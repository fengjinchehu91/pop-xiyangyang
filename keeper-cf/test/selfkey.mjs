// Keeper without any configured private key: it creates its own wallet on the first run, keeps it, asks for BNB,
// and never creates a second wallet if the stored one disappears.
import fs from "node:fs";
import { execSync } from "node:child_process";
import worker from "../dist/worker.js";

const RPC = process.env.RPC || "http://127.0.0.1:8546";
const dep = JSON.parse(fs.readFileSync(new URL(process.env.DEPLOY_JSON || "../../contracts/web-deploy.json", import.meta.url), "utf8"));
const cast = (a) => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const kv = new Map();
const STATE = { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => kv.set(k, v) };
const env = { STATE, MINER: dep.miner, DEPLOY_BLOCK: "0", CHAIN_ID: "31337", RPC_URL: RPC, LOG_RPC_URLS: RPC, MAX_GAS_GWEI: "100" };
let fails = 0;
const check = (n, c, x = "") => { if (!c) fails++; console.log(c ? "ok  " : "FAIL", n, x); };
const cron = async (e = env) => { let p; await worker.scheduled({}, e, { waitUntil: (x) => (p = x) }); await p; return JSON.parse(kv.get("state")); };
const json = async () => (await worker.fetch(new Request("https://site.example/keeper.json"), env)).json();

cast("rpc evm_increaseTime 1600"); cast("rpc evm_mine");
let s = await cron();
const key1 = kv.get("keeper-key");
check("first run creates a wallet", /^0x[0-9a-f]{64}$/.test(key1) && /^0x[0-9a-f]{40}$/.test(s.keeperAddr), s.keeperAddr);
let j = await json();
check("status asks for BNB", j.keeper === s.keeperAddr && j.lowBalance === true && j.errors.some((e) => e.includes("转 0.05 BNB")), JSON.stringify(j.errors));
const page = await (await worker.fetch(new Request("https://site.example/keeper"), env)).text();
check("status page shows the address and the BNB request", page.includes(s.keeperAddr) && page.includes("转 0.05 BNB"));
check("the key is never in any response", !page.includes(key1.slice(2)) && !JSON.stringify(j).includes(key1.slice(2)) && !kv.get("state").includes(key1.slice(2)));
check("website paths are left to the website files", (await worker.fetch(new Request("https://site.example/index.html"), env)).status === 404);

// owner funds it (in reality: a normal BNB transfer from their wallet)
cast(`send ${s.keeperAddr} --value 0.05ether --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`);
cast("rpc evm_increaseTime 1600"); cast("rpc evm_mine");
s = await cron();
check("after funding: works", s.status.ok && s.status.actions.some((a) => a.includes("更新价格")), JSON.stringify(s.status));
check("same wallet kept", kv.get("keeper-key") === key1 && s.keeperAddr === s.status.keeper);
await new Promise((r) => setTimeout(r, 21000)); // the page keeps a 20 s memo to save KV reads
j = await json();
check("json: healthy", j.ok && j.accruing === true && j.lowBalance === false);

// stored key disappears -> refuse to make a new one (its BNB would be stranded)
kv.delete("keeper-key");
s = await cron();
check("lost key: stops instead of creating another wallet", !kv.has("keeper-key") && s.status.errors.some((e) => e.includes("找不到之前创建的检查钱包")), JSON.stringify(s.status.errors));
console.log(fails ? `${fails} FAILURES` : "SELF-KEY OK");
process.exit(fails ? 1 : 0);
