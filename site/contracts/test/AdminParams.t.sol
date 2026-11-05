// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Ownable} from "oz5/access/Ownable.sol";
import {BaseTest} from "./Base.t.sol";
import {XiyangMiner} from "../src/XiyangMiner.sol";

/// Owner-adjustable parameters, claim pause and end-of-mining. Changes must only affect the future.
contract AdminParamsTest is BaseTest {
    address a = makeAddr("a");
    address b = makeAddr("b");
    address c = makeAddr("c");

    function _settle(address u) internal {
        address[] memory l = new address[](1);
        l[0] = u;
        miner.settleMany(l);
    }

    function test_defaults() public view {
        assertEq(miner.dailyRateBps(), 100);
        assertEq(miner.personalBps(), 8500);
        assertEq(miner.tier1Bps(), 1000);
        assertEq(miner.tier2Bps(), 500);
        assertEq(miner.dynamicThresholdUsd(), 100e18);
    }

    function test_onlyOwner_everyAdminFunction() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, a);
        vm.startPrank(a);
        vm.expectRevert(err);
        miner.setRewardParams(200, 8500, 1000, 500, 100e18);
        vm.expectRevert(err);
        miner.setSafetyParams(300, 1, 1, 3);
        vm.expectRevert(err);
        miner.setClaimPaused(true);
        vm.expectRevert(err);
        miner.endMining();
        vm.expectRevert(err);
        miner.setAdminPaused(true);
        vm.stopPrank();
    }

    function test_bounds() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(XiyangMiner.BadConfig.selector, "rate"));
        miner.setRewardParams(0, 8500, 1000, 500, 100e18);
        vm.expectRevert(abi.encodeWithSelector(XiyangMiner.BadConfig.selector, "rate"));
        miner.setRewardParams(301, 8500, 1000, 500, 100e18);
        vm.expectRevert(abi.encodeWithSelector(XiyangMiner.BadConfig.selector, "split"));
        miner.setRewardParams(100, 8500, 1000, 1000, 100e18); // 105%: no extra beyond the daily total
        vm.expectRevert(abi.encodeWithSelector(XiyangMiner.BadConfig.selector, "split"));
        miner.setRewardParams(100, 8000, 1000, 500, 100e18); // 95%
        vm.expectRevert(abi.encodeWithSelector(XiyangMiner.BadConfig.selector, "threshold"));
        miner.setRewardParams(100, 8500, 1000, 500, 0);
        vm.expectRevert(abi.encodeWithSelector(XiyangMiner.BadConfig.selector, "tick deviation"));
        miner.setSafetyParams(0, 1, 1, 3);
        vm.expectRevert(abi.encodeWithSelector(XiyangMiner.BadConfig.selector, "tick deviation"));
        miner.setSafetyParams(2001, 1, 1, 3);
        vm.expectRevert(abi.encodeWithSelector(XiyangMiner.BadConfig.selector, "runway"));
        miner.setSafetyParams(300, 1, 1, 31);
        // valid changes apply
        miner.setRewardParams(300, 10000, 0, 0, 1_000_000e18);
        miner.setSafetyParams(2000, 5, 6, 30);
        vm.stopPrank();
        assertEq(miner.dailyRateBps(), 300);
        assertEq(miner.personalBps(), 10000);
        assertEq(miner.maxTickDeviation(), 2000);
        assertEq(miner.minPoolLiquidity(), 5);
        assertEq(miner.minRewardPoolLiquidity(), 6);
        assertEq(miner.runwayDays(), 30);
    }

    function test_rateChange_onlyAffectsFuture() public {
        _depositBoth(a, 1000e18, address(0));
        uint256 v = miner.valueUsd(a);
        _keep(12 hours, 1 hours);
        (uint256 before,) = miner.pendingUsd(a);
        vm.prank(operator);
        miner.setRewardParams(200, 8500, 1000, 500, 100e18); // 2% per day from now on
        (uint256 justAfter,) = miner.pendingUsd(a);
        assertEq(justAfter, before, "nothing accrued so far is re-priced");
        _keep(12 hours, 1 hours);
        (uint256 p,) = miner.pendingUsd(a);
        assertApproxEqRel(p, v * 85 / 10000 / 2 + v * 2 * 85 / 10000 / 2, 1e12, "12h at 1% + 12h at 2%");
    }

    function test_splitChange_onlyAffectsFuture_evenForUnsettledUsers() public {
        _depositBoth(a, 1000e18, address(0));
        _depositBoth(b, 1000e18, a);
        uint256 vb = miner.valueUsd(b);
        _keep(12 hours, 1 hours); // b is NOT settled during this period
        vm.prank(operator);
        miner.setRewardParams(100, 7000, 2000, 1000, 100e18);
        _keep(12 hours, 1 hours);
        _settle(b);
        (uint256 pb,) = miner.pendingUsd(b);
        (, uint256 da) = miner.pendingUsd(a);
        assertApproxEqRel(pb, vb * 8500 / 1e6 / 2 + vb * 7000 / 1e6 / 2, 1e12, "b: 12h at 85% then 12h at 70%");
        assertApproxEqRel(da, vb * 1000 / 1e6 / 2 + vb * 2000 / 1e6 / 2, 1e12, "a (tier 1): 10% then 20%");
    }

    function test_thresholdChange() public {
        _depositBoth(a, 500e18, address(0)); // value ~1000
        _depositBoth(b, 1000e18, a);
        _keep(12 hours, 1 hours);
        _settle(b);
        (, uint256 da1) = miner.pendingUsd(a);
        assertGt(da1, 0);
        vm.prank(operator);
        miner.setRewardParams(100, 8500, 1000, 500, 1500e18); // a (~1000) no longer qualifies
        assertFalse(miner.isEligible(a));
        _settle(b); // re-assignment for the next interval
        assertEq(miner.getUser(b).up1, address(0));
        _keep(12 hours, 1 hours);
        _settle(b);
        (, uint256 da2) = miner.pendingUsd(a);
        assertEq(da2, da1, "earned referral rewards kept, no new ones below the new threshold");
    }

    function test_claimPause_accrualContinues_withdrawWorks() public {
        uint128 liq = _depositBoth(a, 1000e18, address(0));
        _keep(12 hours, 1 hours);
        vm.prank(operator);
        miner.setClaimPaused(true);
        vm.prank(a);
        vm.expectRevert(XiyangMiner.ClaimPaused.selector);
        miner.claim(0);
        (uint256 p0,) = miner.pendingUsd(a);
        _keep(12 hours, 1 hours);
        (uint256 p1,) = miner.pendingUsd(a);
        assertGt(p1, p0, "accrual continues while claims are paused");
        assertTrue(miner.accruing());
        vm.prank(operator);
        miner.setClaimPaused(false);
        vm.prank(a);
        uint256 got = miner.claim(0);
        assertGt(got, 0);
        vm.prank(a);
        miner.withdraw(liq, 0, 0, block.timestamp);
    }

    function test_endMining_isFinal_claimAndWithdrawStillWork() public {
        uint128 liq = _depositBoth(a, 1000e18, address(0));
        _keep(1 days, 1 hours);
        vm.prank(operator);
        miner.endMining();
        assertTrue(miner.ended());
        assertFalse(miner.accruing());
        assertEq(miner.pauseReasons() & miner.R_ENDED(), miner.R_ENDED());
        (uint256 p0,) = miner.pendingUsd(a);
        _keep(1 days, 1 hours);
        (uint256 p1,) = miner.pendingUsd(a);
        assertEq(p1, p0, "no accrual after the end");
        // cannot restart
        vm.prank(operator);
        vm.expectRevert(XiyangMiner.Ended.selector);
        miner.setAdminPaused(false);
        vm.prank(operator);
        vm.expectRevert(XiyangMiner.Ended.selector);
        miner.endMining();
        // no new deposits
        _fund(b, 100e18, 10_000e18);
        vm.prank(b);
        vm.expectRevert();
        miner.deposit(_p(100e18, 10_000e18, 0, address(0)));
        // users keep everything earned and can leave
        vm.prank(a);
        uint256 got = miner.claim(0);
        assertGt(got, 0);
        vm.prank(a);
        miner.withdraw(liq, 0, 0, block.timestamp);
        assertEq(miner.getUser(a).liquidity, 0);
    }

    function test_endMining_withClaimPause_ownerReopensClaims() public {
        _depositBoth(a, 1000e18, address(0));
        _keep(1 days, 1 hours);
        vm.startPrank(operator);
        miner.setClaimPaused(true);
        miner.endMining();
        vm.stopPrank();
        vm.prank(a);
        vm.expectRevert(XiyangMiner.ClaimPaused.selector);
        miner.claim(0);
        vm.prank(operator);
        miner.setClaimPaused(false);
        vm.prank(a);
        miner.claim(0);
    }

    function testFuzz_paramChanges_neverPayMoreThanTotal(uint16 r1, uint16 r2, uint16 p, uint16 t1) public {
        uint16 rate1 = uint16(bound(r1, 1, 300));
        uint16 rate2 = uint16(bound(r2, 1, 300));
        uint16 pb = uint16(bound(p, 0, 10000));
        uint16 t1b = uint16(bound(t1, 0, 10000 - pb));
        uint16 t2b = 10000 - pb - t1b;
        _depositBoth(a, 1000e18, address(0));
        _depositBoth(b, 800e18, a);
        _depositBoth(c, 600e18, b);
        vm.prank(operator);
        miner.setRewardParams(rate1, 8500, 1000, 500, 100e18);
        _keep(6 hours, 1 hours);
        vm.prank(operator);
        miner.setRewardParams(rate2, pb, t1b, t2b, 100e18);
        _keep(6 hours, 1 hours);
        address[] memory l = new address[](3);
        (l[0], l[1], l[2]) = (a, b, c);
        miner.settleMany(l);
        uint256 credited;
        for (uint256 i; i < 3; ++i) {
            (uint256 pp, uint256 dd) = miner.pendingUsd(l[i]);
            credited += pp + dd;
        }
        assertLe(credited, miner.totalBaseAccruedUsd() + 3, "personal + referral never exceed the daily total");
    }
}
