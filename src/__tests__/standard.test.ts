/* oxlint-disable await-thenable, no-confusing-void-expression -- bun:test types async matchers like `.rejects.toThrow()` as void, but they must be awaited for the assertion to complete */
import { describe, expect, test } from "bun:test"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import * as z from "zod"
import { createClient } from "../lib/client"
import { defineContract, event, procedure } from "../lib/contract"
import { ValidationError } from "../lib/standard"
import { createRouter } from "../lib/router"

const contract = defineContract({
  greet: procedure({ input: z.object({ name: z.string() }), output: z.string() }),
  notify: event(z.object({ message: z.string() })),
})

describe("options passthrough", () => {
  test("forwards per-call options to the transport", async () => {
    const seen: unknown[] = []
    const client = createClient(contract, {
      call: (_path: string, _input: unknown, options?: { delay?: number }) => {
        seen.push(options)
        return Promise.resolve("hi")
      },
      post: (_path: string, _payload: unknown, options?: { delay?: number }) => {
        seen.push(options)
        return Promise.resolve()
      },
    })

    await client.greet({ name: "Ada" }, { delay: 5 })
    await client.notify.publish({ message: "hi" }, { delay: 10 })
    await client.greet({ name: "Ada" })

    expect(seen).toEqual([{ delay: 5 }, { delay: 10 }, undefined])
  })

  test("publish resolves with the transport's post result", async () => {
    const client = createClient(contract, {
      post: (path: string) => Promise.resolve({ messageId: `msg_${path}` }),
    })

    await expect(client.notify.publish({ message: "hi" })).resolves.toEqual({
      messageId: "msg_notify",
    })
  })
})

describe("ValidationError", () => {
  test("client input failures carry Standard Schema issues", async () => {
    const client = createClient(contract, { call: () => Promise.resolve("hi") })

    const error = await client.greet({ name: 1 as unknown as string }).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).issues.length).toBeGreaterThan(0)
  })

  test("router distinguishes validation failures from handler failures", async () => {
    const router = createRouter(contract, {
      greet: () => {
        throw new Error("handler exploded")
      },
      notify: () => null,
    })

    const invalid = await router.dispatch("greet", { name: 1 }).catch((error: unknown) => error)
    const crashed = await router.dispatch("greet", { name: "Ada" }).catch((error: unknown) => error)

    expect(invalid).toBeInstanceOf(ValidationError)
    expect(crashed).toBeInstanceOf(Error)
    expect(crashed).not.toBeInstanceOf(ValidationError)
  })
})

describe("schema-library agnosticism", () => {
  // A hand-rolled Standard Schema — no library involved.
  const stringSchema: StandardSchemaV1<string> = {
    "~standard": {
      validate: (value) =>
        typeof value === "string" ? { value } : { issues: [{ message: "expected a string" }] },
      vendor: "typeport-test",
      version: 1,
    },
  }

  test("any Standard Schema works as a contract leaf", async () => {
    const custom = defineContract({
      shout: procedure({ input: stringSchema, output: stringSchema }),
    })

    const router = createRouter(custom, {
      shout: (input) => input.toUpperCase(),
    })

    await expect(router.dispatch("shout", "hey")).resolves.toBe("HEY")
    await expect(router.dispatch("shout", 42)).rejects.toThrow("expected a string")
  })
})
