import type { Wire } from "./types"
import { asError } from "../core/error"

/**
 * A `Wire` over a wire that hasn't arrived yet: outbound data buffers, the listener attaches on
 * arrival, and unsubscribing before arrival detaches permanently — so a `close` that wins the race
 * leaves a late wire untouched. The flush asks `stillWanted` per entry, so a request whose caller
 * gave up (timed out) while the wire was pending is dropped instead of sent. A rejected promise
 * reports through `onReject` (connect closes with it); the buffered data is dropped with the
 * connection, which is what the caller's pending-call rejections already communicate.
 */
export function deferWire(
  pending: Promise<Wire>,
  onReject: (reason: Error) => void,
  stillWanted: (data: unknown) => boolean
): Wire {
  let inner: Wire | undefined
  let listener: ((data: unknown) => void) | undefined
  let innerUnsubscribe: (() => void) | undefined = undefined
  let detached = false
  const outbox: unknown[] = []

  const adopt = async (): Promise<void> => {
    const wire = await pending

    if (detached) {
      return
    }

    inner = wire

    if (listener) {
      innerUnsubscribe = subscribe(wire, listener)
    }

    for (const data of outbox.splice(0)) {
      if (stillWanted(data)) {
        wire.send(data)
      }
    }
  }

  adopt().catch((error: unknown) => {
    onReject(asError(error))
  })

  return {
    onMessage: (incoming) => {
      listener = incoming

      if (inner) {
        innerUnsubscribe = subscribe(inner, incoming)
      }

      return () => {
        detached = true

        if (typeof innerUnsubscribe === "function") {
          innerUnsubscribe()
        }
      }
    },
    send: (data) => {
      if (inner) {
        inner.send(data)
      } else {
        outbox.push(data)
      }
    },
  }
}

// Normalizes Wire.onMessage's void-or-unsubscribe return to something storable.
export function subscribe(wire: Wire, listener: (data: unknown) => void): (() => void) | undefined {
  const unsubscribe = wire.onMessage(listener)

  return typeof unsubscribe === "function" ? unsubscribe : undefined
}
