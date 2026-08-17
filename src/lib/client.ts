import type { ContractTree, Leaf } from "./contract"
import { createRecursiveProxy } from "./proxy"
import { parseWith } from "./standard"
import type { Transport } from "./transport"
import type { InferClient } from "./types"
import { flatten } from "./utils"

/**
 * Builds the Proxy-backed client for a contract over a transport.
 *
 * Input is validated before it leaves the client so the caller gets an error at the call site. The
 * receiving router validates again: client-side parsing is a convenience, only the router's parse
 * is a trust boundary.
 */
export function createClient<Tree extends ContractTree, Options = never, PostResult = void>(
  contract: Tree,
  transport: Transport<Options, PostResult>
): InferClient<Tree, Options, PostResult> {
  const leaves = flatten(contract)

  return createRecursiveProxy(({ path, args }) => {
    const last = path.at(-1) ?? ""
    const parentPath = path.slice(0, -1).join(".")

    if (last === "$path") {
      getLeaf(leaves, parentPath)
      return parentPath
    }

    if (last === "$schema") {
      const leaf = getLeaf(leaves, parentPath)
      return leaf._kind === "event" ? leaf.payload : leaf.input
    }

    // Call-shaped operations always return a promise: validation and misuse
    // failures reject instead of throwing synchronously.
    if (last === "publish") {
      return publishEvent(parentPath, args[0], args[1])
    }

    return callProcedure(path.join("."), args[0], args[1])
  }, []) as InferClient<Tree, Options, PostResult>

  async function publishEvent(
    leafPath: string,
    payload: unknown,
    options: unknown
  ): Promise<PostResult> {
    const leaf = getLeaf(leaves, leafPath)

    if (leaf._kind !== "event") {
      throw new Error(`"${leafPath}" is a procedure; call it directly`)
    }

    if (!transport.post) {
      throw new Error("Transport does not support events")
    }

    return await transport.post(leafPath, await parseWith(leaf.payload, payload), options as Options)
  }

  async function callProcedure(
    leafPath: string,
    input: unknown,
    options: unknown
  ): Promise<unknown> {
    const leaf = getLeaf(leaves, leafPath)

    if (leaf._kind !== "procedure") {
      throw new Error(`"${leafPath}" is an event; use .publish()`)
    }

    if (!transport.call) {
      throw new Error("Transport does not support procedures")
    }

    return await transport.call(leafPath, await parseWith(leaf.input, input), options as Options)
  }
}

function getLeaf(leaves: Record<string, Leaf>, path: string): Leaf {
  const leaf = leaves[path]

  if (!leaf) {
    throw new Error(`Unknown channel: "${path}"`)
  }

  return leaf
}
