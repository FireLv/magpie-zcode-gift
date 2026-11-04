// 令牌数字格式化：与 magpie GUI 的 fmtN 口径一致（中文 万/亿，西文 B/M）。
export const fmtTokens = (n, style = "zh") => {
  const v = Number(n)
  if (!Number.isFinite(v)) return String(n ?? "")
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
