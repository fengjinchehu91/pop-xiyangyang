// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "oz5/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "oz5/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "oz5/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "oz5/access/Ownable2Step.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {TickMath} from "v3-core/contracts/libraries/TickMath.sol";
import {V3Math} from "./lib/V3Math.sol";
import {
    IPancakeV3Pool,
    IPancakeV3Factory,
    INonfungiblePositionManager,
    IPancakeV2Pair,
    IPancakeV2Factory
} from "./interfaces/IPancakeV3.sol";

/// @title 喜羊羊矿场 (XiyangMiner) — version 2: rewards by the amount put in
/// @notice Custodies one full-range PancakeSwap V3 position NFT per user in a single fixed POP/USDT pool,
/// accrues USDT-denominated rewards (1%/day of the user's principal, 85/10/5 split), and pays rewards in the
/// reward token via transferFrom from the operator wallet (allowance model).
///
/// Principal ("入金额度", USD 18-dec): the TWAP value of the liquidity a deposit adds, booked at deposit time. Later
/// price moves of the position do not change it. A withdrawal reduces it in proportion to the liquidity removed
/// (everything removed -> 0). Referral rewards need principal >= the threshold (100 USD by default; 0.5% tolerance
/// for swap fees and rounding).
///
/// Key properties:
/// - Principal never touches the operator wallet; withdraw() needs no oracle, no reserve, and ignores pauses.
/// - No arbitrary external calls: only the fixed pool / position manager / three fixed tokens are called.
/// - Owner can pause/resume deposits+accrual, pause claims, end mining for good, and tune bounded parameters
///   (daily rate, 85/10/5 split, dynamic threshold, safety settings). Every change first settles everything accrued
///   so far under the old settings, so changes only affect the future. Owner can never touch principal or NFTs.
/// - Rewards accrue on principal; accrual stops automatically when no checkpoint ran for maxValuationAge, when the
///   reward price is unavailable, when reserve coverage fails, or when paused. No back-pay. A missing POP/USDT
///   average price only blocks new deposits (their principal cannot be valued), it does not stop accrual.
contract XiyangMiner is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants
    uint256 public constant L_REF = 1e27; // reference liquidity unit for valuePerRef
    uint256 public constant ACC_PREC = 1e18; // index precision
    uint256 private constant BPS = 10_000;
    uint256 private constant ELIG_TOL_BPS = 50; // referral threshold tolerance (swap fees / rounding at deposit)

    // reasons bitmask for "not running"
    uint8 public constant R_ADMIN_PAUSED = 1;
    uint8 public constant R_VALUATION_INVALID = 2;
    uint8 public constant R_REWARD_PRICE_INVALID = 4;
    uint8 public constant R_RESERVE_LOW = 8;
    uint8 public constant R_ENDED = 16;

    // ------------------------------------------------------------------ immutables
    IPancakeV3Pool public immutable POOL; // POP/USDT
    INonfungiblePositionManager public immutable NPM;
    IERC20 public immutable POP;
    IERC20 public immutable USDT;
    IERC20 public immutable REWARD; // 喜羊羊
    address public immutable REWARD_POOL; // REWARD/USDT or REWARD/POP (PancakeSwap V3 pool or V2 pair)
    bool public immutable REWARD_V2; // reward price from a V2 pair (cumulative-price TWAP recorded at checkpoints)
    bool private immutable REWARD_IS_TOKEN0; // V2: reward token is token0 of the pair
    address public immutable OPERATOR; // reward source wallet
    address public immutable TOKEN0;
    address public immutable TOKEN1;
    uint24 public immutable FEE;
    int24 public immutable TICK_LOWER;
    int24 public immutable TICK_UPPER;
    uint160 public immutable SQRT_LOWER; // sqrt price at the full-range bounds (front-end previews use these)
    uint160 public immutable SQRT_UPPER;
    bool public immutable REWARD_VIA_POP; // reward pool is REWARD/POP (two-hop to USDT)
    uint256 private immutable USDT_SCALE; // 10**(18 - usdtDecimals)
    uint256 private immutable REWARD_UNIT; // 10**rewardDecimals
    uint32 public immutable TWAP_WINDOW;
    uint32 public immutable MAX_VALUATION_AGE;
    uint8 public immutable MAX_UPLINE_SEARCH;

    // ------------------------------------------------------------------ global state
    bool public adminPaused;
    bool public accruing; // decided at the last checkpoint
    uint8 public pauseReasons;
    uint16 public runwayDays;
    uint64 public lastAccrueTime;
    uint64 public lastValuationTime;
    uint64 public lastCheckpointTime;
    uint256 public valuePerRef; // USD (18-dec) value of L_REF liquidity at the last valid TWAP
    uint256 public rewardIndex; // cumulative total (100%) reward USD per 1 USD of principal, scaled by ACC_PREC
    uint256 public totalLiquidity;
    uint256 public totalPrincipal; // sum of all users' principal (USD 18-dec)
    uint256 public totalBaseAccruedUsd; // upper bound of all rewards ever accrued (incl. unallocated referral parts)
    uint256 public totalPaidUsd;
    uint256 public totalPaidReward;
    uint256 public participants;

    // ------------------------------------------------------------------ owner-adjustable parameters (bounded)
    uint16 public dailyRateBps = 100; // 1% per day (bounds 0.01%..3%)
    uint16 public personalBps = 8500; // split of each day's total; sums to 10000
    uint16 public tier1Bps = 1000;
    uint16 public tier2Bps = 500;
    int24 public maxTickDeviation; // deposits refused while POP/USDT spot is further than this from its TWAP
    bool public claimPaused; // claims stopped, accrual continues
    bool public ended; // mining ended for good: no accrual, no deposits; claims and withdrawals still work
    uint128 public minPoolLiquidity;
    uint128 public minRewardPoolLiquidity;
    uint256 public dynamicThresholdUsd = 100e18; // principal needed for referral rewards

    // per-share cumulative indices (USD per 1 USD of principal, scaled by ACC_PREC), already split at accrual time
    uint256 public accPersonal;
    uint256 public accTier1;
    uint256 public accTier2;

    struct User {
        address referrer;
        bool joined;
        uint64 firstDepositAt;
        uint128 liquidity;
        uint256 principalUsd; // 入金额度: USD (18-dec) value booked at deposit, reduced in proportion on withdrawal
        uint256 tokenId;
        uint256 snapP; // accPersonal at last settlement
        uint256 snap1; // accTier1 at last settlement
        uint256 snap2; // accTier2 at last settlement
        uint256 personalUsd; // unpaid
        uint256 dynamicUsd; // unpaid
        uint256 paidPersonalUsd;
        uint256 paidDynamicUsd;
        uint256 claimedPersonalReward; // reward tokens actually received
        uint256 claimedDynamicReward;
        address up1;
        address up2;
        uint32 up1Mark; // lossLog length of up1 at assignment
        uint32 up2Mark;
        uint32 directCount;
        uint32 indirectCount;
    }

    mapping(address => User) internal users;
    /// tier indices at which an account lost dynamic eligibility through its own withdrawal
    struct Loss {
        uint256 a1;
        uint256 a2;
    }

    mapping(address => Loss[]) internal lossLog;

    bool private _inSwap;

    // ------------------------------------------------------------------ events
    event Bound(address indexed user, address indexed referrer);
    event Joined(address indexed user, address indexed referrer, address indexed referrer2, uint256 time);
    event Deposited(
        address indexed user,
        uint256 indexed tokenId,
        uint128 liquidity,
        uint256 usdtIn,
        uint256 popIn,
        uint256 usdtSwapped,
        uint256 popFromSwap,
        uint256 usdtRefund,
        uint256 popRefund
    );
    event Withdrawn(
        address indexed user,
        uint128 liquidity,
        uint256 popPrincipal,
        uint256 usdtPrincipal,
        uint256 popFees,
        uint256 usdtFees
    );
    event DynamicAccrued(address indexed upline, address indexed from, uint8 tier, uint256 usd);
    event PrincipalChanged(address indexed user, uint256 principalUsd);
    event Claimed(
        address indexed user,
        uint256 personalUsd,
        uint256 dynamicUsd,
        uint256 personalReward,
        uint256 dynamicReward,
        uint256 rewardPriceUsd
    );
    event Checkpoint(uint256 valuePerRef, uint256 rewardPriceUsd, uint8 reasons, bool running);
    event RunningChanged(bool running, uint8 reasons);
    event AdminPausedSet(bool paused);
    event RewardParamsSet(uint16 dailyRateBps, uint16 personalBps, uint16 tier1Bps, uint16 tier2Bps, uint256 thresholdUsd);
    event SafetyParamsSet(int24 maxTickDeviation, uint128 minPoolLiquidity, uint128 minRewardPoolLiquidity, uint16 runwayDays);
    event ClaimPausedSet(bool paused);
    event MiningEnded(uint256 time);

    // ------------------------------------------------------------------ errors
    error BadConfig(string what);
    error Expired();
    error NotRunning(uint8 reasons);
    error BadReferrer();
    error AlreadyBound();
    error ZeroAmount();
    error FeeOnTransfer();
    error Slippage();
    error NothingToClaim();
    error RewardPriceUnavailable();
    error TooMuchLiquidity();
    error PriceUnstable();
    error ClaimPaused();
    error Ended();

    struct Config {
        address pool;
        address npm;
        address pop;
        address usdt;
        address reward;
        address rewardPool;
        bool rewardPoolIsV2; // true: rewardPool is a PancakeSwap V2 pair created by v2Factory
        address v2Factory; // PancakeSwap V2 factory (only used when rewardPoolIsV2)
        address operator;
        uint32 twapWindow;
        int24 maxTickDeviation;
        uint128 minPoolLiquidity;
        uint128 minRewardPoolLiquidity;
        uint32 maxValuationAge;
        uint16 runwayDays;
        uint8 maxUplineSearch;
    }

    struct DepositParams {
        uint256 usdtAmount; // USDT pulled from user
        uint256 popAmount; // POP pulled from user (0 for USDT-only)
        uint256 swapUsdtAmount; // part of usdtAmount swapped to POP in the fixed pool
        uint256 minPopFromSwap;
        uint256 minUsdtUsed; // V3 add amount mins
        uint256 minPopUsed;
        address referrer; // used only if not yet bound and first deposit
        uint256 deadline;
    }

    constructor(Config memory c) Ownable(c.operator) {
        if (c.operator == address(0)) revert BadConfig("operator");
        for (uint256 i; i < 6; ++i) {
            address a = [c.pool, c.npm, c.pop, c.usdt, c.reward, c.rewardPool][i];
            if (a.code.length == 0) revert BadConfig("no code");
        }
        IPancakeV3Pool pool = IPancakeV3Pool(c.pool);
        address t0 = pool.token0();
        address t1 = pool.token1();
        if (!((t0 == c.pop && t1 == c.usdt) || (t0 == c.usdt && t1 == c.pop))) revert BadConfig("pool tokens");
        address factory = pool.factory();
        uint24 fee = pool.fee();
        if (IPancakeV3Factory(factory).getPool(t0, t1, fee) != c.pool) revert BadConfig("pool not from factory");
        if (INonfungiblePositionManager(c.npm).factory() != factory) revert BadConfig("npm factory");

        (address other, bool rewardIs0) = _checkRewardPool(c, factory);
        if (c.reward == c.pop || c.reward == c.usdt) revert BadConfig("reward token");

        uint8 ud = IERC20Metadata(c.usdt).decimals();
        uint8 rd = IERC20Metadata(c.reward).decimals();
        if (ud > 18 || rd > 36) revert BadConfig("decimals");
        if (c.twapWindow < 300 || c.twapWindow > 86400) revert BadConfig("twap window");
        if (c.maxTickDeviation <= 0 || c.maxTickDeviation > 2000) revert BadConfig("tick deviation");
        if (c.maxValuationAge < 600 || c.maxValuationAge > 86400) revert BadConfig("valuation age");
        if (c.maxUplineSearch < 2 || c.maxUplineSearch > 50) revert BadConfig("upline search");
        if (c.runwayDays < 1 || c.runwayDays > 30) revert BadConfig("runway");

        int24 spacing = pool.tickSpacing();
        int24 lower = (TickMath.MIN_TICK / spacing) * spacing;
        int24 upper = (TickMath.MAX_TICK / spacing) * spacing;

        POOL = pool;
        NPM = INonfungiblePositionManager(c.npm);
        POP = IERC20(c.pop);
        USDT = IERC20(c.usdt);
        REWARD = IERC20(c.reward);
        REWARD_POOL = c.rewardPool;
        REWARD_V2 = c.rewardPoolIsV2;
        REWARD_IS_TOKEN0 = rewardIs0;
        OPERATOR = c.operator;
        TOKEN0 = t0;
        TOKEN1 = t1;
        FEE = fee;
        TICK_LOWER = lower;
        TICK_UPPER = upper;
        SQRT_LOWER = TickMath.getSqrtRatioAtTick(lower);
        SQRT_UPPER = TickMath.getSqrtRatioAtTick(upper);
        REWARD_VIA_POP = other == c.pop;
        USDT_SCALE = 10 ** (18 - ud);
        REWARD_UNIT = 10 ** rd;
        TWAP_WINDOW = c.twapWindow;
        maxTickDeviation = c.maxTickDeviation;
        minPoolLiquidity = c.minPoolLiquidity;
        minRewardPoolLiquidity = c.minRewardPoolLiquidity;
        MAX_VALUATION_AGE = c.maxValuationAge;
        MAX_UPLINE_SEARCH = c.maxUplineSearch;
        runwayDays = c.runwayDays;
        lastAccrueTime = uint64(block.timestamp);
        pauseReasons = R_VALUATION_INVALID; // not running until the first successful checkpoint
    }

    /// Validates the reward price pool (V3 pool from the same factory, or V2 pair from the given V2 factory).
    function _checkRewardPool(Config memory c, address v3Factory) private view returns (address other, bool rewardIs0) {
        address r0;
        address r1;
        if (c.rewardPoolIsV2) {
            IPancakeV2Pair pair = IPancakeV2Pair(c.rewardPool);
            r0 = pair.token0();
            r1 = pair.token1();
            if (c.v2Factory.code.length == 0 || pair.factory() != c.v2Factory) revert BadConfig("v2 factory");
            if (IPancakeV2Factory(c.v2Factory).getPair(r0, r1) != c.rewardPool) revert BadConfig("v2 pair not from factory");
        } else {
            IPancakeV3Pool rp = IPancakeV3Pool(c.rewardPool);
            r0 = rp.token0();
            r1 = rp.token1();
            if (rp.factory() != v3Factory || IPancakeV3Factory(v3Factory).getPool(r0, r1, rp.fee()) != c.rewardPool) {
                revert BadConfig("reward pool not from factory");
            }
        }
        rewardIs0 = r0 == c.reward;
        other = rewardIs0 ? r1 : (r1 == c.reward ? r0 : address(0));
        if (other != c.usdt && other != c.pop) revert BadConfig("reward pool tokens");
    }

    // ================================================================== V2 reward-price oracle
    // A V2 pair only exposes a running price sum (priceCumulativeLast). The contract stores snapshots of it at
    // checkpoints (at most one per TWAP_WINDOW/6) in a small ring buffer. The reward price is the average between
    // now and the newest snapshot that is at least TWAP_WINDOW old (and at most 4 x TWAP_WINDOW old).

    uint256 private constant OBS_SLOTS = 24;

    struct Obs {
        uint64 t;
        uint256 cum;
    }

    Obs[24] internal rewardObs;
    uint8 public obsNext;
    uint8 public obsCount;

    /// counterfactual cumulative price (reward priced in the counter token, UQ112x112 * seconds) at block.timestamp
    function _v2Cumulative() internal view returns (uint256 cum) {
        IPancakeV2Pair pair = IPancakeV2Pair(REWARD_POOL);
        cum = REWARD_IS_TOKEN0 ? pair.price0CumulativeLast() : pair.price1CumulativeLast();
        (uint112 r0, uint112 r1, uint32 tLast) = pair.getReserves();
        uint32 nowTs = uint32(block.timestamp);
        if (tLast != nowTs && r0 > 0 && r1 > 0) {
            unchecked {
                uint256 p = REWARD_IS_TOKEN0 ? (uint256(r1) << 112) / r0 : (uint256(r0) << 112) / r1;
                cum += p * (nowTs - tLast); // overflow is desired (same as the pair's own accumulator)
            }
        }
    }

    function _recordRewardObs() internal {
        if (!REWARD_V2) return;
        uint256 n = obsCount;
        if (n > 0) {
            Obs storage last = rewardObs[(uint256(obsNext) + OBS_SLOTS - 1) % OBS_SLOTS];
            if (block.timestamp - last.t < TWAP_WINDOW / 6) return;
        }
        uint256 cum;
        try this.v2CumulativeView() returns (uint256 x) {
            cum = x;
        } catch {
            return; // pair unreadable: no snapshot, price stays unavailable
        }
        rewardObs[obsNext] = Obs({t: uint64(block.timestamp), cum: cum});
        obsNext = uint8((uint256(obsNext) + 1) % OBS_SLOTS);
        if (n < OBS_SLOTS) obsCount = uint8(n + 1);
    }

    function v2CumulativeView() external view returns (uint256) {
        return _v2Cumulative();
    }

    /// counter-token raw amount for one whole reward token: V2 TWAP and current spot (checks snapshot age, depth)
    function _v2RewardTwap() internal view returns (bool ok, uint256 twapRaw, uint256 spotRaw) {
        uint256 cumNow;
        try this.v2CumulativeView() returns (uint256 x) {
            cumNow = x;
        } catch {
            return (false, 0, 0);
        }
        uint256 n = obsCount;
        uint256 avg;
        bool found;
        for (uint256 i; i < n; ++i) {
            Obs storage o = rewardObs[(uint256(obsNext) + OBS_SLOTS - 1 - i) % OBS_SLOTS];
            uint256 age = block.timestamp - o.t;
            if (age >= TWAP_WINDOW) {
                if (age > 4 * uint256(TWAP_WINDOW)) return (false, 0, 0); // snapshots too old (keeper was offline)
                unchecked {
                    avg = (cumNow - o.cum) / age;
                }
                found = true;
                break;
            }
        }
        if (!found || avg == 0) return (false, 0, 0);
        twapRaw = Math.mulDiv(REWARD_UNIT, avg, 1 << 112);
        (uint112 r0, uint112 r1,) = IPancakeV2Pair(REWARD_POOL).getReserves();
        (uint256 rr, uint256 rc) = REWARD_IS_TOKEN0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        if (rr == 0 || rc < minRewardPoolLiquidity) return (false, 0, 0);
        spotRaw = Math.mulDiv(REWARD_UNIT, rc, rr);
        ok = twapRaw > 0 && spotRaw > 0;
    }

    // ================================================================== oracle helpers

    /// @notice TWAP tick of `pool` (ok=false on missing history or low liquidity) and its current spot tick.
    function _twapTick(IPancakeV3Pool pool, uint128 minLiq) internal view returns (bool ok, int24 tick, int24 spot) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        try pool.observe(ago) returns (int56[] memory cum, uint160[] memory) {
            int56 delta = cum[1] - cum[0];
            int56 w = int56(uint56(TWAP_WINDOW));
            int24 t = int24(delta / w);
            if (delta < 0 && (delta % w != 0)) t--;
            tick = t;
        } catch {
            return (false, 0, 0);
        }
        (, spot,,,,,) = pool.slot0();
        ok = pool.liquidity() >= minLiq;
    }

    function _near(int24 a, int24 b) internal view returns (bool) {
        int24 d = a > b ? a - b : b - a;
        return d <= maxTickDeviation;
    }

    /// @notice USD (18-dec) value of L_REF full-range liquidity at the POP/USDT TWAP (spot moves do not matter).
    function _valuation() internal view returns (bool ok, uint256 v) {
        int24 tick;
        (ok, tick,) = _twapTick(POOL, minPoolLiquidity);
        if (!ok) return (false, 0);
        (uint256 a0, uint256 a1) =
            V3Math.amountsForLiquidity(TickMath.getSqrtRatioAtTick(tick), SQRT_LOWER, SQRT_UPPER, uint128(L_REF));
        (uint256 popAmt, uint256 usdtAmt) = TOKEN0 == address(POP) ? (a0, a1) : (a1, a0);
        uint256 usdtRaw = usdtAmt + V3Math.quoteAtTick(tick, popAmt, address(POP), address(USDT));
        v = usdtRaw * USDT_SCALE;
        ok = v > 0;
    }

    /// @notice USD (18-dec) value of one whole reward token, from the TWAP and from the current spot price.
    /// `hi` = max(TWAP, spot) pays claims: dumping the price cannot buy extra tokens (the average is the floor) and a
    /// fast rise simply pays at the higher market price, so price swings never need to pause anything.
    /// `lo` = min(TWAP, spot) values the operator's reserve conservatively.
    function _rewardPrice() internal view returns (bool ok, uint256 hi, uint256 lo) {
        uint256 pt;
        uint256 ps;
        if (REWARD_V2) {
            (ok, pt, ps) = _v2RewardTwap();
        } else {
            int24 rt;
            int24 rs;
            (ok, rt, rs) = _twapTick(IPancakeV3Pool(REWARD_POOL), minRewardPoolLiquidity);
            address counter = REWARD_VIA_POP ? address(POP) : address(USDT);
            if (ok) {
                pt = V3Math.quoteAtTick(rt, REWARD_UNIT, address(REWARD), counter);
                ps = V3Math.quoteAtTick(rs, REWARD_UNIT, address(REWARD), counter);
            }
        }
        if (!ok) return (false, 0, 0);
        if (REWARD_VIA_POP) {
            (bool okP, int24 qt, int24 qs) = _twapTick(POOL, minPoolLiquidity);
            if (!okP) return (false, 0, 0);
            pt = V3Math.quoteAtTick(qt, pt, address(POP), address(USDT));
            ps = V3Math.quoteAtTick(qs, ps, address(POP), address(USDT));
        }
        pt *= USDT_SCALE;
        ps *= USDT_SCALE;
        (hi, lo) = pt > ps ? (pt, ps) : (ps, pt);
        ok = lo > 0;
    }

    function _reserve() internal view returns (uint256 bal, uint256 allow) {
        try REWARD.balanceOf(OPERATOR) returns (uint256 b) {
            bal = b;
        } catch {}
        try REWARD.allowance(OPERATOR, address(this)) returns (uint256 a) {
            allow = a;
        } catch {}
    }

    // ================================================================== accrual

    function _accrue() internal {
        uint256 t = block.timestamp;
        uint256 last = lastAccrueTime;
        if (t <= last) return;
        if (accruing && totalPrincipal > 0) {
            uint256 end = Math.min(t, uint256(lastCheckpointTime) + MAX_VALUATION_AGE);
            if (end > last) {
                uint256 dI = Math.mulDiv(end - last, ACC_PREC * dailyRateBps, BPS * 1 days);
                rewardIndex += dI;
                accPersonal += dI * personalBps / BPS;
                accTier1 += dI * tier1Bps / BPS;
                accTier2 += dI * tier2Bps / BPS;
                totalBaseAccruedUsd += Math.mulDiv(totalPrincipal, dI, ACC_PREC);
            }
        }
        lastAccrueTime = uint64(t);
    }

    /// @notice Permissionless keeper entry point: accrue, refresh TWAP valuation, re-evaluate running state.
    function checkpoint() external nonReentrant returns (bool running) {
        return _checkpoint();
    }

    function _checkpoint() internal returns (bool running) {
        _accrue();
        _recordRewardObs();
        uint8 reasons;
        (bool okV, uint256 v) = _valuation();
        if (okV) {
            valuePerRef = v;
            lastValuationTime = uint64(block.timestamp);
        } else {
            reasons |= R_VALUATION_INVALID;
        }
        (bool okR,, uint256 rp) = _rewardPrice(); // conservative (lower) price for reserve coverage
        if (!okR) reasons |= R_REWARD_PRICE_INVALID;
        if (adminPaused) reasons |= R_ADMIN_PAUSED;
        if (ended) reasons |= R_ENDED;
        if (okR && !_coverageOk(rp)) reasons |= R_RESERVE_LOW;

        // the POP/USDT valuation is only needed to book the principal of new deposits: it does not stop accrual
        running = (reasons & ~R_VALUATION_INVALID) == 0;
        if (running != accruing) emit RunningChanged(running, reasons);
        accruing = running;
        pauseReasons = reasons;
        lastCheckpointTime = uint64(block.timestamp);
        emit Checkpoint(okV ? v : valuePerRef, rp, reasons, running);
    }

    /// reserve (min(balance, allowance)) valued at TWAP must cover outstanding liability + runway of emissions
    function _coverageOk(uint256 rewardPriceUsd) internal view returns (bool) {
        (uint256 bal, uint256 allow) = _reserve();
        uint256 reserveTokens = Math.min(bal, allow);
        uint256 reserveUsd = Math.mulDiv(reserveTokens, rewardPriceUsd, REWARD_UNIT);
        uint256 liability = _liability();
        uint256 dailyEmission = totalPrincipal * dailyRateBps / BPS;
        // Require at least a minimal non-zero reserve even with zero TVL, so "balance > 0" alone never suffices
        // in a meaningful way: need = liability + runway * max(dailyEmission, emission of 100 USD TVL).
        uint256 minDaily = 100e18 * uint256(dailyRateBps) / BPS;
        uint256 need = liability + uint256(runwayDays) * Math.max(dailyEmission, minDaily);
        return reserveUsd >= need;
    }

    // ================================================================== referral helpers

    function _eligible(address a) internal view returns (bool) {
        if (a == address(0)) return false;
        return users[a].principalUsd * BPS >= dynamicThresholdUsd * (BPS - ELIG_TOL_BPS);
    }

    /// Settle `u` up to the current indices. Assumes _accrue() already ran in this tx.
    /// Dynamic shares for the interval go to the uplines assigned at the previous settlement, cut off at the
    /// first own-withdrawal eligibility loss of that upline. Then uplines are re-assigned for the next interval.
    function _settle(address u) internal {
        User storage s = users[u];
        uint256 pr = s.principalUsd;
        if (pr > 0) {
            s.personalUsd += Math.mulDiv(pr, accPersonal - s.snapP, ACC_PREC);
            _payUp(s.up1, s.up1Mark, s.snap1, accTier1, pr, u, 1);
            _payUp(s.up2, s.up2Mark, s.snap2, accTier2, pr, u, 2);
        }
        s.snapP = accPersonal;
        s.snap1 = accTier1;
        s.snap2 = accTier2;
        _assignUplines(s);
    }

    function _payUp(address up, uint32 mark, uint256 from, uint256 to, uint256 base, address src, uint8 tier) internal {
        if (up == address(0)) return;
        Loss[] storage log = lossLog[up];
        if (log.length > mark) {
            uint256 lostAt = tier == 1 ? log[mark].a1 : log[mark].a2;
            if (lostAt < to) to = lostAt;
        }
        if (to <= from) return;
        uint256 amt = Math.mulDiv(base, to - from, ACC_PREC);
        if (amt == 0) return;
        users[up].dynamicUsd += amt;
        emit DynamicAccrued(up, src, tier, amt);
    }

    /// Walk up the true referral chain (bounded by MAX_UPLINE_SEARCH hops) and pick the first two eligible.
    function _assignUplines(User storage s) internal {
        address a1;
        address a2;
        address cur = s.referrer;
        for (uint256 i; i < MAX_UPLINE_SEARCH && cur != address(0); ++i) {
            if (_eligible(cur)) {
                if (a1 == address(0)) {
                    a1 = cur;
                } else {
                    a2 = cur;
                    break;
                }
            }
            cur = users[cur].referrer;
        }
        s.up1 = a1;
        s.up2 = a2;
        s.up1Mark = a1 == address(0) ? 0 : uint32(lossLog[a1].length);
        s.up2Mark = a2 == address(0) ? 0 : uint32(lossLog[a2].length);
    }

    // ================================================================== user actions

    /// @notice Bind a referrer before the first deposit (no transfer needed). Immutable afterwards.
    function bind(address referrer) external {
        _bind(msg.sender, referrer);
    }

    function _bind(address u, address r) internal {
        User storage s = users[u];
        if (s.referrer != address(0) || s.joined) revert AlreadyBound();
        // a referrer must be a wallet that has already deposited: this makes cycles impossible
        if (r == address(0) || r == u || !users[r].joined) revert BadReferrer();
        s.referrer = r;
        emit Bound(u, r);
    }

    function _pull(IERC20 t, address from, uint256 amount) internal {
        if (amount == 0) return;
        uint256 b = t.balanceOf(address(this));
        t.safeTransferFrom(from, address(this), amount);
        if (t.balanceOf(address(this)) - b != amount) revert FeeOnTransfer();
    }

    function deposit(DepositParams calldata p) external nonReentrant returns (uint128 liquidityAdded) {
        if (block.timestamp > p.deadline) revert Expired();
        if (p.usdtAmount == 0 && p.popAmount == 0) revert ZeroAmount();
        if (p.swapUsdtAmount > p.usdtAmount) revert ZeroAmount();
        // running, and the POP/USDT average price was readable in this very checkpoint (it values the principal)
        if (!_checkpoint() || lastValuationTime != block.timestamp) revert NotRunning(pauseReasons);
        // deposits trade at the spot price: refuse while the POP/USDT spot is pushed away from its average
        {
            (bool okP, int24 tw, int24 sp) = _twapTick(POOL, minPoolLiquidity);
            if (!okP || !_near(tw, sp)) revert PriceUnstable();
        }

        address u = msg.sender;
        User storage s = users[u];
        if (!s.joined && s.referrer == address(0) && p.referrer != address(0)) _bind(u, p.referrer);

        _pull(USDT, u, p.usdtAmount);
        _pull(POP, u, p.popAmount);

        DepositTmp memory t;
        t.usdtAvail = p.usdtAmount;
        t.popAvail = p.popAmount;
        if (p.swapUsdtAmount > 0) {
            t.popFromSwap = _swapUsdtForPop(p.swapUsdtAmount);
            if (t.popFromSwap < p.minPopFromSwap) revert Slippage();
            t.usdtAvail -= p.swapUsdtAmount;
            t.popAvail += t.popFromSwap;
        }

        _settle(u); // settle with the old liquidity before changing it

        uint256 popUsed;
        uint256 usdtUsed;
        (liquidityAdded, popUsed, usdtUsed) = _addLiquidity(s, t.popAvail, t.usdtAvail, p);
        t.usdtRefund = t.usdtAvail - usdtUsed;
        t.popRefund = t.popAvail - popUsed;

        if (uint256(s.liquidity) + liquidityAdded > type(uint128).max) revert TooMuchLiquidity();
        s.liquidity += liquidityAdded;
        totalLiquidity += liquidityAdded;
        uint256 added = Math.mulDiv(liquidityAdded, valuePerRef, L_REF); // value at the TWAP, fixed from now on
        s.principalUsd += added;
        totalPrincipal += added;
        emit PrincipalChanged(u, s.principalUsd);
        if (!s.joined) _join(u, s);

        if (t.usdtRefund > 0) USDT.safeTransfer(u, t.usdtRefund);
        if (t.popRefund > 0) POP.safeTransfer(u, t.popRefund);

        emit Deposited(
            u,
            s.tokenId,
            liquidityAdded,
            p.usdtAmount,
            p.popAmount,
            p.swapUsdtAmount,
            t.popFromSwap,
            t.usdtRefund,
            t.popRefund
        );
    }

    struct DepositTmp {
        uint256 usdtAvail;
        uint256 popAvail;
        uint256 popFromSwap;
        uint256 usdtRefund;
        uint256 popRefund;
    }

    function _addLiquidity(User storage s, uint256 popAvail, uint256 usdtAvail, DepositParams calldata p)
        internal
        returns (uint128 liq, uint256 popUsed, uint256 usdtUsed)
    {
        bool popIs0 = TOKEN0 == address(POP);
        POP.forceApprove(address(NPM), popAvail);
        USDT.forceApprove(address(NPM), usdtAvail);
        uint256 used0;
        uint256 used1;
        if (s.tokenId == 0) {
            uint256 tokenId;
            (tokenId, liq, used0, used1) = NPM.mint(
                INonfungiblePositionManager.MintParams({
                    token0: TOKEN0,
                    token1: TOKEN1,
                    fee: FEE,
                    tickLower: TICK_LOWER,
                    tickUpper: TICK_UPPER,
                    amount0Desired: popIs0 ? popAvail : usdtAvail,
                    amount1Desired: popIs0 ? usdtAvail : popAvail,
                    amount0Min: popIs0 ? p.minPopUsed : p.minUsdtUsed,
                    amount1Min: popIs0 ? p.minUsdtUsed : p.minPopUsed,
                    recipient: address(this),
                    deadline: p.deadline
                })
            );
            s.tokenId = tokenId;
        } else {
            (liq, used0, used1) = NPM.increaseLiquidity(
                INonfungiblePositionManager.IncreaseLiquidityParams({
                    tokenId: s.tokenId,
                    amount0Desired: popIs0 ? popAvail : usdtAvail,
                    amount1Desired: popIs0 ? usdtAvail : popAvail,
                    amount0Min: popIs0 ? p.minPopUsed : p.minUsdtUsed,
                    amount1Min: popIs0 ? p.minUsdtUsed : p.minPopUsed,
                    deadline: p.deadline
                })
            );
        }
        POP.forceApprove(address(NPM), 0);
        USDT.forceApprove(address(NPM), 0);
        if (liq == 0) revert ZeroAmount();
        (popUsed, usdtUsed) = popIs0 ? (used0, used1) : (used1, used0);
    }

    function _join(address u, User storage s) internal {
        s.joined = true;
        s.firstDepositAt = uint64(block.timestamp);
        participants++;
        address r = s.referrer;
        address r2;
        if (r != address(0)) {
            users[r].directCount++;
            r2 = users[r].referrer;
            if (r2 != address(0)) users[r2].indirectCount++;
        }
        emit Joined(u, r, r2, block.timestamp);
    }

    function _swapUsdtForPop(uint256 usdtIn) internal returns (uint256 popOut) {
        bool zeroForOne = TOKEN0 == address(USDT);
        _inSwap = true;
        (int256 a0, int256 a1) = POOL.swap(
            address(this),
            zeroForOne,
            int256(usdtIn),
            zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
            ""
        );
        _inSwap = false;
        int256 out = zeroForOne ? a1 : a0;
        int256 paid = zeroForOne ? a0 : a1;
        require(out < 0 && paid <= int256(usdtIn), "swap");
        popOut = uint256(-out);
        // a partial fill (price limit) would leave USDT un-swapped; the refund logic returns it, but require full fill
        if (uint256(paid) != usdtIn) revert Slippage();
    }

    function _swapCallback(int256 a0, int256 a1) internal {
        require(msg.sender == address(POOL) && _inSwap, "cb");
        if (a0 > 0) IERC20(TOKEN0).safeTransfer(msg.sender, uint256(a0));
        if (a1 > 0) IERC20(TOKEN1).safeTransfer(msg.sender, uint256(a1));
    }

    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _swapCallback(a0, a1);
    }

    /// Uniswap-V3-compatible callback name (used by local test pools built from Uniswap V3 sources).
    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _swapCallback(a0, a1);
    }

    /// @notice Remove `liquidity` from the caller's position. Always returns POP + USDT principal plus all of the
    /// position's accrued trading fees. Works while paused, without oracle, and regardless of reward reserves.
    function withdraw(uint128 liquidity, uint256 minPop, uint256 minUsdt, uint256 deadline)
        external
        nonReentrant
        returns (uint256 popOut, uint256 usdtOut)
    {
        if (block.timestamp > deadline) revert Expired();
        address u = msg.sender;
        User storage s = users[u];
        if (liquidity == 0 || liquidity > s.liquidity) revert ZeroAmount();

        _accrue(); // pure arithmetic: no oracle / reserve dependency
        _settle(u);

        uint256 cut = liquidity == s.liquidity ? s.principalUsd : Math.mulDiv(s.principalUsd, liquidity, s.liquidity);
        s.principalUsd -= cut;
        totalPrincipal -= cut;
        s.liquidity -= liquidity;
        totalLiquidity -= liquidity;
        emit PrincipalChanged(u, s.principalUsd);
        if (!_eligible(u)) lossLog[u].push(Loss(accTier1, accTier2));

        (popOut, usdtOut) = _removeLiquidity(u, s.tokenId, liquidity, minPop, minUsdt, deadline);
    }

    function _removeLiquidity(address u, uint256 tokenId, uint128 liquidity, uint256 minPop, uint256 minUsdt, uint256 deadline)
        internal
        returns (uint256 popOut, uint256 usdtOut)
    {
        (uint256 popP, uint256 usdtP) = _decrease(tokenId, liquidity, minPop, minUsdt, deadline);
        (popOut, usdtOut) = _collectTo(u, tokenId);
        emit Withdrawn(u, liquidity, popP, usdtP, popOut - popP, usdtOut - usdtP);
    }

    function _decrease(uint256 tokenId, uint128 liquidity, uint256 minPop, uint256 minUsdt, uint256 deadline)
        internal
        returns (uint256 popP, uint256 usdtP)
    {
        bool popIs0 = TOKEN0 == address(POP);
        (uint256 p0, uint256 p1) = NPM.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidity,
                amount0Min: popIs0 ? minPop : minUsdt,
                amount1Min: popIs0 ? minUsdt : minPop,
                deadline: deadline
            })
        );
        (popP, usdtP) = popIs0 ? (p0, p1) : (p1, p0);
    }

    /// collects principal + all accrued fees of the user's own position straight to the user
    function _collectTo(address u, uint256 tokenId) internal returns (uint256 popOut, uint256 usdtOut) {
        (uint256 c0, uint256 c1) = NPM.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: u,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        (popOut, usdtOut) = TOKEN0 == address(POP) ? (c0, c1) : (c1, c0);
    }

    /// @notice Claim all unpaid personal + dynamic rewards, converted at the reward-token TWAP, paid by
    /// transferFrom(OPERATOR -> user). Reverts (keeping rewards intact) if the transfer fails or is taxed.
    function claim(uint256 minRewardOut) external nonReentrant returns (uint256 amount) {
        if (claimPaused) revert ClaimPaused();
        address u = msg.sender;
        _checkpoint();
        _settle(u);
        User storage s = users[u];
        uint256 pUsd = s.personalUsd;
        uint256 dUsd = s.dynamicUsd;
        if (pUsd + dUsd == 0) revert NothingToClaim();
        (bool ok, uint256 price,) = _rewardPrice(); // claims pay at the higher of TWAP and spot
        if (!ok) revert RewardPriceUnavailable();
        uint256 pAmt = Math.mulDiv(pUsd, REWARD_UNIT, price);
        uint256 dAmt = Math.mulDiv(dUsd, REWARD_UNIT, price);
        amount = pAmt + dAmt;
        if (amount == 0 || amount < minRewardOut) revert Slippage();

        s.personalUsd = 0;
        s.dynamicUsd = 0;
        s.paidPersonalUsd += pUsd;
        s.paidDynamicUsd += dUsd;
        s.claimedPersonalReward += pAmt;
        s.claimedDynamicReward += dAmt;
        totalPaidUsd += pUsd + dUsd;
        totalPaidReward += amount;

        uint256 b = REWARD.balanceOf(u);
        REWARD.safeTransferFrom(OPERATOR, u, amount);
        if (REWARD.balanceOf(u) - b != amount) revert FeeOnTransfer();
        emit Claimed(u, pUsd, dUsd, pAmt, dAmt, price);
    }

    /// @notice Permissionless batch settlement (keeper): refreshes referral assignments of many users.
    /// Caller controls the batch size, so gas is bounded by the caller.
    function settleMany(address[] calldata list) external nonReentrant {
        _accrue();
        for (uint256 i; i < list.length; ++i) {
            if (users[list[i]].joined) _settle(list[i]);
        }
    }

    // ================================================================== admin (bounded)

    /// @notice Pause / resume new deposits and new accrual. Never affects withdraw(). Resume only takes effect if
    /// the checkpoint checks (valuation, reward price, reserve coverage) pass.
    function setAdminPaused(bool paused) external onlyOwner nonReentrant {
        if (!paused && ended) revert Ended();
        adminPaused = paused;
        emit AdminPausedSet(paused);
        _checkpoint();
    }

    /// @notice Daily rate (bps of principal per day), personal / tier-1 / tier-2 split (bps, sum 10000) and the
    /// principal needed for referral rewards. Everything accrued so far is booked under the old values first.
    function setRewardParams(uint16 rateBps, uint16 pBps, uint16 t1Bps, uint16 t2Bps, uint256 thresholdUsd)
        external
        onlyOwner
        nonReentrant
    {
        if (rateBps < 1 || rateBps > 300) revert BadConfig("rate");
        if (uint256(pBps) + t1Bps + t2Bps != BPS) revert BadConfig("split");
        if (thresholdUsd < 1e18 || thresholdUsd > 1_000_000e18) revert BadConfig("threshold");
        _accrue();
        dailyRateBps = rateBps;
        personalBps = pBps;
        tier1Bps = t1Bps;
        tier2Bps = t2Bps;
        dynamicThresholdUsd = thresholdUsd;
        emit RewardParamsSet(rateBps, pBps, t1Bps, t2Bps, thresholdUsd);
        _checkpoint();
    }

    /// @notice Deposit price-deviation guard (ticks / bps), minimum pool depths, reserve runway days.
    function setSafetyParams(int24 maxDev, uint128 minLiq, uint128 minRewardLiq, uint16 runway) external onlyOwner nonReentrant {
        if (maxDev <= 0 || maxDev > 2000) revert BadConfig("tick deviation");
        if (runway < 1 || runway > 30) revert BadConfig("runway");
        _accrue();
        maxTickDeviation = maxDev;
        minPoolLiquidity = minLiq;
        minRewardPoolLiquidity = minRewardLiq;
        runwayDays = runway;
        emit SafetyParamsSet(maxDev, minLiq, minRewardLiq, runway);
        _checkpoint();
    }

    /// @notice Stop / resume claims (accrual continues while claims are paused).
    function setClaimPaused(bool paused) external onlyOwner {
        claimPaused = paused;
        emit ClaimPausedSet(paused);
    }

    /// @notice End mining for good: accrual stops now and can never restart; deposits are closed. Users keep all
    /// accrued rewards (claimable unless claims are paused) and can always withdraw their principal.
    function endMining() external onlyOwner nonReentrant {
        if (ended) revert Ended();
        _accrue();
        ended = true;
        adminPaused = true;
        emit MiningEnded(block.timestamp);
        _checkpoint();
    }

    // ================================================================== views

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(msg.sender == address(NPM), "nft");
        return this.onERC721Received.selector;
    }

    /// total index increase that _accrue() would add right now (no state change)
    function _pendingDI() internal view returns (uint256 dI) {
        uint256 last = lastAccrueTime;
        if (accruing && totalPrincipal > 0) {
            uint256 end = Math.min(block.timestamp, uint256(lastCheckpointTime) + MAX_VALUATION_AGE);
            if (end > last) dI = Math.mulDiv(end - last, ACC_PREC * dailyRateBps, BPS * 1 days);
        }
    }

    /// Unpaid personal / dynamic USD incl. the caller's own unsettled personal part. Unsettled dynamic shares from
    /// downlines appear after those downlines are settled (any of their actions, or the keeper's settleMany).
    function pendingUsd(address u) external view returns (uint256 personal, uint256 dynamic_) {
        User storage s = users[u];
        personal = s.personalUsd;
        dynamic_ = s.dynamicUsd;
        if (s.principalUsd > 0) {
            uint256 idx = accPersonal + _pendingDI() * personalBps / BPS;
            personal += Math.mulDiv(s.principalUsd, idx - s.snapP, ACC_PREC);
        }
    }

    function valueUsd(address u) external view returns (uint256) {
        return Math.mulDiv(users[u].liquidity, valuePerRef, L_REF);
    }

    function isEligible(address u) external view returns (bool) {
        return _eligible(u);
    }

    /// price used for claims right now (max of TWAP and spot)
    function rewardPriceView() external view returns (bool ok, uint256 price) {
        (ok, price,) = _rewardPrice();
    }

    function reserveView()
        external
        view
        returns (uint256 balance, uint256 allowance_, uint256 usable, uint256 liabilityUsd)
    {
        (balance, allowance_) = _reserve();
        usable = Math.min(balance, allowance_);
        liabilityUsd = _liability();
    }

    /// Upper bound of accrued-but-unpaid rewards (USD 18-dec). Saturating to avoid rounding underflow.
    function _liability() internal view returns (uint256) {
        uint256 b = totalBaseAccruedUsd;
        uint256 p = totalPaidUsd;
        return b > p ? b - p : 0;
    }

    function getUser(address u) external view returns (User memory) {
        return users[u];
    }
}
