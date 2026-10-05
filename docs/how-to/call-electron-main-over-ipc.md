# How to call the Electron main process over IPC

This guide serves a contract from the main process with `ipcMain.handle` and calls it from a renderer with `ipcRenderer.invoke`. Calls go one way, from the renderer to main. For calls in both directions, see [How to call in both directions over Electron MessagePorts](./call-over-electron-message-ports.md).

1. In the main process, register one IPC handler per channel. The router is the security boundary here, because renderer input is untrusted.

   ```typescript
   // main.ts
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

   If each feature has its own router, merge them first with `mergeRouters(filesRouter, settingsRouter)` and run the same loop over the result. See [How to split handlers across files](./split-handlers-across-files.md#serve-several-routers-as-one).

2. In the preload, expose only the transport function. The client is a Proxy, and `contextBridge` can't pass a Proxy because it structured-clones what it exposes.

   ```typescript
   // preload.ts
   import { contextBridge, ipcRenderer } from "electron"

   contextBridge.exposeInMainWorld("typedport", {
     send: (path: string, payload: unknown) => ipcRenderer.invoke(path, payload),
   })
   ```

3. In the renderer, build the client on top of the exposed function:

   ```typescript
   // renderer.ts
   import { createClient } from "typedport"
   import { contract } from "./contract"

   export const api = createClient(contract, (path, payload) =>
     window.typedport.send(path, payload)
   )
   ```

One-way channels use `invoke` too. The empty reply costs little and keeps the transport to one function.

If the window loads remote content, check `event.senderFrame` in the handler before you dispatch.

## Keep errors structured

`ipcRenderer.invoke` rethrows only the error message, so a `ChannelError` from main arrives in the renderer as a plain `Error`. To keep the code and fields, wrap both sides in the envelope from `typedport/wire`. By default, `toWire` hides server-side failures behind the code `internal`. Pass `expose` to `toWire` to send more.

```typescript
// main.ts
ipcMain.handle(channel, (_event, payload) => toWire(router.dispatch(channel, payload)))

// renderer.ts
export const api = createClient(contract, async (path, payload) =>
  fromWire(await window.typedport.send(path, payload))
)
```
