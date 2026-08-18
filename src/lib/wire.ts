import type { Router } from "./router"
import type { Transport } from "./types"
import { detailOf, TypeportError, type TypeportErrorDetail } from "./error"

/**
 * An outcome flattened to a serializable value, so errors survive boundaries that structured-clone
 * or JSON-encode (Electron `invoke`, `postMessage`, HTTP). `detail` is present exactly when the
 * failure was a `TypeportError`, letting `fromWire` rehydrate it — code and fields intact — on the
 * other side.
 */
export type WireResult =
  | { ok: true; result: unknown }
  | {
      ok: false
      error: { detail?: TypeportErrorDetail; message: string; name: string }
    }

/**
 * Captures any operation's outcome as a serializable `WireResult` — never throws. Pass the
 * operation's promise (`toWire(router.dispatch(path, payload))`), or a thunk when the operation
 * can throw synchronously. `fromWire` on the other side is its inverse:
 * `fromWire(await toWire(x))` returns what `x` resolved with, or rethrows what it threw.
 */
export async function toWire(operation: Promise<unknown> | (() => unknown)): Promise<WireResult> {
  try {
    return { ok: true, result: await (typeof operation === "function" ? operation() : operation) }
  } catch (error) {
    return { error: serializeError(error), ok: false }
  }
}

/**
 * Unwraps a `WireResult`: returns the result, or rethrows the failure — with `TypeportError`
 * rehydrated (code and fields intact) so `instanceof` and `code` checks work across the boundary.
 */
export function fromWire(data: WireResult): unknown {
  if (data.ok) {
    return data.result
  }

  if (data.error.detail) {
    throw new TypeportError(data.error.detail)
  }

  const error = new Error(data.error.message)
  error.name = data.error.name
  throw error
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
 * Wires one end of a duplex pipe into typeport: serves incoming requests through `router` (omit it
 * for a call-only end) and returns a `Transport` for calling the peer, with request/response
 * correlation handled internally. Fully symmetric — call it on both ends with the roles swapped.
 *
 * `timeoutMs` bounds each outgoing call; without it a dead peer leaves calls pending forever.
 * `close` rejects everything in flight, rejects future calls, and stops serving — wire it to
 * whatever liveness signal the pipe has (a window's `closed`, a socket's `close`).
 */
export function connect(
  wire: Wire,
  options: { router?: Router; timeoutMs?: number } = {}
): { transport: Transport; close: (reason?: Error) => void } {
  const { router, timeoutMs } = options
  const pending = new Map<number, PendingEntry>()
  let nextId = 0
  let closed: Error | undefined

  const unsubscribe = wire.onMessage((data) => {
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

  return {
    close(reason) {
      if (closed) {
        return
      }

      closed = reason ?? new TypeportError({ code: "closed" })

      if (typeof unsubscribe === "function") {
        unsubscribe()
      }

      for (const entry of pending.values()) {
        entry.fail(closed)
      }

      pending.clear()
    },
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
                reject(new TypeportError({ code: "timeout", path, timeoutMs }))
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

        wire.send({ id, kind: "req", path, payload })
      }),
  }

  async function respond(message: { id: number; path: string; payload: unknown }): Promise<void> {
    const result: WireResult = router
      ? await toWire(router.dispatch(message.path, message.payload))
      : { error: serializeError(new TypeportError({ code: "no-router" })), ok: false }

    if (!closed) {
      wire.send({ id: message.id, kind: "res", result })
    }
  }
}

function serializeError(error: unknown): Exclude<WireResult, { ok: true }>["error"] {
  if (error instanceof TypeportError) {
    return { detail: detailOf(error), message: error.message, name: error.name }
  }

  if (error instanceof Error) {
    return { message: error.message, name: error.name }
  }

  return { message: String(error), name: "Error" }
}
