export interface UserView {
  liquidity: bigint;
  valueUsd: bigint; // 18-dec USD reference value (TWAP checkpoint)
  popAmt: bigint; // current spot amounts of the position (excl. fees)
  usdtAmt: bigint;
  personalUsd: bigint; // unpaid, incl. own unsettled part
  dynamicUsd: bigint; // unpaid, settled shares only
  claimedPersonal: bigint; // reward tokens actually received
  claimedDynamic: bigint;
  referrer: string;
  joined: boolean;
  eligible: boolean; // the contract's own judgement (入金额度 >= threshold)
  principalUsd: bigint; // 入金额度 (18-dec USD): booked when added, reduced in proportion on withdrawal
  direct: number;
  indirect: number;
  firstDepositAt: number;
  tokenId: bigint; // PancakeSwap V3 position NFT, held by the mining contract
}

export interface Params {
  rateBps: number; // daily total, e.g. 100 = 1%
  personalBps: number;
  tier1Bps: number;
  tier2Bps: number;
  thresholdUsd: bigint; // 18-dec
  maxTickDeviation: number;
  minPoolLiquidity: bigint;
  minRewardPoolLiquidity: bigint;
  claimPaused: boolean;
  ended: boolean;
}

export const DEFAULT_PARAMS: Params = {
  rateBps: 100,
  personalBps: 8500,
  tier1Bps: 1000,
  tier2Bps: 500,
  thresholdUsd: 100n * 10n ** 18n,
  maxTickDeviation: 300,
  minPoolLiquidity: 1n,
  minRewardPoolLiquidity: 1n,
  claimPaused: false,
  ended: false,
};

export interface Snapshot {
  params: Params;
  configured: boolean;
  problem?: string; // why not configured / unavailable
  running: boolean;
  reasons: number;
  adminPaused: boolean;
  lastCheckpoint: number;
  rewardPrice: bigint | null; // USD18 per whole reward token (TWAP), null = unavailable
  rewardPriceEstimated?: boolean; // true: the contract's average price is briefly unavailable, this is a live market estimate
  twapMinutes: number; // the contract's average-price time (minutes)
  rewardDecimals: number;
  usdtDecimals: number;
  popDecimals: number;
  tvlUsd: bigint | null;
  totalPrincipalUsd: bigint | null; // sum of everyone's 入金额度 (18-dec USD): the daily emission is based on it
  participants: number;
  totalPaidReward: bigint;
  owner: string;
  operator: string;
  runwayDays: number;
  reserve: { balance: bigint; allowance: bigint; usable: bigint; liabilityUsd: bigint } | null;
  user: UserView | null;
  old: OldUserView | null; // this wallet in the previous contract (null = no previous contract configured)
  oldStatus: OldStatus | null; // previous contract, for the admin page (owner / operator wallets only)
  balances: { usdt: bigint; pop: bigint; reward: bigint } | null;
  addresses: { miner: string; pool: string; pop: string; usdt: string; reward: string; rewardPool: string; npm?: string };
  fetchedAt: number;
}

/** a wallet in the previous contract: what it still has to withdraw / claim there, and its old referral binding */
export interface OldUserView {
  liquidity: bigint;
  valueUsd: bigint;
  personalUsd: bigint;
  dynamicUsd: bigint;
  referrer: string; // "" = none
  joined: boolean;
  refJoined: boolean | null; // has the old referrer already added liquidity in the new contract (null = not checked)
}

export interface OldStatus {
  address: string;
  adminPaused: boolean;
  ended: boolean;
  accruing: boolean;
  claimPaused: boolean;
  totalLiquidity: bigint;
  tvlUsd: bigint | null;
  participants: number;
  reserve: { balance: bigint; allowance: bigint; usable: bigint; liabilityUsd: bigint };
  rewardPrice: bigint | null;
}

export type RecKind = "liquidity" | "claim" | "dynamic";

export interface Rec {
  kind: RecKind;
  title: string;
  lines: { label: string; value: string }[];
  time: number;
  tx: string;
  status: "已完成";
  sign?: "+" | "-";
}

/** a wallet's whole team (every level below it, wallets that have added liquidity, excluding itself) */
export interface TeamStats {
  direct: number;
  indirect: number;
  team: number;
  usdtOnly: bigint; // put in with "USDT only" (USDT raw units)
  bothUsdt: bigint; // put in with "USDT + POP": USDT part
  bothPop: bigint; //   ... POP part (POP raw units)
  bothValue: bigint; //  ... both parts in USDT raw units (at the time of adding)
  nowPop: bigint; // still in the pool now
  nowUsdt: bigint;
  nowValueUsd: bigint; // 18-dec USD reference value
}

export interface Downline {
  address: string;
  firstDepositAt: number;
  valueUsd: bigint;
  eligible: boolean;
}

export type StepStatus = "idle" | "wallet" | "pending" | "done" | "error" | "skipped";
export interface Step {
  label: string;
  status: StepStatus;
  hash?: string;
  error?: string;
}

export interface AddQuote {
  mode: "usdt" | "both";
  usdtAmount: bigint;
  popAmount: bigint;
  swapUsdt: bigint;
  expectedPopFromSwap: bigint;
  minPopFromSwap: bigint;
  popUsed: bigint;
  usdtUsed: bigint;
  minPopUsed: bigint;
  minUsdtUsed: bigint;
  popRefund: bigint;
  usdtRefund: bigint;
  estValueUsd: bigint;
  createdAt: number;
}

export interface ExitQuote {
  liquidity: bigint;
  pop: bigint;
  usdt: bigint;
  minPop: bigint;
  minUsdt: bigint;
  remainingValueUsd: bigint;
  eligibleAfter: boolean;
  createdAt: number;
}

export const REASON_TEXT: [number, string][] = [
  [1, "管理员已暂停新增入金和计息"],
  [2, "流动性估值不可用（价格历史不足、偏离过大或流动性不足）"],
  [4, "喜羊羊报价暂不可用（刚部署需要先积累价格历史，或自动检查服务停止运行超过 1 小时）"],
  [8, "运营钱包储备或授权不足"],
  [16, "挖矿已永久结束（已累计奖励仍可领取，本金随时可退出）"],
];

// ---------------------------------------------------------------- admin data (derived from on-chain events)
export interface AdminEvent {
  name: "Joined" | "Deposited" | "Withdrawn" | "Claimed" | "DynamicAccrued";
  user: string;
  time: number;
  block: number;
  tx: string;
  args: Record<string, any>;
}

export interface AdminUserRow {
  address: string;
  referrer: string;
  firstDepositAt: number;
  valueUsd: bigint;
  pendingUsd: bigint;
  claimedReward: bigint;
  direct: number;
  indirect: number;
  eligible: boolean;
}
