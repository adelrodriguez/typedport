/* oxlint-disable no-console -- runnable example */
// One connect() per socket: each session serves the pull contract and gets a
// typed push client for the peer. Messages are JSON — the wire envelope keeps
// ChannelError intact across it.
import { WebSocketServer } from "ws"
import { createClient, createRouter, type InferClient } from "../../src/index.ts"
import { connect } from "../../src/wire.ts"
import { webSocket } from "../../src/wire/web-socket.ts"
import { contract, pushContract } from "./contract.ts"

const router = createRouter(contract, {
  "math.add": ({ a, b }) => a + b,
})

const clients = new Set<InferClient<typeof pushContract>>()

const server = new WebSocketServer({ port: 4321 })

server.on("connection", (socket) => {
  // ws sockets speak the browser-compatible listener API, so the same wire
  // wrapper covers both sides; it parses ws's Buffer frames too.
  const { close, transport } = connect(webSocket(socket), { router, timeoutMs: 5000 })
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
    // The peer may hang up between the tick and its acknowledgement — an
    // unhandled rejection here would take the whole server down.
    push.ticker.tick({ count }).catch(() => null)
  }
}, 1000)
