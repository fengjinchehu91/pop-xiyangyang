// DEMO backend: consistent mock data for previewing the UI. Every screen shows a "演示数据" banner in this mode.
// Nothing here is read from or sent to any chain.
import type { AddQuote, AdminEvent, AdminUserRow, Downline, ExitQuote, Rec, RecKind, Snapshot, Step } from "./types";
import { DEFAULT_PARAMS } from "./types";
import type { OnSteps } from "./chain";
import { applySlippage, E18 } from "./fmt";

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
    claimedPersonal: 21_430n * E18,
    claimedDynamic: 4_000n * E18,
  };

  async init() {}

  async snapshot(account?: string): Promise<Snapshot> {
    const dt = BigInt(now() - this.t0);
    const personalUsd = this.base.personalUsd + (this.base.valueUsd * 85n * dt) / (100n * 100n * 86400n);
    const s: Snapshot = {
      params: { ...DEFAULT_PARAMS },
      configured: true,
      running: true,
      reasons: 0,
      adminPaused: false,
      lastCheckpoint: now() - 240,
      rewardPrice: PRICE,
      rewardDecimals: 18,
      usdtDecimals: 18,
      popDecimals: 18,
      tvlUsd: 386_420n * E18,
      participants: 1_284,
      totalPaidReward: 2_480_115n * E18,
      owner: addr(9999),
      operator: addr(9999),
      runwayDays: 3,
      reserve: { balance: 8_600_000n * E18, allowance: 5_000_000n * E18, usable: 5_000_000n * E18, liabilityUsd: 21_350n * E18 },
      user: null,
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
        eligible: this.base.valueUsd >= 100n * E18,
        direct: 12,
        indirect: 28,
        firstDepositAt: now() - 86400 * 20,
        tokenId: 123456n,
      };
      s.balances = { usdt: 3_820n * E18, pop: 2_100_000n * E18, reward: 25_430n * E18 };
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

  async quoteExit(_a: string, pctBps: number, slipBps: number, userLiq: bigint, valueUsd: bigint, thresholdUsd: bigint = 100n * E18): Promise<ExitQuote> {
    const liq = pctBps >= 10000 ? userLiq : (userLiq * BigInt(pctBps)) / 10000n;
    const usdt = (valueUsd * BigInt(Math.min(pctBps, 10000))) / 20000n;
    const remaining = (valueUsd * BigInt(10000 - Math.min(pctBps, 10000))) / 10000n;
    return {
      liquidity: liq, pop: usdt * POP_PER_USDT, usdt, minPop: applySlippage(usdt * POP_PER_USDT, slipBps), minUsdt: applySlippage(usdt, slipBps),
      remainingValueUsd: remaining, eligibleAfter: remaining >= thresholdUsd, createdAt: Date.now(),
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
  claim(_m: bigint, steps: Step[], on: OnSteps) { return this.fake(steps, on); }
  admin(_a: string, _x: any, steps: Step[], on: OnSteps) { return this.fake(steps, on); }

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
      { kind, title: "添加流动性", sign: "+", lines: [{ label: "投入", value: "500.00 USDT" }, { label: "退回余量", value: "0.21 USDT / 1,180.00 POP" }], time: t - 3600 * 5, tx, status: "已完成" },
      { kind, title: "撤回流动性", sign: "-", lines: [{ label: "本金返还", value: "1,875,000 POP + 312.50 USDT" }, { label: "手续费", value: "2,140 POP + 0.36 USDT" }], time: t - 86400 * 2, tx, status: "已完成" },
      { kind, title: "添加流动性", sign: "+", lines: [{ label: "投入", value: "1,000.00 USDT" }, { label: "退回余量", value: "0.40 USDT / 0.00 POP" }], time: t - 86400 * 4, tx, status: "已完成" },
    ];
    const C: Rec[] = [
      { kind, title: "领取喜羊羊", sign: "+", lines: [{ label: "实际收到", value: "2,680.00 喜羊羊" }, { label: "其中个人/动态", value: "2,280.00 / 400.00" }], time: t - 86400, tx, status: "已完成" },
      { kind, title: "领取喜羊羊", sign: "+", lines: [{ label: "实际收到", value: "5,000.00 喜羊羊" }, { label: "其中个人/动态", value: "4,350.00 / 650.00" }], time: t - 86400 * 6, tx, status: "已完成" },
    ];
    const D: Rec[] = [
      { kind, title: "动态奖励 · 第一档 10%", sign: "+", lines: [{ label: "来源", value: "0x8D31…70A2" }, { label: "入账额度", value: "1.2500 USDT 计价（领取时换算喜羊羊）" }], time: t - 3600 * 2, tx, status: "已完成" },
      { kind, title: "动态奖励 · 第二档 5%", sign: "+", lines: [{ label: "来源", value: "0x4F9E…3C77" }, { label: "入账额度", value: "0.2600 USDT 计价（领取时换算喜羊羊）" }], time: t - 3600 * 9, tx, status: "已完成" },
    ];
    return { items: kind === "liquidity" ? L : kind === "claim" ? C : D, nextTo: null };
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
