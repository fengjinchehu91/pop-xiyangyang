#!/usr/bin/env node
// Read-only on-chain verification of the configured BSC addresses. No keys, no transactions.
//   node scripts/verify-chain.mjs                      (uses BSC_RPC_URL or the public BNB Chain RPC)
//   REWARD_POOL=0x... MINER=0x... node scripts/verify-chain.mjs
// Prints PASS/FAIL/WARN per check and exits non-zero on any FAIL.
import * as E from "../app/src/vendor/ethers.min.js";

const RPC = process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org";
const A = {
  XYY: "0x4dDA46C9dD7e794B99eebDcfD3c82bfBD3207777",
  POP: "0xA3cfB853339b77F385B994799B015cB04b208Fe6",
  POOL: "0xE5ce5bc4785CD2a246151364f5A190ceE3FDb142",
  OPERATOR: "0xe034Ab3ec8C6309A322c85acadbe81778836e296",
  // candidates from PancakeSwap docs / public sources — verified below, not trusted blindly
  FACTORY: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
  NPM: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
  BSC_USD: "0x55d398326f99059fF775485246999027B3197955",
};
const p = new E.JsonRpcProvider(RPC, 56, { staticNetwork: true });
let fails = 0;
const ok = (m) => console.log("PASS ", m);
const bad = (m) => { fails++; console.log("FAIL ", m); };
const warn = (m) => console.log("WARN ", m);
const erc20 = (a) => new E.Contract(a, ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function owner() view returns (address)"], p);
const pool = (a) => new E.Contract(a, ["function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)", "function tickSpacing() view returns (int24)", "function factory() view returns (address)", "function liquidity() view returns (uint128)", "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint32,bool)", "function observe(uint32[]) view returns (int56[],uint160[])"], p);

// selectors of functions that often indicate tax / blacklist / pause / mint powers (heuristic only)
const RISKY = ["pause()", "unpause()", "mint(address,uint256)", "blacklist(address)", "addToBlacklist(address)", "setBlacklist(address,bool)", "isBlacklisted(address)", "setFee(uint256)", "setTaxFee(uint256)", "setBuyFee(uint256)", "setSellFee(uint256)", "excludeFromFee(address)", "setMaxTxAmount(uint256)", "enableTrading()", "setTradingEnabled(bool)"];
async function scanCode(name, addr) {
  const code = await p.getCode(addr);
  if (code === "0x") return bad(`${name} ${addr}: no contract code`);
  ok(`${name} has code (${(code.length - 2) / 2} bytes)`);
  const hits = RISKY.filter((s) => code.includes(E.id(s).slice(2, 10)));
  if (hits.length) warn(`${name} bytecode contains selectors: ${hits.join(", ")} — inspect verified source; may imply tax/blacklist/pause/mint`);
  if (code.length < 200) warn(`${name} bytecode is tiny — likely a proxy; implementation can change`);
  try { const o = await erc20(addr).owner(); warn(`${name} owner() = ${o}${o === E.ZeroAddress ? " (renounced)" : ""}`); } catch {}
}

const net = await p.getNetwork();
Number(net.chainId) === 56 ? ok("chainId 56") : bad("chainId " + net.chainId);
for (const [n, a] of Object.entries({ XYY: A.XYY, POP: A.POP, POOL: A.POOL, FACTORY: A.FACTORY, NPM: A.NPM })) await scanCode(n, a);
const opCode = await p.getCode(A.OPERATOR);
if (fails) { console.log(`\n${fails} check(s) FAILED — wrong network/RPC or addresses; stopping`); process.exit(1); }
opCode === "0x" ? ok("operator is an EOA (ordinary wallet)") : warn("operator has code (contract wallet / 7702)");

for (const [n, a] of [["XYY", A.XYY], ["POP", A.POP]]) {
  const t = erc20(a);
  console.log(`INFO  ${n}: symbol=${await t.symbol()} decimals=${await t.decimals()} totalSupply=${await t.totalSupply()}`);
}
const P = pool(A.POOL);
const [t0, t1, fee, ts, fac, liq, s0] = await Promise.all([P.token0(), P.token1(), P.fee(), P.tickSpacing(), P.factory(), P.liquidity(), P.slot0()]);
console.log(`INFO  pool token0=${t0} token1=${t1} fee=${fee} tickSpacing=${ts} liquidity=${liq}`);
const usdt = t0.toLowerCase() === A.POP.toLowerCase() ? t1 : t1.toLowerCase() === A.POP.toLowerCase() ? t0 : null;
usdt ? ok("pool contains POP") : bad("pool does not contain POP");
if (usdt) {
  usdt.toLowerCase() === A.BSC_USD.toLowerCase() ? ok(`quote token = BSC-USD ${usdt}`) : bad(`quote token ${usdt} is NOT the known BSC-USD`);
  const ut = erc20(usdt);
  console.log(`INFO  quote token symbol=${await ut.symbol()} decimals=${await ut.decimals()}`);
}
fac.toLowerCase() === A.FACTORY.toLowerCase() ? ok("pool.factory = PancakeV3Factory") : bad("pool.factory = " + fac);
const F = new E.Contract(A.FACTORY, ["function getPool(address,address,uint24) view returns (address)"], p);
(await F.getPool(t0, t1, fee)).toLowerCase() === A.POOL.toLowerCase() ? ok("factory.getPool(token0,token1,fee) == pool") : bad("factory.getPool mismatch");
const N = new E.Contract(A.NPM, ["function factory() view returns (address)"], p);
(await N.factory()).toLowerCase() === A.FACTORY.toLowerCase() ? ok("NPM.factory == factory") : bad("NPM.factory mismatch");
console.log(`INFO  observation cardinality=${s0[3]} next=${s0[4]} (need history >= TWAP window)`);
try { await P.observe([1800, 0]); ok("pool has >= 30 min TWAP history"); } catch { bad("pool.observe(1800) reverts: TWAP history insufficient — call increaseObservationCardinalityNext and wait"); }
const lower = Math.trunc(-887272 / Number(ts)) * Number(ts);
console.log(`INFO  full-range ticks: [${lower}, ${-lower}]`);

const rp = process.env.REWARD_POOL;
if (!rp) warn("REWARD_POOL not set: 喜羊羊 price source not verified — PRODUCTION BLOCKER");
else {
  const R = pool(rp);
  const [r0, r1, rf, rfac] = await Promise.all([R.token0(), R.token1(), R.fee(), R.factory()]);
  const other = r0.toLowerCase() === A.XYY.toLowerCase() ? r1 : r1.toLowerCase() === A.XYY.toLowerCase() ? r0 : null;
  other ? ok(`reward pool pairs XYY with ${other}`) : bad("reward pool does not contain XYY");
  if (other && ![A.POP, usdt].map((x) => x?.toLowerCase()).includes(other.toLowerCase())) bad("reward pool counter-token is neither POP nor USDT");
  rfac.toLowerCase() === A.FACTORY.toLowerCase() && (await F.getPool(r0, r1, rf)).toLowerCase() === rp.toLowerCase() ? ok("reward pool from PancakeV3Factory") : bad("reward pool factory mismatch");
  try { await R.observe([1800, 0]); ok("reward pool TWAP history >= 30 min"); } catch { bad("reward pool TWAP history insufficient"); }
  console.log(`INFO  reward pool liquidity=${await R.liquidity()}`);
}
const bal = await erc20(A.XYY).balanceOf(A.OPERATOR);
console.log(`INFO  operator XYY balance=${bal}`);
const miner = process.env.MINER;
if (miner) {
  const al = await new E.Contract(A.XYY, ["function allowance(address,address) view returns (uint256)"], p).allowance(A.OPERATOR, miner);
  console.log(`INFO  operator -> miner allowance=${al}`);
}
console.log("NOTE  Transfer-tax behaviour cannot be proven by reads; run the fork test test_fork_transferTaxProbe.");
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall hard checks passed");
process.exit(fails ? 1 : 0);
