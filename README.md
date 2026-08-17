<p align="center">
  <h1 align="center">🔌 <code>conduit</code></h1>
  <p align="center">
    <strong>Type-safe, Proxy-based RPC from a Standard Schema contract tree — transport-agnostic</strong>
  </p>
</p>

> [!WARNING]
> This library is a work in progress. The API is not stable yet.

**conduit** turns a nested schema tree into a strongly-typed RPC client and a validating router, with the transport left to you. Define your contract once, and get a tRPC-style Proxy client on one side and a schema-enforcing dispatcher on the other — over Electron IPC, a message queue, a WebSocket, or an in-memory function call.

It is the transport-agnostic core extracted from [`qstash-events`](https://github.com/adelrodriguez/qstash-events).

## Features

- ✅ **Type-safe** — client inputs and outputs are inferred from your contract
- 📐 **Any Standard Schema** — [Zod](https://zod.dev), [Valibot](https://valibot.dev), [ArkType](https://arktype.io), or anything else implementing [Standard Schema](https://standardschema.dev)
- 🌲 **Nested contracts** — organize operations as a tree (`localFiles.open`); dotted paths are derived automatically
- 🔐 **Validated at the boundary** — the router parses input against your schema before any handler runs, and parses procedure results on the way out so off-contract handlers fail loudly
- 🔁 **Procedures and events** — request/response (`procedure`) and fire-and-forget (`event`) leaves in one contract
- 🚚 **Bring your transport** — a transport is two functions (`call` for round trips, `post` for one-way); adapters stay ~50 lines. Per-call options (a QStash delay, an Electron transfer list) pass through untouched, and whatever `post` resolves with comes back from `publish`

## Installation

```bash
pnpm add @adelrodriguez/conduit
```

Plus your schema library of choice (`zod`, `valibot`, `arktype`, ...). The examples below use Zod.

## Usage

Define a contract:

```typescript
import { defineContract, event, procedure } from "@adelrodriguez/conduit"
import * as z from "zod"

const LocalTextFile = z.object({ contents: z.string(), path: z.string() })

export const contract = defineContract({
  localFiles: {
    open: procedure({ input: z.void(), output: LocalTextFile.nullable() }),
    save: procedure({ input: LocalTextFile, output: z.void() }),
  },
  stripe: {
    checkout: {
      created: event(z.object({ id: z.string() })),
    },
  },
})
```

Implement it with a router (the trust boundary — input is parsed before your handler runs). The handler map is contextually typed from the contract: parameters are inferred, and missing or typo'd paths are compile errors — no annotations needed:

```typescript
import { createRouter } from "@adelrodriguez/conduit"

const router = createRouter(contract, {
  "localFiles.open": async () => openFile(),
  "localFiles.save": async ({ path, contents }) => save(path, contents),
  "stripe.checkout.created": async ({ id }) => record(id),
})

// An adapter feeds untrusted (path, input) pairs into:
await router.dispatch("localFiles.save", rawInput)
```

`InferHandlers<typeof contract>` exists for when the handler map is defined away from the `createRouter` call (another file, built up incrementally) and needs a standalone type to check against.

Call it with a client (validates at the call site, then hands off to your transport):

```typescript
import { createClient } from "@adelrodriguez/conduit"

const client = createClient(contract, {
  call: (path, input) => myTransport.request(path, input),
  post: (path, payload) => myTransport.send(path, payload),
})

await client.localFiles.open()
await client.localFiles.save({ path: "/tmp/a.txt", contents: "hi" })
await client.stripe.checkout.created.publish({ id: "evt_123" })

client.localFiles.save.$path // "localFiles.save"
client.localFiles.save.$schema // the input schema
```

Wire client to router directly for tests — the whole stack with no I/O:

```typescript
import { createMemoryTransport } from "@adelrodriguez/conduit"

const client = createClient(contract, createMemoryTransport(router))
```

### Per-call options and post results

A transport can declare a per-call options type and a `post` result type; both flow through the client untouched:

```typescript
import type { Transport } from "@adelrodriguez/conduit"

type PublishOptions = { delay?: number; deduplicationId?: string }

const transport = {
  post: async (path: string, payload: unknown, options?: PublishOptions) =>
    qstash.publishJSON({ ...options, url: `${baseUrl}/${path}`, body: payload }),
} satisfies Transport<PublishOptions, { messageId: string }>

const client = createClient(contract, transport)

// options are typed, and publish resolves with the transport's result
const { messageId } = await client.stripe.checkout.created.publish(
  { id: "evt_123" },
  { delay: 60 }
)
```

## Validation model

Input is parsed twice by design. The client parses before sending so the caller gets an error with a stack trace at the call site. The router parses again before dispatching because the sender may not be your client at all — in transports like Electron IPC the receiving process must treat every message as untrusted. Only the router's parse is a security boundary.

Validation failures throw `ValidationError`, which carries the Standard Schema issues. Adapters use this to tell bad input (reject the message, keep serving) apart from handler failures (let them propagate):

```typescript
import { ValidationError } from "@adelrodriguez/conduit"

try {
  await router.dispatch(path, raw)
} catch (error) {
  if (error instanceof ValidationError) {
    return badRequest(error.issues)
  }
  throw error
}
```

Authenticity is the transport's job, not the core's: an HTTP adapter verifies signatures, an Electron adapter relies on process identity and a channel allowlist (`router.channels`). The core guarantees one thing everywhere: no handler runs on unparsed input.

## Recipes

Adapters are deliberately small — small enough to paste. Each of these is the entire integration.

<details>
<summary><strong>Electron IPC</strong> — renderer client, main-process router</summary>

A Proxy cannot cross `contextBridge` (it gets structured-cloned), so expose only the two transport functions from the preload and build the conduit client in the renderer.

```typescript
// main.ts — the router is the trust boundary for untrusted renderer input
import { ipcMain } from "electron"
import { createRouter, flatten } from "@adelrodriguez/conduit"
import { contract } from "./contract"

const router = createRouter(contract, {
  // ...
})

for (const [channel, leaf] of Object.entries(flatten(contract))) {
  if (leaf._kind === "procedure") {
    ipcMain.handle(channel, (_event, input) => router.dispatch(channel, input))
  } else {
    ipcMain.on(channel, (_event, payload) => void router.dispatch(channel, payload))
  }
}
```

```typescript
// preload.ts — just the transport, nothing else
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("conduit", {
  invoke: (path: string, input: unknown) => ipcRenderer.invoke(path, input),
  send: (path: string, payload: unknown) => ipcRenderer.send(path, payload),
})
```

```typescript
// renderer.ts
import { createClient } from "@adelrodriguez/conduit"
import { contract } from "./contract"

export const api = createClient(contract, {
  call: (path, input) => window.conduit.invoke(path, input),
  post: async (path, payload) => window.conduit.send(path, payload),
})
```

Note that `ipcRenderer.invoke` re-throws only the error message string, so a `ValidationError` from the main process arrives in the renderer as a flat `Error`. If you need structured errors, encode `{ ok, error }` in the resolved value instead (like the MessagePort recipe below). If you load remote content, also check `event.senderFrame` before dispatching.

</details>

<details>
<summary><strong>MessagePort / postMessage</strong> — workers, iframes, <code>MessageChannelMain</code></summary>

`postMessage` has no request/response primitive, so the transport adds correlation ids. The same pair works for a Web Worker, an iframe, or Electron utility processes (swap `addEventListener` for `.on` on `MessagePortMain`).

```typescript
// caller side
import type { Transport } from "@adelrodriguez/conduit"

export function createPortTransport(port: MessagePort): Transport {
  let nextId = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  port.addEventListener("message", ({ data }) => {
    const entry = data.kind === "response" ? pending.get(data.id) : undefined
    if (!entry) return
    pending.delete(data.id)
    data.ok ? entry.resolve(data.result) : entry.reject(new Error(data.error))
  })
  port.start()

  return {
    call: (path, input) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        port.postMessage({ kind: "call", id, path, input })
      }),
    post: async (path, payload) => port.postMessage({ kind: "event", path, payload }),
  }
}
```

```typescript
// handler side
import type { Router } from "@adelrodriguez/conduit"

export function attachRouter(port: MessagePort, router: Router) {
  port.addEventListener("message", async ({ data }) => {
    if (data.kind === "call") {
      try {
        const result = await router.dispatch(data.path, data.input)
        port.postMessage({ kind: "response", id: data.id, ok: true, result })
      } catch (error) {
        port.postMessage({ kind: "response", id: data.id, ok: false, error: String(error) })
      }
    } else if (data.kind === "event") {
      void router.dispatch(data.path, data.payload)
    }
  })
  port.start()
}
```

If the other end can die (a crashed utility process), add a timeout around `pending` entries — neither port flavor signals a broken peer.

</details>

<details>
<summary><strong>QStash</strong> — publish over HTTP, dispatch behind signature verification</summary>

See [`qstash-events`](https://github.com/adelrodriguez/qstash-events) for the full package. The core of it:

```typescript
import { Client, Receiver } from "@upstash/qstash"
import { createClient, createRouter, ValidationError } from "@adelrodriguez/conduit"

const qstash = new Client({ token })

const client = createClient(contract, {
  post: (path, payload, options?: { delay?: number; deduplicationId?: string }) =>
    qstash.publishJSON({ ...options, url: `${baseUrl}/${path}`, body: payload }),
})

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
