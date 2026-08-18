import { describe, expect, test } from "vitest"
import * as z from "zod"
import { createClient } from "../lib/client"
import { defineContract, event } from "../lib/contract"
import { createRouter } from "../lib/router"
import { ValidationError } from "../lib/standard"
import { connect, dispatchToWire, fromWire, type Wire } from "../lib/wire"

// An in-memory duplex pipe. Cloning every message (as postMessage would)
// asserts the protocol survives serializing boundaries, not shared references.
function createWirePair(): [Wire, Wire] {
  const listeners: [Array<(data: unknown) => void>, Array<(data: unknown) => void>] = [[], []]

  const makeEnd = (mine: 0 | 1, theirs: 0 | 1): Wire => ({
    onMessage: (listener) => {
      listeners[mine].push(listener)
      return () => {
        listeners[mine] = listeners[mine].filter((entry) => entry !== listener)
      }
    },
    send: (data) => {
      const cloned = structuredClone(data)
      for (const listener of listeners[theirs]) {
        queueMicrotask(() => {
          listener(cloned)
        })
      }
    },
  })

  return [makeEnd(0, 1), makeEnd(1, 0)]
}

const pullContract = defineContract({
  math: {
    add: event({ input: z.object({ a: z.number(), b: z.number() }), output: z.number() }),
  },
})

const pushContract = defineContract({
  notify: event(z.object({ message: z.string() })),
  ping: event({ input: z.void(), output: z.literal("pong") }),
})

function createConnectedPeers() {
  const [serverWire, clientWire] = createWirePair()

  const serverRouter = createRouter(pullContract, {
    "math.add": ({ a, b }) => a + b,
  })
  const clientRouter = createRouter(pushContract, {
    notify: () => null,
    ping: () => "pong" as const,
  })

  const server = connect(serverWire, { router: serverRouter })
  const client = connect(clientWire, { router: clientRouter })

  return {
    api: createClient(pullContract, client.transport),
    client,
    push: createClient(pushContract, server.transport),
    server,
  }
}

describe("connect", () => {
  test("round-trips in both directions over one pipe", async () => {
    const { api, push } = createConnectedPeers()

    await expect(api.math.add({ a: 2, b: 3 })).resolves.toBe(5)
    await expect(push.ping()).resolves.toBe("pong")
    await expect(push.notify({ message: "hi" })).resolves.toBeUndefined()
  })

  test("rehydrates ValidationError with issues across the wire", async () => {
    const { api } = createConnectedPeers()

    const error = await api.math
      .add({ a: 2, b: "three" as unknown as number })
      .catch((error: unknown) => error)

    // Thrown by the remote router, yet instanceof works on this side.
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).issues.length).toBeGreaterThan(0)
  })

  test("carries resolver crashes as plain errors", async () => {
    const [serverWire, clientWire] = createWirePair()
    const router = createRouter(pullContract, {
      "math.add": () => {
        throw new Error("resolver exploded")
      },
    })
    connect(serverWire, { router })
    const { transport } = connect(clientWire)

    const error = await Promise.resolve(transport("math.add", { a: 1, b: 2 })).catch(
      (error: unknown) => error
    )

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ValidationError)
    expect((error as Error).message).toBe("resolver exploded")
  })

  test("a call-only end rejects incoming requests", async () => {
    const [serverWire, clientWire] = createWirePair()
    connect(serverWire) // no router
    const { transport } = connect(clientWire)

    await expect(transport("math.add", { a: 1, b: 2 })).rejects.toThrow(
      "This end does not serve requests"
    )
  })

  test("times out calls the peer never answers", async () => {
    const [wire] = createWirePair() // peer end never connected
    const { transport } = connect(wire, { timeoutMs: 20 })

    await expect(transport("math.add", { a: 1, b: 2 })).rejects.toThrow(
      'Call to "math.add" timed out after 20ms'
    )
  })

  test("close rejects pending and future calls", async () => {
    const [wire] = createWirePair() // peer end never connected
    const { close, transport } = connect(wire)

    const pending = transport("math.add", { a: 1, b: 2 })
    close(new Error("window closed"))

    await expect(pending).rejects.toThrow("window closed")
    await expect(Promise.resolve(transport("math.add", { a: 1, b: 2 }))).rejects.toThrow(
      "window closed"
    )
  })
})

describe("dispatchToWire / fromWire", () => {
  const router = createRouter(pullContract, {
    "math.add": ({ a, b }) => a + b,
  })

  test("flattens success into a value fromWire unwraps", async () => {
    const wire = await dispatchToWire(router, "math.add", { a: 2, b: 3 })

    expect(wire).toEqual({ ok: true, result: 5 })
    expect(fromWire(wire)).toBe(5)
  })

  test("flattens validation failures into issues fromWire rehydrates", async () => {
    const wire = await dispatchToWire(router, "math.add", { a: 2, b: "three" })

    expect(wire.ok).toBe(false)

    const error = (() => {
      try {
        fromWire(wire)
        return null
      } catch (error) {
        return error
      }
    })()

    expect(error).toBeInstanceOf(ValidationError)
  })
})
