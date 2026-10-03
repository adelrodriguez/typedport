import * as z from "zod"
import { defineContract, channel } from "../../src/index.ts"

// A queue only delivers, it never answers, so every leaf is one-way: no
// `output` anywhere. The adapters in queue.ts enforce that with OneWayContract.
export const messages = defineContract({
  email: {
    welcome: channel(z.object({ email: z.email() })),
  },
  stripe: {
    checkout: {
      created: channel(z.object({ amount: z.number().int().positive(), id: z.string() })),
    },
  },
})

export const workflows = defineContract({
  reports: {
    generate: channel(z.object({ reportId: z.string() })),
  },
})
