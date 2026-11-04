// Claim the gift plans of every account, one account at a time.
//
// The ZCode client claims a gift for whichever account it is signed in to, on
// launch. An account the client never opens therefore never gets it, and one
// whose captcha failed (observed 2026-10-30) never gets it either. This
// runner does what the client does, for every account it knows about.
//
//   node sweep.mjs            read-only: what every account holds and misses
//   node sweep.mjs --claim    claim what is missing, account by account
//   node sweep.mjs --claim <account>   only that one
import { balance, claim, clientAccount, jwtSubject, preview, reportActivation, switchAccounts } from "./lib/zcode.mjs"
import { attestation, captchaConfig } from "./lib/captcha.mjs"
import { candidatesFor, reconcile } from "./lib/reconcile.mjs"

const fmt = (t) => (t ? new Date(t * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "-")

// The accounts we know: the one the ZCode client is signed in to, and the
// snapshots zcode-switch keeps.
export const knownAccounts = () => {
  const out = []
  const client = clientAccount()
  if (client?.jwt) out.push({ id: "client", name: "ZCode 客户端当前登录", jwt: client.jwt, device: client.device, source: "client" })
  for (const a of switchAccounts()) {
    if (client && client.jwt === a.jwt) continue
    out.push({ ...a, source: "zcode-switch" })
  }
  return out
}

const load = async (list) => {
  const rows = []
  for (const a of list) {
    try {
      const bal = await balance(a.jwt, a.device)
      rows.push({ ...a, plans: bal.plans ?? [], error: null })
    } catch (e) {
      rows.push({ ...a, plans: [], error: e.message })
    }
  }
  return rows
}

const report = async (rows, live) => {
  console.log("=== 每号实况 ===")
  for (const r of rows) {
    console.log(`\n[${r.name}]${r.source === "client" ? " (客户端)" : ""} sub=${jwtSubject(r.jwt)}`)
    if (r.error) { console.log("  读取失败:", r.error); continue }
    if (!r.plans.length) console.log("  (无套餐)")
    for (const p of r.plans) {
      const e = p.entitlements?.[0]
      console.log(`  ✓ ${p.plan_id} ${p.status} ${e?.grant_units ?? "-"} token  生效=${fmt(e?.effective_at)}  过期=${fmt(p.ends_at)}`)
    }
    if (!r.missing.length) { console.log("  无缺失批次"); continue }
    for (const m of r.missing) {
      const listed = await preview(r.jwt, r.device).then((p) => p.some((x) => x.plan_id === m.planId)).catch(() => false)
      console.log(`  ✗ 缺批次 ${m.batch} → ${m.planId}   preview可见=${listed}`)
    }
  }
}

// claimFor tries the plan ids an account may be missing, newest batch first.
const claimFor = async (acc, missing, live) => {
  const results = []
  const listed = await preview(acc.jwt, acc.device).catch(() => [])
  for (const m of missing) {
    const ids = candidatesFor(m, live)
    let done = false
    for (const planId of ids) {
      console.log(`    尝试 ${planId} ...`)
      await reportActivation(acc.jwt, acc.device, jwtSubject(acc.jwt))
      const cfg = await captchaConfig({ token: acc.jwt })
      const att = await attestation(cfg)
      const r = await claim(acc.jwt, acc.device, planId, att)
      console.log(`      → http ${r.http} code ${r.code} ${r.msg || ""}`)
      results.push({ account: acc.name, planId, code: r.code, msg: r.msg })
      if (r.code === 0) { done = true; break }
      if (r.code === 1003) { done = true; break } // already claimed
      if (r.code === 1001) continue // the server does not know this id; try the next kind
      if (r.code === 3007) { console.log("      captcha 被拒，换一次 attestation 重试"); continue }
    }
    if (!done) console.log(`    批次 ${m.batch} 未领到`)
  }
  return results
}

const main = async () => {
  const argv = process.argv.slice(2)
  const wantClaim = argv.includes("--claim")
  const only = argv.find((a) => !a.startsWith("--"))

  const list = knownAccounts()
  if (only) {
    const picked = list.filter((a) => a.name === only || a.id === only || a.name.includes(only))
    if (!picked.length) { console.error("没有这个账号。可用：", list.map((a) => a.name).join(", ")); process.exit(2) }
    list.length = 0
    list.push(...picked)
  }

  const rows = await load(list)
  const { rows: reconciled, batches } = reconcile(rows)
  await report(reconciled, batches)

  if (!wantClaim) {
    console.log("\n(只读模式。加 --claim 执行领取)")
    return
  }

  console.log("\n=== 开始领取 ===")
  const all = []
  for (const r of reconciled) {
    if (!r.missing.length) { console.log(`\n[${r.name}] 无缺失，跳过`); continue }
    console.log(`\n[${r.name}] 待领 ${r.missing.length} 个批次`)
    all.push(...(await claimFor(r, r.missing, batches)))
  }
  console.log("\n=== 汇总 ===")
  for (const x of all) {
    const label = x.code === 0 ? "已领取" : x.code === 1003 ? "已领过" : x.code === 1001 ? "计划不存在" : x.code === 3007 ? "captcha 被拒" : "失败"
    console.log(`  ${label.padEnd(6)} ${x.account} ${x.planId}${x.msg ? " (" + x.msg + ")" : ""}`)
  }
  console.log("\n=== 领取后复核 ===")
  const after = await load(knownAccounts())
  for (const a of after) {
    console.log(`\n[${a.name}]`)
    for (const p of a.plans) {
      const e = p.entitlements?.[0]
      console.log(`  ${p.plan_id} ${p.status} ${e?.grant_units ?? "-"} token 生效=${fmt(e?.effective_at)} 过期=${fmt(p.ends_at)}`)
    }
  }
}

await main()
