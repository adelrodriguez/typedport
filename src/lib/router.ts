import type { ContractTree } from "./contract"
import type { InferResolvers } from "./types"
import { TypeportError } from "./error"
import { parseWith } from "./standard"
import { flatten } from "./utils"

export type Router<Context = void> = {
  /**
   * Every dotted path in the contract. Adapters use this to register transport endpoints (IPC
   * channels, routes) and to build allowlists.
   */
  channels: readonly string[]

  /**
   * Validates and dispatches an incoming call. `path` and `raw` are untrusted: an unknown path
   * throws, input is parsed against the leaf's schema before the resolver runs, and when the leaf
   * declares an `output` the result is parsed against it so an off-contract resolver fails loudly
   * (one-way results are discarded). Library failures throw `TypeportError` (`validation`,
   * `unknown-channel`); anything else escaping `dispatch` came from the resolver.
   *
   * `context` is whatever the edge knows about the caller (the authenticated user, the sender
   * identity) and reaches every resolver untouched. With the default `Context = void` the argument
   * disappears, and `dispatch` is a valid `Transport` — passing it to `createClient` wires the
   * whole stack in-memory.
   */
  dispatch: (
    path: string,
    raw: unknown,
    // oxlint-disable-next-line no-invalid-void-type -- void is the no-context sentinel; it makes the argument disappear entirely
    ...context: Context extends void ? [] : [context: Context]
  ) => Promise<unknown>
}

/**
 * Builds the validating dispatcher for a contract. Declare a context type explicitly when the edge
 * supplies one: `createRouter<typeof contract, Session>(contract, resolvers)`.
 */
export function createRouter<Tree extends ContractTree, Context = void>(
  contract: Tree,
  resolvers: InferResolvers<Tree, Context>
): Router<Context> {
  const leaves = flatten(contract)
  const resolverMap = resolvers as Record<string, (input: unknown, context?: Context) => unknown>

  const dispatch = async (path: string, raw: unknown, context?: Context): Promise<unknown> => {
    const leaf = leaves[path]
    const resolver = resolverMap[path]

    if (!(leaf && resolver)) {
      throw new TypeportError({ code: "unknown-channel", path })
    }

    const result = await resolver(await parseWith(leaf.input, raw), context)

    if (!leaf.output) {
      return
    }

    return await parseWith(leaf.output, result)
  }

  return { channels: Object.keys(leaves), dispatch }
}
