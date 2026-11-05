// 常驻 sidecar：本地 HTTP API + 定时驱动 runner + 页面快照投喂。
// 由 index.mjs 在插件加载时拉起（wb-plus 模式）；页面本身不能联网，
// 靠本服务把快照写进 page/data.js 供页面读取。
import { createServer } from "node:http"
import { writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, saveConfig, clearRecords, dataDir, loadSnapshot, writeSnapshot } from "./lib/store.mjs"
import { tick } from "./runner.mjs"
import { appVersion } from "./lib/zcode.mjs"
import { VERSION_SOURCES } from "./lib/version.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.ZCODE_GIFT_PORT) || 3455

let running = false
let lastTickAt = 0
let lastResult = null
// 面板可见性信号：page-target / page-seen 每次刷新它。
// 已收工账号的余量刷新跟随它；未收工账号的领取探测不受影响。
let lastPageSeen = 0
const PANEL_TTL = 12 * 60_000
const panelActive = () => Date.now() - lastPageSeen < PANEL_TTL

const cadence = (cfg) => Math.max(1, Number(cfg.intervalMin) || 10) * 60_000

const pageDataFile = () => join(here, "page", "data.js")

// 把快照投喂给页面（沙箱页面唯一的数据入口）
const feedPage = async () => {
  const snap = (await import("./lib/store.mjs")).loadSnapshot()
  const body = `window.__ZG__ = ${JSON.stringify({ port: PORT, updated: Date.now(), snapshot: snap })};\n`
  try { writeFileSync(pageDataFile(), body) } catch (e) { console.error("[zcode-gift] data.js:", e.message) }
}

const drive = async ({ force = false, panelActive: panelActiveOverride } = {}) => {
  if (running) return lastResult
  running = true
  try {
    lastResult = await tick({ force, panelActive: panelActiveOverride ?? panelActive() })
    lastTickAt = Date.now()
    await feedPage()
  } catch (e) {
    console.error("[zcode-gift] tick:", e?.message ?? e)
  } finally {
    running = false
  }
  return lastResult
}

const json = (res, code, value) => {
  const body = JSON.stringify(value)
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  // 只听本机回环；API 调用方需带标记头（页面不联网，不受影响）
  if (req.socket.remoteAddress && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) {
    return json(res, 403, { error: "local only" })
  }
  try {
    if (url.pathname === "/api/status") {
      const { loadSnapshot } = await import("./lib/store.mjs")
      return json(res, 200, { ok: true, port: PORT, av: appVersion(), lastTickAt, running, pageSeenAt: lastPageSeen || null, pageActive: panelActive(), snapshot: loadSnapshot() })
    }
    if (url.pathname === "/api/config" && req.method === "POST") {
      lastPageSeen = Date.now() // 面板上保存设置：人显然在看
      let body = ""
      for await (const chunk of req) body += chunk
      const patch = JSON.parse(body || "{}")
      const cfg = loadConfig()
      const next = { ...cfg }
      if (typeof patch.enabled === "boolean") next.enabled = patch.enabled
      if (Number.isFinite(Number(patch.intervalMin))) next.intervalMin = Math.min(180, Math.max(1, Number(patch.intervalMin)))
      if (patch.unitStyle === "zh" || patch.unitStyle === "si") next.unitStyle = patch.unitStyle
      if (VERSION_SOURCES.includes(patch.versionSource)) next.versionSource = patch.versionSource
      if (typeof patch.claimClientAccount === "boolean") next.claimClientAccount = patch.claimClientAccount
      if (patch.__clearRecords) { clearRecords() }
      if (typeof patch.id === "string") next.lastRequest = patch.id
      saveConfig(next)
      if (patch.__clearRecords) clearRecords()
      await drive() // 立即按新配置跑一轮：刷新快照（enabled/nextRun）并开始/停止领取
      return json(res, 200, { ok: true, config: next })
    }
    if (url.pathname === "/api/run" && req.method === "POST") {
      lastPageSeen = Date.now() // 面板上点「立即领取」：人显然在看，收工账号也全量探测
      const r = await drive({ force: true, panelActive: true })
      return json(res, 200, { ok: true, ...r })
    }
    if (url.pathname === "/api/records/clear" && req.method === "POST") {
      clearRecords()
      await feedPage()
      return json(res, 200, { ok: true })
    }
    if (url.pathname === "/api/page-target" && req.method === "POST") {
      // 插件每次被 magpie 加载都会叫醒本服务：只标记「面板在看」。
      // 切到面板的立即补刷由面板的 wake 信号（/api/page-seen wake:true）负责，
      // 这里不补刷——心跳也会经此路由，避免每次心跳多出一轮 tick。
      lastPageSeen = Date.now()
      await feedPage()
      return json(res, 200, { ok: true })
    }
    if (url.pathname === "/api/page-seen" && req.method === "POST") {
      // 面板切回本页的唤醒信号（board.js 的 rAF 可见性检测发出）：
      // wake=true → 补一轮让余量立刻是新的（45 秒防抖，防反复切换打爆接口）；
      // wake=false → 保活心跳，仅维持「面板在看」。
      // 都只影响余量刷新——领取任务由 interval 按 intervalMin 独立轮询。
      let body = ""
      for await (const chunk of req) body += chunk
      const patch = JSON.parse(body || "{}")
      lastPageSeen = Date.now()
      if (typeof patch.id === "string" && patch.id) {
        const cfg = loadConfig()
        if (cfg.lastRequest !== patch.id) {
          saveConfig({ ...cfg, lastRequest: patch.id })
          // 快照同步：页面靠快照 config.lastRequest 确认请求已被处理并清理它，
          // 心跳不触发 drive，必须在这里把 id 补进快照
          const snap = loadSnapshot()
          if (snap?.config) {
            snap.config.lastRequest = patch.id
            writeSnapshot(snap)
          }
        }
      }
      await feedPage()
      if (patch.wake && (!lastTickAt || Date.now() - lastTickAt > 45_000)) await drive({ panelActive: true })
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: "no route" })
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e) })
  }
})

// 本文件只会被当作 sidecar 主入口运行（index.mjs spawn 它）：直接起服务。
server.listen(PORT, "127.0.0.1", async () => {
  console.log(`[zcode-gift] sidecar on http://127.0.0.1:${PORT}`)
  await drive()
  setInterval(() => {
    const cfg = loadConfig()
    // 领取任务按 intervalMin 独立轮询，与面板是否可见无关；
    // panelActive 只影响「已收工账号」的余量刷新（见 runner.tick）。
    if (Date.now() >= lastTickAt + cadence(cfg)) drive({ panelActive: panelActive() })
    else feedPage()
  }, 30_000)
})

export { server, drive, feedPage }
