/**
 * The minimal duplex pipe `connect` runs over: anything that can send a value and hand incoming
 * values to a listener (a DOM `MessagePort`, an Electron `MessagePortMain`, a `WebSocket`, a
 * worker). `onMessage` may return an unsubscribe function; `close` invokes it if present.
 */
export type Wire = {
  send: (data: unknown) => void
  // oxlint-disable-next-line no-invalid-void-type -- adapters without an unsubscribe mechanism return nothing
  onMessage: (listener: (data: unknown) => void) => void | (() => void)
}
