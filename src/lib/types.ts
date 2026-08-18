import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Leaf } from "./contract"

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never

type MaybePromise<T> = Promise<T> | T

/**
 * The single function a transport supplies: deliver a validated payload to a dotted path and
 * resolve with whatever came back. That's the whole edge contract — `router.dispatch` is already
 * one, `(path, input) => ipcRenderer.invoke(path, input)` is another. One-way transports (a message
 * queue) just resolve with nothing useful; pair them with contracts whose leaves declare no
 * `output`.
 */
export type Transport = (path: string, payload: unknown) => MaybePromise<unknown>

type LeafHelpers<Input extends StandardSchemaV1, Output extends StandardSchemaV1 | undefined> = {
  /**
   * The dotted path to this leaf (e.g., "localFiles.open").
   */
  $path: string

  /**
   * The schema for this leaf's input — for a bare-schema leaf (`event(schema)`), the schema itself.
   */
  $input: Input

  /**
   * The schema for this leaf's output, or `undefined` for a one-way leaf.
   */
  $output: Output
}

/**
 * The Proxy-backed client shape for a contract: every leaf is directly callable — leaves with an
 * `output` schema resolve with the result, one-way leaves resolve `void` — and every leaf carries
 * `$`-helpers.
 */
export type InferClient<Tree> = {
  [Key in keyof Tree]: Tree[Key] extends Leaf<infer Input, infer Output>
    ? LeafHelpers<Input, Output> &
        (Output extends StandardSchemaV1
          ? (
              input: StandardSchemaV1.InferInput<Input>
            ) => Promise<StandardSchemaV1.InferOutput<Output>>
          : (input: StandardSchemaV1.InferInput<Input>) => Promise<void>)
    : InferClient<Tree[Key]>
}

type Join<Prefix extends string, Key extends string> = Prefix extends "" ? Key : `${Prefix}.${Key}`

type FlatLeaves<Tree, Context, Prefix extends string = ""> = {
  [Key in keyof Tree & string]: Tree[Key] extends Leaf<infer Input, infer Output>
    ? Output extends StandardSchemaV1
      ? Record<
          Join<Prefix, Key>,
          (
            input: StandardSchemaV1.InferOutput<Input>,
            context: Context
          ) => MaybePromise<StandardSchemaV1.InferInput<Output>>
        >
      : Record<
          Join<Prefix, Key>,
          (input: StandardSchemaV1.InferOutput<Input>, context: Context) => unknown
        >
    : FlatLeaves<Tree[Key], Context, Join<Prefix, Key>>
}[keyof Tree & string]

/**
 * The flat resolver map for a contract, keyed by dotted path. Resolvers receive parsed input (the
 * schema's output type, after defaults and coercions) and the context the edge passed to `dispatch`
 * — the authenticated user, the sender identity, whatever the transport knows. A leaf with an
 * `output` schema must return something it accepts; a one-way leaf's resolver may return anything —
 * the router discards it.
 */
export type InferResolvers<Tree, Context = void> = UnionToIntersection<FlatLeaves<Tree, Context>>
