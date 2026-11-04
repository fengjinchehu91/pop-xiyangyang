// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "oz5/access/Ownable.sol";
import {BaseTest} from "./Base.t.sol";
import {XiyangMiner} from "../src/XiyangMiner.sol";
import {MockERC20, TaxToken} from "./utils/Mocks.sol";

contract PrincipalTest is BaseTest {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function test_fullRangeTicksAndPool() public view {
        assertEq(miner.TICK_LOWER(), -887270);
        assertEq(miner.TICK_UPPER(), 887270);
        assertEq(address(miner.POOL()), pool);
        assertEq(miner.TICK_LOWER() % 10, 0);
    }

    function test_usdtOnlyZap_custodyAndRefund() public {
        uint128 liq = _depositUsdt(alice, 1000e18, address(0));
        XiyangMiner.User memory u = miner.getUser(alice);
        assertEq(u.liquidity, liq);
        assertEq(npm.ownerOf(u.tokenId), address(miner), "NFT custodied by miner");
        // Not all USDT swapped: position holds both tokens; leftovers refunded to the user, none stay in miner
        assertEq(usdt.balanceOf(address(miner)), 0);
        assertEq(pop.balanceOf(address(miner)), 0);
        assertEq(usdt.balanceOf(operator), 0, "principal never reaches operator");
        uint256 v = miner.valueUsd(alice);
        assertApproxEqRel(v, 1000e18, 0.01e18, "value ~ deposit minus swap fee / refund");
    }

    function test_twoTokenDeposit_andRepeatUsesSameNFT() public {
        _depositBoth(alice, 500e18, address(0));
        uint256 id = miner.getUser(alice).tokenId;
        _depositBoth(alice, 300e18, address(0));
        assertEq(miner.getUser(alice).tokenId, id, "repeat deposit increases same position");
        assertApproxEqRel(miner.valueUsd(alice), 1600e18, 0.001e18, "both sides counted: 2 x USDT side");
        assertEq(miner.participants(), 1);
    }

    function test_refundOfExcessToken() public {
        // give far more POP than the price ratio needs: the excess must be refunded
        _fund(alice, 100e18, 1_000_000e18);
        vm.prank(alice);
        miner.deposit(_p(100e18, 1_000_000e18, 0, address(0)));
        assertApproxEqRel(pop.balanceOf(alice), 1_000_000e18 - 10_000e18, 0.001e18);
        assertEq(pop.balanceOf(address(miner)), 0);
    }

    function test_withdrawPartialAndFull_fixedPopUsdt_withFees() public {
        uint128 liq = _depositBoth(alice, 1000e18, address(0));
        // generate trading fees on the pool
        for (uint256 i; i < 5; ++i) {
            uint256 got = _swap(address(usdt), pool, 50_000e18);
            _swap(address(pop), pool, got);
        }
        vm.warp(block.timestamp + 1 hours);
        miner.checkpoint();

        vm.recordLogs();
        vm.prank(alice);
        (uint256 popOut, uint256 usdtOut) = miner.withdraw(liq / 4, 0, 0, block.timestamp);
        assertGt(popOut, 0);
        assertGt(usdtOut, 0);
        (,,, uint256 popFees, uint256 usdtFees) = _lastWithdrawn();
        assertGt(popFees + usdtFees, 0, "fees go to the position owner on exit");
        assertEq(miner.getUser(alice).liquidity, liq - liq / 4);

        vm.prank(alice);
        miner.withdraw(liq - liq / 4, 0, 0, block.timestamp);
        assertEq(miner.getUser(alice).liquidity, 0);
        assertEq(miner.totalLiquidity(), 0);
        // only POP and USDT come back; no reward token mixed in
        assertEq(xyy.balanceOf(alice), 0);
    }

    function test_withdrawSlippageAndDeadline() public {
        uint128 liq = _depositBoth(alice, 1000e18, address(0));
        vm.prank(alice);
        vm.expectRevert();
        miner.withdraw(liq, type(uint128).max, 0, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(XiyangMiner.Expired.selector);
        miner.withdraw(liq, 0, 0, block.timestamp - 1);
        vm.prank(bob);
        vm.expectRevert(XiyangMiner.ZeroAmount.selector);
        miner.withdraw(1, 0, 0, block.timestamp);
    }

    function test_depositGuards() public {
        _fund(alice, 1000e18, 0);
        XiyangMiner.DepositParams memory p = _p(1000e18, 0, 500e18, address(0));
        p.minPopFromSwap = type(uint256).max;
        vm.prank(alice);
        vm.expectRevert(XiyangMiner.Slippage.selector);
        miner.deposit(p);

        p = _p(1000e18, 0, 500e18, address(0));
        p.deadline = block.timestamp - 1;
        vm.prank(alice);
        vm.expectRevert(XiyangMiner.Expired.selector);
        miner.deposit(p);

        // allowance missing
        address carol = makeAddr("carol");
        usdt.mint(carol, 10e18);
        vm.prank(carol);
        vm.expectRevert();
        miner.deposit(_p(10e18, 0, 5e18, address(0)));
    }

    function test_swapCallbackOnlyFromPoolDuringSwap() public {
        vm.expectRevert(bytes("cb"));
        miner.pancakeV3SwapCallback(1, 0, "");
        vm.prank(pool);
        vm.expectRevert(bytes("cb"));
        miner.uniswapV3SwapCallback(1e18, 0, "");
    }

    function _lastWithdrawn() internal returns (address, uint128, uint256, uint256, uint256) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("Withdrawn(address,uint128,uint256,uint256,uint256,uint256)");
        for (uint256 i = logs.length; i > 0; --i) {
            if (logs[i - 1].topics[0] == sig) {
                (uint128 l, uint256 pp, uint256 up, uint256 pf, uint256 uf) =
                    abi.decode(logs[i - 1].data, (uint128, uint256, uint256, uint256, uint256));
                pp;
                up;
                return (address(uint160(uint256(logs[i - 1].topics[1]))), l, 0, pf, uf);
            }
        }
        revert("no Withdrawn");
    }
}

contract RewardTest is BaseTest {
    address a = makeAddr("a");
    address b = makeAddr("b");
    address c = makeAddr("c");

    function test_onePercentDaily_85_10_5_noExtra() public {
        _depositBoth(a, 1000e18, address(0));
        _depositBoth(b, 1000e18, a);
        _depositBoth(c, 1000e18, b);
        uint256 vc = miner.valueUsd(c);
        uint256 baseBefore = miner.totalBaseAccruedUsd();

        _keep(1 days, 1 hours);
        address[] memory list = new address[](3);
        (list[0], list[1], list[2]) = (a, b, c);
        miner.settleMany(list);

        (uint256 pc,) = _pending(c);
        assertApproxEqRel(pc, vc * 85 / 10000, 1e12, "personal 85% of 1%/day");
        // b: own 85% + 10% of c ; a: own 85% + 10% of b + 5% of c
        (uint256 pb, uint256 db) = _pending(b);
        (uint256 pa, uint256 da) = _pending(a);
        assertApproxEqRel(db, vc * 10 / 10000, 1e12);
        assertApproxEqRel(da, (miner.valueUsd(b) * 10 + vc * 5) / 10000, 1e12);
        // total distributed == exactly 1% of TVL per day (3 users, chain fully eligible except a/b's own uplines)
        uint256 accrued = miner.totalBaseAccruedUsd() - baseBefore;
        assertApproxEqRel(accrued, (miner.valueUsd(a) + miner.valueUsd(b) + vc) / 100, 1e12);
        assertLe(pa + pb + pc + da + db, accrued, "never more than the 1% base");
    }

    function test_noReferrer_referralShareUnallocated() public {
        _depositBoth(a, 1000e18, address(0));
        _keep(1 days, 1 hours);
        address[] memory list = new address[](1);
        list[0] = a;
        miner.settleMany(list);
        (uint256 pa, uint256 da) = _pending(a);
        assertApproxEqRel(pa, miner.valueUsd(a) * 85 / 10000, 1e12);
        assertEq(da, 0);
        // liability bound stays at 100% but only 85% is claimable; the 15% is never paid by the operator
        vm.prank(a);
        miner.claim(0);
        assertApproxEqRel(miner.totalPaidUsd(), miner.totalBaseAccruedUsd() * 85 / 100, 1e12);
    }

    function test_valueChangeAccruesPerPeriod_notBackCalculated() public {
        _depositBoth(a, 1000e18, address(0));
        uint256 v0 = miner.valueUsd(a);
        _keep(12 hours, 30 minutes);
        // move price up ~ +2% gradually (stays within TWAP deviation band)
        for (uint256 i; i < 4; ++i) {
            _swap(address(usdt), pool, 5_000e18);
            _keep(1 hours, 15 minutes);
        }
        uint256 v1 = miner.valueUsd(a);
        assertGt(v1, v0);
        (uint256 pBefore,) = _pending(a);
        _keep(8 hours, 30 minutes);
        (uint256 pAfter,) = _pending(a);
        // the last 8h accrue at the new value, earlier hours keep their old-value accrual
        assertApproxEqRel(pAfter - pBefore, v1 * 85 / 10000 * 8 / 24, 0.002e18);
        assertLt(pBefore, v1 * 85 / 10000 * 16 / 24, "history not re-priced at the new value");
    }

    function test_adminPauseStopsAccrual_noBackPay_withdrawStillWorks() public {
        uint128 liq = _depositBoth(a, 1000e18, address(0));
        _keep(6 hours, 1 hours);
        vm.prank(operator);
        miner.setAdminPaused(true);
        assertFalse(miner.accruing());
        (uint256 p0,) = _pending(a);
        _keep(12 hours, 1 hours);
        (uint256 p1,) = _pending(a);
        assertEq(p1, p0, "no accrual while paused");

        // deposits blocked, withdraw allowed
        _fund(b, 100e18, 10_000e18);
        vm.prank(b);
        vm.expectRevert(abi.encodeWithSelector(XiyangMiner.NotRunning.selector, uint8(1)));
        miner.deposit(_p(100e18, 10_000e18, 0, address(0)));

        vm.prank(operator);
        miner.setAdminPaused(false);
        assertTrue(miner.accruing());
        _keep(6 hours, 1 hours);
        (uint256 p2,) = _pending(a);
        assertApproxEqRel(p2, miner.valueUsd(a) * 85 / 10000 * 12 / 24, 1e12, "only 12h of 24h credited");

        vm.prank(operator);
        miner.setAdminPaused(true);
        vm.prank(a);
        miner.withdraw(liq, 0, 0, block.timestamp);
        assertEq(miner.getUser(a).liquidity, 0);
        (uint256 kept,) = _pending(a);
        assertEq(kept, p2, "accrued rewards kept after full exit");
    }

    function test_keeperOffline_accrualStopsAfterMaxValuationAge() public {
        _depositBoth(a, 1000e18, address(0));
        vm.warp(block.timestamp + 10 hours); // no checkpoints
        (uint256 p,) = _pending(a);
        assertApproxEqRel(p, miner.valueUsd(a) * 85 / 10000 * 2 / 24, 1e12, "only maxValuationAge (2h) credited");
        miner.checkpoint(); // keeper back: resumes from now, no back-pay
        (uint256 p2,) = _pending(a);
        assertEq(p2, p);
        _keep(1 hours, 1 hours);
        (uint256 p3,) = _pending(a);
        assertApproxEqRel(p3 - p2, miner.valueUsd(a) * 85 / 10000 / 24, 1e12);
        // duplicate keeper calls are harmless
        miner.checkpoint();
        miner.checkpoint();
        (uint256 p4,) = _pending(a);
        assertEq(p4, p3);
    }

    function test_claim_paysFromOperator_atTwap() public {
        _depositBoth(a, 1000e18, address(0));
        _keep(1 days, 1 hours);
        (uint256 usd,) = _pending(a);
        (, uint256 price) = miner.rewardPriceView(); // ~0.001 USDT
        uint256 opBefore = xyy.balanceOf(operator);
        vm.prank(a);
        uint256 got = miner.claim(0);
        assertApproxEqRel(got, usd * 1e18 / price, 1e9);
        assertEq(xyy.balanceOf(a), got);
        assertEq(opBefore - xyy.balanceOf(operator), got);
        assertEq(miner.getUser(a).claimedPersonalReward, got);
        // double claim
        vm.prank(a);
        vm.expectRevert(XiyangMiner.NothingToClaim.selector);
        miner.claim(0);
    }

    function test_claimMinOut() public {
        _depositBoth(a, 1000e18, address(0));
        _keep(1 days, 1 hours);
        vm.prank(a);
        vm.expectRevert(XiyangMiner.Slippage.selector);
        miner.claim(type(uint256).max);
        (uint256 kept,) = _pending(a);
        assertGt(kept, 0);
    }

    function test_revokedAllowance_claimRevertsKeepsRewards_resumeAfterTopUp() public {
        uint128 liq = _depositBoth(a, 1000e18, address(0));
        _keep(1 days, 1 hours);
        (uint256 owed,) = _pending(a);
        vm.prank(operator);
        xyy.approve(address(miner), 0);
        vm.prank(a);
        vm.expectRevert();
        miner.claim(0);
        (uint256 still,) = _pending(a);
        assertEq(still, owed);

        // next checkpoint detects low reserve: accrual and deposits stop
        miner.checkpoint();
        assertFalse(miner.accruing());
        assertEq(miner.pauseReasons() & miner.R_RESERVE_LOW(), miner.R_RESERVE_LOW());
        _keep(6 hours, 1 hours);
        (uint256 frozen,) = _pending(a);
        assertEq(frozen, owed);

        // operator moves tokens away entirely: withdraw of principal still works
        vm.prank(a);
        miner.withdraw(liq / 2, 0, 0, block.timestamp);

        // top up allowance -> resumes at that checkpoint, no back-pay for the stopped period
        vm.prank(operator);
        xyy.approve(address(miner), 500_000_000e18);
        miner.checkpoint();
        assertTrue(miner.accruing());
        vm.prank(a);
        miner.claim(0);
    }

    function test_operatorBalanceDrained_coverageFails() public {
        _depositBoth(a, 1000e18, address(0));
        vm.startPrank(operator);
        xyy.transfer(makeAddr("sink"), xyy.balanceOf(operator) - 1e18); // 1 XYY ~ 0.001 USD left
        vm.stopPrank();
        miner.checkpoint();
        assertFalse(miner.accruing(), "balance > 0 alone is not enough");
    }

    function test_rewardPriceManipulated_claimBlocked_withdrawOk() public {
        uint128 liq = _depositBoth(a, 1000e18, address(0));
        _keep(1 days, 1 hours);
        _swap(address(usdt), rewardPool, 50_000e18); // pump XYY spot far from TWAP
        vm.prank(a);
        vm.expectRevert(XiyangMiner.RewardPriceUnavailable.selector);
        miner.claim(0);
        vm.prank(a);
        miner.withdraw(liq, 0, 0, block.timestamp);
    }

    function test_poolManipulated_depositBlocked() public {
        _depositBoth(a, 1000e18, address(0));
        _swap(address(usdt), pool, 200_000e18); // big spot move vs TWAP
        _fund(b, 100e18, 0);
        vm.prank(b);
        vm.expectRevert(); // NotRunning(R_VALUATION_INVALID ...)
        miner.deposit(_p(100e18, 0, 50e18, address(0)));
        // a keeper checkpoint now records "valuation invalid" and keeps the last good valuation
        uint256 vBefore = miner.valuePerRef();
        miner.checkpoint();
        assertFalse(miner.accruing());
        assertEq(miner.pauseReasons() & miner.R_VALUATION_INVALID(), miner.R_VALUATION_INVALID());
        assertEq(miner.valuePerRef(), vBefore, "manipulated spot not used");
    }

    function test_onlyOwnerAdmin_noFundMovingFunctions() public {
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, a));
        miner.setAdminPaused(true);
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, a));
        miner.setRunwayDays(1);
        vm.prank(operator);
        vm.expectRevert();
        miner.setRunwayDays(0);
    }

    function testFuzz_creditedNeverExceedsBase(uint96 x, uint96 y, uint32 dt) public {
        uint256 ax = bound(uint256(x), 1e18, 50_000e18);
        uint256 by = bound(uint256(y), 1e18, 50_000e18);
        uint256 t = bound(uint256(dt), 1 hours, 10 days);
        _depositBoth(a, ax, address(0));
        _depositBoth(b, by, a);
        _keep(t, 1 hours);
        address[] memory list = new address[](2);
        (list[0], list[1]) = (a, b);
        miner.settleMany(list);
        (uint256 pa, uint256 da) = _pending(a);
        (uint256 pb, uint256 db) = _pending(b);
        assertLe(pa + pb + da + db, miner.totalBaseAccruedUsd() + 2);
    }
}

contract ReferralTest is BaseTest {
    function _u(uint256 i) internal pure returns (address) {
        return address(uint160(0x10000 + i));
    }

    function test_bindingRules() public {
        address a = _u(1);
        address b = _u(2);
        vm.prank(b);
        vm.expectRevert(XiyangMiner.BadReferrer.selector);
        miner.bind(a); // a has not deposited
        vm.prank(b);
        vm.expectRevert(XiyangMiner.BadReferrer.selector);
        miner.bind(b); // self
        _depositBoth(a, 200e18, address(0));
        vm.prank(b);
        miner.bind(a);
        vm.prank(b);
        vm.expectRevert(XiyangMiner.AlreadyBound.selector);
        miner.bind(a);
        _depositBoth(b, 200e18, address(0)); // referrer param ignored, binding kept
        assertEq(miner.getUser(b).referrer, a);
        // joined users without referrer cannot bind later (admin is never bound silently)
        address c = _u(3);
        _depositBoth(c, 200e18, address(0));
        vm.prank(c);
        vm.expectRevert(XiyangMiner.AlreadyBound.selector);
        miner.bind(a);
        assertEq(miner.getUser(c).referrer, address(0));
    }

    function test_countsDedup_exitReenter() public {
        address a = _u(1);
        address b = _u(2);
        address c = _u(3);
        _depositBoth(a, 200e18, address(0));
        uint128 lb = _depositBoth(b, 200e18, a);
        _depositBoth(b, 50e18, a);
        _depositBoth(c, 200e18, b);
        assertEq(miner.getUser(a).directCount, 1);
        assertEq(miner.getUser(a).indirectCount, 1);
        assertEq(miner.getUser(b).directCount, 1);
        uint128 all = miner.getUser(b).liquidity;
        vm.prank(b);
        miner.withdraw(all, 0, 0, block.timestamp);
        _depositBoth(b, 200e18, address(0));
        lb;
        assertEq(miner.getUser(a).directCount, 1, "re-entry does not recount");
        assertEq(miner.getUser(b).referrer, a, "relation kept after exit");
        assertEq(miner.participants(), 3);
    }

    function test_shiftSkipsIneligibleUpline_noDoubleSlot() public {
        address a = _u(1);
        address b = _u(2);
        address c = _u(3);
        _depositBoth(a, 1000e18, address(0));
        _depositBoth(b, 30e18, a); // value ~60 USDT, below 100
        _depositBoth(c, 1000e18, b);
        XiyangMiner.User memory uc = miner.getUser(c);
        assertEq(uc.up1, a, "first eligible upline");
        assertEq(uc.up2, address(0), "a cannot take both slots");
        _keep(1 days, 1 hours);
        address[] memory l = new address[](1);
        l[0] = c;
        miner.settleMany(l);
        (, uint256 db) = _pending(b);
        (, uint256 da) = _pending(a);
        assertEq(db, 0);
        assertApproxEqRel(da, miner.valueUsd(c) * 10 / 10000, 1e12, "a gets 10% (tier 1), not 15%");
    }

    function test_thresholdBoundary() public {
        address a = _u(1);
        _depositBoth(a, 49.5e18, address(0)); // value ~99 USDT
        assertFalse(miner.isEligible(a));
        _depositBoth(a, 1e18, address(0)); // value ~101 USDT
        assertTrue(miner.isEligible(a));
    }

    function test_uplineLossCutsOffMidInterval_andHistoryKept() public {
        address a = _u(1);
        address b = _u(2);
        address c = _u(3);
        _depositBoth(a, 1000e18, address(0));
        uint128 lb = _depositBoth(b, 1000e18, a);
        _depositBoth(c, 1000e18, b);
        _keep(12 hours, 1 hours);
        vm.prank(b);
        miner.withdraw(lb, 0, 0, block.timestamp); // b loses eligibility mid-interval (c not yet settled)
        _keep(12 hours, 1 hours);
        address[] memory l = new address[](1);
        l[0] = c;
        miner.settleMany(l);
        (, uint256 db) = _pending(b);
        uint256 vc = miner.valueUsd(c);
        assertApproxEqRel(db, vc * 10 / 10000 / 2, 1e12, "b paid only until its exit");
        // next interval: b skipped, a becomes tier 1
        assertEq(miner.getUser(c).up1, a);
        _keep(1 days, 1 hours);
        miner.settleMany(l);
        (, uint256 db2) = _pending(b);
        assertEq(db2, db, "earned dynamic kept, nothing new while ineligible");
        // b re-qualifies -> resumes from c's next settlement only (no retroactive pay)
        _depositBoth(b, 1000e18, address(0));
        miner.settleMany(l);
        assertEq(miner.getUser(c).up1, b);
    }

    function test_deepChain_boundedSearch_gas() public {
        // root eligible, then 29 small (ineligible) wallets in a chain, then a leaf
        _depositBoth(_u(0), 1000e18, address(0));
        for (uint256 i = 1; i < 30; ++i) {
            _depositBoth(_u(i), 10e18, _u(i - 1));
        }
        _depositBoth(_u(30), 1000e18, _u(29));
        XiyangMiner.User memory leaf = miner.getUser(_u(30));
        assertEq(leaf.up1, address(0), "root beyond MAX_UPLINE_SEARCH=10 -> unallocated (documented)");
        _keep(1 hours, 1 hours);
        address[] memory l = new address[](1);
        l[0] = _u(30);
        uint256 g = gasleft();
        miner.settleMany(l);
        assertLt(g - gasleft(), 200_000, "settle gas bounded");
        // within depth: _u(9) chain finds root
        assertEq(miner.getUser(_u(9)).up1, _u(0));
        // withdraw on a deep-chain user always executes
        vm.prank(_u(30));
        miner.withdraw(leaf.liquidity, 0, 0, block.timestamp);
    }
}

contract TaxRewardTest is BaseTest {
    TaxToken tax;

    function _rewardToken() internal override returns (MockERC20) {
        tax = new TaxToken();
        return tax;
    }

    function test_transferTaxOnRewardReverts_noSilentShortPay() public {
        _depositBoth(makeAddr("a"), 1000e18, address(0));
        _keep(1 days, 1 hours);
        tax.setTax(true);
        vm.prank(makeAddr("a"));
        vm.expectRevert(XiyangMiner.FeeOnTransfer.selector);
        miner.claim(0);
        (uint256 kept,) = miner.pendingUsd(makeAddr("a"));
        assertGt(kept, 0);
    }
}
