import type { StandardSchemaV1 } from "@standard-schema/spec"

export type ProcedureLeaf<
  Input extends StandardSchemaV1 = StandardSchemaV1,
  Output extends StandardSchemaV1 = StandardSchemaV1,
> = {
  _kind: "procedure"
  input: Input
  output: Output
}

export type EventLeaf<Payload extends StandardSchemaV1 = StandardSchemaV1> = {
  _kind: "event"
  payload: Payload
}

export type Leaf = EventLeaf | ProcedureLeaf

export type ContractTree = {
  [key: string]: ContractTree | Leaf
}

/**
 * A request/response operation. The client validates `input` before sending, the router validates
 * it again before dispatching, and the handler's return value is validated against `output`.
 * Schemas are anything implementing Standard Schema (Zod, Valibot, ArkType, ...).
 */
export function procedure<Input extends StandardSchemaV1, Output extends StandardSchemaV1>(
  definition: {
    input: Input
    output: Output
  }
): ProcedureLeaf<Input, Output> {
  return { _kind: "procedure", ...definition }
}

/**
 * A fire-and-forget message. The client validates `payload` before sending and the router validates
 * it again before dispatching.
 */
export function event<Payload extends StandardSchemaV1>(payload: Payload): EventLeaf<Payload> {
  return { _kind: "event", payload }
}

export function isLeaf(node: ContractTree | Leaf): node is Leaf {
  // Checking the discriminant's value (not just its presence) keeps a branch
  // that happens to contain a "_kind" key from masquerading as a leaf.
  return "_kind" in node && (node._kind === "procedure" || node._kind === "event")
}

/**
 * Identity at the type level. At runtime it rejects keys the client proxy claims as syntax
 * (`$`-helpers, `publish`) and the leaf brand (`_kind`), so a contract cannot define a branch that
 * the proxy would silently shadow.
 */
export function defineContract<Tree extends ContractTree>(tree: Tree): Tree {
  for (const [path, key] of walkKeys(tree)) {
    if (key.startsWith("$") || key === "publish" || key === "_kind") {
      throw new Error(`Reserved key "${key}" at "${path}" in contract`)
    }
  }

  return tree
}

function* walkKeys(tree: ContractTree, prefix = ""): Generator<[path: string, key: string]> {
  for (const [key, node] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key

    yield [path, key]

    if (!isLeaf(node)) {
      yield* walkKeys(node, path)
    }
  }
}
