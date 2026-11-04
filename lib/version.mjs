// 版本号来源：本地目录探测之外的补强。
//
// 服务端按 X-ZCode-App-Version 过滤活动投递——低于门槛直接返回空 deliveries
// （code 0、HTTP 200，没有任何报错）。本地探测只能看到"这台机器已经装过的版本"，
// 看不到刚发布、还没升级到的最新版；客户端不升级就永远拿不到新活动。
//
// 两个远端来源，由 config.versionSource 选择：
//   local  —— 只用本地目录（默认行为，不联网）
//   github —— api.github.com 直连
//   mirror —— 国内加速站（GitHub 直连不通时用）
const TAGS_PATH = "https://api.github.com/repos/zai-org/ZCode/tags?per_page=10"
// 2026-11-04 实测：gh-proxy.com 200/1.4s；gh.ddlc.top 通但易 429；其余候选多数不通。
const MIRRORS = ["https://gh-proxy.com/", "https://gh.ddlc.top/"]

export const VERSION_SOURCES = ["local", "github", "mirror"]

export const normalizeVersion = (v) => {
  const s = String(v ?? "").trim().replace(/^v/i, "")
  return /^\d+\.\d+\.\d+$/.test(s) ? s : ""
}

export const compareVersions = (a, b) => {
  const pa = (normalizeVersion(a) || "0.0.0").split(".").map(Number)
  const pb = (normalizeVersion(b) || "0.0.0").split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

export const newestVersion = (list) =>
  [...new Set((list ?? []).map(normalizeVersion).filter(Boolean))].sort((a, b) => compareVersions(b, a))[0] ?? ""

const readTags = async (url, timeoutMs) => {
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "zcode-gift" },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json().catch(() => null)
  if (!Array.isArray(body)) throw new Error(body?.message ? String(body.message).slice(0, 80) : "unexpected reply")
  return body.map((t) => normalizeVersion(t?.name)).filter(Boolean)
}

/**
 * 取远端最新 tag。local 直接返回 null；github / mirror 失败时抛错，由调用方回退。
 * @returns {Promise<{version: string, via: string, url: string, tags: string[]}>}
 */
export const fetchLatestVersion = async ({ source = "github", timeoutMs = 6000 } = {}) => {
  const src = VERSION_SOURCES.includes(source) ? source : "github"
  if (src === "local") return null
  const bases = src === "mirror" ? MIRRORS : [""]
  const errors = []
  for (const base of bases) {
    const url = base ? base + TAGS_PATH : TAGS_PATH
    const via = base ? new URL(base).host : "api.github.com"
    try {
      const tags = await readTags(url, timeoutMs)
      const version = newestVersion(tags)
      if (!version) throw new Error("版本列表里没有可用 tag")
      return { version, via, url, tags: tags.slice(0, 5) }
    } catch (e) {
      errors.push(`${via}: ${String(e?.message ?? e).slice(0, 60)}`)
    }
  }
  throw new Error(errors.join(" | ") || "取不到版本号")
}
