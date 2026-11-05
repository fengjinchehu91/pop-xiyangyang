export type Mode = "demo" | "local" | "production";

export interface AppConfig {
  mode: Mode;
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  miner: string; // empty = not deployed / not configured
  pool: string;
  pop: string;
  usdt: string;
  reward: string;
  deployBlock: number;
  logChunk: number; // blocks per eth_getLogs request
  appUrl: string; // base for referral links; empty = current origin
}

// Defaults: addresses given by the project owner. They are re-validated on-chain by the contract constructor
// and by scripts/verify-chain.mjs; the UI never treats them as proof of identity.
export const DEFAULTS: AppConfig = {
  mode: "production",
  chainId: 56,
  chainName: "BNB Smart Chain",
  rpcUrl: "https://bsc-rpc.publicnode.com", // must support eth_getLogs (records / referral lists)
  explorer: "https://bscscan.com",
  miner: "",
  pool: "0xE5ce5bc4785CD2a246151364f5A190ceE3FDb142",
  pop: "0xA3cfB853339b77F385B994799B015cB04b208Fe6",
  usdt: "", // filled from the pool on-chain (token0/token1 other than POP); never hard-assumed
  reward: "0x4dDA46C9dD7e794B99eebDcfD3c82bfBD3207777",
  deployBlock: 0,
  logChunk: 5000,
  appUrl: "",
};

export async function loadConfig(): Promise<AppConfig> {
  // embedded config (single-file build) is the base; a config.json next to the page overrides it, so the
  // operator only edits one small file after deployment
  let file: Partial<AppConfig> = { ...((window as any).__XYY_CONFIG__ || {}) };
  try {
    const r = await fetch("./config.json", { cache: "no-store" });
    if (r.ok) file = { ...file, ...(await r.json()) };
  } catch {
    /* no config file (or sandboxed viewer): keep embedded/defaults */
  }
  const cfg = { ...DEFAULTS, ...file } as AppConfig;
  const q = new URLSearchParams(location.search);
  const m = q.get("mode");
  if (m === "demo" || m === "local" || m === "production") cfg.mode = m;
  return cfg;
}
