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
- 🧵 **`typeport/wire`** — optional subpath for real boundaries: a serializable error envelope, and `connect` to turn any duplex message pipe (MessagePort, worker, WebSocket) into a symmetric, timeout-guarded transport

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

## `typeport/wire`

Two problems every real boundary hits, solved once in an optional subpath export:

**Errors don't survive serialization.** A thrown `ValidationError` gets flattened by `invoke`, structured clone, or JSON. `dispatchToWire`/`fromWire` are the envelope: the server edge flattens every outcome into a serializable value, the client edge unwraps it — rehydrating `ValidationError` with its issues so `instanceof` works across the boundary:

```typescript
import { dispatchToWire, fromWire } from "typeport/wire"

// server edge — never throws, always returns a serializable WireResult
ipcMain.handle(channel, (_event, payload) => dispatchToWire(router, channel, payload))

// client edge — unwraps the result or rethrows, ValidationError intact
const api = createClient(contract, async (path, payload) =>
  fromWire(await window.typeport.send(path, payload))
)
```

**Message pipes have no request/response.** `postMessage`-shaped channels (MessagePorts, workers, WebSockets) need correlation ids, a pending map, timeouts, and teardown. `connect` owns all of that, over a minimal `Wire` — anything that can send a value and hand incoming values to a listener:

```typescript
import { connect, type Wire } from "typeport/wire"

const { transport, close } = connect(wire, {
  router, // serve incoming requests from the peer; omit for a call-only end
  timeoutMs: 5000, // reject a pending call if no response arrives
})
```

`connect` is symmetric: call it on both ends of a duplex pipe, each with its own router, and each side gets a transport for calling the other. It speaks the envelope internally, so error fidelity comes for free. `close(reason?)` rejects everything in flight and future calls — wire it to whatever liveness signal the pipe has (a window's `closed`, a socket's `close`).

## Recipes

A transport is one function, so the edges are almost embarrassing:

```typescript
const memory = router.dispatch
const electron = (path, input) => ipcRenderer.invoke(path, input)
const qstash = async (path, body) => qstashClient.publishJSON({ url: `${baseUrl}/${path}`, body })
const port = createPortTransport(port) // request/response over postMessage, below
```

One thing to keep straight: a one-way transport (a queue) paired with a leaf that declares an `output` is a contract error the core cannot catch at runtime — the client would resolve the publish receipt as if it were the result. Keep `output` off the leaves a one-way transport serves, and make the compiler enforce it: adapters built on one-way delivery should constrain their contract parameter to `OneWayContract`, which rejects any tree containing a round-trip leaf.

A related trick falls out of the one-function design: a transport that awaits another transport is a transport. That makes "the connection isn't ready yet" a non-problem — build the client eagerly over a deferred transport and calls made too early just wait:

```typescript
const ready = new Promise<Transport>((resolve) => {
  /* resolve when the port/socket/window arrives */
})

export const api = createClient(contract, async (path, payload) => (await ready)(path, payload))
```

<details>
<summary><strong>HTTP / fetch</strong> — any framework that speaks Request/Response</summary>

The server edge is a fetch handler (Hono, Next.js route handlers, Bun, and Deno all accept one). The wire envelope carries every outcome, so a `ValidationError` thrown by the router arrives in the browser as a real `ValidationError`:

```typescript
import { dispatchToWire } from "typeport/wire"

const handle = async (request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname.split("/").at(-1) ?? ""

  if (!router.channels.includes(path)) {
    return new Response("Unknown channel", { status: 404 })
  }

  const wire = await dispatchToWire(router, path, await request.json())

  return Response.json(wire, {
    status: wire.ok ? 200 : wire.error.issues ? 400 : 500,
  })
}
```

The client transport is a `fetch` call:

```typescript
import { createClient } from "typeport"
import { fromWire } from "typeport/wire"

const api = createClient(contract, async (path, payload) => {
  const response = await fetch(`${baseUrl}/${path}`, {
    body: JSON.stringify(payload ?? null),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  return fromWire(await response.json())
})
```

Auth, retries, and headers live in the transport function — the core never sees them. The status codes are a courtesy for logs and middleware; `fromWire` decides success from the envelope, not the status.

</details>

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

One-way leaves ride `invoke` too — the extra empty response is harmless and keeps the edge to a single function. Note that `ipcRenderer.invoke` re-throws only the error message string, so a `ValidationError` from the main process arrives in the renderer as a flat `Error`. If you need structured errors, wrap both edges in the `typeport/wire` envelope: `dispatchToWire(router, channel, payload)` in the `handle` callback, `fromWire(await ...)` in the transport. If you load remote content, also check `event.senderFrame` before dispatching.

</details>

<details>
<summary><strong>MessagePort / postMessage</strong> — bidirectional: workers, iframes, <code>MessageChannelMain</code></summary>

A port is duplex, so one `connect` per end gives you round trips in _both_ directions — each side serves its own contract and calls the other's. The only glue you write is adapting the port flavor to `Wire`:

```typescript
import type { Wire } from "typeport/wire"

// renderer / worker / iframe: DOM MessagePort
export const wrapDomPort = (port: MessagePort): Wire => ({
  send: (data) => port.postMessage(data),
  onMessage: (listener) => {
    port.addEventListener("message", (event) => listener(event.data))
    port.start()
  },
})

// Electron main / utility process: MessagePortMain
export const wrapPortMain = (port: Electron.MessagePortMain): Wire => ({
  send: (data) => port.postMessage(data),
  onMessage: (listener) => {
    port.on("message", (event) => listener(event.data))
    port.start()
  },
})
```

Electron main creates the channel, keeps one end, and ships the other to the page:

```typescript
import { BrowserWindow, MessageChannelMain } from "electron"
import { createClient } from "typeport"
import { connect } from "typeport/wire"

function connectWindow(win: BrowserWindow) {
  const { port1, port2 } = new MessageChannelMain()

  const { transport, close } = connect(wrapPortMain(port1), {
    router: mainRouter, // serves the renderer → main contract
    timeoutMs: 5_000, // a dead renderer rejects pending calls instead of hanging them
  })
  const push = createClient(pushContract, transport) // main → renderer, round trips included

  win.webContents.once("did-finish-load", () => {
    win.webContents.postMessage("typeport:port", null, [port2])
  })
  win.on("closed", () => close(new Error("window closed")))

  return push
}
```

The preload is a relay (a port can't cross `contextBridge`, but `window.postMessage` can transfer it):

```typescript
ipcRenderer.on("typeport:port", (event) => {
  window.postMessage({ type: "typeport:port" }, "*", event.ports)
})
```

The renderer is the mirror image, using a deferred transport so `api` is importable before the port arrives:

```typescript
import { createClient, createRouter, type Transport } from "typeport"
import { connect } from "typeport/wire"

const pushRouter = createRouter(pushContract, {
  // ... resolvers for main → renderer calls
})

const ready = new Promise<Transport>((resolve) => {
  window.addEventListener(
    "message",
    (event) => {
      if (event.source !== window || event.data?.type !== "typeport:port") return
      resolve(connect(wrapDomPort(event.ports[0]), { router: pushRouter }).transport)
    },
    { once: true }
  )
})

export const api = createClient(contract, async (path, payload) => (await ready)(path, payload))
```

Port messages buffer until the receiving end calls `start()`, and the deferred transport buffers calls until the port lands — no ready-handshake needed. A `ValidationError` thrown by either router arrives on the other side as a real `ValidationError` with its issues. The same wrappers work for Web Workers, iframes, and utility processes; only the port hand-off differs.

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
