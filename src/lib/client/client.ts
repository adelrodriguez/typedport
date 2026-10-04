import type { Transport } from "../core/transport"
import type { InferClient } from "./types"
import { type Channel, type ContractTree, flatten } from "../core/contract"
import { ChannelError } from "../core/error"
import { isRecord } from "../core/guards"
import { parseWith } from "../core/schema"
import { createRecursiveProxy } from "./proxy"

/**
 * Builds the Proxy-backed client for a contract over a transport. Every leaf is directly callable.
 *
 * Input is validated before it leaves the client so the caller gets an error at the call site, then
 * sent as the caller wrote it; the parsed result is discarded. Only the receiving router's parsed
 * value reaches the resolver: client-side validation is a convenience, only the router's parse is a
 * trust boundary.
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
        getChannel(leaves, parentPath)
        return parentPath
      }

      if (last === "$input") {
        return getChannel(leaves, path.slice(0, -1).join(".")).input
      }

      if (last === "$output") {
        return getChannel(leaves, path.slice(0, -1).join(".")).output
      }

      // Calls always return a promise: validation and misuse failures reject
      // instead of throwing synchronously.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- Proxy call arguments are untyped; the `InferClient` signature is what constrains them
      return send(path.join("."), args[0], mergeOptions(bound, args[1] as Options | undefined))
    }, basePath)

  // oxlint-disable-next-line typescript/consistent-type-assertions -- the Proxy answers every path at runtime; only the contract's type knows the shape
  return make(undefined, []) as InferClient<Tree, Options>

  async function send(
    leafPath: string,
    input: unknown,
    options: Options | undefined
  ): Promise<unknown> {
    // Validate for the call-site error, but send the caller's input as written: the router parses
    // it with the same schema, and a transform (string → number) would not survive a second pass.
    await parseWith(getChannel(leaves, leafPath).input, input)

    // The transport's result is passed through untouched. For one-way leaves the
    // call is typed `Promise<void>`, but the raw value (a queue receipt, an ack)
    // stays reachable for edges that want it.
    return await transport(leafPath, input, options)
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

function getChannel(leaves: Record<string, Channel>, path: string): Channel {
  const leaf = leaves[path]

  if (!leaf) {
    throw new ChannelError({ code: "unknown-channel", path })
  }

  return leaf
}
