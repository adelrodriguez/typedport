import { describe, expect, test } from "bun:test"
import * as z from "zod"
import { defineContract, event } from "../lib/contract"
import { flatten } from "../lib/utils"

describe("event", () => {
  test("a bare schema builds a one-way leaf", () => {
    const schema = z.object({ id: z.string() })
    const leaf = event(schema)

    expect(leaf.input).toBe(schema)
    expect(leaf.output).toBeUndefined()
  })

  test("input and output build a round-trip leaf", () => {
    const input = z.void()
    const output = z.string()
    const leaf = event({ input, output })

    expect(leaf.input).toBe(input)
    expect(leaf.output).toBe(output)
  })
})

describe("defineContract", () => {
  test("returns the tree unchanged", () => {
    const tree = {
      localFiles: {
        open: event({ input: z.void(), output: z.string() }),
      },
    }

    expect(defineContract(tree)).toBe(tree)
  })

  test.each(["$path", "$schema", "_kind"])("rejects reserved key %s", (key) => {
    expect(() =>
      defineContract({
        stripe: { [key]: event(z.object({ id: z.string() })) },
      })
    ).toThrow(`Reserved key "${key}" at "stripe.${key}"`)
  })

  test("rejects reserved keys used as branches", () => {
    expect(() =>
      defineContract({
        $helpers: { created: event(z.object({ id: z.string() })) },
      })
    ).toThrow('Reserved key "$helpers"')
  })

  test("allows publish as an ordinary key", () => {
    const tree = defineContract({
      publish: { created: event(z.object({ id: z.string() })) },
    })

    expect(Object.keys(flatten(tree))).toEqual(["publish.created"])
  })
})

describe("flatten", () => {
  test("flattens nested leaves into dotted paths", () => {
    const open = event({ input: z.void(), output: z.string() })
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
