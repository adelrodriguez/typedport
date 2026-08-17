import { parse } from "zod/v4/core"
import type { ContractTree } from "./contract"
import type { InferHandlers } from "./types"
import { flatten } from "./utils"

export type Router = {
  /**
   * Every dotted path in the contract. Adapters use this to register transport endpoints (IPC
   * channels, routes) and to build allowlists.
   */
  channels: readonly string[]

  /**
   * Validates and dispatches an incoming call. `path` and `raw` are untrusted: an unknown path
   * throws, input is parsed against the leaf's schema before the handler runs, and a procedure's
   * result is parsed against the output schema so an off-contract handler fails loudly.
   */
  dispatch: (path: string, raw: unknown) => Promise<unknown>
}

export function createRouter<Tree extends ContractTree>(
  contract: Tree,
  handlers: InferHandlers<Tree>
): Router {
  const leaves = flatten(contract)
  const handlerMap = handlers as Record<string, (input: unknown) => Promise<unknown>>

  return {
    channels: Object.keys(leaves),
    async dispatch(path, raw) {
      const leaf = leaves[path]
      const handler = handlerMap[path]

      if (!(leaf && handler)) {
        throw new Error(`Unknown channel: "${path}"`)
      }

      if (leaf._kind === "event") {
        await handler(parse(leaf.payload, raw))
        return
      }

      const result = await handler(parse(leaf.input, raw))

      return parse(leaf.output, result)
    },
  }
}

/**
 * A transport that dispatches directly to a router in the same process. Useful for tests and for
 * exercising a contract without real I/O.
 */
export function createMemoryTransport(router: Router) {
  return {
    request: (path: string, input: unknown) => router.dispatch(path, input),
    send: async (path: string, payload: unknown) => {
      await router.dispatch(path, payload)
    },
  } satisfies { request: unknown; send: unknown }
}
