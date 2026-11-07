// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {XiyangLock} from "../src/XiyangLock.sol";
import {MockSwapPair} from "./utils/LockMocks.sol";
import {MockERC20} from "./utils/Mocks.sol";

/// 锁仓: prices in this setup: POP = 0.01 USDT, 喜羊羊 = 0.1 POP = 0.001 USDT.
contract LockTest is BaseTest {
    XiyangLock lk;
    MockSwapPair pair;
    address a = makeAddr("a");
    address b = makeAddr("b");
    address c = makeAddr("c");
    address d = makeAddr("d");
    address e = makeAddr("e");

    function setUp() public override {
        super.setUp();
        pair = new MockSwapPair(address(xyy), address(pop));
        xyy.mint(address(pair), 100_000_000e18);
        pop.mint(address(pair), 10_000_000e18);
        pair.sync();
        lk = new XiyangLock(_lockCfg());
        vm.prank(operator);
        xyy.approve(address(lk), 1_000_000_000e18);
    }

    function _lockCfg() internal view returns (XiyangLock.Config memory) {
        return XiyangLock.Config({
            miner: address(miner),
            pool: pool,
            rewardPair: address(pair),
            pop: address(pop),
            usdt: address(usdt),
            reward: address(xyy),
            operator: operator,
            thresholdUsd: 300e18
        });
    }

    // ---------------------------------------------------------------- helpers

    function _lockW(address u, uint256 amount, uint16 days_) internal returns (uint256 id) {
        xyy.mint(u, amount);
        vm.startPrank(u);
        xyy.approve(address(lk), amount);
        id = lk.lock(amount, days_);
        vm.stopPrank();
    }

    function _buy(address u, uint256 usdtIn, uint16 bps, uint16 days_) internal returns (uint256 id) {
        usdt.mint(u, usdtIn);
        vm.startPrank(u);
        usdt.approve(address(lk), usdtIn);
        id = lk.buyAndLock(usdtIn, bps, days_, 0, block.timestamp + 600);
        vm.stopPrank();
    }

    /// mining: 入金额度 ~ 2 x usdtAmt (both tokens), bound to `ref`
    function _mine(address u, uint256 usdtAmt, address ref) internal {
        _depositBoth(u, usdtAmt, ref);
    }

    /// referral rights: mining >= 100 and 300 USDT locked (300 USDT = 300,000 喜羊羊 here)
    function _rights(address u, address ref) internal {
        _mine(u, 60e18, ref);
        _lockW(u, 300_000e18, 100);
        assertTrue(lk.canRefer(u), "rights");
    }

    function _claim(address u) internal returns (uint256) {
        vm.prank(u);
        return lk.claim();
    }

    // ---------------------------------------------------------------- plans, own reward, release

    function test_lock100_ownReward5_releaseEvery24h() public {
        _mine(b, 10e18, address(0));
        uint256 bal0 = xyy.balanceOf(b);
        _lockW(b, 10_000e18, 100);
        assertEq(xyy.balanceOf(b) - bal0, 500e18, "own 5% at once");
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(b);
        vm.expectRevert(XiyangLock.BadAmount.selector);
        lk.claim();
        vm.warp(block.timestamp + 1);
        assertEq(_claim(b), 100e18, "1% after 24 h");
        vm.warp(block.timestamp + 24 days + 5 hours);
        assertEq(_claim(b), 2_400e18, "25 releases in total");
        (uint256 still, uint256 cl) = lk.balances(b);
        assertEq(still, 7_500e18);
        assertEq(cl, 0);
        vm.warp(block.timestamp + 200 days);
        assertEq(_claim(b), 7_500e18, "everything by day 100");
        vm.prank(b);
        vm.expectRevert(XiyangLock.BadAmount.selector);
        lk.claim();
        assertEq(lk.firstOpen(b), 1);
    }

    function test_lock200_ownReward10_releaseHalfPercent() public {
        uint256 bal0 = xyy.balanceOf(b);
        _lockW(b, 10_000e18, 200);
        assertEq(xyy.balanceOf(b) - bal0, 1_000e18, "own 10% at once");
        vm.warp(block.timestamp + 3 days);
        assertEq(_claim(b), 150e18, "0.5% x 3");
        vm.warp(block.timestamp + 197 days);
        assertEq(_claim(b), 9_850e18);
    }

    function test_badPlan_reverts() public {
        xyy.mint(b, 1e18);
        vm.startPrank(b);
        xyy.approve(address(lk), 1e18);
        vm.expectRevert(XiyangLock.BadPlan.selector);
        lk.lock(1e18, 150);
        vm.stopPrank();
    }

    function test_ownRewardEvenWithoutReferrerOrMinimum() public {
        uint256 bal0 = xyy.balanceOf(e);
        _lockW(e, 100e18, 100); // 0.1 USDT worth, no referrer, never mined
        assertEq(xyy.balanceOf(e) - bal0, 5e18);
        assertEq(lk.totalRefUnpaid(), 5e18, "no referrer: referral share not paid");
    }

    // ---------------------------------------------------------------- referral rights and rewards

    function test_referral_directWithRights() public {
        _rights(a, address(0));
        _mine(b, 10e18, a);
        uint256 a0 = xyy.balanceOf(a);
        _lockW(b, 10_000e18, 100);
        assertEq(xyy.balanceOf(a) - a0, 500e18, "upline 5%");
        a0 = xyy.balanceOf(a);
        _lockW(b, 10_000e18, 200);
        assertEq(xyy.balanceOf(a) - a0, 1_000e18, "upline 10%");
        assertEq(lk.refRewardOf(a), 1_500e18, "referral total");
        assertEq(lk.ownRewardOf(b), 1_500e18, "own total");
    }

    function test_referral_needsBothConditions() public {
        // locked 300 but not eligible in mining (入金额度 20 < 100)
        _mine(a, 10e18, address(0));
        _lockW(a, 300_000e18, 100);
        assertFalse(lk.canRefer(a));
        _mine(b, 10e18, a);
        uint256 a0 = xyy.balanceOf(a);
        _lockW(b, 10_000e18, 100);
        assertEq(xyy.balanceOf(a), a0, "no mining eligibility: nothing");
        // eligible in mining but locked only 290 USDT worth
        _mine(c, 60e18, address(0));
        _lockW(c, 290_000e18, 100);
        assertFalse(lk.canRefer(c));
        _mine(d, 10e18, c);
        uint256 c0 = xyy.balanceOf(c);
        _lockW(d, 10_000e18, 100);
        assertEq(xyy.balanceOf(c), c0, "locked 290 < 300: nothing");
    }

    function test_rights_cumulativeAndPermanent() public {
        _mine(a, 60e18, address(0));
        _lockW(a, 150_000e18, 100);
        assertFalse(lk.canRefer(a));
        _lockW(a, 150_000e18, 100);
        assertTrue(lk.rightsReached(a), "two locks add up to 300");
        assertTrue(lk.canRefer(a));
        // everything released and taken out: rights stay
        vm.warp(block.timestamp + 101 days);
        _keep(0, 1);
        _claim(a);
        (uint256 still, uint256 cl) = lk.balances(a);
        assertEq(still + cl, 0);
        miner.checkpoint();
        assertTrue(lk.canRefer(a), "permanent");
    }

    function test_rights_lostWithMiningEligibility_backWhenEligible() public {
        _rights(a, address(0));
        // withdraw all LP from mining
        uint128 liq = miner.getUser(a).liquidity;
        vm.prank(a);
        miner.withdraw(liq, 0, 0, block.timestamp + 600);
        assertFalse(lk.canRefer(a), "mining condition is current");
        _mine(a, 60e18, address(0));
        assertTrue(lk.canRefer(a), "lock rights kept, mining again -> back");
    }

    function test_threshold_raiseKeepsRights_lowerGrants() public {
        _rights(a, address(0));
        _mine(c, 60e18, address(0));
        _lockW(c, 200_000e18, 100); // 200 USDT
        assertFalse(lk.canRefer(c));
        vm.prank(operator);
        lk.setThresholdUsd(1_000e18);
        assertTrue(lk.canRefer(a), "already reached: kept");
        vm.prank(operator);
        lk.setThresholdUsd(200e18);
        assertTrue(lk.canRefer(c), "lower threshold: now enough");
        vm.prank(a);
        vm.expectRevert();
        lk.setThresholdUsd(1e18);
        vm.prank(operator);
        vm.expectRevert(XiyangLock.BadConfig.selector);
        lk.setThresholdUsd(0);
    }

    /// e <- a <- b <- c <- d (each refers the next). d locks.
    function _chain() internal {
        _mine(e, 10e18, address(0));
        _mine(a, 10e18, e);
        _mine(b, 10e18, a);
        _mine(c, 10e18, b);
        _mine(d, 10e18, c);
    }

    function test_passUp_secondGeneration() public {
        _chain();
        _mine(b, 50e18, address(0)); // b: 入金额度 120
        _lockW(b, 300_000e18, 100);
        assertTrue(lk.canRefer(b) && !lk.canRefer(c));
        uint256 b0 = xyy.balanceOf(b);
        _lockW(d, 10_000e18, 100);
        assertEq(xyy.balanceOf(b) - b0, 500e18);
    }

    function test_passUp_thirdGeneration_onlyOnePaid() public {
        _chain();
        _mine(a, 50e18, address(0));
        _lockW(a, 300_000e18, 100);
        _mine(e, 50e18, address(0));
        _lockW(e, 300_000e18, 100);
        uint256 a0 = xyy.balanceOf(a);
        uint256 e0 = xyy.balanceOf(e);
        _lockW(d, 10_000e18, 200);
        assertEq(xyy.balanceOf(a) - a0, 1_000e18, "a = 3rd generation gets it");
        assertEq(xyy.balanceOf(e), e0, "only one wallet is paid");
    }

    function test_passUp_beyondThreeGenerations_notPaid() public {
        _chain();
        _mine(e, 50e18, address(0));
        _lockW(e, 300_000e18, 100); // e = 4th generation above d
        uint256 e0 = xyy.balanceOf(e);
        uint256 op0 = xyy.balanceOf(operator);
        uint256 unpaid0 = lk.totalRefUnpaid();
        _lockW(d, 10_000e18, 100);
        assertEq(xyy.balanceOf(e), e0, "4th generation: nothing");
        assertEq(lk.totalRefUnpaid() - unpaid0, 500e18);
        assertEq(op0 - xyy.balanceOf(operator), 500e18, "only d's own 5% left the operator wallet");
    }

    // ---------------------------------------------------------------- buy and lock

    function test_buyAndLock_all() public {
        _rights(a, address(0));
        _mine(b, 10e18, a);
        uint256 a0 = xyy.balanceOf(a);
        uint256 w0 = xyy.balanceOf(b);
        _buy(b, 1_000e18, 10_000, 100);
        XiyangLock.Lock[] memory ls = lk.locksOf(b, 0, 10);
        assertEq(ls.length, 1);
        // 1000 USDT ~ 1,000,000 喜羊羊 minus fees and price impact
        assertApproxEqRel(ls[0].amount, 1_000_000e18, 0.03e18);
        assertEq(lk.lockedUsd(b), 1_000e18, "locked value = USDT spent");
        uint256 rw = uint256(ls[0].amount) * 5 / 100;
        assertEq(xyy.balanceOf(b) - w0, rw, "only the 5% reward reaches the wallet");
        assertEq(xyy.balanceOf(a) - a0, rw, "upline 5%");
        assertEq(usdt.balanceOf(address(lk)), 0);
        assertEq(pop.balanceOf(address(lk)), 0);
    }

    function test_buyAndLock_80_20() public {
        uint256 w0 = xyy.balanceOf(b);
        _buy(b, 1_000e18, 8_000, 200);
        XiyangLock.Lock[] memory ls = lk.locksOf(b, 0, 10);
        uint256 locked = ls[0].amount;
        uint256 bought = locked * 10_000 / 8_000;
        assertApproxEqAbs(xyy.balanceOf(b) - w0, bought - locked + locked / 10, 2, "20% + 10% reward");
        assertEq(lk.lockedUsd(b), 800e18, "locked value = 80% of the USDT");
    }

    function test_buyAndLock_slippageProtected() public {
        usdt.mint(b, 1_000e18);
        vm.startPrank(b);
        usdt.approve(address(lk), 1_000e18);
        vm.expectRevert(XiyangLock.Slippage.selector);
        lk.buyAndLock(1_000e18, 10_000, 100, 1_000_000e18, block.timestamp + 600); // no fee-free fill possible
        vm.expectRevert(XiyangLock.Expired.selector);
        lk.buyAndLock(1_000e18, 10_000, 100, 0, block.timestamp - 1);
        vm.expectRevert(XiyangLock.BadAmount.selector);
        lk.buyAndLock(1_000e18, 10_001, 100, 0, block.timestamp + 600);
        vm.stopPrank();
        assertEq(usdt.balanceOf(b), 1_000e18, "nothing taken");
    }

    // ---------------------------------------------------------------- valuation of wallet 喜羊羊 (spot)

    function test_lockFromWallet_valuedAtSpot() public {
        _lockW(b, 300_000e18, 100);
        assertApproxEqRel(lk.lockedUsd(b), 300e18, 0.0001e18, "300,000 x 0.001");
        // price doubles (someone buys) -> the same amount is worth twice as much
        pop.mint(address(pair), 10_000_000e18);
        pair.sync();
        _lockW(c, 150_000e18, 100);
        assertApproxEqRel(lk.lockedUsd(c), 300e18, 0.0001e18, "price doubled");
    }

    // ---------------------------------------------------------------- operator wallet, pause, admin

    function test_operatorCannotPay_lockDoesNotHappen() public {
        vm.prank(operator);
        xyy.approve(address(lk), 100e18);
        xyy.mint(b, 10_000e18);
        vm.startPrank(b);
        xyy.approve(address(lk), 10_000e18);
        vm.expectRevert();
        lk.lock(10_000e18, 100); // needs 500 for b's own reward
        vm.stopPrank();
        assertEq(xyy.balanceOf(b), 10_000e18, "the user's tokens stay in the wallet");
        assertEq(lk.lockCount(b), 0);
    }

    function test_pause_blocksNewLocks_notClaims() public {
        _lockW(b, 10_000e18, 100);
        vm.prank(operator);
        lk.setPaused(true);
        xyy.mint(c, 1e18);
        vm.startPrank(c);
        xyy.approve(address(lk), 1e18);
        vm.expectRevert(XiyangLock.Paused.selector);
        lk.lock(1e18, 100);
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days);
        assertEq(_claim(b), 200e18, "claims work while paused");
        vm.prank(b);
        vm.expectRevert();
        lk.setPaused(false);
    }

    function test_ownerIsOperator_noWayToTakeLockedTokens() public {
        assertEq(lk.owner(), operator);
        _lockW(b, 10_000e18, 100);
        // the only ways tokens leave: claim (to the locker, at the release pace) and rewards (from the operator)
        vm.prank(operator);
        vm.expectRevert(XiyangLock.BadAmount.selector);
        lk.claim();
        assertEq(xyy.balanceOf(address(lk)), 10_000e18);
    }

    function test_operatorCannotLock() public {
        vm.startPrank(operator);
        xyy.approve(address(lk), type(uint256).max);
        vm.expectRevert(XiyangLock.OperatorCannotLock.selector);
        lk.lock(1e18, 100);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- relock (复投)

    function test_relock_rewardAgain_andCountsTowardRights() public {
        _rights(a, address(0));
        _mine(b, 10e18, a);
        _lockW(b, 200_000e18, 100); // 200 USDT
        vm.warp(block.timestamp + 50 days);
        uint256 got = _claim(b);
        assertEq(got, 100_000e18);
        uint256 b0 = xyy.balanceOf(b);
        uint256 a0 = xyy.balanceOf(a);
        vm.startPrank(b);
        xyy.approve(address(lk), got);
        lk.lock(got, 200);
        vm.stopPrank();
        assertEq(b0 - xyy.balanceOf(b), got - got / 10, "paid in, 10% back at once");
        assertEq(xyy.balanceOf(a) - a0, got / 10, "upline 10% again");
        assertTrue(lk.rightsReached(b), "200 + 100 = 300");
    }

    // ---------------------------------------------------------------- mining untouched

    function test_miningUntouched() public {
        _mine(b, 100e18, address(0));
        uint256 tp = miner.totalPrincipal();
        uint256 tl = miner.totalLiquidity();
        (uint256 p0,) = miner.pendingUsd(b);
        _lockW(b, 10_000e18, 100);
        _buy(b, 500e18, 8_000, 200);
        assertEq(miner.totalPrincipal(), tp);
        assertEq(miner.totalLiquidity(), tl);
        (uint256 p1,) = miner.pendingUsd(b);
        assertEq(p1, p0);
    }

    // ---------------------------------------------------------------- fuzz: never more than locked

    function testFuzz_releaseNeverExceedsLocked(uint96 amt, uint16 step, bool long) public {
        uint256 amount = bound(uint256(amt), 1, 10_000_000e18);
        uint256 st = bound(uint256(step), 1 hours, 40 days);
        uint16 days_ = long ? 200 : 100;
        _lockW(b, amount, days_);
        uint256 total;
        for (uint256 i; i < 12; ++i) {
            vm.warp(block.timestamp + st);
            (, uint256 cl) = lk.balances(b);
            if (cl > 0) total += _claim(b);
            assertLe(total, amount);
        }
        vm.warp(block.timestamp + 201 days);
        (, uint256 rest) = lk.balances(b);
        if (rest > 0) total += _claim(b);
        assertEq(total, amount, "exactly the locked amount in the end");
    }
}

/// 喜羊羊 pair against USDT directly (USDT -> 喜羊羊 in one swap)
contract LockUsdtPairTest is BaseTest {
    XiyangLock lk;
    MockSwapPair pair;
    address b = makeAddr("b");

    function setUp() public override {
        super.setUp();
        pair = new MockSwapPair(address(xyy), address(usdt));
        xyy.mint(address(pair), 100_000_000e18);
        usdt.mint(address(pair), 100_000e18);
        pair.sync();
        lk = new XiyangLock(
            XiyangLock.Config({
                miner: address(miner),
                pool: pool,
                rewardPair: address(pair),
                pop: address(pop),
                usdt: address(usdt),
                reward: address(xyy),
                operator: operator,
                thresholdUsd: 300e18
            })
        );
        vm.prank(operator);
        xyy.approve(address(lk), 1_000_000_000e18);
    }

    function test_directPair_buyAndValue() public {
        assertFalse(lk.PAIR_VIA_POP());
        assertApproxEqRel(lk.valueUsd(1_000e18), 1e18, 0.0001e18, "0.001 USDT each");
        usdt.mint(b, 100e18);
        vm.startPrank(b);
        usdt.approve(address(lk), 100e18);
        lk.buyAndLock(100e18, 10_000, 100, 0, block.timestamp + 600);
        vm.stopPrank();
        XiyangLock.Lock[] memory ls = lk.locksOf(b, 0, 1);
        assertApproxEqRel(ls[0].amount, 100_000e18, 0.005e18);
        assertEq(lk.lockedUsd(b), 100e18);
    }

    function test_badConfig_rejected() public {
        XiyangLock.Config memory c = XiyangLock.Config({
            miner: address(miner), pool: pool, rewardPair: pool, pop: address(pop), usdt: address(usdt),
            reward: address(xyy), operator: operator, thresholdUsd: 300e18
        });
        vm.expectRevert(XiyangLock.BadConfig.selector);
        new XiyangLock(c); // the POP/USDT pool is not a 喜羊羊 pair
        c.rewardPair = address(pair);
        c.reward = address(pop);
        vm.expectRevert(XiyangLock.BadConfig.selector);
        new XiyangLock(c); // reward must match the mining contract's
    }
}
