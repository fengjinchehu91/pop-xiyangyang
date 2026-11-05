// 喜羊羊矿场 · 自动检查服务（Cloudflare Workers 版）
//
// Runs on a Cloudflare Cron Trigger (every 10 minutes). Each run:
//   1. reads the contract state with one batched JSON-RPC request;
//   2. sends checkpoint() when the last checkpoint is older than CHECK_MINUTES, or when the running state would
//      change (e.g. the reserve became too low, or it recovered) so pauses / resumes happen within ~10 minutes;
//   3. once per SETTLE_HOURS, sends settleMany() for every wallet that has a referrer and an open position, so that
//      referral (dynamic) rewards show up for the uplines without anyone clicking anything.
//
// The keeper wallet has NO special rights in the contract: checkpoint() and settleMany() are permissionless and
// cannot move anyone's funds. It only needs a little BNB for gas. Use a brand-new wallet for it — never the
// operator / admin wallet (this program refuses to run with those keys).
//
// Required:   secret KEEPER_KEY (private key of the new keeper wallet), KV binding STATE.
// Optional:   RPC_URL, RPC_URL_2, MINER, DEPLOY_BLOCK, CHECK_MINUTES, SETTLE_HOURS, MAX_GAS_GWEI.
//
// Crypto: noble-secp256k1 + noble-hashes (MIT, audited, vendored unchanged).

import * as secp from "../vendor/secp256k1.ts";
import { keccak_256 } from "../vendor/hashes/sha3.ts";
import { sha256 } from "../vendor/hashes/sha2.ts";
import { hmac } from "../vendor/hashes/hmac.ts";

secp.hashes.hmacSha256 = (k, m) => hmac(sha256, k, m);
secp.hashes.sha256 = sha256;


const DEFAULTS = {
  MINER: "0x363CBA25a4bC4617fAF017b1e0728f4AB7473E17",
  DEPLOY_BLOCK: 131739316,
  CHAIN_ID: 56,
  RPC_URL: "https://bsc-rpc.publicnode.com",
  RPC_URL_2: "https://bsc-dataseed.bnbchain.org",
  EXPLORER: "https://bscscan.com",
  CHECK_MINUTES: 25, // refresh the price / valuation at least this often
  SETTLE_HOURS: "", // empty = automatic: hourly for up to 20 wallets, then longer (100 wallets: every 5 h; 480+: daily)
  BATCH: 100, // wallets per settleMany transaction
  MAX_SETTLE_TX: 2, // settle transactions per run (the rest continue in the next run)
  LOG_CHUNK: 5000, // blocks per eth_getLogs
  MAX_LOG_CALLS: 12, // eth_getLogs calls per run
  MAX_GAS_GWEI: 1, // never pay more than this per gas
  CONFIRMATIONS: 5,
};
const SUBREQUEST_BUDGET = 45; // Workers Free allows 50 outgoing requests per run

const REASONS = [
  [1, "管理员已暂停"],
  [2, "流动性估值暂不可用（价格历史不足、偏离过大或流动性不足）"],
  [4, "喜羊羊价格暂不可用（需要约 30 分钟价格历史）"],
  [8, "运营钱包的喜羊羊余额或授权额度不足"],
  [16, "挖矿已永久结束"],
];

// ------------------------------------------------------------------ small helpers

const enc = new TextEncoder();
const toHex = (b) => {
  let s = "0x";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
};
const fromHex = (h) => {
  if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error("bad hex");
  if (h.length % 2) h = "0" + h;
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return b;
};
const concat = (arr) => {
  let n = 0;
  for (const a of arr) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arr) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
const intBytes = (v) => {
  v = BigInt(v);
  if (v < 0n) throw new Error("negative");
  if (v === 0n) return new Uint8Array(0);
  return fromHex(v.toString(16));
};
const stripZeros = (b) => {
  let i = 0;
  while (i < b.length && b[i] === 0) i++;
  return b.subarray(i);
};
const qty = (v) => "0x" + BigInt(v).toString(16);
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const selector = (sig) => toHex(keccak_256(enc.encode(sig)).subarray(0, 4)).slice(2);
const topicOf = (sig) => toHex(keccak_256(enc.encode(sig)));
const big = (h) => (h && h !== "0x" ? BigInt(h) : 0n);

const SEL = {
  checkpoint: selector("checkpoint()"),
  settleMany: selector("settleMany(address[])"),
  accruing: selector("accruing()"),
  pauseReasons: selector("pauseReasons()"),
  lastCheckpointTime: selector("lastCheckpointTime()"),
  operator: selector("OPERATOR()"),
  owner: selector("owner()"),
};
const T_JOINED = topicOf("Joined(address,address,address,uint256)");
const T_DEPOSITED = topicOf("Deposited(address,uint256,uint128,uint256,uint256,uint256,uint256,uint256,uint256)");
const T_WITHDRAWN = topicOf("Withdrawn(address,uint128,uint256,uint256,uint256,uint256)");

// ------------------------------------------------------------------ RLP + legacy (EIP-155) transaction signing

function rlp(x) {
  if (Array.isArray(x)) {
    const parts = x.map(rlp);
    let len = 0;
    for (const p of parts) len += p.length;
    return concat([rlpLen(len, 0xc0), ...parts]);
  }
  if (x.length === 1 && x[0] < 0x80) return x;
  return concat([rlpLen(x.length, 0x80), x]);
}
function rlpLen(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len);
  const lb = intBytes(len);
  return concat([Uint8Array.of(offset + 55 + lb.length), lb]);
}

export function signLegacyTx(tx, key) {
  const base = [
    intBytes(tx.nonce),
    intBytes(tx.gasPrice),
    intBytes(tx.gasLimit),
    fromHex(tx.to),
    intBytes(tx.value || 0),
    fromHex(tx.data || "0x"),
  ];
  const digest = keccak_256(rlp([...base, intBytes(tx.chainId), new Uint8Array(0), new Uint8Array(0)]));
  const sig = secp.sign(digest, key, { prehash: false, format: "recovered" }); // [recovery, r(32), s(32)]
  const v = BigInt(tx.chainId) * 2n + 35n + BigInt(sig[0]);
  const raw = rlp([...base, intBytes(v), stripZeros(sig.subarray(1, 33)), stripZeros(sig.subarray(33, 65))]);
  return { raw: toHex(raw), hash: toHex(keccak_256(raw)) };
}

export function addressOf(key) {
  const pub = secp.getPublicKey(key, false);
  return toHex(keccak_256(pub.subarray(1)).subarray(12));
}

export function encodeSettleMany(list) {
  let s = SEL.settleMany + word(32) + word(list.length);
  for (const a of list) s += a.slice(2).toLowerCase().padStart(64, "0");
  return "0x" + s;
}

// ------------------------------------------------------------------ JSON-RPC with batching and a fallback node

class Rpc {
  constructor(urls, budget) {
    this.urls = urls;
    this.left = budget;
    this.id = 1;
  }
  async post(url, body) {
    if (this.left <= 0) throw new Error("本次运行的网络请求次数已用完");
    this.left--;
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`节点返回 HTTP ${r.status}`);
    return r.json();
  }
  // calls: [[method, params], ...] -> [{result} | {error}, ...] in the same order
  async batch(calls) {
    let lastErr = null;
    let lastOut = null;
    for (const url of this.urls) {
      const reqs = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: this.id++, method, params }));
      let res = null;
      try {
        res = reqs.length === 1 ? [await this.post(url, reqs[0])] : await this.post(url, reqs);
        if (!Array.isArray(res)) res = null;
      } catch (e) {
        lastErr = e;
        res = null;
      }
      if (!res && reqs.length > 1) {
        // this node does not accept batches: send one by one
        try {
          res = [];
          for (const q of reqs) res.push(await this.post(url, q));
        } catch (e) {
          lastErr = e;
          res = null;
        }
      }
      if (!res) continue;
      const byId = new Map(res.map((x) => [x && x.id, x]));
      const out = reqs.map((q) => byId.get(q.id) || { error: { message: "节点没有返回结果" } });
      // every call failed and none is an ordinary contract revert: probably the node itself, try the next one
      if (out.every((x) => x.error && !/revert|nonce|known|underpriced|insufficient/i.test(x.error.message || ""))) {
        lastOut = out;
        continue;
      }
      return out;
    }
    if (lastOut) return lastOut;
    throw lastErr || new Error("无法连接 BSC 节点");
  }
  async call(method, params) {
    const [r] = await this.batch([[method, params]]);
    if (r.error) throw new Error(r.error.message || "节点返回错误");
    return r.result;
  }
}

// ------------------------------------------------------------------ config + state

function config(env) {
  const num = (k) => {
    const v = env[k];
    return v === undefined || v === "" ? DEFAULTS[k] : Number(v);
  };
  const str = (k) => (env[k] ? String(env[k]).trim() : DEFAULTS[k]);
  const rpcs = [str("RPC_URL"), str("RPC_URL_2")].filter((u, i, a) => u && a.indexOf(u) === i);
  return {
    miner: str("MINER").toLowerCase(),
    deployBlock: num("DEPLOY_BLOCK"),
    chainId: num("CHAIN_ID"),
    rpcs,
    explorer: str("EXPLORER"),
    checkMinutes: Math.max(10, num("CHECK_MINUTES")),
    settleHours: env.SETTLE_HOURS ? Math.max(0.25, Number(env.SETTLE_HOURS)) : null,
    batch: Math.min(150, Math.max(1, num("BATCH"))),
    maxSettleTx: Math.max(1, num("MAX_SETTLE_TX")),
    logChunk: Math.max(100, num("LOG_CHUNK")),
    maxLogCalls: Math.max(1, num("MAX_LOG_CALLS")),
    maxGasWei: BigInt(Math.round(num("MAX_GAS_GWEI") * 1e9)),
    confirmations: num("CONFIRMATIONS"),
  };
}

function freshState(c) {
  return {
    v: 1,
    miner: c.miner,
    scanned: c.deployBlock - 1,
    chunk: c.logChunk,
    users: {}, // address -> [liquidity (decimal string), hasReferrer (0/1)]
    settleCursor: 0,
    lastSettle: 0,
    lastSentAt: 0,
    lastGasPrice: "0",
    pending: [], // recently sent transactions not yet mined (by nonce)
    load: 1, // 0.25..1: shrinks automatically if a run gets cut off (CPU limit)
    busy: null,
    balHist: [],
    status: null,
  };
}

async function loadState(env, c) {
  if (!env.STATE || typeof env.STATE.get !== "function") return { ok: false, why: "还没有绑定 KV（变量名 STATE）", s: freshState(c) };
  try {
    const s = await env.STATE.get("state", "json");
    if (!s || s.v !== 1 || s.miner !== c.miner) return { ok: true, s: freshState(c) };
    return { ok: true, s };
  } catch (e) {
    // never overwrite the saved wallet list after a failed read
    return { ok: false, why: "读取 KV 失败：" + (e?.message || e), s: freshState(c) };
  }
}

function applyLog(users, l) {
  if (l.removed) return;
  const t0 = (l.topics[0] || "").toLowerCase();
  if (t0 !== T_JOINED && t0 !== T_DEPOSITED && t0 !== T_WITHDRAWN) return;
  const u = "0x" + l.topics[1].slice(26).toLowerCase();
  const e = users[u] || (users[u] = ["0", 0]);
  if (t0 === T_JOINED) {
    e[1] = big(l.topics[2]) !== 0n ? 1 : 0;
  } else {
    const liq = BigInt("0x" + l.data.slice(2, 66));
    let v = BigInt(e[0]) + (t0 === T_DEPOSITED ? liq : -liq);
    if (v < 0n) v = 0n;
    e[0] = v.toString();
  }
}

const settleList = (s) => Object.keys(s.users).filter((a) => s.users[a][1] === 1 && s.users[a][0] !== "0");

// ------------------------------------------------------------------ one scheduled run

let cachedKey = null; // { str, key, addr } kept in memory of this isolate only, never stored or shown

function keyFromEnv(env) {
  const str = String(env.KEEPER_KEY || "").trim();
  if (cachedKey && cachedKey.str === str) return cachedKey;
  if (!str) throw new Error("还没有设置 KEEPER_KEY（检查钱包的私钥）");
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(str)) throw new Error("KEEPER_KEY 格式不对：应该是 64 位十六进制私钥");
  const key = fromHex(str);
  let addr;
  try {
    addr = addressOf(key);
  } catch {
    throw new Error("KEEPER_KEY 不是有效的私钥");
  }
  cachedKey = { str, key, addr };
  return cachedKey;
}

const label = (k) => (k === "settle" ? "结算" : "检查");
// referral settlement interval: hourly for small lists, longer for big ones so gas stays roughly flat (max daily)
export const autoSettleHours = (n) => Math.min(24, Math.max(1, n / 20));

export async function runOnce(env) {
  const c = config(env);
  const loaded = await loadState(env, c);
  const s = loaded.s;
  const st = {
    at: 0,
    head: 0,
    ok: false,
    actions: [],
    errors: [],
    accruing: null,
    reasons: null,
    lastCheckpoint: null,
    keeper: null,
    balance: null,
    gasPrice: null,
    users: Object.keys(s.users).length,
    toSettle: settleList(s).length,
    settleHours: null,
  };
  if (!loaded.ok) st.errors.push(loaded.why);
  if (loaded.ok && s.busy) {
    // the previous run stopped half-way (most likely the 10 ms CPU limit): do less per run from now on
    s.load = Math.max(0.25, (s.load || 1) / 2);
    st.errors.push("上次运行中途被中断（可能是 CPU 超时），已自动减少每次的工作量");
  }
  const load = (loaded.ok && s.load) || 1;
  const rpc = new Rpc(c.rpcs, SUBREQUEST_BUDGET);
  const save = async (busy) => {
    if (!loaded.ok) return;
    s.busy = busy;
    s.status = st;
    try {
      await env.STATE.put("state", JSON.stringify(s));
    } catch (e) {
      st.errors.push("保存 KV 失败：" + (e?.message || e));
    }
  };

  try {
    const { key, addr: me } = keyFromEnv(env);
    st.keeper = me;

    // ---- 1. one batched read
    const ethCall = (data, from) => ["eth_call", [from ? { from, to: c.miner, data } : { to: c.miner, data }, "latest"]];
    const r = await rpc.batch([
      ["eth_chainId", []],
      ["eth_getBlockByNumber", ["latest", false]],
      ["eth_gasPrice", []],
      ["eth_getTransactionCount", [me, "latest"]],
      ["eth_getTransactionCount", [me, "pending"]],
      ["eth_getBalance", [me, "latest"]],
      ethCall("0x" + SEL.accruing),
      ethCall("0x" + SEL.pauseReasons),
      ethCall("0x" + SEL.lastCheckpointTime),
      ethCall("0x" + SEL.checkpoint, me),
      ethCall("0x" + SEL.operator),
      ethCall("0x" + SEL.owner),
    ]);
    const need = (i, what) => {
      if (r[i].error) throw new Error(`读取${what}失败：${r[i].error.message}`);
      return r[i].result;
    };
    const chainId = Number(need(0, "链 ID"));
    if (chainId !== c.chainId) throw new Error(`连接的不是正确的链（链 ID ${chainId}，应为 ${c.chainId}）`);
    const blk = need(1, "最新区块");
    const head = Number(blk.number);
    const now = Number(blk.timestamp);
    st.at = now;
    st.head = head;
    const operator = "0x" + String(need(10, "运营钱包地址")).slice(-40).toLowerCase();
    const owner = "0x" + String(need(11, "管理员地址")).slice(-40).toLowerCase();
    if (me === operator || me === owner) {
      throw new Error("KEEPER_KEY 填的是运营/管理员钱包的私钥！已拒绝运行。请立刻删除这个密钥，换一个全新的钱包，并把运营钱包的资产转到安全的新钱包。");
    }
    if (!r[8].error && (r[8].result === "0x" || !r[8].result)) throw new Error("MINER 地址不是挖矿合约，请检查合约地址");
    let gasPrice = big(need(2, "手续费价格"));
    const nonceLatest = Number(need(3, "交易序号"));
    const noncePending = Number(need(4, "交易序号"));
    const balance = big(need(5, "BNB 余额"));
    const accruing = big(need(6, "运行状态")) !== 0n;
    const reasons = Number(big(need(7, "暂停原因")));
    const lastCp = Number(big(need(8, "上次检查时间")));
    st.balance = balance.toString();
    st.accruing = accruing;
    st.reasons = reasons;
    st.lastCheckpoint = lastCp;

    // transactions from earlier runs: mined once the account nonce moved past them (receipts are not fetched:
    // settle receipts carry hundreds of logs and would cost CPU to parse; every tx is simulated before sending)
    const still = [];
    for (const t of s.pending || []) {
      if (typeof t.nonce !== "number" || nonceLatest > t.nonce) continue;
      if (now - t.at < 1800) still.push(t);
      else st.errors.push(`交易长时间未确认：${t.hash}`);
    }
    s.pending = still;

    const floor = 50_000_000n; // 0.05 gwei, BSC minimum
    if (gasPrice < floor) gasPrice = floor;
    if (gasPrice > c.maxGasWei) gasPrice = c.maxGasWei;
    let nonce = noncePending;
    let spendable = balance;

    // estimate -> check balance -> sign -> send; returns the transactions the node accepted
    const sendTxs = async (txs) => {
      if (!txs.length) return [];
      const est = await rpc.batch(txs.map((t) => ["eth_estimateGas", [{ from: me, to: t.to, data: t.data }]]));
      const ready = [];
      for (let i = 0; i < txs.length; i++) {
        const t = txs[i];
        if (est[i].error) {
          st.errors.push(`${label(t.kind)}交易预估失败：${est[i].error.message}`);
          break; // keep the list contiguous (settle progress is counted from the front)
        }
        const gas = (big(est[i].result) * 13n) / 10n + 15000n;
        if (gas * gasPrice > spendable) {
          st.errors.push("检查钱包的 BNB 不够付手续费，请往检查钱包里转一点 BNB");
          break;
        }
        spendable -= gas * gasPrice;
        ready.push({ ...t, gas });
      }
      if (!ready.length) return [];
      const signed = ready.map((t) => {
        const n = nonce++;
        const tx = { nonce: n, gasPrice, gasLimit: t.gas, to: t.to, value: 0, data: t.data, chainId: c.chainId };
        return { ...t, nonce: n, ...signLegacyTx(tx, key) };
      });
      const res = await rpc.batch(signed.map((t) => ["eth_sendRawTransaction", [t.raw]]));
      const out = [];
      for (let i = 0; i < signed.length; i++) {
        const t = signed[i];
        const e = res[i].error;
        if (e && !/already known|known transaction/i.test(e.message || "")) {
          st.errors.push(`发送${label(t.kind)}交易失败：${e.message}`);
          break;
        }
        s.pending.push({ hash: t.hash, kind: t.kind, at: now, nonce: t.nonce });
        out.push(t);
      }
      if (out.length) {
        s.lastSentAt = now;
        s.lastGasPrice = gasPrice.toString();
      }
      s.pending = s.pending.slice(-8);
      return out;
    };

    // ---- 2. the important part first, on its own: checkpoint (keeps prices fresh, pauses / resumes)
    let wouldRun = null;
    if (r[9].error) st.errors.push("检查调用会失败：" + r[9].error.message);
    else wouldRun = big(r[9].result) !== 0n;
    const stuck = noncePending > nonceLatest && now - (s.lastSentAt || 0) > 300;
    let cpTx = null;
    if (stuck) {
      // a transaction from an earlier run is stuck: replace it (same nonce, higher price)
      nonce = nonceLatest;
      const last = BigInt(s.lastGasPrice || "0");
      gasPrice = (gasPrice > last ? gasPrice : last) * 2n;
      if (gasPrice > c.maxGasWei) gasPrice = c.maxGasWei;
      st.actions.push("发现卡住的交易，提高手续费重新发送");
      const tx = wouldRun !== null ? { kind: "checkpoint", to: c.miner, data: "0x" + SEL.checkpoint } : { kind: "replace", to: me, data: "0x" };
      cpTx = (await sendTxs([tx])).find((t) => t.kind === "checkpoint") || null;
    } else if (wouldRun !== null && (now - lastCp >= c.checkMinutes * 60 || wouldRun !== accruing)) {
      cpTx = (await sendTxs([{ kind: "checkpoint", to: c.miner, data: "0x" + SEL.checkpoint }]))[0] || null;
    }
    if (cpTx) {
      s.lastCheckpointTx = { hash: cpTx.hash, at: now };
      if (wouldRun !== accruing) st.actions.push(wouldRun ? "条件已恢复，恢复计息" : "条件不满足，暂停计息");
      st.actions.push(`更新价格并检查：${cpTx.hash}`);
      // show the state this checkpoint produces (the reads above were taken before it)
      st.lastCheckpoint = now;
      if (wouldRun !== accruing) st.reasons = wouldRun ? 0 : null;
      st.accruing = wouldRun;
    }
    st.gasPrice = gasPrice.toString();

    // ---- 3. optional work: discover wallets, then settle referral rewards
    if (loaded.ok && !stuck) {
      await save({ at: now }); // if this run is cut off below, the next run sees "busy" and does less

      try {
        const to = head - c.confirmations;
        const maxCalls = Math.max(1, Math.round(c.maxLogCalls * load));
        let calls = 0;
        while (s.scanned < to && calls < maxCalls && rpc.left > 6) {
          const from = s.scanned + 1;
          const end = Math.min(to, from + s.chunk - 1);
          calls++;
          let logs;
          try {
            logs = await rpc.call("eth_getLogs", [
              { address: c.miner, fromBlock: qty(from), toBlock: qty(end), topics: [[T_JOINED, T_DEPOSITED, T_WITHDRAWN]] },
            ]);
          } catch (e) {
            if (s.chunk > 500) {
              s.chunk = Math.max(500, Math.floor(s.chunk / 2)); // node limits the range: use smaller steps
              continue;
            }
            throw e;
          }
          for (const l of logs) applyLog(s.users, l);
          s.scanned = end;
        }
        if (s.scanned < to) st.actions.push(`正在读取历史记录（还差约 ${to - s.scanned} 个区块）`);
      } catch (e) {
        st.errors.push("读取用户记录失败：" + (e?.message || e));
      }
      const list = settleList(s);
      st.users = Object.keys(s.users).length;
      st.toSettle = list.length;
      const hours = c.settleHours ?? autoSettleHours(list.length);
      st.settleHours = hours;

      const due = now - (s.lastSettle || 0) >= hours * 3600 || (s.settleCursor || 0) > 0;
      if (due && list.length === 0) s.settleCursor = 0; // stay due: settle as soon as the first wallets appear
      else if (due && rpc.left >= 2) {
        const batch = Math.max(10, Math.round(c.batch * load));
        const maxTx = Math.max(1, Math.round(c.maxSettleTx * load));
        let i = s.settleCursor || 0;
        if (i >= list.length) i = 0;
        const txs = [];
        for (let j = i; j < list.length && txs.length < maxTx; j += batch) {
          const part = list.slice(j, j + batch);
          txs.push({ kind: "settle", to: c.miner, data: encodeSettleMany(part), count: part.length });
        }
        const sent = await sendTxs(txs);
        for (const t of sent) {
          i += t.count;
          st.actions.push(`结算推荐奖励 ${t.count} 个钱包：${t.hash}`);
        }
        if (i >= list.length) {
          s.settleCursor = 0;
          s.lastSettle = now;
          s.lastSettleTx = { hash: sent[sent.length - 1].hash, at: now, count: list.length };
        } else s.settleCursor = i;
      }
    }

    // balance history (one sample every 6 hours, 3 days kept) for the "lasts about N days" estimate
    const h = s.balHist || (s.balHist = []);
    if (!h.length || now - h[h.length - 1].t >= 6 * 3600) {
      h.push({ t: now, b: balance.toString() });
      if (h.length > 13) h.splice(0, h.length - 13);
    }
  } catch (e) {
    st.errors.push(e?.message || String(e));
  }

  if (!st.at) st.at = Math.floor(Date.now() / 1000);
  st.ok = st.errors.length === 0;
  if (st.ok) {
    s.okAt = st.at;
    s.load = Math.min(1, load + 0.02);
  }
  s.status = st;
  await save(null);
  console.log(`ok=${st.ok} running=${st.accruing} ${st.actions.join(" | ")} ${st.errors.join(" | ")}`);
  return s;
}

// ------------------------------------------------------------------ read-only status page (no secrets on it)

const esc = (x) => String(x).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const bj = (t) => (t ? new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " ") : "—");
const ago = (now, t) => {
  if (!t) return "";
  const m = Math.max(0, Math.round((now - t) / 60));
  return m < 60 ? `（${m} 分钟前）` : m < 2880 ? `（${Math.round(m / 60)} 小时前）` : `（${Math.round(m / 1440)} 天前）`;
};
const bnb = (wei) => {
  if (wei === null || wei === undefined) return "—";
  const v = Number(BigInt(wei) / 10n ** 12n) / 1e6;
  return v.toFixed(4) + " BNB";
};

function daysLeft(s) {
  const h = s.balHist || [];
  if (h.length < 2) return null;
  const a = h[0];
  const b = h[h.length - 1];
  const spent = BigInt(a.b) - BigInt(b.b);
  const dt = b.t - a.t;
  if (dt < 6 * 3600 || spent <= 0n) return null;
  const perDay = (Number(spent) / dt) * 86400;
  return Number(BigInt(b.b)) / perDay;
}

export function statusPage(s, env) {
  const c = config(env);
  const nowS = Math.floor(Date.now() / 1000);
  const st = s?.status;
  const rows = [];
  const row = (k, v) => rows.push(`<div class="row"><span>${esc(k)}</span><b>${v}</b></div>`);
  let pill = ["wait", "还没有运行过"];
  const hints = [];
  if (!env.KEEPER_KEY) hints.push("还没有设置密钥 KEEPER_KEY（设置 → 变量和机密 → 添加 → 类型选“密钥”）。");
  if (!env.STATE) hints.push("还没有绑定 KV 存储，变量名必须是 STATE（设置 → 绑定 → 添加 → KV 命名空间）。");
  if (st) {
    const fresh = nowS - st.at < 30 * 60;
    pill = st.ok && fresh ? ["ok", "正常运行"] : fresh ? ["warn", "有问题，见下方"] : ["warn", "超过 30 分钟没有运行"];
    row("最近一次运行（北京时间）", esc(bj(st.at)) + esc(ago(nowS, st.at)));
    if (st.accruing !== null) {
      const why = st.reasons === null ? ["原因下一次运行时显示"] : REASONS.filter(([b]) => st.reasons & b).map(([, t]) => t);
      row("合约状态", st.accruing ? '<i class="g">运行中，正常计息</i>' : `<i class="r">已暂停</i>${why.length ? "：" + esc(why.join("；")) : ""}`);
      row("合约上次更新价格", esc(bj(st.lastCheckpoint)) + esc(ago(nowS, st.lastCheckpoint)));
    }
    row(
      "推荐奖励上次结算",
      s.lastSettleTx?.at ? esc(bj(s.lastSettleTx.at)) + esc(ago(nowS, s.lastSettleTx.at)) + `，${s.lastSettleTx.count} 个钱包` : "还没有结算过",
    );
    row(
      "已发现的钱包",
      `${st.users} 个（其中 ${st.toSettle} 个有推荐人且有本金，需要定期结算）` +
        (st.settleHours ? `<br>推荐奖励约每 ${esc(Math.round(st.settleHours * 10) / 10)} 小时自动结算一次` : ""),
    );
    if (st.keeper) {
      row("检查钱包", `<a href="${esc(c.explorer)}/address/${esc(st.keeper)}" target="_blank">${esc(st.keeper.slice(0, 8) + "…" + st.keeper.slice(-6))}</a>`);
      const low = st.balance !== null && BigInt(st.balance) < 5n * 10n ** 15n;
      const d = daysLeft(s);
      row(
        "检查钱包余额",
        (low ? '<i class="r">' : "") +
          esc(bnb(st.balance)) +
          (low ? "（快用完了，请补充）</i>" : "") +
          (d !== null ? `，按最近消耗约还能用 ${esc(Math.floor(d))} 天` : "，运行半天后显示还能用几天"),
      );
    }
    const link = (t) => esc(t).replace(/0x[0-9a-fA-F]{64}/g, (h) => `<a href="${esc(c.explorer)}/tx/${h}" target="_blank">${h.slice(0, 10)}…</a>`);
    if (st.actions.length) row("这次做了什么", st.actions.map(link).join("<br>"));
    if (st.errors.length) row("问题", `<i class="r">${st.errors.map((a) => esc(a)).join("<br>")}</i>`);
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>喜羊羊矿场 · 自动检查服务</title><style>
body{margin:0;font:16px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f3f7f4;color:#17301f}
.w{max-width:560px;margin:0 auto;padding:20px 16px 40px}h1{font-size:21px;margin:4px 0 14px}
.pill{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:700;margin-bottom:14px}
.ok{background:#d9f5e1;color:#127a39}.warn{background:#fff0d6;color:#9a5b00}.wait{background:#e8ecef;color:#4b5a63}
.card{background:#fff;border-radius:14px;padding:6px 16px;box-shadow:0 1px 3px #0001}
.row{display:flex;flex-direction:column;padding:11px 0;border-bottom:1px solid #eef2ef}.row:last-child{border:0}
.row span{font-size:13px;color:#6b7c72}.row b{font-weight:600;word-break:break-all}
i{font-style:normal}.g{color:#127a39}.r{color:#c0392b}.hint{background:#fff7e6;border-radius:12px;padding:10px 14px;margin-bottom:12px}
a{color:#1769aa}.foot{font-size:13px;color:#6b7c72;margin-top:14px}</style></head><body><div class="w">
<h1>喜羊羊矿场 · 自动检查服务</h1><div class="pill ${pill[0]}">${pill[1]}</div>
${hints.map((h) => `<div class="hint">${esc(h)}</div>`).join("")}
<div class="card">${rows.join("") || '<div class="row"><b>设置好以后，最多等 10 分钟就会显示第一次运行结果。</b></div>'}</div>
<p class="foot">这个页面只显示状态，不能操作任何东西。每 10 分钟自动运行一次。</p></div></body></html>`;
}

// ------------------------------------------------------------------ start-up warm-up
// Workers Free allows 10 ms of CPU per run but up to 1 s for evaluating the global scope once per isolate.
// Do the expensive one-time work here: build the base-point table and let the JIT compile the hashing,
// signing and encoding code, so a run only executes already-optimised code (about 1-3 ms).
{
  const k = new Uint8Array(32);
  k[31] = 7;
  const me = addressOf(k);
  const list = Array.from({ length: 60 }, (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"));
  const data = encodeSettleMany(list);
  for (let i = 0; i < 40; i++) {
    signLegacyTx({ nonce: i, gasPrice: 50_000_000n, gasLimit: 3_000_000n + BigInt(i), to: me, data: i % 2 ? data : "0x" + SEL.checkpoint, chainId: 56 }, k);
  }
  const d = new Uint8Array(2048);
  for (let i = 0; i < 400; i++) keccak_256(d.subarray(0, 32 + (i % 16) * 128));
  const users = {};
  const log = { topics: [T_DEPOSITED, "0x" + word(1), "0x" + word(1)], data: "0x" + word(123) + word(0).repeat(6) };
  for (let i = 0; i < 300; i++) applyLog(users, { ...log, topics: [log.topics[0], "0x" + word(i + 1), log.topics[2]] });
  JSON.parse(JSON.stringify(users));
  settleList({ users });
}

let pageMemo = { t: 0, s: null };

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOnce(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/") return new Response("Not found", { status: 404 });
    let s = pageMemo.s;
    if (Date.now() - pageMemo.t > 20000) {
      try {
        s = env.STATE ? await env.STATE.get("state", "json") : null;
      } catch {
        s = null;
      }
      if (s) pageMemo = { t: Date.now(), s }; // remember only real data (setup in progress: always re-read)
    }
    return new Response(statusPage(s, env), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  },
};

export const __test = { SEL, T_JOINED, T_DEPOSITED, T_WITHDRAWN };
