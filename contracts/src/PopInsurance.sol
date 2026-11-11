// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "oz5/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "oz5/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "oz5/utils/ReentrancyGuard.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {TickMath} from "v3-core/contracts/libraries/TickMath.sol";
import {IPancakeV3Pool} from "./interfaces/IPancakeV3.sol";
import {V3Math} from "./lib/V3Math.sol";

/// the mining contract (XiyangMiner): only its referral bindings are read, nothing is ever written there
interface IXiyangMinerRef3 {
    function getUser(address u) external view returns (address referrer, bool joined);
}

/// @title POP 保险池
/// @notice Users buy POP with USDT through this contract; the POP stays here, one "lot" per purchase, and can only
///  leave by being sold back to USDT (lot by lot, all or part).
///  - Buying: a buy fee (default 1.5%) goes to the pool wallet (insurance book); the rest is swapped for POP in the
///    PancakeSwap V3 POP/USDT pool. Each lot keeps the rules that applied when it was bought (profit fee,
///    compensation ratio and cap, waiting days) — later parameter changes never touch existing lots.
///  - Selling a lot (or part of it): profit = proceeds − what was paid (fee included) → profit fee (default 15%),
///    split 5:3:7 into insurance / ecosystem / referral. The referral part goes straight to up to 7 uplines
///    (referral bindings of the mining contract): level n is paid when that upline has at least n effective directs
///    (directs holding ≥ the threshold in this pool, default 200 USDT); unpaid levels stay in the pool wallet.
///  - Loss on a lot held for the waiting days (default 15): compensation (default 100% of the loss) paid by the pool
///    wallet straight to the seller. The loss is measured against the USDT that actually bought the POP (buy fee
///    not compensated), and against both the sale price and the 15-minute average price (the smaller loss counts),
///    so a momentary price push cannot create a loss. Paid at most: the cap (default 100% of the principal), the
///    insurance book, the pool wallet's balance and its allowance to this contract. Nothing is owed beyond that.
///  - The pool wallet is an ordinary wallet that gives this contract a fixed USDT allowance; this contract only
///    pulls from it to pay compensation. The three books (insurance / ecosystem / referral) are bookkeeping only.
///  - Owner (fixed at deployment, independent of who deploys) sets every number within hard bounds; up to 3 sub-admins can only set the daily
///    limits. Nobody can move users' POP, and selling can never be paused (only new buys can).
contract PopInsurance is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant LEVELS = 7;
    uint256 public constant MAX_OPEN_LOTS = 64;
    uint256 public constant MAX_SUBS = 3;
    uint32 public constant TWAP_WINDOW = 900; // 15 minutes
    uint16 public constant MAX_BUY_FEE_BPS = 1000; // 10%
    uint16 public constant MAX_PROFIT_FEE_BPS = 5000; // 50%
    uint256 private constant BPS = 10_000;

    IERC20 public immutable USDT;
    IERC20 public immutable POP;
    IPancakeV3Pool public immutable POOL;
    IXiyangMinerRef3 public immutable MINER;
    address public immutable owner;
    bool private immutable USDT_IS_0;
    uint256 private immutable ONE_USDT;

    /// rules locked into a lot when it is bought
    struct Rule {
        uint16 profitFeeBps;
        uint16 compRatioBps;
        uint16 compCapBps;
        uint16 waitDays;
    }

    struct Lot {
        uint128 paid; // USDT paid, buy fee included (original)
        uint128 bought; // POP received (original)
        uint128 left; // POP not sold yet
        uint128 paidLeft; // paid, for the POP not sold yet (profit and cap are measured against this)
        uint128 baseLeft; // USDT that really bought the POP not sold yet, capped at its average-price value at purchase
        uint64 at; // purchase time
        Rule rule;
    }

    struct Params {
        uint128 minBuy;
        uint128 maxBuy;
        uint128 globalDaily;
        uint128 walletDaily;
        uint128 directMin; // effective direct: holding (by cost) >= this
        uint16 buyFeeBps;
        uint16 profitFeeBps;
        uint16 compRatioBps;
        uint16 compCapBps;
        uint16 waitDays;
        uint16 maxDevTicks; // buys refused while the spot price is further than this from the 15-minute average
        uint8 splitIns;
        uint8 splitEco;
        uint8 splitDyn;
    }

    struct Book {
        uint128 left;
        uint128 inflow;
        uint128 outflow;
    }

    Params internal params;
    address public poolWallet;
    bool public paused;
    /// bumped by every change of the buying rules or limits: a buy signed under older numbers is refused
    uint256 public rev = 1;

    Book[3] internal _books; // 0 insurance, 1 ecosystem, 2 referral (dynamic)
    address[] internal _subs;
    mapping(address => bool) public isSub;

    mapping(address => Lot[]) internal _lots;
    mapping(address => uint256) public openLots;
    mapping(address => uint256) public holdCost; // sum of paidLeft over the user's lots
    mapping(address => uint256) public effDirects; // directs currently counted as effective
    mapping(address => address) public countedUnder; // the upline this user is counted under (0 = not counted)
    mapping(address => uint256) public refEarned;
    mapping(address => bool) internal _seen;
    mapping(uint256 => uint256) public daySpent; // Beijing day => USDT bought network-wide
    mapping(uint256 => mapping(address => uint256)) public walletDaySpent;

    uint256 public participants;
    uint256 public totalPop; // POP held for users
    uint256 public totalBought; // USDT
    uint256 public totalComp; // USDT
    uint256 public totalRef; // USDT

    bool private _inSwap;
    bool private _swapUsdtIn;

    /// `upline` = the buyer's referrer in the mining contract (lets the website build the team list)
    event Bought(address indexed user, uint256 indexed id, address indexed upline, uint256 paid, uint256 fee, uint256 popOut, uint256 base, Rule rule);
    event Sold(address indexed user, uint256 indexed id, uint256 popIn, uint256 proceeds, uint256 cost, uint256 fee, uint256 comp);
    event CompShort(address indexed user, uint256 indexed id, uint256 wanted); // compensation could not be pulled
    event RefPaid(address indexed from, address indexed to, uint8 level, uint256 amount);
    event FeeSplit(address indexed from, uint256 ins, uint256 eco, uint256 dynKept);
    event EffChanged(address indexed user, address indexed upline, bool effective);
    event BookChanged(uint8 indexed book, int256 delta, uint256 left, uint8 reason); // 1 fee 2 comp 3 move 4 adjust 5 deposit
    event DailyLimitsSet(address indexed by, uint256 globalDaily, uint256 walletDaily);
    event RulesSet(uint256 minBuy, uint256 maxBuy, uint16 buyFeeBps, uint16 profitFeeBps, uint16 compRatioBps, uint16 compCapBps, uint16 waitDays, uint256 directMin);
    event SplitSet(uint8 ins, uint8 eco, uint8 dyn);
    event MaxDevSet(uint16 ticks);
    event PoolWalletSet(address wallet);
    event SubSet(address indexed account, bool on);
    event PausedSet(bool paused);

    error NotOwner();
    error NotAdmin();
    error Paused();
    error Expired();
    error RulesChanged();
    error BadAmount();
    error BadLot();
    error BadConfig();
    error GlobalLimit();
    error WalletLimit();
    error TooManyLots();
    error PriceUnstable();
    error Slippage();

    struct Config {
        address usdt;
        address pop;
        address pool; // PancakeSwap V3 POP/USDT (the miner's pool)
        address miner;
        address poolWallet;
        address owner; // 主管理员: written in at deployment, whoever sends the deployment transaction
    }

    constructor(Config memory c) {
        if (
            c.usdt == address(0) || c.pop == address(0) || c.pool == address(0) || c.miner == address(0) || c.poolWallet == address(0)
                || c.owner == address(0)
        ) {
            revert BadConfig();
        }
        address t0 = IPancakeV3Pool(c.pool).token0();
        address t1 = IPancakeV3Pool(c.pool).token1();
        if (!((t0 == c.usdt && t1 == c.pop) || (t0 == c.pop && t1 == c.usdt))) revert BadConfig();
        USDT = IERC20(c.usdt);
        POP = IERC20(c.pop);
        POOL = IPancakeV3Pool(c.pool);
        MINER = IXiyangMinerRef3(c.miner);
        USDT_IS_0 = t0 == c.usdt;
        owner = c.owner;
        poolWallet = c.poolWallet;
        uint256 one = 10 ** IERC20Metadata(c.usdt).decimals();
        ONE_USDT = one;
        params = Params({
            minBuy: uint128(200 * one),
            maxBuy: uint128(2000 * one),
            globalDaily: uint128(50_000 * one),
            walletDaily: uint128(4000 * one),
            directMin: uint128(200 * one),
            buyFeeBps: 150,
            profitFeeBps: 1500,
            compRatioBps: 10_000,
            compCapBps: 10_000,
            waitDays: 15,
            maxDevTicks: 300,
            splitIns: 5,
            splitEco: 3,
            splitDyn: 7
        });
    }

    // ================================================================== user actions

    /// @notice Buy POP with `usdtIn` USDT (fixed allowance from the buyer). `expectedRev` = `rev` the page showed:
    ///  if any rule or limit changed since, the buy is refused (nothing is taken).
    function buy(uint256 usdtIn, uint256 minPopOut, uint256 deadline, uint256 expectedRev)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (block.timestamp > deadline) revert Expired();
        if (expectedRev != rev) revert RulesChanged();
        int24 tw = _checkBuy(msg.sender, usdtIn);

        uint256 b0 = USDT.balanceOf(address(this));
        USDT.safeTransferFrom(msg.sender, address(this), usdtIn);
        if (USDT.balanceOf(address(this)) - b0 != usdtIn) revert BadAmount();
        uint256 fee = (usdtIn * params.buyFeeBps) / BPS;
        if (fee > 0) {
            USDT.safeTransfer(poolWallet, fee);
            _credit(0, fee, 1);
        }
        uint256 got = _swap(true, usdtIn - fee);
        if (got == 0 || got < minPopOut) revert Slippage();
        uint256 fair = V3Math.quoteAtTick(tw, got, address(POP), address(USDT));
        id = _record(msg.sender, usdtIn, got, Math.min(usdtIn - fee, fair));
        (address up,) = MINER.getUser(msg.sender);
        emit Bought(msg.sender, id, up, usdtIn, fee, got, _lots[msg.sender][id].baseLeft, _lots[msg.sender][id].rule);
    }

    function _checkBuy(address u, uint256 usdtIn) internal view returns (int24 tw) {
        if (paused) revert Paused();
        Params memory p = params;
        if (usdtIn < p.minBuy || usdtIn > p.maxBuy) revert BadAmount();
        uint256 day = beijingDay();
        if (daySpent[day] + usdtIn > p.globalDaily) revert GlobalLimit();
        if (walletDaySpent[day][u] + usdtIn > p.walletDaily) revert WalletLimit();
        if (openLots[u] >= MAX_OPEN_LOTS) revert TooManyLots();
        bool ok;
        int24 spot;
        (ok, tw, spot) = _ticks();
        if (!ok || _dist(tw, spot) > p.maxDevTicks) revert PriceUnstable();
    }

    function _record(address u, uint256 usdtIn, uint256 got, uint256 base) internal returns (uint256 id) {
        uint256 day = beijingDay();
        daySpent[day] += usdtIn;
        walletDaySpent[day][u] += usdtIn;
        Params memory p = params;
        id = _lots[u].length;
        _lots[u].push(
            Lot({
                paid: uint128(usdtIn),
                bought: uint128(got),
                left: uint128(got),
                paidLeft: uint128(usdtIn),
                baseLeft: uint128(base),
                at: uint64(block.timestamp),
                rule: Rule(p.profitFeeBps, p.compRatioBps, p.compCapBps, p.waitDays)
            })
        );
        openLots[u]++;
        holdCost[u] += usdtIn;
        totalPop += got;
        totalBought += usdtIn;
        if (!_seen[u]) {
            _seen[u] = true;
            participants++;
        }
        _updateEff(u);
    }

    struct Sale {
        uint256 proceeds;
        uint256 cost;
        uint256 base;
        uint256 fee;
        uint256 comp;
    }

    /// @notice Sell `popIn` POP of lot `id` for USDT. Profit fee and compensation follow that lot's own rules.
    function sell(uint256 id, uint256 popIn, uint256 minUsdtOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 toUser, uint256 comp)
    {
        if (block.timestamp > deadline) revert Expired();
        if (id >= _lots[msg.sender].length) revert BadLot();
        Sale memory s = _sell(msg.sender, id, popIn, minUsdtOut);
        if (s.fee > 0) _distribute(msg.sender, s.fee);
        toUser = s.proceeds - s.fee;
        comp = s.comp;
        USDT.safeTransfer(msg.sender, toUser);
        _updateEff(msg.sender);
        emit Sold(msg.sender, id, popIn, s.proceeds, s.cost, s.fee, comp);
    }

    function _sell(address u, uint256 id, uint256 popIn, uint256 minOut) internal returns (Sale memory s) {
        Lot storage l = _lots[u][id];
        uint256 left = l.left;
        if (popIn == 0 || popIn > left) revert BadAmount();
        (bool ok, int24 tw,) = _ticks(); // read before the swap
        s.proceeds = _swap(false, popIn);
        if (s.proceeds < minOut) revert Slippage();
        s.cost = Math.mulDiv(l.paidLeft, popIn, left);
        s.base = Math.mulDiv(l.baseLeft, popIn, left);
        l.left = uint128(left - popIn);
        l.paidLeft -= uint128(s.cost);
        l.baseLeft -= uint128(s.base);
        if (left == popIn) openLots[u]--;
        holdCost[u] -= s.cost;
        totalPop -= popIn;
        Rule memory r = l.rule;
        if (s.proceeds > s.cost) s.fee = ((s.proceeds - s.cost) * r.profitFeeBps) / BPS;
        if (ok && u != poolWallet && block.timestamp >= uint256(l.at) + uint256(r.waitDays) * 1 days) {
            uint256 fair = V3Math.quoteAtTick(tw, popIn, address(POP), address(USDT));
            uint256 hi = s.proceeds > fair ? s.proceeds : fair; // the smaller of the two losses
            if (s.base > hi) {
                uint256 want = Math.min(((s.base - hi) * r.compRatioBps) / BPS, (s.cost * r.compCapBps) / BPS);
                s.comp = _payComp(u, id, want);
            }
        }
    }

    /// @notice Recount whether these wallets are effective directs (e.g. after the threshold changed). Anyone.
    function refresh(address[] calldata users) external {
        for (uint256 i; i < users.length; i++) {
            _updateEff(users[i]);
        }
    }

    /// @notice Put real USDT into a book: sent straight from the caller to the pool wallet. Anyone.
    function deposit(uint8 book, uint256 amount) external nonReentrant {
        if (book > 2 || amount == 0) revert BadAmount();
        USDT.safeTransferFrom(msg.sender, poolWallet, amount);
        _credit(book, amount, 5);
    }

    // ================================================================== admin

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Daily limits (USDT): network-wide and per wallet. Owner or a sub-admin.
    function setDailyLimits(uint256 globalDaily, uint256 walletDaily) external {
        if (msg.sender != owner && !isSub[msg.sender]) revert NotAdmin();
        if (globalDaily > 1e12 * ONE_USDT || walletDaily > 1e12 * ONE_USDT) revert BadConfig();
        params.globalDaily = uint128(globalDaily);
        params.walletDaily = uint128(walletDaily);
        rev++;
        emit DailyLimitsSet(msg.sender, globalDaily, walletDaily);
    }

    /// @notice Buying and compensation rules for new lots. Existing lots keep their own rules.
    function setRules(
        uint256 minBuy,
        uint256 maxBuy,
        uint16 buyFeeBps,
        uint16 profitFeeBps,
        uint16 compRatioBps,
        uint16 compCapBps,
        uint16 waitDays,
        uint256 directMin
    ) external onlyOwner {
        if (minBuy < ONE_USDT || maxBuy < minBuy || maxBuy > 1e9 * ONE_USDT) revert BadConfig();
        if (buyFeeBps > MAX_BUY_FEE_BPS || profitFeeBps > MAX_PROFIT_FEE_BPS) revert BadConfig();
        if (compRatioBps > BPS || compCapBps > BPS || waitDays == 0 || waitDays > 3650) revert BadConfig();
        if (directMin > 1e9 * ONE_USDT) revert BadConfig();
        Params storage p = params;
        p.minBuy = uint128(minBuy);
        p.maxBuy = uint128(maxBuy);
        p.buyFeeBps = buyFeeBps;
        p.profitFeeBps = profitFeeBps;
        p.compRatioBps = compRatioBps;
        p.compCapBps = compCapBps;
        p.waitDays = waitDays;
        p.directMin = uint128(directMin);
        rev++;
        emit RulesSet(minBuy, maxBuy, buyFeeBps, profitFeeBps, compRatioBps, compCapBps, waitDays, directMin);
    }

    /// @notice How the profit fee is split (parts): insurance : ecosystem : referral.
    function setSplit(uint8 ins, uint8 eco, uint8 dyn) external onlyOwner {
        if (uint256(ins) + eco + dyn == 0) revert BadConfig();
        (params.splitIns, params.splitEco, params.splitDyn) = (ins, eco, dyn);
        emit SplitSet(ins, eco, dyn);
    }

    /// @notice Buy-time price protection (ticks; 100 ≈ 1%).
    function setMaxDev(uint16 ticks) external onlyOwner {
        if (ticks < 10 || ticks > 2000) revert BadConfig();
        params.maxDevTicks = ticks;
        emit MaxDevSet(ticks);
    }

    function setPoolWallet(address w) external onlyOwner {
        if (w == address(0) || w == address(this)) revert BadConfig();
        poolWallet = w;
        emit PoolWalletSet(w);
    }

    function setSub(address a, bool on) external onlyOwner {
        if (a == address(0) || a == owner) revert BadConfig();
        if (on == isSub[a]) return;
        if (on) {
            if (_subs.length >= MAX_SUBS) revert BadConfig();
            _subs.push(a);
        } else {
            for (uint256 i; i < _subs.length; i++) {
                if (_subs[i] == a) {
                    _subs[i] = _subs[_subs.length - 1];
                    _subs.pop();
                    break;
                }
            }
        }
        isSub[a] = on;
        emit SubSet(a, on);
    }

    /// @notice Move bookkeeping between books (the money stays in the pool wallet).
    function moveBook(uint8 from, uint8 to, uint256 amount) external onlyOwner {
        if (from > 2 || to > 2 || from == to || amount == 0 || amount > _books[from].left) revert BadAmount();
        _books[from].left -= uint128(amount);
        _books[to].left += uint128(amount);
        emit BookChanged(from, -int256(amount), _books[from].left, 3);
        emit BookChanged(to, int256(amount), _books[to].left, 3);
    }

    /// @notice Set a book's remaining figure directly (e.g. to count USDT already sitting in the pool wallet).
    function adjustBook(uint8 book, uint256 left) external onlyOwner {
        if (book > 2 || left > type(uint128).max) revert BadAmount();
        int256 d = int256(left) - int256(uint256(_books[book].left));
        _books[book].left = uint128(left);
        emit BookChanged(book, d, left, 4);
    }

    /// @notice Pause / resume new buys. Selling is never paused.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    // ================================================================== views

    function beijingDay() public view returns (uint256) {
        return (block.timestamp + 8 hours) / 1 days;
    }

    function getParams() external view returns (Params memory) {
        return params;
    }

    function lotCount(address u) external view returns (uint256) {
        return _lots[u].length;
    }

    function lotsOf(address u) external view returns (Lot[] memory) {
        return _lots[u];
    }

    function lotOf(address u, uint256 id) external view returns (Lot memory) {
        return _lots[u][id];
    }

    function books() external view returns (Book[3] memory) {
        return _books;
    }

    function subs() external view returns (address[] memory) {
        return _subs;
    }

    /// @notice USDT left today: this wallet, network-wide.
    function quotaLeft(address u) external view returns (uint256 mine, uint256 network) {
        uint256 day = beijingDay();
        Params memory p = params;
        uint256 a = walletDaySpent[day][u];
        uint256 b = daySpent[day];
        mine = a < p.walletDaily ? p.walletDaily - a : 0;
        network = b < p.globalDaily ? p.globalDaily - b : 0;
        if (mine > network) mine = network;
    }

    /// @notice Pool wallet's USDT balance and its remaining allowance to this contract.
    function poolWalletStatus() external view returns (uint256 balance, uint256 allowance) {
        return (USDT.balanceOf(poolWallet), USDT.allowance(poolWallet, address(this)));
    }

    /// @notice 1 POP in USDT at the 15-minute average and at the spot price (ok=false: no average available).
    function prices() external view returns (bool ok, uint256 avg, uint256 spot) {
        int24 tw;
        int24 sp;
        (ok, tw, sp) = _ticks();
        uint256 one = 10 ** IERC20Metadata(address(POP)).decimals();
        if (ok) avg = V3Math.quoteAtTick(tw, one, address(POP), address(USDT));
        (, sp,,,,,) = POOL.slot0();
        spot = V3Math.quoteAtTick(sp, one, address(POP), address(USDT));
    }

    /// @notice Referral standing in this pool: holding by cost, effective directs, levels open (<= 7), earned.
    function userInfo(address u)
        external
        view
        returns (uint256 hold, uint256 directs, uint256 levels, uint256 earned, bool effective, address upline)
    {
        hold = holdCost[u];
        directs = effDirects[u];
        levels = directs < LEVELS ? directs : LEVELS;
        earned = refEarned[u];
        effective = hold >= params.directMin;
        (upline,) = MINER.getUser(u);
    }

    // ================================================================== internals

    function _credit(uint8 b, uint256 amount, uint8 reason) internal {
        if (amount == 0) return;
        Book storage k = _books[b];
        k.left += uint128(amount);
        k.inflow += uint128(amount);
        emit BookChanged(b, int256(amount), k.left, reason);
    }

    /// pull compensation from the pool wallet straight to the seller; never blocks the sale
    function _payComp(address to, uint256 id, uint256 want) internal returns (uint256 paid) {
        if (want == 0) return 0;
        address w = poolWallet;
        uint256 cap = Math.min(_books[0].left, Math.min(USDT.balanceOf(w), USDT.allowance(w, address(this))));
        paid = want < cap ? want : cap;
        if (paid == 0) {
            emit CompShort(to, id, want);
            return 0;
        }
        uint256 b = USDT.balanceOf(to);
        (bool s, bytes memory ret) = address(USDT).call(abi.encodeCall(IERC20.transferFrom, (w, to, paid)));
        if (!s || (ret.length != 0 && !abi.decode(ret, (bool))) || USDT.balanceOf(to) - b != paid) {
            emit CompShort(to, id, want);
            return 0;
        }
        Book storage k = _books[0];
        k.left -= uint128(paid);
        k.outflow += uint128(paid);
        totalComp += paid;
        emit BookChanged(0, -int256(paid), k.left, 2);
        if (paid < want) emit CompShort(to, id, want);
    }

    function _distribute(address seller, uint256 fee) internal {
        Params memory p = params;
        uint256 parts = uint256(p.splitIns) + p.splitEco + p.splitDyn;
        uint256 ins = (fee * p.splitIns) / parts;
        uint256 eco = (fee * p.splitEco) / parts;
        uint256 dyn = fee - ins - eco;
        uint256 share = dyn / LEVELS;
        uint256 paid;
        address cur = seller;
        for (uint256 lv = 1; lv <= LEVELS; lv++) {
            (address up,) = MINER.getUser(cur);
            if (up == address(0)) break;
            if (share > 0 && effDirects[up] >= lv) {
                USDT.safeTransfer(up, share);
                paid += share;
                refEarned[up] += share;
                emit RefPaid(seller, up, uint8(lv), share);
            }
            cur = up;
        }
        uint256 kept = dyn - paid;
        totalRef += paid;
        uint256 toWallet = ins + eco + kept;
        if (toWallet > 0) USDT.safeTransfer(poolWallet, toWallet);
        _credit(0, ins, 1);
        _credit(1, eco, 1);
        _credit(2, kept, 1);
        emit FeeSplit(seller, ins, eco, kept);
    }

    function _updateEff(address u) internal {
        (address up,) = MINER.getUser(u);
        address target = holdCost[u] >= params.directMin ? up : address(0);
        address cur = countedUnder[u];
        if (cur == target) return;
        if (cur != address(0)) effDirects[cur]--;
        if (target != address(0)) effDirects[target]++;
        countedUnder[u] = target;
        emit EffChanged(u, target == address(0) ? cur : target, target != address(0));
    }

    function _ticks() internal view returns (bool ok, int24 tw, int24 spot) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        try POOL.observe(ago) returns (int56[] memory cum, uint160[] memory) {
            int56 delta = cum[1] - cum[0];
            int56 w = int56(uint56(TWAP_WINDOW));
            int24 t = int24(delta / w);
            if (delta < 0 && (delta % w != 0)) t--;
            tw = t;
            ok = true;
        } catch {
            ok = false;
        }
        (, spot,,,,,) = POOL.slot0();
    }

    function _dist(int24 a, int24 b) internal pure returns (uint256) {
        return a > b ? uint256(int256(a) - int256(b)) : uint256(int256(b) - int256(a));
    }

    /// exact-input swap in the POP/USDT pool; returns what arrived here
    function _swap(bool usdtIn, uint256 amountIn) internal returns (uint256 out) {
        bool zeroForOne = usdtIn == USDT_IS_0;
        IERC20 outT = usdtIn ? POP : USDT;
        uint256 b = outT.balanceOf(address(this));
        _inSwap = true;
        _swapUsdtIn = usdtIn;
        (int256 a0, int256 a1) = POOL.swap(
            address(this), zeroForOne, int256(amountIn), zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1, ""
        );
        _inSwap = false;
        int256 paid = zeroForOne ? a0 : a1;
        if (paid <= 0 || uint256(paid) != amountIn) revert Slippage(); // partial fill
        out = outT.balanceOf(address(this)) - b;
    }

    function _swapCallback(int256 a0, int256 a1) internal {
        require(msg.sender == address(POOL) && _inSwap, "cb");
        int256 owed = a0 > 0 ? a0 : a1;
        if (owed > 0) (_swapUsdtIn ? USDT : POP).safeTransfer(msg.sender, uint256(owed));
    }

    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _swapCallback(a0, a1);
    }

    /// Uniswap-V3-compatible callback name (local test pools are built from Uniswap V3 sources)
    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _swapCallback(a0, a1);
    }
}
