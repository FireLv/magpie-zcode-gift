// 核对 magpie-zcode 账号的 uid / 套餐读取是否正常
import { providerAccounts } from "../runner.mjs"
import { switchAccounts, balance, preview } from "../lib/zcode.mjs"

const dec = (j) => { try { return JSON.parse(Buffer.from(j.split(".")[1], "base64url").toString("utf8")) } catch { return {} } }
const uids = (list, tag) => list.map((a) => `${tag}:${a.name}=${dec(a.jwt).sub ?? "?"}`)

const fromMagpie = providerAccounts()
const fromSwitch = switchAccounts()
console.log("magpie 账号:", uids(fromMagpie, "M").join(" | "))
console.log("switch 账号:", uids(fromSwitch, "S").join(" | "))

const seen = new Map()
for (const a of [...fromMagpie, ...fromSwitch]) {
  const uid = dec(a.jwt).sub ?? a.jwt.slice(-12)
  if (!seen.has(uid)) seen.set(uid, a)
}
console.log("\n去重后唯一账号:", seen.size)

for (const [uid, a] of seen) {
  try {
    const b = await balance(a.jwt, a.device)
    const p = await preview(a.jwt, a.device)
    console.log(`  ${a.name.padEnd(9)} uid=${String(uid).slice(0, 14)} plans=${(b.plans ?? []).length} preview=${(p ?? []).length} 来源=${a.source}`)
  } catch (e) {
    console.log(`  ${a.name.padEnd(9)} uid=${String(uid).slice(0, 14)} 读取失败: ${e.message.slice(0, 60)}`)
  }
}
