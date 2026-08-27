import { describe, expect, test } from "vitest"
import * as z from "zod"
import { createClient } from "../client"
import { defineContract, channel } from "../contract"
import { createRouter } from "../router"
import { webSocket, whenOpen, type WebSocketLike } from "../web-socket"
import { connect } from "../wire"

type MessageListener = (event: { data: unknown }) => void

// A connected socket pair that transmits JSON text frames only — sending anything
// non-string would throw, which is exactly what the wire must never do.
function createSocketPair(): [WebSocketLike, WebSocketLike] {
  const listeners: [MessageListener[], MessageListener[]] = [[], []]
  const openListeners: [Array<() => void>, Array<() => void>] = [[], []]
  const state: [number, number] = [0, 0]

  const makeEnd = (mine: 0 | 1, theirs: 0 | 1): WebSocketLike & { open: () => void } => ({
    addEventListener: (type: "message" | "open", listener: MessageListener | (() => void)) => {
      if (type === "open") {
        openListeners[mine].push(listener as () => void)
      } else {
        listeners[mine].push(listener)
      }
    },
    open: () => {
      state[mine] = 1

      for (const listener of openListeners[mine]) {
        listener()
      }
    },
    get readyState() {
      return state[mine]
    },
    removeEventListener: (_type, listener) => {
      listeners[mine] = listeners[mine].filter((entry) => entry !== listener)
    },
    send: (data) => {
      if (typeof data !== "string") {
        throw new TypeError("socket frames must be strings")
      }

      for (const listener of listeners[theirs]) {
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
      addEventListener: (_type: string, listener: MessageListener | (() => void)) => {
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
})

describe("whenOpen", () => {
  test("resolves immediately for an already-open socket", async () => {
    const [socket] = createSocketPair()

    ;(socket as WebSocketLike & { open: () => void }).open()

    await expect(whenOpen(socket)).resolves.toBe(socket)
  })

  test("waits for the open event otherwise", async () => {
    const [socket] = createSocketPair()

    const pending = whenOpen(socket)

    ;(socket as WebSocketLike & { open: () => void }).open()

    await expect(pending).resolves.toBe(socket)
  })
})
