import * as z from "zod"
import { defineContract, channel } from "../../src/index.ts"

export const Todo = z.object({ done: z.boolean(), id: z.string(), title: z.string() })

export const contract = defineContract({
  telemetry: {
    pageView: channel(z.object({ route: z.string() })), // one-way
  },
  todos: {
    create: channel({ input: z.object({ title: z.string().min(1) }), output: Todo }),
    list: channel({ input: z.void(), output: z.array(Todo) }),
    toggle: channel({ input: z.object({ id: z.string() }), output: Todo }),
  },
})
