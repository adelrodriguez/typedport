import type { ContractTree } from "./contract"
import { parseWith } from "./standard"
import type { InferResolvers } from "./types"
import { flatten } from "./utils"

export type Router = {
  /**
   * Every dotted path in the contract. Adapters use this to register transport endpoints (IPC
   * channels, routes) and to build allowlists.
   */
  channels: readonly string[]

  /**
   * Validates and dispatches an incoming call. `path` and `raw` are untrusted: an unknown path
   * throws, input is parsed against the leaf's schema before the resolver runs, and when the leaf
   * declares an `output` the result is parsed against it so an off-contract resolver fails loudly
   * (one-way results are discarded). Validation failures throw `ValidationError`; anything else
   * escaping `dispatch` came from the resolver.
   *
   * `dispatch` is a valid `Transport` — passing it to `createClient` wires the whole stack
   * in-memory.
   */
  dispatch: (path: string, raw: unknown) => Promise<unknown>
}

export function createRouter<Tree extends ContractTree>(
  contract: Tree,
  resolvers: InferResolvers<Tree>
): Router {
  const leaves = flatten(contract)
  const resolverMap = resolvers as Record<string, (input: unknown) => unknown>

  return {
    channels: Object.keys(leaves),
    async dispatch(path, raw) {
      const leaf = leaves[path]
      const resolver = resolverMap[path]

      if (!(leaf && resolver)) {
        throw new Error(`Unknown channel: "${path}"`)
      }

      const result = await resolver(await parseWith(leaf.input, raw))

      if (!leaf.output) {
        return
      }

      return await parseWith(leaf.output, result)
    },
  }
}
