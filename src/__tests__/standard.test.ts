import type { StandardSchemaV1 } from "@standard-schema/spec"
/* oxlint-disable await-thenable, no-confusing-void-expression -- bun:test types async matchers like `.rejects.toThrow()` as void, but they must be awaited for the assertion to complete */
import { describe, expect, test } from "bun:test"
import * as z from "zod"
import { createClient } from "../lib/client"
import { defineContract, event } from "../lib/contract"
import { createRouter } from "../lib/router"
import { ValidationError } from "../lib/standard"

const contract = defineContract({
  greet: event({ input: z.object({ name: z.string() }), output: z.string() }),
  notify: event(z.object({ message: z.string() })),
})

describe("ValidationError", () => {
  test("client input failures carry Standard Schema issues", async () => {
    const client = createClient(contract, () => "hi")

    const error = await client
      .greet({ name: 1 as unknown as string })
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).issues.length).toBeGreaterThan(0)
  })

  test("router distinguishes validation failures from resolver failures", async () => {
    const router = createRouter(contract, {
      greet: () => {
        throw new Error("resolver exploded")
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
      shout: event({ input: stringSchema, output: stringSchema }),
    })

    const router = createRouter(custom, {
      shout: (input) => input.toUpperCase(),
    })

    await expect(router.dispatch("shout", "hey")).resolves.toBe("HEY")
    await expect(router.dispatch("shout", 42)).rejects.toThrow("expected a string")
  })
})
