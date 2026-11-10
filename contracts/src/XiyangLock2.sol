// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {SafeERC20} from "oz5/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "oz5/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "oz5/access/Ownable2Step.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {TickMath} from "v3-core/contracts/libraries/TickMath.sol";
import {IPancakeV3Pool, IPancakeV2Pair} from "./interfaces/IPancakeV3.sol";

/// the mining contract (XiyangMiner): referral bindings and the 入金额度 >= threshold check
interface IXiyangMinerRef2 {
    /// first two fields of the miner's (all-static) User record: referrer, joined
    function getUser(address u) external view returns (address referrer, bool joined);
    function isEligible(address u) external view returns (bool);
    function REWARD() external view returns (address);
    function POOL() external view returns (address);
    function POP() external view returns (address);
}

/// @title 喜羊羊 / POP 锁仓（第二版）
/// @notice Lock 喜羊羊 or POP for 100 days (1% released every 24 h, 5% reward) or 200 days (0.5% every 24 h, 10% reward).
///  - 喜羊羊: lock what is in the wallet, or buy it with USDT in the same transaction (part of it can go to the wallet).
///  - POP: lock what is in the wallet.
///  - At the moment of locking, the operator wallet pays in the locked coin (via fixed allowances it gives this contract):
///      the locker: 5% / 10% of the locked amount;
///      the referrer: 5% / 10% — the first of the locker's referrer, referrer's referrer, and the one above that
///      (3 wallets at most) whose 入金额度 in the mining contract is >= its threshold (100 USDT);
///      nobody qualifies -> not paid (stays in the operator wallet).
///    If the operator wallet cannot pay, the lock does not happen (the whole transaction reverts).
///  - Locked coins can only go back to the locker, at the release pace; nothing can be unlocked early, and there is no
///    function that moves locked coins anywhere else (not even for the owner).
///  Referral bindings come from the mining contract; this contract never changes the mining contract.
contract XiyangLock2 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Config {
        address miner; // XiyangMiner (referral bindings + mining eligibility)
        address pool; // PancakeSwap V3 POP/USDT pool (same as the miner's)
        address rewardPair; // PancakeSwap V2 pair 喜羊羊/POP or 喜羊羊/USDT
        address pop;
        address usdt;
        address reward; // 喜羊羊
        address operator; // pays the rewards; also the owner (admin)
    }

    struct Lock {
        uint128 amount; // coins locked
        uint128 claimed; // coins already taken out
        uint64 start; // lock time; one release every 24 h after it
        uint16 days_; // 100 or 200
        uint8 coin; // 0 = 喜羊羊, 1 = POP
    }

    uint8 public constant XYY = 0;
    uint8 public constant POPC = 1;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_REF_GENERATIONS = 3;

    IXiyangMinerRef2 public immutable MINER;
    IPancakeV3Pool public immutable POOL;
    IPancakeV2Pair public immutable PAIR;
    IERC20 public immutable POP;
    IERC20 public immutable USDT;
    IERC20 public immutable REWARD;
    address public immutable OPERATOR;
    bool public immutable PAIR_VIA_POP; // reward pair is 喜羊羊/POP (USDT -> POP -> 喜羊羊)
    bool private immutable POOL_USDT_IS_0;
    bool private immutable PAIR_REWARD_IS_0;

    bool public paused;

    mapping(address => Lock[]) private _locks;
    mapping(address => uint256) public firstOpen; // locks before this index are fully taken out
    mapping(address => uint256[2]) private _ownReward; // per coin, received as the locker's own reward
    mapping(address => uint256[2]) private _refReward; // per coin, received as referral reward

    uint256[2] public totalLocked; // per coin, ever locked
    uint256[2] public totalClaimed; // per coin, ever taken out
    uint256[2] public totalOwnReward; // per coin, paid to lockers
    uint256[2] public totalRefReward; // per coin, paid to referrers
    uint256[2] public totalRefUnpaid; // per coin, nobody qualified: stayed in the operator wallet

    bool private _inSwap;

    /// `referrer` = the locker's referrer in the mining contract at this moment (lets anyone rebuild teams from events)
    event Locked(
        address indexed user,
        uint256 indexed id,
        address indexed referrer,
        uint8 coin,
        uint16 days_,
        uint256 amount,
        uint256 reward,
        uint256 start
    );
    event Bought(address indexed user, uint256 usdtIn, uint256 rewardOut, uint256 toWallet);
    event RefRewardPaid(address indexed from, address indexed to, uint8 coin, uint8 generation, uint256 amount);
    event RefRewardUnpaid(address indexed from, uint8 coin, uint256 amount);
    event Claimed(address indexed user, uint8 coin, uint256 amount);
    event PausedSet(bool paused);

    error Paused();
    error BadPlan();
    error BadCoin();
    error BadAmount();
    error Expired();
    error Slippage();
    error OperatorCannotLock();
    error BadConfig();

    constructor(Config memory c) Ownable(c.operator) {
        if (
            c.miner == address(0) || c.pool == address(0) || c.rewardPair == address(0) || c.pop == address(0)
                || c.usdt == address(0) || c.reward == address(0) || c.operator == address(0)
        ) revert BadConfig();
        IXiyangMinerRef2 m = IXiyangMinerRef2(c.miner);
        if (m.REWARD() != c.reward || m.POOL() != c.pool || m.POP() != c.pop) revert BadConfig();
        address p0 = IPancakeV3Pool(c.pool).token0();
        address p1 = IPancakeV3Pool(c.pool).token1();
        if (!((p0 == c.usdt && p1 == c.pop) || (p0 == c.pop && p1 == c.usdt))) revert BadConfig();
        address q0 = IPancakeV2Pair(c.rewardPair).token0();
        address q1 = IPancakeV2Pair(c.rewardPair).token1();
        address other = q0 == c.reward ? q1 : q0;
        if ((q0 != c.reward && q1 != c.reward) || (other != c.pop && other != c.usdt)) revert BadConfig();
        MINER = m;
        POOL = IPancakeV3Pool(c.pool);
        PAIR = IPancakeV2Pair(c.rewardPair);
        POP = IERC20(c.pop);
        USDT = IERC20(c.usdt);
        REWARD = IERC20(c.reward);
        OPERATOR = c.operator;
        PAIR_VIA_POP = other == c.pop;
        POOL_USDT_IS_0 = p0 == c.usdt;
        PAIR_REWARD_IS_0 = q0 == c.reward;
    }

    // ------------------------------------------------------------------ locking

    /// @notice Lock `amount` of a coin from the wallet (`coin` 0 = 喜羊羊, 1 = POP) for `days_` (100 or 200).
    function lock(uint8 coin, uint256 amount, uint16 days_) external nonReentrant returns (uint256 id) {
        _checkPlan(days_);
        IERC20 t = coinToken(coin);
        if (amount == 0) revert BadAmount();
        if (paused) revert Paused();
        uint256 got = _pull(t, msg.sender, amount);
        id = _lock(msg.sender, coin, got, days_);
    }

    /// @notice Buy 喜羊羊 with `usdtIn` USDT on PancakeSwap, lock `lockBps` of it (10000 = all, 8000 = 80%) for `days_`
    /// and send the rest to the wallet.
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
        id = _lock(msg.sender, XYY, locked, days_);
    }

    function _lock(address u, uint8 coin, uint256 amount, uint16 days_) internal returns (uint256 id) {
        if (u == OPERATOR) revert OperatorCannotLock();
        if (amount == 0 || amount > type(uint128).max) revert BadAmount();
        id = _locks[u].length;
        _locks[u].push(Lock(uint128(amount), 0, uint64(block.timestamp), days_, coin));
        totalLocked[coin] += amount;
        uint256 reward = (amount * rewardBps(days_)) / BPS;
        (address r,) = MINER.getUser(u);
        emit Locked(u, id, r, coin, days_, amount, reward, block.timestamp);
        if (reward == 0) return id;
        IERC20 t = coinToken(coin);
        // the locker's own reward
        t.safeTransferFrom(OPERATOR, u, reward);
        totalOwnReward[coin] += reward;
        _ownReward[u][coin] += reward;
        // the referral reward: first wallet with referral rights among 3 generations above
        for (uint8 g = 1; g <= MAX_REF_GENERATIONS && r != address(0); ++g) {
            if (canRefer(r)) {
                t.safeTransferFrom(OPERATOR, r, reward);
                totalRefReward[coin] += reward;
                _refReward[r][coin] += reward;
                emit RefRewardPaid(u, r, coin, g, reward);
                return id;
            }
            (r,) = MINER.getUser(r);
        }
        totalRefUnpaid[coin] += reward;
        emit RefRewardUnpaid(u, coin, reward);
    }

    // ------------------------------------------------------------------ release

    /// @notice Take out everything released so far, both coins (one release every 24 h after each lock).
    function claim() external nonReentrant returns (uint256 xyyAmount, uint256 popAmount) {
        address u = msg.sender;
        Lock[] storage ls = _locks[u];
        uint256 n = ls.length;
        uint256 i = firstOpen[u];
        bool prefixDone = true;
        uint256[2] memory amt;
        for (; i < n; ++i) {
            Lock storage l = ls[i];
            uint256 rel = _released(l);
            if (rel > l.claimed) {
                amt[l.coin] += rel - l.claimed;
                l.claimed = uint128(rel);
            }
            if (prefixDone) {
                if (l.claimed == l.amount) firstOpen[u] = i + 1;
                else prefixDone = false;
            }
        }
        if (amt[0] == 0 && amt[1] == 0) revert BadAmount();
        for (uint8 c; c < 2; ++c) {
            if (amt[c] == 0) continue;
            totalClaimed[c] += amt[c];
            coinToken(c).safeTransfer(u, amt[c]);
            emit Claimed(u, c, amt[c]);
        }
        return (amt[0], amt[1]);
    }

    function _released(Lock storage l) internal view returns (uint256) {
        uint256 periods = (block.timestamp - l.start) / 1 days;
        if (periods >= l.days_) return l.amount;
        return (uint256(l.amount) * periods) / l.days_;
    }

    // ------------------------------------------------------------------ admin (no access to anyone's coins)

    /// @notice Pause / resume new locks. Releases and claims are never paused.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    // ------------------------------------------------------------------ views

    function coinToken(uint8 coin) public view returns (IERC20) {
        if (coin == XYY) return REWARD;
        if (coin == POPC) return POP;
        revert BadCoin();
    }

    function rewardBps(uint16 days_) public pure returns (uint256) {
        return days_ == 100 ? 500 : days_ == 200 ? 1000 : 0;
    }

    /// referral rights: 入金额度 in the mining contract >= its threshold (100 USDT), checked at the moment of each lock
    function canRefer(address u) public view returns (bool) {
        return MINER.isEligible(u);
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

    /// per coin [喜羊羊, POP]: still locked = not yet released; claimable = released but not taken out
    function balances(address u) external view returns (uint256[2] memory stillLocked, uint256[2] memory claimable) {
        Lock[] storage ls = _locks[u];
        for (uint256 i = firstOpen[u]; i < ls.length; ++i) {
            Lock storage l = ls[i];
            uint256 rel = _released(l);
            stillLocked[l.coin] += l.amount - rel;
            claimable[l.coin] += rel - l.claimed;
        }
    }

    /// per coin [喜羊羊, POP]: own reward and referral reward received so far
    function rewardsOf(address u) external view returns (uint256[2] memory own, uint256[2] memory ref) {
        return (_ownReward[u], _refReward[u]);
    }

    // ------------------------------------------------------------------ internals

    function _checkPlan(uint16 days_) internal pure {
        if (days_ != 100 && days_ != 200) revert BadPlan();
    }

    /// pull `amount` of `t` from `from`; returns what actually arrived (coins that take a fee on transfer)
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
        IV2Swap2(address(PAIR)).swap(o0, o1, address(this), "");
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

interface IV2Swap2 {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}
