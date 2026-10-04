import type { Transport } from "../core/transport"
import type { Router } from "../server/router"
import type { Wire } from "./types"
import { ChannelError } from "../core/error"
import { isRecord } from "../core/guards"
import { deferWire, subscribe } from "./deferred"
import { fromWire, serializeError, toWire, type WireResult } from "./envelope"

// `result` stays unknown until `fromWire` validates it: the peer is the source.
type WireMessage =
  | { kind: "req"; id: number; path: string; payload: unknown }
  | { kind: "res"; id: number; result: unknown }

type PendingEntry = {
  fail: (error: Error) => void
  settle: (result: unknown) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * Wires one end of a duplex pipe into typedport: serves incoming requests through `router` (omit it
 * for a call-only end) and returns a `Transport` for calling the peer, with request/response
 * correlation handled internally. Fully symmetric — call it on both ends with the roles swapped.
 *
 * A pipe is one peer, so `context` is per-connection: whatever identity the edge established (the
 * session, the window) is passed to every dispatch this end serves.
 *
 * Full error fidelity is the point of the protocol: the peer receives every `ChannelError` detail,
 * including server-fault codes like `output-validation`. That makes `connect` a trusted-peer
 * transport (a worker, a MessagePort, your own processes). A peer that should not see server-side
 * detail — a browser talking to a public server — belongs behind an edge that redacts, like the
 * HTTP recipes do.
 *
 * `timeoutMs` bounds each outgoing call; without it a dead peer leaves calls pending forever.
 * `close(reason?)` rejects everything in flight and every future call with a `ChannelError` (code
 * `closed`, the reason in `cause`) and stops serving — wire it to whatever liveness signal the pipe
 * has (a window's `closed`, a socket's `close`).
 *
 * The wire may be a promise — a port that hasn't been handed over yet, a socket that hasn't opened.
 * Calls made in the meantime queue (bounded by `timeoutMs`) and flush when it resolves; `close`
 * before it arrives wins the race, and a rejected wire promise closes the connection with the
 * rejection as the reason.
 */
export function connect<Context = void>(
  wire: Wire | Promise<Wire>,
  options: { context?: Context; router?: Router<Context>; timeoutMs?: number } = {}
): { transport: Transport; close: (reason?: Error) => void } {
  const source: Wire =
    "send" in wire
      ? wire
      : deferWire(
          wire,
          (reason) => {
            close(reason)
          },
          // A queued request whose caller already timed out must not reach the
          // peer once the wire arrives — the reply would be dropped, but the
          // peer's resolver would still run. Anything that isn't a request
          // (responses to calls the peer somehow made this early) still flows.
          (data) => {
            const message = parseMessage(data)
            return message?.kind !== "req" || pending.has(message.id)
          }
        )
  const { context, router, timeoutMs } = options
  // oxlint-disable-next-line typescript/consistent-type-assertions -- `Router<Context>`'s rest tuple is a conditional TypeScript cannot resolve for a generic Context
  const dispatch = router?.dispatch as
    | ((path: string, raw: unknown, context?: Context) => Promise<unknown>)
    | undefined
  const pending = new Map<number, PendingEntry>()
  let nextId = 0
  let closed: Error | undefined

  const unsubscribe = subscribe(source, (data) => {
    // Anything that doesn't parse is not ours on a shared wire; ignore it.
    const message = closed ? undefined : parseMessage(data)

    if (message?.kind === "req") {
      void respond(message)
      return
    }

    if (message?.kind === "res") {
      const { id, result } = message
      const entry = pending.get(id)

      if (!entry) {
        return
      }

      pending.delete(id)

      if (entry.timer !== undefined) {
        clearTimeout(entry.timer)
      }

      entry.settle(result)
    }
  })

  function close(reason?: Error): void {
    if (closed) {
      return
    }

    closed = new ChannelError({ code: "closed" }, { cause: reason })

    unsubscribe?.()

    for (const entry of pending.values()) {
      entry.fail(closed)
    }

    pending.clear()
  }

  return {
    close,
    transport: (path, payload) =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(closed)
          return
        }

        const id = nextId
        nextId += 1
        const timer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                pending.delete(id)
                reject(new ChannelError({ code: "timeout", path, timeoutMs }))
              }, timeoutMs)

        pending.set(id, {
          fail: (error) => {
            if (timer !== undefined) {
              clearTimeout(timer)
            }

            reject(error)
          },
          settle: (result) => {
            try {
              resolve(fromWire(result))
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)))
            }
          },
          timer,
        })

        try {
          source.send({ id, kind: "req", path, payload })
        } catch (error) {
          // A synchronously-throwing send (DataCloneError on a non-cloneable
          // payload) rejects the caller; don't leak the pending entry.
          pending.delete(id)

          if (timer !== undefined) {
            clearTimeout(timer)
          }

          throw error
        }
      }),
  }

  async function respond(message: { id: number; path: string; payload: unknown }): Promise<void> {
    const result: WireResult = dispatch
      ? // The thunk form lets toWire capture even a synchronously-throwing dispatch.
        await toWire(() => dispatch(message.path, message.payload, context))
      : { error: serializeError(new ChannelError({ code: "no-router" })), ok: false }

    if (!closed) {
      try {
        source.send({ id: message.id, kind: "res", result })
      } catch {
        // The pipe died between request and reply; `respond` runs unawaited, so
        // swallowing here is what keeps this from becoming an unhandled
        // rejection. The peer's own timeout covers the lost reply.
      }
    }
  }
}

function parseMessage(data: unknown): WireMessage | undefined {
  if (!isRecord(data)) {
    return undefined
  }

  const message = data

  if (typeof message.id !== "number") {
    return undefined
  }

  if (message.kind === "req" && typeof message.path === "string") {
    return { id: message.id, kind: "req", path: message.path, payload: message.payload }
  }

  if (message.kind === "res") {
    return { id: message.id, kind: "res", result: message.result }
  }

  return undefined
}
