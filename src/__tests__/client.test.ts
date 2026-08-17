/* oxlint-disable await-thenable, no-confusing-void-expression -- bun:test types async matchers like `.rejects.toThrow()` as void, but they must be awaited for the assertion to complete */
import { describe, expect, test } from "bun:test"
import * as z from "zod"
import { createClient } from "../client"
import { defineContract, event, procedure } from "../contract"
import { createMemoryTransport, createRouter } from "../router"

const LocalTextFile = z.object({ contents: z.string(), path: z.string() })

const contract = defineContract({
  localFiles: {
    open: procedure({ input: z.void(), output: LocalTextFile.nullable() }),
    save: procedure({ input: LocalTextFile, output: z.void() }),
  },
  stripe: {
    checkout: {
      created: event(z.object({ id: z.string() })),
    },
  },
})

function createTestClient() {
  const saved: Array<z.infer<typeof LocalTextFile>> = []
  const published: Array<{ id: string }> = []

  const router = createRouter(contract, {
    "localFiles.open": () => Promise.resolve({ contents: "hello", path: "/tmp/a.txt" }),
    "localFiles.save": (file) => {
      saved.push(file)
      return Promise.resolve()
    },
    "stripe.checkout.created": (payload) => {
      published.push(payload)
      return Promise.resolve()
    },
  })

  return { client: createClient(contract, createMemoryTransport(router)), published, saved }
}

describe("createClient", () => {
  test("round-trips a procedure through the transport", async () => {
    const { client } = createTestClient()

    await expect(client.localFiles.open()).resolves.toEqual({
      contents: "hello",
      path: "/tmp/a.txt",
    })
  })

  test("validates input at the call site before sending", async () => {
    const { client, saved } = createTestClient()

    await expect(
      client.localFiles.save({ contents: 1 as unknown as string, path: "/tmp/a.txt" })
    ).rejects.toThrow()
    expect(saved).toEqual([])
  })

  test("publishes events with a validated payload", async () => {
    const { client, published } = createTestClient()

    await client.stripe.checkout.created.publish({ id: "evt_123" })

    expect(published).toEqual([{ id: "evt_123" }])
  })

  test("exposes $path and $schema helpers", () => {
    const { client } = createTestClient()

    expect(client.stripe.checkout.created.$path).toBe("stripe.checkout.created")
    expect(client.localFiles.save.$path).toBe("localFiles.save")
    expect(client.localFiles.save.$schema).toBe(LocalTextFile)
  })

  test("rejects calling an event as a procedure", async () => {
    const { client } = createTestClient()
    const leaf = client.stripe.checkout.created as unknown as () => Promise<void>

    await expect(leaf()).rejects.toThrow('"stripe.checkout.created" is an event; use .publish()')
  })

  test("rejects publishing a procedure", async () => {
    const { client } = createTestClient()
    const leaf = client.localFiles.open as unknown as {
      publish: (input: unknown) => Promise<void>
    }

    await expect(leaf.publish({})).rejects.toThrow(
      '"localFiles.open" is a procedure; call it directly'
    )
  })

  test("rejects unknown channels", async () => {
    const { client } = createTestClient()
    const tree = client as unknown as { localFiles: { rename: () => Promise<void> } }

    await expect(tree.localFiles.rename()).rejects.toThrow('Unknown channel: "localFiles.rename"')
  })

  test("rejects when the transport lacks the required function", async () => {
    const client = createClient(contract, {})
    const events = createClient(contract, { request: () => Promise.resolve(null) })

    await expect(client.localFiles.open()).rejects.toThrow("Transport does not support procedures")
    await expect(events.stripe.checkout.created.publish({ id: "evt_1" })).rejects.toThrow(
      "Transport does not support events"
    )
  })
})
