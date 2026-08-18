import * as z from "zod"
import { defineContract, event } from "../../src/index.ts"

// client → server
export const contract = defineContract({
  math: {
    add: event({ input: z.object({ a: z.number(), b: z.number() }), output: z.number() }),
  },
})

// server → client
export const pushContract = defineContract({
  ticker: {
    tick: event(z.object({ count: z.number() })),
  },
})
