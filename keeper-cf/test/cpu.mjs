// CPU cost of one run, without network: `record` runs against Anvil and saves every RPC response,
// `replay` (fresh process = cold isolate) feeds them back and measures only the worker's own CPU time.
import fs from "node:fs";
import { execSync } from "node:child_process";

const mode = process.argv[2];
const FILE = "/tmp/keeper-cpu-tape.json";
const RPC = "http://127.0.0.1:8545";
const dep = JSON.parse(fs.readFileSync(new URL("../../contracts/keeper-deploy.json", import.meta.url), "utf8"));
const kv = new Map();
const STATE = { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => kv.set(k, v) };
const env = {
  KEEPER_KEY: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  STATE, MINER: dep.miner, DEPLOY_BLOCK: "0", CHAIN_ID: "31337", RPC_URL: RPC, RPC_URL_2: "", MAX_GAS_GWEI: "100",
};

const steady = process.argv[3] === "steady";
const TAPE = steady ? FILE.replace(".json", "-steady.json") : FILE;
if (mode === "record") {
  const warpCmd = `cast rpc evm_increaseTime 3700 --rpc-url ${RPC} && cast rpc evm_mine --rpc-url ${RPC}`;
  execSync(warpCmd);
  if (steady) {
    // first run fills KV (not recorded); the recorded run then only reads ~1 hour of new events
    const { runOnce } = await import("../dist/worker.test.mjs");
    await runOnce(env);
    for (let i = 0; i < 6; i++) execSync(`cast rpc evm_mine --rpc-url ${RPC}`);
    execSync(warpCmd);
    fs.writeFileSync(TAPE + ".kv", kv.get("state"));
  }
  const tape = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const r = await real(url, init);
    const body = await r.text();
    tape.push(body);
    return new Response(body, { status: r.status });
  };
  const { runOnce } = await import("../dist/worker.test.mjs");
  // worst realistic case: empty KV (reads the whole event history) + settle of every wallet + checkpoint
  const s = await runOnce(env);
  console.log("recorded", tape.length, "responses;", s.status.actions.length, "actions;", s.status.errors);
  fs.writeFileSync(TAPE, JSON.stringify(tape));
} else {
  const tape = JSON.parse(fs.readFileSync(TAPE, "utf8"));
  if (steady) kv.set("state", fs.readFileSync(TAPE + ".kv", "utf8"));
  // node implements Response/fetch in JS (undici) and compiles it lazily; warm that up first because on
  // Cloudflare these are native and not part of the worker's CPU time
  for (let k = 0; k < 50; k++) await new Response(JSON.stringify({ a: [1, 2, 3], k })).json();
  let i = 0;
  globalThis.fetch = async () => new Response(tape[i++], { status: 200 });
  const t0 = process.cpuUsage();
  const w = await import("../dist/worker.test.mjs"); // includes the start-up precompute
  const t1 = process.cpuUsage(t0);
  const c0 = process.cpuUsage();
  const s = await w.runOnce(env);
  const c1 = process.cpuUsage(c0);
  const ms = (c) => ((c.user + c.system) / 1000).toFixed(1);
  console.log(`startup (global scope, incl. precompute): ${ms(t1)} ms`);
  console.log(`cold run, ${s.status.users} wallets, ${s.status.actions.length} transactions signed, responses ${tape.map((x) => x.length)} bytes: ${ms(c1)} ms`);
  // second run in the same isolate (warm): no new events, nothing due
  i = 0;
  const c2 = process.cpuUsage();
  await w.runOnce(env);
  console.log(`warm run (same responses again): ${ms(process.cpuUsage(c2))} ms`);
}
