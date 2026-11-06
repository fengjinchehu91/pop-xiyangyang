// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {XiyangMiner} from "../src/XiyangMiner.sol";

/// Version 2 rules: rewards and referral eligibility follow the principal ("入金额度") booked at deposit.
contract PrincipalV2Test is BaseTest {
    address internal A = makeAddr("upline");
    address internal B = makeAddr("downline");
    address internal C = makeAddr("third");

    function _settle(address u) internal {
        address[] memory l = new address[](1);
        l[0] = u;
        miner.settleMany(l);
    }

    function _pr(address u) internal view returns (uint256) {
        return miner.getUser(u).principalUsd;
    }

    function _dyn(address u) internal view returns (uint256 d) {
        (, d) = miner.pendingUsd(u);
    }

    function _personal(address u) internal view returns (uint256 p) {
        (p,) = miner.pendingUsd(u);
    }

    function _withdraw(address u, uint128 liq) internal {
        vm.prank(u);
        miner.withdraw(liq, 0, 0, block.timestamp);
    }

    function test_principalBooked_atDeposit_bothModes() public {
        _depositUsdt(A, 100e18, address(0));
        uint256 pa = _pr(A);
        assertLe(pa, 100e18);
        assertGt(pa, 99.8e18, "100 USDT in -> ~100 principal (minus swap fee)");
        assertTrue(miner.isEligible(A), "exactly 100 USDT qualifies (fee tolerance)");
        _depositBoth(B, 50e18, A);
        assertApproxEqRel(_pr(B), 100e18, 0.002e18, "50 USDT + 50 USDT of POP = 100");
        assertTrue(miner.isEligible(B));
        assertEq(miner.totalPrincipal(), _pr(A) + _pr(B));
    }

    function test_below100_notEligible_passesUp() public {
        _depositUsdt(A, 1000e18, address(0)); // A eligible
        _depositUsdt(B, 80e18, A); //            B below 100
        _depositUsdt(C, 1000e18, B); //          C under B
        assertFalse(miner.isEligible(B), "80 USDT does not qualify");
        _keep(6 hours, 30 minutes);
        _settle(C);
        assertEq(_dyn(B), 0, "B gets no referral rewards");
        // C's tier-1 share passes up to A (first eligible upline)
        assertApproxEqRel(_dyn(A), _pr(C) * 1000 / 10000 / 100 / 4, 1e12, "A gets C's 10% of 1%/day for 6h");
    }

    function test_priceCrash_rewardsAndEligibilityUnchanged() public {
        _depositUsdt(A, 150e18, address(0));
        _depositUsdt(B, 1000e18, A);
        uint256 pa = _pr(A);
        uint256 pb = _pr(B);
        _keep(1 hours, 10 minutes);
        _settle(B);
        // POP crashes ~16x: positions lose ~75% of their value
        _swap(address(pop), pool, 300_000_000e18);
        _keep(3 hours, 5 minutes);
        assertLt(miner.valueUsd(A), 50e18, "A's LP value collapsed");
        assertEq(_pr(A), pa, "principal unchanged");
        assertTrue(miner.isEligible(A), "still eligible");
        _settle(B);
        uint256 p0 = _personal(A);
        uint256 d0 = _dyn(A);
        _keep(12 hours, 10 minutes);
        _settle(B);
        assertApproxEqRel(_personal(A) - p0, pa * 85 / 10000 / 2, 1e12, "A: 12h at 1%/day x 85% of principal");
        assertApproxEqRel(_dyn(A) - d0, pb * 1000 / 10000 / 2 / 100, 1e12, "A: 10% of B's principal-based 12h");
    }

    function test_topUp_partialAndFullWithdraw() public {
        uint128 l1 = _depositUsdt(A, 200e18, address(0));
        uint256 p1 = _pr(A);
        uint128 l2 = _depositUsdt(A, 100e18, address(0));
        assertApproxEqRel(_pr(A), p1 * 3 / 2, 0.002e18, "top-up adds principal");
        uint128 liq = l1 + l2;
        uint256 pAll = _pr(A);
        _withdraw(A, liq / 2);
        assertApproxEqRel(_pr(A), pAll / 2, 1e9, "half out -> half principal");
        assertEq(miner.totalPrincipal(), _pr(A));
        _withdraw(A, miner.getUser(A).liquidity);
        assertEq(_pr(A), 0, "all out -> 0");
        assertEq(miner.totalPrincipal(), 0);
        uint256 p = _personal(A);
        _keep(6 hours, 30 minutes);
        assertEq(_personal(A), p, "no accrual without principal");
    }

    function test_withdrawBelow100_stopsReferral_redepositRestores() public {
        uint128 la = _depositUsdt(A, 200e18, address(0));
        _depositUsdt(B, 1000e18, A);
        _keep(1 hours, 10 minutes);
        _withdraw(A, la / 2); // ~100 left: still eligible
        assertTrue(miner.isEligible(A), "half of 200 left: still eligible");
        _settle(B);
        uint256 d0 = _dyn(A);
        _keep(2 hours, 10 minutes);
        _settle(B);
        uint256 d1 = _dyn(A);
        assertGt(d1, d0, "still earning");
        _withdraw(A, miner.getUser(A).liquidity / 2); // ~50 left
        assertFalse(miner.isEligible(A), "50 left: not eligible");
        _settle(B);
        uint256 d2 = _dyn(A);
        _keep(2 hours, 10 minutes);
        _settle(B);
        assertEq(_dyn(A), d2, "no referral rewards after dropping below 100");
        _depositUsdt(A, 60e18, address(0)); // ~110
        assertTrue(miner.isEligible(A), "back above 100");
        _settle(B);
        uint256 d3 = _dyn(A);
        _keep(2 hours, 10 minutes);
        _settle(B);
        assertGt(_dyn(A), d3, "referral rewards resume");
    }

    function test_poolPriceUnavailable_accrualContinues_depositsBlocked() public {
        _depositUsdt(A, 1000e18, address(0));
        _keep(1 hours, 10 minutes);
        (int24 dev, uint128 rl, uint16 rw) = (miner.maxTickDeviation(), miner.minRewardPoolLiquidity(), miner.runwayDays());
        vm.prank(operator);
        miner.setSafetyParams(dev, type(uint128).max, rl, rw);
        assertTrue(miner.accruing(), "missing POP/USDT average does not stop accrual");
        assertEq(miner.pauseReasons() & miner.R_VALUATION_INVALID(), miner.R_VALUATION_INVALID());
        uint256 p0 = _personal(A);
        _keep(4 hours, 10 minutes);
        assertApproxEqRel(_personal(A) - p0, _pr(A) * 85 / 10000 / 6, 1e12, "4h credited");
        _fund(B, 200e18, 0);
        vm.prank(B);
        vm.expectRevert(abi.encodeWithSelector(XiyangMiner.NotRunning.selector, miner.R_VALUATION_INVALID()));
        miner.deposit(_p(200e18, 0, uint256(200e18) * 10000 / 19995, address(0)));
        // withdrawals still work
        _withdraw(A, miner.getUser(A).liquidity);
        assertEq(_pr(A), 0);
    }

    function test_reserveCoverage_usesPrincipal() public {
        _depositUsdt(A, 1000e18, address(0));
        _keep(1 hours, 10 minutes);
        _swap(address(pop), pool, 300_000_000e18); // value drops ~75%, principal stays 1000
        _keep(3 hours, 5 minutes);
        assertTrue(miner.accruing());
        (,,, uint256 liab) = miner.reserveView();
        // allowance worth liability + 20 USD: enough for value-based (~3 x 2.5 USD) but not for principal-based
        // runway (3 days x 10 USD) -> must pause
        (bool ok, uint256 price) = miner.rewardPriceView();
        assertTrue(ok);
        uint256 tokens = (liab + 20e18) * 1e18 / price;
        vm.prank(operator);
        xyy.approve(address(miner), tokens);
        miner.checkpoint();
        assertFalse(miner.accruing(), "paused: reserve below principal-based need");
        assertEq(miner.pauseReasons() & miner.R_RESERVE_LOW(), miner.R_RESERVE_LOW());
        vm.prank(operator);
        xyy.approve(address(miner), (liab + 40e18) * 1e18 / price);
        miner.checkpoint();
        assertTrue(miner.accruing(), "resumes once covered");
    }

    function test_claim_paysPrincipalBasedRewards() public {
        _depositUsdt(A, 1000e18, address(0));
        _keep(1 days, 30 minutes);
        (uint256 p,) = miner.pendingUsd(A);
        assertApproxEqRel(p, _pr(A) * 85 / 10000, 1e12, "1 day = 1% x 85% of principal");
        (, uint256 price) = miner.rewardPriceView();
        vm.prank(A);
        uint256 got = miner.claim(0);
        assertApproxEqRel(got, p * 1e18 / price, 1e9, "paid in reward tokens at the claim price");
        assertEq(xyy.balanceOf(A), got);
    }

    function testFuzz_principalNeverNegative_andTotalsMatch(uint96 d1, uint96 d2, uint16 outBps) public {
        uint256 a1 = bound(uint256(d1), 10e18, 5_000e18);
        uint256 a2 = bound(uint256(d2), 10e18, 5_000e18);
        uint256 o = bound(uint256(outBps), 1, 10_000);
        uint128 l1 = _depositUsdt(A, a1, address(0));
        _keep(1 hours, 10 minutes); // let the average catch up with the zap's price move
        _depositUsdt(B, a2, address(0));
        uint128 out = uint128(uint256(l1) * o / 10_000);
        if (out > 0) _withdraw(A, out);
        assertEq(miner.totalPrincipal(), _pr(A) + _pr(B), "total = sum");
        if (out == l1) assertEq(_pr(A), 0);
    }
}
