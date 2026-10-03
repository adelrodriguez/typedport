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
 * Which failures `toWire` and `connect` let through with their real message and detail.
 * Caller-fault `ChannelError`s always pass — `validation` (with its `issues`), `unknown-channel`,
 * and `no-router` tell the caller what to fix and reveal nothing about the server — so the
 * predicate only decides the rest: application errors, and server-fault codes like
 * `output-validation`, whose `issues` describe the server's own data. A hidden failure crosses as a
 * `ChannelError` with code `internal`.
 */
export type ExposeOptions = {
  /**
   * Returns `true` for a failure the peer may see as-is: `(error) => error instanceof NotFound`.
   */
  expose?: (error: unknown) => boolean
  /**
   * Receives every failure that was hidden, for the server's own logs.
   */
  onHidden?: (error: unknown) => void
}

// Codes that reveal nothing about the server. `internal` is here so a relayed hidden failure
// passes through instead of being reported to `onHidden` a second time.
const ALWAYS_EXPOSED: ReadonlySet<ChannelErrorDetail["code"]> = new Set([
  "internal",
  "no-router",
  "unknown-channel",
  "validation",
])

/**
 * Captures any operation's outcome as a serializable `WireResult` — never throws. Pass the
 * operation's promise (`toWire(router.dispatch(path, payload))`), or a thunk when the operation can
 * throw synchronously. `fromWire` on the other side is its inverse: `fromWire(await toWire(x))`
 * returns what `x` resolved with, or rethrows what it threw.
 *
 * Failures are hidden by default: anything but a caller-fault `ChannelError` crosses as a
 * `ChannelError` with code `internal`, because the far side of a serializing boundary is often a
 * browser. Widen it with `expose`, and log what was hidden with `onHidden` — see
 * {@link ExposeOptions}.
 */
export async function toWire(
  operation: Promise<unknown> | (() => unknown),
  options: ExposeOptions = {}
): Promise<WireResult> {
  try {
    return { ok: true, result: await (typeof operation === "function" ? operation() : operation) }
  } catch (error) {
    if (isAlwaysExposed(error) || policyExposes(options.expose, error)) {
      return { error: serializeError(error), ok: false }
    }

    try {
      options.onHidden?.(error)
    } catch {
      // A failing logger must not cost the caller its reply.
    }

    return { error: serializeError(new ChannelError({ code: "internal" })), ok: false }
  }
}

// `toWire` promises never to throw, so a policy that throws counts as "no": the failure stays
// hidden, which is the safe side.
function policyExposes(expose: ExposeOptions["expose"], error: unknown): boolean {
  try {
    return expose?.(error) === true
  } catch {
    return false
  }
}

function isAlwaysExposed(error: unknown): boolean {
  return error instanceof ChannelError && ALWAYS_EXPOSED.has(error.code)
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

function serializeError(error: unknown): Exclude<WireResult, { ok: true }>["error"] {
  if (error instanceof ChannelError) {
    return { detail: detailOf(error), message: error.message, name: error.name }
  }

  if (error instanceof Error) {
    return { message: error.message, name: error.name }
  }

  return { message: describe(error), name: "Error" }
}

// `String()` throws for values with no usable conversion (`Object.create(null)`), and anything can
// be thrown.
function describe(value: unknown): string {
  try {
    return String(value)
  } catch {
    return "Unknown error"
  }
}
