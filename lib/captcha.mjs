// Step 1 of the auto-claim: get an Aliyun captcha attestation for the scene
// ZCode uses, with a hidden (minimised, off-screen) headed Chrome over CDP.
// No account is touched here: this only produces a verify param.
//
// Why a headed Chrome: Aliyun rejects headless outright (verifyCode F001),
// but a real Chrome window passes the traceless check even when minimised
// and parked off-screen. That is the same code path ZCode's own Electron
// renderer uses, so the attestation is genuine, not a forgery.
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appVersion } from "./zcode.mjs"

const CHROME_CANDIDATES = [
  process.env.ZCODE_CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean)

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!chromePath) {
  console.error("no Chrome/Edge found; set ZCODE_CHROME_PATH")
  process.exit(2)
}

// —— Chrome 进程树清理 ——
// Windows 上 chrome.kill() 只杀直接子进程，renderer/网络服务会残留成孤儿，
// user-data-dir 被锁着也删不掉；Linux/macOS 用 kill 进程组兜底。
const killTree = (pid) => {
  if (pid == null) return
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5000 }) } catch {}
  } else {
    try { process.kill(-pid, "SIGKILL") } catch { try { process.kill(pid, "SIGKILL") } catch {} }
  }
}

// Windows 上 taskkill 后句柄释放有延迟，立刻删 profile 会 EBUSY。等进程真没了
// （或最多 5s）再返回。
const killTreeAndWait = async (pid) => {
  killTree(pid)
  if (pid == null) return
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200))
    try { process.kill(pid, 0) } catch { return } // ESRCH = 已退出
  }
}

// 关键：Chrome 启动后经常秒退初始进程、由新进程接管浏览器（handoff），
// spawn 返回的 pid 早就不在了——chrome.kill() 杀的是空气，浏览器窗口留在
// 那里。所以清理时按 profile 目录名枚举进程找到"真身"，全部杀掉并等退场。
const killProfileOwner = async (profile) => {
  const key = profile.replaceAll("/", "\\").split("\\").pop()
  const deadline = Date.now() + 15_000
  for (;;) {
    const procs = process.platform === "win32" ? listBrowserProcessesWin() : listBrowserProcesses()
    const mine = procs.filter((p) => (p.cmd ?? "").includes(key))
    for (const p of mine) killTree(p.pid)
    if (!mine.length) return
    if (Date.now() > deadline) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

// 兜底：sidecar 崩溃/被杀时，本次拉起的 Chrome 会变孤儿。拉起时在命令行里
// 打上 "#zcode-gift:<sidecarPid>" 标记；模块加载时把标记里的 sidecar 已不
// 存活（或根本没标记）的 Chrome 全部回收，并清掉残留的 profile 目录。
const SIDE_PID = process.pid
const ownerAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const listBrowserProcesses = () => {
  if (process.platform !== "win32") {
    try {
      const out = execFileSync("ps", ["-eo", "pid=,command="], { timeout: 8000, encoding: "utf8" })
      return out.split(/\r?\n/).filter(Boolean).map((line) => {
        const m = line.match(/^\s*(\d+)\s+(.*)$/)
        return m ? { pid: Number(m[1]), cmd: m[2] } : null
      }).filter(Boolean)
    } catch { return [] }
  }
  try { return [] } catch { return [] }
}
const listBrowserProcessesWin = () => {
  // wmic 在新 Windows 上逐步移除，失败就退回 PowerShell Get-CimInstance
  try {
    const out = execFileSync("wmic", ["process", "where", "name='chrome.exe' or name='msedge.exe'", "get", "ProcessId,CommandLine", "/format:csv"], { timeout: 10000, encoding: "utf8" })
    return out.split(/\r?\n/).filter((l) => l.includes(".exe")).map((line) => {
      const idx = line.lastIndexOf(",")
      return { pid: Number(line.slice(idx + 1).trim()), cmd: line.slice(0, idx) }
    }).filter((p) => Number.isInteger(p.pid) && p.pid > 0)
  } catch {
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"], { timeout: 10000, encoding: "utf8" })
      return out.split(/\r?\n/).filter(Boolean).map((line) => {
        const [pid, ...rest] = line.split("\t")
        return { pid: Number(pid), cmd: rest.join("\t") }
      }).filter((p) => Number.isInteger(p.pid) && p.pid > 0 && p.cmd)
    } catch { return [] }
  }
}

const sweepOrphanChromes = () => {
  const procs = process.platform === "win32" ? listBrowserProcessesWin() : listBrowserProcesses()
  if (!procs.length) return
  const profileOf = (cmd) => {
    const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(cmd ?? "")
    const p = m?.[1] ?? m?.[2] ?? ""
    return p.replaceAll("/", "\\")
  }
  for (const p of procs) {
    const prof = profileOf(p.cmd)
    if (!prof || !prof.includes("zcode-claim-")) continue
    const tags = [...p.cmd.matchAll(/#zcode-gift:(\d+)/g)].map((m) => Number(m[1]))
    // 有存活主人认领的跳过；孤儿（主人死了/旧版本没打标记的）杀掉
    if (tags.some(ownerAlive)) continue
    killTree(p.pid)
    try { rmSync(prof, { recursive: true, force: true }) } catch {}
  }
  // 没有进程引用的残留 profile 目录也清掉（上次 rmSync 撞锁失败留下的）
  try {
    for (const d of readdirSync(tmpdir())) {
      if (!d.startsWith("zcode-claim-")) continue
      if (procs.some((p) => profileOf(p.cmd).endsWith(d))) continue
      try { rmSync(join(tmpdir(), d), { recursive: true, force: true }) } catch {}
    }
  } catch {}
}
sweepOrphanChromes()

export const captchaConfig = async ({ fetchImpl = fetch, origin = "https://zcode.z.ai", token = "" } = {}) => {
  const res = await fetchImpl(`${origin}/api/v1/client/configs`, {
    headers: {
      Accept: "application/json",
      "User-Agent": `ZCode/${appVersion()}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json()
  if (body?.code !== 0) throw new Error(`client/configs answered code ${body?.code}`)
  const c = body?.data?.configs?.captcha ?? body?.data?.captcha ?? {}
  if (!c.enabled || !c.sceneId) throw new Error("ZCode's captcha is off or has no sceneId")
  return { enabled: c.enabled, region: c.region ?? "", prefix: c.prefix ?? "", sceneId: c.sceneId }
}

// attestation runs the Aliyun SDK in a hidden Chrome and returns its param.
export const attestation = async (cfg, { timeoutMs = 30000, origin = "https://zcode.z.ai", quiet = true } = {}) => {
  const port = 8900 + Math.floor(Math.random() * 80)
  const html = `<!doctype html><meta charset="utf-8"><body><div id="holder"></div><button id="btn" style="display:none">v</button><script>
    window.__R__ = null; window.__E__ = null;
    (async () => {
      try {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
          s.onload = () => res(); s.onerror = () => rej(new Error("sdk load failed"));
          document.head.appendChild(s);
        });
        window.AliyunCaptchaConfig = { region: ${JSON.stringify(cfg.region)}, prefix: ${JSON.stringify(cfg.prefix)} };
        window.initAliyunCaptcha({
          SceneId: ${JSON.stringify(cfg.sceneId)},
          mode: "popup", language: "zh-CN", showErrorTip: false,
          element: "#holder", button: "#btn",
          getInstance: (i) => { window.__I__ = i; if (i.startTracelessVerification) i.startTracelessVerification(); },
          success: (p) => { window.__R__ = { ok: true, param: typeof p === "string" ? p : p?.captchaVerifyParam }; },
          fail: (p) => { window.__R__ = { ok: false, why: p }; },
          onError: (p) => { window.__E__ = p; },
        });
      } catch (e) { window.__E__ = String(e); }
    })();
  </script></body>`

  const server = createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(html)
  })
  await new Promise((r) => server.listen(port, "127.0.0.1", r))

  const profile = mkdtempSync(join(tmpdir(), "zcode-claim-"))
  const chrome = spawn(chromePath, [
    "--no-first-run", "--no-default-browser-check", "--disable-features=Translate",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    `--zcode-gift-owner=${process.pid}`, // 孤儿回收标记：sidecar 死后新实例可识别并杀掉
    "--window-position=-32000,-32000", "--window-size=1280,900", "--start-minimized",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" })
  let stderr = ""
  chrome.stderr.on("data", (d) => { stderr += String(d) })

  const cleanup = async () => {
    try { killTree(chrome.pid) } catch {} // 初始进程（可能已 handoff 秒退）
    try { await killProfileOwner(profile) } catch {} // 真身：按 profile 目录名找
    try { server.close() } catch {}
    // bun 的 rmSync 不支持 maxRetries（单次 EBUSY 即失败），自己循环重试：
    // Windows 上句柄释放有延迟，等一等就能删掉；实在删不掉留给下次 sweep
    for (let i = 0; i < 12; i++) {
      try { rmSync(profile, { recursive: true, force: true }); return } catch { await new Promise((r) => setTimeout(r, 500)) }
    }
    // Defender/索引器扫描新 profile 可能锁十几秒：挂个延迟重试（不阻塞主流程），
    // 再删不掉就留给下次模块加载时的 sweep
    const t = setTimeout(() => {
      try { rmSync(profile, { recursive: true, force: true }) } catch {}
    }, 30_000)
    if (typeof t.unref === "function") t.unref()
  }

  try {
    const wsUrl = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Chrome did not announce a DevTools port")), 25000)
      const tick = () => {
        try {
          const txt = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")
          if (txt.length >= 2 && txt[1]) { clearTimeout(t); resolve(`ws://127.0.0.1:${txt[0].trim()}${txt[1].trim()}`) }
          else setTimeout(tick, 150)
        } catch { setTimeout(tick, 150) }
      }
      tick()
    })

    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }))
    })
    // onopen 也要有超时：Chrome 起了但 CDP 连不上时不能把整轮挂死
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WebSocket to DevTools timed out")), 10000)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = (e) => { clearTimeout(t); reject(new Error("WebSocket to DevTools failed: " + String(e?.message ?? e))) }
    })
    // 连接中断：所有在途 send 立刻失败，绝不能挂着等
    ws.onclose = () => {
      for (const { reject } of pending.values()) reject(new Error("DevTools connection closed"))
      pending.clear()
    }
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      }
    }

    const { targetId } = await send("Target.createTarget", { url: "about:blank" })
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true })
    await send("Page.enable", {}, sessionId)
    await send("Runtime.enable", {}, sessionId)
    // The real origin, so the SDK sees what ZCode's own page shows it.
    await send("Page.navigate", { url: `${origin}/` }, sessionId)
    await new Promise((r) => setTimeout(r, 1500))
    await send("Runtime.evaluate", { expression: `(${inject.toString()})(${JSON.stringify(cfg)})` }, sessionId)

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400))
      const r = await send("Runtime.evaluate", {
        expression: "JSON.stringify({r: window.__R__, e: window.__E__})",
        returnByValue: true,
      }, sessionId)
      const v = r?.result?.value
      if (v) {
        const p = JSON.parse(v)
        if (p.r) {
          ws.close()
          if (!p.r.ok) throw new Error("captcha failed: " + JSON.stringify(p.r.why))
          return { param: p.r.param, region: cfg.region }
        }
        if (p.e) { ws.close(); throw new Error("captcha error: " + JSON.stringify(p.e)) }
      }
    }
    ws.close()
    throw new Error("captcha timed out after " + timeoutMs + "ms")
  } catch (e) {
    if (!quiet) console.error("[captcha stderr]", stderr.slice(-800))
    throw e
  } finally {
    await cleanup()
  }
}

function inject(cfg) {
  window.__R__ = null
  window.__E__ = null
  ;(async () => {
    try {
      await new Promise((res, rej) => {
        const s = document.createElement("script")
        s.src = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"
        s.onload = () => res()
        s.onerror = () => rej(new Error("sdk load failed"))
        document.head.appendChild(s)
      })
      window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix }
      window.initAliyunCaptcha({
        SceneId: cfg.sceneId, mode: "popup", language: "zh-CN", showErrorTip: false,
        element: "#holder", button: "#btn",
        getInstance: (i) => { window.__I__ = i; if (i.startTracelessVerification) i.startTracelessVerification() },
        success: (p) => { window.__R__ = { ok: true, param: typeof p === "string" ? p : p?.captchaVerifyParam } },
        fail: (p) => { window.__R__ = { ok: false, why: p } },
        onError: (p) => { window.__E__ = p },
      })
    } catch (e) { window.__E__ = String(e) }
  })()
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const cfg = await captchaConfig()
  console.log("captcha config:", JSON.stringify(cfg))
  const t0 = Date.now()
  const att = await attestation(cfg)
  console.log(`attestation ok in ${Date.now() - t0}ms, param length ${att.param.length}`)
  console.log("decoded:", Buffer.from(att.param, "base64").toString("utf8").slice(0, 160))
}
