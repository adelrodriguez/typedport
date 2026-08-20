export function createRecursiveProxy(
  callback: (opts: { path: readonly string[]; args: readonly unknown[] }) => unknown,
  path: readonly string[]
): unknown {
  return new Proxy(
    () => {
      // dummy no-op function since we don't have any client-side target we want
      // to remap to
    },
    {
      apply(_1, _2, args) {
        return callback({ args, path })
      },
      get: (_obj, key) => {
        if (typeof key !== "string") {
          return
        }

        // Recursing on `then` would make every node thenable: `await
        // client.branch` dispatches "branch.then" and the await never settles.
        // Same probe pattern for JSON.stringify and `toJSON`. `defineContract`
        // rejects both keys, so nothing real is shadowed.
        if (key === "then" || key === "toJSON") {
          return
        }

        const nextPath = [...path, key]

        // `$`-prefixed helpers (e.g. `$path`, `$schema`) are accessed directly
        // as properties, so we invoke the callback immediately.
        if (key.startsWith("$")) {
          return callback({ args: [], path: nextPath })
        }

        // For all other keys, keep recursing and treat the final value as
        // a callable function (handled in the `apply` trap).
        return createRecursiveProxy(callback, nextPath)
      },
    }
  )
}
