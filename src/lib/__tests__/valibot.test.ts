import { MessageChannel } from "node:worker_threads"
import * as v from "valibot"
import { describe, expect, expectTypeOf, test } from "vitest"
import { nodePort } from "../adapters/message-port"
import { createClient } from "../client/client"
import { defineContract, channel } from "../core/contract"
import { ChannelError } from "../core/error"
import { implement } from "../server/implement"
import { createRouter } from "../server/router"
import { connect } from "../wire/connect"

const contract = defineContract({
  notes: {
    // Input and parsed types differ: `limit` is optional going in, always a number coming out.
    list: channel({
      input: v.object({ limit: v.optional(v.number(), 10), tag: v.string() }),
      output: v.array(v.string()),
    }),
    save: channel(v.object({ contents: v.pipe(v.string(), v.minLength(1)), path: v.string() })),
  },
  parse: channel({
    input: v.pipe(v.string(), v.transform(Number)),
    output: v.number(),
  }),
})

const tp = implement(contract)

const router = createRouter(contract, {
  notes: {
    list: tp.notes.list(({ input: { limit, tag } }) =>
      Array.from({ length: limit }, (_, i) => `${tag}-${i}`)
    ),
    save: tp.notes.save(() => null),
  },
  parse: tp.parse(({ input: value }) => value * 2),
})

describe("valibot schemas", () => {
  test("client and resolvers see the schema's input and output types", () => {
    const client = createClient(contract, router.dispatch)

    expectTypeOf(client.notes.list).parameter(0).toEqualTypeOf<{ limit?: number; tag: string }>()
    expectTypeOf(client.notes.list).returns.resolves.toEqualTypeOf<string[]>()
    expectTypeOf(client.parse).parameter(0).toEqualTypeOf<string>()

    tp.notes.list(({ input }) => {
      expectTypeOf(input).toEqualTypeOf<{ limit: number; tag: string }>()
      return []
    })
    tp.parse(({ input }) => {
      expectTypeOf(input).toEqualTypeOf<number>()
      return input
    })
  })

  test("resolvers receive parsed input, with defaults and transforms applied", async () => {
    const client = createClient(contract, router.dispatch)

    await expect(client.notes.list({ tag: "a" })).resolves.toHaveLength(10)
    await expect(client.notes.list({ limit: 2, tag: "a" })).resolves.toEqual(["a-0", "a-1"])
    await expect(client.parse("21")).resolves.toBe(42)
  })

  test("rejected input carries valibot's issues as a validation ChannelError", async () => {
    const error = await router
      .dispatch("notes.save", { contents: "", path: "/a" })
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ChannelError)
    expect(error).toMatchObject({
      code: "validation",
      issues: [{ path: [{ key: "contents" }], type: "min_length" }],
    })
  })

  test("off-contract resolver results fail as output-validation", async () => {
    const drifting = createRouter(contract, {
      notes: {
        // @ts-expect-error -- deliberately returns something the output schema rejects
        list: tp.notes.list(() => [1, 2]),
        save: tp.notes.save(() => null),
      },
      parse: tp.parse(({ input: value }) => value),
    })

    const error = await drifting
      .dispatch("notes.list", { tag: "a" })
      .catch((error: unknown) => error)

    expect(error).toMatchObject({ code: "output-validation" })
  })

  test("async pipes are awaited", async () => {
    const taken = new Set(["ada"])
    const signup = defineContract({
      register: channel({
        input: v.pipeAsync(
          v.string(),
          v.checkAsync(async (name) => {
            await Promise.resolve()
            return !taken.has(name)
          }, "name taken")
        ),
        output: v.string(),
      }),
    })
    const client = createClient(
      signup,
      createRouter(signup, { register: ({ input: name }) => `welcome ${name}` }).dispatch
    )

    await expect(client.register("grace")).resolves.toBe("welcome grace")
    await expect(client.register("ada")).rejects.toThrow("name taken")
  })

  test("issues survive a structured-clone boundary", async () => {
    const { port1, port2 } = new MessageChannel()
    const server = connect(nodePort(port1), { router })
    const caller = connect(nodePort(port2))
    const client = createClient(contract, caller.transport)

    try {
      // Bypasses client-side parsing so the router's rejection is what crosses the port.
      const error = await Promise.resolve(
        caller.transport("notes.save", { contents: "", path: "/a" })
      ).catch((error: unknown) => error)

      expect(error).toBeInstanceOf(ChannelError)
      expect(error).toMatchObject({ code: "validation", issues: [{ type: "min_length" }] })
      await expect(client.parse("4")).resolves.toBe(8)
    } finally {
      server.close()
      caller.close()
      port1.close()
    }
  })
})
