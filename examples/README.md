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
