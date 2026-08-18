/* oxlint-disable no-console -- runnable example */
// One connect() per socket: each session serves the pull contract and gets a
// typed push client for the peer. Messages are JSON — the wire envelope keeps
// ValidationError intact across it.
import type { ServerWebSocket } from "bun"
import { createClient, createRouter, type InferClient } from "../../src/index.ts"
import { connect, type Wire } from "../../src/wire.ts"
import { contract, pushContract } from "./contract.ts"

type Session = {
  close: (reason?: Error) => void
  deliver: (data: unknown) => void
  push: InferClient<typeof pushContract>
}

const router = createRouter(contract, {
  "math.add": ({ a, b }) => a + b,
})

const sessions = new Map<ServerWebSocket<unknown>, Session>()

// Placeholder listener for the gap between open() and connect() wiring one up.
const noop = () => null

const server = Bun.serve({
  fetch(request, bunServer) {
    return bunServer.upgrade(request) ? undefined : new Response("WebSocket only", { status: 400 })
  },
  port: 4321,
  websocket: {
    close(ws) {
      sessions.get(ws)?.close(new Error("socket closed"))
      sessions.delete(ws)
    },
    message(ws, raw) {
      sessions.get(ws)?.deliver(JSON.parse(String(raw)))
    },
    open(ws) {
      let listen: (data: unknown) => void = noop

      const wire: Wire = {
        onMessage: (listener) => {
          listen = listener
        },
        send: (data) => ws.send(JSON.stringify(data)),
      }

      const { close, transport } = connect(wire, { router, timeoutMs: 5000 })

      sessions.set(ws, {
        close,
        deliver: (data) => {
          listen(data)
        },
        push: createClient(pushContract, transport),
      })
    },
  },
})

console.log(`listening on ws://localhost:${server.port}`)

let count = 0

setInterval(() => {
  count += 1

  for (const session of sessions.values()) {
    void session.push.ticker.tick({ count })
  }
}, 1000)
