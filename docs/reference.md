# API reference

typedport has four entry points:

- `typedport`
- `typedport/wire`
- `typedport/wire/message-port`
- `typedport/wire/web-socket`

## `typedport`

### `channel`

Creates one leaf of a contract.

| Form                         | Kind       | Client call resolves with              | Router does with the resolver's return value |
| ---------------------------- | ---------- | -------------------------------------- | -------------------------------------------- |
| `channel({ input, output })` | Round trip | The result                             | Parses it against `output`, then returns it  |
| `channel(schema)`            | One-way    | The transport's value, typed `unknown` | Discards it                                  |

Every schema is a [Standard Schema](https://standardschema.dev).

### `defineContract(tree)`

Returns `tree` unchanged. Branches are plain objects, and leaves are channels. The dotted path of a leaf is its keys joined with `.`, such as `files.open`.

`defineContract` throws a `SetupError` for these keys:

| Key              | Code           | Reason                                                                 |
| ---------------- | -------------- | ---------------------------------------------------------------------- |
| Starts with `$`  | `reserved-key` | The client uses `$` keys for helpers such as `$path`                   |
| `_kind`          | `reserved-key` | Marks a leaf                                                           |
| `then`, `toJSON` | `reserved-key` | Would make a client node look like a promise or break `JSON.stringify` |
| Contains `.`     | `dotted-key`   | Would collide with the dotted path of a nested leaf                    |

### `createRouter(contract, resolvers)`

Returns a `Router`. `resolvers` takes one of two shapes:

- A flat map from dotted path to resolver. The context type defaults to `void`. Use `createRouter.$context<Session>()` to fix it while inferring the contract, or pass both type arguments: `createRouter<typeof contract, Session>(contract, resolvers)`.
- A tree of handlers from `implement()` with the same shape as the contract. The context type comes from the handlers. Keys that aren't in the contract are ignored.

A missing resolver is a compile error. At runtime it throws a `SetupError` with code `missing-resolver`.

### `createRouter.$context<Context>()`

Returns a router factory with the context type fixed. Each call infers its contract, so one edge can reuse the factory across feature contracts without repeating `typeof contract`:

```typescript
const createSessionRouter = createRouter.$context<Session>()

const filesRouter = createSessionRouter(filesContract, {
  "files.open": async ({ context }) => openFile(context.userId),
  // ...
})
const notesRouter = createSessionRouter(notesContract, {
  // ...
})
```

The factory accepts both flat resolver maps and handler trees from `implement()`. Handler fragments must accept the fixed context type. Missing leaves, misplaced fragments, and resolver input/output types are checked as with `createRouter`.

This is a type-level operation, not a bound context value. `dispatch` still requires `{ context }` when the fixed type isn't `void`. The original `createRouter` keeps its default `void` context and handler-tree inference.

### `mergeRouters(...routers)`

Returns one `Router` that serves every router passed to it. Use it to pass an app with one router per feature to an edge that takes a single router, such as an IPC loop or `connect`.

- `channels` lists every router's channels.
- `dispatch` passes the call, with its `context` and `signal`, to the router that owns the path. That router parses input and output as usual. A path no router owns throws a `ChannelError` with code `unknown-channel`.
- The context type is the intersection of the routers' context types. Routers without a context add nothing, so merging only context-free routers keeps `dispatch` a valid `Transport`.
- Every router receives the context the call carries, including context-free routers merged beside routers that need one. Their resolvers are typed `void`, so don't rely on `context` being `undefined` in them.
- The result is a `Router`, so you can merge it again.

A channel that two routers declare throws a `SetupError` with code `duplicate-channel` when `mergeRouters` runs.

### Resolvers

A resolver takes one object, `({ input, context, signal }) => result`, and destructures what it needs. It may be synchronous or async.

`input` is the router's parsed value, with defaults and transforms applied.

| Option    | Description                                                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context` | The `context` the edge passed to `dispatch`. `undefined` when the context type is `void`, unless the router is merged with one that needs a context |
| `signal`  | Aborts when the caller gives up. Always present. Never aborts if the edge passed none                                                               |

### `Router`

| Property                          | Description                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `channels`                        | Every dotted path in the contract                                                                    |
| `dispatch(path, input, options?)` | Parses `input`, runs the resolver, parses a round-trip result against `output`, and resolves with it |

`options` is a `DispatchOptions`, `{ context, signal }`. It is required when the context type isn't `void`, and optional otherwise. When it is optional, `dispatch` is a valid `Transport` that accepts `{ signal }`.

If `signal` aborts, `dispatch` rejects with `signal.reason`, even if the resolver ignores the signal. If `signal` has already aborted, the resolver doesn't start.

`dispatch` throws a `ChannelError` with code `unknown-channel`, `validation`, or `output-validation`. Any other error comes from the resolver.

### `implement(contract)`

Returns a builder with the same shape as the contract. Each leaf on the builder is a function that takes a resolver and returns a `Fragment` for that leaf.

| Member             | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| `$context<T>()`    | Returns the same builder with the context type set to `T`                 |
| `<leaf>(resolver)` | Returns a `Fragment` that carries the leaf's dotted path and context type |

`isFragment(value)` returns `true` for a fragment.

### `createClient(contract, transport)`

Returns a client with the same shape as the contract. Every leaf is a function:

```typescript
client.files.save(input) // without transport options
client.files.save(input, options) // with transport options
```

Before it calls the transport, the leaf parses `input` and rejects with a `ChannelError` with code `validation` on failure. It then sends `input` as the caller wrote it, not the parsed value.

The call resolves with whatever the transport returns, without parsing it. A one-way leaf is typed `Promise<unknown>` and resolves with the transport's raw value, such as a queue receipt, or `undefined` over `router.dispatch`.

Every node has these properties:

| Property         | On     | Value                                                                               |
| ---------------- | ------ | ----------------------------------------------------------------------------------- |
| `$path`          | Leaves | The dotted path                                                                     |
| `$input`         | Leaves | The input schema                                                                    |
| `$output`        | Leaves | The output schema, or `undefined` on a one-way leaf                                 |
| `$with(options)` | All    | The same client with `options` bound. Exists only if the transport declares options |

Options passed to a call are shallow-merged over bound options.

Nodes are stable. `client.files === client.files` is `true`.

`then` and `toJSON` are `undefined` on every node. Awaiting a node returns the node, and no call is made.

### `Transport<Options>`

```typescript
type Transport<Options = never> = (
  path: string,
  payload: unknown,
  options?: Options
) => unknown | Promise<unknown>
```

`createClient` takes `Options` from the annotation on the transport's third parameter. With `Options = never`, the client has no options.

### `parseWith(schema, value)`

Parses `value` with a Standard Schema and resolves with the parsed value. Rejects with a `ChannelError` with code `validation` on failure. The client and the router use this function.

### `flatten(contract)`

Returns an object from dotted path to `Channel`. The object has no prototype. Use `Object.hasOwn(result, path)` to test for a path.

### `isChannel(node)`

Returns `true` if `node` is a leaf.

### `ChannelError`

The class of every failure that typedport raises during a call. `code` selects the extra fields.

| `code`               | Raised when                                                    | Extra fields        |
| -------------------- | -------------------------------------------------------------- | ------------------- |
| `validation`         | The input fails its schema                                     | `issues`            |
| `output-validation`  | A round-trip resolver returns a value that fails `output`      | `issues`            |
| `unknown-channel`    | The path isn't in the contract                                 | `path`              |
| `internal`           | `toWire` or `connect` hid a failure from the caller            |                     |
| `timeout`            | A `connect` call gets no response within `timeoutMs`           | `path`, `timeoutMs` |
| `closed`             | A `connect` session closes, or a socket closes before it opens | `cause`             |
| `no-router`          | A request reaches a `connect` end that has no router           |                     |
| `malformed-envelope` | `fromWire` receives a value that isn't a `WireResult`          |                     |

`issues` holds the Standard Schema issues.

### `SetupError`

The class of every wiring mistake. It is thrown when you build something, and it never crosses the wire.

| `code`              | Raised when                                                                | Extra fields           |
| ------------------- | -------------------------------------------------------------------------- | ---------------------- |
| `reserved-key`      | A contract key is reserved                                                 | `key`, `path`          |
| `dotted-key`        | A contract key contains `.`                                                | `key`, `path`          |
| `missing-resolver`  | A contract leaf has no resolver                                            | `path`                 |
| `duplicate-channel` | Two routers passed to `mergeRouters` declare the same channel              | `path`                 |
| `invalid-handler`   | A handler tree has a non-fragment at a leaf, or a non-object at a branch   | `expected`, `path`     |
| `misplaced-handler` | A fragment sits at a path other than its own                               | `fragmentPath`, `path` |
| `no-window`         | `receivePort` or `relayPort` gets no `target` and finds no global `window` | `caller`               |

### Types

| Type                                       | Describes                                               |
| ------------------------------------------ | ------------------------------------------------------- |
| `ContractTree`                             | Any contract                                            |
| `OneWayContract`                           | A contract whose leaves have no `output`                |
| `Channel`                                  | One leaf                                                |
| `InferClient<typeof contract>`             | The client type for a contract                          |
| `InferResolvers<typeof contract, Context>` | The flat resolver map for a contract                    |
| `Resolver<Leaf, Context>`                  | The resolver for one leaf                               |
| `ResolverArgs<Input, Context>`             | A resolver's argument, `{ input, context, signal }`     |
| `Router<Context>`                          | The value `createRouter` and `mergeRouters` return      |
| `DispatchOptions<Context>`                 | The third argument of `dispatch`, `{ context, signal }` |
| `Implementer`, `Fragment`, `FragmentTree`  | The builder, its handlers, and a tree of handlers       |
| `ChannelErrorDetail`, `SetupErrorDetail`   | The `code` and extra fields of each error class         |

## `typedport/wire`

### `toWire(operation, options?)`

Takes a promise, or a function that may throw synchronously. Resolves with a `WireResult`. Never throws.

`toWire` hides failures by default. These cross with their message, code, and fields:

- a `ChannelError` with code `validation`, `unknown-channel`, `no-router`, or `internal`
- any error for which `options.expose` returns `true`

Every other failure crosses as a `ChannelError` with code `internal`. `toWire` passes the original error to `options.onHidden`.

### `ExposeOptions`

`toWire` and `connect` both take these options.

| Option     | Type                          | Description                                                                                   |
| ---------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `expose`   | `(error: unknown) => boolean` | Returns `true` for a failure the caller may see as-is. If it throws, the failure stays hidden |
| `onHidden` | `(error: unknown) => void`    | Receives every hidden failure. If it throws, the error is ignored                             |

### `fromWire(value)`

Takes `unknown`. If `value` is a successful `WireResult`, returns its result. If it is a failed `WireResult`, throws the error. A `ChannelError` is rebuilt as a `ChannelError` with its code and fields. Any other error is rebuilt as an `Error` with the original `name` and `message`.

Throws a `ChannelError` with code `malformed-envelope` if `value` isn't a valid `WireResult`.

### `WireResult`

```typescript
type WireResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { detail?: ChannelErrorDetail; message: string; name: string } }
```

`detail` is present when the error was a `ChannelError`.

### `connect(wire, options?)`

Turns a `Wire` into a transport for calling the peer, and serves the peer's calls with `router`.

| Option      | Type                          | Description                                                                                                                                                |
| ----------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `router`    | `Router<Context>`             | Serves calls from the peer. Without it, the peer's calls fail with `no-router`                                                                             |
| `context`   | `Context`                     | Passed to every dispatch this end serves                                                                                                                   |
| `timeoutMs` | `number`                      | Fails a call with `timeout` after this many milliseconds. Defaults to 30 seconds. `Infinity` disables it, so a call to a dead peer settles only on `close` |
| `signal`    | `AbortSignal`                 | Closes the session when it aborts, with the signal's reason                                                                                                |
| `expose`    | `(error: unknown) => boolean` | Decides which failures this end sends to the peer as-is                                                                                                    |
| `onHidden`  | `(error: unknown) => void`    | Receives the failures this end hides from the peer                                                                                                         |

`connect` returns an object with these properties:

| Property         | Description                                                       |
| ---------------- | ----------------------------------------------------------------- |
| `transport`      | A `Transport<{ signal?: AbortSignal }>` that calls the peer       |
| `close(reason?)` | Closes the session. `reason` may be any value                     |
| `closed`         | Resolves with the `closed` `ChannelError` once the session closes |

A call's `signal` rejects that call with `signal.reason` and drops its late reply. When a call is aborted or hits `timeoutMs`, `connect` tells the peer, and the peer aborts the `signal` its resolver received.

`wire` may be a `Wire` or a `Promise<Wire>`. While the promise is pending, calls wait in a queue, and `timeoutMs` applies to them. A queued call that is aborted or times out is never sent. If the promise rejects, the session closes with the rejection as its reason.

When the session closes, every pending call and every later call rejects with a `ChannelError` with code `closed` and the reason as `cause`. This end stops serving and aborts every resolver it is running.

### `Wire`

```typescript
type Wire = {
  send: (data: unknown) => void
  onMessage: (listener: (data: unknown) => void) => void | (() => void)
}
```

If `onMessage` returns a function, `close` calls it to unsubscribe.

## `typedport/wire/message-port`

Every parameter is typed by shape. You don't need Electron or DOM types installed.

| Export                                   | Runs in                      | Description                                                                 |
| ---------------------------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `mainPort(port)`                         | Main, utility                | Wraps an Electron `MessagePortMain` as a `Wire`                             |
| `domPort(port)`                          | Renderer, iframe, web worker | Wraps a DOM `MessagePort` as a `Wire`                                       |
| `nodePort(port)`                         | Node                         | Wraps a `node:worker_threads` port, a `Worker`, or `parentPort` as a `Wire` |
| `sendPort(win, port, type)`              | Main                         | Posts `port` to `win` once its page has loaded                              |
| `relayPort(ipcRenderer, type, options?)` | Preload                      | Forwards every port that arrives on the IPC channel `type` into the page    |
| `receivePort(type, options?)`            | Renderer                     | Resolves with the first port relayed on `type`                              |

`mainPort` and `domPort` start the port after they attach their listener.

`sendPort` posts immediately if the page has finished loading, and otherwise waits for `did-finish-load`.

`relayPort` takes these options:

| Option         | Description                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `signal`       | Stops the relay when it aborts                                                                              |
| `target`       | The window to post to. Defaults to the global `window`                                                      |
| `targetOrigin` | The origin to post to. Defaults to the window's own origin, or `"*"` for an opaque origin such as `file://` |

`receivePort` takes these options:

| Option   | Description                                              |
| -------- | -------------------------------------------------------- |
| `signal` | Rejects the wait with `signal.reason` when it aborts     |
| `target` | The window to listen on. Defaults to the global `window` |

`receivePort` accepts a message only if it comes from the same window, has the type `type`, and carries a port.

If `relayPort` or `receivePort` gets no `target` and there is no global `window`, it throws a `SetupError` with code `no-window`.

## `typedport/wire/web-socket`

| Export              | Description                                                                       |
| ------------------- | --------------------------------------------------------------------------------- |
| `webSocket(socket)` | Wraps a browser `WebSocket`, a Node `WebSocket`, or a `ws` socket as a `Wire`     |
| `whenOpen(socket)`  | Resolves with `socket` once it can send. Rejects with `closed` if it closes first |

`webSocket` sends JSON frames. Payloads must survive `JSON.stringify`.

`whenOpen` removes its listeners once it settles. On a `ws` socket, Node throws on an unhandled `error` event, so attach your own `error` listener.
