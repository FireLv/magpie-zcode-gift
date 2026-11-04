// Step 1 of the auto-claim: get an Aliyun captcha attestation for the scene
// ZCode uses, with a hidden (minimised, off-screen) headed Chrome over CDP.
// No account is touched here: this only produces a verify param.
//
// Why a headed Chrome: Aliyun rejects headless outright (verifyCode F001),
// but a real Chrome window passes the traceless check even when minimised
// and parked off-screen. That is the same code path ZCode's own Electron
// renderer uses, so the attestation is genuine, not a forgery.
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs"
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

export const captchaConfig = async ({ fetchImpl = fetch, origin = "https://zcode.z.ai", token = "" } = {}) => {
  const res = await fetchImpl(`${origin}/api/v1/client/configs`, {
    headers: {
      Accept: "application/json",
      "User-Agent": `ZCode/${appVersion()}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
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
    "--window-position=-32000,-32000", "--window-size=1280,900", "--start-minimized",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] })
  let stderr = ""
  chrome.stderr.on("data", (d) => { stderr += String(d) })

  const cleanup = () => {
    try { chrome.kill() } catch {}
    try { server.close() } catch {}
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
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
    await new Promise((r) => (ws.onopen = r))
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
    cleanup()
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
