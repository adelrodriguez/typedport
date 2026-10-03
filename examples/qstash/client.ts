/* oxlint-disable no-console -- runnable example */
// The producer: typed publish and trigger clients. Every call is validated
// against the contract before it reaches QStash, so an off-contract payload
// never enters the queue.
import { Client as QStashClient } from "@upstash/qstash"
import { Client as WorkflowClient } from "@upstash/workflow"
import { ChannelError } from "../../src/index.ts"
import { messages, workflows } from "./contract.ts"
import { env } from "./env.ts"
import { createPublisher, createTrigger } from "./queue.ts"

const credentials = { baseUrl: env.QSTASH_URL, token: env.QSTASH_TOKEN }

const publish = createPublisher(messages, {
  baseUrl: `${env.APP_URL}/messages`,
  client: new QStashClient(credentials),
})

const trigger = createTrigger(workflows, {
  baseUrl: `${env.APP_URL}/workflows`,
  client: new WorkflowClient(credentials),
})

await publish.stripe.checkout.created({ amount: 4200, id: "cs_123" })
await publish.email.welcome({ email: "ada@example.com" }, { delay: 1 }) // per-call options
await trigger.reports.generate({ reportId: "rep_123" })
console.log("published 2 messages, triggered 1 workflow")

// The client validates before publishing — this never reaches QStash:
await publish.email.welcome({ email: "not-an-email" }).catch((error: unknown) => {
  if (error instanceof ChannelError && error.code === "validation") {
    console.log("rejected at the call site:", error.issues[0]?.message)
  }
})

// Bypass QStash to show the server's own trust boundary: without a valid
// Upstash-Signature the route never dispatches.
const forged = await fetch(`${env.APP_URL}/messages/email.welcome`, {
  body: JSON.stringify({ email: "mallory@example.com" }),
  headers: { "content-type": "application/json" },
  method: "POST",
})
console.log("server status for an unsigned message:", forged.status)
