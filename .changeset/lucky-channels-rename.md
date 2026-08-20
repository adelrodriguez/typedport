---
"typedport": minor
---

Breaking API sweep ahead of the freeze (0.x, so breaking changes ride minor bumps).

- **`event()` is now `channel()`.** One leaf constructor for both shapes — `channel({ input, output })` is a round trip, `channel(schema)` is one-way — matching the vocabulary the library already used everywhere else (`router.channels`, `unknown-channel`). The leaf discriminant is now `_kind: "channel"`, the `Leaf` type is now `Channel`, and `isLeaf` is now `isChannel`.
- **`TypeportError` is now `ChannelError`** (and `TypeportErrorDetail` is `ChannelErrorDetail`). Same single class, same `code` discrimination; only the name changed, retiring the residue of the old package name.
- **The client proxy is no longer thenable.** `then` and `toJSON` return `undefined` from the proxy and are rejected as contract keys by `defineContract`. Previously `await client.someBranch` dispatched the path `"someBranch.then"` and never settled.
- The README now documents the adapter-author toolkit (`flatten`, `isChannel`, `parseWith`, `Transport`, `OneWayContract`, `InferClient`, `Channel`) and the client-side output-validation pattern (`parseWith(api.leaf.$output, result)`).

Housekeeping: the package itself was renamed from `typeport` to `typedport` in an earlier release without a changeset — this entry records it.

Migrating: rename `event(` → `channel(`, `TypeportError` → `ChannelError`, `Leaf` → `Channel`, and `isLeaf` → `isChannel`; nothing else changes.
