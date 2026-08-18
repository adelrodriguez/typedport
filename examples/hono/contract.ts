import * as z from "zod"
import { defineContract, event } from "../../src/index.ts"

export const Todo = z.object({ done: z.boolean(), id: z.string(), title: z.string() })

export const contract = defineContract({
  telemetry: {
    pageView: event(z.object({ route: z.string() })), // one-way
  },
  todos: {
    create: event({ input: z.object({ title: z.string().min(1) }), output: Todo }),
    list: event({ input: z.void(), output: z.array(Todo) }),
    toggle: event({ input: z.object({ id: z.string() }), output: Todo }),
  },
})
