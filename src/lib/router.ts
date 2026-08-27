import type { ContractTree } from "./contract"
import type { ContextOfHandlers, FragmentTree } from "./implement"
import type { InferResolvers } from "./types"
import { ChannelError } from "./error"
import { flattenFragments } from "./implement"
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
   * (one-way results are discarded). Library failures throw `ChannelError` — `validation` for the
   * caller's input, `output-validation` for a resolver result that drifted off contract,
   * `unknown-channel` for a path outside it; anything else escaping `dispatch` came from the
   * resolver.
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
 * Builds the validating dispatcher for a contract, from either resolver shape:
 *
 * - A **handler tree** of `implement()` fragments mirroring the contract — a namespace import of a
 *   one-file-per-branch handler module already has the shape (`createRouter(contract, { notes, ping
 *   })`). A missing leaf is a missing property, a fragment in the wrong slot is a path-brand
 *   mismatch, and the context type is inferred from the fragments — it is only ever written at
 *   `implement(contract).$context<Session>()`.
 * - A **flat map** keyed by dotted path — the right tool at small sizes. Declare a context type
 *   explicitly when the edge supplies one: `createRouter<typeof contract, Session>(contract,
 *   resolvers)`.
 */
type CreateRouter = {
  <Tree extends ContractTree, Handlers extends object>(
    contract: Tree,
    handlers: Handlers & FragmentTree<Tree, ContextOfHandlers<Handlers>>
  ): Router<ContextOfHandlers<Handlers>>
  <Tree extends ContractTree, Context = void>(
    contract: Tree,
    resolvers: InferResolvers<Tree, Context>
  ): Router<Context>
}

// Typed as a callable interface, not overload declarations: checking the implementation against
// the tree overload instantiates FragmentTree with the bare ContractTree constraint, whose index
// signature recurses without terminating (TS2589). Concrete contracts are finite, so call sites
// are unaffected; the cast stands in for the compatibility check.
export const createRouter: CreateRouter = buildRouter as CreateRouter

function buildRouter(contract: ContractTree, resolvers: object): Router<never> {
  const leaves = flatten(contract)
  const resolverMap = (
    isHandlerTree(resolvers) ? flattenFragments(contract, resolvers) : resolvers
  ) as Record<string, (input: unknown, context?: unknown) => unknown>

  const dispatch = async (path: string, raw: unknown, context?: unknown): Promise<unknown> => {
    const leaf = leaves[path]
    const resolver = resolverMap[path]

    if (!(leaf && resolver)) {
      throw new ChannelError({ code: "unknown-channel", path })
    }

    const result = await resolver(await parseWith(leaf.input, raw), context)

    if (!leaf.output) {
      return
    }

    try {
      return await parseWith(leaf.output, result)
    } catch (error) {
      // An off-contract resolver result is the server's fault, not the
      // caller's — recode it so edges can tell the two apart.
      if (error instanceof ChannelError && error.code === "validation") {
        throw new ChannelError(
          { code: "output-validation", issues: error.issues },
          { cause: error }
        )
      }

      throw error
    }
  }

  return { channels: Object.keys(leaves), dispatch }
}

// A flat map's values are all resolver functions; a handler tree's top level holds fragments and
// branch objects. One non-function value is therefore a reliable discriminant between the two
// `createRouter` shapes.
function isHandlerTree(resolvers: object): resolvers is Record<string, unknown> {
  return Object.values(resolvers).some((value) => typeof value !== "function")
}
