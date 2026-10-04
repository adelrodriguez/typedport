# How to split handlers across files

A flat resolver map passed to `createRouter` gets hard to read past a dozen channels. Use `implement()` to put each handler next to the code it belongs with, and assemble them in one place.

1. Create a builder from your contract, and declare the context type on it. This is the only place you write the context type.

   ```typescript
   // contract.ts
   import { implement } from "typedport"

   type Session = { userId: string }

   export const tp = implement(contract).$context<Session>()
   ```

   If your resolvers need no context, leave out `.$context<Session>()`.

2. Build each handler by calling its leaf on the builder. TypeScript infers the input, the return type, and the context. You write no annotations.

   ```typescript
   // files/handlers.ts
   import { tp } from "../contract"

   export const open = tp.files.open(async (_input, { context }) => openFile(context.userId))
   export const save = tp.files.save(async ({ contents, path }) => saveFile(path, contents))
   ```

3. Pass `createRouter` an object with the same shape as the contract. A namespace import of a handler module already has that shape.

   ```typescript
   // router.ts
   import { createRouter } from "typedport"
   import * as files from "./files/handlers"
   import { created } from "./stripe/handlers"

   export const router = createRouter(contract, {
     files,
     stripe: { checkout: { created } },
   })
   ```

`createRouter` reads the context type back from the handlers. You don't pass type arguments, and `router.dispatch` requires `{ context: Session }` as its third argument.

## What the compiler catches at assembly

- A missing handler is a missing property. The error names the leaf.
- A handler in the wrong slot is a type error. Each handler carries its dotted path in its type, so `save` can't fill the `open` slot.
- A handler from another contract is a type error, even when the paths match.
- A handler built without `$context` can't join a tree whose other handlers expect a `Session`.

Other exports in a handler module, such as helpers, are ignored. The router walks the contract, not the object you pass it.

## Keep a flat map with a context

If you prefer the flat map, pass the context type to `createRouter` explicitly:

```typescript
const router = createRouter<typeof contract, Session>(contract, {
  "files.open": async (_input, { context }) => openFile(context.userId),
  // ...
})
```

To declare the map away from the `createRouter` call, type it with `InferResolvers<typeof contract, Session>`.
