/* oxlint-disable no-console -- runnable example */
// The main thread: a typed client whose transport is the worker's message port.
// No JSON here — worker messages are structured-cloned natively.
import { Worker } from "node:worker_threads"
import { createClient } from "../../src/index.ts"
import { connect } from "../../src/wire.ts"
import { nodePort } from "../../src/wire/message-port.ts"
import { contract } from "./contract.ts"

const worker = new Worker(new URL("worker.ts", import.meta.url))

// A Worker is postMessage-shaped the same way a worker_threads MessagePort is,
// so the shipped wire covers it.
const { close, transport } = connect(nodePort(worker), { timeoutMs: 10_000 })
const api = createClient(contract, transport)

console.log("primes below 1,000,000:", await api.primes.count({ below: 1_000_000 }))

// Validation happens before anything reaches the worker:
await api.primes.count({ below: -1 }).catch((error: unknown) => {
  console.log("rejected at the call site:", (error as Error).message)
})

close()
await worker.terminate()
