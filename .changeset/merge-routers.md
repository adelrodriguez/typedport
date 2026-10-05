---
"typedport": minor
---

Add `mergeRouters(...routers)`, which serves several routers as one `Router`. Its context is the intersection of the routers' contexts, and a channel that two routers declare throws a `SetupError` with the new code `duplicate-channel`.
