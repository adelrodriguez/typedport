// The publishing side of the adapter. Each transport is one function that
// turns a dotted path into a URL; per-call options (a delay, a dedup id) ride
// the transport's third parameter and never touch the payload.
import type { Client as QStashClient, PublishRequest } from "@upstash/qstash"
import type { Client as WorkflowClient, TriggerOptions } from "@upstash/workflow"
import { createClient, type OneWayContract } from "../../src/index.ts"

type PublishOptions = Pick<PublishRequest, "deduplicationId" | "delay" | "retries">

// OneWayContract makes a round-trip leaf a compile error: a queue would
// resolve the publish receipt where the caller expects a result.
export function createPublisher<Tree extends OneWayContract>(
  contract: Tree,
  { baseUrl, client }: { baseUrl: string; client: QStashClient }
) {
  return createClient(contract, (path, body, options?: PublishOptions) =>
    client.publishJSON({ ...options, body, url: `${baseUrl}/${path}` })
  )
}

type TriggerCallOptions = Omit<TriggerOptions, "body" | "url">

export function createTrigger<Tree extends OneWayContract>(
  contract: Tree,
  { baseUrl, client }: { baseUrl: string; client: WorkflowClient }
) {
  return createClient(contract, (path, body, options?: TriggerCallOptions) =>
    client.trigger({ ...options, body, url: `${baseUrl}/${path}` })
  )
}
