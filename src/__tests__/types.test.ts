// Type assertions are enforced by `pnpm run typecheck`, not Vitest.
import { describe, test } from "vitest"
import * as z from "zod"
import type { Wire } from "../lib/wire/types"
import {
  channel,
  createRouter,
  defineContract,
  type DispatchOptions,
  implement,
  mergeRouters,
  type Router,
  type Transport,
} from "../index"
import { connect } from "../wire"

// ── Helpers ──────────────────────────────────────────────────────────────────
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

type Expect<T extends true> = T

// ── Test fixtures ────────────────────────────────────────────────────────────
type Sender = { sender: string }
type User = { userId: number }
type Session = { kind: "guest" } | { kind: "user"; userId: string }

const filesContract = defineContract({
  files: { read: channel({ input: z.string(), output: z.string() }) },
})
const pingContract = defineContract({ ping: channel({ input: z.string(), output: z.string() }) })
const meContract = defineContract({ me: channel({ input: z.number(), output: z.number() }) })
const sessionContract = defineContract({
  session: channel({ input: z.string(), output: z.string() }),
})

// One router per way of declaring a context: a handler tree, a flat map with none, and flat maps
// with an object, a union, and `unknown`.
const filesRouter = createRouter(filesContract, {
  files: {
    read: implement(filesContract)
      .$context<Sender>()
      .files.read((path, { context }) => `${context.sender}:${path}`),
  },
})
const pingRouter = createRouter(pingContract, { ping: (name) => name })
const meRouter = createRouter<typeof meContract, User>(meContract, {
  me: (offset, { context }) => context.userId + offset,
})
const sessionRouter = createRouter<typeof sessionContract, Session>(sessionContract, {
  session: (_input, { context }) => context.kind,
})
const unknownRouter = createRouter<typeof pingContract, unknown>(pingContract, {
  ping: (name) => name,
})

// ── Positive type-level tests ────────────────────────────────────────────────
describe("mergeRouters", () => {
  test("intersects the contexts of separate routers", () => {
    const router = mergeRouters(filesRouter, pingRouter, meRouter)

    type _Merged = Expect<Equal<typeof router, Router<Sender & User>>>
    type _Options = Expect<
      Equal<Parameters<typeof router.dispatch>[2], DispatchOptions<Sender & User>>
    >
  })

  test("merges the same contexts in any order", () => {
    const forward = mergeRouters(filesRouter, meRouter)
    const backward = mergeRouters(meRouter, filesRouter)

    type _Order = Expect<Equal<typeof forward, typeof backward>>
  })

  test("keeps a single router's context as it was", () => {
    type _Object = Expect<Equal<ReturnType<typeof mergeRouters<[typeof meRouter]>>, Router<User>>>
    type _Union = Expect<
      Equal<ReturnType<typeof mergeRouters<[typeof sessionRouter]>>, Router<Session>>
    >
    type _Unknown = Expect<
      Equal<ReturnType<typeof mergeRouters<[typeof unknownRouter]>>, Router<unknown>>
    >
  })

  test("keeps a union context whole beside other routers", () => {
    const router = mergeRouters(sessionRouter, pingRouter)

    type _Union = Expect<Equal<typeof router, Router<Session>>>
  })

  test("does not let an unknown context absorb required ones", () => {
    const router = mergeRouters(meRouter, unknownRouter)

    type _Required = Expect<Equal<typeof router, Router<User>>>
  })

  test("is context-free when no router has a context", () => {
    const router = mergeRouters(pingRouter)
    const empty = mergeRouters()

    // `Router` defaults its context to `void`, the no-context sentinel.
    type _Void = Expect<Equal<typeof router, Router>>
    type _Empty = Expect<Equal<typeof empty, Router>>
    type _Transport = Expect<typeof router.dispatch extends Transport ? true : false>
    type _EmptyTransport = Expect<typeof empty.dispatch extends Transport ? true : false>
  })

  test("nests", () => {
    const router = mergeRouters(mergeRouters(filesRouter, pingRouter), meRouter)

    type _Nested = Expect<Equal<typeof router, Router<Sender & User>>>
  })

  test("merges arrays of unknown length", () => {
    const routers: Array<typeof meRouter> = [meRouter]
    const mixed: Array<typeof meRouter | typeof filesRouter> = [meRouter, filesRouter]
    const spread = mergeRouters(...routers)
    const trailing = mergeRouters(...routers, filesRouter)
    const leading = mergeRouters(filesRouter, ...routers)
    const union = mergeRouters(...mixed)

    type _Spread = Expect<Equal<typeof spread, Router<User>>>
    type _Trailing = Expect<Equal<typeof trailing, Router<User & Sender>>>
    type _Leading = Expect<Equal<typeof leading, Router<Sender & User>>>
    type _Union = Expect<Equal<typeof union, Router<User & Sender>>>
  })

  test("serves through connect with the merged context", () => {
    const wire: Wire = { onMessage: () => () => null, send: () => null }
    const router = mergeRouters(filesRouter, meRouter)

    void connect(wire, { context: { sender: "main", userId: 1 }, router })
  })
})

// ── Negative type tests ──────────────────────────────────────────────────────
// These verify that invalid usage produces compile-time errors.
// The function bodies never execute — only the type checker matters.

async function _negativeTypeTests(wire: Wire): Promise<void> {
  const merged = mergeRouters(filesRouter, pingRouter, meRouter)

  // @ts-expect-error -- the merged router needs a context
  await merged.dispatch("ping", "ada")

  // @ts-expect-error -- `userId` is required by meRouter
  await merged.dispatch("ping", "ada", { context: { sender: "main" } })

  // @ts-expect-error -- `userId` must be a number
  await merged.dispatch("ping", "ada", { context: { sender: "main", userId: "1" } })

  const session = mergeRouters(sessionRouter, pingRouter)

  // @ts-expect-error -- the union context is still required
  await session.dispatch("session", "hi")

  // @ts-expect-error -- "admin" is not a member of the union context
  await session.dispatch("session", "hi", { context: { kind: "admin" } })

  const withUnknown = mergeRouters(meRouter, unknownRouter)

  // @ts-expect-error -- an unknown context does not make `userId` optional
  await withUnknown.dispatch("me", 1, { context: {} })

  const free = mergeRouters(pingRouter)

  // @ts-expect-error -- a context-free merged router takes no context
  await free.dispatch("ping", "ada", { context: { sender: "main" } })

  // @ts-expect-error -- a router that needs a context is not a Transport
  const _transport: Transport = merged.dispatch

  // @ts-expect-error -- connect needs every router's context
  connect(wire, { context: { sender: "main" }, router: mergeRouters(filesRouter, meRouter) })

  // @ts-expect-error -- only routers can be merged
  mergeRouters({ channels: ["ping"] })
}

void _negativeTypeTests
