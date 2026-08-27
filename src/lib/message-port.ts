import type { Wire } from "./wire"

/**
 * `Wire` constructors for postMessage-shaped pipes, plus the Electron hand-off that gets a port
 * from the main process into a page. The port flavors share an idea but not a surface — a DOM
 * `MessagePort` speaks `addEventListener` and wraps data in an event, Electron's `MessagePortMain`
 * is an emitter that also wraps, Node's `worker_threads` port is an emitter that doesn't — which is
 * exactly the kind of difference that rots in hand-copied snippets. Every parameter is structural,
 * so nothing here depends on Electron or the DOM, even for types.
 */

/**
 * The shape of an Electron `MessagePortMain` — satisfied in the main process and in utility
 * processes alike (both ends of a `MessageChannelMain` are this flavor, wherever they land).
 */
export type MainPortLike = {
  postMessage(message: unknown): void
  on(event: "message", listener: (event: { data: unknown }) => void): unknown
  removeListener(event: "message", listener: (event: { data: unknown }) => void): unknown
  start(): void
}

/**
 * Wraps an Electron `MessagePortMain` (main or utility process) as a `Wire`.
 */
export function mainPort(port: MainPortLike): Wire {
  return {
    onMessage: (listener) => {
      const handle = (event: { data: unknown }): void => {
        listener(event.data)
      }

      port.on("message", handle)
      // Ports buffer until start(); the listener is attached, so nothing is lost.
      port.start()

      return () => {
        port.removeListener("message", handle)
      }
    },
    send: (data) => {
      port.postMessage(data)
    },
  }
}

/**
 * The shape of a DOM `MessagePort` — renderers, iframes, web workers.
 */
export type DomPortLike = {
  postMessage(message: unknown): void
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  start(): void
}

/**
 * Wraps a DOM `MessagePort` as a `Wire`.
 */
export function domPort(port: DomPortLike): Wire {
  return {
    onMessage: (listener) => {
      const handle = (event: { data: unknown }): void => {
        listener(event.data)
      }

      port.addEventListener("message", handle)
      port.start()

      return () => {
        port.removeEventListener("message", handle)
      }
    },
    send: (data) => {
      port.postMessage(data)
    },
  }
}

/**
 * The shape of a `node:worker_threads` message end — a `MessagePort`, a `Worker`, or `parentPort`.
 * Unlike the other flavors, listeners receive the value directly (no wrapping event), and
 * subscribing implicitly starts the port.
 */
export type NodePortLike = {
  postMessage(value: unknown): void
  on(event: "message", listener: (value: unknown) => void): unknown
  removeListener(event: "message", listener: (value: unknown) => void): unknown
}

/**
 * Wraps a `node:worker_threads` port, `Worker`, or `parentPort` as a `Wire`.
 */
export function nodePort(port: NodePortLike): Wire {
  return {
    onMessage: (listener) => {
      port.on("message", listener)

      return () => {
        port.removeListener("message", listener)
      }
    },
    send: (data) => {
      port.postMessage(data)
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The Electron hand-off: three functions, two ends, one channel string. A MessagePort cannot
// cross contextBridge, but window.postMessage can transfer it — so main ships the port to the
// page's IPC channel (sendPort), the preload relays it into the window (relayPort), and the
// renderer awaits it (receivePort). Keep the channel string in shared code so all three agree.
// ---------------------------------------------------------------------------------------------

type PortMessageEvent = { data: unknown; ports: readonly DomPortLike[]; source: unknown }

/**
 * The slice of a DOM `window` the hand-off touches.
 */
export type MessageWindowLike = {
  addEventListener(type: "message", listener: (event: PortMessageEvent) => void): void
  removeEventListener(type: "message", listener: (event: PortMessageEvent) => void): void
  postMessage(message: unknown, targetOrigin: string, transfer?: readonly unknown[]): void
}

function defaultWindow(caller: string): MessageWindowLike {
  // The cast is the boundary with the untyped global scope; the guard below is what validates it.
  const candidate = (globalThis as { window?: MessageWindowLike }).window

  if (!candidate) {
    throw new Error(`${caller} needs a window; outside the DOM, pass one explicitly`)
  }

  return candidate
}

/**
 * Renderer end of the hand-off: resolves with the port the preload relays on `type`. The guard is
 * deliberate security surface — only same-window messages (i.e. the preload's relay) carrying the
 * agreed type and an actual port are accepted, so an injected script cannot substitute a port it
 * controls. Feed the result to {@link domPort}; `connect` accepts the pending promise directly:
 * `connect(receivePort("app:port").then(domPort), { router })`.
 */
export function receivePort(type: string, target?: MessageWindowLike): Promise<DomPortLike> {
  const win = target ?? defaultWindow("receivePort")

  return new Promise((resolve) => {
    const handle = (event: PortMessageEvent): void => {
      const data = event.data as { type?: unknown } | null
      const port = event.ports[0]

      if (event.source !== win || data?.type !== type || !port) {
        return
      }

      // Removal is the guard's job, not {once}'s: an unrelated message must not consume the
      // listener before the port arrives.
      win.removeEventListener("message", handle)
      resolve(port)
    }

    win.addEventListener("message", handle)
  })
}

/**
 * The slice of Electron's `ipcRenderer` the preload relay touches.
 */
export type PortIpcRendererLike = {
  on(channel: string, listener: (event: { ports: readonly unknown[] }) => void): unknown
}

/**
 * Preload end of the hand-off: relays every port arriving on the IPC channel `type` into the page,
 * where {@link receivePort} is waiting. `ipcRenderer` is a parameter (not a global) so the preload
 * stays the only module that imports Electron.
 */
export function relayPort(
  ipcRenderer: PortIpcRendererLike,
  type: string,
  target?: MessageWindowLike
): void {
  const win = target ?? defaultWindow("relayPort")

  ipcRenderer.on(type, (event) => {
    win.postMessage({ type }, "*", event.ports)
  })
}

/**
 * The slice of a `BrowserWindow` that {@link sendPort} touches.
 */
export type PortWindowLike = {
  webContents: {
    once(event: "did-finish-load", listener: () => void): unknown
    postMessage(channel: string, message: unknown, transfer?: unknown[]): void
  }
}

/**
 * Main-process end of the hand-off: ships one end of a `MessageChannelMain` to a window once the
 * page can receive it. Window lifecycle stays the caller's business — pair this with
 * `win.on("closed", () => close(...))` on the `connect` session serving the other end.
 */
export function sendPort(win: PortWindowLike, port: MainPortLike, type: string): void {
  win.webContents.once("did-finish-load", () => {
    win.webContents.postMessage(type, null, [port])
  })
}
