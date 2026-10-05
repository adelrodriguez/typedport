import type { StandardSchemaV1 } from "@standard-schema/spec"
import { describe, expect, expectTypeOf, test } from "vitest"
import * as z from "zod"
import { createClient } from "../../client/client"
import { defineContract, channel } from "../../core/contract"
import { ChannelError } from "../../core/error"
import { SetupError } from "../../core/setup-error"
import { implement } from "../implement"
import { createRouter, type DispatchOptions, mergeRouters, type Router } from "../router"

const contract = defineContract({
  math: {
    add: channel({
      input: z.object({ a: z.number(), b: z.number().default(1) }),
      output: z.number(),
    }),
  },
  notify: channel(z.object({ message: z.string() })),
})

// A Standard Schema whose validation waits until released, to abort mid-parse. `entered` resolves
// once validation has actually started.
function gatedSchema(): {
  entered: Promise<void>
  release: () => void
  schema: StandardSchemaV1<number, number>
} {
  let release: (() => void) | undefined
  let enter: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })

  return {
    entered,
    release: () => release?.(),
    schema: {
      "~standard": {
        validate: async (value) => {
          enter?.()
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

  test("accepts a context type that references itself", async () => {
    // Electron's `WebContents` is one such type (`hostWebContents: WebContents`).
    type TreeNode = { children: TreeNode[]; parent: TreeNode | null }
    const root: TreeNode = { children: [], parent: null }
    const router = createRouter<typeof contract, { node: TreeNode }>(contract, {
      "math.add": ({ a, b }, { context: { node } }) => a + b + node.children.length,
      notify: () => null,
    })

    await expect(
      router.dispatch("math.add", { a: 1, b: 2 }, { context: { node: root } })
    ).resolves.toBe(3)
  })

  test("$context fixes the context once while inferring each contract", async () => {
    type Session = { userId: string }
    const createSessionRouter = createRouter.$context<Session>()
    const session: Session = { userId: "ada" }
    const controller = new AbortController()
    const router = createSessionRouter(contract, {
      "math.add": (input, { context, signal }) => {
        expectTypeOf(input).toEqualTypeOf<{ a: number; b: number }>()
        expectTypeOf(context).toEqualTypeOf<Session>()
        expectTypeOf(signal).toEqualTypeOf<AbortSignal>()
        expect(context).toBe(session)
        expect(signal).toBe(controller.signal)
        return input.a + input.b
      },
      notify: ({ message }, { context }) => {
        expectTypeOf(message).toEqualTypeOf<string>()
        expectTypeOf(context).toEqualTypeOf<Session>()
        expect(context).toBe(session)
        return "discarded"
      },
    })
    const otherContract = defineContract({
      user: { name: channel({ input: z.void(), output: z.string() }) },
    })
    const otherRouter = createSessionRouter(otherContract, {
      "user.name": (input, { context }) => {
        expectTypeOf(input).toBeVoid()
        expectTypeOf(context).toEqualTypeOf<Session>()
        return context.userId
      },
    })

    expect(createSessionRouter).toBe(createRouter)
    expectTypeOf(router).toEqualTypeOf<Router<Session>>()
    expectTypeOf(otherRouter).toEqualTypeOf<Router<Session>>()
    expect(router.channels.toSorted()).toEqual(["math.add", "notify"])
    await expect(
      router.dispatch("math.add", { a: 2 }, { context: session, signal: controller.signal })
    ).resolves.toBe(3)
    await expect(
      router.dispatch("notify", { message: "hi" }, { context: session })
    ).resolves.toBeUndefined()
    await expect(otherRouter.dispatch("user.name", undefined, { context: session })).resolves.toBe(
      "ada"
    )
  })

  test("$context accepts a context type that references itself", async () => {
    type TreeNode = { children: TreeNode[]; parent: TreeNode | null }
    const createTreeRouter = createRouter.$context<{ node: TreeNode }>()
    const router = createTreeRouter(contract, {
      "math.add": ({ a, b }, { context: { node } }) => a + b + node.children.length,
      notify: () => null,
    })

    await expect(
      router.dispatch("math.add", { a: 1 }, { context: { node: { children: [], parent: null } } })
    ).resolves.toBe(2)
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
      const { entered, release, schema } = gatedSchema()
      const gated = defineContract({ add: channel({ input: z.number(), output: schema }) })
      const router = createRouter(gated, { add: (n) => n })
      const controller = new AbortController()

      const call = router.dispatch("add", 5, { signal: controller.signal })
      // Abort strictly mid-validation, so only a race that spans output parsing can pass.
      await entered
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

// oxlint-disable-next-line no-unused-vars -- exists to be typechecked, not run
function typeAssertions(): void {
  const createSessionRouter = createRouter.$context<{ userId: string }>()
  const resolvers = {
    "math.add": ({ a, b }: { a: number; b: number }) => a + b,
    notify: () => null,
  }
  const router = createSessionRouter(contract, resolvers)

  void router.dispatch("math.add", { a: 1 }, { context: { userId: "ada" } })
  // @ts-expect-error context is required
  void router.dispatch("math.add", { a: 1 })
  // @ts-expect-error a signal alone does not supply the context
  void router.dispatch("math.add", { a: 1 }, { signal: new AbortController().signal })
  // @ts-expect-error the dispatch context must match the fixed type
  void router.dispatch("math.add", { a: 1 }, { context: { userId: 1 } })
  // @ts-expect-error missing resolver for "notify"
  void createSessionRouter(contract, { "math.add": resolvers["math.add"] })
  // @ts-expect-error a round-trip resolver must return the output schema's input type
  void createSessionRouter(contract, { ...resolvers, "math.add": () => "wrong" })
  // @ts-expect-error the resolver input must match the parsed schema type
  void createSessionRouter(contract, { ...resolvers, "math.add": (input: string) => input.length })

  // oxlint-disable-next-line no-invalid-void-type -- void is the no-context sentinel
  const createNoContextRouter = createRouter.$context<void>()
  const noContextRouter = createNoContextRouter(contract, {
    "math.add": ({ a, b }, { context }) => {
      expectTypeOf(context).toBeVoid()
      return a + b
    },
    notify: () => null,
  })
  expectTypeOf(noContextRouter).toEqualTypeOf<Router>()
  void noContextRouter.dispatch("math.add", { a: 1 })
  void noContextRouter.dispatch("math.add", { a: 1 }, { signal: new AbortController().signal })
}

describe("mergeRouters", () => {
  const filesContract = defineContract({
    files: { read: channel({ input: z.string(), output: z.string() }) },
  })
  const pingContract = defineContract({ ping: channel({ input: z.string(), output: z.string() }) })
  const meContract = defineContract({ me: channel({ input: z.number(), output: z.number() }) })

  // One router per context shape: a handler tree, a context-free map, and a map with a context.
  const filesRouter = createRouter(filesContract, {
    files: {
      read: implement(filesContract)
        .$context<{ sender: string }>()
        .files.read((path, { context }) => `${context.sender}:${path}`),
    },
  })
  const pingRouter = createRouter(pingContract, { ping: (name) => `pong ${name}` })
  const meRouter = createRouter<typeof meContract, { userId: number }>(meContract, {
    me: (offset, { context }) => context.userId + offset,
  })

  test("lists every router's channels", () => {
    const router = mergeRouters(filesRouter, pingRouter, meRouter)

    expect(router.channels.toSorted()).toEqual(["files.read", "me", "ping"])
  })

  test("dispatches to the router that owns the path, passing the context through", async () => {
    const router = mergeRouters(filesRouter, pingRouter, meRouter)
    const context = { sender: "main", userId: 7 }

    await expect(router.dispatch("files.read", "a.txt", { context })).resolves.toBe("main:a.txt")
    await expect(router.dispatch("ping", "ada", { context })).resolves.toBe("pong ada")
    await expect(router.dispatch("me", 1, { context })).resolves.toBe(8)
  })

  test("leaves parsing to the owning router", async () => {
    const router = mergeRouters(filesRouter, pingRouter)

    await expect(
      router.dispatch("files.read", 42, { context: { sender: "main" } })
    ).rejects.toMatchObject({ code: "validation" })
  })

  test("throws duplicate-channel when two routers declare the same path", () => {
    const other = createRouter(pingContract, { ping: (name) => name })

    expect(() => mergeRouters(pingRouter, other)).toThrow(
      expect.objectContaining({ code: "duplicate-channel", path: "ping" })
    )
    expect(() => mergeRouters(pingRouter, other)).toThrow(SetupError)
  })

  test("rejects paths no router owns, prototype members included", async () => {
    const router = mergeRouters(pingRouter)

    for (const path of ["missing", "constructor", "__proto__"]) {
      // oxlint-disable-next-line no-await-in-loop -- each rejection is asserted in turn
      await expect(router.dispatch(path, null)).rejects.toMatchObject({
        code: "unknown-channel",
        path,
      })
    }

    await expect(router.dispatch("missing", null)).rejects.toBeInstanceOf(ChannelError)
  })

  test("rejects with an aborted signal's reason before looking up the path", async () => {
    const router = mergeRouters(pingRouter)
    const reason = new Error("gave up")

    await expect(
      router.dispatch("missing", null, { signal: AbortSignal.abort(reason) })
    ).rejects.toBe(reason)
  })

  test("passes the signal to the owning router", async () => {
    const seen: AbortSignal[] = []
    const watching = createRouter(pingContract, {
      ping: (name, { signal }) => {
        seen.push(signal)
        return name
      },
    })
    const controller = new AbortController()

    await mergeRouters(watching).dispatch("ping", "ada", { signal: controller.signal })

    expect(seen).toEqual([controller.signal])
  })

  test("nests", async () => {
    const router = mergeRouters(mergeRouters(filesRouter, pingRouter), meRouter)

    expect(router.channels.toSorted()).toEqual(["files.read", "me", "ping"])
    await expect(
      router.dispatch("me", 1, { context: { sender: "main", userId: 3 } })
    ).resolves.toBe(4)
    expect(() => mergeRouters(mergeRouters(pingRouter), pingRouter)).toThrow(
      expect.objectContaining({ code: "duplicate-channel" })
    )
  })

  test("passes the call's context to context-free routers too", async () => {
    const seen: unknown[] = []
    const freeRouter = createRouter(pingContract, {
      ping: (name, { context }) => {
        seen.push(context)
        return name
      },
    })
    const router = mergeRouters(freeRouter, meRouter)

    await router.dispatch("ping", "ada", { context: { userId: 7 } })

    expect(seen).toEqual([{ userId: 7 }])
  })

  test("passes a union context through whole", async () => {
    type Session = { kind: "guest" } | { kind: "user"; userId: string }
    const sessionContract = defineContract({
      session: channel({ input: z.string(), output: z.string() }),
    })
    const sessionRouter = createRouter<typeof sessionContract, Session>(sessionContract, {
      session: (_input, { context }) => context.kind,
    })
    const router = mergeRouters(sessionRouter, pingRouter)

    await expect(router.dispatch("session", "hi", { context: { kind: "guest" } })).resolves.toBe(
      "guest"
    )
  })

  test("calls a router's dispatch method on the router", async () => {
    class PrefixRouter {
      readonly channels = ["echo"]
      readonly prefix = "echo:"

      // oxlint-disable-next-line require-await -- `Router` requires dispatch to return a promise
      async dispatch(_path: string, raw: unknown, _options?: DispatchOptions): Promise<unknown> {
        return `${this.prefix}${String(raw)}`
      }
    }

    await expect(mergeRouters(new PrefixRouter()).dispatch("echo", "hi")).resolves.toBe("echo:hi")
  })

  test("serves a client when no router has a context", async () => {
    const router = mergeRouters(pingRouter)

    await expect(createClient(pingContract, router.dispatch).ping("ada")).resolves.toBe("pong ada")
  })
})
