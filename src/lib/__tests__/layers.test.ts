import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { describe, expect, test } from "vitest"

// Each folder may import only from folders that appear in its list. Dependencies point one way:
// core ← client, server ← wire ← adapters. `client` and `server` are siblings and stay ignorant of
// each other, so either half of the stack can ship without the other.
const ALLOWED: Record<string, readonly string[]> = {
  adapters: ["wire"],
  client: ["core"],
  core: [],
  server: ["core"],
  wire: ["core", "server"],
}

const LIB = resolve(import.meta.dirname, "..")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)

    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(path)
    }

    return entry.name.endsWith(".ts") ? [path] : []
  })
}

function layerOf(path: string): string | undefined {
  return relative(LIB, path).split("/")[0]
}

describe("layers", () => {
  const files = Object.keys(ALLOWED).flatMap((layer) => sourceFiles(join(LIB, layer)))

  test("every lib folder is a known layer", () => {
    const folders = readdirSync(LIB, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "__tests__")
      .map((entry) => entry.name)

    expect(folders.toSorted()).toEqual(Object.keys(ALLOWED).toSorted())
  })

  test.each(files.map((file) => [relative(LIB, file), file]))(
    "%s imports only from lower layers",
    (_name, file) => {
      const from = layerOf(file) ?? ""
      const specifiers = [...readFileSync(file, "utf8").matchAll(/from "(\.[^"]+)"/g)].map(
        (match) => match[1] ?? ""
      )
      const violations = specifiers.filter((specifier) => {
        const to = layerOf(resolve(dirname(file), specifier))
        return to !== from && !(to !== undefined && ALLOWED[from]?.includes(to))
      })

      expect(violations).toEqual([])
    }
  )
})
