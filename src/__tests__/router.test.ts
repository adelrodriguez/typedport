import { describe, expect, test } from "vitest"
import * as z from "zod"
import { defineContract, event } from "../lib/contract"
import { createRouter } from "../lib/router"

const contract = defineContract({
  math: {
    add: event({
      input: z.object({ a: z.number(), b: z.number().default(1) }),
      output: z.number(),
    }),
  },
  notify: event(z.object({ message: z.string() })),
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

  test("rejects resolver results that drift off contract", async () => {
    const router = createRouter(contract, {
      "math.add": () => "not a number" as unknown as number,
      notify: () => null,
    })

    await expect(router.dispatch("math.add", { a: 1, b: 2 })).rejects.toThrow()
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
