// 常驻 sidecar：本地 HTTP API + 定时驱动 runner + 页面快照投喂。
// 由 index.mjs 在插件加载时拉起（wb-plus 模式）；页面本身不能联网，
// 靠本服务把快照写进 page/data.js 供页面读取。
import { createServer } from "node:http"
import { writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, saveConfig, clearRecords, dataDir } from "./lib/store.mjs"
import { tick } from "./runner.mjs"
import { appVersion } from "./lib/zcode.mjs"
import { VERSION_SOURCES } from "./lib/version.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.ZCODE_GIFT_PORT) || 3455

let running = false
let lastTickAt = 0
let lastResult = null

const pageDataFile = () => join(here, "page", "data.js")

// 把快照投喂给页面（沙箱页面唯一的数据入口）
const feedPage = async () => {
  const snap = (await import("./lib/store.mjs")).loadSnapshot()
  const body = `window.__ZG__ = ${JSON.stringify({ port: PORT, updated: Date.now(), snapshot: snap })};\n`
  try { writeFileSync(pageDataFile(), body) } catch (e) { console.error("[zcode-gift] data.js:", e.message) }
}

const drive = async ({ force = false } = {}) => {
  if (running) return lastResult
  running = true
  try {
    lastResult = await tick({ force })
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
      return json(res, 200, { ok: true, port: PORT, av: appVersion(), lastTickAt, running, snapshot: loadSnapshot() })
    }
    if (url.pathname === "/api/config" && req.method === "POST") {
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
      const r = await drive({ force: true })
      return json(res, 200, { ok: true, ...r })
    }
    if (url.pathname === "/api/records/clear" && req.method === "POST") {
      clearRecords()
      await feedPage()
      return json(res, 200, { ok: true })
    }
    if (url.pathname === "/api/page-target" && req.method === "POST") {
      // 插件每次被 magpie 加载都会叫醒本服务；顺带刷新一次快照
      await feedPage()
      if (!lastTickAt || Date.now() - lastTickAt > 60_000) await drive()
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
    const cadence = Math.max(1, Number(cfg.intervalMin) || 10) * 60_000
    // 快照刷新与领取同节奏：每 interval 分钟真正调一次 API，间隔期只投喂页面
    if (Date.now() >= lastTickAt + cadence) drive()
    else feedPage()
  }, 30_000)
})

export { server, drive, feedPage }
