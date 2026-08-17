import { parse } from "zod/v4/core"
import type { ContractTree, Leaf } from "./contract"
import type { InferClient, Transport } from "./types"
import { createRecursiveProxy } from "./lib/proxy"
import { flatten } from "./utils"

/**
 * Builds the Proxy-backed client for a contract over a transport.
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
      return publishEvent(parentPath, args[0])
    }

    return callProcedure(path.join("."), args[0])
  }, []) as InferClient<Tree>

  async function publishEvent(leafPath: string, payload: unknown): Promise<void> {
    const leaf = getLeaf(leaves, leafPath)

    if (leaf._kind !== "event") {
      throw new Error(`"${leafPath}" is a procedure; call it directly`)
    }

    if (!transport.send) {
      throw new Error("Transport does not support events")
    }

    await transport.send(leafPath, parse(leaf.payload, payload))
  }

  async function callProcedure(leafPath: string, input: unknown): Promise<unknown> {
    const leaf = getLeaf(leaves, leafPath)

    if (leaf._kind !== "procedure") {
      throw new Error(`"${leafPath}" is an event; use .publish()`)
    }

    if (!transport.request) {
      throw new Error("Transport does not support procedures")
    }

    return await transport.request(leafPath, parse(leaf.input, input))
  }
}

function getLeaf(leaves: Record<string, Leaf>, path: string): Leaf {
  const leaf = leaves[path]

  if (!leaf) {
    throw new Error(`Unknown channel: "${path}"`)
  }

  return leaf
}
