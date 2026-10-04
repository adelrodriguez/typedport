import { ChannelError, type ChannelErrorDetail, detailOf, parseDetail } from "../core/error"
import { isRecord } from "../core/guards"

/**
 * An outcome flattened to a serializable value, so errors survive boundaries that structured-clone
 * or JSON-encode (Electron `invoke`, `postMessage`, HTTP). `detail` is present exactly when the
 * failure was a `ChannelError`, letting `fromWire` rehydrate it — code and fields intact — on the
 * other side.
 */
export type WireResult =
  | { ok: true; result: unknown }
  | {
      ok: false
      error: { detail?: ChannelErrorDetail; message: string; name: string }
    }

/**
 * Captures any operation's outcome as a serializable `WireResult` — never throws. Pass the
 * operation's promise (`toWire(router.dispatch(path, payload))`), or a thunk when the operation can
 * throw synchronously. `fromWire` on the other side is its inverse: `fromWire(await toWire(x))`
 * returns what `x` resolved with, or rethrows what it threw.
 */
export async function toWire(operation: Promise<unknown> | (() => unknown)): Promise<WireResult> {
  try {
    return { ok: true, result: await (typeof operation === "function" ? operation() : operation) }
  } catch (error) {
    return { error: serializeError(error), ok: false }
  }
}

/**
 * Unwraps a `WireResult`: returns the result, or rethrows the failure — with `ChannelError`
 * rehydrated (code and fields intact) so `instanceof` and `code` checks work across the boundary.
 *
 * Takes `unknown` because at a real boundary the value is untrusted: a gateway error page or a
 * proxy 502 is not an envelope, and that raises a clear error here instead of an opaque `TypeError`
 * downstream.
 */
export function fromWire(data: unknown): unknown {
  const envelope = parseEnvelope(data)

  if (!envelope) {
    // A library-raised failure, so it follows the one rule: it is a
    // ChannelError, and adapters can branch on its code.
    throw new ChannelError({ code: "malformed-envelope" })
  }

  if (envelope.ok) {
    return envelope.result
  }

  if (envelope.error.detail) {
    throw new ChannelError(envelope.error.detail)
  }

  const error = new Error(envelope.error.message)
  error.name = envelope.error.name
  throw error
}

// Validates every field `fromWire` reads, down to the `ChannelError` detail: a forged detail with an
// unknown code or mistyped fields would otherwise rehydrate into a broken error.
function parseEnvelope(data: unknown): WireResult | undefined {
  if (!isRecord(data)) {
    return undefined
  }

  if (data.ok === true) {
    return { ok: true, result: data.result }
  }

  if (data.ok !== false || !isRecord(data.error)) {
    return undefined
  }

  const { detail, message, name } = data.error

  if (typeof message !== "string" || typeof name !== "string") {
    return undefined
  }

  if (detail === undefined) {
    return { error: { message, name }, ok: false }
  }

  const parsed = parseDetail(detail)

  return parsed ? { error: { detail: parsed, message, name }, ok: false } : undefined
}

export function serializeError(error: unknown): Exclude<WireResult, { ok: true }>["error"] {
  if (error instanceof ChannelError) {
    return { detail: detailOf(error), message: error.message, name: error.name }
  }

  if (error instanceof Error) {
    return { message: error.message, name: error.name }
  }

  return { message: String(error), name: "Error" }
}
