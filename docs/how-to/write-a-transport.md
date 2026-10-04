# How to write your own transport

A transport is a function with the signature `(path, payload, options?) => result`. typedport doesn't ship transports. You write them in your code, and most fit on one line:

```typescript
const memory = router.dispatch
const electron = (path, input) => ipcRenderer.invoke(path, input)
const queue = async (path, body) => queueClient.publishJSON({ body, url: `${baseUrl}/${path}` })
const socket = connect(whenOpen(ws).then(webSocket), { timeoutMs: 5000 }).transport
```

The [examples](../../examples) are complete transports for worker threads, WebSockets, Hono, and QStash.

## Pick the tool for your boundary

- If the boundary serializes values, as HTTP, Electron `invoke`, and structured clone do, wrap the outcome with `toWire` on the receiving side and unwrap it with `fromWire` on the calling side. A `ChannelError` keeps its code and fields. Server-side failures arrive with the code `internal` unless you pass `expose`.
- If the boundary is a message pipe, such as a MessagePort, a worker, or a WebSocket, use `connect`. It adds request/response matching, timeouts, cancellation, and teardown. Use a shipped wire from `typedport/wire/message-port` or `typedport/wire/web-socket` if one fits. Otherwise, write a `Wire` inline. It has two properties, `send` and `onMessage`.
- If the edge must register every endpoint up front, as HTTP routes and IPC handlers do, loop over `router.channels` on the server or `flatten(contract)` anywhere.

## Restrict a one-way transport to one-way contracts

A queue can't return a resolver's result. If a leaf it serves declares `output`, the client resolves with the publish receipt as if it were the result. Nothing at runtime catches the mistake.

To make it a compile error, type the adapter's contract parameter as `OneWayContract`:

```typescript
import { createClient, type OneWayContract } from "typedport"

export function createPublisher<Tree extends OneWayContract>(contract: Tree) {
  return createClient(contract, async (path, body) => {
    await queueClient.publishJSON({ body, url: `${baseUrl}/${path}` })
  })
}
```

`examples/qstash/queue.ts` uses this pattern.

## Create a client before the endpoint is known

A transport that awaits another transport is also a transport. Use one to export a client before you know where its calls go. Calls made too early wait for the endpoint.

```typescript
const ready = new Promise<Transport>((resolve) => {
  // resolve once the endpoint is known
})

export const api = createClient(contract, async (path, payload) => (await ready)(path, payload))
```

You don't need this for a message pipe. `connect` accepts a `Promise<Wire>` directly.

## Type the adapter

- Annotate the transport function as `Transport`. A third parameter becomes the per-call options type. See [How to pass per-call options](./pass-per-call-options.md).
- Accept contracts as `ContractTree`, or as `OneWayContract` for one-way adapters.
- Use `InferClient<typeof contract>` and `Channel` when you wrap or re-export the client.
- Use `isChannel(node)` to tell a leaf from a branch when you walk a contract yourself.
