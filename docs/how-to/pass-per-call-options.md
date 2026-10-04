# How to pass per-call options

Some settings belong to a single call but not to its payload. Examples are an `AbortSignal`, an Electron transfer list, and an HTTP method. Declare them on the transport, and every leaf on the client accepts them.

1. Add a third, optional parameter to your transport function, and annotate its type. The client takes the options type from this annotation.

   ```typescript
   const api = createClient(contract, async (path, payload, options?: { signal?: AbortSignal }) => {
     return await send(path, payload, options?.signal)
   })
   ```

2. Pass the options after the input:

   ```typescript
   await api.files.save(file, { signal: controller.signal })
   ```

## Bind options to a branch

To apply the same options to many calls, bind them with `$with`. It works on the root and on any branch, and it returns the same client with the options attached:

```typescript
const cancellable = api.$with({ signal: controller.signal })

await cancellable.files.open()
await cancellable.stripe.checkout.created({ id: "evt_123" })
```

`$with` also saves you from writing `undefined` as the input of a leaf whose input is `void`.

When a call passes options and options are also bound, the call's options are shallow-merged over the bound ones.

If the transport declares no options parameter, calls take only the input and the client has no `$with`.

`router.dispatch` and the transport from `connect` already accept `{ signal }`. To use it, see [How to cancel a call](./cancel-calls.md).
