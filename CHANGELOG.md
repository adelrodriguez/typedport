# typedport

## 0.2.1

### Patch Changes

- 7810d91: Fix `createRouter<typeof contract, Context>(contract, resolvers)` failing with TS2615 when `Context` references itself, such as Electron's `WebContents`. The handler-tree overload now infers context by walking the contract instead of the handler object.

## 0.2.0

### Minor Changes

- 1460cc4: `toWire` now hides failures by default. Caller-fault `ChannelError`s (`validation`, `unknown-channel`, `no-router`) cross intact. Everything else, including application errors and `output-validation`, crosses as a `ChannelError` with the new code `internal`. Pass `expose: (error) => boolean` to let more through and `onHidden` to log what was hidden. `connect` hides the same way and takes the same options; pass `expose: () => true` for a trusted peer.

  `connect` is now cancellable. Its transport takes `{ signal }` per call, so `api.$with({ signal })` aborts one call: it rejects with `signal.reason` and a late reply is dropped. `connect(wire, { signal })` closes the session when the signal aborts (`close(reason)` now accepts any value, like an abort reason), and the returned `closed` promise resolves with the `closed` `ChannelError`.

  `receivePort` and `relayPort` take an options object instead of a positional `target`: `receivePort(type, { signal, target })` and `relayPort(ipcRenderer, type, { signal, target, targetOrigin })`. `receivePort`'s signal bounds the wait, and `relayPort`'s stops the relay, so `PortIpcRendererLike` now requires `removeListener`. `relayPort` posts to the window's own origin instead of `"*"`, and falls back to `"*"` only for opaque origins such as `file://`.

- f073ab3: `connect` now times out outgoing calls after 30 seconds by default. Before, leaving out `timeoutMs` meant a dead peer left every pending call pending forever. Pass `timeoutMs: Infinity` to keep the old behavior when something else, such as `close`, covers liveness.
- 14340d8: Resolvers take `{ context, signal }` as their second argument, and `router.dispatch` takes `{ context, signal }` as its third. Before: `(input, session) => ...` and `router.dispatch(path, raw, session)`. After: `(input, { context }) => ...` and `router.dispatch(path, raw, { context: session })`.

  `signal` aborts when the caller gives up. Resolvers always receive one (it never aborts if the edge gave none), so they can pass it straight to `fetch` or a database driver. `dispatch` rejects with the abort reason as soon as the signal aborts, even if the resolver ignores it, and doesn't start the resolver if the signal is already aborted. With the default `Context = void` the options are optional, so `createClient(contract, router.dispatch)` gets `$with({ signal })` in memory.

  `connect` now tells the other side when a call is cancelled or times out, and that side aborts the `signal` its resolver received. Closing a session aborts every resolver that end is running. New exported types: `DispatchOptions`, `Resolver`, and `ResolverOptions`.

- cce0642: Harden the untrusted boundaries. Paths like `"constructor"` or `"__proto__"` now fail as `unknown-channel` instead of resolving to `Object.prototype` members. `fromWire` validates error details and rejects forged ones as `malformed-envelope`, and `ChannelError` copies only its known fields. `connect` ignores requests without a numeric `id` and string `path`. `whenOpen` rejects a socket that is already closed instead of waiting forever, and its rejections are now a `ChannelError` with code `closed` (the `cause` says whether the socket errored or closed). `flatten` now returns an object with no prototype, so use `Object.hasOwn(result, path)` rather than `result.hasOwnProperty(path)`. `createRouter` throws at construction when a flat resolver map misses a leaf.

  Setup failures now throw `SetupError` (exported from `typedport`) instead of plain `Error`, discriminated by `code` like `ChannelError`: `reserved-key`, `dotted-key`, `missing-resolver`, `invalid-handler`, `misplaced-handler`, and `no-window`. A handler tree missing a leaf now reports `Missing resolver for "..."`, the same message as a flat map.

  Client nodes are now stable: `api.a.b === api.a.b`, so a node can serve as a `Map` key or a React dependency. The package also declares `"sideEffects": false`.

- 9b6beb7: Handler builder, shipped wires, and late-arriving pipes. All additive.

  - **`implement()`.** `const tp = implement(contract).$context<Session>()` gives you a fragment factory per leaf: `tp.notes.open(async ({ path }, session) => ...)` infers input, output, and context with zero annotations, so handlers can live next to their domain code, one file per contract branch. Assemble with `createRouter(contract, { notes, ping })`, where a namespace import of a handler module already has the right shape (stray helper exports are ignored). A missing leaf, a fragment in the wrong slot, a fragment from another contract, or two fragments built against different contexts are all compile errors at the assembly site. The context type is written once, at `$context`; `createRouter` infers it from the fragments. The flat resolver map still works unchanged.
  - **`connect` accepts `Promise<Wire>`.** For pipes that aren't ready yet: a port still being handed over, a socket still opening. Calls made in the meantime queue (bounded by `timeoutMs`) and flush on arrival; `close()` before arrival rejects them and ignores the late wire; a rejected wire promise closes the connection with the rejection as `cause`. This replaces the hand-rolled deferred-transport pattern, which silently dropped per-call options.
  - **`typedport/wire/message-port`.** `mainPort` (Electron `MessagePortMain`, in main and utility processes), `domPort` (DOM `MessagePort`), and `nodePort` (`worker_threads` ports, `Worker`, `parentPort`) turn each port flavor into a `Wire`. For Electron, `sendPort` / `relayPort` / `receivePort` are the main → preload → renderer hand-off, with the same-window/type guard built into `receivePort`. Everything is structurally typed, with no dependency on Electron or DOM types.
  - **`typedport/wire/web-socket`.** `webSocket` wraps a browser/Node `WebSocket` or a `ws` socket as a `Wire` (JSON frames, Buffer-tolerant), and `whenOpen(socket)` pairs with the pending-wire `connect`: `connect(whenOpen(ws).then(webSocket), { router })`.

- 9b6beb7: Breaking API sweep ahead of the freeze (0.x, so breaking changes ride minor bumps).

  - **`event()` is now `channel()`.** One leaf constructor for both shapes — `channel({ input, output })` is a round trip, `channel(schema)` is one-way — matching the vocabulary the library already used everywhere else (`router.channels`, `unknown-channel`). The leaf discriminant is now `_kind: "channel"`, the `Leaf` type is now `Channel`, and `isLeaf` is now `isChannel`.
  - **`TypeportError` is now `ChannelError`** (and `TypeportErrorDetail` is `ChannelErrorDetail`). Same single class, same `code` discrimination; only the name changed, retiring the residue of the old package name.
  - **The client proxy is no longer thenable.** `then` and `toJSON` return `undefined` from the proxy and are rejected as contract keys by `defineContract`. Previously `await client.someBranch` dispatched the path `"someBranch.then"` and never settled.
  - The README now documents the adapter-author toolkit (`flatten`, `isChannel`, `parseWith`, `Transport`, `OneWayContract`, `InferClient`, `Channel`) and the client-side output-validation pattern (`parseWith(api.leaf.$output, result)`).

  Housekeeping: the package itself was renamed from `typeport` to `typedport` in an earlier release without a changeset — this entry records it.

  Migrating: rename `event(` → `channel(`, `TypeportError` → `ChannelError`, `Leaf` → `Channel`, and `isLeaf` → `isChannel`. Also rename any contract key called `then` or `toJSON` (`defineContract` now rejects both), and update any hand-built leaf from `_kind: "event"` to `_kind: "channel"`.

- 6715810: One-way calls are typed `Promise<unknown>` instead of `Promise<void>`. The client already resolved them with whatever the transport returned (a queue receipt, an ack), but the `void` type hid that value behind an unchecked cast. Code that assigned a one-way call to a `() => Promise<void>` slot needs to discard the value, for example `async () => { await api.events.created(input) }`.

### Patch Changes

- 0a51c67: **Input transforms work end to end.** The client still validates input at the call site, but now sends it as the caller wrote it instead of the parsed value. Previously the router re-parsed an already-transformed payload, so any type-changing transform (`z.string().transform(Number)`, `v.pipe(v.string(), v.transform(Number))`) was rejected server-side. Only the router's parsed value (defaults, transforms, stripping applied) reaches the resolver; the client discards its own parse result.

## 0.1.0

### Minor Changes

- 2daa3ac: Rename to `typedport`, accept any Standard Schema, collapse to one leaf primitive and one transport function

  - The package is renamed from `@adelrodriguez/conduit` to `typedport` — typed trans**port**s, unscoped on npm.
  - Contract leaves now accept anything implementing [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType, ...) instead of Zod only. `zod` is no longer a peer dependency.
  - `procedure` and `event` collapse into a single `event` leaf: `event({ input, output })` is a round trip (result parsed against `output`), `event(schema)` is one-way (resolver result discarded, call typed `Promise<void>`).
  - Every leaf is directly callable on the client — `.publish()` is gone, and `publish` is no longer a reserved contract key. `defineContract` rejects keys containing a dot, which would silently collide with the equivalent nested path.
  - A transport is now a single function `(path, payload) => result` instead of a `{ request, send }` pair. `router.dispatch` is itself a valid transport, so `createMemoryTransport` is gone: `createClient(contract, router.dispatch)`.
  - Every failure the library raises is the new exported `TypeportError`, discriminated by `code` with typed fields per code: `validation` (the caller's input; Standard Schema `issues`), `output-validation` (the resolver's result drifted off contract — the server's fault; `issues`), `unknown-channel` (`path`), `timeout` (`path`, `timeoutMs`), `closed` (the close reason in `cause`), `no-router`, and `malformed-envelope` (`fromWire` received a non-envelope). Adapters branch on structured fields instead of message strings; anything that is not a `TypeportError` came from application code. The parse primitive is exported as `parseWith` for edge adapters that validate before their own publish paths.
  - The resolver map is typed by `InferResolvers` (replacing `InferHandlers`). Resolvers may be synchronous, and one-way resolvers may return a value (discarded by the router).
  - Resolvers receive a per-dispatch **context**: `createRouter<typeof contract, Session>(contract, resolvers)` types every resolver `(input, context)`, and the edge supplies it via `dispatch(path, raw, context)`. With the default `void` context the argument disappears and `dispatch` remains a valid two-argument transport. `connect` accepts a per-connection `context` option.
  - The client's `$schema` helper splits into `$input` and `$output`: `$input` is always the input schema (for a bare-schema leaf, the schema itself), `$output` is the output schema or `undefined` on one-way leaves.
  - Transports may declare a per-call `options` parameter (`Transport<Options>`, inferred from the transport function's annotation). Every leaf call accepts `(input, options?)`, and `$with(options)` on the root or any subtree returns the client with options bound (per-call shallow-merging over bound) — `api.$with({ method: "GET" }).todos.list()`, `api.$with({ signal }).files.open()`. With no options declared, the surface disappears.
  - New `typedport/wire` subpath export: `toWire`/`fromWire` are a symmetric codec for outcomes — `toWire(promiseOrThunk)` captures any operation's result or failure as a serializable envelope, `fromWire` takes `unknown`, validates the envelope shape (a proxy error page raises a clear error instead of an opaque `TypeError`), and unwraps it or rethrows (`TypeportError` crosses boundaries with its code and fields intact) — and `connect(wire, { router?, timeoutMs? })` turns any duplex message pipe into a symmetric transport with request/response correlation, per-call timeouts, and `close` teardown.
  - New `OneWayContract` type: adapters built on one-way delivery (queues, `webContents.send`) constrain their contract parameter to it, making a round-trip leaf a compile error.
