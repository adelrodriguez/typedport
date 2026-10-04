# How to serve a contract over HTTP

This guide serves every channel from one fetch handler and calls it with `fetch`. The handler works in any framework that accepts a fetch handler, such as Hono, Next.js route handlers, Bun, and Deno. [`examples/hono`](../../examples/hono) is a running version.

Both sides use the envelope from `typedport/wire`. With it, a validation failure on the server reaches the client as a `ChannelError` with its code and `issues`.

## Write the server handler

The handler takes the channel name from the last URL segment, dispatches the request body, and wraps the outcome with `toWire`.

`toWire` hides server-side failures by default. A resolver that throws, or returns a value that fails `output`, reaches the caller as a `ChannelError` with code `internal`. `toWire` passes the real error to `onHidden`, so you can log it.

```typescript
import { toWire } from "typedport/wire"

const handle = async (request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname.split("/").at(-1) ?? ""

  if (!router.channels.includes(path)) {
    return new Response("Unknown channel", { status: 404 })
  }

  // JSON has no undefined, so the client sends null for void inputs.
  // Map it back so z.void() leaves still parse.
  const wire = await toWire(router.dispatch(path, (await request.json()) ?? undefined), {
    onHidden: (error) => console.error(error),
  })

  if (wire.ok) {
    return Response.json(wire, { status: 200 })
  }

  return Response.json(wire, { status: wire.error.detail?.code === "validation" ? 400 : 500 })
}
```

## Write the client transport

The transport posts the payload and unwraps the response with `fromWire`:

```typescript
import { createClient } from "typedport"
import { fromWire } from "typedport/wire"

const api = createClient(contract, async (path, payload) => {
  const response = await fetch(`${baseUrl}/${path}`, {
    body: JSON.stringify(payload ?? null),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  return fromWire(await response.json())
})
```

To let the caller see an error that `toWire` would hide, such as a "not found" error, pass `expose`:

```typescript
toWire(router.dispatch(path, payload), {
  expose: (error) => error instanceof NotFoundError,
  onHidden: (error) => console.error(error),
})
```

`fromWire` reads success from the envelope, not from the status code. The status codes exist for logs and middleware.

If a proxy returns an HTML error page instead of an envelope, `fromWire` throws a `ChannelError` with code `malformed-envelope`.

Put auth headers, retries, and anything else HTTP-specific in the transport function. The rest of typedport never sees them.
