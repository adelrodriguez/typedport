import type { StandardSchemaV1 } from "@standard-schema/spec"
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

// A Standard Schema whose validation waits until released, to abort mid-parse.
function gatedSchema(): { schema: StandardSchemaV1<number, number>; release: () => void } {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  return {
    release: () => release?.(),
    schema: {
      "~standard": {
        validate: async (value) => {
          await gate
          return { value: value as number }
        },
        vendor: "test",
        version: 1,
      },
    },
  }
}

// Collects unhandled rejections for the duration of a test.
function watchUnhandled(): { stop: () => unknown[] } {
  const seen: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason)
  }

  process.on("unhandledRejection", onUnhandled)

  return {
    stop: () => {
      process.off("unhandledRejection", onUnhandled)
      return seen
    },
  }
}

async function settleTimers(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 10)
  })
}

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

  describe("cancellation covers the whole pipeline", () => {
    test("releases the caller while async input parsing is pending, without running the resolver", async () => {
      const { release, schema } = gatedSchema()
      const gated = defineContract({ add: channel({ input: schema, output: z.number() }) })
      let called = false
      const router = createRouter(gated, {
        add: (n) => {
          called = true
          return n
        },
      })
      const controller = new AbortController()

      const call = router.dispatch("add", 1, { signal: controller.signal })
      controller.abort("stop")

      await expect(call).rejects.toBe("stop")
      release()
      await settleTimers()
      expect(called).toBe(false)
    })

    test("releases the caller while async output parsing is pending", async () => {
      const { release, schema } = gatedSchema()
      const gated = defineContract({ add: channel({ input: z.number(), output: schema }) })
      let resolverRan: (() => void) | undefined
      const ran = new Promise<void>((resolve) => {
        resolverRan = resolve
      })
      const router = createRouter(gated, {
        add: (n) => {
          resolverRan?.()
          return n
        },
      })
      const controller = new AbortController()

      const call = router.dispatch("add", 5, { signal: controller.signal })
      await ran
      controller.abort("stop")

      await expect(call).rejects.toBe("stop")
      release()
    })

    test.each([
      // The reviewer's case: abort (say, via the session's close()) then throwIfAborted.
      [
        "throws",
        (signal: AbortSignal): number => {
          signal.throwIfAborted()
          return 3
        },
      ],
      ["returns", (): number => 3],
    ])(
      "a resolver that aborts synchronously then %s rejects with the reason, nothing unhandled",
      async (_name, finish) => {
        const watcher = watchUnhandled()
        const controller = new AbortController()
        const router = createRouter(contract, {
          "math.add": (_input, { signal }) => {
            controller.abort("closed by resolver")
            return finish(signal)
          },
          notify: () => null,
        })

        await expect(
          router.dispatch("math.add", { a: 1, b: 2 }, { signal: controller.signal })
        ).rejects.toBe("closed by resolver")
        await settleTimers()

        expect(watcher.stop()).toEqual([])
      }
    )
  })
})
