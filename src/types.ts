import type { $ZodType, input, output } from "zod/v4/core"
import type { EventLeaf, ProcedureLeaf } from "./contract"

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never

/**
 * The two functions a transport supplies. `request` carries procedures, `send` carries events. A
 * transport may support only one kind; the client throws when a call reaches a function the
 * transport did not provide.
 */
export type Transport = {
  request?: (path: string, input: unknown) => Promise<unknown>
  send?: (path: string, payload: unknown) => Promise<void>
}

type LeafHelpers<Schema extends $ZodType> = {
  /**
   * The dotted path to this leaf (e.g., "localFiles.open").
   */
  $path: string

  /**
   * The Zod schema for this leaf's input (procedures) or payload (events).
   */
  $schema: Schema
}

/**
 * The Proxy-backed client shape for a contract: procedures become callable functions, events expose
 * `publish`, and every leaf carries `$`-helpers.
 */
export type InferClient<Tree> = {
  [Key in keyof Tree]: Tree[Key] extends ProcedureLeaf<infer Input, infer Output>
    ? ((input: input<Input>) => Promise<output<Output>>) & LeafHelpers<Input>
    : Tree[Key] extends EventLeaf<infer Payload>
      ? { publish: (payload: input<Payload>) => Promise<void> } & LeafHelpers<Payload>
      : InferClient<Tree[Key]>
}

type Join<Prefix extends string, Key extends string> = Prefix extends "" ? Key : `${Prefix}.${Key}`

type FlatLeaves<Tree, Prefix extends string = ""> = {
  [Key in keyof Tree & string]: Tree[Key] extends ProcedureLeaf<infer Input, infer Output>
    ? Record<Join<Prefix, Key>, (input: output<Input>) => Promise<input<Output>>>
    : Tree[Key] extends EventLeaf<infer Payload>
      ? Record<Join<Prefix, Key>, (payload: output<Payload>) => Promise<void>>
      : FlatLeaves<Tree[Key], Join<Prefix, Key>>
}[keyof Tree & string]

/**
 * The flat handler map for a contract, keyed by dotted path. Handlers receive parsed input
 * (`z.output` of the input schema, after defaults and coercions) and may return anything the output
 * schema accepts (`z.input`).
 */
export type InferHandlers<Tree> = UnionToIntersection<FlatLeaves<Tree>>
