---
"typedport": minor
---

One-way calls are typed `Promise<unknown>` instead of `Promise<void>`. The client already resolved them with whatever the transport returned (a queue receipt, an ack), but the `void` type hid that value behind an unchecked cast. Code that assigned a one-way call to a `() => Promise<void>` slot needs to discard the value, for example `async () => { await api.events.created(input) }`.
