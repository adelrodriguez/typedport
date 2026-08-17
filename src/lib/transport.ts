import type { Router } from "./router"

/**
 * The two functions a transport supplies. `call` carries procedures — a round trip that resolves
 * with the handler's result. `post` carries events — one-way. A transport may support only one
 * kind; the client throws when an operation reaches a function the transport did not provide.
 *
 * `Options` is the transport's per-call options type, forwarded verbatim from the call site (QStash
 * publish options, an Electron transfer list). `PostResult` is what `post` resolves with, surfaced
 * as the return value of `publish` (a QStash message id, or `void` when there is nothing to say).
 */
export type Transport<Options = never, PostResult = void> = {
  call?: (path: string, input: unknown, options?: Options) => Promise<unknown>
  post?: (path: string, payload: unknown, options?: Options) => Promise<PostResult>
}

/**
 * A transport that dispatches directly to a router in the same process. Useful for tests and for
 * exercising a contract without real I/O.
 */
export function createMemoryTransport(router: Router) {
  return {
    call: (path: string, input: unknown) => router.dispatch(path, input),
    post: async (path: string, payload: unknown) => {
      await router.dispatch(path, payload)
    },
  } satisfies Transport
}
