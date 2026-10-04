/**
 * The discriminated payload of a `SetupError`, one variant per way wiring typedport up can fail.
 */
export type SetupErrorDetail =
  | { code: "dotted-key"; key: string; path: string }
  | { code: "invalid-handler"; expected: "branch" | "fragment"; path: string }
  | { code: "misplaced-handler"; fragmentPath: string; path: string }
  | { code: "missing-resolver"; path: string }
  | { code: "no-window"; caller: string }
  | { code: "reserved-key"; key: string; path: string }

function messageFor(detail: SetupErrorDetail): string {
  switch (detail.code) {
    case "dotted-key":
      return `Key "${detail.key}" at "${detail.path}" in contract must not contain "."`
    case "invalid-handler":
      return detail.expected === "fragment"
        ? `Handler for "${detail.path}" is not a fragment`
        : `Expected a branch of handlers at "${detail.path}"`
    case "misplaced-handler":
      return `Handler for "${detail.fragmentPath}" placed at "${detail.path}"`
    case "missing-resolver":
      return `Missing resolver for "${detail.path}"`
    case "no-window":
      return `${detail.caller} needs a window; outside the DOM, pass one explicitly`
    case "reserved-key":
      return `Reserved key "${detail.key}" at "${detail.path}" in contract`
  }
}

class SetupBaseError extends Error {
  constructor(detail: SetupErrorDetail, options?: ErrorOptions) {
    super(messageFor(detail), options)
    // oxlint-disable-next-line custom-error-definition -- instances present under the public name, SetupError
    this.name = "SetupError"
    Object.assign(this, detail)
  }
}

/**
 * The error class for misusing typedport outside a call: a contract that can't be defined, a router
 * that can't be assembled, a port hand-off with no window. `ChannelError` is the other half —
 * failures of a call, serializable across the wire. A `SetupError` never travels: it surfaces where
 * the wiring happens, as a bug to fix rather than a condition to handle.
 *
 * - `reserved-key` (`key`, `path`) — a contract key the client proxy claims (`$`-helpers, `_kind`,
 *   `then`, `toJSON`)
 * - `dotted-key` (`key`, `path`) — a contract key containing `.`, which would collide with nesting
 * - `missing-resolver` (`path`) — a contract leaf with no resolver or fragment
 * - `invalid-handler` (`path`, `expected`) — a handler-tree slot holding something other than the
 *   fragment or branch the contract demands
 * - `misplaced-handler` (`path`, `fragmentPath`) — a fragment built for another leaf
 * - `no-window` (`caller`) — a port hand-off called outside the DOM without an explicit window
 *
 * `instanceof SetupError` then `error.code === "..."` narrows the fields.
 */
// oxlint-disable-next-line no-redeclare -- the type and the constructor below share the public name, like a class
export type SetupError = SetupBaseError & SetupErrorDetail

// Same construction as ChannelError: the cast lets `code` narrow the per-code fields.
// oxlint-disable-next-line typescript/consistent-type-assertions -- see above
export const SetupError = SetupBaseError as unknown as new (
  detail: SetupErrorDetail,
  options?: ErrorOptions
) => SetupError
