import { describe, expect, test, vi } from "vitest"
import * as z from "zod"
import { createClient } from "../client"
import { defineContract, event } from "../contract"
import { TypeportError } from "../error"
import { createRouter } from "../router"
import { connect, fromWire, toWire, type Wire } from "../wire"

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

  test("rehydrates validation failures with issues across the wire", async () => {
    const { api } = createConnectedPeers()

    const error = await api.math
      .add({ a: 2, b: "three" as unknown as number })
      .catch((error: unknown) => error)

    // Thrown by the remote router, yet instanceof and code checks work on this side.
    expect(error).toBeInstanceOf(TypeportError)

    const typeportError = error as Extract<TypeportError, { code: "validation" }>

    expect(typeportError.code).toBe("validation")
    expect(typeportError.issues.length).toBeGreaterThan(0)
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
    expect(error).not.toBeInstanceOf(TypeportError)
    expect((error as Error).message).toBe("resolver exploded")
  })

  test("a call-only end rejects incoming requests with code no-router", async () => {
    const [serverWire, clientWire] = createWirePair()
    connect(serverWire) // no router
    const { transport } = connect(clientWire)

    const error = await Promise.resolve(transport("math.add", { a: 1, b: 2 })).catch(
      (error: unknown) => error
    )

    // Raised on the peer, rehydrated here with its code intact.
    expect(error).toBeInstanceOf(TypeportError)
    expect((error as TypeportError).code).toBe("no-router")
    expect((error as TypeportError).message).toBe("This end does not serve requests")
  })

  test("times out calls the peer never answers", async () => {
    const [wire] = createWirePair() // peer end never connected
    const { transport } = connect(wire, { timeoutMs: 20 })

    const error = await Promise.resolve(transport("math.add", { a: 1, b: 2 })).catch(
      (error: unknown) => error
    )

    expect(error).toBeInstanceOf(TypeportError)

    const typeportError = error as Extract<TypeportError, { code: "timeout" }>

    expect(typeportError.code).toBe("timeout")
    expect(typeportError.path).toBe("math.add")
    expect(typeportError.timeoutMs).toBe(20)
  })

  test("passes per-connection context to the served router", async () => {
    const [serverWire, clientWire] = createWirePair()
    const seen: string[] = []

    const router = createRouter<typeof pullContract, { sessionId: string }>(pullContract, {
      "math.add": ({ a, b }, session) => {
        seen.push(session.sessionId)
        return a + b
      },
    })

    connect(serverWire, { context: { sessionId: "s1" }, router })
    const { transport } = connect(clientWire)

    await expect(Promise.resolve(transport("math.add", { a: 2, b: 3 }))).resolves.toBe(5)
    expect(seen).toEqual(["s1"])
  })

  test("close rejects pending and future calls with the reason in cause", async () => {
    const [wire] = createWirePair() // peer end never connected
    const { close, transport } = connect(wire)

    const pending = transport("math.add", { a: 1, b: 2 })
    close(new Error("window closed"))

    const error = await Promise.resolve(pending).catch((error: unknown) => error)
    const late = await Promise.resolve(transport("math.add", { a: 1, b: 2 })).catch(
      (error: unknown) => error
    )

    for (const rejection of [error, late]) {
      expect(rejection).toBeInstanceOf(TypeportError)
      expect((rejection as TypeportError).code).toBe("closed")
      expect(((rejection as TypeportError).cause as Error).message).toBe("window closed")
    }
  })

  test("survives a synchronously-throwing send without leaking pending entries", async () => {
    vi.useFakeTimers()

    try {
      const [silent] = createWirePair()
      const wire: Wire = {
        onMessage: silent.onMessage,
        send: () => {
          throw new Error("DataCloneError: not cloneable")
        },
      }
      const { transport } = connect(wire, { timeoutMs: 1000 })

      await expect(Promise.resolve(transport("math.add", { a: 1, b: 2 }))).rejects.toThrow(
        "not cloneable"
      )

      // The entry's timeout timer is armed in the same block that registers the
      // pending entry; a leak leaves it live, and this catches it.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("toWire / fromWire", () => {
  const router = createRouter(pullContract, {
    "math.add": ({ a, b }) => a + b,
  })

  test("flattens success into a value fromWire unwraps", async () => {
    const wire = await toWire(router.dispatch("math.add", { a: 2, b: 3 }))

    expect(wire).toEqual({ ok: true, result: 5 })
    expect(fromWire(wire)).toBe(5)
  })

  test("flattens validation failures into issues fromWire rehydrates", async () => {
    const wire = await toWire(router.dispatch("math.add", { a: 2, b: "three" }))

    expect(wire.ok).toBe(false)

    const error = (() => {
      try {
        fromWire(wire)
        return null
      } catch (error) {
        return error
      }
    })()

    expect(error).toBeInstanceOf(TypeportError)
    expect((error as TypeportError).code).toBe("validation")
  })

  test("rejects values that are not envelopes with a clear error", () => {
    for (const garbage of [
      null,
      "502 Bad Gateway",
      { message: "not an envelope" },
      { ok: false },
    ]) {
      expect(() => fromWire(garbage)).toThrow("not a WireResult envelope")
    }
  })

  test("captures operations that are not dispatch, including sync throws", async () => {
    await expect(toWire(Promise.resolve("receipt"))).resolves.toEqual({
      ok: true,
      result: "receipt",
    })

    const wire = await toWire(() => {
      throw new Error("sync explosion")
    })

    expect(wire).toEqual({
      error: { message: "sync explosion", name: "Error" },
      ok: false,
    })
  })
})
