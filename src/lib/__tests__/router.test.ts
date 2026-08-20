import { describe, expect, test } from "vitest"
import * as z from "zod"
import { defineContract, channel } from "../contract"
import { ChannelError } from "../error"
import { createRouter } from "../router"

const contract = defineContract({
  math: {
    add: channel({
      input: z.object({ a: z.number(), b: z.number().default(1) }),
      output: z.number(),
    }),
  },
  notify: channel(z.object({ message: z.string() })),
})

describe("createRouter", () => {
  test("lists every channel", () => {
    const router = createRouter(contract, {
      "math.add": ({ a, b }) => a + b,
      notify: () => null,
    })

    expect(router.channels.toSorted()).toEqual(["math.add", "notify"])
  })

  test("parses input before the resolver runs, applying defaults", async () => {
    const router = createRouter(contract, {
      "math.add": ({ a, b }) => a + b,
      notify: () => null,
    })

    await expect(router.dispatch("math.add", { a: 2 })).resolves.toBe(3)
  })

  test("rejects invalid input without calling the resolver", async () => {
    let called = false
    const router = createRouter(contract, {
      "math.add": ({ a, b }) => {
        called = true
        return a + b
      },
      notify: () => null,
    })

    await expect(router.dispatch("math.add", { a: "two" })).rejects.toThrow()
    expect(called).toBe(false)
  })

  test("rejects unknown channels", async () => {
    const router = createRouter(contract, {
      "math.add": ({ a, b }) => a + b,
      notify: () => null,
    })

    await expect(router.dispatch("math.subtract", {})).rejects.toThrow(
      'Unknown channel: "math.subtract"'
    )
  })

  test("rejects resolver results that drift off contract as output-validation", async () => {
    const router = createRouter(contract, {
      "math.add": () => "not a number" as unknown as number,
      notify: () => null,
    })

    const error = await router.dispatch("math.add", { a: 1, b: 2 }).catch((error: unknown) => error)

    // The server's fault, not the caller's — a distinct code lets edges avoid
    // reporting it as a 400.
    expect(error).toBeInstanceOf(ChannelError)
    expect((error as ChannelError).code).toBe("output-validation")
  })

  test("passes the edge's context to every resolver", async () => {
    const seen: string[] = []
    const router = createRouter<typeof contract, { userId: string }>(contract, {
      "math.add": ({ a, b }, session) => {
        seen.push(session.userId)
        return a + b
      },
      notify: (_payload, session) => {
        seen.push(session.userId)
      },
    })

    await expect(router.dispatch("math.add", { a: 1, b: 2 }, { userId: "ada" })).resolves.toBe(3)
    await router.dispatch("notify", { message: "hi" }, { userId: "grace" })

    expect(seen).toEqual(["ada", "grace"])
  })

  test("dispatches one-way leaves, discarding the resolver's result", async () => {
    const received: string[] = []
    const router = createRouter(contract, {
      "math.add": ({ a, b }) => a + b,
      notify: ({ message }) => {
        received.push(message)
        return "discarded"
      },
    })

    await expect(router.dispatch("notify", { message: "hi" })).resolves.toBeUndefined()
    expect(received).toEqual(["hi"])
  })
})
