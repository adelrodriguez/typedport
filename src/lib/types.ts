import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { EventLeaf, ProcedureLeaf } from "./contract"

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never

type MaybePromise<T> = Promise<T> | T

type LeafHelpers<Schema extends StandardSchemaV1> = {
  /**
   * The dotted path to this leaf (e.g., "localFiles.open").
   */
  $path: string

  /**
   * The schema for this leaf's input (procedures) or payload (events).
   */
  $schema: Schema
}

/**
 * The Proxy-backed client shape for a contract: procedures become callable functions, events expose
 * `publish`, and every leaf carries `$`-helpers.
 */
export type InferClient<Tree, Options = never, PostResult = void> = {
  [Key in keyof Tree]: Tree[Key] extends ProcedureLeaf<infer Input, infer Output>
    ? ((
        input: StandardSchemaV1.InferInput<Input>,
        options?: Options
      ) => Promise<StandardSchemaV1.InferOutput<Output>>) &
        LeafHelpers<Input>
    : Tree[Key] extends EventLeaf<infer Payload>
      ? {
          publish: (
            payload: StandardSchemaV1.InferInput<Payload>,
            options?: Options
          ) => Promise<PostResult>
        } & LeafHelpers<Payload>
      : InferClient<Tree[Key], Options, PostResult>
}

type Join<Prefix extends string, Key extends string> = Prefix extends "" ? Key : `${Prefix}.${Key}`

type FlatLeaves<Tree, Prefix extends string = ""> = {
  [Key in keyof Tree & string]: Tree[Key] extends ProcedureLeaf<infer Input, infer Output>
    ? Record<
        Join<Prefix, Key>,
        (
          input: StandardSchemaV1.InferOutput<Input>
        ) => MaybePromise<StandardSchemaV1.InferInput<Output>>
      >
    : Tree[Key] extends EventLeaf<infer Payload>
      ? Record<Join<Prefix, Key>, (payload: StandardSchemaV1.InferOutput<Payload>) => unknown>
      : FlatLeaves<Tree[Key], Join<Prefix, Key>>
}[keyof Tree & string]

/**
 * The flat handler map for a contract, keyed by dotted path. Handlers receive parsed input (the
 * schema's output type, after defaults and coercions) and may return anything the output schema
 * accepts. Event handlers may return a value; the router discards it.
 */
export type InferHandlers<Tree> = UnionToIntersection<FlatLeaves<Tree>>
