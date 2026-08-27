/* oxlint-disable class-methods-use-this -- capnweb dispatches instance methods; static would fall off the stub */
// The worker side: a capnweb RpcTarget served over the same shipped wire the worker-threads
// example uses. The class is the API — no contract file, and nothing validates inputs at
// runtime; TypeScript types are erased on the way over.
import { parentPort } from "node:worker_threads"
import { RpcSession, RpcTarget } from "capnweb"
import { nodePort } from "../../src/wire/message-port.ts"
import { wireTransport } from "./wire-transport.ts"

export class WorkerApi extends RpcTarget {
  countPrimes(below: number): number {
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

  // The part typedport's protocol cannot express: the main thread passes a live function, and
  // the worker calls it — a capability crossing the boundary by reference, not by value.
  streamPrimes(count: number, onPrime: (prime: number) => void): void {
    let found = 0

    for (let candidate = 2; found < count; candidate += 1) {
      if (isPrime(candidate)) {
        onPrime(candidate)
        found += 1
      }
    }
  }
}

function isPrime(candidate: number): boolean {
  for (let divisor = 2; divisor * divisor <= candidate; divisor += 1) {
    if (candidate % divisor === 0) {
      return false
    }
  }

  return candidate > 1
}

if (!parentPort) {
  throw new Error("This module must run inside a worker thread")
}

// oxlint-disable-next-line no-new -- the session registers itself on the port; its lifetime is the worker's
new RpcSession(wireTransport(nodePort(parentPort)).transport, new WorkerApi())
