import { describe, expect, test } from "vitest"
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
    // oxlint-disable-next-line no-confusing-void-expression -- deliberately observing the runtime value behind the void type
    const result: unknown = await client.stripe.checkout.created({ id: "evt_123" })

    expect(result).toEqual({ messageId: "msg_stripe.checkout.created" })
  })

  test("exposes $path, $input, and $output helpers", () => {
    const { client } = createTestClient()

    expect(client.stripe.checkout.created.$path).toBe("stripe.checkout.created")
    expect(client.localFiles.save.$path).toBe("localFiles.save")

    // For a bare-schema leaf, the schema is the input; there is no output.
    expect(client.localFiles.save.$input).toBe(LocalTextFile)
    expect(client.localFiles.save.$output).toBeUndefined()

    expect(client.localFiles.open.$output).not.toBeUndefined()
  })

  test("rejects unknown channels", async () => {
    const { client } = createTestClient()
    const tree = client as unknown as { localFiles: { rename: () => Promise<void> } }

    await expect(tree.localFiles.rename()).rejects.toThrow('Unknown channel: "localFiles.rename"')
  })
})

describe("per-call options", () => {
  const optionsContract = defineContract({
    greet: event({ input: z.object({ name: z.string() }), output: z.string() }),
    misc: {
      ping: event({ input: z.void(), output: z.string() }),
    },
  })

  function createRecordingClient() {
    const seen: unknown[] = []
    const client = createClient(
      optionsContract,
      (path, _payload, options?: { a?: number; b?: number }) => {
        seen.push(options)
        return `ok:${path}`
      }
    )

    return { client, seen }
  }

  test("forwards per-call options to the transport", async () => {
    const { client, seen } = createRecordingClient()

    await client.greet({ name: "Ada" }, { a: 1 })
    await client.greet({ name: "Ada" })

    expect(seen).toEqual([{ a: 1 }, undefined])
  })

  test("$with binds options without disturbing the input slot", async () => {
    const { client, seen } = createRecordingClient()

    await expect(client.$with({ a: 1 }).misc.ping()).resolves.toBe("ok:misc.ping")

    expect(seen).toEqual([{ a: 1 }])
  })

  test("$with works on subtrees, chains, and merges per-call over bound", async () => {
    const { client, seen } = createRecordingClient()

    const bound = client.$with({ a: 1, b: 1 })
    await bound.greet({ name: "Ada" }, { b: 2 })
    await bound.$with({ a: 3 }).greet({ name: "Ada" })
    await client.misc.$with({ b: 4 }).ping()

    expect(seen).toEqual([{ a: 1, b: 2 }, { a: 3, b: 1 }, { b: 4 }])
  })
})
