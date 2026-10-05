---
"typedport": minor
---

Add `createRouter.$context<Context>()` to fix a router factory's context type once while inferring each contract. The factory accepts flat resolver maps and compatible handler trees, and `dispatch` still requires the context. Existing `createRouter` calls are unchanged.
