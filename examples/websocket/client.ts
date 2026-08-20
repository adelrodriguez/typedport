/* oxlint-disable no-console -- runnable example */
// The mirror image of the server: serves the push contract, calls the pull
// contract. The deferred transport makes `api` usable before the socket opens.
import { createClient, createRouter, type Transport } from "../../src/index.ts"
import { connect, type Wire } from "../../src/wire.ts"
import { contract, pushContract } from "./contract.ts"

const pushRouter = createRouter(pushContract, {
  "ticker.tick": ({ count }) => {
    console.log(`tick ${count}`)
  },
})

const ws = new WebSocket("ws://localhost:4321")

const ready = new Promise<Transport>((resolve) => {
  ws.addEventListener("open", () => {
    const wire: Wire = {
      onMessage: (listener) => {
        ws.addEventListener("message", (event) => {
          listener(JSON.parse(String(event.data)))
        })
      },
      send: (data) => {
        ws.send(JSON.stringify(data))
      },
    }

    const session = connect(wire, { router: pushRouter, timeoutMs: 5000 })

    // Wire the socket's liveness signal to the session: in-flight calls get a
    // fast `closed` rejection instead of waiting out the timeout.
    ws.addEventListener("close", () => {
      session.close(new Error("socket closed"))
    })

    resolve(session.transport)
  })
})

const api = createClient(contract, async (path, payload) => (await ready)(path, payload))

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
