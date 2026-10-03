---
"typedport": patch
---

Harden the untrusted boundaries. Paths like `"constructor"` or `"__proto__"` now fail as `unknown-channel` instead of resolving to `Object.prototype` members. `fromWire` validates error details and rejects forged ones as `malformed-envelope`, and `ChannelError` copies only its known fields. `connect` ignores requests without a numeric `id` and string `path`. `whenOpen` rejects a socket that is already closed instead of waiting forever. `createRouter` throws at construction when a flat resolver map misses a leaf.
