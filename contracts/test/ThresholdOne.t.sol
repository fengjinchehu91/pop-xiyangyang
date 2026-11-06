// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";

/// Plan for the live contract (no redeploy): the operator sets the referral threshold to 1 USDT, the website only
/// lets a wallet without a position add >= 100 USDT and only offers full withdrawal. Checks on the real contract code:
///  - a price drop that pushes the LP value below 100 USDT keeps the referral rewards flowing,
///  - withdrawing everything stops them from that moment,
///  - adding >= 100 USDT again brings them back.
contract ThresholdOneTest is BaseTest {
    address internal A = makeAddr("upline");
    address internal B = makeAddr("downline");

    function _settleB() internal {
        address[] memory l = new address[](1);
        l[0] = B;
        miner.settleMany(l);
    }

    function _dyn(address u) internal view returns (uint256 d) {
        (, d) = miner.pendingUsd(u);
    }

    function test_priceDrop_keeps_withdraw_stops_redeposit_restores() public {
        vm.prank(operator);
        miner.setRewardParams(100, 8500, 1000, 500, 1e18);
        assertEq(miner.dynamicThresholdUsd(), 1e18);

        _depositUsdt(A, 150e18, address(0));
        _depositUsdt(B, 1000e18, A);
        _keep(1 hours, 10 minutes);
        _settleB();
        assertTrue(miner.isEligible(A), "eligible after adding 150 USDT");

        // POP crashes: the pool price falls ~16x, A's LP value falls well below 100 USDT
        _swap(address(pop), pool, 300_000_000e18);
        _keep(3 hours, 5 minutes);
        uint256 valueA = miner.valueUsd(A);
        assertLt(valueA, 100e18, "LP value shrank below 100");
        assertGt(valueA, 1e18);
        assertTrue(miner.isEligible(A), "still eligible after the price drop");

        _settleB();
        uint256 d0 = _dyn(A);
        _keep(2 hours, 10 minutes);
        _settleB();
        uint256 d1 = _dyn(A);
        assertGt(d1, d0, "referral rewards keep coming after the price drop");

        // same situation with the 100 USDT threshold: A would have lost it (the current behaviour)
        uint256 snap = vm.snapshot();
        vm.prank(operator);
        miner.setRewardParams(100, 8500, 1000, 500, 100e18);
        assertFalse(miner.isEligible(A), "with 100 USDT threshold the price drop would cut it");
        vm.revertTo(snap);

        // A withdraws everything: no referral rewards from that moment
        uint128 liqA = miner.getUser(A).liquidity;
        vm.prank(A);
        miner.withdraw(liqA, 0, 0, block.timestamp);
        assertFalse(miner.isEligible(A), "not eligible after withdrawing");
        _settleB();
        uint256 d2 = _dyn(A);
        assertGe(d2, d1);
        _keep(2 hours, 10 minutes);
        _settleB();
        assertEq(_dyn(A), d2, "nothing more after withdrawing");

        // A adds 100 USDT again: eligible again, rewards resume (B's next interval)
        _depositUsdt(A, 100e18, address(0));
        assertTrue(miner.isEligible(A), "eligible again after adding 100 USDT");
        _settleB(); // B re-assigns its uplines -> A again
        uint256 d3 = _dyn(A);
        _keep(2 hours, 10 minutes);
        _settleB();
        assertGt(_dyn(A), d3, "referral rewards resume");
    }
}
