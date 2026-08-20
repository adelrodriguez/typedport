import * as z from "zod"
import { defineContract, channel } from "../../src/index.ts"

// client → server
export const contract = defineContract({
  math: {
    add: channel({ input: z.object({ a: z.number(), b: z.number() }), output: z.number() }),
  },
})

// server → client
export const pushContract = defineContract({
  ticker: {
    tick: channel(z.object({ count: z.number() })),
  },
})
