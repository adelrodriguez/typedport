// The worker side: a router serving the contract, wired to the worker's message port.
import { createRouter } from "../../src/index.ts"
import { connect, type Wire } from "../../src/wire.ts"
import { contract } from "./contract.ts"

declare const self: Worker

const router = createRouter(contract, {
  "primes.count": ({ below }) => countPrimes(below),
})

const wire: Wire = {
  onMessage: (listener) => {
    self.addEventListener("message", (event) => {
      listener(event.data)
    })
  },
  send: (data) => {
    // oxlint-disable-next-line require-post-message-target-origin -- Worker.postMessage takes a transfer list, not a targetOrigin
    self.postMessage(data)
  },
}

connect(wire, { router })

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
