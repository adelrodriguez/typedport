import * as z from "zod"
import { defineContract, event } from "../../src/index.ts"

export const contract = defineContract({
  primes: {
    count: event({
      input: z.object({ below: z.number().int().positive() }),
      output: z.number(),
    }),
  },
})
