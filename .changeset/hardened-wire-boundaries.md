---
"typedport": minor
---

Harden the untrusted boundaries. Paths like `"constructor"` or `"__proto__"` now fail as `unknown-channel` instead of resolving to `Object.prototype` members. `fromWire` validates error details and rejects forged ones as `malformed-envelope`, and `ChannelError` copies only its known fields. `connect` ignores requests without a numeric `id` and string `path`. `whenOpen` rejects a socket that is already closed instead of waiting forever. `createRouter` throws at construction when a flat resolver map misses a leaf.

Setup failures now throw `SetupError` (exported from `typedport`) instead of plain `Error`, discriminated by `code` like `ChannelError`: `reserved-key`, `dotted-key`, `missing-resolver`, `invalid-handler`, `misplaced-handler`, `no-window`, `socket-failed`, and `socket-closed`. A handler tree missing a leaf now reports `Missing resolver for "..."`, the same message as a flat map.

Client nodes are now stable: `api.a.b === api.a.b`, so a node can serve as a `Map` key or a React dependency. The package also declares `"sideEffects": false`.
