// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "oz5/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "oz5/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "oz5/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "oz5/access/Ownable2Step.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {TickMath} from "v3-core/contracts/libraries/TickMath.sol";
import {IPancakeV3Pool, IPancakeV2Pair} from "../interfaces/IPancakeV3.sol";

/// the mining contract (XiyangMiner): referral bindings and the 入金额度 >= threshold check
interface IXiyangMinerRef {
    /// first two fields of the miner's (all-static) User record: referrer, joined
    function getUser(address u) external view returns (address referrer, bool joined);
    function isEligible(address u) external view returns (bool);
    function REWARD() external view returns (address);
    function POOL() external view returns (address);
}

/// @title 喜羊羊锁仓（第一版，已不使用：0x8747…6927，2026-11-07 部署，测试阶段后由 XiyangLock2 替换）
/// @notice Lock 喜羊羊 for 100 days (1% released every 24 h, 5% reward) or 200 days (0.5% every 24 h, 10% reward).
///  - Lock 喜羊羊 already in the wallet, or buy it with USDT in the same transaction (part of it can go to the wallet).
///  - At the moment of locking, the operator wallet pays (via a fixed allowance it gives this contract):
///      the locker: 5% / 10% of the locked amount;
///      the referrer: 5% / 10% — the first of the locker's referrer, referrer's referrer, and the one above that
///      (3 wallets at most) who has referral rights; nobody qualifies -> not paid (stays in the operator wallet).
///    If the operator wallet cannot pay, the lock does not happen (the whole transaction reverts).
///  - Referral rights: 累计锁仓额度 (USD value of everything the wallet ever locked, booked when locked) has reached the
///    threshold (default 300 USDT, 0.5% tolerance) — permanent once reached — AND the wallet is eligible in the mining contract
///    (入金额度 >= its threshold, 100 USDT).
///  - 锁仓额度 of one lock: USDT spent on the locked part (buy and lock), or amount x spot price (lock from wallet).
///  - Locked 喜羊羊 can only go back to the locker, at the release pace; nothing can be unlocked early, and there is no
///    function that moves locked tokens anywhere else (not even for the owner).
///  Referral bindings come from the mining contract; this contract never changes the mining contract.
contract XiyangLock is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Config {
        address miner; // XiyangMiner (referral bindings + mining eligibility)
        address pool; // PancakeSwap V3 POP/USDT pool (same as the miner's)
        address rewardPair; // PancakeSwap V2 pair 喜羊羊/POP or 喜羊羊/USDT
        address pop;
        address usdt;
        address reward; // 喜羊羊
        address operator; // pays the rewards; also the owner (admin)
        uint256 thresholdUsd; // referral rights threshold (18-dec USD), e.g. 300e18
    }

    struct Lock {
        uint128 amount; // 喜羊羊 locked
        uint128 claimed; // 喜羊羊 already taken out
        uint64 start; // lock time; one release every 24 h after it
        uint16 days_; // 100 or 200
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_REF_GENERATIONS = 3;
    uint256 public constant MIN_THRESHOLD_USD = 1e18;
    uint256 public constant MAX_THRESHOLD_USD = 1_000_000e18;
    uint256 private constant TOL_BPS = 50; // 0.5% tolerance for rounding / small price moves (same as the miner)

    IXiyangMinerRef public immutable MINER;
    IPancakeV3Pool public immutable POOL;
    IPancakeV2Pair public immutable PAIR;
    IERC20 public immutable POP;
    IERC20 public immutable USDT;
    IERC20 public immutable REWARD;
    address public immutable OPERATOR;
    bool public immutable PAIR_VIA_POP; // reward pair is 喜羊羊/POP (USDT -> POP -> 喜羊羊)
    bool private immutable POOL_USDT_IS_0;
    bool private immutable PAIR_REWARD_IS_0;
    uint256 private immutable USDT_SCALE; // 10**(18 - usdtDecimals)

    uint256 public thresholdUsd;
    bool public paused;

    mapping(address => Lock[]) private _locks;
    mapping(address => uint256) public firstOpen; // locks before this index are fully taken out
    mapping(address => uint256) public lockedUsd; // 累计锁仓额度 (18-dec USD), only grows
    mapping(address => bool) public rightsReached; // 累计锁仓额度 reached the threshold at some point (permanent)
    mapping(address => uint256) public ownRewardOf; // 喜羊羊 received as the locker's own reward
    mapping(address => uint256) public refRewardOf; // 喜羊羊 received as referral reward

    uint256 public totalLocked; // 喜羊羊 ever locked
    uint256 public totalClaimed; // 喜羊羊 ever taken out
    uint256 public totalOwnReward; // paid to lockers
    uint256 public totalRefReward; // paid to referrers
    uint256 public totalRefUnpaid; // nobody qualified: stayed in the operator wallet

    bool private _inSwap;

    event Locked(
        address indexed user, uint256 indexed id, uint16 days_, uint256 amount, uint256 usdValue, uint256 reward, uint256 start
    );
    event Bought(address indexed user, uint256 usdtIn, uint256 rewardOut, uint256 toWallet);
    event RefRewardPaid(address indexed from, address indexed to, uint8 generation, uint256 amount);
    event RefRewardUnpaid(address indexed from, uint256 amount);
    event RightsReached(address indexed user, uint256 lockedUsd);
    event Claimed(address indexed user, uint256 amount);
    event ThresholdSet(uint256 thresholdUsd);
    event PausedSet(bool paused);

    error Paused();
    error BadPlan();
    error BadAmount();
    error Expired();
    error Slippage();
    error PriceUnavailable();
    error OperatorCannotLock();
    error BadConfig();

    constructor(Config memory c) Ownable(c.operator) {
        if (
            c.miner == address(0) || c.pool == address(0) || c.rewardPair == address(0) || c.pop == address(0)
                || c.usdt == address(0) || c.reward == address(0) || c.operator == address(0)
        ) revert BadConfig();
        if (IXiyangMinerRef(c.miner).REWARD() != c.reward || IXiyangMinerRef(c.miner).POOL() != c.pool) revert BadConfig();
        address p0 = IPancakeV3Pool(c.pool).token0();
        address p1 = IPancakeV3Pool(c.pool).token1();
        if (!((p0 == c.usdt && p1 == c.pop) || (p0 == c.pop && p1 == c.usdt))) revert BadConfig();
        address q0 = IPancakeV2Pair(c.rewardPair).token0();
        address q1 = IPancakeV2Pair(c.rewardPair).token1();
        address other = q0 == c.reward ? q1 : q0;
        if ((q0 != c.reward && q1 != c.reward) || (other != c.pop && other != c.usdt)) revert BadConfig();
        _checkThreshold(c.thresholdUsd);
        MINER = IXiyangMinerRef(c.miner);
        POOL = IPancakeV3Pool(c.pool);
        PAIR = IPancakeV2Pair(c.rewardPair);
        POP = IERC20(c.pop);
        USDT = IERC20(c.usdt);
        REWARD = IERC20(c.reward);
        OPERATOR = c.operator;
        PAIR_VIA_POP = other == c.pop;
        POOL_USDT_IS_0 = p0 == c.usdt;
        PAIR_REWARD_IS_0 = q0 == c.reward;
        USDT_SCALE = 10 ** (18 - IERC20Metadata(c.usdt).decimals());
        thresholdUsd = c.thresholdUsd;
    }

    // ------------------------------------------------------------------ locking

    /// @notice Lock `amount` 喜羊羊 from the wallet for `days_` (100 or 200). Its 锁仓额度 = amount x spot price.
    function lock(uint256 amount, uint16 days_) external nonReentrant returns (uint256 id) {
        _checkPlan(days_);
        if (amount == 0) revert BadAmount();
        uint256 got = _pull(REWARD, msg.sender, amount);
        uint256 usd = valueUsd(got);
        id = _lock(msg.sender, got, usd, days_);
    }

    /// @notice Buy 喜羊羊 with `usdtIn` USDT on PancakeSwap, lock `lockBps` of it (10000 = all, 8000 = 80%) for `days_`
    /// and send the rest to the wallet. Its 锁仓额度 = usdtIn x lockBps.
    function buyAndLock(uint256 usdtIn, uint16 lockBps, uint16 days_, uint256 minRewardOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (block.timestamp > deadline) revert Expired();
        _checkPlan(days_);
        if (usdtIn == 0 || lockBps == 0 || lockBps > BPS) revert BadAmount();
        if (paused) revert Paused();
        uint256 inUsdt = _pull(USDT, msg.sender, usdtIn);
        uint256 before = REWARD.balanceOf(address(this));
        if (PAIR_VIA_POP) {
            uint256 popOut = _swapUsdtForPop(inUsdt);
            _swapV2(POP, popOut);
        } else {
            _swapV2(USDT, inUsdt);
        }
        uint256 bought = REWARD.balanceOf(address(this)) - before;
        if (bought < minRewardOut || bought == 0) revert Slippage();
        uint256 locked = (bought * lockBps) / BPS;
        uint256 toWallet = bought - locked;
        if (locked == 0) revert BadAmount();
        if (toWallet > 0) REWARD.safeTransfer(msg.sender, toWallet);
        emit Bought(msg.sender, inUsdt, bought, toWallet);
        uint256 usd = ((inUsdt * lockBps) / BPS) * USDT_SCALE;
        id = _lock(msg.sender, locked, usd, days_);
    }

    function _lock(address u, uint256 amount, uint256 usd, uint16 days_) internal returns (uint256 id) {
        if (paused) revert Paused();
        if (u == OPERATOR) revert OperatorCannotLock();
        if (amount > type(uint128).max) revert BadAmount();
        id = _locks[u].length;
        _locks[u].push(Lock(uint128(amount), 0, uint64(block.timestamp), days_));
        totalLocked += amount;
        uint256 cum = lockedUsd[u] + usd;
        lockedUsd[u] = cum;
        if (!rightsReached[u] && _meets(cum)) {
            rightsReached[u] = true;
            emit RightsReached(u, cum);
        }
        uint256 reward = (amount * rewardBps(days_)) / BPS;
        emit Locked(u, id, days_, amount, usd, reward, block.timestamp);
        if (reward == 0) return id;
        // the locker's own reward
        REWARD.safeTransferFrom(OPERATOR, u, reward);
        totalOwnReward += reward;
        ownRewardOf[u] += reward;
        // the referral reward: first wallet with referral rights among 3 generations above
        (address r,) = MINER.getUser(u);
        for (uint8 g = 1; g <= MAX_REF_GENERATIONS && r != address(0); ++g) {
            if (canRefer(r)) {
                REWARD.safeTransferFrom(OPERATOR, r, reward);
                totalRefReward += reward;
                refRewardOf[r] += reward;
                emit RefRewardPaid(u, r, g, reward);
                return id;
            }
            (r,) = MINER.getUser(r);
        }
        totalRefUnpaid += reward;
        emit RefRewardUnpaid(u, reward);
    }

    // ------------------------------------------------------------------ release

    /// @notice Take out everything released so far (one release every 24 h after each lock).
    function claim() external nonReentrant returns (uint256 amount) {
        address u = msg.sender;
        Lock[] storage ls = _locks[u];
        uint256 n = ls.length;
        uint256 i = firstOpen[u];
        bool prefixDone = true;
        for (; i < n; ++i) {
            Lock storage l = ls[i];
            uint256 rel = _released(l);
            if (rel > l.claimed) {
                amount += rel - l.claimed;
                l.claimed = uint128(rel);
            }
            if (prefixDone) {
                if (l.claimed == l.amount) firstOpen[u] = i + 1;
                else prefixDone = false;
            }
        }
        if (amount == 0) revert BadAmount();
        totalClaimed += amount;
        REWARD.safeTransfer(u, amount);
        emit Claimed(u, amount);
    }

    function _released(Lock storage l) internal view returns (uint256) {
        uint256 periods = (block.timestamp - l.start) / 1 days;
        if (periods >= l.days_) return l.amount;
        return (uint256(l.amount) * periods) / l.days_;
    }

    // ------------------------------------------------------------------ admin (no access to anyone's tokens)

    /// @notice Referral rights threshold (18-dec USD). Wallets that already reached it keep their rights.
    function setThresholdUsd(uint256 usd) external onlyOwner {
        _checkThreshold(usd);
        thresholdUsd = usd;
        emit ThresholdSet(usd);
    }

    /// @notice Pause / resume new locks. Releases and claims are never paused.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    // ------------------------------------------------------------------ views

    function rewardBps(uint16 days_) public pure returns (uint256) {
        return days_ == 100 ? 500 : days_ == 200 ? 1000 : 0;
    }

    /// referral rights: 累计锁仓额度 reached the threshold (permanent) and eligible in the mining contract
    function canRefer(address u) public view returns (bool) {
        return (rightsReached[u] || _meets(lockedUsd[u])) && MINER.isEligible(u);
    }

    function _meets(uint256 usd) internal view returns (bool) {
        return usd * BPS >= thresholdUsd * (BPS - TOL_BPS);
    }

    function lockCount(address u) external view returns (uint256) {
        return _locks[u].length;
    }

    function locksOf(address u, uint256 from, uint256 max) external view returns (Lock[] memory out) {
        Lock[] storage ls = _locks[u];
        uint256 n = ls.length;
        if (from >= n) return out;
        uint256 m = Math.min(max, n - from);
        out = new Lock[](m);
        for (uint256 i; i < m; ++i) {
            out[i] = ls[from + i];
        }
    }

    /// (still locked = not yet released, released but not taken out)
    function balances(address u) external view returns (uint256 stillLocked, uint256 claimable) {
        Lock[] storage ls = _locks[u];
        for (uint256 i = firstOpen[u]; i < ls.length; ++i) {
            Lock storage l = ls[i];
            uint256 rel = _released(l);
            stillLocked += l.amount - rel;
            claimable += rel - l.claimed;
        }
    }

    /// USD (18-dec) value of `amount` 喜羊羊 at the current PancakeSwap prices (spot)
    function valueUsd(uint256 amount) public view returns (uint256) {
        (uint112 r0, uint112 r1,) = PAIR.getReserves();
        (uint256 rr, uint256 rc) = PAIR_REWARD_IS_0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        if (rr == 0 || rc == 0) revert PriceUnavailable();
        uint256 counter = Math.mulDiv(amount, rc, rr);
        if (!PAIR_VIA_POP) return counter * USDT_SCALE;
        (uint160 sp,,,,,,) = POOL.slot0();
        if (sp == 0) revert PriceUnavailable();
        // POOL price = token1 per token0 = (sp / 2^96)^2
        uint256 usdt = POOL_USDT_IS_0
            ? Math.mulDiv(Math.mulDiv(counter, 1 << 96, sp), 1 << 96, sp)
            : Math.mulDiv(Math.mulDiv(counter, sp, 1 << 96), sp, 1 << 96);
        return usdt * USDT_SCALE;
    }

    // ------------------------------------------------------------------ internals

    function _checkPlan(uint16 days_) internal pure {
        if (days_ != 100 && days_ != 200) revert BadPlan();
    }

    function _checkThreshold(uint256 usd) internal pure {
        if (usd < MIN_THRESHOLD_USD || usd > MAX_THRESHOLD_USD) revert BadConfig();
    }

    /// pull `amount` of `t` from `from`; returns what actually arrived (tokens that take a fee on transfer)
    function _pull(IERC20 t, address from, uint256 amount) internal returns (uint256) {
        uint256 b = t.balanceOf(address(this));
        t.safeTransferFrom(from, address(this), amount);
        return t.balanceOf(address(this)) - b;
    }

    /// V2 swap of `amountIn` of `tokenIn` (held here) for 喜羊羊, sent here. Input measured at the pair.
    function _swapV2(IERC20 tokenIn, uint256 amountIn) internal {
        (uint112 r0, uint112 r1,) = PAIR.getReserves();
        (uint256 rIn, uint256 rOut) = PAIR_REWARD_IS_0 ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
        tokenIn.safeTransfer(address(PAIR), amountIn);
        uint256 got = tokenIn.balanceOf(address(PAIR)) - rIn;
        uint256 withFee = got * 9975; // PancakeSwap V2: 0.25%
        uint256 out = (withFee * rOut) / (rIn * 10_000 + withFee);
        if (out == 0) revert Slippage();
        (uint256 o0, uint256 o1) = PAIR_REWARD_IS_0 ? (out, uint256(0)) : (uint256(0), out);
        IV2Swap(address(PAIR)).swap(o0, o1, address(this), "");
    }

    function _swapUsdtForPop(uint256 usdtIn) internal returns (uint256 popOut) {
        bool zeroForOne = POOL_USDT_IS_0;
        uint256 b = POP.balanceOf(address(this));
        _inSwap = true;
        (int256 a0, int256 a1) = POOL.swap(
            address(this), zeroForOne, int256(usdtIn), zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1, ""
        );
        _inSwap = false;
        int256 paid = zeroForOne ? a0 : a1;
        if (uint256(paid) != usdtIn) revert Slippage(); // partial fill
        popOut = POP.balanceOf(address(this)) - b;
    }

    function _swapCallback(int256 a0, int256 a1) internal {
        require(msg.sender == address(POOL) && _inSwap, "cb");
        // only USDT is ever owed (exact-input USDT -> POP)
        int256 owed = a0 > 0 ? a0 : a1;
        if (owed > 0) USDT.safeTransfer(msg.sender, uint256(owed));
    }

    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _swapCallback(a0, a1);
    }

    /// Uniswap-V3-compatible callback name (local test pools are built from Uniswap V3 sources)
    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _swapCallback(a0, a1);
    }
}

interface IV2Swap {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}
