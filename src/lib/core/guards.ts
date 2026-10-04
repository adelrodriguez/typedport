/**
 * Narrows an untrusted value to an object whose fields can be read as `unknown` — the one way the
 * library inspects values that crossed a boundary (wire messages, error details, handler trees), so
 * each field is checked before it is trusted.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
