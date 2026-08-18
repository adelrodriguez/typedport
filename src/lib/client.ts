import type { ContractTree, Leaf } from "./contract"
import type { InferClient, Transport } from "./types"
import { TypeportError } from "./error"
import { createRecursiveProxy } from "./proxy"
import { parseWith } from "./standard"
import { flatten } from "./utils"

/**
 * Builds the Proxy-backed client for a contract over a transport. Every leaf is directly callable.
 *
 * Input is validated before it leaves the client so the caller gets an error at the call site. The
 * receiving router validates again: client-side parsing is a convenience, only the router's parse
 * is a trust boundary.
 *
 * When the transport declares a per-call options parameter, every call accepts it positionally
 * (`api.leaf(input, options)`) and `$with(options)` — on the root or any subtree — returns the same
 * client with those options bound, so leaves with `void` inputs need no `undefined` placeholder:
 * `api.$with({ signal }).localFiles.open()`.
 */
export function createClient<Tree extends ContractTree, Options = never>(
  contract: Tree,
  transport: Transport<Options>
): InferClient<Tree, Options> {
  const leaves = flatten(contract)

  const make = (bound: Options | undefined, basePath: readonly string[]): unknown =>
    createRecursiveProxy(({ path, args }) => {
      const last = path.at(-1) ?? ""

      if (last === "$with") {
        // `$`-keys resolve on property access, so return the binder itself.
        const base = path.slice(0, -1)
        return (options: Options) => make(mergeOptions(bound, options), base)
      }

      if (last === "$path") {
        const parentPath = path.slice(0, -1).join(".")
        getLeaf(leaves, parentPath)
        return parentPath
      }

      if (last === "$input") {
        return getLeaf(leaves, path.slice(0, -1).join(".")).input
      }

      if (last === "$output") {
        return getLeaf(leaves, path.slice(0, -1).join(".")).output
      }

      // Calls always return a promise: validation and misuse failures reject
      // instead of throwing synchronously.
      return send(path.join("."), args[0], mergeOptions(bound, args[1] as Options | undefined))
    }, basePath)

  return make(undefined, []) as InferClient<Tree, Options>

  async function send(
    leafPath: string,
    input: unknown,
    options: Options | undefined
  ): Promise<unknown> {
    const leaf = getLeaf(leaves, leafPath)

    // The transport's result is passed through untouched. For one-way leaves the
    // call is typed `Promise<void>`, but the raw value (a queue receipt, an ack)
    // stays reachable for edges that want it.
    return await transport(leafPath, await parseWith(leaf.input, input), options)
  }
}

function mergeOptions<Options>(
  bound: Options | undefined,
  perCall: Options | undefined
): Options | undefined {
  if (perCall === undefined) {
    return bound
  }

  if (bound === undefined) {
    return perCall
  }

  if (isRecord(bound) && isRecord(perCall)) {
    return { ...bound, ...perCall }
  }

  return perCall
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getLeaf(leaves: Record<string, Leaf>, path: string): Leaf {
  const leaf = leaves[path]

  if (!leaf) {
    throw new TypeportError({ code: "unknown-channel", path })
  }

  return leaf
}
