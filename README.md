<p align="center">
  <h1 align="center">🚌 <code>typedport</code></h1>
  <p align="center">
    <strong>Type-safe RPC over any transport</strong>
  </p>
</p>

> [!WARNING]
> This library is a work in progress. The API is not stable yet.

**typedport** turns a nested schema tree into a strongly-typed RPC client and a validating router, with the transport left to you. Define your contract once. One side gets a tRPC-style Proxy client, the other gets a dispatcher that enforces the schemas. It works over Electron IPC, a message queue, a WebSocket, or a plain in-memory function call.

## Features

- **Type-safe.** The contract infers client inputs and outputs, resolver signatures, and error shapes. No generated code.
- **Any Standard Schema.** [Zod](https://zod.dev), [Valibot](https://valibot.dev), [ArkType](https://arktype.io), or anything else implementing [Standard Schema](https://standardschema.dev).
- **Nested contracts.** Organize operations as a tree (`localFiles.open`). Dotted paths fall out automatically.
- **Validated at the boundary.** The router parses input against your schema before any resolver runs, and parses results against `output` on the way out, so an off-contract resolver fails loudly.
- **One leaf constructor.** `channel({ input, output })` is a round trip, `channel(schema)` is one-way. Every leaf is directly callable on the client.
- **Handlers where the code lives.** `implement(contract)` builds one handler at a time with full inference, one file per branch. `createRouter` assembles them and refuses to compile with a leaf missing.
- **Bring your transport.** A transport is a single function `(path, payload, options?) => result`. `router.dispatch` is already one. Per-call options (an `AbortSignal`, a transfer list) flow through untouched.
- **`typedport/wire`.** A serializable error envelope, `connect` for turning any duplex pipe into a symmetric transport, and shipped wires for the common pipes: MessagePorts (DOM, Electron, Node) and WebSockets.

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

Implement it with a router. The router is the trust boundary: it parses input before your resolver runs. The resolver map is contextually typed from the contract, so parameters are inferred and a missing or typo'd path is a compile error:

```typescript
import { createRouter } from "typedport"

const router = createRouter(contract, {
  "localFiles.open": async () => openFile(),
  "localFiles.save": async ({ path, contents }) => saveFile(path, contents),
  "stripe.checkout.created": async ({ id }) => record(id),
})

// An adapter feeds untrusted (path, input) pairs into:
await router.dispatch("localFiles.save", rawInput)
```

Resolvers also receive a **context**: whatever the edge knows about the caller (the authenticated user, `event.senderFrame`, the socket session). The edge supplies it per dispatch. With the default `Context = void` the argument disappears entirely, and `dispatch` stays a valid two-argument `Transport`.

Call it with a client. A transport is one function, and every leaf is directly callable:

```typescript
import { createClient } from "typedport"

const client = createClient(contract, (path, payload) => myWire.send(path, payload))

const file = await client.localFiles.open()
await client.localFiles.save({ path: "/tmp/a.txt", contents: "hi" })
await client.stripe.checkout.created({ id: "evt_123" })

client.localFiles.save.$path // "localFiles.save"
client.localFiles.save.$input // the input schema. For a bare-schema leaf, the schema itself
client.localFiles.open.$output // the output schema, or undefined on one-way leaves
```

Leaves with an `output` schema resolve with the result. One-way leaves are typed `Promise<void>`. The client validates input at the call site before it reaches the transport, and the router validates again on arrival.

`router.dispatch` is itself a valid transport, so wiring client to router directly, the whole stack with no I/O, is one line:

```typescript
const client = createClient(contract, router.dispatch)
```

## Implementing a contract with `implement()`

The flat map above is the right tool at small sizes. Past a dozen channels it turns into one giant object, so `implement` lets each handler live next to its domain code instead:

```typescript
// contract.ts
import { implement } from "typedport"

type Session = { userId: string }

export const tp = implement(contract).$context<Session>()
```

```typescript
// local-files/handlers.ts — zero annotations, everything inferred from the contract
import { tp } from "../contract"

export const open = tp.localFiles.open(async (_input, session) => openFile(session.userId))
export const save = tp.localFiles.save(async ({ path, contents }) => saveFile(path, contents))
```

```typescript
// router.ts — assembly is where completeness is enforced
import { createRouter } from "typedport"
import * as localFiles from "./local-files/handlers"
import { created } from "./stripe/handlers"

export const router = createRouter(contract, {
  localFiles,
  stripe: { checkout: { created } },
})
```

The handler object mirrors the contract's shape, and a namespace import of a one-file-per-branch handler module already has it. What the compiler enforces at the assembly site:

- **A missing handler is a missing property.** TypeScript names the leaf in the error.
- **Position and identity must agree.** Each fragment carries its dotted path as a brand, so the `save` handler cannot occupy the `open` slot, and a fragment built from a different contract cannot fill in even when the names collide.
- **Contexts must agree.** A fragment built without `$context` cannot join a `Session` tree.
- **Stray exports are ignored.** The router walks the contract, not the handler object, so a helper exported next to the fragments doesn't break assembly.

`$context<Session>()` is the only place the context type is written. Fragments carry it from there, and `createRouter` infers it back out of them, so `dispatch` demands a `Session` without any explicit type arguments. If you need the flat map with a context instead, declare it the old way: `createRouter<typeof contract, Session>(contract, resolvers)`.

`InferResolvers<typeof contract, Context>` still exists for typing a flat map defined away from the `createRouter` call.

## Per-call options

A transport may declare a third `options` parameter for per-call edge mechanics (an `AbortSignal`, an Electron transfer list, an HTTP method) that never travel in the payload. The type is inferred from the transport's own annotation and flows to every call site. `$with(options)` on the root or any subtree returns the same client with options bound, so leaves with `void` inputs need no `undefined` placeholder:

```typescript
const api = createClient(contract, async (path, payload, options?: { signal?: AbortSignal }) => {
  return await sendOverTheWire(path, payload, options?.signal)
})

await api.localFiles.save(file, { signal: controller.signal }) // positional
await api.$with({ signal: controller.signal }).localFiles.open() // bound

const cancellable = api.$with({ signal: controller.signal })
await cancellable.stripe.checkout.created({ id: "evt_123" }) // bound options apply to every call
```

Per-call options shallow-merge over bound ones. When the transport declares no options, none of this exists in the type. Calls are `(input)` and `$with` is absent.

## Validation model

Input is parsed twice by design. The client parses before sending so the caller gets an error with a stack trace at the call site. The router parses again before dispatching because the sender may not be your client at all. In transports like Electron IPC the receiving process must treat every message as untrusted. Only the router's parse is a security boundary.

Results flow the other way with one parse. The router validates the resolver's return against `output` before it leaves the server, and the client returns the transport's value as-is. When the peer is a typedport router the result is schema-checked end to end. When it isn't (a plain HTTP endpoint, a mock), the client's return type is a promise, not a guarantee, so validate at the edge if you don't trust the peer. The pieces are already in hand: `parseWith` is the same parse the router uses, and every round-trip leaf carries its schema as `$output`:

```typescript
import { parseWith } from "typedport"

const raw = await api.localFiles.open()
const file = await parseWith(api.localFiles.open.$output, raw) // now a guarantee, not a claim
```

Every failure the library raises is a `ChannelError`, discriminated by `code`: `validation` (the caller's input failed, with the Standard Schema `issues`), `output-validation` (the resolver's result drifted off contract, which is the server's fault, not the caller's), `unknown-channel` (with the `path`), the `connect` lifecycle codes `timeout`, `closed`, and `no-router`, and `malformed-envelope` (`fromWire` got something that isn't an envelope). One `instanceof`, then `code` narrows the fields. Anything that is _not_ a `ChannelError` came from application code:

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

Authenticity is the transport's job, not the core's. An HTTP adapter verifies signatures. An Electron adapter relies on process identity and a channel allowlist (`router.channels`). The core guarantees one thing everywhere: no resolver runs on unparsed input.

## `typedport/wire`

Two problems every real boundary hits, solved once in an optional subpath.

**Errors don't survive serialization.** A thrown `ChannelError` gets flattened by `invoke`, structured clone, or JSON. `toWire` and `fromWire` are the codec. `toWire` captures any operation's outcome as a serializable value, and `fromWire` unwraps it on the other side, returning the result or rethrowing. `ChannelError` comes back rehydrated with its code and fields intact, so `instanceof` and `code` checks work across the boundary:

```typescript
import { fromWire, toWire } from "typedport/wire"

// server edge — never throws, always resolves a serializable WireResult
ipcMain.handle(channel, (_event, payload) => toWire(router.dispatch(channel, payload)))

// client edge — unwraps the result or rethrows, ChannelError intact
const api = createClient(contract, async (path, payload) =>
  fromWire(await window.typedport.send(path, payload))
)
```

`toWire` takes the operation's promise, or a thunk when the operation can throw synchronously. `fromWire(await toWire(x))` returns what `x` resolved with, or rethrows what it threw.

**Message pipes have no request/response.** `postMessage`-shaped channels (MessagePorts, workers, WebSockets) need correlation ids, a pending map, timeouts, and teardown. `connect` owns all of that, over a minimal `Wire`, which is anything that can send a value and hand incoming values to a listener:

```typescript
import { connect, type Wire } from "typedport/wire"

const { transport, close } = connect(wire, {
  router, // serve incoming requests from the peer; omit for a call-only end
  context: session, // per-connection: passed to every dispatch this end serves
  timeoutMs: 5000, // reject a pending call if no response arrives
})
```

`connect` is symmetric. Call it on both ends of a duplex pipe, each with its own router, and each side gets a transport for calling the other. It speaks the envelope internally, so error fidelity comes for free. That also makes it a **trusted-peer** transport: the peer sees every `ChannelError` detail, including server-fault codes like `output-validation`. An untrusted peer (a browser talking to a public server) belongs behind an edge that redacts, like the HTTP recipe. `close(reason?)` rejects everything in flight and every future call. Wire it to whatever liveness signal the pipe has (a window's `closed`, a socket's `close`).

`connect` also accepts a `Promise<Wire>`, for pipes that aren't ready yet: a port still being handed over, a socket still opening. Calls made in the meantime queue (bounded by `timeoutMs`) and flush when the wire arrives. `close` before arrival wins the race, and a rejected wire promise closes the connection with the rejection as `cause`.

### Shipped wires

The port flavors share an idea but not an interface, and hand-copied wrappers rot, so the common ones ship as subpaths. Everything is structurally typed, with no dependency on Electron or DOM types.

`typedport/wire/message-port`:

| Export        | Wraps                                                                |
| ------------- | -------------------------------------------------------------------- |
| `mainPort`    | Electron `MessagePortMain`, in the main process or a utility process |
| `domPort`     | DOM `MessagePort`: renderers, iframes, web workers                   |
| `nodePort`    | `node:worker_threads` ports, a `Worker`, or `parentPort`             |
| `sendPort`    | Main process: ship a port to a window once it has loaded             |
| `relayPort`   | Preload: relay ports from an IPC channel into the page               |
| `receivePort` | Renderer: await the relayed port, with the source and type guarded   |

`typedport/wire/web-socket`:

| Export      | Does                                                                             |
| ----------- | -------------------------------------------------------------------------------- |
| `webSocket` | Wraps a browser/Node `WebSocket` or a `ws` socket as a `Wire` over JSON frames   |
| `whenOpen`  | Resolves with the socket once it can send; pairs with the pending-wire `connect` |

One caveat on `webSocket`: sockets carry frames, not values, so the envelope rides JSON there. Payloads must survive JSON, unlike on the structured-clone transports.

## Writing an adapter

Transports live in your codebase, not in this package. A transport is one function, and the examples in this repo (worker threads, WebSocket, Hono) are the reference implementations. The supported toolkit:

- **`flatten(contract)`.** The tree as a flat `Record<path, Channel>`, for edges that register endpoints ahead of time (`router.channels` is the same list of paths).
- **`isChannel(node)`.** The discriminant for walking a `ContractTree` yourself.
- **`parseWith(schema, value)`.** The single parse the client and router use. Reuse it to validate on a path the router never sees. Throws `ChannelError` with code `validation` and the Standard Schema `issues`.
- **Types.** Annotate your adapter's function as `Transport` (declare an options parameter and it flows to every call site), accept contracts as `ContractTree`, and constrain one-way adapters to `OneWayContract` so a round-trip leaf is a compile error. `InferClient` and `Channel` cover the places you wrap or re-expose the client.
- **`toWire` / `fromWire`** (from `typedport/wire`). The error codec for any serializing boundary, and `connect` when the boundary is a duplex message pipe.
- **The shipped wires.** And when your pipe isn't one of them, a `Wire` is two properties. Write it inline.

## Recipes

A transport is one function, so most edges are one line:

```typescript
const memory = router.dispatch
const electron = (path, input) => ipcRenderer.invoke(path, input)
const queue = async (path, body) => queueClient.publishJSON({ url: `${baseUrl}/${path}`, body })
const socket = connect(whenOpen(ws).then(webSocket), { timeoutMs: 5000 }).transport
```

One thing to keep straight: a one-way transport (a queue) paired with a leaf that declares an `output` is a contract error the core cannot catch at runtime. The client would resolve the publish receipt as if it were the result. Keep `output` off the leaves a one-way transport serves, and make the compiler enforce it: adapters built on one-way delivery should constrain their contract parameter to `OneWayContract`, which rejects any tree containing a round-trip leaf.

A related trick falls out of the one-function design: a transport that awaits another transport is a transport. For `connect` pipes you don't need it, since `connect` takes the pending wire directly. For everything else, build the client eagerly over a deferred transport and calls made too early just wait:

```typescript
const ready = new Promise<Transport>((resolve) => {
  /* resolve when the endpoint is known */
})

export const api = createClient(contract, async (path, payload) => (await ready)(path, payload))
```

<details>
<summary><strong>HTTP / fetch</strong>: any framework that speaks Request/Response</summary>

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

Auth, retries, and headers live in the transport function. The core never sees them. The status codes are a courtesy for logs and middleware; `fromWire` decides success from the envelope, not the status.

</details>

<details>
<summary><strong>Electron IPC</strong>: renderer client, main-process router over <code>invoke</code></summary>

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

One-way leaves ride `invoke` too. The extra empty response is harmless and keeps the edge to a single function. Note that `ipcRenderer.invoke` re-throws only the error message string, so a `ChannelError` from the main process arrives in the renderer as a flat `Error`. If you need structured errors, wrap both edges in the `typedport/wire` envelope: `toWire(router.dispatch(channel, payload))` in the `handle` callback, `fromWire(await ...)` in the transport. Or use the MessagePort recipe below, which gets error fidelity and both directions from `connect`. If you load remote content, also check `event.senderFrame` before dispatching.

</details>

<details>
<summary><strong>Electron MessagePort</strong>: bidirectional main ↔ renderer, and utility processes</summary>

A port is duplex, so one `connect` per end gives you round trips in _both_ directions. Each side serves its own contract and calls the other's. The wires and the port hand-off ship in `typedport/wire/message-port`; what's left in your code is the lifecycle.

Main creates the channel, keeps one end, and ships the other to the page:

```typescript
import { MessageChannelMain, type BrowserWindow } from "electron"
import { createClient } from "typedport"
import { connect } from "typedport/wire"
import { mainPort, sendPort } from "typedport/wire/message-port"

function attach(win: BrowserWindow) {
  const { port1, port2 } = new MessageChannelMain()

  const { transport, close } = connect(mainPort(port1), {
    router: mainRouter, // serves the renderer → main contract
    context: { windowId: win.id }, // passed to every resolver this connection serves
    timeoutMs: 5_000, // a dead renderer rejects pending calls instead of hanging them
  })
  const push = createClient(pushContract, transport) // main → renderer, same port

  sendPort(win, port2, "typedport:port")
  win.on("closed", () => close(new Error("window closed")))

  return push
}
```

The preload is one line (a port cannot cross `contextBridge`, but `window.postMessage` can transfer it, and `relayPort` does exactly that):

```typescript
import { ipcRenderer } from "electron"
import { relayPort } from "typedport/wire/message-port"

relayPort(ipcRenderer, "typedport:port")
```

The renderer awaits the port and hands `connect` the pending wire, so `api` is importable before the port arrives:

```typescript
import { createClient, createRouter } from "typedport"
import { connect } from "typedport/wire"
import { domPort, receivePort } from "typedport/wire/message-port"

const pushRouter = createRouter(pushContract, {
  // ... resolvers for main → renderer calls
})

const { transport } = connect(receivePort("typedport:port").then(domPort), {
  router: pushRouter,
  timeoutMs: 5_000,
})

export const api = createClient(contract, transport)
```

No ready-handshake exists anywhere. Ports buffer until `start()` (the wires call it once their listener is attached), and `connect` buffers calls until the port lands. Call `attach` before or after `loadURL`: `sendPort` posts immediately when a page has already loaded and waits for `did-finish-load` otherwise (a reload needs a fresh channel, since a transferred port is spent). A `ChannelError` thrown by either router arrives on the other side as a real `ChannelError` with its code and fields. `receivePort` only accepts same-window messages of the agreed type that carry an actual port, which shuts out senders in other windows (an iframe, a compromised `opener`). A script already running in the same window is outside any postMessage guard's reach.

Utility processes use the same `mainPort` wire, because their ports are `MessagePortMain`-shaped too:

```typescript
// main
const { port1, port2 } = new MessageChannelMain()
utilityProcess.fork(indexerPath).postMessage({ type: "port" }, [port2])
const indexer = createClient(
  indexerContract,
  connect(mainPort(port1), { timeoutMs: 30_000 }).transport
)

// indexer.js
process.parentPort.on("message", (event) => {
  connect(mainPort(event.ports[0]), { router: indexerRouter })
})
```

The same pattern covers Web Workers, iframes, and `worker_threads` (see `examples/worker-threads`, which is `nodePort` on both ends). Only the port hand-off differs.

</details>

## License

MIT
