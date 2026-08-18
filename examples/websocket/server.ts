/* oxlint-disable no-console -- runnable example */
// One connect() per socket: each session serves the pull contract and gets a
// typed push client for the peer. Messages are JSON — the wire envelope keeps
// ValidationError intact across it.
import { WebSocketServer } from "ws"
import { createClient, createRouter, type InferClient } from "../../src/index.ts"
import { connect, type Wire } from "../../src/wire.ts"
import { contract, pushContract } from "./contract.ts"

const router = createRouter(contract, {
  "math.add": ({ a, b }) => a + b,
})

const clients = new Set<InferClient<typeof pushContract>>()

const server = new WebSocketServer({ port: 4321 })

server.on("connection", (socket) => {
  const wire: Wire = {
    onMessage: (listener) => {
      socket.on("message", (raw) => {
        // Text frames arrive as a Buffer.
        listener(JSON.parse((raw as Buffer).toString("utf8")))
      })
    },
    send: (data) => {
      socket.send(JSON.stringify(data))
    },
  }

  const { close, transport } = connect(wire, { router, timeoutMs: 5000 })
  const push = createClient(pushContract, transport)

  clients.add(push)
  socket.on("close", () => {
    close(new Error("socket closed"))
    clients.delete(push)
  })
})

console.log("listening on ws://localhost:4321")

let count = 0

setInterval(() => {
  count += 1

  for (const push of clients) {
    void push.ticker.tick({ count })
  }
}, 1000)
