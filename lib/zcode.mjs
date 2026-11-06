// ZCode account access: read the local sign-ins, see what a plan costs, and
// claim it. The credentials come from the ZCode client's own store (the same
// file the official magpie plugin reads) or from zcode-switch's snapshots.
import { createHash, createDecipheriv } from "node:crypto"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { compareVersions, normalizeVersion } from "./version.mjs"

const ORIGIN = "https://zcode.z.ai"

// ZCode 把运行时按版本分目录（…/provider/<plat>/<ver>/）。版本号随客户端升级变化，
// 硬编码会在 ZCode 升到 3.17 后失效，所以优先从目录名读，读不到才回退。
const detectAppVersion = () => {
  try {
    const root = join(homedir(), ".zcode", "v2", "runtime", "provider")
    for (const plat of readdirSync(root)) {
      const versions = readdirSync(join(root, plat))
        .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      if (versions.length) return versions[versions.length - 1]
    }
  } catch {}
  return process.env.ZCODE_GIFT_APP_VERSION || "3.17.2"
}

// 版本号必须按请求重取：服务端按 X-ZCode-App-Version 过滤活动投递，低于门槛
// 直接返回空 deliveries（code 0、HTTP 200，没有任何报错）。旧实现只在模块加载
// 时算一次，常驻 sidecar 会一直带着启动那一刻的版本号——客户端升级后就再也扫
// 不到新活动（2026-11-04：3.16.3 看不到 gb-1104，3.17.1 起才投递）。
//
// 远端来源（config.versionSource = github / mirror）拿到更新版本时取较大者：
// 本机没升级客户端，也能跟上服务端的版本门槛。
let remote = { version: "", via: "", error: "", at: 0 }
export const remoteVersionInfo = () => ({ ...remote })
export const noteRemoteVersion = ({ version, via = "", error = "" } = {}) => {
  const v = normalizeVersion(version)
  remote = {
    // 只记更高的版本：远端偶尔回旧 tag（缓存/镜像滞后）不该让面板倒退回旧值
    version: v && compareVersions(v, remote.version) >= 0 ? v : remote.version,
    via: via || remote.via,
    error,
    at: Date.now(),
  }
}

let versionCache = { at: 0, value: "" }
export const appVersion = () => {
  // 目录内容很少变，5 秒内复用，免得每次请求都 readdir
  if (!versionCache.value || Date.now() - versionCache.at > 5_000) {
    const local = detectAppVersion()
    versionCache = { at: Date.now(), value: compareVersions(remote.version, local) > 0 ? remote.version : local }
  }
  return versionCache.value
}

const readJSON = (p) => {
  try { return JSON.parse(readFileSync(p, "utf8")) } catch { return null }
}

// The key ZCode encrypts its credentials with: a hash of the machine and user.
const secret = () => {
  let name = ""
  try { name = userInfo().username } catch {}
  name = name.slice(name.lastIndexOf("\\") + 1)
  return createHash("sha256").update(`zcode-credential-fallback:${process.platform}:${homedir()}:${name}`).digest()
}

const decrypt = (key, v) => {
  if (typeof v !== "string" || !v.startsWith("enc:v1:")) return null
  const parts = v.slice(7).split(".")
  if (parts.length !== 3) return null
  try {
    const [iv, tag, data] = parts.map((p) => Buffer.from(p.replace(/=+$/, ""), "base64url"))
    const d = createDecipheriv("aes-256-gcm", key, iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(data), d.final()]).toString("utf8")
  } catch { return null }
}

// zcodeDir is where the ZCode client keeps credentials.json (it may have been
// moved by the client's own "data storage path" setting).
const zcodeDir = () => {
  const settingDir = join(homedir(), ".zcode", "v2")
  const moved = readJSON(join(settingDir, "setting.json"))?.dataBaseDir
  const base = typeof moved === "string" && moved.trim() ? moved.trim() : homedir()
  return join(base, ".zcode", "v2")
}

// jwtOf pulls the ZCode session token out of a credentials map, encrypted or
// not. ZCode 3.16 keeps zcodejwttoken in the clear.
export const jwtOf = (creds) => {
  const raw = typeof creds?.zcodejwttoken === "string" ? creds.zcodejwttoken : ""
  const v = decrypt(secret(), raw) ?? raw
  return v.replace(/^Bearer /, "").trim()
}

// clientAccount is the account the ZCode client is signed in to right now.
export const clientAccount = () => {
  const creds = readJSON(join(zcodeDir(), "credentials.json"))
  if (!creds) return null
  const jwt = jwtOf(creds)
  if (!jwt) return null
  return { name: "ZCode client", jwt, device: readJSON(join(zcodeDir(), "device-mid"))?.mid ?? undefined, creds }
}

// switchAccount returns every account zcode-switch keeps a snapshot of.
export const switchAccounts = () => {
  const dir = join(homedir(), ".zcode-switch", "accounts")
  if (!existsSync(dir)) return []
  const out = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue
    const snap = readJSON(join(dir, file))
    if (!snap?.credentials) continue
    const jwt = jwtOf(snap.credentials)
    if (!jwt) continue
    out.push({
      id: snap.id,
      name: snap.name ?? snap.id,
      jwt,
      device: snap.virtual_device_mid,
      provider: snap.credentials["oauth:active_provider"],
    })
  }
  return out
}

const headers = (jwt, device, extra = {}) => {
  const av = appVersion()
  return {
    Accept: "application/json",
    "User-Agent": `ZCode/${av}`,
    Authorization: `Bearer ${jwt}`,
    "X-Device-Mid": device || crypto.randomUUID(),
    "X-ZCode-App-Version": av,
    "X-Platform": `${process.platform}-${process.arch}`,
    ...extra,
  }
}

// 常驻 sidecar 没人盯着：任何上游请求都必须带超时，否则一个僵死的 TCP 连接
// 就能把整个 tick 挂住（页面侧表现为所有按钮"点了没反应"）。
const TIMEOUT_MS = 15_000
const fetchJSON = async (url, options = {}) => {
  const signals = [AbortSignal.timeout(TIMEOUT_MS)]
  if (options.signal) signals.push(options.signal)
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  const res = await fetch(url, { ...options, signal })
  return res
}

export const preview = async (jwt, device) => {
  const url = `${ORIGIN}/api/v1/zcode-plan/billing/preview?app_version=${appVersion()}&platform=${process.platform}-${process.arch}`
  const res = await fetchJSON(url, { headers: headers(jwt, device) })
  const body = await res.json().catch(() => null)
  if (body?.code !== 0) throw new Error(`preview HTTP ${res.status} code ${body?.code} ${body?.msg ?? ""}`)
  return body?.data?.plans ?? []
}

export const balance = async (jwt, device) => {
  const url = `${ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${appVersion()}`
  const res = await fetchJSON(url, { headers: headers(jwt, device) })
  const body = await res.json().catch(() => null)
  if (body?.code !== 0) throw new Error(`balance HTTP ${res.status} code ${body?.code} ${body?.msg ?? ""}`)
  return body?.data ?? { plans: [], balances: [] }
}

// claim asks for one plan. The captcha attestation is what the ZCode app
// sends; without it the server answers 3007 ("captcha verify failed").
export const claim = async (jwt, device, planId, attestation) => {
  const extra = {}
  if (attestation?.param) {
    extra["X-Aliyun-Captcha-Verify-Param"] = attestation.param
    if (attestation.region) extra["X-Aliyun-Captcha-Verify-Region"] = attestation.region
  }
  const res = await fetchJSON(`${ORIGIN}/api/v1/zcode-plan/billing/claim`, {
    method: "POST",
    headers: headers(jwt, device, { "Content-Type": "application/json", ...extra }),
    body: JSON.stringify({ plan_id: planId }),
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch {}
  const code = Number(body?.code)
  return { http: res.status, code, msg: body?.msg ?? "", data: body?.data ?? null, raw: text.slice(0, 300) }
}

// reportActivation tells ZCode the client is alive. The ZCode app does this on
// every launch, and zcode-switch does it too before a claim.
export const reportActivation = async (jwt, device, userId) => {
  const out = []
  for (const element of ["app_launch", "app_daily_active"]) {
    const body = {
      event_id: crypto.randomUUID(),
      client_timezone: "Asia/Shanghai",
      client_language: "zh",
      element_name: element,
      event_region: "app",
      event_type: "view",
      event_text: "",
      event_extra_detail: {},
      user_id: userId,
      screen_resolution: "2560x1440",
      app_version: appVersion(),
      device_os_category: "windows",
      device_os_version: "10.0",
      device_mid: device,
      mac_id: "",
      marketing_params: "{}",
    }
    try {
      const res = await fetchJSON(`${ORIGIN}/api/v1/event/report`, {
        method: "POST",
        headers: headers(jwt, device, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => null)
      out.push({ element, code: j?.code })
    } catch (e) {
      out.push({ element, error: e.message })
    }
  }
  return out
}

export const jwtSubject = (jwt) => {
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")).sub } catch { return "?" }
}

// —— 营销投递（活动卡）——
// ZCode 的「周末活动」这类活动不走 billing/preview，而是 /api/v1/marketing/touch
// 的 deliveries（二进制里能看到 action/args.zcode_plan/buttons 这些字段）。
// 这里的投递结构没有公开文档，所以从序列化文本里提取计划 id，避免猜 schema。
//
// 只认 "plan_id" 这个键的值：早先按全文匹配 zcode-v3-start-plan-*，会把
// entitlement_id（…-gb-1104-1）也当成计划，导致每轮对着一个不存在的 id
// 发一次领取（code 1001）外加一次验证码流程。
const PLAN_ID_RE = /"plan_id"\s*:\s*"(zcode-v3-start-plan-[0-9a-z-]+)"/g

export const marketingDeliveries = async (jwt, device) => {
  const rows = []
  for (const seq of [0, 1]) {
    const url = `${ORIGIN}/api/v1/marketing/touch?seq=${seq}`
    try {
      const res = await fetch(url, { headers: headers(jwt, device, { Accept: "application/json" }), signal: AbortSignal.timeout(15000) })
      const body = await res.json()
      if (body?.code !== 0) continue
      for (const d of body?.data?.deliveries ?? []) rows.push(d)
      if (!(body?.data?.deliveries ?? []).length) break // seq=1 只在 seq=0 有货时才有意义
    } catch {}
  }
  // 去重 + 提取可领计划
  const seen = new Set()
  const out = []
  for (const d of rows) {
    const text = JSON.stringify(d)
    const key = text.slice(0, 200)
    if (seen.has(key)) continue
    seen.add(key)
    const plans = [...new Set([...text.matchAll(PLAN_ID_RE)].map((m) => m[1]))]
    out.push({
      id: d?.id ?? null,
      action: d?.action ?? null,
      type: d?.type ?? null,
      title: d?.title ?? d?.name ?? d?.msg ?? null,
      plans,
      raw: text.slice(0, 400),
    })
  }
  return out
}
