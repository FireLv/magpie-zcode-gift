// Auto-claim runner for ZCode gift plans.
//
// The plan of record for one batch (say "zcode-v3-start-plan-1030-wk") is a
// per-account entitlement: every account that is eligible gets its own copy
// with its own user_plan_id. The client claims it on launch for whichever
// account it is signed in to, so an account the client never opens never gets
// it. This runner does what the client does, for any account, and can also
// report which accounts are missing a batch their peers already hold.
//
//   node claim.mjs status            read-only: every account and its plans
//   node claim.mjs claim <account>   claim what that account is missing
import { balance, claim, jwtSubject, preview, reportActivation, switchAccounts, clientAccount } from "./lib/zcode.mjs"
import { attestation, captchaConfig } from "./lib/captcha.mjs"

const fmt = (t) => (t ? new Date(t * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "-")

const accounts = () => {
  const out = []
  const client = clientAccount()
  if (client) out.push({ id: "client", name: "ZCode 客户端当前登录", jwt: client.jwt, device: client.device, isClient: true })
  for (const a of switchAccounts()) {
    if (client && client.jwt === a.jwt) continue // the same account, twice
    out.push({ ...a, isClient: false })
  }
  return out
}

// batchOf reads the batch a plan belongs to: "zcode-v3-start-plan-1030-wk" is
// the 1030 batch. Two accounts holding the same batch hold the same gift.
const batchOf = (planId) => {
  const m = /^zcode-v3-start-plan-([0-9]{4})/.exec(planId ?? "")
  return m ? m[1] : null
}

const status = async () => {
  const list = accounts()
  const seen = new Map() // batch -> plan_id, from whoever already holds it
  const rows = []
  for (const a of list) {
    let plans = []
    let err = null
    try { plans = (await balance(a.jwt, a.device)).plans ?? [] } catch (e) { err = e.message }
    for (const p of plans) {
      const b = batchOf(p.plan_id)
      if (b && !seen.has(b)) seen.set(b, p.plan_id)
    }
    rows.push({ a, plans, err })
  }
  console.log("=== 各账号持有的套餐 ===")
  for (const { a, plans, err } of rows) {
    console.log(`\n[${a.name}]${a.isClient ? " (客户端当前)" : ""} sub=${jwtSubject(a.jwt)}`)
    if (err) { console.log("  读取失败:", err); continue }
    if (!plans.length) console.log("  (无套餐)")
    for (const p of plans) {
      const e = p.entitlements?.[0]
      console.log(`  ${p.plan_id}  ${p.status}  units=${e?.grant_units ?? "-"}  起=${fmt(p.starts_at)}  生效=${fmt(e?.effective_at)}  过期=${fmt(p.ends_at)}`)
    }
  }
  console.log("\n=== 批次缺席判定（客户端从未登录 → 永远领不到）===")
  for (const { a, plans, err } of rows) {
    if (err) continue
    const held = new Set(plans.map((p) => batchOf(p.plan_id)).filter(Boolean))
    const missing = [...seen.keys()].filter((b) => !held.has(b))
    if (!missing.length) { console.log(`  [${a.name}] 无缺席批次`); continue }
    for (const b of missing) {
      const planId = `zcode-v3-start-plan-${b}-wk`
      const previewPlans = await preview(a.jwt, a.device).catch(() => [])
      const inPreview = previewPlans.some((p) => p.plan_id === planId)
      console.log(`  [${a.name}] 缺批次 ${b} (${planId})  preview可见=${inPreview}  → ${inPreview ? "可领取" : "服务端未下发/已被领"}`)
    }
  }
  return rows
}

const runClaim = async (name) => {
  const list = accounts()
  const target = list.find((a) => a.name === name || a.id === name || a.name.includes(name))
  if (!target) { console.error("no such account:", name); console.error("known:", list.map((a) => a.name).join(", ")); process.exit(2) }
  console.log(`目标账号: ${target.name} (sub=${jwtSubject(target.jwt)})`)

  const bal = await balance(target.jwt, target.device)
  const held = new Set((bal.plans ?? []).map((p) => batchOf(p.plan_id)).filter(Boolean))

  // Which plan should this account have? The peers tell us the batch.
  const peers = []
  for (const a of list) {
    if (a.id === target.id) continue
    const b = await balance(a.jwt, a.device).catch(() => ({ plans: [] }))
    for (const p of b.plans ?? []) {
      const bt = batchOf(p.plan_id)
      if (bt && !held.has(bt)) peers.push({ batch: bt, plan_id: p.plan_id })
    }
  }
  const seen = new Set()
  const wanted = peers.filter((p) => (seen.has(p.batch) ? false : (seen.add(p.batch), true)))

  const listed = await preview(target.jwt, target.device).catch(() => [])
  console.log("preview 可领:", listed.map((p) => p.plan_id).join(", ") || "(空)")
  console.log("按同批次推断应领:", wanted.map((w) => `${w.batch} → ${w.plan_id}`).join(", ") || "(无)")

  const target_ = wanted[0] ?? (listed[0] ? { batch: batchOf(listed[0].plan_id), plan_id: listed[0].plan_id } : null)
  if (!target_) { console.log("没有可领的计划（preview 空且无同批次缺席）"); return }

  console.log(`\n=== 领取 ${target_.plan_id} ===`)
  console.log("上报激活事件:", JSON.stringify(await reportActivation(target.jwt, target.device, jwtSubject(target.jwt))))

  console.log("取 captcha attestation ...")
  const cfg = await captchaConfig({ token: target.jwt })
  const att = await attestation(cfg)
  console.log("attestation ok, len", att.param.length)

  const r = await claim(target.jwt, target.device, target_.plan_id, att)
  console.log("claim ->", JSON.stringify({ http: r.http, code: r.code, msg: r.msg }))
  if (r.code === 0) {
    const after = await balance(target.jwt, target.device)
    const p = (after.plans ?? []).find((x) => x.plan_id === target_.plan_id)
    console.log("领取后:", p ? `${p.plan_id} status=${p.status} units=${p.entitlements?.[0]?.grant_units} 生效=${fmt(p.entitlements?.[0]?.effective_at)} 过期=${fmt(p.ends_at)}` : "未在 balance 中看到")
  } else if (r.code === 1003) console.log("已领过（target already exists）")
  else if (r.code === 3007) console.log("captcha verify failed —— attestation 未被接受")
  else if (r.code === 1001) console.log("target not found —— 服务端不认这个计划")
  else console.log("原始响应:", r.raw)
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === "status") await status()
else if (cmd === "claim") await runClaim(arg)
else { console.log("usage: node claim.mjs status | claim <account>"); await status() }
