import { type ContractTree, isChannel, type Channel } from "./contract"

export function flatten(tree: ContractTree, prefix = ""): Record<string, Channel> {
  const result: Record<string, Channel> = {}

  for (const [key, node] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key

    if (isChannel(node)) {
      result[path] = node
    } else {
      Object.assign(result, flatten(node, path))
    }
  }

  return result
}
