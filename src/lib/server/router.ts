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
 * - A **flat map** keyed by dotted path — the right tool at small sizes. Fix the context once with
 *   `const createSessionRouter = createRouter.$context<Session>()`, then let each call infer its
 *   contract: `createSessionRouter(contract, resolvers)`. The explicit `createRouter<typeof
 *   contract, Session>(contract, resolvers)` form also works.
 */
type CreateRouter = {
  <Tree extends ContractTree, Handlers extends object>(
    contract: Tree,
    handlers: Handlers & FragmentTree<Tree, ContextOfHandlers<Handlers, Tree>>
  ): Router<ContextOfHandlers<Handlers, Tree>>
  <Tree extends ContractTree, Context = void>(
    contract: Tree,
    resolvers: InferResolvers<Tree, Context>
  ): Router<Context>
  /**
   * Returns the same factory with a fixed context type, reusable across contracts. Accepts either
   * resolver shape; handler fragments must accept this context. No context value is bound here —
   * the edge still supplies it to `dispatch`.
   */
  $context: <Context>() => CreateRouterWithContext<Context>
}

type CreateRouterWithContext<Context> = {
  // oxlint-disable-next-line no-unnecessary-type-parameters -- preserves extra exports in handler branches, including object literals
  <Tree extends ContractTree, Handlers extends object>(
    contract: Tree,
    handlers: Handlers & FragmentTree<Tree, Context>
  ): Router<Context>
  <Tree extends ContractTree>(
    contract: Tree,
    resolvers: InferResolvers<Tree, Context>
  ): Router<Context>
}

// Typed as a callable interface, not overload declarations: checking the implementation against
// the tree overload instantiates FragmentTree with the bare ContractTree constraint, whose index
// signature recurses without terminating (TS2589). Concrete contracts are finite, so call sites
// are unaffected; the cast stands in for the compatibility check.
// oxlint-disable-next-line typescript/consistent-type-assertions -- see above
export const createRouter: CreateRouter = Object.assign(buildRouter as CreateRouter, {
  // Context exists only in the type system; at runtime the factory is unchanged.
  $context: () => createRouter,
})

// Any router at all. `Router<any>` would not do: `[any] extends [void]` picks the no-context
// `dispatch`, which a router with a context is not assignable to.
type AnyRouter = {
  channels: readonly string[]
  dispatch: (path: string, raw: unknown, ...options: never[]) => Promise<unknown>
}

type ContextOf<R> = R extends Router<infer Context> ? Context : never

// A router's required context as a parameter type, or nothing when it is context-free.
// Distributes over a union-typed argument (`Router<A> | Router<B>`), one function per router, so a
// union context stays whole.
type ContextParameter<R> = R extends AnyRouter
  ? // oxlint-disable-next-line no-invalid-void-type -- void is the no-context sentinel, as in `DispatchOptions`
    [ContextOf<R>] extends [void]
    ? never
    : (context: ContextOf<R>) => void
  : never

// What one argument requires: inferring from a union of parameters intersects them, because either
// router of a union-typed argument may be the one that runs. `unknown` when nothing is required,
// so it drops out of the fold's intersection.
type ArgumentContext<R> = [ContextParameter<R>] extends [never]
  ? unknown
  : ContextParameter<R> extends (context: infer Context) => void
    ? Context
    : never

type RequiresContext<R> = [ContextParameter<R>] extends [never] ? false : true

/**
 * Folds every argument's context into `Merged`, tracking in `Required` whether any argument needs
 * one. Walks a tuple from both ends so a variadic tuple (`[...routers, extra]`) keeps its fixed
 * elements apart; an array of unknown length contributes its element type once.
 */
type FoldContexts<
  Routers extends readonly AnyRouter[],
  Merged,
  Required extends boolean,
> = Routers extends readonly [infer Head, ...infer Tail extends readonly AnyRouter[]]
  ? FoldContexts<
      Tail,
      Merged & ArgumentContext<Head>,
      Required extends true ? true : RequiresContext<Head>
    >
  : Routers extends readonly [...infer Init extends readonly AnyRouter[], infer Last]
    ? FoldContexts<
        Init,
        Merged & ArgumentContext<Last>,
        Required extends true ? true : RequiresContext<Last>
      >
    : Routers extends readonly []
      ? FinishContext<Merged, Required>
      : FinishContext<
          Merged & ArgumentContext<Routers[number]>,
          Required extends true ? true : RequiresContext<Routers[number]>
        >

// Stands in for contexts no value satisfies at once (`{ kind: "user" }` and `{ kind: "guest" }`,
// or the literals `"user"` and `"guest"`). Their intersection is `never`, which `Router` reads as
// "no context", so it would make `dispatch` callable with none. This keeps a context required but
// impossible to build, and its key is what the compiler error shows.
type IncompatibleContexts = { "the merged routers' contexts are incompatible": never }

// The flag, not the merged type, decides whether a context is required: an impossible
// intersection and "nothing required" must not look alike.
type FinishContext<Merged, Required extends boolean> = Required extends true
  ? [Merged] extends [never]
    ? IncompatibleContexts
    : Merged
  : // oxlint-disable-next-line no-invalid-void-type -- void is the no-context sentinel, as in `DispatchOptions`
    void

/**
 * The context of a merged router: the intersection of the routers' contexts, or `void` when none
 * has one. Contexts are intersected whole, never by intersecting a union of them, which would also
 * intersect the members of a union context (`{ kind: "guest" } | { kind: "user" }` would collapse
 * to `never`) and let an `unknown` context absorb the others. The `void` fallback keeps `dispatch`
 * a `Transport` when nothing is required.
 */
type MergedContext<Routers extends readonly AnyRouter[]> = FoldContexts<Routers, unknown, false>

/**
 * Serves several routers as one, so an edge that takes a single router (an IPC loop, `connect`,
 * `createClient` in tests) can serve an app split into one router per feature. `channels` lists
 * every router's channels, and `dispatch` hands the call, `context` and `signal` included, to the
 * router that owns the path, which parses as it always does.
 *
 * Two routers declaring the same channel throw a `SetupError` with code `duplicate-channel` here,
 * before any edge registers anything. The merged context is the intersection of the routers'
 * contexts: routers needing `{ sender }` and `{ userId }` merge into one needing both, and each
 * resolver still receives the whole object. Context-free routers add nothing, so merging only those
 * keeps `dispatch` a valid `Transport`. The result is a `Router`, so merges nest.
 */
export function mergeRouters<const Routers extends readonly AnyRouter[]>(
  ...routers: Routers
): Router<MergedContext<Routers>> {
  // A Map, not an object: an untrusted path such as "constructor" must miss, not resolve to an
  // `Object.prototype` member.
  const owners = new Map<string, AnyRouter>()

  for (const router of routers) {
    for (const channel of router.channels) {
      if (owners.has(channel)) {
        throw new SetupError({ code: "duplicate-channel", path: channel })
      }

      owners.set(channel, router)
    }
  }

  const dispatch = async (
    path: string,
    raw: unknown,
    options?: { context?: unknown; signal?: AbortSignal }
  ): Promise<unknown> => {
    const owner = owners.get(path)

    // Same order as a single router: a caller that already gave up hears its own reason.
    options?.signal?.throwIfAborted()

    if (!owner) {
      throw new ChannelError({ code: "unknown-channel", path })
    }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- the owner accepts the slice of the merged context it declared, and the intersection carries every slice
    const forward = owner.dispatch as (
      path: string,
      raw: unknown,
      options?: object
    ) => Promise<unknown>

    // Called on its owner: a router may implement `dispatch` as a method that reads `this`.
    return await forward.call(owner, path, raw, options)
  }

  return { channels: [...owners.keys()], dispatch }
}

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
