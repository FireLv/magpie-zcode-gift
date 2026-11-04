// 领取任务引擎：轮询全部账号 → 有可领礼包即自动领取 → 写记录与快照。
// 由 server.mjs（常驻 sidecar）按配置的间隔驱动；enabled=false 时只刷新快照不领取。
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadConfig, loadRecords, addRecords, saveConfig, writeSnapshot, loadDaily, saveDaily } from "./lib/store.mjs"
import { preview, balance, claim, jwtSubject, reportActivation, marketingDeliveries, appVersion, noteRemoteVersion, remoteVersionInfo } from "./lib/zcode.mjs"
import { fetchLatestVersion, VERSION_SOURCES } from "./lib/version.mjs"
import { attestation, captchaConfig } from "./lib/captcha.mjs"
import { batchOf } from "./lib/reconcile.mjs"
import { fmtTokens } from "./lib/units.mjs"

// 插件自身版本（面板展示用）：直接读同目录的 package.json
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version ?? "" } catch { return "" }
})()

// —— 账号来源 ——

// 账号源：magpie 里 zcode 供应商的登录态（上游 @magpie-community/opencode-zcode-auth 管的那批），
// 与 wb-plus 同构——它读 workbuddy 前缀，我们读 zcode 前缀。refresh 里存着 jwt/device。
const magpieAuthFile = () => {
  const root = process.env.ZCODE_GIFT_MAGPIE_DIR
    || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie")
  return join(root, "plugin-auth.json")
}

const parseJwt = (jwt) => {
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) } catch { return {} }
}
const jwtExpired = (jwt) => {
  const exp = parseJwt(jwt)?.exp
  return Number(exp) > 0 && exp * 1000 < Date.now() + 60_000
}

export const providerAccounts = () => {
  const out = []
  try {
    const store = JSON.parse(readFileSync(magpieAuthFile(), "utf8"))
    for (const [key, value] of Object.entries(store)) {
      // zcode 供应商的登录：zcode（跟随客户端）/ zcode#xxxx（OAuth 登录）
      const provider = key.split("#")[0]
      if (provider !== "zcode") continue
      let state = {}
      try { state = typeof value.refresh === "string" ? JSON.parse(value.refresh) : value.refresh } catch {}
      if (!state?.jwt) continue
      const uid = parseJwt(state.jwt)?.sub
      out.push({
        key,
        id: uid ? `zcode:${uid}` : key,
        name: String(value.accountId || key).replace(/^zcode#?/, "zcode") || "ZCode",
        site: state.site ?? "zai",
        jwt: state.jwt,
        device: state.device,
        source: "magpie-zcode",
      })
    }
  } catch {}
  return out
}

export const allAccounts = () => {
  // 账号源只有一处：magpie 里 zcode 供应商的登录（上游 zcode 插件管的那批）。
  // 不再并入 zcode-switch 快照，也不再单独读 ZCode 客户端凭据——
  // 「zcode 供应商的 ZCode 登录」本身就是跟随客户端的那条。
  const list = providerAccounts()
  const seen = new Set()
  const out = []
  for (const a of list) {
    const uid = parseJwt(a.jwt)?.sub ?? a.jwt
    if (seen.has(uid)) continue
    seen.add(uid)
    out.push(a)
  }
  return out
}

// —— 带限速重试的调用 ——

const with429 = async (fn) => {
  try { return await fn() } catch (e) {
    if (!/429/.test(String(e?.message))) throw e
    await new Promise((r) => setTimeout(r, 1500))
    return fn()
  }
}
const apiPreview = (a) => with429(() => preview(a.jwt, a.device))
const apiBalance = (a) => with429(() => balance(a.jwt, a.device))

// —— 领取一次 ———

const claimPlan = async (account, plan, cfg) => {
  const entry = { time: new Date().toISOString(), account: account.name, plan: plan.plan_id, units: plan.grant_units ?? null, status: "failed", reason: "" }
  try {
    await reportActivation(account.jwt, account.device, jwtSubject(account.jwt))
    const cfgCaptcha = await captchaConfig({ token: account.jwt })
    const att = await attestation(cfgCaptcha)
    const r = await claim(account.jwt, account.device, plan.plan_id, att)
    entry.code = r.code
    if (r.code === 0) { entry.status = "claimed" }
    else if (r.code === 1003) { entry.status = "done"; entry.reason = "已领过（target already exists）" }
    else if (r.code === 3007) { entry.status = "captcha"; entry.reason = "人机验证被拒：" + (r.msg || "3007") }
    else { entry.status = "failed"; entry.reason = `code ${r.code} ${r.msg}`.trim() }
  } catch (e) {
    entry.reason = String(e?.message ?? e).slice(0, 200)
  }
  return entry
}

// —— 版本号来源 ——

// 服务端按 X-ZCode-App-Version 过滤活动投递，版本越新越不容易被挡。
// 本地目录只看得到"已装过的版本"，这里按配置从 GitHub / 国内加速站补一个最新 tag，
// 与本地取较大者。60 秒节流，失败保留上次成功的值（只记错误，不倒退）。
let lastVersionFetch = 0
const refreshVersion = async (cfg) => {
  const source = VERSION_SOURCES.includes(cfg?.versionSource) ? cfg.versionSource : "github"
  if (source === "local") return null
  if (Date.now() - lastVersionFetch < 60_000) return null
  lastVersionFetch = Date.now()
  try {
    const hit = await fetchLatestVersion({ source })
    noteRemoteVersion({ version: hit.version, via: hit.via })
    return hit
  } catch (e) {
    noteRemoteVersion({ error: String(e?.message ?? e).slice(0, 120) })
    return null
  }
}

// —— 当日领取台账 ——

// 本地日期（Asia/Shanghai 机器上的本地日），跨天自然清零
const dayKey = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 批次键：同一个礼包的变体 id 归到一起。
//   zcode-v3-start-plan-gb-1104     -> "1104|gb"
//   zcode-v3-start-plan-gb-1104-1   -> "1104|gb"（entitlement 尾巴，活动投递里会带出来）
//   zcode-v3-start-plan-1029        -> "1029|"
// 解析不出来就退回 id 本身。
const claimKey = (planId) => {
  const id = String(planId ?? "")
  const direct = batchOf(id)
  if (direct) return `${direct.batch}|${direct.kind}`
  const b = batchOf(id.replace(/-\d+$/, ""))
  return b ? `${b.batch}|${b.kind}` : id
}

const trimDaily = (daily) => {
  const keep = Object.keys(daily).sort().slice(-3) // 只留最近 3 天
  const out = {}
  for (const k of keep) out[k] = daily[k]
  return out
}

// —— 主流程 ——

export const tick = async ({ force = false } = {}) => {
  const cfg = loadConfig()
  await refreshVersion(cfg)
  const accounts = allAccounts()
  const now = Date.now()
  const nextRun = () => new Date(now + Math.max(1, Number(cfg.intervalMin) || 10) * 60_000).toISOString()

  const accountViews = []
  const records = []
  let claimedNow = 0
  let activitySeen = 0

  // 当天已领过的批次：同一账号同一批次，今天不再打领取接口
  const day = dayKey()
  const daily = loadDaily()
  const todayDone = (daily[day] ??= {})
  let skippedDaily = 0
  let dailyWrite = false

  for (const a of accounts) {
    const view = { name: a.name, site: a.site, source: a.source, expired: jwtExpired(a.jwt), plans: [], pending: [] }
    try {
      const bal = await apiBalance(a)
      const plans = bal?.plans ?? []
      const eff = (p) => p.entitlements?.[0]
      for (const p of plans) {
        const e = eff(p) ?? {}
        view.plans.push({
          plan: p.plan_id, name: p.name || p.plan_id, status: p.status,
          units: e.grant_units ?? null, effective: e.effective_at ? e.effective_at * 1000 : null,
          ends: p.ends_at ? p.ends_at * 1000 : null,
          starts: p.starts_at ? p.starts_at * 1000 : null,
        })
      }
      // 各模型桶的实时用量（used/remaining 随每次 tick 刷新）
      view.buckets = (bal?.balances ?? []).map((x) => ({
        show: x.show_name ?? "", plan: x.plan_id ?? "",
        used: Number.isFinite(Number(x.used_units)) ? Number(x.used_units) : null,
        remaining: Number.isFinite(Number(x.remaining_units)) ? Number(x.remaining_units) : null,
        total: Number.isFinite(Number(x.total_units)) ? Number(x.total_units) : null,
        expires: Number(x.expires_at) > 0 ? x.expires_at * 1000 : null,
      }))
      // 每个礼包的已用量 = 它名下各模型桶之和（用于面板「礼包/总量/已用/开始/过期」）
      {
        const usedByPlan = new Map()
        const totalByPlan = new Map()
        for (const b of view.buckets ?? []) {
          if (!b.plan) continue
          usedByPlan.set(b.plan, (usedByPlan.get(b.plan) ?? 0) + (Number(b.used) || 0))
          totalByPlan.set(b.plan, (totalByPlan.get(b.plan) ?? 0) + (Number(b.total) || 0))
        }
        for (const p of view.plans) {
          p.used = usedByPlan.has(p.plan) ? usedByPlan.get(p.plan) : null
          if (!p.units && totalByPlan.has(p.plan)) p.units = totalByPlan.get(p.plan)
        }
      }
      // 活动投递（marketing/touch）：周末活动这类「活动卡」不走 preview，
      // 只看 preview 会漏掉——10-31 客户端弹框但 preview 为空就是这个原因。
      let activities = []
      try {
        activities = await marketingDeliveries(a.jwt, a.device)
        view.activities = activities.filter((d) => d.plans.length)
        if (view.activities.length) activitySeen++
      } catch {}
      if (cfg.enabled || force) {
        const listed = await apiPreview(a).catch(() => [])
        const fresh = (Array.isArray(listed) ? listed : []).filter((p) => typeof p?.plan_id === "string" && p.plan_id.trim())
        // preview 的计划 + 活动投递里的计划，一起去重后尝试领取
        const wanted = new Map()
        for (const p of fresh) wanted.set(p.plan_id, p.entitlements?.[0]?.grant_units ?? null)
        for (const d of view.activities ?? []) {
          for (const planId of d.plans) if (!wanted.has(planId)) wanted.set(planId, null)
        }
        const held = new Set((view.plans ?? []).map((p) => p.plan))
        const done = (todayDone[a.id] ??= {})
        for (const [planId, grant] of wanted) {
          if (!cfg.enabled && !force) break
          if (held.has(planId)) continue // 已持有，不再打领取接口
          const ck = claimKey(planId)
          if (done[ck]) { skippedDaily++; continue } // 今天已领过这一批，不再重复
          const r = await claimPlan(a, { plan_id: planId, grant_units: grant }, cfg)
          if (r.status === "claimed") claimedNow++
          if (r.status === "claimed" || r.status === "done") {
            done[ck] = Date.now()
            dailyWrite = true
          }
          records.push(r)
        }
      }
    } catch (e) {
      view.error = String(e?.message ?? e).slice(0, 160)
    }
    accountViews.push(view)
  }

  // 已领取 = 账号当前【实际持有】的礼包（balance 为准，不依赖插件执行记录）
  // 礼包判定：plan id 带种类后缀（wk / trust…）的才算礼包；基础 Start Plan 不算
  const heldGifts = []
  for (const v of accountViews) {
    for (const p of v.plans ?? []) {
      const b = batchOf(p.plan)
      if (!b?.kind) continue
      heldGifts.push({ account: v.name, planId: p.plan, name: p.name, units: p.units ?? 0, starts: p.starts })
    }
  }

  // 一次性存量导入：记录为空且启用前账号已持有礼包时，按服务端 starts_at 补成记录
  if (!cfg.bootstrapped) {
    const existing = loadRecords()
    if (!existing.length && heldGifts.length) {
      addRecords(heldGifts.map((h) => ({
        time: new Date(h.starts || Date.now()).toISOString(),
        account: h.account, plan: h.planId, units: h.units, status: "done",
        reason: "已持有（面板启用前由客户端或脚本领取）",
      })))
    }
    saveConfig({ ...cfg, bootstrapped: true })
  }

  if (dailyWrite) saveDaily(trimDaily(daily))

  const all = records.length ? addRecords(records) : loadRecords()
  const stats = {
    accounts: accountViews.length,
    claimedCount: heldGifts.length,
    claimedTokens: heldGifts.reduce((s, h) => s + (Number(h.units) || 0), 0),
    success: all.filter((r) => r.status === "claimed" || r.status === "done").length,
    failed: all.filter((r) => r.status === "failed" || r.status === "captcha").length,
    nextRun: cfg.enabled ? nextRun() : null,
    enabled: !!cfg.enabled,
    claimedNow,
    activities: activitySeen,
    skippedDaily,
  }

  const rv = remoteVersionInfo()
  writeSnapshot({
    updated: Date.now(),
    config: { enabled: cfg.enabled, intervalMin: cfg.intervalMin, unitStyle: cfg.unitStyle, versionSource: cfg.versionSource },
    version: { plugin: PLUGIN_VERSION, app: appVersion(), source: cfg.versionSource, remote: rv.version, via: rv.via, error: rv.error, checkedAt: rv.at || null },
    stats, accounts: accountViews, records: all.slice(-100).reverse(),
  })
  return { stats, records }
}
