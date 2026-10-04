# Examples

Each example runs typedport over a real transport. They import from `../../src`, so they run against the working tree. In your own app, import from `"typedport"`, `"typedport/wire"`, `"typedport/wire/message-port"`, and `"typedport/wire/web-socket"` instead.

Run them with [`tsx`](https://tsx.is), which is already a dev dependency.

## Worker threads

Runs a CPU-heavy function in a `node:worker_threads` worker and calls it with full types, much like Comlink. Both ends use the shipped `nodePort` wire. A browser Web Worker looks the same apart from the port globals.

```bash
pnpm tsx examples/worker-threads/main.ts
```

## capnweb over typedport wires

Runs [capnweb](https://github.com/cloudflare/capnweb)'s own protocol over the `nodePort` wire from the worker-threads example.

`wire-transport.ts` adapts any structured-clone `Wire` (`nodePort`, `mainPort`, or `domPort`) to capnweb's `RpcTransport`. It uses capnweb's `"structuredClonable"` encoding level, so values cross the port as-is with no JSON step. That's also why it doesn't work with the JSON-based `webSocket` wire. Values capnweb leaves native at this level, like `BigInt`, fail to serialize there.

Pair the adapter with `mainPort` and `domPort` plus the `sendPort`, `relayPort`, and `receivePort` hand-off, and capnweb runs between Electron's main process and a renderer. The demo covers the pending-wire case. It gives the adapter a `Promise<Wire>` that resolves when the worker comes online, so the first call waits in the queue and goes out on arrival.

The demo also shows what you trade by switching protocols. You gain a live callback passed by reference, which a contract tree can't express. You lose validation, so an input that breaks the contract reaches the worker unchecked.

```bash
pnpm tsx examples/capnweb/main.ts
```

## Hono (HTTP)

A running version of [How to serve a contract over HTTP](../docs/how-to/serve-over-http.md). One Hono route serves the whole contract through the wire envelope. It returns 400 when validation fails and 500 when a resolver throws. The client transport is a `fetch` call. Run the two halves in separate terminals:

```bash
pnpm tsx examples/hono/server.ts
pnpm tsx examples/hono/client.ts
```

## WebSocket

Calls in both directions over one socket. The client calls the server's `math.add`, and the server pushes `ticker.tick` to every connected client. Both ends use the shipped `webSocket` wire. The server wraps a [`ws`](https://github.com/websockets/ws) socket. The client wraps Node's built-in `WebSocket` and uses `whenOpen` to hand `connect` a pending wire. Run the two halves in separate terminals:

```bash
pnpm tsx examples/websocket/server.ts
pnpm tsx examples/websocket/client.ts
```

## QStash (message queue)

One-way calls over [Upstash QStash](https://upstash.com/docs/qstash). `createPublisher` and `createTrigger` turn a `OneWayContract` into typed clients for publishing messages and triggering workflows. Per-call options like `delay` go through the transport. A Hono server checks the `Upstash-Signature` header before dispatching.

Workflow resolvers get QStash's `WorkflowContext` as their router context, so each step is a plain `context.run` call with a typed payload.

Start the local QStash dev server, then the server and client. Set `QSTASH_URL` if the dev server isn't on port 8080.

```bash
npx @upstash/qstash-cli dev
pnpm tsx examples/qstash/server.ts
pnpm tsx examples/qstash/client.ts
```
