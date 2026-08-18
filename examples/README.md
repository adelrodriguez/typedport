# Examples

Runnable demos of typedport over real transports. Each example imports from `../../src` so it runs
against the working tree; in your own app the imports become `"typedport"` and `"typedport/wire"`.

Run them with [`tsx`](https://tsx.is) (a dev dependency of this repo).

## Worker threads

Offload computation to a `node:worker_threads` worker with full type inference — a typed Comlink
alternative. A browser Web Worker has the same shape; only the port globals differ:

```bash
pnpm tsx examples/worker-threads/main.ts
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
to every connected client (`ticker.tick`). The server uses [`ws`](https://github.com/websockets/ws);
the client uses Node's built-in `WebSocket`. Run in two terminals:

```bash
pnpm tsx examples/websocket/server.ts
pnpm tsx examples/websocket/client.ts
```
