// DEMO backend: consistent mock data for previewing the UI. Every screen shows a "演示数据" banner in this mode.
// Nothing here is read from or sent to any chain.
import type { AddQuote, AdminEvent, AdminUserRow, Downline, ExitQuote, LockCoin, LockItem, LockView, Pair2, Rec, RecKind, Snapshot, Step, TeamStats } from "./types";
import { DEFAULT_PARAMS } from "./types";
import type { OnSteps } from "./chain";
import { applySlippage, E18, meetsThreshold } from "./fmt";

const now = () => Math.floor(Date.now() / 1000);
const addr = (n: number) => "0x" + n.toString(16).padStart(4, "0") + "d3a1c9e2b47f05a8e6c1d2b3a4f5e6c7d8" + n.toString(16).padStart(2, "0");

// 0.0395717 USD per 喜羊羊 -> 1,250 USDT LP earns 1250*1%*85% = 10.625 USD/day ≈ 268.5 喜羊羊/day
const PRICE = 39_571_700_000_000_000n;
const POP_PER_USDT = 6000n; // demo price: 1 POP = 0.000166 USDT

export class DemoBackend {
  t0 = now();
  base = {
    personalUsd: 450_000_000_000_000_000_000n, // 450 USD
    dynamicUsd: 74_400_000_000_000_000_000n,
    liquidity: 1_000_000_000_000_000_000_000n,
    valueUsd: 1250n * E18,
    principalUsd: 1200n * E18, // 入金额度: booked when added (the LP value moves with the price, this does not)
    claimedPersonal: 21_430n * E18,
    claimedDynamic: 4_000n * E18,
  };

  async init() {}

  async snapshot(account?: string): Promise<Snapshot> {
    const dt = BigInt(now() - this.t0);
    const personalUsd = this.base.personalUsd + (this.base.principalUsd * 85n * dt) / (100n * 100n * 86400n);
    const s: Snapshot = {
      params: { ...DEFAULT_PARAMS },
      configured: true,
      running: true,
      reasons: 0,
      adminPaused: false,
      lastCheckpoint: now() - 240,
      rewardPrice: PRICE,
      twapMinutes: 15,
      rewardDecimals: 18,
      usdtDecimals: 18,
      popDecimals: 18,
      tvlUsd: 386_420n * E18,
      totalPrincipalUsd: 371_800n * E18,
      participants: 1_284,
      totalPaidReward: 2_480_115n * E18,
      owner: addr(9999),
      operator: addr(9999),
      runwayDays: 3,
      reserve: { balance: 8_600_000n * E18, allowance: 5_000_000n * E18, usable: 5_000_000n * E18, liabilityUsd: 21_350n * E18 },
      user: null,
      old: null,
      oldStatus: {
        address: "0x363CBA25a4bC4617fAF017b1e0728f4AB7473E17", adminPaused: true, ended: false, accruing: false, claimPaused: false,
        totalLiquidity: 4_000_000_000_000_000_000_000n, tvlUsd: 2_310n * E18, participants: 37,
        reserve: { balance: 8_600_000n * E18, allowance: 120_000n * E18, usable: 120_000n * E18, liabilityUsd: 186n * E18 },
        rewardPrice: PRICE,
      },
      balances: null,
      addresses: {
        miner: "0x0000000000000000000000000000000000000000",
        pool: "0xE5ce5bc4785CD2a246151364f5A190ceE3FDb142",
        pop: "0xA3cfB853339b77F385B994799B015cB04b208Fe6",
        usdt: "0x55d398326f99059fF775485246999027B3197955",
        reward: "0x4dDA46C9dD7e794B99eebDcfD3c82bfBD3207777",
        rewardPool: "0x0000000000000000000000000000000000000000",
        npm: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
      },
      fetchedAt: Date.now(),
    };
    if (account) {
      s.user = {
        liquidity: this.base.liquidity,
        valueUsd: this.base.valueUsd,
        popAmt: 625n * E18 * POP_PER_USDT,
        usdtAmt: 625n * E18,
        personalUsd,
        dynamicUsd: this.base.dynamicUsd,
        claimedPersonal: this.base.claimedPersonal,
        claimedDynamic: this.base.claimedDynamic,
        referrer: addr(7),
        joined: this.base.liquidity > 0n || true,
        eligible: this.base.principalUsd >= 100n * E18,
        principalUsd: this.base.principalUsd,
        direct: 12,
        indirect: 28,
        firstDepositAt: now() - 86400 * 20,
        tokenId: 123456n,
      };
      s.balances = { usdt: 3_820n * E18, pop: 2_100_000n * E18, reward: 25_430n * E18 };
      // previous contract: a position and rewards still to take out (演示迁移提示)
      s.old = this.oldDone
        ? { liquidity: 0n, valueUsd: 0n, personalUsd: 0n, dynamicUsd: 0n, referrer: addr(7), joined: true, refJoined: true }
        : { liquidity: 900_000_000_000_000_000_000n, valueUsd: 318n * E18, personalUsd: 8_600_000_000_000_000_000n, dynamicUsd: 1_200_000_000_000_000_000n, referrer: addr(7), joined: true, refJoined: true };
    }
    return s;
  }

  async pairAmount(from: "usdt" | "pop", amount: bigint): Promise<bigint> {
    return from === "usdt" ? amount * POP_PER_USDT : amount / POP_PER_USDT;
  }

  async quoteAdd(mode: "usdt" | "both", usdtAmount: bigint, popAmount: bigint, slipBps: number): Promise<AddQuote> {
    if (mode === "usdt") {
      const swap = (usdtAmount * 10000n) / 19975n;
      const pop = (swap * 9975n * POP_PER_USDT) / 10000n;
      const usdtAvail = usdtAmount - swap;
      const usdtUsed = usdtAvail < pop / POP_PER_USDT ? usdtAvail : pop / POP_PER_USDT;
      const popUsed = usdtUsed * POP_PER_USDT;
      return {
        mode, usdtAmount, popAmount: 0n, swapUsdt: swap, expectedPopFromSwap: pop, minPopFromSwap: applySlippage(pop, slipBps),
        popUsed, usdtUsed, minPopUsed: applySlippage(popUsed, slipBps * 2), minUsdtUsed: applySlippage(usdtUsed, slipBps * 2),
        popRefund: pop - popUsed, usdtRefund: usdtAvail - usdtUsed, estValueUsd: usdtUsed * 2n, createdAt: Date.now(),
      };
    }
    const usdtUsed = usdtAmount < popAmount / POP_PER_USDT ? usdtAmount : popAmount / POP_PER_USDT;
    const popUsed = usdtUsed * POP_PER_USDT;
    return {
      mode, usdtAmount, popAmount, swapUsdt: 0n, expectedPopFromSwap: 0n, minPopFromSwap: 0n, popUsed, usdtUsed,
      minPopUsed: applySlippage(popUsed, slipBps), minUsdtUsed: applySlippage(usdtUsed, slipBps),
      popRefund: popAmount - popUsed, usdtRefund: usdtAmount - usdtUsed, estValueUsd: usdtUsed * 2n, createdAt: Date.now(),
    };
  }

  async quoteExit(_a: string, pctBps: number, slipBps: number, userLiq: bigint, valueUsd: bigint, principalUsd: bigint, thresholdUsd: bigint): Promise<ExitQuote> {
    const liq = pctBps >= 10000 ? userLiq : (userLiq * BigInt(pctBps)) / 10000n;
    const usdt = (valueUsd * BigInt(Math.min(pctBps, 10000))) / 20000n;
    const remaining = (valueUsd * BigInt(10000 - Math.min(pctBps, 10000))) / 10000n;
    const remainingPrincipal = pctBps >= 10000 ? 0n : (principalUsd * BigInt(10000 - pctBps)) / 10000n;
    return {
      liquidity: liq, pop: usdt * POP_PER_USDT, usdt, minPop: applySlippage(usdt * POP_PER_USDT, slipBps), minUsdt: applySlippage(usdt, slipBps),
      remainingValueUsd: remaining, eligibleAfter: meetsThreshold(remainingPrincipal, thresholdUsd), createdAt: Date.now(),
    };
  }

  private async fake(steps: Step[], on: OnSteps): Promise<boolean> {
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].status === "done" || steps[i].status === "skipped") continue;
      steps[i] = { ...steps[i], status: "wallet" };
      on([...steps]);
      await new Promise((r) => setTimeout(r, 700));
      steps[i] = { ...steps[i], status: "pending", hash: "0xdemo" + i };
      on([...steps]);
      await new Promise((r) => setTimeout(r, 900));
      steps[i] = { ...steps[i], status: "done" };
      on([...steps]);
    }
    return true;
  }
  deposit(_q: AddQuote, _r: string, steps: Step[], on: OnSteps) { return this.fake(steps, on); }
  withdraw(_q: ExitQuote, steps: Step[], on: OnSteps) { return this.fake(steps, on); }
  bind(_r: string, steps: Step[], on: OnSteps) { return this.fake(steps, on); }
  claim(_m: bigint, steps: Step[], on: OnSteps) { return this.fake(steps, on); }
  admin(_a: string, _x: any, steps: Step[], on: OnSteps) { return this.fake(steps, on); }
  oldDone = false;
  async oldAmounts(liquidity: bigint): Promise<[bigint, bigint]> {
    void liquidity;
    return [159n * E18 * POP_PER_USDT, 159n * E18];
  }
  async withdrawOld(_s: number, steps: Step[], on: OnSteps) {
    const ok = await this.fake(steps, on);
    this.oldDone = true;
    return ok;
  }
  async migrateOld(_s: number, steps: Step[], on: OnSteps) {
    const ok = await this.fake(steps, on);
    this.oldDone = true;
    return ok;
  }
  async oldLeftovers(onProgress: (d: number, t: number) => void) {
    onProgress(1, 1);
    return { wallets: 37, withLiquidity: 6, unclaimed: 9, unclaimedUsd: 186n * E18 };
  }

  /** demo admin data: a small consistent set of events */
  async adminScan(onProgress: (d: number, t: number) => void): Promise<AdminEvent[]> {
    onProgress(1, 1);
    const t = now();
    const ev: AdminEvent[] = [];
    const users = [addr(1), addr(11), addr(12), addr(13), addr(21), addr(22)];
    const refs = ["", addr(1), addr(1), addr(11), addr(11), addr(12)];
    users.forEach((u, i) => {
      const jt = t - 86400 * (6 - i);
      ev.push({ name: "Joined", user: u, time: jt, block: 100 + i, tx: "0xdemo", args: { user: u, referrer: refs[i] || "0x0000000000000000000000000000000000000000", referrer2: i >= 3 ? addr(1) : "0x0000000000000000000000000000000000000000", time: BigInt(jt) } });
      ev.push({ name: "Deposited", user: u, time: jt, block: 100 + i, tx: "0xdemo", args: { user: u, usdtIn: BigInt(300 + i * 150) * E18, popIn: 0n, usdtRefund: 0n, popRefund: 0n } });
    });
    for (let d = 0; d < 5; d++) {
      ev.push({ name: "Claimed", user: users[d % 6], time: t - 86400 * d - 3600, block: 200 + d, tx: "0xdemo", args: { user: users[d % 6], personalReward: BigInt(2000 + d * 300) * E18, dynamicReward: BigInt(300 + d * 40) * E18, personalUsd: 0n, dynamicUsd: 0n } });
    }
    ev.push({ name: "Withdrawn", user: users[3], time: t - 86400 * 2, block: 300, tx: "0xdemo", args: { user: users[3], popPrincipal: 1_200_000n * E18, usdtPrincipal: 200n * E18, popFees: 3000n * E18, usdtFees: E18 / 2n } });
    return ev;
  }

  async userRows(addresses: string[]): Promise<AdminUserRow[]> {
    return addresses.map((a, i) => ({
      address: a, referrer: i === 0 ? "" : addr(1), firstDepositAt: now() - 86400 * (6 - i), valueUsd: BigInt(600 + i * 300) * E18,
      pendingUsd: BigInt(5 + i * 3) * E18, claimedReward: BigInt(1000 + i * 700) * E18, direct: i < 2 ? 2 : 0, indirect: i === 0 ? 2 : 0, eligible: true,
    }));
  }

  async latestBlock() { return 1_000_000; }

  async records(_a: string, kind: RecKind, _to: number, _span: number): Promise<{ items: Rec[]; nextTo: number | null }> {
    const t = now();
    const tx = "0x" + "ab".repeat(32);
    const L: Rec[] = [
      { kind, title: "添加流动性", sign: "+", lines: [{ label: "投入", value: "500.00 USDT" }], time: t - 3600 * 5, tx, status: "已完成" },
      { kind, title: "撤回流动性", sign: "-", lines: [{ label: "本金返还", value: "1,875,000 POP + 312.50 USDT" }, { label: "手续费", value: "2,140 POP + 0.36 USDT" }], time: t - 86400 * 2, tx, status: "已完成" },
      { kind, title: "添加流动性", sign: "+", lines: [{ label: "投入", value: "1,000.00 USDT" }], time: t - 86400 * 4, tx, status: "已完成" },
    ];
    const C: Rec[] = [
      { kind, title: "领取喜羊羊", sign: "+", lines: [{ label: "实际收到", value: "2,680.00 喜羊羊" }, { label: "其中个人/动态", value: "2,280.00 / 400.00" }], time: t - 86400, tx, status: "已完成" },
      { kind, title: "领取喜羊羊", sign: "+", lines: [{ label: "实际收到", value: "5,000.00 喜羊羊" }, { label: "其中个人/动态", value: "4,350.00 / 650.00" }], time: t - 86400 * 6, tx, status: "已完成" },
    ];
    const D: Rec[] = [
      { kind, title: "动态奖励 · 直推 10%", sign: "+", lines: [{ label: "来源", value: "0x8D31…70A2" }, { label: "入账额度", value: "1.2500 USDT 计价（领取时换算喜羊羊）" }], time: t - 3600 * 2, tx, status: "已完成" },
      { kind, title: "动态奖励 · 间推 5%", sign: "+", lines: [{ label: "来源", value: "0x4F9E…3C77" }, { label: "入账额度", value: "0.2600 USDT 计价（领取时换算喜羊羊）" }], time: t - 3600 * 9, tx, status: "已完成" },
    ];
    const K: Rec[] = [
      { kind, title: "锁仓推荐奖励 · 直推", sign: "+", lines: [{ label: "到账", value: "1,250.00 喜羊羊" }, { label: "来源", value: "0x8D31…70A2" }], time: t - 3600 * 3, tx, status: "已完成" },
      { kind, title: "锁仓推荐奖励 · 间推（顺延）", sign: "+", lines: [{ label: "到账", value: "300.00 POP" }, { label: "来源", value: "0x4F9E…3C77" }], time: t - 3600 * 20, tx, status: "已完成" },
      { kind, title: "领取锁仓释放 · 喜羊羊", sign: "+", lines: [{ label: "到账", value: "2,040.00 喜羊羊" }], time: t - 86400, tx, status: "已完成" },
      { kind, title: "锁仓 POP · 100 天", sign: "-", lines: [{ label: "锁仓", value: "3,000.00 POP" }, { label: "立即到账奖励", value: "150.00 POP" }], time: t - 86400 * 5, tx, status: "已完成" },
      { kind, title: "锁仓 喜羊羊 · 200 天", sign: "-", lines: [{ label: "锁仓", value: "20,000.00 喜羊羊" }, { label: "立即到账奖励", value: "2,000.00 喜羊羊" }], time: t - 86400 * 10, tx, status: "已完成" },
      { kind, title: "锁仓 喜羊羊 · 100 天", sign: "-", lines: [{ label: "锁仓", value: "8,000.00 喜羊羊" }, { label: "用 USDT 买入", value: "400.00 USDT，2,000.00 喜羊羊到钱包" }, { label: "立即到账奖励", value: "400.00 喜羊羊" }], time: t - 86400 * 23, tx, status: "已完成" },
    ];
    return { items: kind === "liquidity" ? L : kind === "claim" ? C : kind === "lock" ? K : D, nextTo: null };
  }

  // ---------------------------------------------------------------- 锁仓 (demo)
  async lockView(account: string): Promise<LockView | null> {
    const t = now();
    const locks: LockItem[] = [
      { id: 2, coin: 1, amount: 3_000n * E18, claimed: 90n * E18, start: t - 86400 * 5 - 3600 * 7, days: 100 },
      { id: 1, coin: 0, amount: 20_000n * E18, claimed: 100n * E18, start: t - 86400 * 10 - 3600 * 5, days: 200 },
      { id: 0, coin: 0, amount: 8_000n * E18, claimed: 1_760n * E18, start: t - 86400 * 23 - 3600 * 2, days: 100 },
    ];
    const rel = (l: LockItem) => (l.amount * BigInt(Math.min(l.days, Math.floor((t - l.start) / 86400)))) / BigInt(l.days);
    const sum = (f: (l: LockItem) => bigint): Pair2 => [0, 1].map((c) => locks.filter((l) => l.coin === c).reduce((a, l) => a + f(l), 0n)) as Pair2;
    return {
      address: addr(4242), paused: false, owner: addr(9999),
      totals: {
        locked: [2_610_000n * E18, 180_000n * E18], claimed: [260_000n * E18, 9_000n * E18], ownReward: [182_000n * E18, 12_000n * E18],
        refReward: [128_000n * E18, 8_000n * E18], refUnpaid: [42_000n * E18, 2_500n * E18],
      },
      operator: { allowance: [4_690_000n * E18, 300_000n * E18], balance: [8_600_000n * E18, 520_000n * E18] },
      network: [2_350_000n * E18, 171_000n * E18],
      me: account
        ? {
            canRefer: true, stillLocked: sum((l) => l.amount - rel(l)), claimable: sum((l) => rel(l) - l.claimed),
            ownReward: [2_400n * E18, 150n * E18], refReward: [3_650n * E18, 300n * E18], team: [120_000n * E18, 8_000n * E18],
            locks, usdt: 3_820n * E18, reward: 25_430n * E18, pop: 1_875_000n * E18,
          }
        : null,
    };
  }
  async lockQuote(usdtIn: bigint): Promise<bigint> {
    return (((usdtIn * E18) / PRICE) * 995n) / 1000n;
  }
  lockBuy(_u: bigint, _b: number, _d: number, _s: number, steps: Step[], on: OnSteps) { return this.fake(steps, on); }
  lockWallet(_c: LockCoin, _a: bigint, _d: number, steps: Step[], on: OnSteps) { return this.fake(steps, on); }
  lockClaim(steps: Step[], on: OnSteps) { return this.fake(steps, on); }
  lockAdmin(_a: string, _x: bigint, steps: Step[], on: OnSteps) { return this.fake(steps, on); }

  async teamStats(_addr: string): Promise<TeamStats | null> {
    return {
      direct: 12, indirect: 28, team: 156,
      usdtOnly: 61_200n * E18, bothUsdt: 12_650n * E18, bothPop: 75_900_000n * E18, bothValue: 25_300n * E18,
      nowPop: 216_900_000n * E18, nowUsdt: 36_150n * E18, nowValueUsd: 72_300n * E18,
    };
  }

  async isJoined(_addr: string): Promise<boolean> {
    return true;
  }

  async downlines(): Promise<{ direct: Downline[]; indirect: Downline[]; nextTo: number | null }> {
    const t = now();
    const mk = (n: number, v: number): Downline => ({ address: addr(n), firstDepositAt: t - n * 7200, valueUsd: BigInt(v) * E18, eligible: v >= 100 });
    return {
      direct: [mk(11, 1250), mk(12, 520), mk(13, 80), mk(14, 300)],
      indirect: [mk(21, 960), mk(22, 40), mk(23, 150)],
      nextTo: null,
    };
  }

  async adminLog() {
    const t = now();
    return [
      { text: "运行状态：恢复计息", time: t - 86400 * 3, tx: "0xdemo" },
      { text: "管理员申请恢复", time: t - 86400 * 3, tx: "0xdemo" },
      { text: "运行状态：停止计息（原因码 8）", time: t - 86400 * 3 - 7200, tx: "0xdemo" },
    ];
  }
}
