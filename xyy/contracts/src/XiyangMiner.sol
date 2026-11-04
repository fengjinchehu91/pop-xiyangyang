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
import {IPancakeV3Pool, IPancakeV3Factory, INonfungiblePositionManager} from "./interfaces/IPancakeV3.sol";

/// @title 喜羊羊矿场 (XiyangMiner)
/// @notice Custodies one full-range PancakeSwap V3 position NFT per user in a single fixed POP/USDT pool,
/// accrues USDT-denominated rewards (1%/day of the position's TWAP reference value, 85/10/5 split),
/// and pays rewards in the reward token via transferFrom from the operator wallet (allowance model).
///
/// Key properties:
/// - Principal never touches the operator wallet; withdraw() needs no oracle, no reserve, and ignores pauses.
/// - No arbitrary external calls: only the fixed pool / position manager / three fixed tokens are called.
/// - Owner can only pause/resume new deposits+accrual and set the reserve runway within fixed bounds.
/// - Rewards accrue piecewise-constant on the latest checkpoint valuation; accrual stops automatically when
///   the valuation is older than maxValuationAge, when reserve coverage fails, or when paused. No back-pay.
contract XiyangMiner is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants
    uint256 public constant L_REF = 1e27; // reference liquidity unit for valuePerRef
    uint256 public constant ACC_PREC = 1e18; // index precision
    uint256 private constant LREF_ACC = L_REF * ACC_PREC;
    uint256 public constant DAILY_RATE_DIV = 100; // 1% per day
    uint256 public constant DYNAMIC_THRESHOLD_USD = 100e18; // 100 USDT (18-dec internal units)
    uint256 public constant PERSONAL_PCT = 85;
    uint256 public constant TIER1_PCT = 10;
    uint256 public constant TIER2_PCT = 5;

    // reasons bitmask for "not running"
    uint8 public constant R_ADMIN_PAUSED = 1;
    uint8 public constant R_VALUATION_INVALID = 2;
    uint8 public constant R_REWARD_PRICE_INVALID = 4;
    uint8 public constant R_RESERVE_LOW = 8;

    // ------------------------------------------------------------------ immutables
    IPancakeV3Pool public immutable POOL; // POP/USDT
    INonfungiblePositionManager public immutable NPM;
    IERC20 public immutable POP;
    IERC20 public immutable USDT;
    IERC20 public immutable REWARD; // 喜羊羊
    IPancakeV3Pool public immutable REWARD_POOL; // REWARD/USDT or REWARD/POP
    address public immutable OPERATOR; // reward source wallet
    address public immutable TOKEN0;
    address public immutable TOKEN1;
    uint24 public immutable FEE;
    int24 public immutable TICK_LOWER;
    int24 public immutable TICK_UPPER;
    uint160 private immutable SQRT_LOWER;
    uint160 private immutable SQRT_UPPER;
    bool public immutable REWARD_VIA_POP; // reward pool is REWARD/POP (two-hop to USDT)
    uint256 private immutable USDT_SCALE; // 10**(18 - usdtDecimals)
    uint256 private immutable REWARD_UNIT; // 10**rewardDecimals
    uint32 public immutable TWAP_WINDOW;
    int24 public immutable MAX_TICK_DEVIATION;
    uint128 public immutable MIN_POOL_LIQUIDITY;
    uint128 public immutable MIN_REWARD_POOL_LIQUIDITY;
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
    uint256 public rewardIndex; // cumulative total (100%) reward USD per L_REF, scaled by ACC_PREC
    uint256 public totalLiquidity;
    uint256 public totalBaseAccruedUsd; // upper bound of all rewards ever accrued (incl. unallocated referral parts)
    uint256 public totalPaidUsd;
    uint256 public totalPaidReward;
    uint256 public participants;

    struct User {
        address referrer;
        bool joined;
        uint64 firstDepositAt;
        uint128 liquidity;
        uint256 tokenId;
        uint256 indexSnapshot;
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
    /// rewardIndex values at which an account lost dynamic eligibility through its own withdrawal
    mapping(address => uint256[]) internal lossLog;

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
    event PersonalAccrued(address indexed user, uint256 usd);
    event DynamicAccrued(address indexed upline, address indexed from, uint8 tier, uint256 usd);
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
    event RunwayDaysSet(uint16 days_);

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

    struct Config {
        address pool;
        address npm;
        address pop;
        address usdt;
        address reward;
        address rewardPool;
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

        IPancakeV3Pool rp = IPancakeV3Pool(c.rewardPool);
        address r0 = rp.token0();
        address r1 = rp.token1();
        address other = r0 == c.reward ? r1 : (r1 == c.reward ? r0 : address(0));
        if (other != c.usdt && other != c.pop) revert BadConfig("reward pool tokens");
        if (rp.factory() != factory || IPancakeV3Factory(factory).getPool(r0, r1, rp.fee()) != c.rewardPool) {
            revert BadConfig("reward pool not from factory");
        }
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
        REWARD_POOL = rp;
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
        MAX_TICK_DEVIATION = c.maxTickDeviation;
        MIN_POOL_LIQUIDITY = c.minPoolLiquidity;
        MIN_REWARD_POOL_LIQUIDITY = c.minRewardPoolLiquidity;
        MAX_VALUATION_AGE = c.maxValuationAge;
        MAX_UPLINE_SEARCH = c.maxUplineSearch;
        runwayDays = c.runwayDays;
        lastAccrueTime = uint64(block.timestamp);
        pauseReasons = R_VALUATION_INVALID; // not running until the first successful checkpoint
    }

    // ================================================================== oracle helpers

    /// @notice TWAP tick of `pool`, failing (ok=false) on missing history, low liquidity or spot/TWAP deviation.
    function _twapTick(IPancakeV3Pool pool, uint128 minLiq) internal view returns (bool ok, int24 tick) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        try pool.observe(ago) returns (int56[] memory cum, uint160[] memory) {
            int56 delta = cum[1] - cum[0];
            int56 w = int56(uint56(TWAP_WINDOW));
            int24 t = int24(delta / w);
            if (delta < 0 && (delta % w != 0)) t--;
            tick = t;
        } catch {
            return (false, 0);
        }
        (, int24 spot,,,,,) = pool.slot0();
        int24 diff = spot > tick ? spot - tick : tick - spot;
        if (diff > MAX_TICK_DEVIATION) return (false, tick);
        if (pool.liquidity() < minLiq) return (false, tick);
        return (true, tick);
    }

    /// @notice USD (18-dec) value of L_REF full-range liquidity at the POP/USDT TWAP.
    function _valuation() internal view returns (bool ok, uint256 v) {
        int24 tick;
        (ok, tick) = _twapTick(POOL, MIN_POOL_LIQUIDITY);
        if (!ok) return (false, 0);
        (uint256 a0, uint256 a1) =
            V3Math.amountsForLiquidity(TickMath.getSqrtRatioAtTick(tick), SQRT_LOWER, SQRT_UPPER, uint128(L_REF));
        (uint256 popAmt, uint256 usdtAmt) = TOKEN0 == address(POP) ? (a0, a1) : (a1, a0);
        uint256 usdtRaw = usdtAmt + V3Math.quoteAtTick(tick, popAmt, address(POP), address(USDT));
        v = usdtRaw * USDT_SCALE;
        ok = v > 0;
    }

    /// @notice USD (18-dec) value of one whole reward token at TWAP (direct or via POP).
    function _rewardPrice() internal view returns (bool ok, uint256 price) {
        int24 rt;
        (ok, rt) = _twapTick(REWARD_POOL, MIN_REWARD_POOL_LIQUIDITY);
        if (!ok) return (false, 0);
        if (!REWARD_VIA_POP) {
            price = V3Math.quoteAtTick(rt, REWARD_UNIT, address(REWARD), address(USDT)) * USDT_SCALE;
        } else {
            int24 pt;
            (ok, pt) = _twapTick(POOL, MIN_POOL_LIQUIDITY);
            if (!ok) return (false, 0);
            uint256 popOut = V3Math.quoteAtTick(rt, REWARD_UNIT, address(REWARD), address(POP));
            price = V3Math.quoteAtTick(pt, popOut, address(POP), address(USDT)) * USDT_SCALE;
        }
        ok = price > 0;
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
        if (accruing && valuePerRef > 0 && totalLiquidity > 0) {
            uint256 end = Math.min(t, uint256(lastValuationTime) + MAX_VALUATION_AGE);
            if (end > last) {
                uint256 dI = Math.mulDiv(valuePerRef * (end - last), ACC_PREC, DAILY_RATE_DIV * 1 days);
                rewardIndex += dI;
                totalBaseAccruedUsd += Math.mulDiv(totalLiquidity, dI, LREF_ACC);
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
        uint8 reasons;
        (bool okV, uint256 v) = _valuation();
        if (okV) {
            valuePerRef = v;
            lastValuationTime = uint64(block.timestamp);
        } else {
            reasons |= R_VALUATION_INVALID;
        }
        (bool okR, uint256 rp) = _rewardPrice();
        if (!okR) reasons |= R_REWARD_PRICE_INVALID;
        if (adminPaused) reasons |= R_ADMIN_PAUSED;
        if (okV && okR && !_coverageOk(v, rp)) reasons |= R_RESERVE_LOW;

        running = reasons == 0;
        if (running != accruing) emit RunningChanged(running, reasons);
        accruing = running;
        pauseReasons = reasons;
        lastCheckpointTime = uint64(block.timestamp);
        emit Checkpoint(okV ? v : valuePerRef, rp, reasons, running);
    }

    /// reserve (min(balance, allowance)) valued at TWAP must cover outstanding liability + runway of emissions
    function _coverageOk(uint256 v, uint256 rewardPriceUsd) internal view returns (bool) {
        (uint256 bal, uint256 allow) = _reserve();
        uint256 reserveTokens = Math.min(bal, allow);
        uint256 reserveUsd = Math.mulDiv(reserveTokens, rewardPriceUsd, REWARD_UNIT);
        uint256 liability = _liability();
        uint256 dailyEmission = Math.mulDiv(totalLiquidity, v, L_REF) / DAILY_RATE_DIV;
        // Require at least a minimal non-zero reserve even with zero TVL, so "balance > 0" alone never suffices
        // in a meaningful way: need = liability + runway * max(dailyEmission, emission of 100 USD TVL).
        uint256 minDaily = DYNAMIC_THRESHOLD_USD / DAILY_RATE_DIV;
        uint256 need = liability + uint256(runwayDays) * Math.max(dailyEmission, minDaily);
        return reserveUsd >= need;
    }

    // ================================================================== referral helpers

    function _eligible(address a) internal view returns (bool) {
        if (a == address(0)) return false;
        uint256 v = valuePerRef;
        if (v == 0) return false;
        return Math.mulDiv(users[a].liquidity, v, L_REF) >= DYNAMIC_THRESHOLD_USD;
    }

    /// Settle `u` up to the current rewardIndex. Assumes _accrue() already ran in this tx.
    /// Dynamic shares for the interval go to the uplines assigned at the previous settlement, cut off at the
    /// first own-withdrawal eligibility loss of that upline. Then uplines are re-assigned for the next interval.
    function _settle(address u) internal {
        User storage s = users[u];
        uint256 idx = rewardIndex;
        uint256 last = s.indexSnapshot;
        if (idx > last && s.liquidity > 0) {
            uint256 base = Math.mulDiv(s.liquidity, idx - last, LREF_ACC);
            uint256 personal = base * PERSONAL_PCT / 100;
            if (personal > 0) {
                s.personalUsd += personal;
                emit PersonalAccrued(u, personal);
            }
            _payUp(s.up1, s.up1Mark, last, idx, s.liquidity, TIER1_PCT, u, 1);
            _payUp(s.up2, s.up2Mark, last, idx, s.liquidity, TIER2_PCT, u, 2);
        }
        s.indexSnapshot = idx;
        _assignUplines(s);
    }

    function _payUp(address up, uint32 mark, uint256 from, uint256 to, uint128 liq, uint256 pct, address src, uint8 tier)
        internal
    {
        if (up == address(0)) return;
        uint256[] storage log = lossLog[up];
        if (log.length > mark) {
            uint256 lostAt = log[mark];
            if (lostAt < to) to = lostAt;
        }
        if (to <= from) return;
        uint256 amt = Math.mulDiv(liq, to - from, LREF_ACC) * pct / 100;
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
        if (!_checkpoint()) revert NotRunning(pauseReasons);

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

        s.liquidity -= liquidity;
        totalLiquidity -= liquidity;
        if (!_eligible(u)) lossLog[u].push(rewardIndex);

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
        address u = msg.sender;
        _checkpoint();
        _settle(u);
        User storage s = users[u];
        uint256 pUsd = s.personalUsd;
        uint256 dUsd = s.dynamicUsd;
        if (pUsd + dUsd == 0) revert NothingToClaim();
        (bool ok, uint256 price) = _rewardPrice();
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
        adminPaused = paused;
        emit AdminPausedSet(paused);
        _checkpoint();
    }

    function setRunwayDays(uint16 d) external onlyOwner nonReentrant {
        if (d < 1 || d > 30) revert BadConfig("runway");
        runwayDays = d;
        emit RunwayDaysSet(d);
        _checkpoint();
    }

    // ================================================================== views

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(msg.sender == address(NPM), "nft");
        return this.onERC721Received.selector;
    }

    /// Index as it would be after _accrue() now (no state change).
    function currentIndex() public view returns (uint256 idx) {
        idx = rewardIndex;
        uint256 last = lastAccrueTime;
        if (accruing && valuePerRef > 0 && totalLiquidity > 0) {
            uint256 end = Math.min(block.timestamp, uint256(lastValuationTime) + MAX_VALUATION_AGE);
            if (end > last) idx += Math.mulDiv(valuePerRef * (end - last), ACC_PREC, DAILY_RATE_DIV * 1 days);
        }
    }

    /// Unpaid personal / dynamic USD incl. the caller's own unsettled personal part. Unsettled dynamic shares from
    /// downlines appear after those downlines are settled (any of their actions, or the keeper's settleMany).
    function pendingUsd(address u) external view returns (uint256 personal, uint256 dynamic_) {
        User storage s = users[u];
        personal = s.personalUsd;
        dynamic_ = s.dynamicUsd;
        uint256 idx = currentIndex();
        if (idx > s.indexSnapshot && s.liquidity > 0) {
            personal += Math.mulDiv(s.liquidity, idx - s.indexSnapshot, LREF_ACC) * PERSONAL_PCT / 100;
        }
    }

    function valueUsd(address u) external view returns (uint256) {
        return Math.mulDiv(users[u].liquidity, valuePerRef, L_REF);
    }

    function isEligible(address u) external view returns (bool) {
        return _eligible(u);
    }

    function valuationView() external view returns (bool ok, uint256 v) {
        return _valuation();
    }

    function rewardPriceView() external view returns (bool ok, uint256 price) {
        return _rewardPrice();
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

    function lossLogLength(address u) external view returns (uint256) {
        return lossLog[u].length;
    }

    /// Spot amounts (POP, USDT) for `liquidity` of the fixed full-range position (withdraw preview, excl. fees).
    function amountsForLiquidity(uint128 liquidity) external view returns (uint256 popAmt, uint256 usdtAmt) {
        (uint160 sp,,,,,,) = POOL.slot0();
        (uint256 a0, uint256 a1) = V3Math.amountsForLiquidity(sp, SQRT_LOWER, SQRT_UPPER, liquidity);
        (popAmt, usdtAmt) = TOKEN0 == address(POP) ? (a0, a1) : (a1, a0);
    }

    /// Spot preview of adding `popAmt` + `usdtAmt` (no swap): liquidity and amounts used.
    function previewAdd(uint256 popAmt, uint256 usdtAmt)
        external
        view
        returns (uint128 liquidity, uint256 popUsed, uint256 usdtUsed)
    {
        (uint160 sp,,,,,,) = POOL.slot0();
        (uint256 d0, uint256 d1) = TOKEN0 == address(POP) ? (popAmt, usdtAmt) : (usdtAmt, popAmt);
        liquidity = V3Math.liquidityForAmounts(sp, SQRT_LOWER, SQRT_UPPER, d0, d1);
        (uint256 a0, uint256 a1) = V3Math.amountsForLiquidity(sp, SQRT_LOWER, SQRT_UPPER, liquidity);
        (popUsed, usdtUsed) = TOKEN0 == address(POP) ? (a0, a1) : (a1, a0);
    }
}
