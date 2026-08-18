import { describe, expect, test } from "vitest"
import * as z from "zod"
import { defineContract, event, type OneWayContract } from "../contract"
import { flatten } from "../utils"

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

const acceptsOneWay = (tree: OneWayContract) => tree

describe("OneWayContract", () => {
  test("accepts one-way trees and rejects round-trip leaves at compile time", () => {
    const oneWay = defineContract({
      stripe: { checkout: { created: event(z.object({ id: z.string() })) } },
    })

    expect(acceptsOneWay(oneWay)).toBe(oneWay)

    // @ts-expect-error a leaf with an `output` schema is a round trip, not one-way
    acceptsOneWay(defineContract({ ask: event({ input: z.string(), output: z.string() }) }))
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
