import type { MaybePromise } from "./types"

/**
 * The single function a transport supplies: deliver a validated payload to a dotted path and
 * resolve with whatever came back. That's the whole edge contract — `router.dispatch` is already
 * one, `(path, input) => ipcRenderer.invoke(path, input)` is another. One-way transports (a message
 * queue) just resolve with nothing useful; pair them with contracts whose leaves declare no
 * `output`.
 *
 * A transport may declare a third `options` parameter — per-call edge mechanics (an `AbortSignal`,
 * an Electron transfer list, an HTTP method) that never travel in the payload. Its type is inferred
 * from the annotation and flows to every call site and to the client's `$with`. With the default
 * `never`, the options surface does not exist.
 */
export type Transport<Options = never> = (
  path: string,
  payload: unknown,
  options?: Options
) => MaybePromise<unknown>
