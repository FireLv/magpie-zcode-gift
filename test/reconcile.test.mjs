// Tests for the reconciliation: which account is missing which batch.
//
// The case that matters is the one observed on 2026-10-30: an account whose
// gift was never claimed still gets an EMPTY preview, so preview cannot be
// the only source of truth.
import { describe, expect, test } from "bun:test"
import { batchOf, candidatesFor, planIdFor, reconcile } from "../lib/reconcile.mjs"

const plan = (planId, units = 500000000) => ({
  plan_id: planId,
  status: "active",
  entitlements: [{ show_name: "GLM-5.3-Flash", grant_units: units, effective_at: 1793372400 }],
})

describe("batchOf", () => {
  test("reads the date and the kind out of a plan id", () => {
    expect(batchOf("zcode-v3-start-plan-1030-wk")).toEqual({ batch: "1030", kind: "wk" })
    expect(batchOf("zcode-v3-start-plan-trust-1006")).toEqual({ batch: "1006", kind: "trust" })
    expect(batchOf("zcode-v3-start-plan-0817")).toEqual({ batch: "0817", kind: "" })
  })

  test("an id that is not a plan id has no batch", () => {
    expect(batchOf("some-other-plan")).toBeNull()
    expect(batchOf(undefined)).toBeNull()
  })
})

describe("reconcile", () => {
  test("an account that holds a batch is not missing it", () => {
    const { rows } = reconcile([
      { id: "a", name: "a", plans: [plan("zcode-v3-start-plan-1030-wk")] },
      { id: "b", name: "b", plans: [plan("zcode-v3-start-plan-1030-wk")] },
    ])
    expect(rows.every((r) => r.missing.length === 0)).toBe(true)
  })

  test("an account that never claimed is missing the batch its peers hold", () => {
    const { rows } = reconcile([
      { id: "a", name: "a", plans: [plan("zcode-v3-start-plan-1030-wk")] },
      { id: "b", name: "b", plans: [] },
    ])
    expect(rows[1].missing).toEqual([{ batch: "1030", kind: "wk", planId: "zcode-v3-start-plan-1030-wk" }])
    expect(rows[0].missing).toEqual([])
  })

  test("the plan id a missing account should ask for comes from a peer", () => {
    const { rows } = reconcile([
      { id: "a", name: "a", plans: [plan("zcode-v3-start-plan-1030-wk")] },
      { id: "b", name: "b", plans: [] },
    ])
    expect(candidatesFor(rows[1].missing[0], [{ batch: "1030", kind: "wk", planId: "zcode-v3-start-plan-1030-wk" }]))
      .toEqual(["zcode-v3-start-plan-1030-wk"])
  })

  test("without a peer the known gift kinds are tried, wk first", () => {
    const c = candidatesFor({ batch: "1030", kind: "" }, [])
    expect(c[0]).toBe(planIdFor("1030", "wk"))
    expect(c).toContain("zcode-v3-start-plan-1030-trust")
  })

  test("a Trust Build id keeps the kind in front of the date", () => {
    expect(batchOf("zcode-v3-start-plan-trust-1006")).toEqual({ batch: "1006", kind: "trust" })
    expect(candidatesFor({ batch: "1006", kind: "trust" }, []))
      .toEqual(["zcode-v3-start-plan-1006-trust"])
  })

  test("two batches are two separate gifts", () => {
    const { rows, batches } = reconcile([
      { id: "a", name: "a", plans: [plan("zcode-v3-start-plan-1030-wk"), plan("zcode-v3-start-plan-0817")] },
      { id: "b", name: "b", plans: [plan("zcode-v3-start-plan-1030-wk")] },
    ])
    expect(batches.map((b) => b.batch).sort()).toEqual(["0817", "1030"])
    expect(rows[1].missing.map((m) => m.batch)).toEqual(["0817"])
  })

  test("an account that holds nothing and has no peers misses nothing", () => {
    const { rows } = reconcile([{ id: "b", name: "b", plans: [] }])
    expect(rows[0].missing).toEqual([])
  })
})
