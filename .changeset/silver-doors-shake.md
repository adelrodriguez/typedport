---
"typeport": minor
---

Rename to `typeport`, accept any Standard Schema, collapse to one leaf primitive and one transport function

- The package is renamed from `@adelrodriguez/conduit` to `typeport` — typed trans**port**s, unscoped on npm.
- Contract leaves now accept anything implementing [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType, ...) instead of Zod only. `zod` is no longer a peer dependency.
- `procedure` and `event` collapse into a single `event` leaf: `event({ input, output })` is a round trip (result parsed against `output`), `event(schema)` is one-way (resolver result discarded, call typed `Promise<void>`).
- Every leaf is directly callable on the client — `.publish()` is gone, and `publish` is no longer a reserved contract key.
- A transport is now a single function `(path, payload) => result` instead of a `{ request, send }` pair. `router.dispatch` is itself a valid transport, so `createMemoryTransport` is gone: `createClient(contract, router.dispatch)`.
- Every failure the library raises is the new exported `TypeportError`, discriminated by `code` with typed fields per code: `validation` (Standard Schema `issues`), `unknown-channel` (`path`), `timeout` (`path`, `timeoutMs`), `closed` (the close reason in `cause`), and `no-router`. Adapters branch on structured fields instead of message strings; anything that is not a `TypeportError` came from application code. The parse primitive is exported as `parseWith` for edge adapters that validate before their own publish paths.
- The resolver map is typed by `InferResolvers` (replacing `InferHandlers`). Resolvers may be synchronous, and one-way resolvers may return a value (discarded by the router).
- Resolvers receive a per-dispatch **context**: `createRouter<typeof contract, Session>(contract, resolvers)` types every resolver `(input, context)`, and the edge supplies it via `dispatch(path, raw, context)`. With the default `void` context the argument disappears and `dispatch` remains a valid two-argument transport. `connect` accepts a per-connection `context` option.
- The client's `$schema` helper splits into `$input` and `$output`: `$input` is always the input schema (for a bare-schema leaf, the schema itself), `$output` is the output schema or `undefined` on one-way leaves.
- Transports may declare a per-call `options` parameter (`Transport<Options>`, inferred from the transport function's annotation). Every leaf call accepts `(input, options?)`, and `$with(options)` on the root or any subtree returns the client with options bound (per-call shallow-merging over bound) — `api.$with({ method: "GET" }).todos.list()`, `api.$with({ signal }).files.open()`. With no options declared, the surface disappears.
- New `typeport/wire` subpath export: `toWire`/`fromWire` are a symmetric codec for outcomes — `toWire(promiseOrThunk)` captures any operation's result or failure as a serializable envelope, `fromWire` unwraps it or rethrows (`TypeportError` crosses boundaries with its code and fields intact) — and `connect(wire, { router?, timeoutMs? })` turns any duplex message pipe into a symmetric transport with request/response correlation, per-call timeouts, and `close` teardown.
- New `OneWayContract` type: adapters built on one-way delivery (queues, `webContents.send`) constrain their contract parameter to it, making a round-trip leaf a compile error.
