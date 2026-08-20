import type { StandardSchemaV1 } from "@standard-schema/spec"

export type Leaf<
  Input extends StandardSchemaV1 = StandardSchemaV1,
  Output extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  _kind: "channel"
  input: Input
  output: Output
}

export type ContractTree = {
  [key: string]: ContractTree | Leaf
}

/**
 * A contract whose leaves are all one-way (no `output` schema). One-way transports (a message
 * queue, `webContents.send`) can't carry a result back, so an adapter built on one constrains its
 * contract parameter to this — pairing it with a round-trip leaf becomes a compile error instead of
 * a call that silently resolves the wrong value.
 */
export type OneWayContract = {
  [key: string]: Leaf<StandardSchemaV1, undefined> | OneWayContract
}

/**
 * A contract leaf. With `input` and `output` it is a round trip: the client validates `input`
 * before sending, the router validates it again before dispatching, and the router validates the
 * resolver's return value against `output` before the result leaves the server — the client returns
 * the transport's value as-is. With a bare schema (`channel(schema)`) it is one-way: the resolver's
 * return value is discarded and the client types the call `Promise<void>`. Schemas are anything
 * implementing Standard Schema (Zod, Valibot, ArkType, ...).
 */
export function channel<
  Input extends StandardSchemaV1,
  Output extends StandardSchemaV1,
>(definition: { input: Input; output: Output }): Leaf<Input, Output>
export function channel<Input extends StandardSchemaV1>(input: Input): Leaf<Input, undefined>
export function channel(
  definition: StandardSchemaV1 | { input: StandardSchemaV1; output?: StandardSchemaV1 }
): Leaf {
  if ("~standard" in definition) {
    return { _kind: "channel", input: definition, output: undefined }
  }

  return { _kind: "channel", input: definition.input, output: definition.output }
}

export function isLeaf(node: ContractTree | Leaf): node is Leaf {
  // Checking the discriminant's value (not just its presence) keeps a branch
  // that happens to contain a "_kind" key from masquerading as a leaf.
  return "_kind" in node && node._kind === "channel"
}

// `then` would make the client thenable — `await client.branch` dispatches
// "branch.then" and hangs. `toJSON` is probed by JSON.stringify the same way.
// The proxy refuses both keys, so the contract cannot define them.
const RESERVED_KEYS = new Set(["_kind", "then", "toJSON"])

/**
 * Identity at the type level. At runtime it rejects keys the client proxy claims as syntax
 * (`$`-helpers), the leaf brand (`_kind`), and the keys the proxy must refuse to stay inert under
 * `await` and `JSON.stringify` (`then`, `toJSON`) — so a contract cannot define a branch that the
 * proxy would silently shadow.
 */
export function defineContract<Tree extends ContractTree>(tree: Tree): Tree {
  for (const [path, key] of walkKeys(tree)) {
    if (key.startsWith("$") || RESERVED_KEYS.has(key)) {
      throw new Error(`Reserved key "${key}" at "${path}" in contract`)
    }

    if (key.includes(".")) {
      // Dotted paths are derived by flatten; a literal dot in a key would
      // silently collide with the equivalent nested tree.
      throw new Error(`Key "${key}" at "${path}" in contract must not contain "."`)
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
