import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Channel } from "../core/contract"
import type { Join, MaybePromise } from "../core/types"

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never

/**
 * The resolver signature one leaf demands: parsed input (the schema's output type, after defaults
 * and coercions) and the per-dispatch context. A round-trip leaf must return something its `output`
 * schema accepts; a one-way leaf's resolver may return anything — the router discards it.
 */
export type Resolver<Leaf, Context> =
  Leaf extends Channel<infer Input, infer Output>
    ? Output extends StandardSchemaV1
      ? (
          input: StandardSchemaV1.InferOutput<Input>,
          context: Context
        ) => MaybePromise<StandardSchemaV1.InferInput<Output>>
      : (input: StandardSchemaV1.InferOutput<Input>, context: Context) => unknown
    : never

type FlatResolvers<Tree, Context, Prefix extends string = ""> = {
  [Key in keyof Tree & string]: Tree[Key] extends Channel
    ? Record<Join<Prefix, Key>, Resolver<Tree[Key], Context>>
    : FlatResolvers<Tree[Key], Context, Join<Prefix, Key>>
}[keyof Tree & string]

/**
 * The flat resolver map for a contract, keyed by dotted path. Resolvers receive the context the
 * edge passed to `dispatch` — the authenticated user, the sender identity, whatever the transport
 * knows. See {@link Resolver} for the per-leaf signature.
 */
export type InferResolvers<Tree, Context = void> = UnionToIntersection<FlatResolvers<Tree, Context>>
