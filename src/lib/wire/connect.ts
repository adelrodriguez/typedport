import type { Transport } from "../core/transport"
import type { Router } from "../server/router"
import type { Wire } from "./types"
import { ChannelError } from "../core/error"
import { isRecord } from "../core/guards"
import { deferWire, subscribe } from "./deferred"
import { type ExposeOptions, fromWire, toWire } from "./envelope"

// `result` stays unknown until `fromWire` validates it: the peer is the source.
type WireMessage =
  | { kind: "cancel"; id: number }
  | { kind: "req"; id: number; path: string; payload: unknown }
  | { kind: "res"; id: number; result: unknown }

const DEFAULT_TIMEOUT_MS = 30_000

type PendingEntry = {
  fail: (error: ChannelError) => void
  settle: (result: unknown) => void
}

type CallOptions = {
  /**
   * Aborts this call: it rejects with `signal.reason`, a late reply is dropped, and the peer aborts
   * the `signal` its resolver received.
   */
  signal?: AbortSignal
}

/**
 * Wires one end of a duplex pipe into typedport: serves incoming requests through `router` (omit it
 * for a call-only end) and returns a `Transport` for calling the peer, with request/response
 * correlation handled internally. Fully symmetric — call it on both ends with the roles swapped.
 *
 * A pipe is one peer, so `context` is per-connection: whatever identity the edge established (the
 * session, the window) is passed to every dispatch this end serves.
 *
 * Failures this end serves are hidden from the peer exactly as `toWire` hides them: caller-fault
 * codes cross intact, everything else crosses as code `internal` and goes to `onHidden`. A trusted
 * peer (a worker, your own processes) can see everything with `expose: () => true`.
 *
 * `timeoutMs` bounds each outgoing call (default 30 seconds) so a dead peer rejects calls instead
 * of leaving them pending forever; pass `Infinity` to opt out when something else, such as `close`,
 * covers liveness. The transport also takes `{ signal }` per call, so `api.$with({ signal })`
 * cancels from the client; the call rejects with `signal.reason`. A call that is aborted or times
 * out tells the peer, which aborts the `signal` its resolver received; closing the session aborts
 * every resolver this end is running.
 *
 * The session ends on `close(reason?)` or when `options.signal` aborts (its reason becomes the
 * close reason): everything in flight and every future call rejects with a `ChannelError` (code
 * `closed`, the reason in `cause`) and this end stops serving. Tie it to whatever liveness signal
 * the pipe has (a window's `closed`, a socket's `close`). `closed` resolves with that error once it
 * happens.
 *
 * The wire may be a promise — a port that hasn't been handed over yet, a socket that hasn't opened.
 * Calls made in the meantime queue (bounded by `timeoutMs`) and flush when it resolves; `close`
 * before it arrives wins the race, and a rejected wire promise closes the connection with the
 * rejection as the reason.
 */
export function connect<Context = void>(
  wire: Wire | Promise<Wire>,
  options: ExposeOptions & {
    context?: Context
    router?: Router<Context>
    signal?: AbortSignal
    /**
     * Bounds each outgoing call. Defaults to 30 seconds; `Infinity` disables it.
     */
    timeoutMs?: number
  } = {}
): {
  close: (reason?: unknown) => void
  closed: Promise<ChannelError>
  transport: Transport<CallOptions>
} {
  const source: Wire =
    "send" in wire
      ? wire
      : deferWire(
          wire,
          (reason) => {
            close(reason)
          },
          // A queued request whose caller already gave up (timed out, aborted) must not reach
          // the peer once the wire arrives — the reply would be dropped, but the peer's resolver
          // would still run. A queued cancel always belongs to such a request, so it goes too.
          (data) => {
            const message = parseMessage(data)

            if (message?.kind === "req") {
              return pending.has(message.id)
            }

            return message?.kind !== "cancel"
          }
        )
  const { context, router, signal, timeoutMs = DEFAULT_TIMEOUT_MS, ...exposure } = options
  // oxlint-disable-next-line typescript/consistent-type-assertions -- `Router<Context>`'s rest tuple is a conditional TypeScript cannot resolve for a generic Context
  const dispatch = router?.dispatch as
    | ((
        path: string,
        raw: unknown,
        options: { context?: Context; signal?: AbortSignal }
      ) => Promise<unknown>)
    | undefined
  const pending = new Map<number, PendingEntry>()
  // Requests this end is serving, by the peer's id, so a cancel can reach the resolver.
  const serving = new Map<number, AbortController>()
  let nextId = 0
  let closed: ChannelError | undefined
  let resolveClosed: ((error: ChannelError) => void) | undefined
  const whenClosed = new Promise<ChannelError>((resolve) => {
    resolveClosed = resolve
  })

  const unsubscribe = subscribe(source, (data) => {
    // Anything that doesn't parse is not ours on a shared wire; ignore it.
    const message = closed ? undefined : parseMessage(data)

    if (message?.kind === "req") {
      void respond(message)
      return
    }

    if (message?.kind === "res") {
      pending.get(message.id)?.settle(message.result)
      return
    }

    if (message?.kind === "cancel") {
      serving.get(message.id)?.abort()
    }
  })

  const onAbort = (): void => {
    close(signal?.reason)
  }

  function close(reason?: unknown): void {
    if (closed) {
      return
    }

    closed = new ChannelError({ code: "closed" }, { cause: reason })
    unsubscribe?.()
    signal?.removeEventListener("abort", onAbort)

    // Each entry deletes only itself as it fails, which Map iteration tolerates.
    for (const entry of pending.values()) {
      entry.fail(closed)
    }

    for (const controller of serving.values()) {
      controller.abort(closed)
    }

    resolveClosed?.(closed)
  }

  if (signal?.aborted) {
    onAbort()
  } else {
    signal?.addEventListener("abort", onAbort, { once: true })
  }

  return {
    close,
    closed: whenClosed,
    transport: (path, payload, callOptions) =>
      new Promise((resolve, reject) => {
        const callSignal = callOptions?.signal

        if (closed) {
          reject(closed)
          return
        }

        // Throwing in the executor rejects with the raw reason, as fetch does.
        callSignal?.throwIfAborted()

        const id = nextId
        nextId += 1

        const cleanup = (): void => {
          pending.delete(id)
          clearTimeout(timer)
          callSignal?.removeEventListener("abort", onCallAbort)
        }
        const onCallAbort = (): void => {
          cleanup()
          cancelRemote(id)
          // oxlint-disable-next-line prefer-promise-reject-errors -- an abort rejects with the caller's own reason, as fetch does
          reject(callSignal?.reason)
        }
        // `setTimeout` would fire an `Infinity` delay immediately.
        const timer = Number.isFinite(timeoutMs)
          ? setTimeout(() => {
              cleanup()
              cancelRemote(id)
              reject(new ChannelError({ code: "timeout", path, timeoutMs }))
            }, timeoutMs)
          : undefined

        callSignal?.addEventListener("abort", onCallAbort, { once: true })
        pending.set(id, {
          fail: (error: ChannelError) => {
            cleanup()
            reject(error)
          },
          settle: (result) => {
            cleanup()

            // Adopting a promise carries fromWire's throw through as the rejection.
            resolve(Promise.resolve(result).then(fromWire))
          },
        })

        try {
          source.send({ id, kind: "req", path, payload })
        } catch (error) {
          // A synchronously-throwing send (DataCloneError on a non-cloneable
          // payload) rejects the caller; don't leak the pending entry.
          cleanup()
          throw error
        }
      }),
  }

  // Best effort: if the pipe is gone, so is the peer's reason to keep working.
  function cancelRemote(id: number): void {
    if (closed) {
      return
    }

    try {
      source.send({ id, kind: "cancel" })
    } catch {
      // Same as a lost reply: nothing to recover, and nobody awaits this.
    }
  }

  async function respond(message: { id: number; path: string; payload: unknown }): Promise<void> {
    const controller = new AbortController()
    serving.set(message.id, controller)

    const result = await toWire(
      dispatch
        ? // The thunk form lets toWire capture even a synchronously-throwing dispatch.
          () => dispatch(message.path, message.payload, { context, signal: controller.signal })
        : Promise.reject(new ChannelError({ code: "no-router" })),
      {
        expose: exposure.expose,
        // A resolver that failed because the caller cancelled is not a failure worth logging.
        onHidden: (error) => {
          if (!controller.signal.aborted) {
            exposure.onHidden?.(error)
          }
        },
      }
    )

    if (serving.get(message.id) === controller) {
      serving.delete(message.id)
    }

    // A cancelled caller already stopped listening for this id.
    if (!closed && !controller.signal.aborted) {
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

  if (message.kind === "cancel") {
    return { id: message.id, kind: "cancel" }
  }

  return undefined
}
