/* oxlint-disable no-console -- runnable example */
// The consumer: QStash calls back into these routes. Messages go through one
// route that verifies the signature and dispatches; workflows go through
// Upstash Workflow's serve, with the WorkflowContext passed to resolvers as
// their `context`.
import { serve } from "@hono/node-server"
import { Receiver } from "@upstash/qstash"
import { serve as serveWorkflow, type WorkflowContext } from "@upstash/workflow"
import { Hono } from "hono"
import { ChannelError, createRouter } from "../../src/index.ts"
import { messages, workflows } from "./contract.ts"
import { env } from "./env.ts"

const messageRouter = createRouter(messages, {
  "email.welcome": ({ email }) => {
    console.log(`welcome email sent to ${email}`)
  },
  "stripe.checkout.created": ({ amount, id }) => {
    console.log(`checkout ${id} created for $${(amount / 100).toFixed(2)}`)
  },
})

// Workflow resolvers are re-entered once per step; context.run memoizes each
// completed step, so the body reads top to bottom like ordinary code.
const workflowRouter = createRouter<typeof workflows, WorkflowContext>(workflows, {
  "reports.generate": async ({ reportId }, { context }) => {
    const rows = await context.run("query", () => 3)
    await context.sleep("cool-down", 1)
    await context.run("render", () => {
      console.log(`report ${reportId} ready with ${rows} rows`)
    })
  },
})

const receiver = new Receiver({
  currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
})

const app = new Hono()

// Dotted paths have no slashes, so each one is a single URL segment.
app.post("/messages/:path", async (c) => {
  const path = c.req.param("path")

  if (!messageRouter.channels.includes(path)) {
    return c.text("Unknown channel", 404)
  }

  const signature = c.req.header("upstash-signature")
  const body = await c.req.text()

  // QStash signs the URL it published to, so verify against the public URL:
  // behind a TLS-terminating proxy, c.req.url is the internal http:// one.
  // verify throws on a malformed signature and resolves false on a wrong one.
  const url = `${env.APP_URL}/messages/${path}`
  const verified =
    signature !== undefined && (await receiver.verify({ body, signature, url }).catch(() => false))

  if (!verified) {
    return c.text("Invalid signature", 401)
  }

  try {
    await messageRouter.dispatch(path, JSON.parse(body))
  } catch (error) {
    // A signed message that fails validation will fail the same way on every
    // retry, so tell QStash to stop. Anything else is worth retrying.
    if (
      error instanceof SyntaxError
      || (error instanceof ChannelError && error.code === "validation")
    ) {
      return new Response("Invalid message", {
        headers: { "Upstash-NonRetryable-Error": "true" },
        status: 489,
      })
    }

    console.error(`resolver failed for "${path}":`, error)
    return c.text("Internal server error", 500)
  }

  return c.body(null, 204)
})

// One serve handler per workflow channel, built once at startup. serve
// verifies QStash's signature itself and parses the initial payload; the
// router validates it against the contract on every step. `url` pins the
// public URL for step callbacks, which would otherwise come from request.url.
const workflowHandlers = new Map(
  workflowRouter.channels.map((path) => [
    path,
    serveWorkflow((context) => workflowRouter.dispatch(path, context.requestPayload, { context }), {
      env: {
        QSTASH_CURRENT_SIGNING_KEY: env.QSTASH_CURRENT_SIGNING_KEY,
        QSTASH_NEXT_SIGNING_KEY: env.QSTASH_NEXT_SIGNING_KEY,
        QSTASH_TOKEN: env.QSTASH_TOKEN,
        QSTASH_URL: env.QSTASH_URL,
      },
      url: `${env.APP_URL}/workflows/${path}`,
    }).handler,
  ])
)

app.post("/workflows/:path", async (c) => {
  const handler = workflowHandlers.get(c.req.param("path"))

  return handler ? await handler(c.req.raw) : c.text("Unknown channel", 404)
})

serve({ fetch: app.fetch, port: 4323 }, (info) => {
  console.log(`listening on http://localhost:${info.port}`)
})
