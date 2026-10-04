---
"typedport": minor
---

Resolvers take `{ context, signal }` as their second argument, and `router.dispatch` takes `{ context, signal }` as its third. Before: `(input, session) => ...` and `router.dispatch(path, raw, session)`. After: `(input, { context }) => ...` and `router.dispatch(path, raw, { context: session })`.

`signal` aborts when the caller gives up. Resolvers always receive one (it never aborts if the edge gave none), so they can pass it straight to `fetch` or a database driver. `dispatch` rejects with the abort reason as soon as the signal aborts, even if the resolver ignores it, and doesn't start the resolver if the signal is already aborted. With the default `Context = void` the options are optional, so `createClient(contract, router.dispatch)` gets `$with({ signal })` in memory.

`connect` now tells the other side when a call is cancelled or times out, and that side aborts the `signal` its resolver received. Closing a session aborts every resolver that end is running. New exported types: `DispatchOptions`, `Resolver`, and `ResolverOptions`.
