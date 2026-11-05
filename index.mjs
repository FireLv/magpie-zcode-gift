// zcode-gift：ZCode 礼包助手（本地插件，不上仓库）。
//
// 定位（与 magpie-workbuddy-plus 同构）：只做上游 zcode 供应商【不做】的两件事——
//   1. 自动识别礼包（billing/preview + marketing 活动投递 + 跨账号批次比对）
//   2. 自动领取（阿里云人机验证走隐藏有头 Chrome 的无痕通道；上游插件按契约不碰验证码）
// 外加一个面板：账号/持有/成功失败/领取记录/间隔设置/用量小卡片。
//
// 账号来源不自己造：直接读 magpie 里 zcode 供应商的登录态（plugin-auth.json 的 zcode / zcode#*），
// 另可并上 zcode-switch 的账号快照（客户端够不着的号）。本插件不注册供应商、不做 OAuth。
//
// 结构：本文件是「带路 + 工具」层；真正的任务与数据在常驻 sidecar（server.mjs + runner.mjs）。
import { spawn } from "node:child_process"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { loadSnapshot } from "./lib/store.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const portOf = (options) => {
  const p = Number(options?.port ?? options?.page?.service?.port)
  return Number.isFinite(p) && p > 0 ? p : 3455
}
const base = (port) => `http://127.0.0.1:${port}`

// 页面快照：沙箱页面不能联网，靠这个文件投喂
const feedDataFile = (port) => {
  try {
    const snap = loadSnapshot()
    mkdirSync(join(here, "page"), { recursive: true })
    writeFileSync(join(here, "page", "data.js"), `window.__ZG__ = ${JSON.stringify({ port, updated: Date.now(), snapshot: snap })};\n`)
  } catch {}
}

const sidecarUp = async (port) => {
  try {
    const r = await fetch(`${base(port)}/api/status`, { signal: AbortSignal.timeout(1200) })
    return r.ok
  } catch { return false }
}

const ensureSidecar = async (port) => {
  if (await sidecarUp(port)) return true
  const child = spawn(process.execPath, [join(here, "server.mjs")], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ZCODE_GIFT_PORT: String(port) },
  })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await delay(150)
    if (await sidecarUp(port)) return true
  }
  return false
}

// sidecar RPC
const rpc = async (port, path, body) => {
  const res = await fetch(`${base(port)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Zcode-Gift": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180_000),
  })
  const value = await res.json()
  if (!res.ok) throw new Error(value?.error ?? `HTTP ${res.status}`)
  return value
}

export const ZcodeGiftPlugin = async (input, options = {}) => {
  const port = portOf(options)
  feedDataFile(port)
  const up = await ensureSidecar(port)
  if (!up) console.error("[zcode-gift] sidecar 未就绪，页面数据可能为空")
  else fetch(`${base(port)}/api/page-target`, { method: "POST" }).catch(() => {})

  // 面板按钮：经 magpie 页面 options 中继过来（options.set → 插件重载 → 这里执行）
  const request = options?.request
  if (request) {
    try {
      const body = typeof request === "string" ? JSON.parse(request) : request
      if (body?.action === "run") await rpc(port, "/api/run", {})
      else if (body?.action === "config") await rpc(port, "/api/config", { ...(body.patch ?? {}), id: body.id })
      else if (body?.action === "page-seen") await rpc(port, "/api/page-seen", { id: body.id, wake: body.wake === true }).catch(() => {})
      feedDataFile(port)
    } catch (e) { console.error("[zcode-gift] request:", e?.message ?? e) }
  }

  return {
    tool: {
      status: {
        description: "ZCode 礼包的账号池、当前持有、领取记录与任务状态（不含任何登录密钥）。账号来自 magpie 的 zcode 供应商登录 + zcode-switch 快照。",
        args: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const s = await rpc(port, "/api/status")
          const snap = s?.snapshot ?? {}
          return {
            port, running: s.running, enabled: snap.config?.enabled, intervalMin: snap.config?.intervalMin,
            version: snap.version ?? null,
            stats: snap.stats,
            accounts: (snap.accounts ?? []).map((a) => ({
              name: a.name, source: a.source, plans: (a.plans ?? []).length,
              buckets: (a.buckets ?? []).length, error: a.error ?? null,
            })),
            records: (snap.records ?? []).slice(0, 10),
          }
        },
      },
      run: {
        description: "立即跑一轮 ZCode 礼包探测与领取（不改动任务开关）。返回本轮统计与新产生的记录。",
        args: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => rpc(port, "/api/run", {}),
      },
      configure: {
        description: "查看或修改礼包任务：enabled 开关、intervalMin 轮询间隔（1-180 分钟）、unitStyle（zh=万/亿，si=B/M）、claimClientAccount（是否代领客户端登录的号）、versionSource（版本号来源：local 只用本地目录 / github 直连 api.github.com / mirror 国内加速站；服务端按 X-ZCode-App-Version 过滤活动投递，远端能拿到比本机更新的版本）。",
        args: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            intervalMin: { type: "number" },
            unitStyle: { type: "string", enum: ["zh", "si"] },
            claimClientAccount: { type: "boolean" },
            versionSource: { type: "string", enum: ["local", "github", "mirror"] },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          if (!args || Object.keys(args).length === 0) {
            const s = await rpc(port, "/api/status")
            return s?.snapshot?.config ?? {}
          }
          return rpc(port, "/api/config", args)
        },
      },
    },
  }
}

// 页面数据保底：插件每次被加载都刷新一次
try { feedDataFile(3455) } catch {}
