/* oxlint-disable no-console -- runnable example */
// The main thread: a capnweb session whose transport is a typedport wire. Same worker, same
// nodePort hand-off as the worker-threads example — a different protocol on top. The same
// wireTransport over mainPort/domPort (plus sendPort/relayPort/receivePort) is an Electron
// main ↔ renderer transport for capnweb.
import { Worker } from "node:worker_threads"
import { RpcSession } from "capnweb"
import type { Wire } from "../../src/wire.ts"
import type { WorkerApi } from "./worker.ts"
import { nodePort } from "../../src/wire/message-port.ts"
import { wireTransport } from "./wire-transport.ts"

const worker = new Worker(new URL("worker.ts", import.meta.url))

// A pending wire, settled once the worker is online — the shape of an Electron port still being
// handed over. The first call below is made before it settles, so it waits in the adapter's
// outbox and is flushed on arrival.
const wire = new Promise<Wire>((resolve, reject) => {
  worker.once("error", reject)
  worker.once("online", () => {
    worker.off("error", reject)
    resolve(nodePort(worker))
  })
})

const { close, transport } = wireTransport(wire)
const session = new RpcSession<WorkerApi>(transport)
const api = session.getRemoteMain()

console.log("primes below 1,000,000:", await api.countPrimes(1_000_000))

// A live callback crosses the boundary by reference; the worker calls back into this thread
// once per prime. This is capnweb's capability passing — no contract tree can express it.
await api.streamPrimes(5, (prime) => {
  console.log("streamed from worker:", prime)
})

// The trade: no schema boundary. The worker-threads example rejects { below: -1 } at the call
// site before it leaves the thread; here the value reaches the worker unchecked.
// The 0 is the sieve's own `below < 3` guard, not a rejection — the bad value arrived.
console.log("countPrimes(-1) reached the worker unvalidated:", await api.countPrimes(-1))

close()
await worker.terminate()
