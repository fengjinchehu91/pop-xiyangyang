// BigInt formatting helpers (no floating point for on-chain amounts).
export const E18 = 10n ** 18n;

export function fmtUnits(v: bigint | null | undefined, decimals = 18, dp = 2): string {
  if (v === null || v === undefined) return "—";
  const neg = v < 0n;
  let x = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const scale = 10n ** BigInt(dp);
  // round half up to dp
  let scaled = (x * scale + base / 2n) / base;
  const int = scaled / scale;
  const frac = scaled % scale;
  const intStr = int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const s = dp > 0 ? `${intStr}.${frac.toString().padStart(dp, "0")}` : intStr;
  return neg ? "-" + s : s;
}

export function parseUnitsSafe(s: string, decimals = 18): bigint | null {
  const t = s.trim().replace(/[,，\s_]/g, "");
  if (!/^\d*(\.\d*)?$/.test(t) || t === "" || t === ".") return null;
  const [i, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function short(a?: string | null): string {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function fmtTime(sec: number | bigint | null | undefined): string {
  if (!sec) return "—";
  const d = new Date(Number(sec) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** usd18 -> reward token raw amount given price (usd18 per whole token) */
export function usdToToken(usd: bigint, priceUsd18: bigint | null, tokenDecimals = 18): bigint | null {
  if (!priceUsd18 || priceUsd18 === 0n) return null;
  return (usd * 10n ** BigInt(tokenDecimals)) / priceUsd18;
}

export function applySlippage(x: bigint, bps: number): bigint {
  return (x * BigInt(10000 - bps)) / 10000n;
}
