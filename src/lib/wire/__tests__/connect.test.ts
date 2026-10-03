import { describe, expect, test, vi } from "vitest"
import * as z from "zod"
import type { Wire } from "../types"
import { createClient } from "../../client/client"
import { defineContract, channel } from "../../core/contract"
import { ChannelError } from "../../core/error"
import { createRouter } from "../../server/router"
import { connect } from "../connect"
import { fromWire, toWire } from "../envelope"

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
    add: channel({ input: z.object({ a: z.number(), b: z.number() }), output: z.number() }),
  },
})

const pushContract = defineContract({
  notify: channel(z.object({ message: z.string() })),
  ping: channel({ input: z.void(), output: z.literal("pong") }),
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
    expect(error).toBeInstanceOf(ChannelError)

    const channelError = error as Extract<ChannelError, { code: "validation" }>

    expect(channelError.code).toBe("validation")
    expect(channelError.issues.length).toBeGreaterThan(0)
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
    expect(error).not.toBeInstanceOf(ChannelError)
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
    expect(error).toBeInstanceOf(ChannelError)
    expect((error as ChannelError).code).toBe("no-router")
    expect((error as ChannelError).message).toBe("This end does not serve requests")
  })

  test("ignores requests without a numeric id or string path", async () => {
    const [serverWire, peerWire] = createWirePair()
    const seen: unknown[] = []
    let calls = 0
    const router = createRouter(pullContract, {
      "math.add": ({ a, b }) => {
        calls += 1
        return a + b
      },
    })

    connect(serverWire, { router })
    peerWire.onMessage((data) => {
      seen.push(data)
    })
    peerWire.send({ id: "1", kind: "req", path: "math.add", payload: { a: 1, b: 2 } })
    peerWire.send({ id: 2, kind: "req", path: ["math", "add"], payload: { a: 1, b: 2 } })
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })

    expect(calls).toBe(0)
    expect(seen).toEqual([])
  })

  test("times out calls the peer never answers", async () => {
    const [wire] = createWirePair() // peer end never connected
    const { transport } = connect(wire, { timeoutMs: 20 })

    const error = await Promise.resolve(transport("math.add", { a: 1, b: 2 })).catch(
      (error: unknown) => error
    )

    expect(error).toBeInstanceOf(ChannelError)

    const channelError = error as Extract<ChannelError, { code: "timeout" }>

    expect(channelError.code).toBe("timeout")
    expect(channelError.path).toBe("math.add")
    expect(channelError.timeoutMs).toBe(20)
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
      expect(rejection).toBeInstanceOf(ChannelError)
      expect((rejection as ChannelError).code).toBe("closed")
      expect(((rejection as ChannelError).cause as Error).message).toBe("window closed")
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

    expect(error).toBeInstanceOf(ChannelError)
    expect((error as ChannelError).code).toBe("validation")
  })

  test("rejects values that are not envelopes with code malformed-envelope", () => {
    for (const garbage of [
      null,
      "502 Bad Gateway",
      { message: "not an envelope" },
      { ok: false },
    ]) {
      const error = (() => {
        try {
          fromWire(garbage)
          return null
        } catch (error) {
          return error
        }
      })()

      // Library-raised, so it follows the one rule: ChannelError with a code.
      expect(error).toBeInstanceOf(ChannelError)
      expect((error as ChannelError).code).toBe("malformed-envelope")
    }
  })

  test("rejects forged or mistyped error details as malformed-envelope", () => {
    for (const forged of [
      { error: { detail: { code: "made-up" }, message: "x", name: "ChannelError" }, ok: false },
      {
        error: { detail: { code: "validation", issues: "nope" }, message: "x", name: "E" },
        ok: false,
      },
      {
        error: { detail: { code: "timeout", path: 1, timeoutMs: 5 }, message: "x", name: "E" },
        ok: false,
      },
      { error: { message: 42, name: "Error" }, ok: false },
    ]) {
      expect(() => fromWire(forged)).toThrow(
        expect.objectContaining({ code: "malformed-envelope" }) as Error
      )
    }
  })

  test.each([
    ["an object path", { path: {} }],
    ["a null segment", { path: [null] }],
    ["a segment without a key", { path: [{ name: "a" }] }],
  ])("rejects issues with %s as malformed-envelope", (_name, extra) => {
    for (const code of ["validation", "output-validation"]) {
      expect(() =>
        fromWire({
          error: {
            detail: { code, issues: [{ message: "bad", ...extra }] },
            message: "bad",
            name: "ChannelError",
          },
          ok: false,
        })
      ).toThrow(expect.objectContaining({ code: "malformed-envelope" }) as Error)
    }
  })

  test("accepts Standard Schema paths of keys and segments", () => {
    const issues = [{ message: "bad", path: ["items", 0, { key: "name" }] }, { message: "no path" }]

    expect(() =>
      fromWire({
        error: { detail: { code: "validation", issues }, message: "bad", name: "ChannelError" },
        ok: false,
      })
    ).toThrow(expect.objectContaining({ code: "validation", issues }) as Error)
  })

  test("copies only a detail's known fields onto the rehydrated error", () => {
    const error = (() => {
      try {
        fromWire({
          error: {
            detail: { code: "unknown-channel", message: "spoofed", path: "a.b", stack: "spoofed" },
            message: "x",
            name: "ChannelError",
          },
          ok: false,
        })
        return null
      } catch (error) {
        return error as ChannelError
      }
    })()

    expect(error?.code).toBe("unknown-channel")
    expect(error?.message).toBe('Unknown channel: "a.b"')
    expect(error?.stack).not.toBe("spoofed")
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

describe("connect over a pending wire", () => {
  test("queues calls until the wire arrives, then flushes them", async () => {
    const [serverWire, clientWire] = createWirePair()

    const serverRouter = createRouter(pullContract, {
      "math.add": ({ a, b }) => a + b,
    })
    connect(serverWire, { router: serverRouter })

    const { promise: pending, resolve: deliver } = Promise.withResolvers<Wire>()

    const client = connect(pending)
    const api = createClient(pullContract, client.transport)

    // Called before any wire exists; must settle once one shows up.
    const result = api.math.add({ a: 2, b: 3 })

    deliver(clientWire)

    await expect(result).resolves.toBe(5)
  })

  test("close before the wire arrives wins the race", async () => {
    const { promise: pending, resolve: deliver } = Promise.withResolvers<Wire>()

    const client = connect(pending)
    const api = createClient(pullContract, client.transport)

    const result = api.math.add({ a: 2, b: 3 })

    client.close(new Error("gave up"))

    const error = await result.catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ChannelError)
    expect((error as ChannelError).code).toBe("closed")
    expect((error as ChannelError).cause).toBeInstanceOf(Error)

    // A late wire must stay untouched: no listener attached, nothing buffered leaked onto it.
    const attached: unknown[] = []
    const sent: unknown[] = []
    deliver({
      onMessage: (listener) => {
        attached.push(listener)
      },
      send: (data) => {
        sent.push(data)
      },
    })

    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })

    expect(attached).toEqual([])
    expect(sent).toEqual([])
  })

  test("does not flush requests whose callers already timed out", async () => {
    const { promise: pending, resolve: deliver } = Promise.withResolvers<Wire>()

    const client = connect(pending, { timeoutMs: 5 })
    const api = createClient(pullContract, client.transport)

    // Times out while the wire is still pending; the queued frame must die with it.
    await expect(api.math.add({ a: 2, b: 3 })).rejects.toMatchObject({ code: "timeout" })

    const attached: unknown[] = []
    const sent: unknown[] = []
    deliver({
      onMessage: (listener) => {
        attached.push(listener)
      },
      send: (data) => {
        sent.push(data)
      },
    })

    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })

    // The connection is still open (the listener attaches), but the peer must
    // not run a resolver for a call nobody is waiting on.
    expect(attached).toHaveLength(1)
    expect(sent).toEqual([])
  })

  test("a rejected wire promise closes the connection with the reason as cause", async () => {
    const reason = new Error("no port for you")
    const client = connect(Promise.reject(reason))
    const api = createClient(pullContract, client.transport)

    // The rejection lands in a microtask; afterwards every call is a fast failure.
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })

    const error = await api.math.add({ a: 1, b: 1 }).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ChannelError)
    expect((error as ChannelError).code).toBe("closed")
    expect((error as ChannelError).cause).toBe(reason)
  })
})
