/* oxlint-disable await-thenable, no-confusing-void-expression -- bun:test types async matchers like `.rejects.toThrow()` as void, but they must be awaited for the assertion to complete */
import { describe, expect, test } from "bun:test"
import * as z from "zod"
import { defineContract, event, procedure } from "../lib/contract"
import { createRouter } from "../lib/router"

const contract = defineContract({
  math: {
    add: procedure({
      input: z.object({ a: z.number(), b: z.number().default(1) }),
      output: z.number(),
    }),
  },
  notify: event(z.object({ message: z.string() })),
})

describe("createRouter", () => {
  test("lists every channel", () => {
    const router = createRouter(contract, {
      "math.add": ({ a, b }) => Promise.resolve(a + b),
      notify: () => Promise.resolve(),
    })

    expect(router.channels.toSorted()).toEqual(["math.add", "notify"])
  })

  test("parses input before the handler runs, applying defaults", async () => {
    const router = createRouter(contract, {
      "math.add": ({ a, b }) => Promise.resolve(a + b),
      notify: () => Promise.resolve(),
    })

    await expect(router.dispatch("math.add", { a: 2 })).resolves.toBe(3)
  })

  test("rejects invalid input without calling the handler", async () => {
    let called = false
    const router = createRouter(contract, {
      "math.add": ({ a, b }) => {
        called = true
        return Promise.resolve(a + b)
      },
      notify: () => Promise.resolve(),
    })

    await expect(router.dispatch("math.add", { a: "two" })).rejects.toThrow()
    expect(called).toBe(false)
  })

  test("rejects unknown channels", async () => {
    const router = createRouter(contract, {
      "math.add": ({ a, b }) => Promise.resolve(a + b),
      notify: () => Promise.resolve(),
    })

    await expect(router.dispatch("math.subtract", {})).rejects.toThrow(
      'Unknown channel: "math.subtract"'
    )
  })

  test("rejects handler results that drift off contract", async () => {
    const router = createRouter(contract, {
      "math.add": () => Promise.resolve("not a number" as unknown as number),
      notify: () => Promise.resolve(),
    })

    await expect(router.dispatch("math.add", { a: 1, b: 2 })).rejects.toThrow()
  })

  test("dispatches events and resolves with undefined", async () => {
    const received: string[] = []
    const router = createRouter(contract, {
      "math.add": ({ a, b }) => Promise.resolve(a + b),
      notify: ({ message }) => {
        received.push(message)
        return Promise.resolve()
      },
    })

    await expect(router.dispatch("notify", { message: "hi" })).resolves.toBeUndefined()
    expect(received).toEqual(["hi"])
  })
})
