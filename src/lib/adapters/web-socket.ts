import type { Wire } from "../wire/types"
import { ChannelError } from "../core/error"

/**
 * The shape both socket families share: the browser/Node built-in `WebSocket` and the `ws`
 * package's sockets (which implement the browser-compatible listener API). `readyState` and the
 * `open` event exist for {@link whenOpen}.
 */
export type WebSocketLike = {
  readyState: number
  send(data: string): void
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  addEventListener(type: "open" | "close" | "error", listener: () => void): void
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  removeEventListener(type: "open" | "close" | "error", listener: () => void): void
}

// WebSocket.OPEN and .CLOSING — statics on the class, so the constants are restated here rather
// than reached through a constructor the structural type deliberately doesn't require.
const OPEN = 1
const CLOSING = 2

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
        // Text frames arrive as strings; String() also recovers text from a Buffer. Anything else
        // is a binary frame, which this protocol never sends and the parse below drops.
        const raw = typeof event.data === "string" ? event.data : String(event.data)

        let data: unknown

        try {
          data = JSON.parse(raw)
        } catch {
          // A malformed frame from an untrusted peer must not throw out of the
          // listener: on a `ws` server that propagates as an uncaughtException
          // and kills the process. Drop the frame; if it was a mangled reply,
          // the sender's own timeout covers it. Only the parse is guarded —
          // an error thrown by `listener` is a real failure and still surfaces.
          return
        }

        listener(data)
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

/**
 * Resolves with the socket once it can send — immediately if it already can. Rejects if the socket
 * errors or closes before opening, or is already closing or closed, so a dead endpoint fails loudly
 * instead of leaving the promise (and everything `connect` queued behind it) pending forever. The
 * rejection is a `ChannelError` with code `closed`; `cause` says whether the socket errored or
 * closed.
 *
 * The listeners detach once the promise settles, so a `ws` socket keeps Node's
 * throw-on-unhandled-`error` default after it opens. Attach your own `error` listener there.
 */
export function whenOpen<Socket extends WebSocketLike>(socket: Socket): Promise<Socket> {
  if (socket.readyState === OPEN) {
    return Promise.resolve(socket)
  }

  // A closed socket emits nothing more, so waiting for `close` would hang forever.
  if (socket.readyState >= CLOSING) {
    return Promise.reject(notOpened("closed"))
  }

  return new Promise((resolve, reject) => {
    // Detach on settle: a lingering "error" listener would otherwise suppress
    // ws's throw-on-unhandled-error for the socket's whole life, not just the
    // pre-open window this function owns.
    const detach = (): void => {
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
      socket.removeEventListener("close", onClose)
    }
    const onOpen = (): void => {
      detach()
      resolve(socket)
    }
    const onError = (): void => {
      detach()
      reject(notOpened("errored"))
    }
    const onClose = (): void => {
      detach()
      reject(notOpened("closed"))
    }

    socket.addEventListener("open", onOpen)
    socket.addEventListener("error", onError)
    socket.addEventListener("close", onClose)
  })
}

// A socket that never opens is a wire torn down before its first message — a condition callers
// handle (retry, reconnect), so it is a ChannelError `closed`, like a wire closed later on.
function notOpened(how: "closed" | "errored"): ChannelError {
  return new ChannelError({ code: "closed" }, { cause: new Error(`Socket ${how} before opening`) })
}
