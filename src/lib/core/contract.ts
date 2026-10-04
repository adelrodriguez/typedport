import type { StandardSchemaV1 } from "@standard-schema/spec"
import { SetupError } from "./setup-error"

export type Channel<
  Input extends StandardSchemaV1 = StandardSchemaV1,
  Output extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  _kind: "channel"
  input: Input
  output: Output
}

export type ContractTree = {
  [key: string]: ContractTree | Channel
}

/**
 * A contract whose leaves are all one-way (no `output` schema). One-way transports (a message
 * queue, `webContents.send`) can't carry a result back, so an adapter built on one constrains its
 * contract parameter to this — pairing it with a round-trip leaf becomes a compile error instead of
 * a call that silently resolves the wrong value.
 */
export type OneWayContract = {
  [key: string]: Channel<StandardSchemaV1, undefined> | OneWayContract
}

/**
 * A channel — one leaf of the contract tree. With `input` and `output` it is a round trip: the
 * client validates `input` before sending, the router validates it again before dispatching, and
 * the router validates the resolver's return value against `output` before the result leaves the
 * server — the client returns the transport's value as-is. With a bare schema (`channel(schema)`)
 * it is one-way: the resolver's return value is discarded and the client types the call
 * `Promise<void>`. Schemas are anything implementing Standard Schema (Zod, Valibot, ArkType, ...).
 */
export function channel<
  Input extends StandardSchemaV1,
  Output extends StandardSchemaV1,
>(definition: { input: Input; output: Output }): Channel<Input, Output>
export function channel<Input extends StandardSchemaV1>(input: Input): Channel<Input, undefined>
export function channel(
  definition: StandardSchemaV1 | { input: StandardSchemaV1; output?: StandardSchemaV1 }
): Channel {
  if ("~standard" in definition) {
    return { _kind: "channel", input: definition, output: undefined }
  }

  return { _kind: "channel", input: definition.input, output: definition.output }
}

export function isChannel(node: ContractTree | Channel): node is Channel {
  // Checking the discriminant's value (not just its presence) keeps a branch
  // that happens to contain a "_kind" key from masquerading as a leaf.
  return "_kind" in node && node._kind === "channel"
}

/**
 * Keys the client proxy must answer with `undefined` to stay inert: `then` would make every node
 * thenable (`await client.branch` dispatches "branch.then" and hangs), and `JSON.stringify` probes
 * `toJSON` the same way. `defineContract` rejects them, so nothing real is shadowed.
 */
export const INERT_KEYS: ReadonlySet<string> = new Set(["then", "toJSON"])

/**
 * Identity at the type level. At runtime it rejects keys the client proxy claims as syntax
 * (`$`-helpers), the leaf brand (`_kind`), and the {@link INERT_KEYS} — so a contract cannot define
 * a branch that the proxy would silently shadow.
 */
export function defineContract<Tree extends ContractTree>(tree: Tree): Tree {
  for (const { key, path } of walk(tree)) {
    if (key.startsWith("$") || key === "_kind" || INERT_KEYS.has(key)) {
      throw new SetupError({ code: "reserved-key", key, path })
    }

    if (key.includes(".")) {
      // Dotted paths are derived by flatten; a literal dot in a key would
      // silently collide with the equivalent nested tree.
      throw new SetupError({ code: "dotted-key", key, path })
    }
  }

  return tree
}

export function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key
}

/**
 * The one traversal the rest of the library builds on.
 *
 * @yields {{ key: string; node: Channel | ContractTree; path: string }} Every node of the tree,
 *   depth-first, with its key and dotted path.
 */
export function* walk(
  tree: ContractTree,
  prefix = ""
): Generator<{ key: string; node: Channel | ContractTree; path: string }> {
  for (const [key, node] of Object.entries(tree)) {
    const path = joinPath(prefix, key)

    yield { key, node, path }

    if (!isChannel(node)) {
      yield* walk(node, path)
    }
  }
}

/**
 * The tree as a flat `Record<path, Channel>`. The record has no prototype, so an untrusted path
 * like `"constructor"` or `"__proto__"` misses instead of resolving to an `Object.prototype`
 * member.
 */
export function flatten(tree: ContractTree, prefix = ""): Record<string, Channel> {
  const result: Record<string, Channel> = Object.create(null)

  for (const { node, path } of walk(tree, prefix)) {
    if (isChannel(node)) {
      result[path] = node
    }
  }

  return result
}
