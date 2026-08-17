import { describe, expect, test } from "bun:test"
import * as z from "zod"
import { defineContract, event, procedure } from "../lib/contract"
import { flatten } from "../lib/utils"

describe("defineContract", () => {
  test("returns the tree unchanged", () => {
    const tree = {
      localFiles: {
        open: procedure({ input: z.void(), output: z.string() }),
      },
    }

    expect(defineContract(tree)).toBe(tree)
  })

  test.each(["$path", "$schema", "publish", "_kind"])("rejects reserved key %s", (key) => {
    expect(() =>
      defineContract({
        stripe: { [key]: event(z.object({ id: z.string() })) },
      })
    ).toThrow(`Reserved key "${key}" at "stripe.${key}"`)
  })

  test("rejects reserved keys used as branches", () => {
    expect(() =>
      defineContract({
        publish: { created: event(z.object({ id: z.string() })) },
      })
    ).toThrow('Reserved key "publish"')
  })
})

describe("flatten", () => {
  test("flattens nested leaves into dotted paths", () => {
    const open = procedure({ input: z.void(), output: z.string() })
    const created = event(z.object({ id: z.string() }))

    const result = flatten({
      localFiles: { open },
      stripe: { checkout: { created } },
    })

    expect(Object.keys(result).toSorted()).toEqual(["localFiles.open", "stripe.checkout.created"])
    expect(result["localFiles.open"]).toBe(open)
    expect(result["stripe.checkout.created"]).toBe(created)
  })
})
