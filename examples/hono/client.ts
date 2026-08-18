/* oxlint-disable no-console -- runnable example */
// The client side of the HTTP recipe: a fetch transport wrapped in fromWire.
// The transport declares per-call options — the contract knows nothing about
// HTTP, but a call site can still pick GET or attach an AbortSignal.
import { createClient, TypeportError } from "../../src/index.ts"
import { fromWire, type WireResult } from "../../src/wire.ts"
import { contract } from "./contract.ts"

const baseUrl = "http://localhost:4322"

type CallOptions = { method?: "GET"; signal?: AbortSignal }

const api = createClient(contract, async (path, payload, options?: CallOptions) => {
  const response =
    options?.method === "GET"
      ? await fetch(
          `${baseUrl}/rpc/${path}?input=${encodeURIComponent(JSON.stringify(payload ?? null))}`,
          { signal: options.signal }
        )
      : await fetch(`${baseUrl}/rpc/${path}`, {
          body: JSON.stringify(payload ?? null),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: options?.signal,
        })

  return fromWire((await response.json()) as WireResult)
})

const created = await api.todos.create({ title: "ship typeport" })
console.log("created:", created)

const toggled = await api.todos.toggle({ id: created.id })
console.log("toggled to done:", toggled.done)

// $with binds options ahead of the call — no undefined placeholder for the
// void input, and the read rides a cacheable GET.
console.log("all todos:", await api.$with({ method: "GET" }).todos.list())

await api.telemetry.pageView({ route: "/home" }) // one-way

// The client validates before sending — this never reaches the network:
await api.todos.create({ title: "" }).catch((error: unknown) => {
  if (error instanceof TypeportError && error.code === "validation") {
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
