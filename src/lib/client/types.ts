import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Channel } from "../core/contract"

type ChannelHelpers<Input extends StandardSchemaV1, Output extends StandardSchemaV1 | undefined> = {
  /**
   * The dotted path to this leaf (e.g., "localFiles.open").
   */
  $path: string

  /**
   * The schema for this leaf's input — for a bare-schema leaf (`channel(schema)`), the schema
   * itself.
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
 * `$`-helpers. When the transport declares options, every call accepts them positionally and every
 * level of the tree exposes `$with(options)`, which returns the same (sub)client with those options
 * bound — per-call options shallow-merge over bound ones.
 */
export type InferClient<Tree, Options = never> = {
  [Key in keyof Tree]: Tree[Key] extends Channel<infer Input, infer Output>
    ? ChannelHelpers<Input, Output>
        & (Output extends StandardSchemaV1
          ? (
              input: StandardSchemaV1.InferInput<Input>,
              options?: Options
            ) => Promise<StandardSchemaV1.InferOutput<Output>>
          : (input: StandardSchemaV1.InferInput<Input>, options?: Options) => Promise<void>)
    : InferClient<Tree[Key], Options>
} & ([Options] extends [never]
  ? unknown
  : { $with: (options: Options) => InferClient<Tree, Options> })
