// Real-chain backend (local Anvil / BSC fork / BSC mainnet). Reads via the configured RPC, writes via the
// injected wallet (EIP-1193). Never falls back to mock values: missing data is reported as unavailable.
// @ts-ignore vendored ESM build of ethers v6.13.4 (MIT)
import * as E from "./vendor/ethers.min.js";
import { MINER_ABI, ERC20_ABI, POOL_ABI } from "./abi";
import type { AppConfig } from "./config";
import type { AddQuote, Downline, ExitQuote, Rec, RecKind, Snapshot, Step } from "./types";
import { applySlippage, E18, fmtUnits, short } from "./fmt";

const L_REF = 10n ** 27n;
const Q192 = 1n << 192n;
const ZERO = "0x0000000000000000000000000000000000000000";

export type OnSteps = (steps: Step[]) => void;

declare global {
  interface Window {
    ethereum?: any;
  }
}

export class ChainBackend {
  cfg: AppConfig;
  read: any;
  miner: any;
  addr = { miner: "", pool: "", pop: "", usdt: "", reward: "", rewardPool: "" };
  dec = { usdt: 18, pop: 18, reward: 18 };
  fee = 0;
  token0 = "";
  ready = false;
  problem = "";

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.read = new E.JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
  }

  async init(): Promise<void> {
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
      const [pool, pop, usdt, reward, rewardPool, fee, token0] = await Promise.all([
        this.miner.POOL(),
        this.miner.POP(),
        this.miner.USDT(),
        this.miner.REWARD(),
        this.miner.REWARD_POOL(),
        this.miner.FEE(),
        this.miner.TOKEN0(),
      ]);
      // cross-check contract immutables against the configured addresses
      const same = (a: string, b: string) => !b || a.toLowerCase() === b.toLowerCase();
      if (!same(pool, this.cfg.pool) || !same(pop, this.cfg.pop) || !same(reward, this.cfg.reward) || !same(usdt, this.cfg.usdt)) {
        this.problem = "合约内的池子/代币地址与配置不一致，已禁止交易";
        return;
      }
      this.addr = { miner: this.cfg.miner, pool, pop, usdt, reward, rewardPool };
      const t = (a: string) => new E.Contract(a, ERC20_ABI, this.read);
      const [du, dp, dr] = await Promise.all([t(usdt).decimals(), t(pop).decimals(), t(reward).decimals()]);
      this.dec = { usdt: Number(du), pop: Number(dp), reward: Number(dr) };
      this.fee = Number(fee);
      this.token0 = token0;
      this.ready = true;
    } catch (e: any) {
      this.problem = "读取链上数据失败：" + (e?.shortMessage || e?.message || "未知错误");
    }
  }

  private emptySnap(problem: string): Snapshot {
    return {
      configured: false,
      problem,
      running: false,
      reasons: 0,
      adminPaused: false,
      lastCheckpoint: 0,
      rewardPrice: null,
      rewardDecimals: 18,
      usdtDecimals: 18,
      popDecimals: 18,
      tvlUsd: null,
      participants: 0,
      totalPaidReward: 0n,
      owner: "",
      operator: "",
      runwayDays: 0,
      reserve: null,
      user: null,
      balances: null,
      addresses: { ...this.addr, pool: this.addr.pool || this.cfg.pool, pop: this.addr.pop || this.cfg.pop, reward: this.addr.reward || this.cfg.reward },
      fetchedAt: Date.now(),
    };
  }

  async snapshot(account?: string): Promise<Snapshot> {
    if (!this.ready) return this.emptySnap(this.problem || "未就绪");
    const m = this.miner;
    const [accruing, reasons, adminPaused, lastCp, vpr, totalLiq, participants, paidReward, owner, operator, runway, rp, reserve] =
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
      ]);
    const snap: Snapshot = {
      ...this.emptySnap(""),
      configured: true,
      problem: undefined,
      running: accruing,
      reasons: Number(reasons),
      adminPaused,
      lastCheckpoint: Number(lastCp),
      rewardPrice: rp[0] ? rp[1] : null,
      rewardDecimals: this.dec.reward,
      usdtDecimals: this.dec.usdt,
      popDecimals: this.dec.pop,
      tvlUsd: vpr > 0n ? (totalLiq * vpr) / L_REF : null,
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
      const amounts = u.liquidity > 0n ? await m.amountsForLiquidity(u.liquidity) : [0n, 0n];
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
        direct: Number(u.directCount),
        indirect: Number(u.indirectCount),
        firstDepositAt: Number(u.firstDepositAt),
      };
      snap.balances = { usdt: bu, pop: bp, reward: br };
    }
    return snap;
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
    const [, popUsed, usdtUsed] = await this.miner.previewAdd(popAvail, usdtAvail);
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

  async quoteExit(account: string, pctBps: number, slipBps: number, userLiq: bigint, valueUsd: bigint): Promise<ExitQuote> {
    const liq = pctBps >= 10000 ? userLiq : (userLiq * BigInt(pctBps)) / 10000n;
    const [pop, usdt] = liq > 0n ? await this.miner.amountsForLiquidity(liq) : [0n, 0n];
    const remainingValueUsd = userLiq > 0n ? (valueUsd * (userLiq - liq)) / userLiq : 0n;
    void account;
    return {
      liquidity: liq,
      pop,
      usdt,
      minPop: applySlippage(pop, slipBps),
      minUsdt: applySlippage(usdt, slipBps),
      remainingValueUsd,
      eligibleAfter: remainingValueUsd >= 100n * E18,
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
    return this.runSteps(
      steps,
      [
        () => this.approveIfNeeded(s, this.addr.usdt, q.usdtAmount),
        () => (q.popAmount > 0n ? this.approveIfNeeded(s, this.addr.pop, q.popAmount) : Promise.resolve(null)),
        async () =>
          new E.Contract(this.addr.miner, MINER_ABI, s).deposit({
            usdtAmount: q.usdtAmount,
            popAmount: q.popAmount,
            swapUsdtAmount: q.swapUsdt,
            minPopFromSwap: q.minPopFromSwap,
            minUsdtUsed: q.minUsdtUsed,
            minPopUsed: q.minPopUsed,
            referrer: referrer || ZERO,
            deadline: await this.deadline(),
          }),
      ],
      on,
    );
  }

  async withdraw(q: ExitQuote, steps: Step[], on: OnSteps): Promise<boolean> {
    const s = await this.signer();
    return this.runSteps(
      steps,
      [async () => new E.Contract(this.addr.miner, MINER_ABI, s).withdraw(q.liquidity, q.minPop, q.minUsdt, await this.deadline())],
      on,
    );
  }

  async claim(minOut: bigint, steps: Step[], on: OnSteps): Promise<boolean> {
    const s = await this.signer();
    return this.runSteps(steps, [() => new E.Contract(this.addr.miner, MINER_ABI, s).claim(minOut)], on);
  }

  async admin(action: "pause" | "resume" | "checkpoint" | "approve", arg: bigint, steps: Step[], on: OnSteps): Promise<boolean> {
    const s = await this.signer();
    const m = new E.Contract(this.addr.miner, MINER_ABI, s);
    const fn =
      action === "pause"
        ? () => m.setAdminPaused(true)
        : action === "resume"
          ? () => m.setAdminPaused(false)
          : action === "checkpoint"
            ? () => m.checkpoint()
            : () => new E.Contract(this.addr.reward, ERC20_ABI, s).approve(this.addr.miner, arg);
    return this.runSteps(steps, [fn], on);
  }

  // ------------------------------------------------------------------ events (paged backwards by block range)

  async latestBlock(): Promise<number> {
    return Number(await this.read.getBlockNumber());
  }

  /** Scan [from, to] in chunks; returns parsed logs. Caller pages by moving the window backwards. */
  private async scan(filter: any, from: number, to: number): Promise<any[]> {
    const out: any[] = [];
    for (let end = to; end >= from; end -= this.cfg.logChunk) {
      const start = Math.max(from, end - this.cfg.logChunk + 1);
      const logs = await this.miner.queryFilter(filter, start, end);
      out.push(...logs);
    }
    return out;
  }

  async records(account: string, kind: RecKind, toBlock: number, span: number): Promise<{ items: Rec[]; nextTo: number | null }> {
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
            { label: "退回余量", value: `${fmtUnits(a.usdtRefund, d.usdt)} USDT / ${fmtUnits(a.popRefund, d.pop)} POP` },
          ],
          time,
          tx: l.transactionHash,
          status: "已完成",
        } as Rec;
      if (l.fragment.name === "Withdrawn")
        return {
          kind,
          title: "退出流动性",
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
        title: `动态奖励 · ${Number(a.tier) === 1 ? "第一档 10%" : "第二档 5%"}`,
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
      await Promise.all([this.scan(f.AdminPausedSet(), from, toBlock), this.scan(f.RunningChanged(), from, toBlock), this.scan(f.RunwayDaysSet(), from, toBlock)])
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
              : `储备覆盖天数设为 ${l.args.days_}`;
        return { text, time: (await this.read.getBlock(l.blockNumber))?.timestamp ?? 0, tx: l.transactionHash };
      }),
    );
  }
}

const MINER_IFACE = new E.Interface(MINER_ABI);

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
  if (/BadReferrer/.test(m)) return "推荐人无效（推荐人必须已入金，且不能是自己）";
  if (/AlreadyBound/.test(m)) return "已绑定过推荐人，不能修改";
  if (/ZeroAmount/.test(m)) return "数量无效";
  if (e?.code === "ACTION_REJECTED" || /user rejected|denied/i.test(m)) return "您已在钱包中拒绝签名，可重新发起";
  if (/Slippage/.test(m)) return "价格变化超出滑点保护，请刷新报价后重试";
  if (/Expired/.test(m)) return "报价已过期，请刷新后重试";
  if (/NotRunning/.test(m)) return "当前暂停新增入金（见运行状态），本金退出不受影响";
  if (/RewardPriceUnavailable/.test(m)) return "喜羊羊报价暂不可用，暂不能领取，奖励不会丢失";
  if (/FeeOnTransfer/.test(m)) return "检测到代币转账扣税，交易已整体回滚";
  if (/NothingToClaim/.test(m)) return "暂无可领取奖励";
  if (/insufficient|exceeds balance|allowance/i.test(m)) return "余额或授权不足（可能是运营钱包储备不足），交易已回滚，奖励不会丢失";
  if (/network|timeout|fetch/i.test(m)) return "网络错误，请检查网络后重试";
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
