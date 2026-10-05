---
"typedport": minor
---

Resolvers take one object, `{ input, context, signal }`, instead of `input` plus `{ context, signal }`. A resolver that ignores its input no longer needs a placeholder parameter. Before: `(_input, { context }) => ...` and `({ id }, { signal }) => ...`. After: `({ context }) => ...` and `({ input: { id }, signal }) => ...`. `ResolverOptions<Context>` is renamed to `ResolverArgs<Input, Context>`.
