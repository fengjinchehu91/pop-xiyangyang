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
  eligible: boolean;
  direct: number;
  indirect: number;
  firstDepositAt: number;
}

export interface Snapshot {
  configured: boolean;
  problem?: string; // why not configured / unavailable
  running: boolean;
  reasons: number;
  adminPaused: boolean;
  lastCheckpoint: number;
  rewardPrice: bigint | null; // USD18 per whole reward token (TWAP), null = unavailable
  rewardDecimals: number;
  usdtDecimals: number;
  popDecimals: number;
  tvlUsd: bigint | null;
  participants: number;
  totalPaidReward: bigint;
  owner: string;
  operator: string;
  runwayDays: number;
  reserve: { balance: bigint; allowance: bigint; usable: bigint; liabilityUsd: bigint } | null;
  user: UserView | null;
  balances: { usdt: bigint; pop: bigint; reward: bigint } | null;
  addresses: { miner: string; pool: string; pop: string; usdt: string; reward: string; rewardPool: string };
  fetchedAt: number;
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
  [4, "喜羊羊报价不可用"],
  [8, "运营钱包储备或授权不足"],
];
