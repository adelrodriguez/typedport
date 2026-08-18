/* oxlint-disable no-console -- runnable example */
// The main thread: a typed client whose transport is the worker's message port.
// No JSON here — worker messages are structured-cloned natively.
import { createClient } from "../../src/index.ts"
import { connect, type Wire } from "../../src/wire.ts"
import { contract } from "./contract.ts"

const worker = new Worker(new URL("worker.ts", import.meta.url).href)

const wire: Wire = {
  onMessage: (listener) => {
    worker.addEventListener("message", (event) => {
      listener(event.data)
    })
  },
  send: (data) => {
    // oxlint-disable-next-line require-post-message-target-origin -- Worker.postMessage takes a transfer list, not a targetOrigin
    worker.postMessage(data)
  },
}

const { close, transport } = connect(wire, { timeoutMs: 10_000 })
const api = createClient(contract, transport)

console.log("primes below 1,000,000:", await api.primes.count({ below: 1_000_000 }))

// Validation happens before anything reaches the worker:
await api.primes.count({ below: -1 }).catch((error: unknown) => {
  console.log("rejected at the call site:", (error as Error).message)
})

close()
worker.terminate()
