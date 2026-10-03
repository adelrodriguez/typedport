# Examples

Runnable demos of typedport over real transports. Each example imports from `../../src` so it runs
against the working tree; in your own app the imports become `"typedport"`, `"typedport/wire"`, and
the wire subpaths (`"typedport/wire/message-port"`, `"typedport/wire/web-socket"`).

Run them with [`tsx`](https://tsx.is) (a dev dependency of this repo).

## Worker threads

Offload computation to a `node:worker_threads` worker with full type inference — a typed Comlink
alternative, wired with the shipped `nodePort` wire on both ends. A browser Web Worker has the same
shape; only the port globals differ:

```bash
pnpm tsx examples/worker-threads/main.ts
```

## capnweb over typedport wires

[capnweb](https://github.com/cloudflare/capnweb) speaking its own object-capability protocol over
the same shipped `nodePort` wire the worker-threads example uses. `wire-transport.ts` adapts a
structured-clone typedport `Wire` (`nodePort`, `mainPort`, `domPort`) to capnweb's pull-based
`RpcTransport` — at encoding level `"structuredClonable"`, so values ride the port natively with no
JSON framing. It does not fit the JSON-framed `webSocket` wire: values like `BigInt` that capnweb
leaves native at this level fail to serialize. The same adapter over `mainPort`/`domPort` plus the
`sendPort`/`relayPort`/`receivePort` hand-off gives capnweb an Electron main ↔ renderer transport;
the demo exercises that pending-wire path by handing the adapter a `Promise<Wire>` that settles when
the worker comes online, so the first call is queued and flushed on arrival. The demo shows both
sides of the protocol swap: a live callback passed by reference (capability passing, which no
contract tree can express) and an off-contract input reaching the worker unchecked (capnweb
validates nothing at runtime):

```bash
pnpm tsx examples/capnweb/main.ts
```

## Hono (HTTP)

The HTTP recipe made concrete: one Hono route serves the whole contract through the wire envelope
(400 for validation failures, 500 for resolver crashes), and the client is a `fetch` transport.
Run in two terminals:

```bash
pnpm tsx examples/hono/server.ts
pnpm tsx examples/hono/client.ts
```

## WebSocket

A bidirectional stack over one socket: the client calls the server (`math.add`), the server pushes
to every connected client (`ticker.tick`). Both ends use the shipped `webSocket` wire — the server
over [`ws`](https://github.com/websockets/ws), the client over Node's built-in `WebSocket` with
`whenOpen` feeding `connect` a pending wire. Run in two terminals:

```bash
pnpm tsx examples/websocket/server.ts
pnpm tsx examples/websocket/client.ts
```

## QStash (message queue)

A one-way stack over [Upstash QStash](https://upstash.com/docs/qstash): `createPublisher` and
`createTrigger` turn a `OneWayContract` into typed publish and workflow-trigger clients (per-call
options like `delay` ride the transport), and a Hono server verifies the `Upstash-Signature` before
dispatching. Workflow resolvers receive the `WorkflowContext` as their router context, so steps are
plain `context.run` calls with a typed payload. Start the local QStash dev server, then run the
server and client (set `QSTASH_URL` if the dev server isn't on port 8080):

```bash
npx @upstash/qstash-cli dev
pnpm tsx examples/qstash/server.ts
pnpm tsx examples/qstash/client.ts
```
