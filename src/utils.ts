import { type ContractTree, isLeaf, type Leaf } from "./contract"

export function flatten(tree: ContractTree, prefix = ""): Record<string, Leaf> {
  const result: Record<string, Leaf> = {}

  for (const [key, node] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key

    if (isLeaf(node)) {
      result[path] = node
    } else {
      Object.assign(result, flatten(node, path))
    }
  }

  return result
}
