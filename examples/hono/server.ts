/* oxlint-disable no-console -- runnable example */
// One Hono route serves the entire contract. No per-route validators: the
// router parses input before any resolver runs and parses results on the way
// back. toWire never throws, so every outcome maps to a status code.
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import type * as z from "zod"
import { createRouter } from "../../src/index.ts"
import { toWire } from "../../src/wire.ts"
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

app.post("/rpc/:path", async (c) => {
  // Dotted paths have no slashes, so each one is a single URL segment.
  const path = c.req.param("path")

  if (!router.channels.includes(path)) {
    return c.text("Unknown channel", 404)
  }

  // JSON has no undefined, so the client sends null for void inputs; map it
  // back so z.void() leaves round-trip.
  const body = (await c.req.json()) as unknown
  const wire = await toWire(router.dispatch(path, body ?? undefined))

  if (wire.ok) {
    return c.json(wire, 200)
  }

  return c.json(wire, wire.error.issues ? 400 : 500)
})

serve({ fetch: app.fetch, port: 4322 }, (info) => {
  console.log(`listening on http://localhost:${info.port}`)
})
