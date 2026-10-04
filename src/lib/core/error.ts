import type { StandardSchemaV1 } from "@standard-schema/spec"

/**
 * The discriminated payload of a `ChannelError`, one variant per failure the library itself can
 * raise. Serializable by construction: the wire envelope ships it across boundaries verbatim and
 * rehydrates it on the other side.
 */
export type ChannelErrorDetail =
  | { code: "closed" }
  | { code: "malformed-envelope" }
  | { code: "no-router" }
  | { code: "output-validation"; issues: readonly StandardSchemaV1.Issue[] }
  | { code: "timeout"; path: string; timeoutMs: number }
  | { code: "unknown-channel"; path: string }
  | { code: "validation"; issues: readonly StandardSchemaV1.Issue[] }

function messageFor(detail: ChannelErrorDetail): string {
  switch (detail.code) {
    case "closed":
      return "Wire closed"
    case "malformed-envelope":
      return "Received a value that is not a WireResult envelope"
    case "no-router":
      return "This end does not serve requests"
    case "output-validation":
    case "validation":
      return detail.issues.map((issue) => issue.message).join("; ")
    case "timeout":
      return `Call to "${detail.path}" timed out after ${detail.timeoutMs}ms`
    case "unknown-channel":
      return `Unknown channel: "${detail.path}"`
  }
}

class ChannelBaseError extends Error {
  constructor(detail: ChannelErrorDetail, options?: ErrorOptions) {
    super(messageFor(detail), options)
    // oxlint-disable-next-line custom-error-definition -- instances present under the public name, ChannelError
    this.name = "ChannelError"
    // Copy the known fields only: a detail rehydrated from a peer must not
    // be able to overwrite `message`, `stack`, or `cause` on the instance.
    Object.assign(this, detailOf(detail))
  }
}

/**
 * The single error class for every failure the library raises — `code` discriminates, and each code
 * carries its own typed fields:
 *
 * - `validation` (`issues`) — a schema rejected the caller's input; the caller's fault
 * - `output-validation` (`issues`) — the resolver's result failed the leaf's `output` schema; the
 *   server's fault, so edges should not blame (or inform) the caller
 * - `unknown-channel` (`path`) — the path is not in the contract
 * - `timeout` (`path`, `timeoutMs`) — a `connect` call the peer never answered
 * - `closed` — the wire was torn down; the close reason is in `cause`
 * - `no-router` — the peer's `connect` has no router to serve requests
 * - `malformed-envelope` — `fromWire` received a value that is not a `WireResult` (a gateway error
 *   page, a proxy 502)
 *
 * `instanceof ChannelError` then `error.code === "..."` narrows the fields. Anything a resolver
 * throws is not wrapped: an error that is not a `ChannelError` came from application code.
 */
export type ChannelError = ChannelBaseError & ChannelErrorDetail

// The base class assigns the detail's fields onto the instance; this cast is what lets the type
// system see them, making `code` narrow the per-code fields after an `instanceof` check.
export const ChannelError = ChannelBaseError as unknown as new (
  detail: ChannelErrorDetail,
  options?: ErrorOptions
) => ChannelError

/**
 * Recovers the serializable detail from an instance (or narrows a detail to its known fields) — the
 * wire envelope's half of the round trip `new ChannelError(detailOf(error))`.
 */
export function detailOf(detail: ChannelErrorDetail): ChannelErrorDetail {
  switch (detail.code) {
    case "closed":
      return { code: "closed" }
    case "malformed-envelope":
      return { code: "malformed-envelope" }
    case "no-router":
      return { code: "no-router" }
    case "output-validation":
      return { code: "output-validation", issues: detail.issues }
    case "timeout":
      return { code: "timeout", path: detail.path, timeoutMs: detail.timeoutMs }
    case "unknown-channel":
      return { code: "unknown-channel", path: detail.path }
    case "validation":
      return { code: "validation", issues: detail.issues }
  }
}

/**
 * Validates an untrusted value as a `ChannelErrorDetail` — a detail that arrives over a wire is
 * only as trustworthy as the peer. Returns `undefined` for an unknown code or mistyped fields.
 */
export function parseDetail(value: unknown): ChannelErrorDetail | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return undefined
  }

  const candidate = value as {
    code: unknown
    issues?: unknown
    path?: unknown
    timeoutMs?: unknown
  }

  switch (candidate.code) {
    case "closed":
    case "malformed-envelope":
    case "no-router":
      return { code: candidate.code }
    case "output-validation":
    case "validation":
      return isIssueList(candidate.issues)
        ? { code: candidate.code, issues: candidate.issues }
        : undefined
    case "timeout":
      return typeof candidate.path === "string" && typeof candidate.timeoutMs === "number"
        ? { code: "timeout", path: candidate.path, timeoutMs: candidate.timeoutMs }
        : undefined
    case "unknown-channel":
      return typeof candidate.path === "string"
        ? { code: "unknown-channel", path: candidate.path }
        : undefined
    default:
      return undefined
  }
}

function isIssueList(value: unknown): value is readonly StandardSchemaV1.Issue[] {
  return Array.isArray(value) && everySlot(value, isIssue)
}

// The Standard Schema issue shape: a string `message` and an optional `path` of property keys or
// `{ key }` segments. Consumers walk `path` freely, so a malformed one must not get through.
function isIssue(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const { message, path } = value as { message?: unknown; path?: unknown }

  return (
    typeof message === "string" &&
    (path === undefined || (Array.isArray(path) && everySlot(path, isPathSegment)))
  )
}

// `Array.prototype.every` skips empty slots, and structured clone (MessagePort, workers) preserves
// them, so `new Array(1)` would pass. Walk the indices instead, failing on the first hole — without
// copying: a compact sparse array can claim a huge `length`, and `Array.from` would allocate it all.
// A dense array is only as long as what the peer actually sent.
function everySlot(array: readonly unknown[], predicate: (value: unknown) => boolean): boolean {
  for (let index = 0; index < array.length; index += 1) {
    if (!(index in array) || !predicate(array[index])) {
      return false
    }
  }

  return true
}

function isPathSegment(value: unknown): boolean {
  if (isPropertyKey(value)) {
    return true
  }

  return (
    typeof value === "object" && value !== null && isPropertyKey((value as { key?: unknown }).key)
  )
}

function isPropertyKey(value: unknown): value is PropertyKey {
  return typeof value === "string" || typeof value === "number" || typeof value === "symbol"
}
