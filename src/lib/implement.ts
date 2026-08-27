import type { StandardSchemaV1 } from "@standard-schema/spec"
import { type Channel, type ContractTree, isChannel } from "./contract"

type MaybePromise<T> = Promise<T> | T
type Join<Prefix extends string, Key extends string> = Prefix extends "" ? Key : `${Prefix}.${Key}`

/**
 * The resolver signature one leaf demands: parsed input (the schema's output type, after defaults
 * and coercions) and the per-dispatch context. A round-trip leaf must return something its `output`
 * schema accepts; a one-way leaf's resolver may return anything — the router discards it.
 */
type ResolverFor<Leaf, Context> =
  Leaf extends Channel<infer Input, infer Output>
    ? Output extends StandardSchemaV1
      ? (
          input: StandardSchemaV1.InferOutput<Input>,
          context: Context
        ) => MaybePromise<StandardSchemaV1.InferInput<Output>>
      : (input: StandardSchemaV1.InferOutput<Input>, context: Context) => unknown
    : never

/**
 * One implemented leaf: the dotted path it serves, the resolver, and (as a phantom on the resolver)
 * the context it was built against. Produced by calling a leaf on an {@link implement} builder;
 * consumed by `createRouter`, where the path brand must agree with the fragment's position in the
 * handler tree — so a fragment for another leaf, or another contract, cannot occupy a slot even
 * when names collide.
 */
export type Fragment<Path extends string = string, Context = never> = {
  _kind: "fragment"
  $path: Path
  $resolver: (input: never, context: Context) => unknown
}

/**
 * The widest fragment: every concrete `Fragment<P, C>` is assignable to it (contravariance).
 */
type AnyFragment = Fragment

/**
 * Mirrors the contract tree: every branch is a sub-implementer, every leaf is a fragment factory.
 * `$context` rebinds the context type — a type-level operation with no runtime counterpart, split
 * from `implement` itself because TypeScript cannot infer the contract argument and take an
 * explicit context parameter in the same call.
 */
export type Implementer<Tree, Context = void, Prefix extends string = ""> = {
  [Key in keyof Tree & string]: Tree[Key] extends Channel
    ? (resolver: ResolverFor<Tree[Key], Context>) => Fragment<Join<Prefix, Key>, Context>
    : Implementer<Tree[Key], Context, Join<Prefix, Key>>
} & {
  /**
   * Returns the same builder with the context type rebound — the one place the context type is
   * written: `const tp = implement(contract).$context<Session>()`. Fragments carry it from there,
   * and `createRouter` infers it back out of them.
   */
  $context: <NextContext>() => Implementer<Tree, NextContext, Prefix>
}

/**
 * The handler-definition builder for a contract: `tp.notes.open(resolver)` returns a
 * {@link Fragment} for that leaf with input, output, and context fully inferred — so handlers can
 * live next to their domain code, one file per branch, with zero annotations. Assemble them with
 * `createRouter(contract, { notes, ping })`, where a namespace import of a handler module already
 * has the required shape.
 */
export function implement<Tree extends ContractTree>(contract: Tree): Implementer<Tree> {
  return build(contract, "") as Implementer<Tree>
}

function build(tree: ContractTree, prefix: string): Record<string, unknown> {
  const node: Record<string, unknown> = {
    // Context exists only in the type system; at runtime the builder is unchanged.
    $context: () => node,
  }

  for (const [key, child] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key

    node[key] = isChannel(child)
      ? (resolver: Fragment["$resolver"]): Fragment => ({
          $path: path,
          $resolver: resolver,
          _kind: "fragment",
        })
      : build(child, path)
  }

  return node
}

export function isFragment(node: unknown): node is Fragment {
  return typeof node === "object" && node !== null && "_kind" in node && node._kind === "fragment"
}

/**
 * The implementation shape a contract demands: the same tree with a fragment at every leaf. Missing
 * leaves are missing properties (TypeScript names them in the error), and each slot demands the
 * fragment whose path brand matches the position.
 */
export type FragmentTree<Tree, Context, Prefix extends string = ""> = {
  [Key in keyof Tree & string]: Tree[Key] extends Channel
    ? Fragment<Join<Prefix, Key>, Context>
    : FragmentTree<Tree[Key], Context, Join<Prefix, Key>>
}

/**
 * The union of fragments anywhere in a handler tree; stray non-fragment exports contribute nothing.
 */
type HandlerLeaves<Handlers> = Handlers extends AnyFragment
  ? Handlers
  : Handlers extends object
    ? { [Key in keyof Handlers]: HandlerLeaves<Handlers[Key]> }[keyof Handlers]
    : never

type FragmentContext<F> = F extends Fragment<string, infer Context> ? Context : never

/**
 * The context a handler tree was built against. `FragmentContext` distributes (its parameter is
 * naked in the conditional), so a uniform tree yields its one context and a mixed tree yields a
 * union — which no concrete fragment satisfies (context is contravariant), turning disagreement
 * into a per-entry compile error instead of a silent widening. Inferred here rather than on the
 * `createRouter` signature because TypeScript cannot infer a type parameter through the mapped
 * conditional in `FragmentTree`.
 */
export type ContextOfHandlers<Handlers> = FragmentContext<HandlerLeaves<Handlers>>

/**
 * Flattens a handler tree into the dotted-path resolver map the router dispatches from. Walks the
 * contract, not the handler object, so stray extra exports in a handler module (a helper, a
 * constant) are ignored — which is what makes raw namespace imports usable as branches. The type
 * system prevents the throws below; they guard the JavaScript and cast-happy callers.
 */
export function flattenFragments(
  contract: ContractTree,
  handlers: Record<string, unknown>
): Record<string, Fragment["$resolver"]> {
  const map: Record<string, Fragment["$resolver"]> = {}

  walk(contract, handlers, "")

  return map

  function walk(tree: ContractTree, node: Record<string, unknown>, prefix: string): void {
    for (const [key, child] of Object.entries(tree)) {
      const path = prefix ? `${prefix}.${key}` : key
      const value = node[key]

      if (value === undefined) {
        throw new Error(`Missing handler for "${path}"`)
      }

      if (isChannel(child)) {
        if (!isFragment(value)) {
          throw new Error(`Handler for "${path}" is not a fragment`)
        }

        if (value.$path !== path) {
          throw new Error(`Handler for "${value.$path}" placed at "${path}"`)
        }

        map[path] = value.$resolver
        continue
      }

      if (typeof value !== "object" || value === null) {
        throw new Error(`Expected a branch of handlers at "${path}"`)
      }

      walk(child, value as Record<string, unknown>, path)
    }
  }
}
