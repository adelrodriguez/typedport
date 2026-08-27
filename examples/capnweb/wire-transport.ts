// A capnweb RpcTransport over a typedport Wire. The wires carry structured-clonable values, so
// the session runs at encodingLevel "structuredClonable" — no JSON strings, native values ride
// the port the same way typedport's own protocol does. The adapter's whole job is inverting
// push (Wire hands values to a listener) into pull (capnweb awaits receive()), plus a close.
// Everything else — correlation, timeouts, error serialization — belongs to capnweb's session,
// which is why this is not `connect`.
import type { RpcTransportWithCustomEncoding } from "capnweb"
import type { Wire } from "../../src/wire.ts"

export type WireTransport = {
  transport: RpcTransportWithCustomEncoding
  /**
   * Ends the session: rejects the pending receive and every future one.
   */
  close: (reason?: Error) => void
}

export function wireTransport(wire: Wire | Promise<Wire>): WireTransport {
  const inbox: unknown[] = []
  const waiters: Array<{ reject: (error: Error) => void; resolve: (value: unknown) => void }> = []
  const outbox: unknown[] = []
  let ready: Wire | undefined
  let closed: Error | undefined
  let unsubscribe: (() => void) | undefined

  const close = (reason?: Error): void => {
    if (closed) {
      return
    }

    closed = reason ?? new Error("transport closed")

    for (const waiter of waiters.splice(0)) {
      waiter.reject(closed)
    }

    inbox.length = 0
    outbox.length = 0
    unsubscribe?.()
  }

  const attach = (arrived: Wire): void => {
    ready = arrived

    const detach = arrived.onMessage((data) => {
      if (closed) {
        return
      }

      const waiter = waiters.shift()
      waiter ? waiter.resolve(data) : inbox.push(data)
    })

    if (typeof detach === "function") {
      unsubscribe = detach
    }

    // capnweb's send is synchronous, so a pending wire (a port still being handed over) queues
    // outbound messages here and flushes them on arrival.
    for (const message of outbox.splice(0)) {
      arrived.send(message)
    }
  }

  const adopt = async (pendingWire: Promise<Wire>): Promise<void> => {
    const arrived = await pendingWire

    if (!closed) {
      attach(arrived)
    }
  }

  if ("send" in wire) {
    attach(wire)
  } else {
    adopt(wire).catch((error: unknown) => {
      close(new Error("wire failed", { cause: error }))
    })
  }

  return {
    close,
    transport: {
      abort: (reason) => {
        close(reason instanceof Error ? reason : new Error(String(reason)))
      },
      encodingLevel: "structuredClonable",
      receive: () => {
        if (closed) {
          return Promise.reject(closed)
        }

        if (inbox.length > 0) {
          return Promise.resolve(inbox.shift())
        }

        return new Promise((resolve, reject) => {
          waiters.push({ reject, resolve })
        })
      },
      send: (message) => {
        if (closed) {
          return
        }

        ready ? ready.send(message) : outbox.push(message)
      },
    },
  }
}
