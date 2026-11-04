// ZCode 礼包面板：渲染 sidecar 快照；按钮经 magpie options 中继给后台服务。
const $ = (id) => document.getElementById(id)
const fmt = (n, style = "zh") => {
  const v = Number(n)
  if (!Number.isFinite(v)) return "–"
  if (style === "zh") {
    if (Math.abs(v) >= 1e8) return +(v / 1e8).toFixed(2) + "亿"
    if (Math.abs(v) >= 1e4) return +(v / 1e4).toFixed(1) + "万"
    return String(Math.round(v))
  }
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B"
  if (Math.abs(v) >= 1e6) return +(v / 1e6).toFixed(1) + "M"
  if (Math.abs(v) >= 1e3) return Math.round(v / 1e3) + "k"
  return String(Math.round(v))
}
const when = (iso) => {
  if (!iso) return "–"
  const d = new Date(iso)
  if (isNaN(d)) return "–"
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const STATUS_TEXT = {
  claimed: "领取成功", done: "已领过", captcha: "需人机验证",
  failed: "失败", skipped: "跳过",
}

let myRequestId = null

// 版本号一行：插件自身版本 + 这次请求带的 ZCode 版本（及来源）
function versionLine(v) {
  if (!v) return ""
  const bits = []
  if (v.plugin) bits.push(`插件 ${v.plugin}`)
  if (v.app) {
    if (v.source === "local") bits.push(`ZCode ${v.app}（本地目录）`)
    else if (v.remote) bits.push(`ZCode ${v.app}（远端 ${v.remote}${v.via ? " · " + v.via : ""}）`)
    else bits.push(`ZCode ${v.app}（远端获取失败${v.error ? "：" + v.error : ""}）`)
  }
  return bits.join(" · ")
}

function render(snap) {
  if (!snap) { $("updated").textContent = "后台服务尚未产生数据"; $("version").textContent = ""; return }
  const { config = {}, stats = {}, accounts = [], records = [] } = snap
  const style = config.unitStyle || "zh"

  $("updated").textContent = "更新于 " + when(new Date(snap.updated).toISOString()) +
    " · 后台任务 " + (config.enabled ? "已启用" : "已禁用")
  $("version").textContent = versionLine(snap.version)
  const toggle = $("toggle")
  toggle.textContent = config.enabled ? "禁用任务" : "启用任务"
  toggle.classList.toggle("on", !!config.enabled)

  $("s-accounts").textContent = stats.accounts ?? 0
  $("s-claimed").textContent = stats.claimedCount ?? 0
  $("s-tokens").textContent = fmt(stats.claimedTokens, style)
  $("s-success").textContent = stats.success ?? 0
  $("s-failed").textContent = stats.failed ?? 0
  $("s-next").textContent = stats.enabled ? when(stats.nextRun) : "已禁用"

  if ($("interval").value === "") $("interval").value = config.intervalMin ?? 10
  if (!$("unitStyle").dataset.touched) $("unitStyle").value = style
  if (!$("versionSource").dataset.touched) $("versionSource").value = config.versionSource || "github"

  const rec = $("records")
  if (!records.length) rec.textContent = "暂无记录"
  else {
    rec.innerHTML = ""
    const table = document.createElement("table")
    table.innerHTML = "<thead><tr><th>时间</th><th>账号</th><th>礼包</th><th>数量</th><th>状态</th><th>说明</th></tr></thead>"
    const body = document.createElement("tbody")
    for (const r of records) {
      const tr = document.createElement("tr")
      tr.className = r.status
      const cells = [
        when(r.time), r.account ?? "", r.plan ?? "",
        r.units != null ? fmt(r.units, style) : "–",
        STATUS_TEXT[r.status] ?? r.status,
        r.reason ?? "",
      ]
      for (const c of cells) { const td = document.createElement("td"); td.textContent = c; tr.appendChild(td) }
      body.appendChild(tr)
    }
    table.appendChild(body)
    rec.appendChild(table)
  }

  const acc = $("accounts")
  if (!accounts.length) acc.textContent = "暂无数据（先在供应商里登录账号）"
  else {
    acc.innerHTML = ""
    for (const a of accounts) {
      const row = document.createElement("div")
      row.className = "account"
      const head = document.createElement("div")
      head.className = "account-head"
      head.innerHTML = `<b>${a.name}</b> <span class="muted">${a.site ?? ""}${a.expired ? " · 登录过期" : ""}${a.error ? " · " + a.error : ""}</span>`
      row.appendChild(head)
      if (a.plans?.length) {
        const STATUS_ZH = { active: "生效中", expired: "已过期", pending: "待生效", inactive: "未激活" }
        const tbl = document.createElement("table")
        tbl.className = "plans"
        tbl.innerHTML = "<thead><tr><th>礼包</th><th>总量</th><th>已用</th><th>开始</th><th>过期</th><th>状态</th></tr></thead>"
        const tb = document.createElement("tbody")
        for (const p of a.plans) {
          const tr = document.createElement("tr")
          if (p.effective && p.effective > Date.now()) tr.className = "pending"
          const cells = [
            p.name,
            fmt(p.units, style),
            p.used == null ? "–" : fmt(p.used, style),
            p.starts ? when(new Date(p.starts).toISOString()) : "–",
            p.ends ? when(new Date(p.ends).toISOString()) : "–",
            STATUS_ZH[p.status] ?? p.status,
          ]
          for (const c of cells) { const td = document.createElement("td"); td.textContent = c; tr.appendChild(td) }
          tb.appendChild(tr)
        }
        tbl.appendChild(tb)
        row.appendChild(tbl)
      } else {
        const line = document.createElement("div")
        line.className = "muted"
        line.textContent = "无套餐"
        row.appendChild(line)
      }
      // 各模型桶的 token 用量：小卡片（一行 3 个），进度条 + 数字
      if (a.buckets?.length) {
        const usage = document.createElement("div")
        usage.className = "usage"
        for (const b of a.buckets) {
          const total = Number(b.total) || 0
          const used = Number(b.used) || 0
          const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
          const tone = pct >= 80 ? "danger" : pct >= 50 ? "warn" : ""
          const card = document.createElement("div")
          card.className = "usage-card"
          const head = document.createElement("div")
          head.className = "usage-model"
          head.textContent = b.show || b.plan
          const bar = document.createElement("div")
          bar.className = "usage-bar"
          const fill = document.createElement("div")
          fill.className = "usage-fill " + tone
          fill.style.width = pct.toFixed(1) + "%"
          bar.appendChild(fill)
          const nums = document.createElement("div")
          nums.className = "muted"
          nums.textContent = `已用 ${fmt(used, style)} · 余 ${fmt(b.remaining, style)} / ${fmt(total, style)}`
          const exp = document.createElement("div")
          exp.className = "muted"
          exp.textContent = b.expires ? "有效期至 " + when(new Date(b.expires).toISOString()) : ""
          card.appendChild(head)
          card.appendChild(bar)
          card.appendChild(nums)
          card.appendChild(exp)
          usage.appendChild(card)
        }
        row.appendChild(usage)
      }
      acc.appendChild(row)
    }
  }

  // 我发起的请求已被处理：清掉，避免插件下次重载重复执行
  if (myRequestId && config.lastRequest === myRequestId) {
    myRequestId = null
    try { magpie.options.set({ request: null }) } catch {}
    $("msg").textContent = "已执行"
    setTimeout(() => { $("msg").textContent = "" }, 2500)
  }
}

function readData() {
  const s = document.createElement("script")
  s.src = "data.js?t=" + Date.now()
  s.onload = () => { try { render(window.__ZG__?.snapshot) } catch (e) { console.error(e) } }
  document.head.appendChild(s)
}

function send(action, patch) {
  myRequestId = "r" + Date.now()
  const request = { id: myRequestId, action, ...(patch ? { patch } : {}) }
  try {
    magpie.options.set({ request })
    $("msg").textContent = "已提交…"
  } catch (e) { $("msg").textContent = "提交失败：" + e.message }
}

document.addEventListener("click", (e) => {
  const act = e.target?.dataset?.action
  if (!act) return
  if (act === "toggle") send("config", { enabled: !window.__ZG__?.snapshot?.config?.enabled })
  if (act === "run") send("run", {})
  if (act === "clear") send("config", { __clearRecords: true })
  if (act === "save") {
    const intervalMin = Number($("interval").value) || 10
    const patch = { intervalMin, unitStyle: $("unitStyle").value, versionSource: $("versionSource").value }
    $("unitStyle").dataset.touched = "1"
    $("versionSource").dataset.touched = "1"
    send("config", patch)
  }
})

// 侧车把 __clearRecords 也当 config 处理：这里直接映射到清空端点
const origSend = send
// 简化：清空记录走独立标记，由插件转发 /api/records/clear

readData()
setInterval(readData, 5000)
