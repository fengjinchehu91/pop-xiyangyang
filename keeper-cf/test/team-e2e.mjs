// Local chain: real deposits (USDT only / USDT + POP) in a 3-level referral chain, the real worker reads the
// events (also starting from an old v1 saved state), and /keeper/team.json reports the team numbers.
import { execSync } from "node:child_process";
import fs from "node:fs";
import worker, { runOnce } from "../dist/worker.test.mjs";
const RPC = "http://127.0.0.1:8546";
const dep = JSON.parse(fs.readFileSync("/home/claude/xyy/contracts/web-deploy.json", "utf8"));
const M = dep.miner;
const cast = (a) => execSync(`/tmp/foundry/cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
const OPK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const W = {
  A: ["0x976EA74026E726554dB657fA54763abd0C3a0aa9", "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"],
  B: ["0x14dC79964da2C08b23698B3D3cc7Ca32193d9955", "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"],
  C: ["0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f", "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97"],
};
const E18 = 10n ** 18n;
let fails = 0;
const check = (n, c, x = "") => { if (!c) fails++; console.log(c ? "ok  " : "FAIL", n, x); };
const send = (key, to, sig, args) => cast(`send ${to} "${sig}" ${args} --private-key ${key} --gas-limit 3000000`);
const deposit = (w, usdt, pop, swap) => {
  const [a, k] = W[w];
  send(OPK, dep.usdt, "mint(address,uint256)", `${a} ${usdt}`);
  send(k, dep.usdt, "approve(address,uint256)", `${M} ${usdt}`);
  if (pop > 0n) {
    send(OPK, dep.pop, "mint(address,uint256)", `${a} ${pop}`);
    send(k, dep.pop, "approve(address,uint256)", `${M} ${pop}`);
  }
  const ts = Number(cast("block latest -f timestamp"));
  const out = send(k, M, "deposit((uint256,uint256,uint256,uint256,uint256,uint256,address,uint256))", `"(${usdt},${pop},${swap},0,0,0,0x0000000000000000000000000000000000000000,${ts + 600})"`);
  if (!/status\s+1/.test(out)) throw new Error("deposit failed " + w);
};
// chain A -> B -> C ; A deposits USDT only, B adds USDT + POP, C deposits USDT only
deposit("A", 300n * E18, 0n, (300n * E18 * 10000n) / 19995n);
send(W.B[1], M, "bind(address)", W.A[0]);
deposit("B", 100n * E18, 10_000_000n * E18, 0n);
send(W.C[1], M, "bind(address)", W.B[0]);
deposit("C", 50n * E18, 0n, (50n * E18 * 10000n) / 19995n);

cast("rpc anvil_mine 8"); // the keeper only reads blocks with 5 confirmations
const kv = new Map();
const STATE = { async get(k, t) { const v = kv.get(k); return v === undefined ? null : t === "json" ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, v); } };
const env = { KEEPER_KEY: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6", STATE, MINER: M, DEPLOY_BLOCK: "0", CHAIN_ID: "31337", RPC_URL: RPC, RPC_URL_2: "", LOG_RPC_URLS: RPC, MAX_GAS_GWEI: "100" };
// an old (v1) saved state, as the live keeper has it now: wallet list without referrers / amounts, fully scanned
const head = Number(cast("block-number"));
kv.set("state", JSON.stringify({ v: 1, miner: M.toLowerCase(), scanned: head, chunk: 1000, users: { [W.B[0].toLowerCase()]: ["1", 1] }, settleCursor: 0, lastSettle: 0, lastSentAt: 0, lastGasPrice: "0", pending: [], load: 1, busy: null, balHist: [], status: null, seq: 5 }));
const team = async (a) => (await (await worker.fetch(new Request(`https://x/keeper/team.json?u=${a}`), env)).json());
let s = await runOnce(env);
console.log("run 1:", s.status.actions.join(" | "), s.status.errors.join(" | "));
check("old state upgraded and rebuilt from the start", s.v === 3 && !s.rebuilding && Object.keys(s.users).length === 3, `v=${s.v} users=${Object.keys(s.users).length}`);
await new Promise((r) => setTimeout(r, 21000)); // page cache of the saved state is 20 s
const tA = await team(W.A[0]);
console.log(JSON.stringify(tA));
const near = (x, y, tol = 1e-9) => Math.abs(Number(BigInt(x) - y)) <= Number(y) * tol + 1e6;
check("A: direct 1, indirect 1, team 2", tA.ok && tA.direct === 1 && tA.indirect === 1 && tA.team === 2);
check("A's team USDT-only = C's 50 USDT (minus a tiny refund)", BigInt(tA.usdtOnly) > 49n * E18 && BigInt(tA.usdtOnly) <= 50n * E18, tA.usdtOnly);
const bU = BigInt(tA.bothUsdt);
check("A's team USDT + POP = B's USDT part and a POP part", bU > 99n * E18 && bU <= 100n * E18 && BigInt(tA.bothPop) > 0n, `${tA.bothUsdt} / ${tA.bothPop}`);
check("B's two-token value ~ 2 x its USDT part", near(tA.bothValue, 2n * bU, 1e-6), tA.bothValue);
const liqB = BigInt(cast(`call ${M} "getUser(address)((address,bool,uint64,uint128))" ${W.B[0]}`).match(/, (\d+)/g)[1].slice(2));
const liqC = BigInt(cast(`call ${M} "getUser(address)((address,bool,uint64,uint128))" ${W.C[0]}`).match(/, (\d+)/g)[1].slice(2));
check("A's team liquidity = B + C on chain", near(tA.liquidity, liqB + liqC, 1e-12), `${tA.liquidity} vs ${liqB + liqC}`);
const tC = await team(W.C[0]);
check("C (bottom): empty team", tC.ok && tC.team === 0 && tC.direct === 0);
const tB = await team(W.B[0]);
check("B: team 1 (C)", tB.ok && tB.team === 1 && tB.direct === 1 && tB.indirect === 0);
const pj = await (await worker.fetch(new Request(`https://x/keeper/principal.json?u=${W.A[0]},${W.B[0]},${W.C[0]}`), env)).json();
const P = (w) => BigInt(pj.p[W[w][0].toLowerCase()]);
check("amount put in: A ~300, B ~200 (USDT + POP), C ~50", pj.ok && P("A") > 299n * E18 && P("A") <= 300n * E18 && P("B") > 199n * E18 && P("B") <= 200n * E18 && P("C") > 49n * E18 && P("C") <= 50n * E18, JSON.stringify(pj.p));
s = await runOnce(env); // the reminder is worked out once the history has been read
check("admin reminder fields present", s.status.eligMismatch === 0 && s.status.eligThreshold === (100n * E18).toString(), `${s.status.eligMismatch} / ${s.status.eligThreshold} / min ${s.status.eligMinValue}`);
// admin raises the contract threshold to 250: B (put in 200, LP ~200) is still shown eligible but the contract stops paying
send(OPK, M, "setRewardParams(uint16,uint16,uint16,uint16,uint256)", `100 8500 1000 500 ${250n * E18}`);
s = await runOnce(env);
check("reminder: 1 wallet shown eligible but below the 250 threshold, lowest value ~200", s.status.eligMismatch === 1 && BigInt(s.status.eligMinValue) > 199n * E18 && BigInt(s.status.eligMinValue) < 201n * E18, `${s.status.eligMismatch} / ${s.status.eligMinValue}`);
fs.writeFileSync("/tmp/webtest/keeper/principal.json", JSON.stringify(pj));
const bad = await team("0x123");
check("bad address refused", bad.ok === false);
fs.mkdirSync("/tmp/webtest/keeper", { recursive: true });
fs.writeFileSync("/tmp/webtest/keeper/team.json", JSON.stringify(tA));
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
