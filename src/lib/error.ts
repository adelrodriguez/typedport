import type { StandardSchemaV1 } from "@standard-schema/spec"

/**
 * The discriminated payload of a `TypeportError`, one variant per failure the library itself can
 * raise. Serializable by construction: the wire envelope ships it across boundaries verbatim and
 * rehydrates it on the other side.
 */
export type TypeportErrorDetail =
  | { code: "closed" }
  | { code: "malformed-envelope" }
  | { code: "no-router" }
  | { code: "output-validation"; issues: readonly StandardSchemaV1.Issue[] }
  | { code: "timeout"; path: string; timeoutMs: number }
  | { code: "unknown-channel"; path: string }
  | { code: "validation"; issues: readonly StandardSchemaV1.Issue[] }

function messageFor(detail: TypeportErrorDetail): string {
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

class TypeportBaseError extends Error {
  constructor(detail: TypeportErrorDetail, options?: ErrorOptions) {
    super(messageFor(detail), options)
    // oxlint-disable-next-line custom-error-definition -- instances present under the public name, TypeportError
    this.name = "TypeportError"
    Object.assign(this, detail)
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
 * `instanceof TypeportError` then `error.code === "..."` narrows the fields. Anything a resolver
 * throws is not wrapped: an error that is not a `TypeportError` came from application code.
 */
export type TypeportError = TypeportBaseError & TypeportErrorDetail

// The base class assigns the detail's fields onto the instance; this cast is what lets the type
// system see them, making `code` narrow the per-code fields after an `instanceof` check.
export const TypeportError = TypeportBaseError as unknown as new (
  detail: TypeportErrorDetail,
  options?: ErrorOptions
) => TypeportError

/**
 * Recovers the serializable detail from an instance — the wire envelope's half of the round trip
 * `new TypeportError(detailOf(error))`.
 */
export function detailOf(error: TypeportError): TypeportErrorDetail {
  switch (error.code) {
    case "closed":
      return { code: "closed" }
    case "malformed-envelope":
      return { code: "malformed-envelope" }
    case "no-router":
      return { code: "no-router" }
    case "output-validation":
      return { code: "output-validation", issues: error.issues }
    case "timeout":
      return { code: "timeout", path: error.path, timeoutMs: error.timeoutMs }
    case "unknown-channel":
      return { code: "unknown-channel", path: error.path }
    case "validation":
      return { code: "validation", issues: error.issues }
  }
}
