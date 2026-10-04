export type MaybePromise<T> = Promise<T> | T

/**
 * The dotted path of `Key` under `Prefix` — the type-level twin of `joinPath`.
 */
export type Join<Prefix extends string, Key extends string> = Prefix extends ""
  ? Key
  : `${Prefix}.${Key}`
