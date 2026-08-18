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
 */
export function createClient<Tree extends ContractTree>(
  contract: Tree,
  transport: Transport
): InferClient<Tree> {
  const leaves = flatten(contract)

  return createRecursiveProxy(({ path, args }) => {
    const last = path.at(-1) ?? ""

    if (last === "$path") {
      const parentPath = path.slice(0, -1).join(".")
      getLeaf(leaves, parentPath)
      return parentPath
    }

    if (last === "$schema") {
      return getLeaf(leaves, path.slice(0, -1).join(".")).input
    }

    // Calls always return a promise: validation and misuse failures reject
    // instead of throwing synchronously.
    return send(path.join("."), args[0])
  }, []) as InferClient<Tree>

  async function send(leafPath: string, input: unknown): Promise<unknown> {
    const leaf = getLeaf(leaves, leafPath)

    // The transport's result is passed through untouched. For one-way leaves the
    // call is typed `Promise<void>`, but the raw value (a queue receipt, an ack)
    // stays reachable for edges that want it.
    return await transport(leafPath, await parseWith(leaf.input, input))
  }
}

function getLeaf(leaves: Record<string, Leaf>, path: string): Leaf {
  const leaf = leaves[path]

  if (!leaf) {
    throw new TypeportError({ code: "unknown-channel", path })
  }

  return leaf
}
