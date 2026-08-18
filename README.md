<p align="center">
  <h1 align="center">🚌 <code>typeport</code></h1>
  <p align="center">
    <strong>Type-safe, Proxy-based RPC from a Standard Schema contract tree — transport-agnostic</strong>
  </p>
</p>

> [!WARNING]
> This library is a work in progress. The API is not stable yet.

**typeport** turns a nested schema tree into a strongly-typed RPC client and a validating router, with the transport left to you. Define your contract once, and get a tRPC-style Proxy client on one side and a schema-enforcing dispatcher on the other — over Electron IPC, a message queue, a WebSocket, or an in-memory function call.

It is the transport-agnostic core extracted from [`qstash-events`](https://github.com/adelrodriguez/qstash-events).

## Features

- ✅ **Type-safe** — client inputs and outputs are inferred from your contract
- 📐 **Any Standard Schema** — [Zod](https://zod.dev), [Valibot](https://valibot.dev), [ArkType](https://arktype.io), or anything else implementing [Standard Schema](https://standardschema.dev)
- 🌲 **Nested contracts** — organize operations as a tree (`localFiles.open`); dotted paths are derived automatically
- 🔐 **Validated at the boundary** — the router parses input against your schema before any resolver runs, and parses results against `output` on the way out so off-contract resolvers fail loudly
- 🎯 **One primitive** — `event({ input, output })` is a round trip, `event(schema)` is one-way; every leaf is directly callable on the client
- 🚚 **Bring your transport** — a transport is a single function `(path, payload) => result`; `router.dispatch` is already one, and real adapters are one-liners

## Installation

```bash
pnpm add typeport
```

Plus your schema library of choice (`zod`, `valibot`, `arktype`, ...). The examples below use Zod.

## Usage

Define a contract:

```typescript
import { defineContract, event } from "typeport"
import * as z from "zod"

const LocalTextFile = z.object({ contents: z.string(), path: z.string() })

export const contract = defineContract({
  localFiles: {
    open: event({ input: z.void(), output: LocalTextFile.nullable() }),
    save: event(LocalTextFile), // input only → one-way, resolves void
  },
  stripe: {
    checkout: {
      created: event(z.object({ id: z.string() })),
    },
  },
})
```

Implement it with a router (the trust boundary — input is parsed before your resolver runs). The resolver map is contextually typed from the contract: parameters are inferred, and missing or typo'd paths are compile errors — no annotations needed:

```typescript
import { createRouter } from "typeport"

const router = createRouter(contract, {
  "localFiles.open": async () => openFile(),
  "localFiles.save": async ({ path, contents }) => save(path, contents),
  "stripe.checkout.created": async ({ id }) => record(id),
})

// An adapter feeds untrusted (path, input) pairs into:
await router.dispatch("localFiles.save", rawInput)
```

`InferResolvers<typeof contract>` exists for when the resolver map is defined away from the `createRouter` call (another file, built up incrementally) and needs a standalone type to check against.

Call it with a client. A transport is one function; every leaf is directly callable:

```typescript
import { createClient } from "typeport"

const client = createClient(contract, (path, payload) => myWire.send(path, payload))

const file = await client.localFiles.open()
await client.localFiles.save({ path: "/tmp/a.txt", contents: "hi" })
await client.stripe.checkout.created({ id: "evt_123" })

client.localFiles.save.$path // "localFiles.save"
client.localFiles.save.$schema // the input schema
```

Leaves with an `output` schema resolve with the result; one-way leaves are typed `Promise<void>`. Input is validated at the call site before it reaches the transport, and the router validates again on arrival.

`router.dispatch` is itself a valid transport, so wiring client to router directly — the whole stack with no I/O — is:

```typescript
const client = createClient(contract, router.dispatch)
```

## Validation model

Input is parsed twice by design. The client parses before sending so the caller gets an error with a stack trace at the call site. The router parses again before dispatching because the sender may not be your client at all — in transports like Electron IPC the receiving process must treat every message as untrusted. Only the router's parse is a security boundary.

Validation failures throw `ValidationError`, which carries the Standard Schema issues. Adapters use this to tell bad input (reject the message, keep serving) apart from resolver failures (let them propagate):

```typescript
import { ValidationError } from "typeport"

try {
  await router.dispatch(path, raw)
} catch (error) {
  if (error instanceof ValidationError) {
    return badRequest(error.issues)
  }
  throw error
}
```

Authenticity is the transport's job, not the core's: an HTTP adapter verifies signatures, an Electron adapter relies on process identity and a channel allowlist (`router.channels`). The core guarantees one thing everywhere: no resolver runs on unparsed input.

## Recipes

A transport is one function, so the edges are almost embarrassing:

```typescript
const memory = router.dispatch
const electron = (path, input) => ipcRenderer.invoke(path, input)
const qstash = async (path, body) => qstashClient.publishJSON({ url: `${baseUrl}/${path}`, body })
const port = createPortTransport(port) // request/response over postMessage, below
```

One thing to keep straight: a one-way transport (a queue) paired with a leaf that declares an `output` is a contract error the core cannot catch — the client would resolve the publish receipt as if it were the result. Keep `output` off the leaves a one-way transport serves.

<details>
<summary><strong>Electron IPC</strong> — renderer client, main-process router</summary>

A Proxy cannot cross `contextBridge` (it gets structured-cloned), so expose only the transport function from the preload and build the typeport client in the renderer.

```typescript
// main.ts — the router is the trust boundary for untrusted renderer input
import { ipcMain } from "electron"
import { createRouter } from "typeport"
import { contract } from "./contract"

const router = createRouter(contract, {
  // ...
})

for (const channel of router.channels) {
  ipcMain.handle(channel, (_event, payload) => router.dispatch(channel, payload))
}
```

```typescript
// preload.ts — just the transport, nothing else
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("typeport", {
  send: (path: string, payload: unknown) => ipcRenderer.invoke(path, payload),
})
```

```typescript
// renderer.ts
import { createClient } from "typeport"
import { contract } from "./contract"

export const api = createClient(contract, (path, payload) => window.typeport.send(path, payload))
```

One-way leaves ride `invoke` too — the extra empty response is harmless and keeps the edge to a single function. Note that `ipcRenderer.invoke` re-throws only the error message string, so a `ValidationError` from the main process arrives in the renderer as a flat `Error`. If you need structured errors, encode `{ ok, error }` in the resolved value instead (like the MessagePort recipe below). If you load remote content, also check `event.senderFrame` before dispatching.

</details>

<details>
<summary><strong>MessagePort / postMessage</strong> — workers, iframes, <code>MessageChannelMain</code></summary>

`postMessage` has no request/response primitive, so the transport adds correlation ids. The same pair works for a Web Worker, an iframe, or Electron utility processes (swap `addEventListener` for `.on` on `MessagePortMain`).

```typescript
// caller side
import type { Transport } from "typeport"

export function createPortTransport(port: MessagePort): Transport {
  let nextId = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  port.addEventListener("message", ({ data }) => {
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    data.ok ? entry.resolve(data.result) : entry.reject(new Error(data.error))
  })
  port.start()

  return (path, payload) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      port.postMessage({ id, path, payload })
    })
}
```

```typescript
// handler side
import type { Router } from "typeport"

export function attachRouter(port: MessagePort, router: Router) {
  port.addEventListener("message", async ({ data }) => {
    try {
      const result = await router.dispatch(data.path, data.payload)
      port.postMessage({ id: data.id, ok: true, result })
    } catch (error) {
      port.postMessage({ id: data.id, ok: false, error: String(error) })
    }
  })
  port.start()
}
```

If the other end can die (a crashed utility process), add a timeout around `pending` entries — neither port flavor signals a broken peer.

</details>

<details>
<summary><strong>QStash</strong> — publish over HTTP, dispatch behind signature verification</summary>

See [`qstash-events`](https://github.com/adelrodriguez/qstash-events) for the full package. QStash is one-way, so the contract it serves uses bare-schema leaves only. Publish options (delay, deduplication) live at the edge — bake them into the transport, per path if needed:

```typescript
import { Client, Receiver } from "@upstash/qstash"
import { createClient, createRouter, ValidationError } from "typeport"

const qstash = new Client({ token })

const client = createClient(contract, (path, body) =>
  qstash.publishJSON({ url: `${baseUrl}/${path}`, body })
)

// fetch-based receiver: verify the signature, then hand the untrusted pair to the router
const handle = async (request: Request): Promise<Response> => {
  const signature = request.headers.get("upstash-signature")
  if (!signature) return new Response("Missing signature", { status: 400 })

  const body = await request.text()
  const isValid = await receiver.verify({ body, signature }).catch(() => false)
  if (!isValid) return new Response("Invalid signature", { status: 403 })

  const path = new URL(request.url).pathname.split("/").at(-1) ?? ""
  if (!router.channels.includes(path)) {
    return new Response(`Unknown message type: ${path}`, { status: 400 })
  }

  try {
    await router.dispatch(path, JSON.parse(body))
    return Response.json({ message: "Message processed successfully" })
  } catch (error) {
    if (error instanceof ValidationError) {
      return new Response("Invalid message structure", { status: 400 })
    }
    throw error
  }
}
```

</details>

## License

MIT
