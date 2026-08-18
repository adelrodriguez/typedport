import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Router } from "./router"
import type { Transport } from "./types"
import { ValidationError } from "./standard"

/**
 * A dispatch outcome flattened to a serializable value, so errors survive boundaries that
 * structured-clone or JSON-encode (Electron `invoke`, `postMessage`, HTTP). `issues` is present
 * exactly when the failure was a `ValidationError`, letting `fromWire` rehydrate it on the other
 * side.
 */
export type WireResult =
  | { ok: true; result: unknown }
  | {
      ok: false
      error: { name: string; message: string; issues?: readonly StandardSchemaV1.Issue[] }
    }

/**
 * Server edge: dispatch that never throws — every outcome, including resolver crashes, comes back
 * as a serializable `WireResult`.
 */
export async function dispatchToWire(
  router: Router,
  path: string,
  payload: unknown
): Promise<WireResult> {
  try {
    return { ok: true, result: await router.dispatch(path, payload) }
  } catch (error) {
    return { error: serializeError(error), ok: false }
  }
}

/**
 * Client edge: unwrap a `WireResult` — returns the result, or rethrows the failure with
 * `ValidationError` rehydrated (issues intact) so `instanceof` checks work across the boundary.
 */
export function fromWire(data: WireResult): unknown {
  if (data.ok) {
    return data.result
  }

  if (data.error.issues) {
    throw new ValidationError(data.error.issues)
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

      closed = reason ?? new Error("Wire closed")

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
                reject(new Error(`Call to "${path}" timed out after ${timeoutMs}ms`))
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
      ? await dispatchToWire(router, message.path, message.payload)
      : { error: { message: "This end does not serve requests", name: "Error" }, ok: false }

    if (!closed) {
      wire.send({ id: message.id, kind: "res", result })
    }
  }
}

function serializeError(error: unknown): Exclude<WireResult, { ok: true }>["error"] {
  if (error instanceof ValidationError) {
    return { issues: error.issues, message: error.message, name: error.name }
  }

  if (error instanceof Error) {
    return { message: error.message, name: error.name }
  }

  return { message: String(error), name: "Error" }
}
