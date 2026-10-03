---
"typedport": patch
---

**Input transforms work end to end.** The client still validates input at the call site, but now sends it as the caller wrote it instead of the parsed value. Previously the router re-parsed an already-transformed payload, so any type-changing transform (`z.string().transform(Number)`, `v.pipe(v.string(), v.transform(Number))`) was rejected server-side. Only the router's parsed value (defaults, transforms, stripping applied) reaches the resolver; the client discards its own parse result.
