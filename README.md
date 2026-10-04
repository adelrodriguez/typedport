<p align="center">
  <h1 align="center"><code>typedport</code></h1>
  <p align="center">
    <strong>Type-safe RPC over any transport</strong>
  </p>
</p>

> [!WARNING]
> typedport is pre-1.0. Expect breaking changes in minor releases.

You write a contract once, as a tree of schemas. typedport turns it into two things. The caller gets a typed client, where `client.files.open()` is a function call. The receiver gets a router that validates every input before your code sees it.

What sits between them is up to you. A transport is one function, `(path, payload) => result`, so the same contract runs over Electron IPC, a worker thread, a WebSocket, an HTTP endpoint, a message queue, or a direct in-memory call.

- Types come from the contract. There is no codegen step.
- Schemas can come from any [Standard Schema](https://standardschema.dev) library, such as [Zod](https://zod.dev), [Valibot](https://valibot.dev), or [ArkType](https://arktype.io).
- The router parses the input before a resolver runs and parses the result before it leaves. A resolver that returns the wrong shape fails on the server, so the caller never gets bad data.
- A missing resolver is a compile error.
- `typedport/wire` carries errors across serialization, hiding server-side details by default. It also turns message pipes into request/response calls you can cancel, and it ships wires for MessagePorts and WebSockets.

## Install

```bash
pnpm add typedport
```

Add a schema library too. These docs use Zod.

## Build your first contract

In this section, we build a contract with two channels, serve it, and call it. Everything runs in one process, so we need no server and no network.

Create `rpc.mts` and define the contract. The `.mts` extension makes the file an ES module, which the top-level `await` calls below need. It has one round trip, `greetings.hello`, which returns a string, and one one-way channel, `log`, which returns nothing:

```typescript
import { ChannelError, channel, createClient, createRouter, defineContract } from "typedport"
import * as z from "zod"

const contract = defineContract({
  greetings: {
    hello: channel({ input: z.object({ name: z.string() }), output: z.string() }),
  },
  log: channel(z.string()),
})
```

Now implement it with a router. Each key is a dotted path from the contract. Hover over `name` or `message` in your editor, and you see that TypeScript already knows their types:

```typescript
const router = createRouter(contract, {
  "greetings.hello": ({ name }) => `Hello, ${name}!`,
  log: (message) => {
    console.log("server got:", message)
  },
})
```

Next, create a client. A client needs a transport, and `router.dispatch` is already one, so we pass it in directly:

```typescript
const client = createClient(contract, router.dispatch)

console.log(await client.greetings.hello({ name: "Ada" }))
await client.log("ping")
```

Run the file with `npx tsx rpc.mts`. You see:

```text
Hello, Ada!
server got: ping
```

Finally, send the router a bad input. The client won't let us, because `{ name: 42 }` is a type error and the client also parses the input at runtime. So we call `router.dispatch` directly, the way an untrusted sender would:

```typescript
try {
  await router.dispatch("greetings.hello", { name: 42 })
} catch (error) {
  if (error instanceof ChannelError && error.code === "validation") {
    console.log("rejected:", error.issues[0]?.message)
  }
}
```

Run the file again. The resolver never runs, and you see a new line:

```text
rejected: Invalid input: expected string, received number
```

We now have a contract, a router that guards it, and a typed client. To move the router into another process, replace `router.dispatch` with a transport that crosses the boundary. The guides below show how.

## Documentation

How-to guides:

- [Split handlers across files](./docs/how-to/split-handlers-across-files.md)
- [Pass per-call options like an `AbortSignal`](./docs/how-to/pass-per-call-options.md)
- [Cancel a call and stop its resolver](./docs/how-to/cancel-calls.md)
- [Serve a contract over HTTP](./docs/how-to/serve-over-http.md)
- [Call the Electron main process over IPC](./docs/how-to/call-electron-main-over-ipc.md)
- [Call in both directions over Electron MessagePorts](./docs/how-to/call-over-electron-message-ports.md)
- [Write your own transport](./docs/how-to/write-a-transport.md)

Reference:

- [API reference](./docs/reference.md)

Background:

- [About validation and trust](./docs/validation-and-trust.md)

Runnable code:

- [Examples](./examples) for worker threads, WebSockets, Hono, QStash, and capnweb

## License

MIT
