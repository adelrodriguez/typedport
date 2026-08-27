// The worker side: a router serving the contract, wired to the thread's message port.
// A browser Web Worker is the same shape — swap parentPort for self.
import { parentPort } from "node:worker_threads"
import { createRouter } from "../../src/index.ts"
import { connect } from "../../src/wire.ts"
import { nodePort } from "../../src/wire/message-port.ts"
import { contract } from "./contract.ts"

if (!parentPort) {
  throw new Error("This module must run inside a worker thread")
}

const router = createRouter(contract, {
  "primes.count": ({ below }) => countPrimes(below),
})

connect(nodePort(parentPort), { router })

function countPrimes(below: number): number {
  if (below < 3) {
    return 0
  }

  const composite = new Uint8Array(below)
  let count = 1 // 2 is prime

  for (let candidate = 3; candidate < below; candidate += 2) {
    if (composite[candidate]) {
      continue
    }

    count += 1

    for (let multiple = candidate * candidate; multiple < below; multiple += candidate * 2) {
      composite[multiple] = 1
    }
  }

  return count
}
