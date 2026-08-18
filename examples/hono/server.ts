/* oxlint-disable no-console -- runnable example */
// One Hono route serves the entire contract. No per-route validators: the
// router parses input before any resolver runs and parses results on the way
// back. toWire never throws, so every outcome maps to a status code.
import type * as z from "zod"
import { serve } from "@hono/node-server"
import { type Context, Hono } from "hono"
import { createRouter } from "../../src/index.ts"
import { toWire, type WireResult } from "../../src/wire.ts"
import { contract, type Todo } from "./contract.ts"

const todos = new Map<string, z.infer<typeof Todo>>()

const router = createRouter(contract, {
  "telemetry.pageView": ({ route }) => {
    console.log(`pageview: ${route}`)
  },
  "todos.create": ({ title }) => {
    const todo = { done: false, id: crypto.randomUUID(), title }
    todos.set(todo.id, todo)
    return todo
  },
  "todos.list": () => [...todos.values()],
  "todos.toggle": ({ id }) => {
    const todo = todos.get(id)

    if (!todo) {
      throw new Error(`No todo "${id}"`)
    }

    todo.done = !todo.done
    return todo
  },
})

const app = new Hono()

// Edge concerns (auth, logging, rate limits) go here as ordinary middleware:
// app.use("/rpc/*", authMiddleware)

// Every response this route family produces — success or failure, any door —
// is a WireResult envelope, so the client's unconditional fromWire always has
// something it can read.
const fail = (c: Context, message: string, status: 400 | 404 | 405 | 500) =>
  c.json({ error: { message, name: "Error" }, ok: false } satisfies WireResult, status)

// JSON has no undefined, so the client sends null for void inputs; map it
// back so z.void() leaves round-trip. The router neither knows nor cares
// which HTTP door a call came through.
const respond = async (c: Context, path: string, input: unknown) => {
  if (!router.channels.includes(path)) {
    // Fixed strings only: echoing the untrusted path back is a habit that
    // turns unsafe the day a response is rendered as HTML.
    return fail(c, "Unknown channel", 404)
  }

  const wire = await toWire(router.dispatch(path, input ?? undefined))

  if (wire.ok) {
    return c.json(wire, 200)
  }

  if (wire.error.detail) {
    return c.json(wire, wire.error.detail.code === "validation" ? 400 : 500)
  }

  // A failure without detail came from application code — a database error, a
  // filesystem error. Its message is for the server's logs, not for an
  // untrusted caller.
  console.error(`resolver failed for "${path}":`, wire.error)
  return fail(c, "Internal server error", 500)
}

// Dotted paths have no slashes, so each one is a single URL segment.
app.post("/rpc/:path", async (c) => {
  let input: unknown

  try {
    input = await c.req.json()
  } catch {
    return fail(c, "Malformed request body", 400)
  }

  return respond(c, c.req.param("path"), input)
})

// Reads may ride GET (cacheable, prefetchable); the input travels in the
// query string. GET is a door browsers and prefetchers treat as safe to
// repeat, so only allowlisted read paths go through it — everything else,
// including mutations, must knock on POST.
const reads = new Set<string>(["todos.list"])

// The allowlist is hand-written, so guard it at startup: a renamed channel
// should crash the boot, not silently turn a read into a 405.
for (const path of reads) {
  if (!router.channels.includes(path)) {
    throw new Error(`reads allowlist references unknown channel "${path}"`)
  }
}

app.get("/rpc/:path", async (c) => {
  const path = c.req.param("path")

  if (!reads.has(path)) {
    return fail(c, "Not a query; use POST", 405)
  }

  let input: unknown

  try {
    input = JSON.parse(c.req.query("input") ?? "null")
  } catch {
    return fail(c, "Malformed input query parameter", 400)
  }

  return respond(c, path, input)
})

serve({ fetch: app.fetch, port: 4322 }, (info) => {
  console.log(`listening on http://localhost:${info.port}`)
})
