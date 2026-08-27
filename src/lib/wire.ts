import type { Router } from "./router"
import type { Transport } from "./types"
import { detailOf, ChannelError, type ChannelErrorDetail } from "./error"

/**
 * An outcome flattened to a serializable value, so errors survive boundaries that structured-clone
 * or JSON-encode (Electron `invoke`, `postMessage`, HTTP). `detail` is present exactly when the
 * failure was a `ChannelError`, letting `fromWire` rehydrate it — code and fields intact — on the
 * other side.
 */
export type WireResult =
  | { ok: true; result: unknown }
  | {
      ok: false
      error: { detail?: ChannelErrorDetail; message: string; name: string }
    }

/**
 * Captures any operation's outcome as a serializable `WireResult` — never throws. Pass the
 * operation's promise (`toWire(router.dispatch(path, payload))`), or a thunk when the operation can
 * throw synchronously. `fromWire` on the other side is its inverse: `fromWire(await toWire(x))`
 * returns what `x` resolved with, or rethrows what it threw.
 */
export async function toWire(operation: Promise<unknown> | (() => unknown)): Promise<WireResult> {
  try {
    return { ok: true, result: await (typeof operation === "function" ? operation() : operation) }
  } catch (error) {
    return { error: serializeError(error), ok: false }
  }
}

/**
 * Unwraps a `WireResult`: returns the result, or rethrows the failure — with `ChannelError`
 * rehydrated (code and fields intact) so `instanceof` and `code` checks work across the boundary.
 *
 * Takes `unknown` because at a real boundary the value is untrusted: a gateway error page or a
 * proxy 502 is not an envelope, and that raises a clear error here instead of an opaque `TypeError`
 * downstream.
 */
export function fromWire(data: unknown): unknown {
  if (!isEnvelope(data)) {
    // A library-raised failure, so it follows the one rule: it is a
    // ChannelError, and adapters can branch on its code.
    throw new ChannelError({ code: "malformed-envelope" })
  }

  if (data.ok) {
    return data.result
  }

  if (data.error.detail) {
    throw new ChannelError(data.error.detail)
  }

  const error = new Error(data.error.message)
  error.name = data.error.name
  throw error
}

function isEnvelope(data: unknown): data is WireResult {
  if (typeof data !== "object" || data === null || !("ok" in data)) {
    return false
  }

  const candidate = data as { error?: unknown; ok: unknown }

  if (candidate.ok === true) {
    return true
  }

  return candidate.ok === false && typeof candidate.error === "object" && candidate.error !== null
}

/**
 * The minimal duplex pipe `connect` runs over: anything that can send a value and hand incoming
 * values to a listener (a DOM `MessagePort`, an Electron `MessagePortMain`, a `WebSocket`, a
 * worker). `onMessage` may return an unsubscribe function; `close` invokes it if present.
 */
export type Wire = {
  send: (data: unknown) => void
  // oxlint-disable-next-line no-invalid-void-type -- adapters without an unsubscribe mechanism return nothing
  onMessage: (listener: (data: unknown) => void) => void | (() => void)
}

type WireMessage =
  | { kind: "req"; id: number; path: string; payload: unknown }
  | { kind: "res"; id: number; result: WireResult }

type PendingEntry = {
  fail: (error: Error) => void
  settle: (result: WireResult) => void
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
      : deferWire(wire, (reason) => {
          close(reason)
        })
  const { context, router, timeoutMs } = options
  const dispatch = router?.dispatch as
    | ((path: string, raw: unknown, context?: Context) => Promise<unknown>)
    | undefined
  const pending = new Map<number, PendingEntry>()
  let nextId = 0
  let closed: Error | undefined

  const unsubscribe = source.onMessage((data) => {
    if (closed || typeof data !== "object" || data === null) {
      return
    }

    // Anything else on a shared wire is not ours; ignore it.
    const message = data as { kind?: string }

    if (message.kind === "req") {
      void respond(data as Extract<WireMessage, { kind: "req" }>)
      return
    }

    if (message.kind === "res") {
      const { id, result } = data as Extract<WireMessage, { kind: "res" }>
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

    if (typeof unsubscribe === "function") {
      unsubscribe()
    }

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

/**
 * A `Wire` over a wire that hasn't arrived yet: outbound data buffers, the listener attaches on
 * arrival, and unsubscribing before arrival detaches permanently — so a `close` that wins the race
 * leaves a late wire untouched. A rejected promise reports through `onReject` (connect closes with
 * it); the buffered data is dropped with the connection, which is what the caller's pending-call
 * rejections already communicate.
 */
function deferWire(pending: Promise<Wire>, onReject: (reason: Error) => void): Wire {
  let inner: Wire | undefined
  let listener: ((data: unknown) => void) | undefined
  let innerUnsubscribe: (() => void) | undefined = undefined
  let detached = false
  const outbox: unknown[] = []

  const adopt = async (): Promise<void> => {
    const wire = await pending

    if (detached) {
      return
    }

    inner = wire

    if (listener) {
      innerUnsubscribe = subscribe(wire, listener)
    }

    for (const data of outbox.splice(0)) {
      wire.send(data)
    }
  }

  adopt().catch((error: unknown) => {
    onReject(error instanceof Error ? error : new Error(String(error)))
  })

  return {
    onMessage: (incoming) => {
      listener = incoming

      if (inner) {
        innerUnsubscribe = subscribe(inner, incoming)
      }

      return () => {
        detached = true

        if (typeof innerUnsubscribe === "function") {
          innerUnsubscribe()
        }
      }
    },
    send: (data) => {
      if (inner) {
        inner.send(data)
      } else {
        outbox.push(data)
      }
    },
  }
}

// Normalizes Wire.onMessage's void-or-unsubscribe return to something storable.
function subscribe(wire: Wire, listener: (data: unknown) => void): (() => void) | undefined {
  const unsubscribe = wire.onMessage(listener)

  return typeof unsubscribe === "function" ? unsubscribe : undefined
}

function serializeError(error: unknown): Exclude<WireResult, { ok: true }>["error"] {
  if (error instanceof ChannelError) {
    return { detail: detailOf(error), message: error.message, name: error.name }
  }

  if (error instanceof Error) {
    return { message: error.message, name: error.name }
  }

  return { message: String(error), name: "Error" }
}
