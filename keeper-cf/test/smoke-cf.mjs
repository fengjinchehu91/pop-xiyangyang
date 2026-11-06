// Smoke test of the exact file that is pasted into Cloudflare (dist/worker.js): only its default export is used,
// the way Cloudflare calls it: scheduled() for the cron and fetch() for the status page.
import fs from "node:fs";
import { execSync } from "node:child_process";
import worker from "../dist/worker.js";

const RPC = "http://127.0.0.1:8545";
const dep = JSON.parse(fs.readFileSync(new URL("../../contracts/keeper-deploy.json", import.meta.url), "utf8"));
const kv = new Map();
const env = {
  KEEPER_KEY: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  STATE: { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => kv.set(k, v) },
  MINER: dep.miner, DEPLOY_BLOCK: "0", CHAIN_ID: "31337", RPC_URL: RPC, MAX_GAS_GWEI: "100",
};
const src = fs.readFileSync(new URL("../dist/worker.js", import.meta.url), "utf8");
let fails = 0;
const check = (n, c) => { if (!c) fails++; console.log(c ? "ok  " : "FAIL", n); };

check("only a default export", /export \{\s*worker_default as default\s*\};?\s*$/.test(src));
check("no Node-only APIs", !/require\(|process\.|node:/.test(src.replace(/\/\/.*$/gm, "")));
let page = await (await worker.fetch(new Request("https://k.workers.dev/"), { STATE: env.STATE })).text();
check("page before setup explains what happens", page.includes("自动创建检查钱包") && page.includes("还没有运行过"));
execSync(`cast rpc evm_increaseTime 1600 --rpc-url ${RPC} && cast rpc evm_mine --rpc-url ${RPC}`);
let p;
await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, env, { waitUntil: (x) => (p = x) });
await p;
const s = JSON.parse(kv.get("state"));
check("cron run worked", s.status.ok && s.status.actions.length > 0);
page = await (await worker.fetch(new Request("https://k.workers.dev/"), env)).text();
check("status page shows a healthy run", page.includes("正常运行") && page.includes("运行中，正常计息"));
check("404 for other paths", (await worker.fetch(new Request("https://k.workers.dev/x"), env)).status === 404);
console.log(fails ? `${fails} FAILURES` : "SMOKE OK");
process.exit(fails ? 1 : 0);
