#!/usr/bin/env node
// Keeper: periodically calls the permissionless checkpoint() and settleMany(). It holds NO special rights:
// it cannot change balances, report prices or move funds — the contract derives everything from the pool TWAP
// and the operator's balance/allowance. If it stops, accrual stops automatically after MAX_VALUATION_AGE and
// any user action (deposit / claim) also checkpoints; withdrawals never depend on it.
//
// env: RPC_URL, MINER, KEEPER_PRIVATE_KEY (a fresh wallet holding only a little BNB for gas),
//      INTERVAL_SEC=600, SETTLE_EVERY=6 (rounds), BATCH=50, DEPLOY_BLOCK, LOG_CHUNK=5000, STATUS_FILE=keeper-status.json
import fs from "node:fs";
import * as E from "../app/src/vendor/ethers.min.js";

const env = (k, d) => process.env[k] ?? d;
const RPC = env("RPC_URL");
const MINER = env("MINER");
const KEY = env("KEEPER_PRIVATE_KEY");
if (!RPC || !MINER || !KEY) {
  console.error("RPC_URL, MINER and KEEPER_PRIVATE_KEY are required");
  process.exit(1);
}
const INTERVAL = Number(env("INTERVAL_SEC", 600)) * 1000;
const SETTLE_EVERY = Number(env("SETTLE_EVERY", 6));
const BATCH = Number(env("BATCH", 50));
const CHUNK = Number(env("LOG_CHUNK", 5000));
const STATUS = env("STATUS_FILE", "keeper-status.json");

const provider = new E.JsonRpcProvider(RPC);
const wallet = new E.Wallet(KEY, provider);
const m = new E.Contract(
  MINER,
  [
    "function checkpoint() returns (bool)",
    "function settleMany(address[])",
    "function accruing() view returns (bool)",
    "function pauseReasons() view returns (uint8)",
    "event Joined(address indexed user, address indexed referrer, address indexed referrer2, uint256 time)",
  ],
  wallet,
);
const users = new Set();
let scanned = Number(env("DEPLOY_BLOCK", 0)) - 1;
let round = 0;
const status = { startedAt: new Date().toISOString(), lastOk: null, lastError: null, accruing: null, reasons: null, users: 0 };
const save = () => fs.writeFileSync(STATUS, JSON.stringify(status, null, 2));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function syncUsers() {
  const head = await provider.getBlockNumber();
  for (let from = scanned + 1; from <= head; from += CHUNK) {
    const to = Math.min(head, from + CHUNK - 1);
    for (const l of await m.queryFilter(m.filters.Joined(), from, to)) users.add(l.args.user);
    scanned = to;
  }
  status.users = users.size;
}

async function once() {
  round++;
  try {
    // simulate first: skip sending if it would revert
    await m.checkpoint.staticCall();
    const tx = await m.checkpoint();
    await tx.wait();
    status.accruing = await m.accruing();
    status.reasons = Number(await m.pauseReasons());
    log("checkpoint", tx.hash, "accruing", status.accruing, "reasons", status.reasons);
    if (round % SETTLE_EVERY === 0) {
      await syncUsers();
      const list = [...users];
      for (let i = 0; i < list.length; i += BATCH) {
        const t = await m.settleMany(list.slice(i, i + BATCH));
        await t.wait();
        log("settleMany", i, "-", Math.min(i + BATCH, list.length), t.hash);
      }
    }
    status.lastOk = new Date().toISOString();
  } catch (e) {
    status.lastError = `${new Date().toISOString()} ${e?.shortMessage || e?.message}`;
    log("ERROR", status.lastError);
  }
  save();
}

log("keeper", await wallet.getAddress(), "miner", MINER, "interval", INTERVAL / 1000, "s");
await once();
setInterval(once, INTERVAL);
