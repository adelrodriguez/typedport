import { describe, expect, test } from "vitest"
import * as z from "zod"
import { createClient } from "../client"
import { defineContract, channel } from "../contract"
import {
  domPort,
  mainPort,
  nodePort,
  receivePort,
  relayPort,
  sendPort,
  type DomPortLike,
  type MainPortLike,
  type MessageWindowLike,
  type NodePortLike,
} from "../message-port"
import { createRouter } from "../router"
import { connect } from "../wire"

type Listener = (event: { data: unknown }) => void

// One end MessagePortMain-flavored, the other DOM-flavored — the exact pairing of the Electron
// main ↔ renderer hand-off. Messages are structured-cloned, and both ends buffer until start(),
// as the real ports do.
function createPortPair(): { main: MainPortLike; dom: DomPortLike } {
  const buffers: [unknown[], unknown[]] = [[], []]
  const listeners: [Listener[], Listener[]] = [[], []]
  const started: [boolean, boolean] = [false, false]

  const deliver = (side: 0 | 1, data: unknown): void => {
    if (!started[side] || listeners[side].length === 0) {
      buffers[side].push(data)
      return
    }

    for (const listener of listeners[side]) {
      queueMicrotask(() => {
        listener({ data })
      })
    }
  }

  const start = (side: 0 | 1): void => {
    started[side] = true

    for (const data of buffers[side].splice(0)) {
      deliver(side, data)
    }
  }

  return {
    dom: {
      addEventListener: (_type, listener) => {
        listeners[1].push(listener)
      },
      postMessage: (message) => {
        deliver(0, structuredClone(message))
      },
      removeEventListener: (_type, listener) => {
        listeners[1] = listeners[1].filter((entry) => entry !== listener)
      },
      start: () => {
        start(1)
      },
    },
    main: {
      on: (_event, listener) => {
        listeners[0].push(listener)
      },
      postMessage: (message) => {
        deliver(1, structuredClone(message))
      },
      removeListener: (_event, listener) => {
        listeners[0] = listeners[0].filter((entry) => entry !== listener)
      },
      start: () => {
        start(0)
      },
    },
  }
}

const contract = defineContract({
  math: {
    add: channel({ input: z.object({ a: z.number(), b: z.number() }), output: z.number() }),
  },
})

describe("mainPort / domPort", () => {
  test("a full stack round-trips across the flavor boundary", async () => {
    const { main, dom } = createPortPair()

    const router = createRouter(contract, {
      "math.add": ({ a, b }) => a + b,
    })
    connect(mainPort(main), { router })

    const client = connect(domPort(dom))
    const api = createClient(contract, client.transport)

    await expect(api.math.add({ a: 2, b: 3 })).resolves.toBe(5)
  })

  test("unsubscribing detaches the listener from both flavors", () => {
    const { main, dom } = createPortPair()

    const mainSeen: unknown[] = []
    const domSeen: unknown[] = []

    const stopMain = mainPort(main).onMessage((data) => {
      mainSeen.push(data)
    })
    const stopDom = domPort(dom).onMessage((data) => {
      domSeen.push(data)
    })

    if (typeof stopMain === "function") {
      stopMain()
    }
    if (typeof stopDom === "function") {
      stopDom()
    }

    // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage takes a transfer list, not a targetOrigin
    dom.postMessage("to main")
    // oxlint-disable-next-line require-post-message-target-origin -- MessagePortMain.postMessage takes a transfer list, not a targetOrigin
    main.postMessage("to dom")

    expect(mainSeen).toEqual([])
    expect(domSeen).toEqual([])
  })
})

describe("nodePort", () => {
  test("adapts the unwrapped-value emitter shape", () => {
    let handler: ((value: unknown) => void) | undefined
    const sent: unknown[] = []

    const port: NodePortLike = {
      on: (_event, listener) => {
        handler = listener
      },
      postMessage: (value) => {
        sent.push(value)
      },
      removeListener: () => {
        handler = undefined
      },
    }

    const wire = nodePort(port)
    const seen: unknown[] = []
    const stop = wire.onMessage((data) => {
      seen.push(data)
    })

    // Node listeners receive the value directly — no event wrapper to unwrap.
    handler?.({ hello: true })
    wire.send("out")

    expect(seen).toEqual([{ hello: true }])
    expect(sent).toEqual(["out"])

    if (typeof stop === "function") {
      stop()
    }

    expect(handler).toBeUndefined()
  })
})

type WindowMessage = { message: unknown; targetOrigin: string; transfer: readonly unknown[] }

function createFakeWindow(): {
  window: MessageWindowLike
  emit: (event: { data: unknown; ports: readonly DomPortLike[]; source: unknown }) => void
  posted: WindowMessage[]
  listenerCount: () => number
} {
  let listeners: Array<(event: { data: unknown; ports: readonly DomPortLike[]; source: unknown }) => void> = []
  const posted: WindowMessage[] = []

  return {
    emit: (event) => {
      for (const listener of listeners) {
        listener(event)
      }
    },
    listenerCount: () => listeners.length,
    posted,
    window: {
      addEventListener: (_type, listener) => {
        listeners.push(listener)
      },
      postMessage: (message, targetOrigin, transfer = []) => {
        posted.push({ message, targetOrigin, transfer })
      },
      removeEventListener: (_type, listener) => {
        listeners = listeners.filter((entry) => entry !== listener)
      },
    },
  }
}

describe("receivePort", () => {
  test("resolves only for same-window messages of the agreed type carrying a port", async () => {
    const fake = createFakeWindow()
    const { dom } = createPortPair()

    const received = receivePort("app:port", fake.window)

    // An injected script posting from elsewhere must not be able to substitute a port.
    fake.emit({ data: { type: "app:port" }, ports: [dom], source: { not: "the window" } })
    // Same window, wrong type: not ours.
    fake.emit({ data: { type: "other" }, ports: [dom], source: fake.window })
    // Same window, right type, no port: not consumed.
    fake.emit({ data: { type: "app:port" }, ports: [], source: fake.window })

    expect(fake.listenerCount()).toBe(1)

    fake.emit({ data: { type: "app:port" }, ports: [dom], source: fake.window })

    await expect(received).resolves.toBe(dom)
    // The guard controls removal; once resolved the listener is gone.
    expect(fake.listenerCount()).toBe(0)
  })
})

describe("relayPort", () => {
  test("reposts ports from the IPC channel into the page", () => {
    const fake = createFakeWindow()
    const { dom } = createPortPair()

    const handlers = new Map<string, (event: { ports: readonly unknown[] }) => void>()
    relayPort(
      {
        on: (channel, listener) => {
          handlers.set(channel, listener)
        },
      },
      "app:port",
      fake.window
    )

    handlers.get("app:port")?.({ ports: [dom] })

    expect(fake.posted).toEqual([
      { message: { type: "app:port" }, targetOrigin: "*", transfer: [dom] },
    ])
  })
})

describe("sendPort", () => {
  test("ships the port once the page has loaded", () => {
    const { main } = createPortPair()
    const posted: Array<{ channel: string; message: unknown; transfer?: unknown[] }> = []
    let onLoad: (() => void) | undefined

    sendPort(
      {
        webContents: {
          once: (_event, listener) => {
            onLoad = listener
          },
          postMessage: (channel, message, transfer) => {
            posted.push({ channel, message, transfer })
          },
        },
      },
      main,
      "app:port"
    )

    // Nothing moves before the page can receive it.
    expect(posted).toEqual([])

    onLoad?.()

    expect(posted).toEqual([{ channel: "app:port", message: null, transfer: [main] }])
  })
})
