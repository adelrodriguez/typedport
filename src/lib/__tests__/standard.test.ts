import type { StandardSchemaV1 } from "@standard-schema/spec"
import { describe, expect, test } from "vitest"
import * as z from "zod"
import { createClient } from "../client"
import { defineContract, channel } from "../contract"
import { ChannelError } from "../error"
import { createRouter } from "../router"
import { parseWith } from "../standard"

const contract = defineContract({
  greet: channel({ input: z.object({ name: z.string() }), output: z.string() }),
  notify: channel(z.object({ message: z.string() })),
})

describe("ChannelError", () => {
  test("client input failures carry code validation and Standard Schema issues", async () => {
    const client = createClient(contract, () => "hi")

    const error = await client
      .greet({ name: 1 as unknown as string })
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ChannelError)

    const channelError = error as Extract<ChannelError, { code: "validation" }>

    expect(channelError.code).toBe("validation")
    expect(channelError.issues.length).toBeGreaterThan(0)
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

    expect(invalid).toBeInstanceOf(ChannelError)
    expect((invalid as ChannelError).code).toBe("validation")
    expect(unknown).toBeInstanceOf(ChannelError)
    expect((unknown as ChannelError).code).toBe("unknown-channel")
    expect(crashed).toBeInstanceOf(Error)
    expect(crashed).not.toBeInstanceOf(ChannelError)
  })
})

describe("parseWith", () => {
  // Standard Schema permits async validation; this is the only place the
  // await branch is exercised.
  const asyncString: StandardSchemaV1<string> = {
    "~standard": {
      validate: (value) =>
        Promise.resolve(
          typeof value === "string" ? { value } : { issues: [{ message: "expected a string" }] }
        ),
      vendor: "typedport-test",
      version: 1,
    },
  }

  test("awaits schemas that validate asynchronously", async () => {
    await expect(parseWith(asyncString, "ok")).resolves.toBe("ok")
  })

  test("async failures throw ChannelError with code validation", async () => {
    const error = await parseWith(asyncString, 42).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ChannelError)
    expect((error as ChannelError).code).toBe("validation")
    expect((error as Extract<ChannelError, { code: "validation" }>).issues).toEqual([
      { message: "expected a string" },
    ])
  })
})

describe("schema-library agnosticism", () => {
  // A hand-rolled Standard Schema — no library involved.
  const stringSchema: StandardSchemaV1<string> = {
    "~standard": {
      validate: (value) =>
        typeof value === "string" ? { value } : { issues: [{ message: "expected a string" }] },
      vendor: "typedport-test",
      version: 1,
    },
  }

  test("any Standard Schema works as a contract leaf", async () => {
    const custom = defineContract({
      shout: channel({ input: stringSchema, output: stringSchema }),
    })

    const router = createRouter(custom, {
      shout: (input) => input.toUpperCase(),
    })

    await expect(router.dispatch("shout", "hey")).resolves.toBe("HEY")
    await expect(router.dispatch("shout", 42)).rejects.toThrow("expected a string")
  })
})
