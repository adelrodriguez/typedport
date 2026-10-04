# How to call in both directions over Electron MessagePorts

A MessagePort carries messages both ways. With one `connect` on each end, the main process and a renderer can each serve a contract and call the other's.

This guide uses two contracts. `contract` holds the calls from the renderer to main. `pushContract` holds the calls from main to the renderer.

1. In the main process, create a channel, serve one end, and send the other end to the window:

   ```typescript
   import { type BrowserWindow, MessageChannelMain } from "electron"
   import { createClient } from "typedport"
   import { connect } from "typedport/wire"
   import { mainPort, sendPort } from "typedport/wire/message-port"

   function attach(win: BrowserWindow) {
     const { port1, port2 } = new MessageChannelMain()

     const { close, transport } = connect(mainPort(port1), {
       context: { windowId: win.id },
       router: mainRouter, // serves calls from the renderer
       timeoutMs: 5_000, // fails pending calls if the renderer dies
     })
     const push = createClient(pushContract, transport) // calls into the renderer

     sendPort(win, port2, "typedport:port")
     win.on("closed", () => close(new Error("window closed")))

     return push
   }
   ```

   You can call `attach` before or after `loadURL`. If the page has loaded, `sendPort` posts the port right away. Otherwise it waits for `did-finish-load`.

2. In the preload, relay the port into the page. A port can't cross `contextBridge`, but `relayPort` transfers it with `window.postMessage`:

   ```typescript
   import { ipcRenderer } from "electron"
   import { relayPort } from "typedport/wire/message-port"

   relayPort(ipcRenderer, "typedport:port")
   ```

3. In the renderer, pass `connect` the port that `receivePort` will deliver. `api` works as soon as the module loads. Calls made before the port arrives wait for it. Give `receivePort` a `signal` so the wait ends if the port never comes. Its rejection closes the connection.

   ```typescript
   import { createClient, createRouter } from "typedport"
   import { connect } from "typedport/wire"
   import { domPort, receivePort } from "typedport/wire/message-port"

   const pushRouter = createRouter(pushContract, {
     // ... resolvers for calls from main
   })

   const port = receivePort("typedport:port", { signal: AbortSignal.timeout(10_000) })

   const { transport } = connect(port.then(domPort), {
     router: pushRouter,
     timeoutMs: 5_000,
   })

   export const api = createClient(contract, transport)
   ```

You don't need a ready handshake. A port holds messages until its listener starts it, and `connect` holds calls until the port arrives.

## Decide which errors cross

`connect` hides server-side failures the same way `toWire` does. Validation errors and unknown channels cross with their code and fields. A resolver that throws reaches the caller as a `ChannelError` with code `internal`. To log the real error, pass `onHidden`. To send every error as-is, pass `expose: () => true` on the end that serves the calls.

## Handle a reload

A port can be transferred only once. When the window reloads, create a new `MessageChannelMain` and call `attach` again from your own `did-finish-load` handler. Do the same after a failed navigation, because the old port may have gone to a page that never loaded.

## Know what the hand-off blocks

`relayPort` posts the port to the window's own origin, so a page that has navigated to another origin never receives it. A `file://` page has no origin to address, so `relayPort` falls back to `"*"` there. Pass `targetOrigin` to override both.

`receivePort` accepts a message only if it comes from the same window, has the agreed type, and carries a port. That blocks other windows, such as an iframe or a compromised `opener`. It can't block a script already running in the page.

## Connect a utility process

Utility process ports have the same shape as main process ports, so both ends use `mainPort`:

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

Web Workers, iframes, and `worker_threads` follow the same pattern. Only the way you hand over the port changes. [`examples/worker-threads`](../../examples/worker-threads) uses `nodePort` on both ends.
