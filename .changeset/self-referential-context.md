---
"typedport": patch
---

Fix `createRouter<typeof contract, Context>(contract, resolvers)` failing with TS2615 when `Context` references itself, such as Electron's `WebContents`. The handler-tree overload now infers context by walking the contract instead of the handler object.
