<p align="center">
  <h1 align="center">🚌 <code>typedport</code></h1>
  <p align="center">
    <strong>Type-safe RPC over any transport</strong>
  </p>
</p>

> [!WARNING]
> This library is a work in progress. The API is not stable yet.

**typedport** turns a nested schema tree into a strongly-typed RPC client and a validating router, with the transport left to you. Define your contract once, and get a tRPC-style Proxy client on one side and a schema-enforcing dispatcher on the other — over Electron IPC, a message queue, a WebSocket, or an in-memory function call.

## Features

- ✅ **Type-safe** — client inputs and outputs are inferred from your contract
- 📐 **Any Standard Schema** — [Zod](https://zod.dev), [Valibot](https://valibot.dev), [ArkType](https://arktype.io), or anything else implementing [Standard Schema](https://standardschema.dev)
- 🌲 **Nested contracts** — organize operations as a tree (`localFiles.open`); dotted paths are derived automatically
- 🔐 **Validated at the boundary** — the router parses input against your schema before any resolver runs, and parses results against `output` on the way out so off-contract resolvers fail loudly
- 🎯 **One primitive** — `channel({ input, output })` is a round trip, `channel(schema)` is one-way; every leaf is directly callable on the client
- 🚚 **Bring your transport** — a transport is a single function `(path, payload, options?) => result`; `router.dispatch` is already one, real adapters are one-liners, and per-call options (an `AbortSignal`, a transfer list) flow through untouched via `$with` or positionally
- 🧵 **`typedport/wire`** — optional subpath for real boundaries: a serializable error envelope, and `connect` to turn any duplex message pipe (MessagePort, worker, WebSocket) into a symmetric, timeout-guarded transport

## Installation

```bash
pnpm add typedport
```

Plus your schema library of choice (`zod`, `valibot`, `arktype`, ...). The examples below use Zod.

## Usage

Define a contract:

```typescript
import { defineContract, channel } from "typedport"
import * as z from "zod"

const LocalTextFile = z.object({ contents: z.string(), path: z.string() })

export const contract = defineContract({
  localFiles: {
    open: channel({ input: z.void(), output: LocalTextFile.nullable() }),
    save: channel(LocalTextFile), // input only → one-way, resolves void
  },
  stripe: {
    checkout: {
      created: channel(z.object({ id: z.string() })),
    },
  },
})
```

Implement it with a router (the trust boundary — input is parsed before your resolver runs). The resolver map is contextually typed from the contract: parameters are inferred, and missing or typo'd paths are compile errors — no annotations needed:

```typescript
import { createRouter } from "typedport"

const router = createRouter(contract, {
  "localFiles.open": async () => openFile(),
  "localFiles.save": async ({ path, contents }) => save(path, contents),
  "stripe.checkout.created": async ({ id }) => record(id),
})

// An adapter feeds untrusted (path, input) pairs into:
await router.dispatch("localFiles.save", rawInput)
```

Resolvers also receive a **context** — whatever the edge knows about the caller (the authenticated user, `event.senderFrame`, the socket session). Declare its type explicitly and the edge supplies it per dispatch:

```typescript
type Session = { userId: string }

const router = createRouter<typeof contract, Session>(contract, {
  "localFiles.open": async (_input, session) => openFile(session.userId),
  "localFiles.save": async ({ path, contents }, session) => save(session.userId, path, contents),
  "stripe.checkout.created": async ({ id }) => record(id), // context is optional to use
})

await router.dispatch("localFiles.save", rawInput, { userId: authenticate(request) })
```

With the default `Context = void`, the third argument disappears and `dispatch` stays a valid two-argument `Transport`.

`InferResolvers<typeof contract, Context>` exists for when the resolver map is defined away from the `createRouter` call (another file, built up incrementally) and needs a standalone type to check against.

Call it with a client. A transport is one function; every leaf is directly callable:

```typescript
import { createClient } from "typedport"

const client = createClient(contract, (path, payload) => myWire.send(path, payload))

const file = await client.localFiles.open()
await client.localFiles.save({ path: "/tmp/a.txt", contents: "hi" })
await client.stripe.checkout.created({ id: "evt_123" })

client.localFiles.save.$path // "localFiles.save"
client.localFiles.save.$input // the input schema — for a bare-schema leaf, the schema itself
client.localFiles.open.$output // the output schema, or undefined on one-way leaves
```

Leaves with an `output` schema resolve with the result; one-way leaves are typed `Promise<void>`. Input is validated at the call site before it reaches the transport, and the router validates again on arrival.

`router.dispatch` is itself a valid transport, so wiring client to router directly — the whole stack with no I/O — is:

```typescript
const client = createClient(contract, router.dispatch)
```

### Per-call options

A transport may declare a third `options` parameter — per-call edge mechanics (an `AbortSignal`, an Electron transfer list, an HTTP method) that never travel in the payload. The type is inferred from the transport's own annotation and flows to every call site; `$with(options)` on the root or any subtree returns the same client with options bound, so leaves with `void` inputs need no `undefined` placeholder:

```typescript
const api = createClient(contract, async (path, payload, options?: { signal?: AbortSignal }) => {
  return await sendOverTheWire(path, payload, options?.signal)
})

await api.localFiles.save(file, { signal: controller.signal }) // positional
await api.$with({ signal: controller.signal }).localFiles.open() // bound

const cancellable = api.$with({ signal: controller.signal })
await cancellable.stripe.checkout.created({ id: "evt_123" }) // bound options apply to every call
```

Per-call options shallow-merge over bound ones. When the transport declares no options, none of this surface exists — calls are `(input)` and `$with` is not in the type.

## Validation model

Input is parsed twice by design. The client parses before sending so the caller gets an error with a stack trace at the call site. The router parses again before dispatching because the sender may not be your client at all — in transports like Electron IPC the receiving process must treat every message as untrusted. Only the router's parse is a security boundary.

Results flow the other way with one parse: the router validates the resolver's return against `output` before it leaves the server, and the client returns the transport's value as-is. When the peer is a typedport router the result is schema-checked end to end; when it isn't (a plain HTTP endpoint, a mock), the client's return type is a promise, not a guarantee — validate at the edge if you don't trust the peer. The pieces are already in hand: `parseWith` is the same primitive the router uses, and every round-trip leaf carries its schema as `$output`:

```typescript
import { parseWith } from "typedport"

const raw = await api.localFiles.open()
const file = await parseWith(api.localFiles.open.$output, raw) // now a guarantee, not a claim
```

Every failure the library raises is a `ChannelError`, discriminated by `code` — `validation` (the caller's input failed, with the Standard Schema `issues`), `output-validation` (the resolver's result drifted off contract — the server's fault, not the caller's), `unknown-channel` (with the `path`), the `connect` lifecycle codes `timeout`, `closed`, and `no-router`, and `malformed-envelope` (`fromWire` got something that isn't an envelope). One `instanceof`, then `code` narrows the fields; anything that is _not_ a `ChannelError` came from application code:

```typescript
import { ChannelError } from "typedport"

try {
  await router.dispatch(path, raw)
} catch (error) {
  if (error instanceof ChannelError && error.code === "validation") {
    return badRequest(error.issues)
  }
  throw error // unknown channel, or the resolver itself failed
}
```

Authenticity is the transport's job, not the core's: an HTTP adapter verifies signatures, an Electron adapter relies on process identity and a channel allowlist (`router.channels`). The core guarantees one thing everywhere: no resolver runs on unparsed input.

## `typedport/wire`

Two problems every real boundary hits, solved once in an optional subpath export:

**Errors don't survive serialization.** A thrown `ChannelError` gets flattened by `invoke`, structured clone, or JSON. `toWire`/`fromWire` are the codec: `toWire` captures any operation's outcome as a serializable value, `fromWire` unwraps it on the other side — returning the result or rethrowing, with `ChannelError` rehydrated (code and fields intact) so `instanceof` and `code` checks work across the boundary:

```typescript
import { fromWire, toWire } from "typedport/wire"

// server edge — never throws, always resolves a serializable WireResult
ipcMain.handle(channel, (_event, payload) => toWire(router.dispatch(channel, payload)))

// client edge — unwraps the result or rethrows, ChannelError intact
const api = createClient(contract, async (path, payload) =>
  fromWire(await window.typedport.send(path, payload))
)
```

`toWire` takes the operation's promise — dispatch, a queue publish, anything — or a thunk when the operation can throw synchronously. `fromWire(await toWire(x))` returns what `x` resolved with, or rethrows what it threw.

**Message pipes have no request/response.** `postMessage`-shaped channels (MessagePorts, workers, WebSockets) need correlation ids, a pending map, timeouts, and teardown. `connect` owns all of that, over a minimal `Wire` — anything that can send a value and hand incoming values to a listener:

```typescript
import { connect, type Wire } from "typedport/wire"

const { transport, close } = connect(wire, {
  router, // serve incoming requests from the peer; omit for a call-only end
  context: session, // per-connection: passed to every dispatch this end serves
  timeoutMs: 5000, // reject a pending call if no response arrives
})
```

`connect` is symmetric: call it on both ends of a duplex pipe, each with its own router, and each side gets a transport for calling the other. It speaks the envelope internally, so error fidelity comes for free — which also makes it a **trusted-peer** transport: the peer sees every `ChannelError` detail, including server-fault codes like `output-validation`. An untrusted peer (a browser talking to a public server) belongs behind an edge that redacts, like the HTTP recipe. `close(reason?)` rejects everything in flight and future calls — wire it to whatever liveness signal the pipe has (a window's `closed`, a socket's `close`).

## Writing an adapter

Adapters live in your codebase, not in this package — a transport is one function, and the examples in this repo (worker threads, WebSocket, Hono) are the reference implementations. These exports are the supported toolkit for building one:

- **`flatten(contract)`** — the tree as a flat `Record<path, Channel>`, for edges that register endpoints ahead of time (`router.channels` is the same list of paths).
- **`isChannel(node)`** — the discriminant for walking a `ContractTree` yourself.
- **`parseWith(schema, value)`** — the single parse primitive the client and router use; reuse it to validate on a path the router never sees (a publish edge, a response you don't trust). Throws `ChannelError` with code `validation` and the Standard Schema `issues`.
- **Types** — annotate your adapter's function as `Transport` (declare an options parameter and it flows to every call site), accept contracts as `ContractTree`, and constrain one-way adapters to `OneWayContract` so a round-trip leaf is a compile error. `InferClient` and `Channel` cover the places you wrap or re-expose the client.
- **`toWire` / `fromWire`** (from `typedport/wire`) — the error-fidelity codec for any serializing boundary, and `connect` when the boundary is a duplex message pipe.

## Recipes

A transport is one function, so the edges are almost embarrassing:

```typescript
const memory = router.dispatch
const electron = (path, input) => ipcRenderer.invoke(path, input)
const queue = async (path, body) => queueClient.publishJSON({ url: `${baseUrl}/${path}`, body })
const port = connect(wrapDomPort(messagePort)).transport // request/response over postMessage, below
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

The server edge is a fetch handler (Hono, Next.js route handlers, Bun, and Deno all accept one). The wire envelope carries every outcome, so a `ChannelError` thrown by the router arrives in the browser with its `code` and fields intact:

```typescript
import { toWire } from "typedport/wire"

const handle = async (request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname.split("/").at(-1) ?? ""

  if (!router.channels.includes(path)) {
    return new Response("Unknown channel", { status: 404 })
  }

  // JSON has no undefined, so the client sends null for void inputs; map it
  // back so z.void() leaves round-trip.
  const wire = await toWire(router.dispatch(path, (await request.json()) ?? undefined))

  if (wire.ok) {
    return Response.json(wire, { status: 200 })
  }

  // Only `validation` is the caller's fault. Everything else — an application
  // error, an off-contract resolver result (`output-validation`) — belongs in
  // the server's logs, not in a response to an untrusted caller.
  if (wire.error.detail?.code === "validation") {
    return Response.json(wire, { status: 400 })
  }

  console.error(wire.error)
  return Response.json(
    { ok: false, error: { message: "Internal server error", name: "Error" } },
    { status: 500 }
  )
}
```

The client transport is a `fetch` call:

```typescript
import { createClient } from "typedport"
import { fromWire } from "typedport/wire"

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

A Proxy cannot cross `contextBridge` (it gets structured-cloned), so expose only the transport function from the preload and build the typedport client in the renderer.

```typescript
// main.ts — the router is the trust boundary for untrusted renderer input
import { ipcMain } from "electron"
import { createRouter } from "typedport"
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

contextBridge.exposeInMainWorld("typedport", {
  send: (path: string, payload: unknown) => ipcRenderer.invoke(path, payload),
})
```

```typescript
// renderer.ts
import { createClient } from "typedport"
import { contract } from "./contract"

export const api = createClient(contract, (path, payload) => window.typedport.send(path, payload))
```

One-way leaves ride `invoke` too — the extra empty response is harmless and keeps the edge to a single function. Note that `ipcRenderer.invoke` re-throws only the error message string, so a `ChannelError` from the main process arrives in the renderer as a flat `Error`. If you need structured errors, wrap both edges in the `typedport/wire` envelope: `toWire(router.dispatch(channel, payload))` in the `handle` callback, `fromWire(await ...)` in the transport. If you load remote content, also check `event.senderFrame` before dispatching.

</details>

<details>
<summary><strong>MessagePort / postMessage</strong> — bidirectional: workers, iframes, <code>MessageChannelMain</code></summary>

A port is duplex, so one `connect` per end gives you round trips in _both_ directions — each side serves its own contract and calls the other's. The only glue you write is adapting the port flavor to `Wire`:

```typescript
import type { Wire } from "typedport/wire"

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
import { createClient } from "typedport"
import { connect } from "typedport/wire"

function connectWindow(win: BrowserWindow) {
  const { port1, port2 } = new MessageChannelMain()

  const { transport, close } = connect(wrapPortMain(port1), {
    router: mainRouter, // serves the renderer → main contract
    timeoutMs: 5_000, // a dead renderer rejects pending calls instead of hanging them
  })
  const push = createClient(pushContract, transport) // main → renderer, round trips included

  win.webContents.once("did-finish-load", () => {
    win.webContents.postMessage("typedport:port", null, [port2])
  })
  win.on("closed", () => close(new Error("window closed")))

  return push
}
```

The preload is a relay (a port can't cross `contextBridge`, but `window.postMessage` can transfer it):

```typescript
ipcRenderer.on("typedport:port", (event) => {
  window.postMessage({ type: "typedport:port" }, "*", event.ports)
})
```

The renderer is the mirror image, using a deferred transport so `api` is importable before the port arrives:

```typescript
import { createClient, createRouter, type Transport } from "typedport"
import { connect } from "typedport/wire"

const pushRouter = createRouter(pushContract, {
  // ... resolvers for main → renderer calls
})

const ready = new Promise<Transport>((resolve) => {
  window.addEventListener(
    "message",
    (event) => {
      if (event.source !== window || event.data?.type !== "typedport:port") return
      resolve(connect(wrapDomPort(event.ports[0]), { router: pushRouter }).transport)
    },
    { once: true }
  )
})

export const api = createClient(contract, async (path, payload) => (await ready)(path, payload))
```

Port messages buffer until the receiving end calls `start()`, and the deferred transport buffers calls until the port lands — no ready-handshake needed. A `ChannelError` thrown by either router arrives on the other side as a real `ChannelError` with its code and fields. The same wrappers work for Web Workers, iframes, and utility processes; only the port hand-off differs.

</details>

## License

MIT
