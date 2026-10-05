import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import packageJson from "../package.json" with { type: "json" }

const packageRoot = join(import.meta.dirname, "..")
const temporaryDirectory = mkdtempSync(join(tmpdir(), "typedport-build-"))
const exportPaths = Object.values(packageJson.exports).flatMap((entrypoint) => [
  entrypoint.import,
  entrypoint.types,
])

function run(command: string, arguments_: string[], cwd: string) {
  execFileSync(command, arguments_, { cwd, stdio: "inherit" })
}

try {
  for (const exportPath of exportPaths) {
    if (!existsSync(join(packageRoot, exportPath))) {
      throw new Error(`The package export does not exist: ${exportPath}`)
    }
  }

  run("pnpm", ["pack", "--pack-destination", temporaryDirectory], packageRoot)

  const tarballs = readdirSync(temporaryDirectory).filter((file) => file.endsWith(".tgz"))
  const [tarball] = tarballs
  if (!tarball || tarballs.length !== 1) {
    throw new Error(`Expected one package tarball, found ${tarballs.length}`)
  }

  const tarballPath = join(temporaryDirectory, tarball)
  writeFileSync(
    join(temporaryDirectory, "package.json"),
    `${JSON.stringify({ name: "typedport-build-verification", private: true, type: "module" }, null, 2)}\n`
  )
  run("npm", ["install", "--ignore-scripts", "--no-package-lock", tarballPath], temporaryDirectory)

  writeFileSync(
    join(temporaryDirectory, "runtime.mjs"),
    `import assert from "node:assert/strict"
import { channel, createClient, createRouter, defineContract, implement } from "typedport"
import { connect, fromWire, toWire } from "typedport/wire"
import { mainPort, nodePort, sendPort } from "typedport/wire/message-port"
import { webSocket, whenOpen } from "typedport/wire/web-socket"

for (const value of [
  channel,
  createClient,
  createRouter,
  defineContract,
  implement,
  connect,
  fromWire,
  toWire,
  mainPort,
  nodePort,
  sendPort,
  webSocket,
  whenOpen,
]) {
  assert.equal(typeof value, "function")
}
`
  )
  run(process.execPath, ["runtime.mjs"], temporaryDirectory)

  writeFileSync(
    join(temporaryDirectory, "consumer.ts"),
    `import type { InferClient, Router, Transport } from "typedport"
import type { Wire, WireResult } from "typedport/wire"
import type { NodePortLike } from "typedport/wire/message-port"
import type { WebSocketLike } from "typedport/wire/web-socket"

export type Exports = [InferClient<never>, Router, Transport, Wire, WireResult, NodePortLike, WebSocketLike]
`
  )
  writeFileSync(
    join(temporaryDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ESNext",
          types: [],
        },
        files: ["consumer.ts"],
      },
      null,
      2
    )}\n`
  )
  run(
    process.execPath,
    [join(packageRoot, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"],
    temporaryDirectory
  )

  console.info("Verified the packed typedport runtime and declarations.")
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
