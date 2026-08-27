import { describe, expect, test } from "vitest"
import * as z from "zod"
import { createClient } from "../client"
import { defineContract, channel } from "../contract"
import { createRouter } from "../router"
import { webSocket, whenOpen, type WebSocketLike } from "../web-socket"
import { connect } from "../wire"

type MessageListener = (event: { data: unknown }) => void

type FakeSocket = WebSocketLike & {
  open: () => void
  fail: () => void
  hangUp: () => void
}

// A connected socket pair that transmits JSON text frames only — sending anything
// non-string would throw, which is exactly what the wire must never do. Lifecycle
// listeners (open/close/error) take no arguments, so storing everything as
// MessageListener and firing lifecycle events with a dummy payload is sound.
function createSocketPair(): [FakeSocket, FakeSocket] {
  const ends: [Record<string, MessageListener[]>, Record<string, MessageListener[]>] = [{}, {}]
  const state: [number, number] = [0, 0]

  const listenersFor = (side: 0 | 1, type: string): MessageListener[] => {
    const existing = ends[side][type]

    if (existing) {
      return existing
    }

    const created: MessageListener[] = []
    ends[side][type] = created
    return created
  }

  const fire = (side: 0 | 1, type: "open" | "close" | "error"): void => {
    for (const listener of listenersFor(side, type)) {
      listener({ data: undefined })
    }
  }

  const makeEnd = (mine: 0 | 1, theirs: 0 | 1): FakeSocket => ({
    addEventListener: (type: string, listener: MessageListener) => {
      listenersFor(mine, type).push(listener)
    },
    fail: () => {
      fire(mine, "error")
    },
    hangUp: () => {
      fire(mine, "close")
    },
    open: () => {
      state[mine] = 1
      fire(mine, "open")
    },
    get readyState() {
      return state[mine]
    },
    removeEventListener: (_type, listener) => {
      ends[mine]["message"] = listenersFor(mine, "message").filter((entry) => entry !== listener)
    },
    send: (data) => {
      if (typeof data !== "string") {
        throw new TypeError("socket frames must be strings")
      }

      for (const listener of listenersFor(theirs, "message")) {
        queueMicrotask(() => {
          listener({ data })
        })
      }
    },
  })

  return [makeEnd(0, 1), makeEnd(1, 0)]
}

const contract = defineContract({
  math: {
    add: channel({ input: z.object({ a: z.number(), b: z.number() }), output: z.number() }),
  },
})

describe("webSocket", () => {
  test("a full stack round-trips over JSON frames", async () => {
    const [serverSocket, clientSocket] = createSocketPair()

    const router = createRouter(contract, {
      "math.add": ({ a, b }) => a + b,
    })
    connect(webSocket(serverSocket), { router })

    const client = connect(webSocket(clientSocket))
    const api = createClient(contract, client.transport)

    await expect(api.math.add({ a: 2, b: 3 })).resolves.toBe(5)
  })

  test("parses Buffer-style frames, as ws delivers them", () => {
    const seen: unknown[] = []
    let handler: MessageListener | undefined

    const wire = webSocket({
      addEventListener: (_type: string, listener: MessageListener) => {
        handler = listener
      },
      readyState: 1,
      removeEventListener: () => null,
      send: () => null,
    })

    wire.onMessage((data) => {
      seen.push(data)
    })

    // `ws` hands text frames over as Buffers; String() must recover the JSON.
    handler?.({ data: Buffer.from('{"kind":"req"}', "utf8") })

    expect(seen).toEqual([{ kind: "req" }])
  })

  test("drops malformed frames instead of throwing out of the listener", () => {
    const seen: unknown[] = []
    let handler: MessageListener | undefined

    const wire = webSocket({
      addEventListener: (_type: string, listener: MessageListener) => {
        handler = listener
      },
      readyState: 1,
      removeEventListener: () => null,
      send: () => null,
    })

    wire.onMessage((data) => {
      seen.push(data)
    })

    // A throw here would propagate through ws's EventEmitter as an
    // uncaughtException and kill a Node server process.
    expect(() => handler?.({ data: "not json at all" })).not.toThrow()
    expect(seen).toEqual([])

    // The connection survives: the next well-formed frame still arrives.
    handler?.({ data: '{"kind":"req"}' })
    expect(seen).toEqual([{ kind: "req" }])
  })
})

describe("whenOpen", () => {
  test("resolves immediately for an already-open socket", async () => {
    const [socket] = createSocketPair()

    socket.open()

    await expect(whenOpen(socket)).resolves.toBe(socket)
  })

  test("waits for the open event otherwise", async () => {
    const [socket] = createSocketPair()

    const pending = whenOpen(socket)

    socket.open()

    await expect(pending).resolves.toBe(socket)
  })

  test("rejects when the socket errors before opening", async () => {
    const [socket] = createSocketPair()

    const pending = whenOpen(socket)

    socket.fail()

    await expect(pending).rejects.toThrow("Socket failed before opening")
  })

  test("rejects when the socket closes before opening", async () => {
    const [socket] = createSocketPair()

    const pending = whenOpen(socket)

    socket.hangUp()

    await expect(pending).rejects.toThrow("Socket closed before opening")
  })
})
