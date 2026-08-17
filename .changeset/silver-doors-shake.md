---
"@adelrodriguez/conduit": minor
---

Accept any Standard Schema, rename transport functions to `call`/`post`, add per-call options passthrough, surface post results

- Contract leaves now accept anything implementing [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType, ...) instead of Zod only. `zod` is no longer a peer dependency.
- Transport functions are renamed: `request` → `call` (procedures; a round trip resolving with the handler's result) and `send` → `post` (events; one-way).
- Transports take an optional third `options` argument on `call` and `post`, forwarded verbatim from the call site: `client.foo.bar(input, options)` / `client.baz.publish(payload, options)`. The options type is inferred from the transport.
- `publish` now resolves with whatever the transport's `post` returns (e.g. a QStash message id) instead of always `void`.
- Validation failures throw the new exported `ValidationError`, which carries the Standard Schema issues, so adapters can distinguish bad input from handler failures.
- Handlers may be synchronous, and event handlers may return a value (discarded by the router).
