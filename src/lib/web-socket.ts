import type { Wire } from "./wire"

/**
 * The shape both socket families share: the browser/Node built-in `WebSocket` and the `ws`
 * package's sockets (which implement the browser-compatible listener API). `readyState` and the
 * `open` event exist for {@link whenOpen}.
 */
export type WebSocketLike = {
  readyState: number
  send(data: string): void
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  addEventListener(type: "open", listener: () => void): void
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void
}

// WebSocket.OPEN — a static on the class, so the constant is restated here rather than reached
// through a constructor the structural type deliberately doesn't require.
const OPEN = 1

/**
 * Wraps a WebSocket as a `Wire`. Sockets carry frames, not values, so the wire envelope rides JSON
 * here — which makes this a JSON boundary: payloads must survive it (no `undefined` in arrays, no
 * Dates without a schema that revives them), unlike the structured-clone transports.
 *
 * Sending on a socket that isn't open yet throws; hand `connect` the pending wire instead:
 * `connect(whenOpen(socket).then(webSocket), { router })`.
 */
export function webSocket(socket: WebSocketLike): Wire {
  return {
    onMessage: (listener) => {
      const handle = (event: { data: unknown }): void => {
        // Text frames arrive as strings in browsers and Buffers from `ws`.
        listener(JSON.parse(typeof event.data === "string" ? event.data : String(event.data)))
      }

      socket.addEventListener("message", handle)

      return () => {
        socket.removeEventListener("message", handle)
      }
    },
    send: (data) => {
      socket.send(JSON.stringify(data))
    },
  }
}

/** Resolves with the socket once it can send — immediately if it already can. */
export function whenOpen<Socket extends WebSocketLike>(socket: Socket): Promise<Socket> {
  if (socket.readyState === OPEN) {
    return Promise.resolve(socket)
  }

  return new Promise((resolve) => {
    socket.addEventListener("open", () => {
      resolve(socket)
    })
  })
}
