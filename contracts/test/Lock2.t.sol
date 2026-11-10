// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {XiyangLock2} from "../src/XiyangLock2.sol";
import {MockSwapPair} from "./utils/LockMocks.sol";

/// 锁仓第二版（喜羊羊 + POP）: prices here: POP = 0.01 USDT, 喜羊羊 = 0.1 POP = 0.001 USDT.
/// Referral rights = mining 入金额度 >= 100 only (deposit both tokens: 入金额度 ~ 2 x usdtAmt).
contract Lock2Test is BaseTest {
    XiyangLock2 lk;
    MockSwapPair pair;
    address a = makeAddr("a");
    address b = makeAddr("b");
    address c = makeAddr("c");
    address d = makeAddr("d");
    address e = makeAddr("e");
    uint8 constant X = 0;
    uint8 constant P = 1;

    function setUp() public override {
        super.setUp();
        pair = new MockSwapPair(address(xyy), address(pop));
        xyy.mint(address(pair), 100_000_000e18);
        pop.mint(address(pair), 10_000_000e18);
        pair.sync();
        lk = new XiyangLock2(_cfg());
        pop.mint(operator, 1_000_000_000e18);
        vm.startPrank(operator);
        xyy.approve(address(lk), 1_000_000_000e18);
        pop.approve(address(lk), 1_000_000_000e18);
        vm.stopPrank();
    }

    function _cfg() internal view returns (XiyangLock2.Config memory) {
        return XiyangLock2.Config({
            miner: address(miner),
            pool: pool,
            rewardPair: address(pair),
            pop: address(pop),
            usdt: address(usdt),
            reward: address(xyy),
            operator: operator
        });
    }

    // ---------------------------------------------------------------- helpers

    function _tok(uint8 coin) internal view returns (address) {
        return coin == X ? address(xyy) : address(pop);
    }

    function _bal(uint8 coin, address u) internal view returns (uint256) {
        return coin == X ? xyy.balanceOf(u) : pop.balanceOf(u);
    }

    function _lockW(address u, uint8 coin, uint256 amount, uint16 days_) internal returns (uint256 id) {
        if (coin == X) xyy.mint(u, amount);
        else pop.mint(u, amount);
        vm.startPrank(u);
        if (coin == X) xyy.approve(address(lk), amount);
        else pop.approve(address(lk), amount);
        id = lk.lock(coin, amount, days_);
        vm.stopPrank();
    }

    function _buy(address u, uint256 usdtIn, uint16 bps, uint16 days_) internal returns (uint256 id) {
        usdt.mint(u, usdtIn);
        vm.startPrank(u);
        usdt.approve(address(lk), usdtIn);
        id = lk.buyAndLock(usdtIn, bps, days_, 0, block.timestamp + 600);
        vm.stopPrank();
    }

    /// mining: 入金额度 ~ 2 x usdtAmt, bound to `ref`
    function _mine(address u, uint256 usdtAmt, address ref) internal {
        _depositBoth(u, usdtAmt, ref);
    }

    function _claim(address u) internal returns (uint256 x, uint256 p) {
        vm.prank(u);
        return lk.claim();
    }

    function _ref(address u, uint8 coin) internal view returns (uint256) {
        (, uint256[2] memory r) = lk.rewardsOf(u);
        return r[coin];
    }

    // ---------------------------------------------------------------- plans, own reward, release (both coins)

    function test_xyy100_ownReward5_releaseEvery24h() public {
        uint256 bal0 = xyy.balanceOf(b);
        _lockW(b, X, 10_000e18, 100);
        assertEq(xyy.balanceOf(b) - bal0, 500e18, "own 5% at once");
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(b);
        vm.expectRevert(XiyangLock2.BadAmount.selector);
        lk.claim();
        vm.warp(block.timestamp + 1);
        (uint256 x,) = _claim(b);
        assertEq(x, 100e18, "1% after 24 h");
        vm.warp(block.timestamp + 24 days + 5 hours);
        (x,) = _claim(b);
        assertEq(x, 2_400e18, "25 releases in total");
        vm.warp(block.timestamp + 200 days);
        (x,) = _claim(b);
        assertEq(x, 7_500e18, "everything by day 100");
        assertEq(lk.firstOpen(b), 1);
    }

    function test_pop200_ownReward10InPop_releaseHalfPercent() public {
        uint256 p0 = pop.balanceOf(b);
        uint256 x0 = xyy.balanceOf(b);
        _lockW(b, P, 20_000e18, 200);
        assertEq(pop.balanceOf(b) - p0, 2_000e18, "own 10% in POP at once");
        assertEq(xyy.balanceOf(b), x0, "no xyy for a POP lock");
        vm.warp(block.timestamp + 3 days);
        (uint256 x, uint256 p) = _claim(b);
        assertEq(x, 0);
        assertEq(p, 300e18, "0.5% x 3");
        vm.warp(block.timestamp + 197 days);
        (, p) = _claim(b);
        assertEq(p, 19_700e18);
        assertEq(lk.totalLocked(P), 20_000e18);
        assertEq(lk.totalClaimed(P), 20_000e18);
        assertEq(lk.totalLocked(X), 0);
    }

    function test_bothCoins_oneClaim_balancesPerCoin() public {
        _lockW(b, X, 10_000e18, 100);
        _lockW(b, P, 4_000e18, 200);
        vm.warp(block.timestamp + 2 days);
        (uint256[2] memory still, uint256[2] memory cl) = lk.balances(b);
        assertEq(cl[0], 200e18);
        assertEq(cl[1], 40e18);
        assertEq(still[0], 9_800e18);
        assertEq(still[1], 3_960e18);
        uint256 x0 = xyy.balanceOf(b);
        uint256 p0 = pop.balanceOf(b);
        (uint256 x, uint256 p) = _claim(b);
        assertEq(x, 200e18);
        assertEq(p, 40e18);
        assertEq(xyy.balanceOf(b) - x0, 200e18, "xyy arrived");
        assertEq(pop.balanceOf(b) - p0, 40e18, "POP arrived");
        XiyangLock2.Lock[] memory ls = lk.locksOf(b, 0, 10);
        assertEq(ls.length, 2);
        assertEq(ls[0].coin, X);
        assertEq(ls[1].coin, P);
        assertEq(ls[1].days_, 200);
    }

    function test_badPlan_badCoin_zero_revert() public {
        pop.mint(b, 10e18);
        vm.startPrank(b);
        pop.approve(address(lk), 10e18);
        vm.expectRevert(XiyangLock2.BadPlan.selector);
        lk.lock(P, 1e18, 150);
        vm.expectRevert(XiyangLock2.BadCoin.selector);
        lk.lock(2, 1e18, 100);
        vm.expectRevert(XiyangLock2.BadAmount.selector);
        lk.lock(P, 0, 100);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- referral: only mining >= 100

    function test_referral_onlyMiningEligibility_noLockNeeded() public {
        _mine(a, 60e18, address(0)); // 120 USD in mining, never locked anything
        assertTrue(lk.canRefer(a));
        _mine(b, 10e18, a);
        uint256 a0 = xyy.balanceOf(a);
        _lockW(b, X, 10_000e18, 100);
        assertEq(xyy.balanceOf(a) - a0, 500e18, "upline 5% in xyy");
        uint256 ap = pop.balanceOf(a);
        _lockW(b, P, 10_000e18, 200);
        assertEq(pop.balanceOf(a) - ap, 1_000e18, "upline 10% in POP");
        assertEq(_ref(a, X), 500e18);
        assertEq(_ref(a, P), 1_000e18);
    }

    function test_referral_miningBelow100_passesUp() public {
        _mine(a, 60e18, address(0)); // eligible
        _mine(b, 40e18, a); // 80: not eligible
        _mine(c, 10e18, b);
        assertFalse(lk.canRefer(b));
        uint256 b0 = pop.balanceOf(b);
        uint256 a0 = pop.balanceOf(a);
        pop.mint(c, 5_000e18);
        vm.startPrank(c);
        pop.approve(address(lk), 5_000e18);
        vm.expectEmit(true, true, false, true, address(lk));
        emit XiyangLock2.RefRewardPaid(c, a, P, 2, 250e18);
        lk.lock(P, 5_000e18, 100);
        vm.stopPrank();
        assertEq(pop.balanceOf(b), b0, "direct referrer not eligible: nothing");
        assertEq(pop.balanceOf(a) - a0, 250e18, "2nd generation gets it");
    }

    function test_referral_thirdGeneration_onlyOnePaid() public {
        _mine(a, 60e18, address(0));
        _mine(b, 60e18, a); // eligible too, but is 4th from e
        _mine(c, 10e18, b); // not eligible
        _mine(d, 10e18, c); // not eligible
        _mine(e, 10e18, d);
        // e -> d (1) -> c (2) -> b (3, eligible) ; a is 4th
        uint256 a0 = xyy.balanceOf(a);
        uint256 b0 = xyy.balanceOf(b);
        _lockW(e, X, 10_000e18, 200);
        assertEq(xyy.balanceOf(b) - b0, 1_000e18, "3rd generation");
        assertEq(xyy.balanceOf(a), a0, "only one wallet is paid");
    }

    function test_referral_beyondThreeGenerations_notPaid() public {
        _mine(a, 60e18, address(0)); // eligible, 4th above e
        _mine(b, 10e18, a);
        _mine(c, 10e18, b);
        _mine(d, 10e18, c);
        _mine(e, 10e18, d);
        uint256 a0 = xyy.balanceOf(a);
        uint256 op0 = xyy.balanceOf(operator);
        _lockW(e, X, 10_000e18, 100);
        assertEq(xyy.balanceOf(a), a0, "not beyond 3 generations");
        assertEq(op0 - xyy.balanceOf(operator), 500e18, "only the own reward left the operator wallet");
        assertEq(lk.totalRefUnpaid(X), 500e18);
    }

    function test_noReferrer_referralShareStays() public {
        uint256 op0 = pop.balanceOf(operator);
        _lockW(e, P, 1_000e18, 100);
        assertEq(op0 - pop.balanceOf(operator), 50e18);
        assertEq(lk.totalRefUnpaid(P), 50e18);
    }

    function test_eligibility_isCheckedAtEachLock() public {
        _mine(a, 60e18, address(0));
        _mine(b, 10e18, a);
        uint128 liq = miner.getUser(a).liquidity;
        vm.prank(a);
        miner.withdraw(liq, 0, 0, block.timestamp + 600);
        assertFalse(lk.canRefer(a), "withdrew from mining: no rights");
        uint256 a0 = xyy.balanceOf(a);
        _lockW(b, X, 10_000e18, 100);
        assertEq(xyy.balanceOf(a), a0);
        _mine(a, 60e18, address(0));
        assertTrue(lk.canRefer(a), "back when eligible again");
        _lockW(b, X, 10_000e18, 100);
        assertEq(xyy.balanceOf(a) - a0, 500e18);
    }

    // ---------------------------------------------------------------- buy with USDT (喜羊羊 only)

    function test_buyAndLock_all() public {
        uint256 id = _buy(b, 100e18, 10_000, 100);
        XiyangLock2.Lock[] memory ls = lk.locksOf(b, 0, 10);
        assertEq(id, 0);
        assertEq(ls[0].coin, X);
        assertGt(ls[0].amount, 95_000e18, "~100,000 xyy for 100 USDT");
        assertEq(xyy.balanceOf(b), (uint256(ls[0].amount) * 500) / 10_000, "only the reward in the wallet");
    }

    function test_buyAndLock_80_20() public {
        _buy(b, 100e18, 8_000, 200);
        XiyangLock2.Lock[] memory ls = lk.locksOf(b, 0, 10);
        uint256 locked = ls[0].amount;
        uint256 wallet = xyy.balanceOf(b) - (locked * 1000) / 10_000;
        assertApproxEqAbs(wallet * 4, locked, 4, "20% to the wallet");
    }

    function test_buyAndLock_guards() public {
        usdt.mint(b, 100e18);
        vm.startPrank(b);
        usdt.approve(address(lk), 100e18);
        vm.expectRevert(XiyangLock2.Slippage.selector);
        lk.buyAndLock(100e18, 10_000, 100, 200_000e18, block.timestamp + 600);
        vm.expectRevert(XiyangLock2.Expired.selector);
        lk.buyAndLock(100e18, 10_000, 100, 0, block.timestamp - 1);
        vm.expectRevert(XiyangLock2.BadAmount.selector);
        lk.buyAndLock(100e18, 0, 100, 0, block.timestamp + 600);
        vm.expectRevert(XiyangLock2.BadAmount.selector);
        lk.buyAndLock(100e18, 10_001, 100, 0, block.timestamp + 600);
        vm.stopPrank();
    }

    function test_buyAndLock_doesNotTouchLockedPop() public {
        _lockW(c, P, 50_000e18, 100);
        _buy(b, 100e18, 10_000, 100);
        assertEq(pop.balanceOf(address(lk)), 50_000e18, "locked POP stays");
    }

    // ---------------------------------------------------------------- operator, admin

    function test_operatorCannotPay_lockDoesNotHappen() public {
        vm.prank(operator);
        pop.approve(address(lk), 10e18); // too little for 5% of 1,000
        pop.mint(b, 1_000e18);
        vm.startPrank(b);
        pop.approve(address(lk), 1_000e18);
        vm.expectRevert();
        lk.lock(P, 1_000e18, 100);
        vm.stopPrank();
        assertEq(pop.balanceOf(b), 1_000e18, "nothing taken");
        assertEq(lk.lockCount(b), 0);
    }

    function test_pause_blocksNewLocks_notClaims() public {
        _lockW(b, X, 10_000e18, 100);
        vm.prank(b);
        vm.expectRevert();
        lk.setPaused(true);
        vm.prank(operator);
        lk.setPaused(true);
        pop.mint(c, 1e18);
        vm.startPrank(c);
        pop.approve(address(lk), 1e18);
        vm.expectRevert(XiyangLock2.Paused.selector);
        lk.lock(P, 1e18, 100);
        vm.stopPrank();
        usdt.mint(c, 1e18);
        vm.startPrank(c);
        usdt.approve(address(lk), 1e18);
        vm.expectRevert(XiyangLock2.Paused.selector);
        lk.buyAndLock(1e18, 10_000, 100, 0, block.timestamp + 600);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days);
        (uint256 x,) = _claim(b);
        assertEq(x, 100e18, "claims keep working");
        vm.prank(operator);
        lk.setPaused(false);
        _lockW(c, P, 1e18, 100);
    }

    function test_ownerIsOperator_operatorCannotLock() public {
        assertEq(lk.owner(), operator);
        pop.mint(operator, 0);
        vm.startPrank(operator);
        vm.expectRevert(XiyangLock2.OperatorCannotLock.selector);
        lk.lock(P, 1e18, 100);
        vm.stopPrank();
    }

    function test_lockedEvent_carriesReferrer() public {
        _mine(a, 60e18, address(0));
        vm.prank(b);
        miner.bind(a); // bound only, never deposited
        pop.mint(b, 1_000e18);
        vm.startPrank(b);
        pop.approve(address(lk), 1_000e18);
        vm.expectEmit(true, true, true, true, address(lk));
        emit XiyangLock2.Locked(b, 0, a, P, 100, 1_000e18, 50e18, block.timestamp);
        lk.lock(P, 1_000e18, 100);
        vm.stopPrank();
    }

    function test_relock_rewardAgain() public {
        uint256 p0 = pop.balanceOf(b);
        _lockW(b, P, 1_000e18, 100);
        _lockW(b, P, 1_000e18, 100);
        assertEq(pop.balanceOf(b) - p0, 100e18, "5% each time");
        assertEq(lk.lockCount(b), 2);
    }

    function test_badConfig() public {
        XiyangLock2.Config memory k = _cfg();
        k.pop = address(usdt);
        vm.expectRevert();
        new XiyangLock2(k);
        k = _cfg();
        MockSwapPair other = new MockSwapPair(address(pop), address(usdt)); // no 喜羊羊
        k.rewardPair = address(other);
        vm.expectRevert(XiyangLock2.BadConfig.selector);
        new XiyangLock2(k);
        k = _cfg();
        k.operator = address(0);
        vm.expectRevert();
        new XiyangLock2(k);
    }

    // ---------------------------------------------------------------- mining untouched

    function test_miningUntouched() public {
        _mine(a, 60e18, address(0));
        _mine(b, 100e18, a);
        uint256 tp = miner.totalPrincipal();
        uint256 tl = miner.totalLiquidity();
        (uint256 p0, uint256 d0) = miner.pendingUsd(a);
        _lockW(b, X, 10_000e18, 100);
        _lockW(b, P, 10_000e18, 200);
        _buy(b, 500e18, 8_000, 200);
        assertEq(miner.totalPrincipal(), tp);
        assertEq(miner.totalLiquidity(), tl);
        (uint256 p1, uint256 d1) = miner.pendingUsd(a);
        assertEq(p1, p0);
        assertEq(d1, d0, "mining dynamic reward unchanged by lock referral rewards");
    }

    // ---------------------------------------------------------------- fuzz: never more than locked

    function testFuzz_releaseNeverExceedsLocked(uint96 amt, uint96 amt2, uint16 step, bool long) public {
        uint256 ax = bound(uint256(amt), 1, 10_000_000e18);
        uint256 ap = bound(uint256(amt2), 1, 10_000_000e18);
        uint256 st = bound(uint256(step), 1 hours, 40 days);
        _lockW(b, X, ax, long ? 200 : 100);
        _lockW(b, P, ap, long ? 100 : 200);
        uint256 tx_;
        uint256 tp;
        for (uint256 i; i < 12; ++i) {
            vm.warp(block.timestamp + st);
            (, uint256[2] memory cl) = lk.balances(b);
            if (cl[0] + cl[1] > 0) {
                (uint256 x, uint256 p) = _claim(b);
                tx_ += x;
                tp += p;
            }
            assertLe(tx_, ax);
            assertLe(tp, ap);
        }
        vm.warp(block.timestamp + 201 days);
        (, uint256[2] memory rest) = lk.balances(b);
        if (rest[0] + rest[1] > 0) {
            (uint256 x, uint256 p) = _claim(b);
            tx_ += x;
            tp += p;
        }
        assertEq(tx_, ax, "exactly the locked xyy in the end");
        assertEq(tp, ap, "exactly the locked POP in the end");
    }
}
