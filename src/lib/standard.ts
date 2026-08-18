import type { StandardSchemaV1 } from "@standard-schema/spec"

/**
 * Thrown when a value fails validation against a contract schema. Carries the Standard Schema
 * issues so adapters can tell bad input (reject the message, keep serving) apart from handler
 * failures (let them propagate).
 */
export class ValidationError extends Error {
  readonly issues: readonly StandardSchemaV1.Issue[]

  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super(issues.map((issue) => issue.message).join("; "))
    this.name = "ValidationError"
    this.issues = issues
  }
}

/**
 * Parses a value against any Standard Schema, throwing `ValidationError` on failure. This is the
 * single parse primitive the client and router use; edge adapters can reuse it to validate before
 * their own publish paths.
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
    throw new ValidationError(result.issues)
  }

  return result.value
}
