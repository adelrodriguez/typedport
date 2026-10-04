import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { ContextOfHandlers, FragmentTree } from "./implement"
import type { InferResolvers } from "./types"
import { type ContractTree, flatten } from "../core/contract"
import { ChannelError } from "../core/error"
import { parseWith } from "../core/schema"
import { SetupError } from "../core/setup-error"
import { flattenFragments } from "./implement"

/**
 * What an edge passes to `dispatch` besides the payload. `context` reaches every resolver
 * untouched; with the default `Context = void` it disappears, and so does the requirement to pass
 * anything. `signal` is the caller giving up: the resolver sees it, and `dispatch` rejects with its
 * reason even if the resolver ignores it.
 */
// oxlint-disable-next-line no-invalid-void-type -- void is the no-context sentinel; it makes `context` optional
export type DispatchOptions<Context = void> = { signal?: AbortSignal } & ([Context] extends [void]
  ? { context?: undefined }
  : { context: Context })

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
   * The third argument carries the `context` and an optional `signal` — see {@link DispatchOptions}.
   * With the default `Context = void` it is optional, and `dispatch` is a valid `Transport`:
   * passing it to `createClient` wires the whole stack in-memory, `$with({ signal })` included.
   */
  dispatch: (
    path: string,
    raw: unknown,
    // oxlint-disable-next-line no-invalid-void-type -- void is the no-context sentinel; it makes the options optional
    ...options: [Context] extends [void]
      ? [options?: DispatchOptions<Context>]
      : [options: DispatchOptions<Context>]
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
// oxlint-disable-next-line typescript/consistent-type-assertions -- see above
export const createRouter: CreateRouter = buildRouter as CreateRouter

type AnyResolver = (input: unknown, options: { context: unknown; signal: AbortSignal }) => unknown

function buildRouter(contract: ContractTree, resolvers: object): Router<never> {
  const leaves = flatten(contract)
  const source: object = isHandlerTree(resolvers)
    ? flattenFragments(contract, resolvers)
    : resolvers
  // Snapshotted with no prototype, like `leaves`: an untrusted path such as "constructor" misses
  // both maps instead of resolving to an `Object.prototype` member.
  const resolverMap: Record<string, AnyResolver> = Object.create(null)

  for (const path of Object.keys(leaves)) {
    const resolver: unknown = Object.hasOwn(source, path) ? Reflect.get(source, path) : undefined

    // Fail at construction, as a handler tree does, rather than letting a forgotten leaf surface
    // as `unknown-channel` on its first call.
    if (typeof resolver !== "function") {
      throw new SetupError({ code: "missing-resolver", path })
    }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- a resolver's parameters are typed by its leaf; dispatch parses before it calls
    resolverMap[path] = resolver as AnyResolver
  }

  const dispatch = async (
    path: string,
    raw: unknown,
    options: { context?: unknown; signal?: AbortSignal } = {}
  ): Promise<unknown> => {
    const { context } = options
    // Resolvers always get a signal, so they can pass it on without checking for one.
    const signal = options.signal ?? new AbortController().signal
    const leaf = leaves[path]
    const resolver = resolverMap[path]

    signal.throwIfAborted()

    if (!(leaf && resolver)) {
      throw new ChannelError({ code: "unknown-channel", path })
    }

    // The whole pipeline races the signal: an abort during async input parsing, the resolver, or
    // async output parsing releases the caller at once.
    return await untilAborted(signal, async () => {
      const input = await parseWith(leaf.input, raw)
      // A caller that gave up while input was parsing must not start the resolver.
      signal.throwIfAborted()
      const result = await resolver(input, { context, signal })

      return leaf.output ? await parseOutput(leaf.output, result) : undefined
    })
  }

  return { channels: Object.keys(leaves), dispatch }
}

// A flat map's values are all resolver functions; a handler tree's top level holds fragments and
// branch objects. One non-function value is therefore a reliable discriminant between the two
// `createRouter` shapes.
function isHandlerTree(resolvers: object): resolvers is Record<string, unknown> {
  return Object.values(resolvers).some((value) => typeof value !== "function")
}

async function parseOutput(schema: StandardSchemaV1, result: unknown): Promise<unknown> {
  try {
    return await parseWith(schema, result)
  } catch (error) {
    // An off-contract resolver result is the server's fault, not the
    // caller's — recode it so edges can tell the two apart.
    if (error instanceof ChannelError && error.code === "validation") {
      throw new ChannelError({ code: "output-validation", issues: error.issues }, { cause: error })
    }

    throw error
  }
}

// Settles like `run()`, or rejects with the abort reason the moment `signal` aborts — so a caller
// that gave up is released even when the work ignores the signal. The listener attaches before
// `run` starts, so the caller's reason also wins over anything a resolver that aborts its own
// signal throws or returns. `work` is forwarded by hand rather than adopted with `resolve(work)`,
// which would lock the promise to `work` and silence the abort; both its outcomes are observed.
async function untilAborted<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      // oxlint-disable-next-line prefer-promise-reject-errors -- an abort rejects with the caller's own reason, as fetch does
      reject(signal.reason)
    }
    const detach = (): void => {
      signal.removeEventListener("abort", onAbort)
    }

    signal.addEventListener("abort", onAbort, { once: true })

    // Never rejects: every outcome of `run` is caught and forwarded.
    const forward = async (): Promise<void> => {
      try {
        resolve(await run())
      } catch (error) {
        // oxlint-disable-next-line prefer-promise-reject-errors -- forwards whatever the resolver threw, unchanged
        reject(error)
      } finally {
        detach()
      }
    }

    void forward()
  })
}
