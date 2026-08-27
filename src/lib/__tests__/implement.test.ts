import { describe, expect, test } from "vitest"
import * as z from "zod"
import { defineContract, channel } from "../contract"
import { implement, isFragment, type FragmentTree } from "../implement"
import { createRouter } from "../router"

const contract = defineContract({
  notes: {
    open: channel({
      input: z.object({ path: z.string() }),
      output: z.object({ contents: z.string(), path: z.string() }).nullable(),
    }),
    save: channel(z.object({ contents: z.string(), path: z.string() })),
  },
  ping: channel(z.void()),
})

type Session = { userId: string }

describe("implement", () => {
  test("leaves produce fragments carrying their dotted path", () => {
    const tp = implement(contract)
    const open = tp.notes.open(() => null)

    expect(isFragment(open)).toBe(true)
    expect(open.$path).toBe("notes.open")
    expect(tp.ping(() => null).$path).toBe("ping")
  })

  test("$context is a type-level rebind with no runtime effect", () => {
    const tp = implement(contract).$context<Session>()

    expect(tp.notes.save(() => null).$path).toBe("notes.save")
  })
})

describe("createRouter with a handler tree", () => {
  const tp = implement(contract).$context<Session>()

  const open = tp.notes.open(({ path }, session) => ({
    contents: `${session.userId}:${path}`,
    path,
  }))
  const save = tp.notes.save(() => null)
  const ping = tp.ping(() => null)

  test("dispatches through fragments, passing parsed input and context", async () => {
    const router = createRouter(contract, { notes: { open, save }, ping })

    await expect(
      router.dispatch("notes.open", { path: "/a.md" }, { userId: "u1" })
    ).resolves.toEqual({ contents: "u1:/a.md", path: "/a.md" })
  })

  test("lists every channel, same as the flat form", () => {
    const router = createRouter(contract, { notes: { open, save }, ping })

    expect(router.channels.toSorted()).toEqual(["notes.open", "notes.save", "ping"])
  })

  test("ignores stray extra exports in a handler branch", async () => {
    // A namespace import may carry helpers alongside its fragments.
    const branch = { helper: { unrelated: true }, open, save }
    const router = createRouter(contract, { notes: branch, ping })

    await expect(
      router.dispatch("notes.open", { path: "/a.md" }, { userId: "u1" })
    ).resolves.toEqual({ contents: "u1:/a.md", path: "/a.md" })
  })

  // The casts below fabricate what the type system prevents, to prove the runtime guards hold.
  type Handlers = FragmentTree<typeof contract, Session>

  test("throws at assembly when a handler is missing", () => {
    expect(() => createRouter(contract, { notes: { open, save } } as unknown as Handlers)).toThrow(
      'Missing handler for "ping"'
    )
  })

  test("throws at assembly when a fragment sits in the wrong slot", () => {
    expect(() =>
      createRouter(contract, { notes: { open: save, save }, ping } as unknown as Handlers)
    ).toThrow('Handler for "notes.save" placed at "notes.open"')
  })
})

// ---- type-level assertions (checked by tsc, never executed) ---------------------------------

// oxlint-disable-next-line no-unused-vars -- exists to be typechecked, not run
function typeAssertions(): void {
  const tp = implement(contract).$context<Session>()
  const open = tp.notes.open(() => null)
  const save = tp.notes.save(() => null)
  const ping = tp.ping(() => null)
  const notes = { open, save }

  const router = createRouter(contract, { notes, ping })

  // Context was inferred from the fragments: dispatch demands it.
  void router.dispatch("notes.open", { path: "x" }, { userId: "u" })
  // @ts-expect-error context is required
  void router.dispatch("notes.open", { path: "x" })

  // @ts-expect-error missing handler for "ping"
  void createRouter(contract, { notes })

  // @ts-expect-error the `save` fragment cannot occupy the `open` slot
  void createRouter(contract, { notes: { open: save, save }, ping })

  // @ts-expect-error a resolver drifting off the output schema fails at the definition site
  void tp.notes.open(() => ({ nope: true }))

  const foreign = implement(defineContract({ misc: channel(z.string()) })).misc(() => null)
  // @ts-expect-error a fragment from another contract cannot occupy a slot
  void createRouter(contract, { notes, ping: foreign })

  const noContext = implement(contract).ping(() => null)
  // @ts-expect-error fragment contexts must agree
  void createRouter(contract, { notes, ping: noContext })
}
