<p align="center">
  <h1 align="center">🔌 <code>conduit</code></h1>
  <p align="center">
    <strong>Type-safe, Proxy-based RPC from a Zod schema tree — transport-agnostic</strong>
  </p>
</p>

> [!WARNING]
> This library is a work in progress. The API is not stable yet.

**conduit** turns a nested [Zod](https://zod.dev) schema tree into a strongly-typed RPC client and a validating router, with the transport left to you. Define your contract once, and get a tRPC-style Proxy client on one side and a schema-enforcing dispatcher on the other — over Electron IPC, a message queue, a WebSocket, or an in-memory function call.

It is the transport-agnostic core extracted from [`qstash-events`](https://github.com/adelrodriguez/qstash-events).

## Features

- ✅ **Type-safe** — client inputs and outputs are inferred from your contract
- 🌲 **Nested contracts** — organize operations as a tree (`localFiles.open`); dotted paths are derived automatically
- 🔐 **Validated at the boundary** — the router parses input against your schema before any handler runs, and parses procedure results on the way out so off-contract handlers fail loudly
- 🔁 **Procedures and events** — request/response (`procedure`) and fire-and-forget (`event`) leaves in one contract
- 🚚 **Bring your transport** — a transport is two functions (`request`, `send`); adapters stay ~50 lines

## Installation

```bash
pnpm add @adelrodriguez/conduit zod
```

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

Implement it with a router (the trust boundary — input is parsed before your handler runs):

```typescript
import { createRouter, type InferHandlers } from "@adelrodriguez/conduit"

const router = createRouter(contract, {
  "localFiles.open": async () => openFile(),
  "localFiles.save": async ({ path, contents }) => save(path, contents),
  "stripe.checkout.created": async ({ id }) => record(id),
} satisfies InferHandlers<typeof contract>)

// An adapter feeds untrusted (path, input) pairs into:
await router.dispatch("localFiles.save", rawInput)
```

Call it with a client (validates at the call site, then hands off to your transport):

```typescript
import { createClient } from "@adelrodriguez/conduit"

const client = createClient(contract, {
  request: (path, input) => myTransport.request(path, input),
  send: (path, payload) => myTransport.send(path, payload),
})

await client.localFiles.open()
await client.localFiles.save({ path: "/tmp/a.txt", contents: "hi" })
await client.stripe.checkout.created.publish({ id: "evt_123" })

client.localFiles.save.$path // "localFiles.save"
client.localFiles.save.$schema // the Zod input schema
```

Wire client to router directly for tests — the whole stack with no I/O:

```typescript
import { createMemoryTransport } from "@adelrodriguez/conduit"

const client = createClient(contract, createMemoryTransport(router))
```

## Validation model

Input is parsed twice by design. The client parses before sending so the caller gets an error with a stack trace at the call site. The router parses again before dispatching because the sender may not be your client at all — in transports like Electron IPC the receiving process must treat every message as untrusted. Only the router's parse is a security boundary.

Authenticity is the transport's job, not the core's: an HTTP adapter verifies signatures, an Electron adapter relies on process identity and a channel allowlist (`router.channels`). The core guarantees one thing everywhere: no handler runs on unparsed input.

## Planned adapters

- `@adelrodriguez/conduit-electron` — `contextBridge`/`ipcMain` wiring for Electron
- `qstash-events` — retrofitted as the QStash adapter

## License

MIT
