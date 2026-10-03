---
"typedport": minor
---

`toWire` now hides failures by default. Caller-fault `ChannelError`s (`validation`, `unknown-channel`, `no-router`) cross intact. Everything else, including application errors and `output-validation`, crosses as a `ChannelError` with the new code `internal`. Pass `expose: (error) => boolean` to let more through and `onHidden` to log what was hidden. `connect` hides the same way and takes the same options; pass `expose: () => true` for a trusted peer.

`connect` is now cancellable. Its transport takes `{ signal }` per call, so `api.$with({ signal })` aborts one call: it rejects with `signal.reason` and a late reply is dropped. `connect(wire, { signal })` closes the session when the signal aborts (`close(reason)` now accepts any value, like an abort reason), and the returned `closed` promise resolves with the `closed` `ChannelError`.

`receivePort` and `relayPort` take an options object instead of a positional `target`: `receivePort(type, { signal, target })` and `relayPort(ipcRenderer, type, { signal, target, targetOrigin })`. `receivePort`'s signal bounds the wait, and `relayPort`'s stops the relay, so `PortIpcRendererLike` now requires `removeListener`. `relayPort` posts to the window's own origin instead of `"*"`, and falls back to `"*"` only for opaque origins such as `file://`.
