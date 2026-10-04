# How to cancel a call

Cancel a call when its result is no longer needed, such as when a user leaves the page or a request runs too long. Cancelling rejects the call on the client. It also aborts the `signal` that the resolver received, so the server can stop work.

1. In the resolver, pass `signal` to anything that accepts one, such as `fetch` or a database driver:

   ```typescript
   const router = createRouter(contract, {
     "reports.generate": async ({ id }, { signal }) => generate(id, { signal }),
   })
   ```

   Every resolver receives a `signal`. If the edge passes none, the signal never aborts.

2. On the client, bind a signal with `$with`:

   ```typescript
   const controller = new AbortController()

   const report = api.$with({ signal: controller.signal }).reports.generate({ id })

   controller.abort()
   ```

   The call rejects with `signal.reason`. To set a deadline instead, use `AbortSignal.timeout(5000)`.

This works only if the transport accepts `{ signal }`. Two transports already do:

- `router.dispatch`, when the context type is `void`. `dispatch` rejects as soon as the signal aborts, even if the resolver ignores it. If the signal has already aborted, the resolver doesn't start.
- The transport from `connect`. The client side drops the late reply and tells the peer, and the peer aborts its resolver's signal. A call that hits `timeoutMs` tells the peer the same way.

For your own transport, declare `options?: { signal?: AbortSignal }` as its third parameter and pass the signal on. See [How to pass per-call options](./pass-per-call-options.md).

## Stop every resolver when a connection ends

Closing a `connect` session aborts every resolver that end is running. You can close it two ways:

- Call `close(reason)`.
- Pass `signal` to `connect`. When that signal aborts, the session closes with the signal's reason.

```typescript
const session = new AbortController()

const { closed, transport } = connect(wire, { router, signal: session.signal })

closed.then((error) => console.log("session ended:", error.cause))
```

`closed` resolves with the `ChannelError` that pending and later calls reject with. Its code is `closed`.
