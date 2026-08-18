/* oxlint-disable await-thenable, no-confusing-void-expression -- bun:test types async matchers like `.rejects.toThrow()` as void, but they must be awaited for the assertion to complete */
import { describe, expect, test } from "bun:test"
import * as z from "zod"
import { createClient } from "../lib/client"
import { defineContract, event } from "../lib/contract"
import { createRouter } from "../lib/router"

const LocalTextFile = z.object({ contents: z.string(), path: z.string() })

const contract = defineContract({
  localFiles: {
    open: event({ input: z.void(), output: LocalTextFile.nullable() }),
    save: event(LocalTextFile),
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
    "localFiles.open": () => ({ contents: "hello", path: "/tmp/a.txt" }),
    "localFiles.save": (file) => {
      saved.push(file)
    },
    "stripe.checkout.created": (payload) => {
      published.push(payload)
    },
  })

  return { client: createClient(contract, router.dispatch), published, saved }
}

describe("createClient", () => {
  test("round-trips a leaf with an output schema", async () => {
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

  test("sends one-way leaves with a validated payload", async () => {
    const { client, published } = createTestClient()

    await expect(client.stripe.checkout.created({ id: "evt_123" })).resolves.toBeUndefined()

    expect(published).toEqual([{ id: "evt_123" }])
  })

  test("passes the transport's result through on one-way leaves", async () => {
    const client = createClient(contract, (path) => ({ messageId: `msg_${path}` }))

    // Typed `Promise<void>`, but the raw value stays reachable for edges that want it.
    const result: unknown = await client.stripe.checkout.created({ id: "evt_123" })

    expect(result).toEqual({ messageId: "msg_stripe.checkout.created" })
  })

  test("exposes $path and $schema helpers", () => {
    const { client } = createTestClient()

    expect(client.stripe.checkout.created.$path).toBe("stripe.checkout.created")
    expect(client.localFiles.save.$path).toBe("localFiles.save")
    expect(client.localFiles.save.$schema).toBe(LocalTextFile)
  })

  test("rejects unknown channels", async () => {
    const { client } = createTestClient()
    const tree = client as unknown as { localFiles: { rename: () => Promise<void> } }

    await expect(tree.localFiles.rename()).rejects.toThrow('Unknown channel: "localFiles.rename"')
  })
})
