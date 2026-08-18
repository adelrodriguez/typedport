import type { StandardSchemaV1 } from "@standard-schema/spec"

export type Leaf<
  Input extends StandardSchemaV1 = StandardSchemaV1,
  Output extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  _kind: "event"
  input: Input
  output: Output
}

export type ContractTree = {
  [key: string]: ContractTree | Leaf
}

/**
 * A contract whose leaves are all one-way (no `output` schema). One-way transports (a message
 * queue, `webContents.send`) can't carry a result back, so an adapter built on one constrains its
 * contract parameter to this — pairing it with a round-trip leaf becomes a compile error instead
 * of a call that silently resolves the wrong value.
 */
export type OneWayContract = {
  [key: string]: Leaf<StandardSchemaV1, undefined> | OneWayContract
}

/**
 * A contract leaf. With `input` and `output` it is a round trip: the client validates `input`
 * before sending, the router validates it again before dispatching, and the resolver's return
 * value is validated against `output` on the way back. With a bare schema (`event(schema)`) it is
 * one-way: the resolver's return value is discarded and the client types the call `Promise<void>`.
 * Schemas are anything implementing Standard Schema (Zod, Valibot, ArkType, ...).
 */
export function event<Input extends StandardSchemaV1, Output extends StandardSchemaV1>(definition: {
  input: Input
  output: Output
}): Leaf<Input, Output>
export function event<Input extends StandardSchemaV1>(input: Input): Leaf<Input, undefined>
export function event(
  definition: StandardSchemaV1 | { input: StandardSchemaV1; output?: StandardSchemaV1 }
): Leaf {
  if ("~standard" in definition) {
    return { _kind: "event", input: definition, output: undefined }
  }

  return { _kind: "event", input: definition.input, output: definition.output }
}

export function isLeaf(node: ContractTree | Leaf): node is Leaf {
  // Checking the discriminant's value (not just its presence) keeps a branch
  // that happens to contain a "_kind" key from masquerading as a leaf.
  return "_kind" in node && node._kind === "event"
}

/**
 * Identity at the type level. At runtime it rejects keys the client proxy claims as syntax
 * (`$`-helpers) and the leaf brand (`_kind`), so a contract cannot define a branch that the proxy
 * would silently shadow.
 */
export function defineContract<Tree extends ContractTree>(tree: Tree): Tree {
  for (const [path, key] of walkKeys(tree)) {
    if (key.startsWith("$") || key === "_kind") {
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
