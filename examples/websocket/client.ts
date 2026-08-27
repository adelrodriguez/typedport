/* oxlint-disable no-console -- runnable example */
// The mirror image of the server: serves the push contract, calls the pull
// contract. connect() accepts the still-opening socket as a pending wire, so
// `api` is usable immediately — early calls queue until the socket opens.
import { createClient, createRouter } from "../../src/index.ts"
import { connect } from "../../src/wire.ts"
import { webSocket, whenOpen } from "../../src/wire/web-socket.ts"
import { contract, pushContract } from "./contract.ts"

const pushRouter = createRouter(pushContract, {
  "ticker.tick": ({ count }) => {
    console.log(`tick ${count}`)
  },
})

const ws = new WebSocket("ws://localhost:4321")

const session = connect(whenOpen(ws).then(webSocket), { router: pushRouter, timeoutMs: 5000 })

// Wire the socket's liveness signal to the session: in-flight calls get a
// fast `closed` rejection instead of waiting out the timeout.
ws.addEventListener("close", () => {
  session.close(new Error("socket closed"))
})

const api = createClient(contract, session.transport)

console.log("2 + 3 =", await api.math.add({ a: 2, b: 3 }))

// The server's router rejects bad input; the error arrives here as a real
// ChannelError (code "validation") thanks to the wire envelope.
await api.math.add({ a: 2, b: "three" as unknown as number }).catch((error: unknown) => {
  console.log("server rejected:", (error as Error).message)
})

// Watch a few pushes, then hang up.
await new Promise((resolve) => {
  setTimeout(resolve, 3500)
})
ws.close()
