import type { StandardSchemaV1 } from "@standard-schema/spec"
import { describe, expect, test } from "vitest"
import * as z from "zod"
import { createClient } from "../client"
import { defineContract, event } from "../contract"
import { TypeportError } from "../error"
import { createRouter } from "../router"

const contract = defineContract({
  greet: event({ input: z.object({ name: z.string() }), output: z.string() }),
  notify: event(z.object({ message: z.string() })),
})

describe("TypeportError", () => {
  test("client input failures carry code validation and Standard Schema issues", async () => {
    const client = createClient(contract, () => "hi")

    const error = await client
      .greet({ name: 1 as unknown as string })
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(TypeportError)

    const typeportError = error as Extract<TypeportError, { code: "validation" }>

    expect(typeportError.code).toBe("validation")
    expect(typeportError.issues.length).toBeGreaterThan(0)
  })

  test("router distinguishes library failures from resolver failures", async () => {
    const router = createRouter(contract, {
      greet: () => {
        throw new Error("resolver exploded")
      },
      notify: () => null,
    })

    const invalid = await router.dispatch("greet", { name: 1 }).catch((error: unknown) => error)
    const unknown = await router.dispatch("nope", {}).catch((error: unknown) => error)
    const crashed = await router.dispatch("greet", { name: "Ada" }).catch((error: unknown) => error)

    expect(invalid).toBeInstanceOf(TypeportError)
    expect((invalid as TypeportError).code).toBe("validation")
    expect(unknown).toBeInstanceOf(TypeportError)
    expect((unknown as TypeportError).code).toBe("unknown-channel")
    expect(crashed).toBeInstanceOf(Error)
    expect(crashed).not.toBeInstanceOf(TypeportError)
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
