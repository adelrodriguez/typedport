# About validation and trust

typedport makes one promise on every transport: no resolver runs on input that hasn't been parsed. This page explains where the parsing happens, why input gets parsed twice, and what the library leaves to you.

## Why input is parsed twice

The client parses the input before it calls the transport. The router parses it again when it arrives. That looks like waste, but each parse serves a different person.

The client's parse is for the developer making the call. A bad input throws at the call site, with a stack trace that points at the line that made it. Without it, the error would come back from the other side of the boundary, stripped of anything useful.

The client throws its parsed value away and sends the input as the caller wrote it. Only the router's parsed value reaches the resolver. If the client sent its parsed value, a transform such as `z.string().transform(Number)` would turn `"21"` into `21` on the client, and the router's schema would then reject the number. The cost is that transform callbacks run on both sides, so keep them free of side effects.

The router's parse is for the server. The sender might not be your client at all. In Electron, a compromised renderer can call `ipcRenderer.invoke` with anything it likes. On the web, anyone can `curl` your endpoint. So the router treats every input as hostile, whatever the client did. The router's parse is the security boundary. The client's parse is a convenience, and you could delete it without opening a hole.

## Why results are parsed once

The router parses a round-trip resolver's return value against `output` before sending it. A resolver that drifts off contract fails on the server, as `output-validation`, where the bug lives. The caller never sees the bad value.

The client doesn't parse results. When a typedport router is on the other end, the router already did, and parsing again would cost time for nothing. But when something else answers, such as a plain HTTP endpoint or a test mock, the client's return type is only a claim. If you don't trust the peer, parse the result yourself. Every round-trip leaf carries its output schema as `$output`:

```typescript
import { parseWith } from "typedport"

const raw = await api.files.open()
const file = await parseWith(api.files.open.$output, raw)
```

## Who proves the sender's identity

Not typedport. Parsing proves that a message has the right shape. It says nothing about who sent it. That job belongs to the transport, because only the transport knows what identity means at its boundary.

- An HTTP edge checks a session cookie, a bearer token, or a signature such as QStash's `Upstash-Signature` header.
- An Electron edge relies on process identity. It can also check `event.senderFrame`, and it can use `router.channels` as an allowlist of IPC channel names.

Whatever the edge learns, it passes to the resolvers as context.

## Why failures are hidden by default

An error message can leak a lot: a file path, a SQL fragment, the shape of your data. `output-validation` is a sharp case. Its `issues` describe the value your own resolver returned, which is server data the caller never asked for.

So `toWire` and `connect` decide what the caller may see. A failure that is the caller's fault crosses intact, because the caller needs it to fix the call and it reveals nothing about the server. That covers `validation`, `unknown-channel`, and `no-router`. Everything else crosses as a `ChannelError` with code `internal`, and the real error goes to `onHidden` for your logs.

The default favors the public server, where the caller might be anyone. Between your own processes, such as a worker and the main thread, hiding errors only makes debugging harder. Pass `expose: () => true` there. To expose only some errors, such as a "not found", return `true` for those.

## Why a queue can't serve a round-trip channel

A message queue delivers a message and returns a receipt. It never returns the resolver's result. If a leaf served by a queue declares `output`, the client resolves with the receipt as if it were the result, and nothing at runtime can tell the difference.

The library can't catch this at runtime, so it catches it at compile time. `OneWayContract` accepts only contracts with no `output` on any leaf. Adapters built on one-way delivery should take their contract as `OneWayContract`.
