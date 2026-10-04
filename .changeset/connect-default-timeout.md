---
"typedport": minor
---

`connect` now times out outgoing calls after 30 seconds by default. Before, leaving out `timeoutMs` meant a dead peer left every pending call pending forever. Pass `timeoutMs: Infinity` to keep the old behavior when something else, such as `close`, covers liveness.
