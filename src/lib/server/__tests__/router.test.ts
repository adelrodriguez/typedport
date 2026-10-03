import { describe, expect, test } from "vitest"
import * as z from "zod"
import { createClient } from "../../client/client"
import { defineContract, channel } from "../../core/contract"
import { ChannelError } from "../../core/error"
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

  test("rejects Object.prototype member names as unknown channels", async () => {
    const router = createRouter(contract, {
      "math.add": ({ a, b }) => a + b,
      notify: () => null,
    })

    const errors = await Promise.all(
      ["constructor", "__proto__", "toString", "hasOwnProperty"].map((path) =>
        router.dispatch(path, {}).catch((error: unknown) => error)
      )
    )

    for (const error of errors) {
      expect(error).toBeInstanceOf(ChannelError)
      expect((error as ChannelError).code).toBe("unknown-channel")
    }
  })

  test("throws at construction when a flat map misses a leaf", () => {
    expect(() =>
      createRouter(contract, {
        "math.add": ({ a, b }: { a: number; b: number }) => a + b,
      } as never)
    ).toThrow('Missing resolver for "notify"')
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
      "math.add": ({ a, b }, { context: session }) => {
        seen.push(session.userId)
        return a + b
      },
      notify: (_payload, { context: session }) => {
        seen.push(session.userId)
      },
    })

    await expect(
      router.dispatch("math.add", { a: 1, b: 2 }, { context: { userId: "ada" } })
    ).resolves.toBe(3)
    await router.dispatch("notify", { message: "hi" }, { context: { userId: "grace" } })

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

  test("gives every resolver a signal, even when the edge passes none", async () => {
    let seen: AbortSignal | undefined
    const router = createRouter(contract, {
      "math.add": ({ a, b }, { signal }) => {
        seen = signal
        return a + b
      },
      notify: () => null,
    })

    await router.dispatch("math.add", { a: 1, b: 2 })

    expect(seen).toBeInstanceOf(AbortSignal)
    expect(seen?.aborted).toBe(false)
  })

  test("aborting rejects with the reason even if the resolver ignores its signal", async () => {
    const controller = new AbortController()
    let resolverSignal: AbortSignal | undefined
    const router = createRouter(contract, {
      "math.add": (_input, { signal }) => {
        resolverSignal = signal
        return new Promise<number>(() => {
          // Never settles: only the abort can release the caller.
        })
      },
      notify: () => null,
    })

    const call = router.dispatch("math.add", { a: 1, b: 2 }, { signal: controller.signal })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort("gave up")

    await expect(call).rejects.toBe("gave up")
    expect(resolverSignal?.aborted).toBe(true)
  })

  test("does not run the resolver for an already-aborted signal", async () => {
    let called = false
    const router = createRouter(contract, {
      "math.add": ({ a, b }) => {
        called = true
        return a + b
      },
      notify: () => null,
    })

    await expect(
      router.dispatch("math.add", { a: 1, b: 2 }, { signal: AbortSignal.abort("early") })
    ).rejects.toBe("early")
    expect(called).toBe(false)
  })

  test("dispatch is a transport, so an in-memory client can cancel with $with", async () => {
    const router = createRouter(contract, {
      "math.add": (_input, { signal }) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("resolver stopped"))
          })
        }),
      notify: () => null,
    })
    const api = createClient(contract, router.dispatch)
    const controller = new AbortController()

    const call = api.$with({ signal: controller.signal }).math.add({ a: 1, b: 2 })
    setTimeout(() => {
      controller.abort("gave up")
    }, 0)

    await expect(call).rejects.toBe("gave up")
  })
})
