// Runs the real worker (dist/worker.js) against a local Anvil chain with the real XiyangMiner contract.
// Every transaction the worker sends is signed by the worker itself and mined by Anvil.
import { execSync } from "node:child_process";
import fs from "node:fs";
import worker, { runOnce, autoSettleHours } from "../dist/worker.test.mjs";

const RPC = "http://127.0.0.1:8545";
const dep = JSON.parse(fs.readFileSync(new URL("../../contracts/keeper-deploy.json", import.meta.url), "utf8"));
const MINER = dep.miner;
const KEEPER_KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"; // anvil #9
const OPERATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1 (operator/owner)
const cast = (a) => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const forge = (a, env = {}) =>
  execSync(`forge script script/KeeperScenario.s.sol ${a} --rpc-url ${RPC} --broadcast --gas-estimate-multiplier 300 > /tmp/forge-users.log 2>&1`, {
    cwd: new URL("../../contracts/", import.meta.url).pathname,
    env: { ...process.env, ...env },
  });
const warp = (sec) => {
  cast(`rpc evm_increaseTime ${sec}`);
  cast("rpc evm_mine");
};

const kv = new Map();
let kvReads = 0;
let kvWrites = 0;
const STATE = {
  async get(k, type) {
    kvReads++;
    const v = kv.get(k);
    return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
  },
  async put(k, v) {
    kvWrites++;
    kv.set(k, v);
  },
};
const env = { KEEPER_KEY, STATE, MINER, DEPLOY_BLOCK: "0", CHAIN_ID: "31337", RPC_URL: RPC, RPC_URL_2: "", LOG_RPC_URLS: RPC, MAX_GAS_GWEI: "100", EXPLORER: "https://bscscan.com", SETTLE_HOURS: "1" };

let fails = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fails++;
  console.log(cond ? "ok  " : "FAIL", name, extra);
};
const N_CURVE = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const userKey = (i) => {
  const h = BigInt(execSync(`cast keccak $(cast abi-encode "f(string,uint256)" "xyy-keeper-user" ${i})`, { encoding: "utf8" }).trim());
  return "0x" + ((h % (N_CURVE - 1n)) + 1n).toString(16).padStart(64, "0");
};
const userAddr = (i) => execSync(`cast wallet address --private-key ${userKey(i)}`, { encoding: "utf8" }).trim();
const view = (sig) => cast(`call ${MINER} "${sig}"`).split(" ")[0];
let gasLog = [];
async function run(label, e = env) {
  const cpu0 = process.cpuUsage();
  const s = await runOnce(e);
  const cpu = process.cpuUsage(cpu0);
  const st = s.status;
  console.log(`--- ${label}: ok=${st.ok} accruing=${st.accruing} reasons=${st.reasons} users=${st.users}/${st.toSettle} cpu=${((cpu.user + cpu.system) / 1000).toFixed(1)}ms`);
  for (const a of st.actions) console.log("     做了:", a);
  for (const x of st.errors) console.log("     问题:", x);
  for (const t of s.pending.filter((p) => p.at === st.at)) {
    const rc = JSON.parse(cast(`rpc eth_getTransactionReceipt ${t.hash}`));
    if (rc) gasLog.push({ kind: t.kind, gas: Number(rc.gasUsed), status: rc.status });
  }
  return s;
}

// 1) fresh contract, pool history > 30 min, no reward-price snapshots yet
warp(2000);
let s = await run("run 1 (first run, no price history)");
check("first run sends checkpoint", s.status.actions.some((a) => a.includes("更新价格")));
check("still paused: reward price needs 30 min of snapshots", view("accruing()(bool)") === "false");

// 2) 10 minutes later: checkpoint was just made, nothing due, state unchanged -> no transaction
warp(600);
s = await run("run 2 (+10 min)");
const mainActs = (st) => st.actions.filter((a) => !a.includes("扩充 POP/USDT 池的价格记录"));
check("no tx when nothing is due (besides the one-time pool slot increase)", mainActs(s.status).length === 0 && s.status.ok);

// 3) +25 min: due again; snapshot is now 35 min old -> resumes
warp(1500);
s = await run("run 3 (+25 min)");
check("resumes once price history exists", view("accruing()(bool)") === "true" && s.status.actions.some((a) => a.includes("恢复计息")));

// 4) users join (referral tree, every 7th below the 100 USDT threshold)
forge(`--sig "users()"`, { N: "40", START: "0" });
for (let i = 0; i < 6; i++) cast("rpc evm_mine"); // the worker only reads events that are 5 blocks deep
warp(60);
s = await run("run 4 (40 wallets joined)");
check("discovers all 40 wallets from events", s.status.users === 40, `(${s.status.users})`);
check("39 wallets have a referrer + position", s.status.toSettle === 39, `(${s.status.toSettle})`);
check("settles them in one run", s.status.actions.filter((a) => a.includes("结算推荐奖励")).length === 1);

// 5) one hour of accrual, then settle again -> uplines receive dynamic rewards
const u0 = userAddr(0);
const dynBefore = BigInt(cast(`call ${MINER} "pendingUsd(address)(uint256,uint256)" ${u0}`).split("\n")[1].split(" ")[0]);
warp(1600);
s = await run("run 5 (+27 min)");
check("checkpoint only (settle not due yet)", mainActs(s.status).length === 1 && mainActs(s.status)[0].includes("更新价格"));
warp(2100);
s = await run("run 6 (+35 min, settle due)");
check("hourly settle sent", s.status.actions.some((a) => a.includes("结算推荐奖励 39 个钱包")));
const dynAfter = BigInt(cast(`call ${MINER} "pendingUsd(address)(uint256,uint256)" ${u0}`).split("\n")[1].split(" ")[0]);
check("root wallet's referral reward grew after settle", dynAfter > dynBefore, `${dynBefore} -> ${dynAfter}`);

// 7) reserve problem: operator lowers the allowance -> next run pauses immediately (not waiting 25 min)
cast(`send ${dep.reward} "approve(address,uint256)" ${MINER} 1 --private-key ${OPERATOR_KEY}`);
warp(120);
s = await run("run 7 (allowance removed)");
check("pauses within one run", view("accruing()(bool)") === "false" && s.status.actions.some((a) => a.includes("暂停计息")));
cast(`send ${dep.reward} "approve(address,uint256)" ${MINER} 500000000000000000000000000 --private-key ${OPERATOR_KEY}`);
warp(120);
s = await run("run 8 (allowance restored)");
check("resumes within one run", view("accruing()(bool)") === "true");

// 8b) a transaction gets stuck (underpriced): the next run replaces it with a higher fee
warp(1600);
cast("rpc evm_setAutomine false");
s = await run("run 8b (checkpoint sent, chain stops including it)");
const stuckHash = s.pending[s.pending.length - 1].hash;
const gp = BigInt(s.status.gasPrice);
const nonceBefore = Number(cast(`nonce ${s.status.keeper}`));
cast(`rpc anvil_setNextBlockBaseFeePerGas ${(gp * 3n) / 2n}`);
cast("rpc evm_increaseTime 400");
cast("rpc evm_mine");
check("tx is stuck (not mined)", Number(cast(`nonce ${s.status.keeper}`)) === nonceBefore);
s = await run("run 8c (+7 min)");
// (a node that counts mempool txs in "pending" triggers the explicit replacement; Anvil does not, and then the
// normal resend with the same nonce at the current, higher price replaces it — both must end with one mined tx)
check("stuck tx replaced by a new transaction", s.pending[s.pending.length - 1].hash !== stuckHash, s.status.actions.join(" | "));
cast("rpc evm_mine");
cast("rpc evm_setAutomine true");
check("replacement mined, nonce advanced by exactly one", Number(cast(`nonce ${s.status.keeper}`)) === nonceBefore + 1);
check("checkpoint time advanced", Number(view("lastCheckpointTime()(uint64)")) >= s.status.at);
warp(60);
s = await run("run 8d");
check("back to normal afterwards", s.status.ok && s.pending.length === 0, JSON.stringify(s.status.errors));
const POOL_ADDR = cast(`call ${MINER} "POOL()(address)"`);
const slotsNow = Number(cast(`call ${POOL_ADDR} "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)"`).split("\n")[4]);
check("pool price slots raised to 2400 once, then left alone", s.status.poolSlots === 2400 && slotsNow === 2400 && !s.status.actions.some((x) => x.includes("扩充")), `${s.status.poolSlots} / on chain ${slotsNow}`);

// 9) more users than one run can settle: 2 tx x 100 = 200 per run -> continues next run
forge(`--sig "users()"`, { N: "260", START: "40" });
for (let i = 0; i < 6; i++) cast("rpc evm_mine");
warp(3700);
s = await run("run 9 (300 wallets, settle due)");
const n9 = s.status.actions.filter((a) => a.includes("结算推荐奖励")).length;
check("first part settled (2 transactions of 100)", n9 === 2, `(${n9})`);
warp(600);
s = await run("run 10 (+10 min, rest of the list)");
const n10 = s.status.actions.filter((a) => a.includes("结算推荐奖励")).length;
check("rest settled in the next run", n10 === 1 && s.settleCursor === 0, `(${n10}, cursor ${s.settleCursor})`);

// 10) a partial withdrawal and a full exit are tracked from events
const k1 = userKey(1);
const a1 = userAddr(1).toLowerCase();
const liq1 = BigInt(s.users[a1][0]);
cast(`send ${MINER} "withdraw(uint128,uint256,uint256,uint256)" ${liq1} 0 0 9999999999 --private-key ${k1}`);
for (let i = 0; i < 6; i++) cast("rpc evm_mine");
warp(600);
s = await run("run 11 (wallet 1 fully exited)");
check("exited wallet dropped from settle list", s.users[a1][0] === "0" && s.status.toSettle === 298, `(${s.status.toSettle})`);

// 10b) a run cut off half-way (e.g. CPU limit) is noticed and the next runs do less
const saved = JSON.parse(kv.get("state"));
saved.busy = { at: saved.status.at };
saved.seq = (saved.seq || 0) + 5; // newer than this isolate's own copy, like a run elsewhere that was cut off
kv.set("state", JSON.stringify(saved));
warp(600);
s = await run("run 12 (previous run was cut off)");
check("detects the interrupted run and halves the work", s.load === 0.5 && s.status.errors.some((e) => e.includes("中途被中断")));
warp(600);
s = await run("run 13");
check("recovers gradually", s.load > 0.5 && s.load < 1 && s.status.ok && !s.busy);
check("automatic settle interval", autoSettleHours(10) === 1 && autoSettleHours(100) === 5 && autoSettleHours(1000) === 24);

// 11) safety: refuses the operator key
const bad = await runOnce({ ...env, KEEPER_KEY: OPERATOR_KEY, STATE: { get: async () => null, put: async () => {} } });
check("refuses to run with the operator/admin key", bad.status.errors.some((e) => e.includes("运营/管理员钱包")));
const bad2 = await runOnce({ ...env, KEEPER_KEY: "", STATE: { get: async () => null, put: async () => {} } });
check("without KEEPER_KEY it creates its own wallet", !!bad2.generatedAddr && bad2.status.keeper === bad2.generatedAddr);
const bad3 = await runOnce({ ...env, STATE: undefined });
check("without KV: still checkpoints when due, does not settle", bad3.status.errors.some((e) => e.includes("STATE")));

// 12) the cron entry point + status page
let waited;
await worker.scheduled({ cron: "*/10 * * * *" }, env, { waitUntil: (p) => (waited = p) });
await waited;
const res = await worker.fetch(new Request("https://x.workers.dev/"), env);
const html = await res.text();
check("status page renders", res.status === 200 && html.includes("正常运行") && html.includes("运行中"));
check("status page never contains the key", !html.includes(KEEPER_KEY.slice(2)) && !JSON.stringify([...kv.values()]).includes(KEEPER_KEY.slice(2)));
fs.writeFileSync(new URL("./status.html", import.meta.url), html);

const by = (k) => gasLog.filter((g) => g.kind === k);
const avg = (a) => Math.round(a.reduce((x, g) => x + g.gas, 0) / Math.max(1, a.length));
console.log("\ngas: checkpoint avg", avg(by("checkpoint")), "| settle tx avg", avg(by("settle")), "max", Math.max(...by("settle").map((g) => g.gas)));
console.log("all receipts succeeded:", gasLog.every((g) => g.status === "0x1" || g.status === 1 || g.status === "1"));
console.log("kv reads/writes", kvReads, kvWrites);
console.log(fails ? `\n${fails} FAILURES` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
