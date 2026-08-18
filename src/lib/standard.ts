import type { StandardSchemaV1 } from "@standard-schema/spec"
import { TypeportError } from "./error"

/**
 * Parses a value against any Standard Schema, throwing `TypeportError` (code `validation`, issues
 * attached) on failure. This is the single parse primitive the client and router use; edge
 * adapters can reuse it to validate before their own publish paths.
 */
export async function parseWith<Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown
): Promise<StandardSchemaV1.InferOutput<Schema>> {
  let result = schema["~standard"].validate(value)

  if (result instanceof Promise) {
    result = await result
  }

  if (result.issues) {
    throw new TypeportError({ code: "validation", issues: result.issues })
  }

  return result.value
}
