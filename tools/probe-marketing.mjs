// Probe /api/v1/marketing/touch per account: what deliveries does a ZCode
// session see? Read-only.
import { switchAccounts, appVersion } from "../lib/zcode.mjs"
const AV = appVersion()
const H = (jwt, mid) => ({
  Accept: "application/json",
  "User-Agent": `ZCode/${AV}`,
  "HTTP-Referer": "https://zcode.z.ai",
  "X-Title": "Z Code@electron",
  "X-ZCode-App-Version": AV,
  "X-Platform": "win32-x64",
  "X-Release-Channel": "1",
  "X-Client-Language": "zh",
  "X-Client-Timezone": "Asia/Shanghai",
  "X-Os-Category": "windows",
  "X-Os-Version": "10.0",
  Authorization: `Bearer ${jwt}`,
  "X-Device-Mid": mid,
  "x-request-id": crypto.randomUUID(),
})

const accounts = switchAccounts().slice(0, 3)
for (const a of accounts) {
  for (const seq of [0, 1]) {
    const url = `https://zcode.z.ai/api/v1/marketing/touch?seq=${seq}`
    try {
      const r = await fetch(url, { headers: H(a.jwt, a.device), signal: AbortSignal.timeout(15000) })
      const text = await r.text()
      console.log(`\n[${a.name}] seq=${seq} → HTTP ${r.status} (${text.length}b)`)
      console.log("  ", text.slice(0, 700).replace(/\s+/g, " "))
    } catch (e) {
      console.log(`\n[${a.name}] seq=${seq} ERROR ${e.message}`)
    }
  }
}
