// 检查 lib/zcode.mjs 的营销投递解析（不联网：用假响应喂解析逻辑）。
import { describe, expect, test } from "bun:test"

// 复制 lib 里的解析规则（保持与实现一致：从序列化文本提取计划 id）
const PLAN_ID_RE = /zcode-v3-start-plan-[0-9a-z-]+/g
const extract = (delivery) => [...new Set(JSON.stringify(delivery).match(PLAN_ID_RE) ?? [])]

describe("marketing delivery 解析", () => {
  test("投递里 args.zcode_plan 的计划 id 能被提取", () => {
    const d = { id: "d1", action: "claim_zcode_plan", type: "popup", args: { zcode_plan: "zcode-v3-start-plan-1101-wk" } }
    expect(extract(d)).toEqual(["zcode-v3-start-plan-1101-wk"])
  })

  test("Trust Build 这种 kind 在前的 id 也能提取", () => {
    const d = { action: "claim_zcode_plan", args: { zcode_plan: "zcode-v3-start-plan-trust-1103" } }
    expect(extract(d)).toEqual(["zcode-v3-start-plan-trust-1103"])
  })

  test("没有计划 id 的普通公告不带出计划", () => {
    const d = { id: "d2", type: "banner", title: "双十一活动", msg: "敬请期待" }
    expect(extract(d)).toEqual([])
  })

  test("同一投递里重复的计划 id 去重", () => {
    const d = { args: { zcode_plan: "zcode-v3-start-plan-1101-wk" }, buttons: [{ args: { zcode_plan: "zcode-v3-start-plan-1101-wk" } }] }
    expect(extract(d)).toEqual(["zcode-v3-start-plan-1101-wk"])
  })

  test("一个投递里两个不同计划都提取", () => {
    const d = { args: { a: "zcode-v3-start-plan-1101-wk", b: "zcode-v3-start-plan-trust-1103" } }
    expect(extract(d).sort()).toEqual(["zcode-v3-start-plan-1101-wk", "zcode-v3-start-plan-trust-1103"])
  })
})
