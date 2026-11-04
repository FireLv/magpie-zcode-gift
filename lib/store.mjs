// 插件本地存储：配置（开关/间隔/单位风格）、领取记录、页面快照。
// 位置：XDG_CONFIG_HOME || %APPDATA% || ~/.config 下的 zcode-gift/。
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const dataDir = () => {
  const root = process.env.ZCODE_GIFT_DATA
    || process.env.XDG_CONFIG_HOME
    || (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : "")
    || join(homedir(), ".config")
  return join(root, "zcode-gift")
}

const readJSON = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, "utf8")) } catch { return fallback }
}
const writeAtomic = (p, value) => {
  mkdirSync(dataDir(), { recursive: true })
  const tmp = p + ".tmp"
  writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n")
  try { renameSync(tmp, p) } catch { writeFileSync(p, JSON.stringify(value, null, 1) + "\n") }
}

export const DEFAULT_CONFIG = {
  enabled: false,        // 领取任务总开关：默认禁用
  intervalMin: 10,       // 轮询间隔（分钟）
  unitStyle: "zh",       // zh = 万/亿，si = B/M
  versionSource: "github", // 版本号来源：local 本地目录 / github 直连 / mirror 国内加速站
}

export const loadConfig = () => ({ ...DEFAULT_CONFIG, ...readJSON(join(dataDir(), "config.json"), {}) })
export const saveConfig = (config) => writeAtomic(join(dataDir(), "config.json"), config)

export const loadRecords = () => readJSON(join(dataDir(), "records.json"), [])
export const addRecords = (entries) => {
  const all = [...loadRecords(), ...entries].slice(-500)
  writeAtomic(join(dataDir(), "records.json"), all)
  return all
}
export const clearRecords = () => { writeAtomic(join(dataDir(), "records.json"), []) }

// 当日领取台账：{ "2026-11-04": { "<账号 id>": { "<批次键>": 时间戳 } } }
// 一个账号当天领到某个礼包后，同批次不再重复打领取接口（含 entitlement 尾巴这类变体 id）。
export const loadDaily = () => readJSON(join(dataDir(), "daily.json"), {})
export const saveDaily = (v) => writeAtomic(join(dataDir(), "daily.json"), v)

// 快照：页面唯一的数据来源（沙箱页面不能联网，靠这个文件投喂）
export const writeSnapshot = (snapshot) => writeAtomic(join(dataDir(), "snapshot.json"), snapshot)
export const loadSnapshot = () => readJSON(join(dataDir(), "snapshot.json"), null)
