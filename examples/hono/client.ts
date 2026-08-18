/* oxlint-disable no-console -- runnable example */
// The client side of the HTTP recipe: a fetch transport wrapped in fromWire.
// In a browser this file is identical — fetch and the contract are the same.
import { createClient, ValidationError } from "../../src/index.ts"
import { fromWire, type WireResult } from "../../src/wire.ts"
import { contract } from "./contract.ts"

const baseUrl = "http://localhost:4322"

const api = createClient(contract, async (path, payload) => {
  const response = await fetch(`${baseUrl}/rpc/${path}`, {
    body: JSON.stringify(payload ?? null),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  return fromWire((await response.json()) as WireResult)
})

const created = await api.todos.create({ title: "ship typeport" })
console.log("created:", created)

const toggled = await api.todos.toggle({ id: created.id })
console.log("toggled to done:", toggled.done)

console.log("all todos:", await api.todos.list())

await api.telemetry.pageView({ route: "/home" }) // one-way

// The client validates before sending — this never reaches the network:
await api.todos.create({ title: "" }).catch((error: unknown) => {
  if (error instanceof ValidationError) {
    console.log("rejected at the call site:", error.issues[0]?.message)
  }
})

// Bypass the client to show the server's own trust boundary: the router
// rejects off-contract input and the route maps it to a 400.
const raw = await fetch(`${baseUrl}/rpc/todos.create`, {
  body: JSON.stringify({ title: 42 }),
  headers: { "content-type": "application/json" },
  method: "POST",
})
console.log("server status for off-contract input:", raw.status)
