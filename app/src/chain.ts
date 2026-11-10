// Real-chain backend (local Anvil / BSC fork / BSC mainnet). Reads via the configured RPC, writes via the
// injected wallet (EIP-1193). Never falls back to mock values: missing data is reported as unavailable.
// @ts-ignore vendored ESM build of ethers v6.13.4 (MIT)
import * as E from "./vendor/ethers.min.js";
import { MINER_ABI, OLD_MINER_ABI, LOCK_ABI, ERC20_ABI, POOL_ABI, PAIR_ABI } from "./abi";
import type { AppConfig } from "./config";
import type { AddQuote, AdminEvent, AdminUserRow, Downline, ExitQuote, LockCoin, LockItem, LockView, OldStatus, Pair2, OldUserView, Params, Rec, RecKind, Snapshot, Step, TeamStats } from "./types";
import { DEFAULT_PARAMS } from "./types";
import { amountsForLiquidity, liquidityForAmounts, pairedAmount } from "./v3math";
import { applySlippage, fmtUnits, meetsThreshold, short } from "./fmt";

const L_REF = 10n ** 27n;
const Q192 = 1n << 192n;
const ZERO = "0x0000000000000000000000000000000000000000";

export type OnSteps = (steps: Step[]) => void;
export type LockAdminAction = "pause" | "resume" | "approveXyy" | "approvePop";
export const LOCK_COIN_NAME = ["喜羊羊", "POP"] as const;
export type AdminAction = "pause" | "resume" | "checkpoint" | "approve" | "rewardParams" | "safetyParams" | "claimPause" | "claimResume" | "end" | "oldPause" | "oldEnd" | "oldRevoke";

declare global {
  interface Window {
    ethereum?: any;
  }
}

export class ChainBackend {
  cfg: AppConfig;
  read: any;
  miner: any;
  addr = { miner: "", pool: "", pop: "", usdt: "", reward: "", rewardPool: "", npm: "" };
  dec = { usdt: 18, pop: 18, reward: 18 };
  fee = 0;
  twapMinutes = 30;
  token0 = "";
  sqrtLo = 0n;
  sqrtHi = 0n;
  ready = false;
  problem = "";
  readVia: "wallet" | "rpc" = "rpc";

  rpc: any;
  minerRpc: any;
  // previous contract (users withdraw and claim there before adding again here); null = none configured
  old: any = null;
  oldRpc: any = null;
  oldSqrt: [bigint, bigint] = [0n, 0n];
  // 锁仓 contract (null = not configured)
  lock: any = null;
  lockRpc: any = null;
  lockPair: { pair: any; rewardIs0: boolean; viaPop: boolean } | null = null;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    const req = new E.FetchRequest(cfg.rpcUrl);
    req.timeout = 12000;
    this.rpc = new E.JsonRpcProvider(req, cfg.chainId, { staticNetwork: true });
    this.read = this.rpc;
  }

  async init(): Promise<void> {
    // Prefer the wallet's own node for reads (works inside mainland China wallet apps where public RPCs may be
    // blocked); fall back to the configured RPC when there is no wallet or it is on another chain.
    try {
      if (window.ethereum) {
        const cid = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
        if (cid === this.cfg.chainId) {
          this.read = new E.BrowserProvider(window.ethereum, this.cfg.chainId);
          this.readVia = "wallet";
        }
      }
    } catch {
      /* keep configured RPC */
    }
    if (!this.cfg.miner || !E.isAddress(this.cfg.miner)) {
      this.problem = "挖矿合约未配置（尚未部署或未填写地址），已禁止交易";
      return;
    }
    try {
      const code = await this.read.getCode(this.cfg.miner);
      if (code === "0x") {
        this.problem = "配置的挖矿合约地址上没有合约代码";
        return;
      }
      this.miner = new E.Contract(this.cfg.miner, MINER_ABI, this.read);
      this.minerRpc = this.read === this.rpc ? this.miner : new E.Contract(this.cfg.miner, MINER_ABI, this.rpc);
      const [pool, pop, usdt, reward, rewardPool, fee, token0, sqrtLo, sqrtHi] = await Promise.all([
        this.miner.POOL(),
        this.miner.POP(),
        this.miner.USDT(),
        this.miner.REWARD(),
        this.miner.REWARD_POOL(),
        this.miner.FEE(),
        this.miner.TOKEN0(),
        this.miner.SQRT_LOWER(),
        this.miner.SQRT_UPPER(),
      ]);
      this.sqrtLo = sqrtLo;
      this.sqrtHi = sqrtHi;
      // cross-check contract immutables against the configured addresses
      const same = (a: string, b: string) => !b || a.toLowerCase() === b.toLowerCase();
      if (!same(pool, this.cfg.pool) || !same(pop, this.cfg.pop) || !same(reward, this.cfg.reward) || !same(usdt, this.cfg.usdt)) {
        this.problem = "合约内的池子/代币地址与配置不一致，已禁止交易";
        return;
      }
      const npm = String(await this.miner.NPM().catch(() => ""));
      this.addr = { miner: this.cfg.miner, pool, pop, usdt, reward, rewardPool, npm };
      const t = (a: string) => new E.Contract(a, ERC20_ABI, this.read);
      const [du, dp, dr] = await Promise.all([t(usdt).decimals(), t(pop).decimals(), t(reward).decimals()]);
      this.dec = { usdt: Number(du), pop: Number(dp), reward: Number(dr) };
      this.fee = Number(fee);
      this.twapMinutes = Math.round(Number(await this.miner.TWAP_WINDOW().catch(() => 1800)) / 60);
      this.token0 = token0;
      this.ready = true;
    } catch (e: any) {
      this.problem = "读取链上数据失败：" + (e?.shortMessage || e?.message || "未知错误");
      return;
    }
    await this.initOld();
    await this.initLock();
  }

  /** 锁仓 contract: only used if it belongs to this mining contract */
  private async initLock(): Promise<void> {
    const a = this.cfg.lock;
    if (!a || !E.isAddress(a)) return;
    try {
      if ((await this.read.getCode(a)) === "0x") return;
      const l = new E.Contract(a, LOCK_ABI, this.read);
      const [miner, pair, viaPop] = await Promise.all([l.MINER(), l.PAIR(), l.PAIR_VIA_POP()]);
      if (String(miner).toLowerCase() !== this.addr.miner.toLowerCase()) return;
      const p = new E.Contract(pair, PAIR_ABI, this.read);
      const t0 = String(await p.token0());
      this.lock = l;
      this.lockRpc = this.read === this.rpc ? l : new E.Contract(a, LOCK_ABI, this.rpc);
      this.lockPair = { pair: p, rewardIs0: t0.toLowerCase() === this.addr.reward.toLowerCase(), viaPop: Boolean(viaPop) };
    } catch {
      /* 锁仓 not available: the page says so */
    }
  }

  // ------------------------------------------------------------------ 锁仓 (喜羊羊 + POP)
  private lockToken(coin: LockCoin): string {
    return coin === 1 ? this.addr.pop : this.addr.reward;
  }

  private lockDec(coin: LockCoin): number {
    return coin === 1 ? this.dec.pop : this.dec.reward;
  }

  /** still-locked totals (everyone / this wallet's team) from the automatic check service; null when unavailable */
  private async lockTeam(account: string): Promise<{ network: Pair2; team: Pair2 | null } | null> {
    try {
      const u = account || ZERO;
      const r = await fetch(`./keeper/team.json?u=${u}`, { cache: "no-store" });
      if (!r.ok) return null;
      const j = await r.json();
      // only numbers of this very lock contract
      if (!j || !j.ok || !j.lock || String(j.lock.addr || "").toLowerCase() !== String(this.lock?.target || "").toLowerCase()) return null;
      const p2 = (x: any): Pair2 => [BigInt(x?.[0] || "0"), BigInt(x?.[1] || "0")];
      return { network: p2(j.lock.network), team: account ? p2(j.lock.team) : null };
    } catch {
      return null;
    }
  }

  async lockView(account: string): Promise<LockView | null> {
    const l = this.lock;
    if (!l) return null;
    const t = (a: string) => new E.Contract(a, ERC20_ABI, this.read);
    const two = async (f: (i: number) => Promise<bigint>): Promise<Pair2> => (await Promise.all([f(0), f(1)])) as Pair2;
    const [paused, owner, op, tl, tc, to, tr, tu, kt] = await Promise.all([
      l.paused(), l.owner(), l.OPERATOR(),
      two((i) => l.totalLocked(i)), two((i) => l.totalClaimed(i)), two((i) => l.totalOwnReward(i)), two((i) => l.totalRefReward(i)), two((i) => l.totalRefUnpaid(i)),
      this.lockTeam(account),
    ]);
    const [ax, ap, bx, bp] = await Promise.all([
      t(this.addr.reward).allowance(op, l.target), t(this.addr.pop).allowance(op, l.target), t(this.addr.reward).balanceOf(op), t(this.addr.pop).balanceOf(op),
    ]);
    const v: LockView = {
      address: String(l.target),
      paused, owner: String(owner),
      totals: { locked: tl, claimed: tc, ownReward: to, refReward: tr, refUnpaid: tu },
      operator: { allowance: [ax, ap], balance: [bx, bp] },
      network: kt ? kt.network : null,
      me: null,
    };
    if (account) {
      const [cr, bal, rw, n, bu, br, bpop] = await Promise.all([
        l.canRefer(account), l.balances(account), l.rewardsOf(account), l.lockCount(account),
        t(this.addr.usdt).balanceOf(account), t(this.addr.reward).balanceOf(account), t(this.addr.pop).balanceOf(account),
      ]);
      const count = Number(n);
      const from = Math.max(0, count - 100);
      const raw: any[] = count > 0 ? await l.locksOf(account, from, 100) : [];
      const locks: LockItem[] = raw
        .map((x: any, i: number) => ({ id: from + i, coin: (Number(x.coin) === 1 ? 1 : 0) as LockCoin, amount: x.amount, claimed: x.claimed, start: Number(x.start), days: Number(x.days_) }))
        .reverse();
      const p2 = (x: any): Pair2 => [BigInt(x[0]), BigInt(x[1])];
      v.me = {
        canRefer: cr, stillLocked: p2(bal[0]), claimable: p2(bal[1]), ownReward: p2(rw[0]), refReward: p2(rw[1]),
        team: kt ? kt.team : null, locks, usdt: bu, reward: br, pop: bpop,
      };
    }
    return v;
  }

  /** 喜羊羊 that `usdtIn` buys now (spot price, pool fees; the V3 leg's price impact is left to the slippage margin) */
  async lockQuote(usdtIn: bigint): Promise<bigint> {
    const lp = this.lockPair;
    if (!lp || usdtIn <= 0n) return 0n;
    const [r0, r1] = await lp.pair.getReserves();
    const [rR, rC]: [bigint, bigint] = lp.rewardIs0 ? [r0, r1] : [r1, r0];
    let inC = usdtIn;
    if (lp.viaPop) {
      const sp = await this.spotSqrt();
      const net = (usdtIn * BigInt(1_000_000 - this.fee)) / 1_000_000n;
      const usdtIs0 = this.token0.toLowerCase() === this.addr.usdt.toLowerCase();
      // pool price = token1 per token0 = sp^2 / 2^192
      inC = usdtIs0 ? (net * sp * sp) >> 192n : (net << 192n) / (sp * sp);
    }
    const withFee = inC * 9975n;
    return (withFee * rR) / (rC * 10_000n + withFee);
  }

  private async lockOperatorCanPay(coin: LockCoin, reward: bigint): Promise<void> {
    const v = await this.lockView("");
    // own reward + (possibly) the referral reward, in the locked coin
    if (!v || v.operator.allowance[coin] < reward * 2n || v.operator.balance[coin] < reward * 2n) throw new Error("OperatorShort");
  }

  private async approveTo(signer: any, token: string, spender: string, amount: bigint): Promise<any | null> {
    const owner = await signer.getAddress();
    const c = new E.Contract(token, ERC20_ABI, signer);
    const cur: bigint = await c.allowance(owner, spender);
    if (cur >= amount) return null;
    return c.approve(spender, amount); // exact amount, not unlimited
  }

  async lockBuy(usdtIn: bigint, lockBps: number, days: number, slipBps: number, steps: Step[], on: OnSteps): Promise<boolean> {
    if (!this.lock) throw new Error("锁仓暂未开放");
    const s = await this.signer();
    const from = await s.getAddress();
    const l = new E.Contract(this.lock.target, LOCK_ABI, s);
    const rewardOf = (out: bigint) => (((out * BigInt(lockBps)) / 10_000n) * BigInt(days === 200 ? 1000 : 500)) / 10_000n;
    // before asking for any signature: can the operator wallet pay the rewards right now?
    await this.lockOperatorCanPay(0, rewardOf(await this.lockQuote(usdtIn)));
    return this.runSteps(
      steps,
      [
        () => this.approveTo(s, this.addr.usdt, String(this.lock.target), usdtIn),
        async () => {
          const exp = await this.lockQuote(usdtIn);
          await this.lockOperatorCanPay(0, rewardOf(exp));
          const minOut = applySlippage(exp, slipBps);
          const dl = await this.deadline();
          await this.precheck(() => this.lockRpc.buyAndLock.staticCall(usdtIn, lockBps, days, minOut, dl, { from }));
          return l.buyAndLock(usdtIn, lockBps, days, minOut, dl);
        },
      ],
      on,
    );
  }

  /** lock `amount` of 喜羊羊 (coin 0) or POP (coin 1) from the wallet */
  async lockWallet(coin: LockCoin, amount: bigint, days: number, steps: Step[], on: OnSteps): Promise<boolean> {
    if (!this.lock) throw new Error("锁仓暂未开放");
    const s = await this.signer();
    const from = await s.getAddress();
    const l = new E.Contract(this.lock.target, LOCK_ABI, s);
    const reward = (amount * BigInt(days === 200 ? 1000 : 500)) / 10_000n;
    await this.lockOperatorCanPay(coin, reward); // before any signature
    return this.runSteps(
      steps,
      [
        () => this.approveTo(s, this.lockToken(coin), String(this.lock.target), amount),
        async () => {
          await this.lockOperatorCanPay(coin, reward);
          await this.precheck(() => this.lockRpc.lock.staticCall(coin, amount, days, { from }));
          return l.lock(coin, amount, days);
        },
      ],
      on,
    );
  }

  async lockClaim(steps: Step[], on: OnSteps): Promise<boolean> {
    if (!this.lock) throw new Error("锁仓暂未开放");
    const s = await this.signer();
    const from = await s.getAddress();
    const l = new E.Contract(this.lock.target, LOCK_ABI, s);
    return this.runSteps(
      steps,
      [
        async () => {
          await this.precheck(() => this.lockRpc.claim.staticCall({ from }));
          return l.claim();
        },
      ],
      on,
    );
  }

  async lockAdmin(action: LockAdminAction, arg: bigint, steps: Step[], on: OnSteps): Promise<boolean> {
    if (!this.lock) throw new Error("锁仓暂未开放");
    const s = await this.signer();
    const l = new E.Contract(this.lock.target, LOCK_ABI, s);
    const fn = {
      pause: () => l.setPaused(true),
      resume: () => l.setPaused(false),
      approveXyy: () => new E.Contract(this.addr.reward, ERC20_ABI, s).approve(this.lock.target, arg),
      approvePop: () => new E.Contract(this.addr.pop, ERC20_ABI, s).approve(this.lock.target, arg),
    }[action];
    return this.runSteps(steps, [fn], on);
  }

  private async lockQueryLogs(filter: any, start: number, end: number): Promise<any[]> {
    try {
      return await this.lock.queryFilter(filter, start, end);
    } catch (e) {
      if (this.lockRpc === this.lock) throw e;
      return await this.lockRpc.queryFilter(filter, start, end);
    }
  }

  private async lockRecords(account: string, toBlock: number, span: number): Promise<{ items: Rec[]; nextTo: number | null }> {
    const base = this.cfg.lockDeployBlock || 0;
    if (!this.lock) return { items: [], nextTo: null };
    const from = Math.max(base, toBlock - span + 1);
    const f = this.lock.filters;
    const scan = async (flt: any) => {
      const out: any[] = [];
      for (let end = toBlock; end >= from; end -= this.cfg.logChunk) out.push(...(await this.lockQueryLogs(flt, Math.max(from, end - this.cfg.logChunk + 1), end)));
      return out;
    };
    const [locked, claimed, ref, bought] = await Promise.all([scan(f.Locked(account)), scan(f.Claimed(account)), scan(f.RefRewardPaid(null, account)), scan(f.Bought(account))]);
    const buys = new Map<string, any>(bought.map((b: any) => [b.transactionHash, b.args]));
    const logs = [...locked, ...claimed, ...ref].sort((x, y) => y.blockNumber - x.blockNumber || y.index - x.index);
    const times = new Map<number, number>();
    await Promise.all([...new Set(logs.map((l) => l.blockNumber))].map(async (n) => times.set(n, (await this.read.getBlock(n))?.timestamp ?? 0)));
    const d = this.dec;
    const coinOf = (x: any): LockCoin => (Number(x) === 1 ? 1 : 0);
    const amt = (c: LockCoin, v: bigint) => `${fmtUnits(v, this.lockDec(c))} ${LOCK_COIN_NAME[c]}`;
    const items: Rec[] = logs.map((l) => {
      const a = l.args;
      const time = times.get(l.blockNumber) || 0;
      const base = { kind: "lock" as RecKind, time, tx: l.transactionHash, status: "已完成" as const };
      const c = coinOf(a.coin);
      if (l.fragment.name === "Locked") {
        const b = buys.get(l.transactionHash);
        const lines = [{ label: "锁仓", value: amt(c, a.amount) }];
        if (b) lines.push({ label: "用 USDT 买入", value: `${fmtUnits(b.usdtIn, d.usdt)} USDT${b.toWallet > 0n ? `，${fmtUnits(b.toWallet, d.reward)} 喜羊羊到钱包` : ""}` });
        lines.push({ label: "立即到账奖励", value: amt(c, a.reward) });
        return { ...base, title: `锁仓 ${LOCK_COIN_NAME[c]} · ${Number(a.days_)} 天`, sign: "-", lines } as Rec;
      }
      if (l.fragment.name === "Claimed") return { ...base, title: `领取锁仓释放 · ${LOCK_COIN_NAME[c]}`, sign: "+", lines: [{ label: "到账", value: amt(c, a.amount) }] } as Rec;
      const g = Number(a.generation);
      return {
        ...base,
        title: `锁仓推荐奖励 · ${g === 1 ? "直推" : g === 2 ? "间推（顺延）" : "第 3 代（顺延）"}`,
        sign: "+",
        lines: [
          { label: "到账", value: amt(c, a.amount) },
          { label: "来源", value: short(a.from) },
        ],
      } as Rec;
    });
    return { items, nextTo: from > base ? from - 1 : null };
  }

  /** previous contract: only used if it sits on the same pool, position manager and reward token */
  private async initOld(): Promise<void> {
    const a = this.cfg.oldMiner;
    if (!a || !E.isAddress(a) || a.toLowerCase() === this.cfg.miner.toLowerCase()) return;
    try {
      if ((await this.read.getCode(a)) === "0x") return;
      const o = new E.Contract(a, OLD_MINER_ABI, this.read);
      const [pool, npm, reward, lo, hi] = await Promise.all([o.POOL(), o.NPM(), o.REWARD(), o.SQRT_LOWER(), o.SQRT_UPPER()]);
      const same = (x: string, y: string) => String(x).toLowerCase() === String(y).toLowerCase();
      if (!same(pool, this.addr.pool) || !same(npm, this.addr.npm) || !same(reward, this.addr.reward)) return;
      this.old = o;
      this.oldRpc = this.read === this.rpc ? o : new E.Contract(a, OLD_MINER_ABI, this.rpc);
      this.oldSqrt = [lo, hi];
    } catch {
      /* previous contract unreadable: the page simply shows no migration hint */
    }
  }

  private emptySnap(problem: string): Snapshot {
    return {
      params: { ...DEFAULT_PARAMS },
      configured: false,
      problem,
      running: false,
      reasons: 0,
      adminPaused: false,
      lastCheckpoint: 0,
      rewardPrice: null,
      twapMinutes: this.twapMinutes,
      rewardDecimals: 18,
      usdtDecimals: 18,
      popDecimals: 18,
      tvlUsd: null,
      totalPrincipalUsd: null,
      participants: 0,
      totalPaidReward: 0n,
      owner: "",
      operator: "",
      runwayDays: 0,
      reserve: null,
      user: null,
      old: null,
      oldStatus: null,
      balances: null,
      addresses: { ...this.addr, pool: this.addr.pool || this.cfg.pool, pop: this.addr.pop || this.cfg.pop, reward: this.addr.reward || this.cfg.reward },
      fetchedAt: Date.now(),
    };
  }

  async snapshot(account?: string): Promise<Snapshot> {
    if (!this.ready) return this.emptySnap(this.problem || "未就绪");
    const m = this.miner;
    const params = await this.params();
    const [accruing, reasons, adminPaused, lastCp, vpr, totalLiq, participants, paidReward, owner, operator, runway, rp, reserve, totalPr] =
      await Promise.all([
        m.accruing(),
        m.pauseReasons(),
        m.adminPaused(),
        m.lastCheckpointTime(),
        m.valuePerRef(),
        m.totalLiquidity(),
        m.participants(),
        m.totalPaidReward(),
        m.owner(),
        m.OPERATOR(),
        m.runwayDays(),
        m.rewardPriceView(),
        m.reserveView(),
        m.totalPrincipal(),
      ]);
    const snap: Snapshot = {
      ...this.emptySnap(""),
      params,
      configured: true,
      problem: undefined,
      running: accruing,
      reasons: Number(reasons),
      adminPaused,
      lastCheckpoint: Number(lastCp),
      rewardPrice: rp[0] ? rp[1] : await this.marketRewardPrice().catch(() => null),
      rewardPriceEstimated: !rp[0],
      rewardDecimals: this.dec.reward,
      usdtDecimals: this.dec.usdt,
      popDecimals: this.dec.pop,
      tvlUsd: vpr > 0n ? (totalLiq * vpr) / L_REF : null,
      totalPrincipalUsd: totalPr,
      participants: Number(participants),
      totalPaidReward: paidReward,
      owner,
      operator,
      runwayDays: Number(runway),
      reserve: { balance: reserve[0], allowance: reserve[1], usable: reserve[2], liabilityUsd: reserve[3] },
    };
    if (account) {
      const t = (a: string) => new E.Contract(a, ERC20_ABI, this.read);
      const [u, pend, val, elig, bu, bp, br] = await Promise.all([
        m.getUser(account),
        m.pendingUsd(account),
        m.valueUsd(account),
        m.isEligible(account),
        t(this.addr.usdt).balanceOf(account),
        t(this.addr.pop).balanceOf(account),
        t(this.addr.reward).balanceOf(account),
      ]);
      const [amounts, old] = await Promise.all([
        u.liquidity > 0n ? this.positionAmounts(u.liquidity) : Promise.resolve([0n, 0n] as [bigint, bigint]),
        this.oldUser(account, u).catch(() => null),
      ]);
      snap.user = {
        liquidity: u.liquidity,
        valueUsd: val,
        popAmt: amounts[0],
        usdtAmt: amounts[1],
        personalUsd: pend[0],
        dynamicUsd: pend[1],
        claimedPersonal: u.claimedPersonalReward,
        claimedDynamic: u.claimedDynamicReward,
        referrer: u.referrer === ZERO ? "" : u.referrer,
        joined: u.joined,
        eligible: elig,
        principalUsd: BigInt(u.principalUsd),
        direct: Number(u.directCount),
        indirect: Number(u.indirectCount),
        firstDepositAt: Number(u.firstDepositAt),
        tokenId: BigInt(u.tokenId),
      };
      snap.balances = { usdt: bu, pop: bp, reward: br };
      snap.old = old;
    }
    return snap;
  }

  /** this wallet in the previous contract; the old referrer is checked against the new contract only while this
   * wallet still has to bind here */
  private async oldUser(account: string, now: any): Promise<OldUserView | null> {
    const o = this.old;
    if (!o) return null;
    const [u, pend, val] = await Promise.all([o.getUser(account), o.pendingUsd(account), o.valueUsd(account)]);
    const referrer = u.referrer === ZERO ? "" : String(u.referrer);
    const needBind = !!referrer && now.referrer === ZERO && !now.joined;
    const refJoined = needBind ? Boolean((await this.miner.getUser(referrer)).joined) : null;
    return { liquidity: u.liquidity, valueUsd: val, personalUsd: pend[0], dynamicUsd: pend[1], referrer, joined: u.joined, refJoined };
  }

  /** previous contract state for the admin page */
  async oldStatus(): Promise<OldStatus | null> {
    const o = this.old;
    if (!o) return null;
    const [adminPaused, ended, accruing, claimPaused, totalLiq, vpr, participants, reserve, rp] = await Promise.all([
      o.adminPaused(), o.ended(), o.accruing(), o.claimPaused(), o.totalLiquidity(), o.valuePerRef(), o.participants(), o.reserveView(), o.rewardPriceView(),
    ]);
    return {
      address: String(o.target),
      adminPaused, ended, accruing, claimPaused,
      totalLiquidity: totalLiq,
      tvlUsd: vpr > 0n ? (totalLiq * vpr) / L_REF : null,
      participants: Number(participants),
      reserve: { balance: reserve[0], allowance: reserve[1], usable: reserve[2], liabilityUsd: reserve[3] },
      rewardPrice: rp[0] ? rp[1] : null,
    };
  }

  async params(): Promise<Params> {
    const m = this.miner;
    const [rate, pb, t1, t2, thr, dev, mpl, mrl, cp, ended] = await Promise.all([
      m.dailyRateBps(), m.personalBps(), m.tier1Bps(), m.tier2Bps(), m.dynamicThresholdUsd(), m.maxTickDeviation(),
      m.minPoolLiquidity(), m.minRewardPoolLiquidity(), m.claimPaused(), m.ended(),
    ]);
    return {
      rateBps: Number(rate), personalBps: Number(pb), tier1Bps: Number(t1), tier2Bps: Number(t2), thresholdUsd: thr,
      maxTickDeviation: Number(dev), minPoolLiquidity: mpl, minRewardPoolLiquidity: mrl, claimPaused: cp, ended,
    };
  }

  private async spotSqrt(): Promise<bigint> {
    const pool = new E.Contract(this.addr.pool, POOL_ABI, this.read);
    return (await pool.slot0())[0];
  }

  /** current (POP, USDT) amounts of `liquidity` in the fixed full-range position (excl. fees) */
  async positionAmounts(liquidity: bigint): Promise<[bigint, bigint]> {
    const [a0, a1] = amountsForLiquidity(await this.spotSqrt(), this.sqrtLo, this.sqrtHi, liquidity);
    return this.token0.toLowerCase() === this.addr.pop.toLowerCase() ? [a0, a1] : [a1, a0];
  }

  /** how much of the other token pairs with `amount` of USDT (from="usdt") or POP (from="pop") at the spot price */
  async pairAmount(from: "usdt" | "pop", amount: bigint): Promise<bigint> {
    const popIs0 = this.token0.toLowerCase() === this.addr.pop.toLowerCase();
    const knownIs0 = (from === "pop") === popIs0;
    return pairedAmount(await this.spotSqrt(), this.sqrtLo, this.sqrtHi, amount, knownIs0);
  }

  /** spot preview of adding POP + USDT (no swap): amounts actually used */
  async previewAdd(popAmt: bigint, usdtAmt: bigint): Promise<[bigint, bigint]> {
    const popIs0 = this.token0.toLowerCase() === this.addr.pop.toLowerCase();
    const sp = await this.spotSqrt();
    const [d0, d1] = popIs0 ? [popAmt, usdtAmt] : [usdtAmt, popAmt];
    const l = liquidityForAmounts(sp, this.sqrtLo, this.sqrtHi, d0, d1);
    const [a0, a1] = amountsForLiquidity(sp, this.sqrtLo, this.sqrtHi, l);
    return popIs0 ? [a0, a1] : [a1, a0];
  }

  /** Display-only estimate of the reward token's USD price from the pools' current prices, used while the
   * contract's own average price is briefly unavailable. Claims always settle at the contract's price. */
  async marketRewardPrice(): Promise<bigint | null> {
    const m = this.miner;
    const [isV2, viaPop] = await Promise.all([m.REWARD_V2(), m.REWARD_VIA_POP()]);
    const unit = 10n ** BigInt(this.dec.reward);
    let counterRaw: bigint; // counter-token raw amount for one whole reward token
    if (isV2) {
      const pair = new E.Contract(this.addr.rewardPool, PAIR_ABI, this.read);
      const [res, t0] = await Promise.all([pair.getReserves(), pair.token0()]);
      const rewardIs0 = String(t0).toLowerCase() === this.addr.reward.toLowerCase();
      const [rr, rc] = rewardIs0 ? [BigInt(res[0]), BigInt(res[1])] : [BigInt(res[1]), BigInt(res[0])];
      if (rr === 0n) return null;
      counterRaw = (unit * rc) / rr;
    } else {
      const pool = new E.Contract(this.addr.rewardPool, POOL_ABI, this.read);
      const [s0, t0] = await Promise.all([pool.slot0(), pool.token0()]);
      const r = BigInt(s0[0]) * BigInt(s0[0]); // token1 per token0 * 2^192
      const rewardIs0 = String(t0).toLowerCase() === this.addr.reward.toLowerCase();
      counterRaw = rewardIs0 ? (unit * r) / Q192 : (unit * Q192) / r;
    }
    let usdtRaw = counterRaw;
    if (viaPop) {
      const px = await this.spotPopPerUsdt(); // POP raw per USDT raw = num / den
      usdtRaw = (counterRaw * px.den) / px.num;
    }
    const v = usdtRaw * 10n ** BigInt(18 - this.dec.usdt);
    return v > 0n ? v : null;
  }

  // ------------------------------------------------------------------ quotes

  private async spotPopPerUsdt(): Promise<{ num: bigint; den: bigint }> {
    const pool = new E.Contract(this.addr.pool, POOL_ABI, this.read);
    const s0 = await pool.slot0();
    const sq: bigint = s0[0];
    const r = sq * sq; // token1/token0 * 2^192
    // POP per USDT (raw units)
    return this.token0.toLowerCase() === this.addr.usdt.toLowerCase() ? { num: r, den: Q192 } : { num: Q192, den: r };
  }

  async quoteAdd(mode: "usdt" | "both", usdtAmount: bigint, popAmount: bigint, slipBps: number, valuePerUsdt?: bigint): Promise<AddQuote> {
    let swapUsdt = 0n;
    let expectedPop = 0n;
    let popAvail = popAmount;
    let usdtAvail = usdtAmount;
    if (mode === "usdt") {
      // full range needs ~50/50 value at the post-swap price: swap u/(2 - fee)
      const fee = BigInt(this.fee); // in 1e-6
      swapUsdt = (usdtAmount * 1_000_000n) / (2_000_000n - fee);
      const px = await this.spotPopPerUsdt();
      expectedPop = (swapUsdt * (1_000_000n - fee) * px.num) / (1_000_000n * px.den);
      popAvail = expectedPop;
      usdtAvail = usdtAmount - swapUsdt;
    }
    const [popUsed, usdtUsed] = await this.previewAdd(popAvail, usdtAvail);
    const ext = mode === "usdt" ? slipBps * 2 : slipBps; // zap: swap impact shifts the ratio
    const usdtScale = 10n ** BigInt(18 - this.dec.usdt);
    void valuePerUsdt;
    return {
      mode,
      usdtAmount,
      popAmount,
      swapUsdt,
      expectedPopFromSwap: expectedPop,
      minPopFromSwap: applySlippage(expectedPop, slipBps),
      popUsed,
      usdtUsed,
      minPopUsed: applySlippage(popUsed, ext),
      minUsdtUsed: applySlippage(usdtUsed, ext),
      popRefund: popAvail - popUsed,
      usdtRefund: usdtAvail - usdtUsed,
      estValueUsd: usdtUsed * usdtScale * 2n, // full range: POP side ≈ USDT side in value
      createdAt: Date.now(),
    };
  }

  async quoteExit(account: string, pctBps: number, slipBps: number, userLiq: bigint, valueUsd: bigint, principalUsd: bigint, thresholdUsd: bigint): Promise<ExitQuote> {
    const liq = pctBps >= 10000 ? userLiq : (userLiq * BigInt(pctBps)) / 10000n;
    const [pop, usdt] = liq > 0n ? await this.positionAmounts(liq) : [0n, 0n];
    const remainingValueUsd = userLiq > 0n ? (valueUsd * (userLiq - liq)) / userLiq : 0n;
    const remainingPrincipal = userLiq > 0n && liq < userLiq ? principalUsd - (principalUsd * liq) / userLiq : 0n;
    void account;
    return {
      liquidity: liq,
      pop,
      usdt,
      minPop: applySlippage(pop, slipBps),
      minUsdt: applySlippage(usdt, slipBps),
      remainingValueUsd,
      eligibleAfter: meetsThreshold(remainingPrincipal, thresholdUsd),
      createdAt: Date.now(),
    };
  }

  // ------------------------------------------------------------------ wallet / tx

  async signer(): Promise<any> {
    if (!window.ethereum) throw new Error("未检测到钱包，请在钱包 App 内置浏览器中打开");
    const bp = new E.BrowserProvider(window.ethereum);
    const net = await bp.getNetwork();
    if (Number(net.chainId) !== this.cfg.chainId) throw new Error("钱包网络不正确，请切换到 " + this.cfg.chainName);
    return bp.getSigner();
  }

  private async runSteps(steps: Step[], fns: (() => Promise<any | null>)[], on: OnSteps): Promise<boolean> {
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].status === "done" || steps[i].status === "skipped") continue;
      steps[i] = { ...steps[i], status: "wallet", error: undefined };
      on([...steps]);
      try {
        const tx = await fns[i]();
        if (tx === null) {
          steps[i] = { ...steps[i], status: "skipped" };
        } else {
          steps[i] = { ...steps[i], status: "pending", hash: tx.hash };
          on([...steps]);
          const rc = await tx.wait();
          if (!rc || rc.status !== 1) throw new Error("交易失败");
          steps[i] = { ...steps[i], status: "done" };
        }
        on([...steps]);
      } catch (e: any) {
        steps[i] = { ...steps[i], status: "error", error: humanError(e) };
        on([...steps]);
        return false;
      }
    }
    return true;
  }

  /** deadline = latest block time + 10 min (chain clock, not the phone's clock) */
  async deadline(): Promise<bigint> {
    const b = await this.read.getBlock("latest");
    const t = Math.max(Number(b?.timestamp ?? 0), Math.floor(Date.now() / 1000));
    return BigInt(t + 600);
  }

  async approveIfNeeded(signer: any, token: string, amount: bigint): Promise<any | null> {
    const owner = await signer.getAddress();
    const c = new E.Contract(token, ERC20_ABI, signer);
    const cur: bigint = await c.allowance(owner, this.addr.miner);
    if (cur >= amount) return null;
    return c.approve(this.addr.miner, amount); // exact amount, not unlimited
  }

  async deposit(q: AddQuote, referrer: string, steps: Step[], on: OnSteps): Promise<boolean> {
    const s = await this.signer();
    const from = await s.getAddress();
    const fns: (() => Promise<any | null>)[] = [() => this.approveIfNeeded(s, this.addr.usdt, q.usdtAmount)];
    if (q.popAmount > 0n) fns.push(() => this.approveIfNeeded(s, this.addr.pop, q.popAmount));
    fns.push(async () => {
      const p = {
        usdtAmount: q.usdtAmount,
        popAmount: q.popAmount,
        swapUsdtAmount: q.swapUsdt,
        minPopFromSwap: q.minPopFromSwap,
        minUsdtUsed: q.minUsdtUsed,
        minPopUsed: q.minPopUsed,
        referrer: referrer || ZERO,
        deadline: await this.deadline(),
      };
      await this.precheck(() => this.minerRpc.deposit.staticCall(p, { from }));
      return new E.Contract(this.addr.miner, MINER_ABI, s).deposit(p);
    });
    return this.runSteps(steps, fns, on);
  }

  /** bind a referrer before the first deposit (one wallet confirmation, can never be changed) */
  async bind(referrer: string, steps: Step[], on: OnSteps): Promise<boolean> {
    const s = await this.signer();
    return this.runSteps(
      steps,
      [
        async () => {
          const from = await s.getAddress();
          await this.precheck(() => this.minerRpc.bind.staticCall(referrer, { from }));
          return new E.Contract(this.addr.miner, MINER_ABI, s).bind(referrer);
        },
      ],
      on,
    );
  }

  async withdraw(q: ExitQuote, steps: Step[], on: OnSteps): Promise<boolean> {
    const s = await this.signer();
    return this.runSteps(
      steps,
      [
        async () => {
          const from = await s.getAddress();
          const dl = await this.deadline();
          await this.precheck(() => this.minerRpc.withdraw.staticCall(q.liquidity, q.minPop, q.minUsdt, dl, { from }));
          return new E.Contract(this.addr.miner, MINER_ABI, s).withdraw(q.liquidity, q.minPop, q.minUsdt, dl);
        },
      ],
      on,
    );
  }

  async claim(minOut: bigint, steps: Step[], on: OnSteps): Promise<boolean> {
    const s = await this.signer();
    return this.runSteps(
      steps,
      [
        async () => {
          const from = await s.getAddress();
          await this.precheck(() => this.minerRpc.claim.staticCall(minOut, { from }));
          return new E.Contract(this.addr.miner, MINER_ABI, s).claim(minOut);
        },
      ],
      on,
    );
  }

  /** (POP, USDT) that `liquidity` of the previous contract's position is worth at the current price (excl. fees) */
  async oldAmounts(liquidity: bigint): Promise<[bigint, bigint]> {
    const [a0, a1] = amountsForLiquidity(await this.spotSqrt(), this.oldSqrt[0], this.oldSqrt[1], liquidity);
    return this.token0.toLowerCase() === this.addr.pop.toLowerCase() ? [a0, a1] : [a1, a0];
  }

  /** previous contract (ended): take all liquidity out. Needs no approval; rewards there are not claimed. */
  async withdrawOld(slipBps: number, steps: Step[], on: OnSteps): Promise<boolean> {
    if (!this.old) throw new Error("没有旧矿池");
    const s = await this.signer();
    const from = await s.getAddress();
    const o = new E.Contract(this.old.target, OLD_MINER_ABI, s);
    return this.runSteps(
      steps,
      [
        async () => {
          const u = await this.old.getUser(from);
          const liq: bigint = u.liquidity;
          if (liq === 0n) return null;
          const [pop, usdt] = await this.oldAmounts(liq);
          const dl = await this.deadline();
          const [mp, mu] = [applySlippage(pop, slipBps), applySlippage(usdt, slipBps)];
          await this.precheck(() => this.oldRpc.withdraw.staticCall(liq, mp, mu, dl, { from }));
          return o.withdraw(liq, mp, mu, dl);
        },
      ],
      on,
    );
  }

  /** admin: every wallet of the previous contract and what it still has there (scans its Joined records) */
  async oldLeftovers(onProgress: (done: number, total: number) => void): Promise<{ wallets: number; withLiquidity: number; unclaimed: number; unclaimedUsd: bigint }> {
    const o = this.old;
    if (!o) throw new Error("没有旧矿池");
    const head = await this.latestBlock();
    const from = this.cfg.oldDeployBlock || 0;
    const total = Math.max(1, head - from + 1);
    const users = new Set<string>();
    for (let start = from; start <= head; start += this.cfg.logChunk) {
      const end = Math.min(head, start + this.cfg.logChunk - 1);
      let logs: any[];
      try {
        logs = await o.queryFilter(o.filters.Joined(), start, end);
      } catch (e) {
        if (this.oldRpc === o) throw e;
        logs = await this.oldRpc.queryFilter(this.oldRpc.filters.Joined(), start, end);
      }
      for (const l of logs) users.add(String(l.args.user));
      onProgress(end - from + 1, total);
    }
    const list = [...users];
    let withLiquidity = 0, unclaimed = 0, unclaimedUsd = 0n;
    for (let i = 0; i < list.length; i += 20) {
      const part = await Promise.all(list.slice(i, i + 20).map(async (a) => Promise.all([o.getUser(a), o.pendingUsd(a)])));
      for (const [u, p] of part) {
        if (u.liquidity > 0n) withLiquidity++;
        const usd: bigint = p[0] + p[1];
        if (usd > 0n) {
          unclaimed++;
          unclaimedUsd += usd;
        }
      }
    }
    return { wallets: list.length, withLiquidity, unclaimed, unclaimedUsd };
  }

  async admin(action: AdminAction, arg: any, steps: Step[], on: OnSteps): Promise<boolean> {
    const s = await this.signer();
    const m = new E.Contract(this.addr.miner, MINER_ABI, s);
    const fns: Record<AdminAction, () => Promise<any>> = {
      pause: () => m.setAdminPaused(true),
      resume: () => m.setAdminPaused(false),
      checkpoint: () => m.checkpoint(),
      approve: () => new E.Contract(this.addr.reward, ERC20_ABI, s).approve(this.addr.miner, arg),
      rewardParams: () => m.setRewardParams(arg.rateBps, arg.personalBps, arg.tier1Bps, arg.tier2Bps, arg.thresholdUsd),
      safetyParams: () => m.setSafetyParams(arg.maxTickDeviation, arg.minPoolLiquidity, arg.minRewardPoolLiquidity, arg.runwayDays),
      claimPause: () => m.setClaimPaused(true),
      claimResume: () => m.setClaimPaused(false),
      end: () => m.endMining(),
      oldPause: () => new E.Contract(this.old.target, OLD_MINER_ABI, s).setAdminPaused(true),
      oldEnd: () => new E.Contract(this.old.target, OLD_MINER_ABI, s).endMining(),
      oldRevoke: () => new E.Contract(this.addr.reward, ERC20_ABI, s).approve(this.old.target, 0n),
    };
    return this.runSteps(steps, [fns[action]], on);
  }

  /** Scan ALL miner events since deployment (one eth_getLogs per chunk). Admin data is derived from these. */
  async adminScan(onProgress: (done: number, total: number) => void): Promise<AdminEvent[]> {
    const head = await this.latestBlock();
    const from = this.cfg.deployBlock;
    const total = Math.max(1, head - from + 1);
    const names = new Set(["Joined", "Deposited", "Withdrawn", "Claimed", "DynamicAccrued"]);
    const raw: any[] = [];
    for (let start = from; start <= head; start += this.cfg.logChunk) {
      const end = Math.min(head, start + this.cfg.logChunk - 1);
      const logs = await this.queryLogs("*", start, end);
      for (const l of logs) if (l.fragment && names.has(l.fragment.name)) raw.push(l);
      onProgress(end - from + 1, total);
    }
    const times = new Map<number, number>();
    for (const l of raw) if (l.fragment.name === "Joined") times.set(l.blockNumber, Number(l.args.time));
    const need = [...new Set(raw.map((l) => l.blockNumber))].filter((n) => !times.has(n));
    for (let i = 0; i < need.length; i += 20) {
      await Promise.all(need.slice(i, i + 20).map(async (n) => times.set(n, (await this.read.getBlock(n))?.timestamp ?? 0)));
    }
    return raw.map((l) => {
      const args: Record<string, any> = {};
      l.fragment.inputs.forEach((inp: any, i: number) => (args[inp.name] = l.args[i]));
      return {
        name: l.fragment.name,
        user: (l.fragment.name === "DynamicAccrued" ? args.upline : args.user) as string,
        time: times.get(l.blockNumber) || 0,
        block: l.blockNumber,
        tx: l.transactionHash,
        args,
      } as AdminEvent;
    });
  }

  /** live per-user figures for the admin user list (batched) */
  async userRows(addresses: string[]): Promise<AdminUserRow[]> {
    return Promise.all(
      addresses.map(async (a) => {
        const [u, pend, val, elig] = await Promise.all([this.miner.getUser(a), this.miner.pendingUsd(a), this.miner.valueUsd(a), this.miner.isEligible(a)]);
        return {
          address: a,
          referrer: u.referrer === ZERO ? "" : u.referrer,
          firstDepositAt: Number(u.firstDepositAt),
          valueUsd: val,
          pendingUsd: pend[0] + pend[1],
          claimedReward: u.claimedPersonalReward + u.claimedDynamicReward,
          direct: Number(u.directCount),
          indirect: Number(u.indirectCount),
          eligible: elig,
        };
      }),
    );
  }

  // ------------------------------------------------------------------ events (paged backwards by block range)

  async latestBlock(): Promise<number> {
    return Number(await this.read.getBlockNumber());
  }

  private async queryLogs(filter: any, start: number, end: number): Promise<any[]> {
    try {
      return await this.miner.queryFilter(filter, start, end);
    } catch (e) {
      if (this.minerRpc === this.miner) throw e;
      return await this.minerRpc.queryFilter(filter, start, end);
    }
  }

  /** team statistics, worked out by the automatic check service from the chain's records (same website) */
  async teamStats(addr: string): Promise<TeamStats | null> {
    const r = await fetch(`./keeper/team.json?u=${addr}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.ok) return null;
    const liq = BigInt(j.liquidity || "0");
    const [amts, vpr] = await Promise.all([liq > 0n ? this.positionAmounts(liq) : Promise.resolve([0n, 0n] as [bigint, bigint]), this.miner.valuePerRef()]);
    return {
      direct: Number(j.direct),
      indirect: Number(j.indirect),
      team: Number(j.team),
      usdtOnly: BigInt(j.usdtOnly || "0"),
      bothUsdt: BigInt(j.bothUsdt || "0"),
      bothPop: BigInt(j.bothPop || "0"),
      bothValue: BigInt(j.bothValue || "0"),
      nowPop: amts[0],
      nowUsdt: amts[1],
      nowValueUsd: (liq * BigInt(vpr)) / L_REF,
    };
  }

  /** has this wallet deposited before (only such wallets can be referrers) */
  async isJoined(addr: string): Promise<boolean> {
    return Boolean((await this.miner.getUser(addr)).joined);
  }

  /** Simulate first through the public node (wallet nodes often drop the revert reason). Only the contract's own
   * rule errors stop the flow; network problems or a node that is a block behind are ignored. */
  private async precheck(call: () => Promise<any>): Promise<void> {
    try {
      await call();
    } catch (e: any) {
      const data = e?.data || e?.info?.error?.data;
      let name = e?.revert?.name || "";
      if (!name && typeof data === "string" && data.length >= 10) {
        try {
          name = MINER_IFACE.parseError(data)?.name || "";
        } catch {}
      }
      if (name && RULE_ERRORS.has(name)) throw e;
    }
  }

  /** Scan [from, to] in chunks; returns parsed logs. Caller pages by moving the window backwards. */
  private async scan(filter: any, from: number, to: number): Promise<any[]> {
    const out: any[] = [];
    for (let end = to; end >= from; end -= this.cfg.logChunk) {
      const start = Math.max(from, end - this.cfg.logChunk + 1);
      out.push(...(await this.queryLogs(filter, start, end)));
    }
    return out;
  }

  async records(account: string, kind: RecKind, toBlock: number, span: number): Promise<{ items: Rec[]; nextTo: number | null }> {
    if (kind === "lock") return this.lockRecords(account, toBlock, span);
    const from = Math.max(this.cfg.deployBlock, toBlock - span + 1);
    const f = this.miner.filters;
    let logs: any[] = [];
    if (kind === "liquidity") {
      const [a, b] = await Promise.all([this.scan(f.Deposited(account), from, toBlock), this.scan(f.Withdrawn(account), from, toBlock)]);
      logs = [...a, ...b];
    } else if (kind === "claim") logs = await this.scan(f.Claimed(account), from, toBlock);
    else logs = await this.scan(f.DynamicAccrued(account), from, toBlock);
    logs.sort((x, y) => y.blockNumber - x.blockNumber || y.index - x.index);
    const times = new Map<number, number>();
    await Promise.all(
      [...new Set(logs.map((l) => l.blockNumber))].map(async (n) => times.set(n, (await this.read.getBlock(n))?.timestamp ?? 0)),
    );
    const d = this.dec;
    const items: Rec[] = logs.map((l) => {
      const a = l.args;
      const time = times.get(l.blockNumber) || 0;
      if (l.fragment.name === "Deposited")
        return {
          kind,
          title: "添加流动性",
          sign: "+",
          lines: [
            { label: "投入", value: `${fmtUnits(a.usdtIn, d.usdt)} USDT${a.popIn > 0n ? ` + ${fmtUnits(a.popIn, d.pop)} POP` : ""}` },
          ],
          time,
          tx: l.transactionHash,
          status: "已完成",
        } as Rec;
      if (l.fragment.name === "Withdrawn")
        return {
          kind,
          title: "撤回流动性",
          sign: "-",
          lines: [
            { label: "本金返还", value: `${fmtUnits(a.popPrincipal, d.pop)} POP + ${fmtUnits(a.usdtPrincipal, d.usdt)} USDT` },
            { label: "手续费", value: `${fmtUnits(a.popFees, d.pop, 4)} POP + ${fmtUnits(a.usdtFees, d.usdt, 4)} USDT` },
          ],
          time,
          tx: l.transactionHash,
          status: "已完成",
        } as Rec;
      if (l.fragment.name === "Claimed")
        return {
          kind,
          title: "领取喜羊羊",
          sign: "+",
          lines: [
            { label: "实际收到", value: `${fmtUnits(a.personalReward + a.dynamicReward, d.reward)} 喜羊羊` },
            { label: "其中个人/动态", value: `${fmtUnits(a.personalReward, d.reward)} / ${fmtUnits(a.dynamicReward, d.reward)}` },
          ],
          time,
          tx: l.transactionHash,
          status: "已完成",
        } as Rec;
      return {
        kind,
        title: `动态奖励 · ${Number(a.tier) === 1 ? "直推 10%" : "间推 5%"}`,
        sign: "+",
        lines: [
          { label: "来源", value: short(a.from) },
          { label: "入账额度", value: `${fmtUnits(a.usd, 18, 4)} USDT 计价（领取时换算喜羊羊）` },
        ],
        time,
        tx: l.transactionHash,
        status: "已完成",
      } as Rec;
    });
    return { items, nextTo: from > this.cfg.deployBlock ? from - 1 : null };
  }

  async downlines(account: string, toBlock: number, span: number): Promise<{ direct: Downline[]; indirect: Downline[]; nextTo: number | null }> {
    const from = Math.max(this.cfg.deployBlock, toBlock - span + 1);
    const f = this.miner.filters;
    const [dl, il] = await Promise.all([this.scan(f.Joined(null, account), from, toBlock), this.scan(f.Joined(null, null, account), from, toBlock)]);
    const load = async (logs: any[]): Promise<Downline[]> =>
      Promise.all(
        logs.map(async (l) => {
          const u = l.args.user as string;
          const [v, e] = await Promise.all([this.miner.valueUsd(u), this.miner.isEligible(u)]);
          return { address: u, firstDepositAt: Number(l.args.time), valueUsd: v, eligible: e };
        }),
      );
    return { direct: await load(dl), indirect: await load(il), nextTo: from > this.cfg.deployBlock ? from - 1 : null };
  }

  async adminLog(toBlock: number, span: number): Promise<{ text: string; time: number; tx: string }[]> {
    const from = Math.max(this.cfg.deployBlock, toBlock - span + 1);
    const f = this.miner.filters;
    const logs = (
      await Promise.all([
        this.scan(f.AdminPausedSet(), from, toBlock),
        this.scan(f.RunningChanged(), from, toBlock),
        this.scan(f.RewardParamsSet(), from, toBlock),
        this.scan(f.SafetyParamsSet(), from, toBlock),
        this.scan(f.ClaimPausedSet(), from, toBlock),
        this.scan(f.MiningEnded(), from, toBlock),
      ])
    ).flat();
    logs.sort((x: any, y: any) => y.blockNumber - x.blockNumber);
    return Promise.all(
      logs.slice(0, 30).map(async (l: any) => {
        const n = l.fragment.name;
        const text =
          n === "AdminPausedSet"
            ? l.args.paused
              ? "管理员暂停"
              : "管理员申请恢复"
            : n === "RunningChanged"
              ? l.args.running
                ? "运行状态：恢复计息"
                : `运行状态：停止计息（原因码 ${l.args.reasons}）`
              : n === "RewardParamsSet"
                ? `奖励参数：日收益 ${Number(l.args.dailyRateBps) / 100}%，本人/一代/二代 ${Number(l.args.personalBps) / 100}%/${Number(l.args.tier1Bps) / 100}%/${Number(l.args.tier2Bps) / 100}%，门槛 ${fmtUnits(l.args.thresholdUsd, 18, 0)} USDT`
                : n === "SafetyParamsSet"
                  ? `安全参数：入金偏离 ${Number(l.args.maxTickDeviation) / 100}%，储备覆盖 ${l.args.runwayDays} 天`
                  : n === "ClaimPausedSet"
                    ? l.args.paused ? "暂停领取" : "恢复领取"
                    : "挖矿已永久结束";
        return { text, time: (await this.read.getBlock(l.blockNumber))?.timestamp ?? 0, tx: l.transactionHash };
      }),
    );
  }
}

const MINER_IFACE = new E.Interface([...MINER_ABI, ...LOCK_ABI.filter((x) => x.startsWith("error ") && !MINER_ABI.includes(x))]);

const RULE_ERRORS = new Set([
  "BadReferrer", "AlreadyBound", "ZeroAmount", "ClaimPaused", "Ended", "PriceUnstable", "Slippage", "Expired",
  "NotRunning", "RewardPriceUnavailable", "FeeOnTransfer", "NothingToClaim", "TooMuchLiquidity",
  "Paused", "BadPlan", "BadCoin", "BadAmount", "OperatorCannotLock",
]);

export function humanError(e: any): string {
  let m = String(e?.shortMessage || e?.reason || e?.message || e);
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    try {
      const d = MINER_IFACE.parseError(data);
      if (d) m = d.name + " " + m;
    } catch {}
  }
  if (e?.revert?.name) m = e.revert.name + " " + m;
  if (/OperatorShort/.test(m)) return "暂时无法锁仓，请稍后再试";
  if (/OperatorCannotLock/.test(m)) return "运营钱包不能锁仓";
  if (/BadPlan/.test(m)) return "锁仓方案无效";
  if (/BadCoin/.test(m)) return "锁仓币种无效";
  if (/BadAmount/.test(m)) return "数量无效，或暂时没有可领取的币";
  if (/PriceUnavailable/.test(m)) return "请稍后再试";
  if (/(^|[^A-Za-z])Paused/.test(m)) return "锁仓暂时关闭（管理员已暂停新锁仓），已锁仓的照常释放和领取";
  if (/BadReferrer/.test(m)) return "推荐人还没有入过金，暂时不能绑定（推荐人必须先入金，且不能是自己）";
  if (/AlreadyBound/.test(m)) return "已绑定过推荐人，不能修改";
  if (/ZeroAmount/.test(m)) return "数量无效";
  if (/ClaimPaused/.test(m)) return "领取暂时关闭（管理员已暂停领取），收益照常累计";
  if (/Ended/.test(m)) return "挖矿已永久结束，不能再开启";
  if (/PriceUnstable/.test(m)) return "POP 价格刚刚被大幅拉动，为防止被夹子攻击，这笔入金暂不成交，请过几分钟再试（已有收益照常累计）";
  if (e?.code === "ACTION_REJECTED" || /user rejected|denied/i.test(m)) return "您已在钱包中拒绝签名，可重新发起";
  if (/Slippage/.test(m)) return "价格变化超出滑点保护，请刷新报价后重试";
  if (/Expired/.test(m)) return "报价已过期，请刷新后重试";
  if (/NotRunning/.test(m)) return "请稍后再试";
  if (/RewardPriceUnavailable/.test(m)) return "请稍后再试";
  if (/FeeOnTransfer/.test(m)) return "到账数量和应发数量不一致（代币转账扣税，或运营钱包给自己领取），交易已整体回滚，奖励不会丢失";
  if (/NothingToClaim/.test(m)) return "暂无可领取奖励";
  if (/insufficient funds|gas required exceeds|INSUFFICIENT_FUNDS/i.test(m) || e?.code === "INSUFFICIENT_FUNDS")
    return "钱包里的 BNB 不够付手续费，请先往这个钱包转一点 BNB（0.005 左右就够）";
  if (/insufficient|exceeds balance|allowance/i.test(m)) return "余额或授权不足（可能是运营钱包储备不足），交易已回滚，奖励不会丢失";
  if (/network|timeout|fetch/i.test(m)) return "网络错误，请检查网络后重试";
  if (/missing revert data|execution reverted|CALL_EXCEPTION/i.test(m)) return "交易未能执行（钱包没有返回具体原因），请刷新页面后重试";
  if (/could not coalesce|unknown error|UNKNOWN_ERROR/i.test(m)) return "钱包或网络返回异常，请刷新页面后重试";
  return m.length > 140 ? m.slice(0, 140) + "…" : m;
}

export async function walletAccounts(request: boolean): Promise<string[]> {
  if (!window.ethereum) return [];
  return window.ethereum.request({ method: request ? "eth_requestAccounts" : "eth_accounts" });
}

export async function walletChainId(): Promise<number | null> {
  if (!window.ethereum) return null;
  return parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
}

export async function switchChain(cfg: AppConfig): Promise<void> {
  const hex = "0x" + cfg.chainId.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e: any) {
    if (e?.code === 4902 && cfg.chainId === 56) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hex, chainName: "BNB Smart Chain", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: [cfg.rpcUrl], blockExplorerUrls: [cfg.explorer] }],
      });
    } else throw e;
  }
}
