import * as z from "zod"
import { defineContract, channel } from "../../src/index.ts"

export const contract = defineContract({
  primes: {
    count: channel({
      input: z.object({ below: z.number().int().positive() }),
      output: z.number(),
    }),
  },
})
