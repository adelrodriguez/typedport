// Compile-time checks only: `pnpm run typecheck` enforces this file, and Vitest never runs it.
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
// mergeRouters intersects the contexts of separate routers.
{
  const router = mergeRouters(filesRouter, pingRouter, meRouter)

  type _Merged = Expect<Equal<typeof router, Router<Sender & User>>>
  type _Options = Expect<
    Equal<Parameters<typeof router.dispatch>[2], DispatchOptions<Sender & User>>
  >
}

// mergeRouters merges the same contexts in any order.
{
  const forward = mergeRouters(filesRouter, meRouter)
  const backward = mergeRouters(meRouter, filesRouter)

  type _Order = Expect<Equal<typeof forward, typeof backward>>
}

// mergeRouters keeps a single router's context as it was.
type _SingleObject = Expect<Equal<ReturnType<typeof mergeRouters<[typeof meRouter]>>, Router<User>>>
type _SingleUnion = Expect<
  Equal<ReturnType<typeof mergeRouters<[typeof sessionRouter]>>, Router<Session>>
>
type _SingleUnknown = Expect<
  Equal<ReturnType<typeof mergeRouters<[typeof unknownRouter]>>, Router<unknown>>
>

// mergeRouters keeps a union context whole beside other routers.
{
  const router = mergeRouters(sessionRouter, pingRouter)

  type _Union = Expect<Equal<typeof router, Router<Session>>>
}

// mergeRouters does not let an unknown context absorb required ones.
{
  const router = mergeRouters(meRouter, unknownRouter)

  type _Required = Expect<Equal<typeof router, Router<User>>>
}

// mergeRouters is context-free when no router has a context.
{
  const router = mergeRouters(pingRouter)
  const empty = mergeRouters()

  // `Router` defaults its context to `void`, the no-context sentinel.
  type _Void = Expect<Equal<typeof router, Router>>
  type _Empty = Expect<Equal<typeof empty, Router>>
  type _Transport = Expect<typeof router.dispatch extends Transport ? true : false>
  type _EmptyTransport = Expect<typeof empty.dispatch extends Transport ? true : false>
}

// mergeRouters nests.
{
  const router = mergeRouters(mergeRouters(filesRouter, pingRouter), meRouter)

  type _Nested = Expect<Equal<typeof router, Router<Sender & User>>>
}

// mergeRouters merges arrays of unknown length.
{
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
}

// mergeRouters needs every member's context for a union-typed router argument.
{
  const either = Math.random() > 0.5 ? filesRouter : meRouter
  const routers: Array<typeof pingRouter> = [pingRouter]
  const alone = mergeRouters(either)
  const leading = mergeRouters(either, ...routers)
  const trailing = mergeRouters(...routers, either)

  type _Alone = Expect<Equal<typeof alone, Router<Sender & User>>>
  type _Leading = Expect<Equal<typeof leading, Router<Sender & User>>>
  type _Trailing = Expect<Equal<typeof trailing, Router<Sender & User>>>
}

// mergeRouters merges routers built with a context-fixed `createRouter.$context` factory.
{
  const createSenderRouter = createRouter.$context<Sender>()
  const createUserRouter = createRouter.$context<User>()
  const router = mergeRouters(
    createSenderRouter(pingContract, { ping: (name, { context }) => `${context.sender}:${name}` }),
    createUserRouter(meContract, { me: (offset, { context }) => context.userId + offset })
  )

  type _Factories = Expect<Equal<typeof router, Router<Sender & User>>>
}

// mergeRouters serves through connect with the merged context.
{
  const wire: Wire = { onMessage: () => () => null, send: () => null }
  const router = mergeRouters(filesRouter, meRouter)

  void connect(wire, { context: { sender: "main", userId: 1 }, router })
}

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

  const userRouter = createRouter<typeof meContract, { kind: "user" }>(meContract, {
    me: (offset) => offset,
  })
  const guestRouter = createRouter<typeof pingContract, { kind: "guest" }>(pingContract, {
    ping: (name) => name,
  })
  const incompatible = mergeRouters(userRouter, guestRouter)

  // @ts-expect-error -- incompatible contexts must not make dispatch context-free
  await incompatible.dispatch("me", 1)

  // @ts-expect-error -- no context satisfies both `{ kind: "user" }` and `{ kind: "guest" }`
  await incompatible.dispatch("me", 1, { context: { kind: "user" } })

  // @ts-expect-error -- incompatible contexts do not make a Transport
  const _incompatibleTransport: Transport = incompatible.dispatch

  const either = Math.random() > 0.5 ? filesRouter : meRouter
  const fromUnion = mergeRouters(either)
  const routers: Array<typeof pingRouter> = [pingRouter]
  const afterSpread = mergeRouters(...routers, either)

  // @ts-expect-error -- a union-typed router argument needs a context for every member
  await fromUnion.dispatch("me", 1, { context: { sender: "main" } })

  // @ts-expect-error -- the same holds for a fixed argument after a spread
  await afterSpread.dispatch("me", 1, { context: { userId: 1 } })

  const userLiteral = createRouter<typeof pingContract, "user">(pingContract, {
    ping: (name, { context }) => `${context}:${name}`,
  })
  const guestLiteral = createRouter<typeof pingContract, "guest">(pingContract, {
    ping: (name, { context }) => `${context}:${name}`,
  })
  const literalChoice = Math.random() > 0.5 ? userLiteral : guestLiteral
  const literalRouters: Array<typeof pingRouter> = [pingRouter]

  const literalAlone = mergeRouters(literalChoice)

  // @ts-expect-error -- incompatible literal contexts (alone) must not make dispatch context-free
  await literalAlone.dispatch("ping", "ada")

  // @ts-expect-error -- incompatible literal contexts (alone) do not make a Transport
  const _literalAloneTransport: Transport = literalAlone.dispatch

  const literalLeading = mergeRouters(literalChoice, ...literalRouters)

  // @ts-expect-error -- incompatible literal contexts (before a spread) must not make dispatch context-free
  await literalLeading.dispatch("ping", "ada")

  // @ts-expect-error -- incompatible literal contexts (before a spread) do not make a Transport
  const _literalLeadingTransport: Transport = literalLeading.dispatch

  const literalTrailing = mergeRouters(...literalRouters, literalChoice)

  // @ts-expect-error -- incompatible literal contexts (after a spread) must not make dispatch context-free
  await literalTrailing.dispatch("ping", "ada")

  // @ts-expect-error -- incompatible literal contexts (after a spread) do not make a Transport
  const _literalTrailingTransport: Transport = literalTrailing.dispatch

  const literalNested = mergeRouters(mergeRouters(literalChoice))

  // @ts-expect-error -- incompatible literal contexts (nested) must not make dispatch context-free
  await literalNested.dispatch("ping", "ada")

  // @ts-expect-error -- incompatible literal contexts (nested) do not make a Transport
  const _literalNestedTransport: Transport = literalNested.dispatch

  // @ts-expect-error -- a router that needs a context is not a Transport
  const _transport: Transport = merged.dispatch

  // @ts-expect-error -- connect needs every router's context
  connect(wire, { context: { sender: "main" }, router: mergeRouters(filesRouter, meRouter) })

  // @ts-expect-error -- only routers can be merged
  mergeRouters({ channels: ["ping"] })
}

void _negativeTypeTests
