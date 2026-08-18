---
"typeport": minor
---

Rename to `typeport`, accept any Standard Schema, collapse to one leaf primitive and one transport function

- The package is renamed from `@adelrodriguez/conduit` to `typeport` — typed trans**port**s, unscoped on npm.
- Contract leaves now accept anything implementing [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType, ...) instead of Zod only. `zod` is no longer a peer dependency.
- `procedure` and `event` collapse into a single `event` leaf: `event({ input, output })` is a round trip (result parsed against `output`), `event(schema)` is one-way (resolver result discarded, call typed `Promise<void>`).
- Every leaf is directly callable on the client — `.publish()` is gone, and `publish` is no longer a reserved contract key.
- A transport is now a single function `(path, payload) => result` instead of a `{ request, send }` pair. `router.dispatch` is itself a valid transport, so `createMemoryTransport` is gone: `createClient(contract, router.dispatch)`.
- Validation failures throw the new exported `ValidationError`, which carries the Standard Schema issues, so adapters can distinguish bad input from resolver failures. The parse primitive itself is exported as `parseWith` for edge adapters that validate before their own publish paths.
- The resolver map is typed by `InferResolvers` (replacing `InferHandlers`). Resolvers may be synchronous, and one-way resolvers may return a value (discarded by the router).
- New `typeport/wire` subpath export: `dispatchToWire`/`fromWire` flatten dispatch outcomes into a serializable envelope and rehydrate them (`ValidationError` crosses boundaries with its issues intact), and `connect(wire, { router?, timeoutMs? })` turns any duplex message pipe into a symmetric transport with request/response correlation, per-call timeouts, and `close` teardown.
- New `OneWayContract` type: adapters built on one-way delivery (queues, `webContents.send`) constrain their contract parameter to it, making a round-trip leaf a compile error.
