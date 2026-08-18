# Examples

Runnable demos of typeport over real transports. Each example imports from `../../src` so it runs
against the working tree; in your own app the imports become `"typeport"` and `"typeport/wire"`.

## Web Worker

Offload computation to a worker with full type inference — a typed Comlink alternative:

```bash
bun examples/web-worker/main.ts
```

## WebSocket

A bidirectional stack over one socket: the client calls the server (`math.add`), the server pushes
to every connected client (`ticker.tick`). Run in two terminals:

```bash
bun examples/websocket/server.ts
bun examples/websocket/client.ts
```
