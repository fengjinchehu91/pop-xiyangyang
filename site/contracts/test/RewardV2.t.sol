// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {XiyangMiner} from "../src/XiyangMiner.sol";
import {MockV2Factory, MockV2Pair} from "./utils/Mocks.sol";

/// Reward price from a PancakeSwap-V2-style pair (cumulative-price TWAP recorded at checkpoints).
/// XYY/USDT V2 pair at 0.001 USDT per XYY (100,000,000 XYY : 100,000 USDT).
contract RewardV2Test is BaseTest {
    MockV2Factory v2f;
    MockV2Pair pair;
    address a = makeAddr("a");

    function _beforeMiner() internal override {
        v2f = new MockV2Factory();
        pair = MockV2Pair(v2f.createPair(address(xyy), address(usdt)));
        pair.setReservesFor(address(xyy), 100_000_000e18, 100_000e18);
        rewardPool = address(pair);
    }

    function _rewardIsV2() internal pure override returns (bool) {
        return true;
    }

    function _v2Factory() internal view override returns (address) {
        return address(v2f);
    }

    function _ready() internal {
        vm.warp(block.timestamp + 31 minutes);
        miner.checkpoint();
    }

    function test_v2_needsHistoryBeforeRunning() public {
        assertTrue(miner.REWARD_V2());
        assertFalse(miner.accruing(), "no 30-min history yet");
        assertEq(miner.pauseReasons() & miner.R_REWARD_PRICE_INVALID(), miner.R_REWARD_PRICE_INVALID());
        (bool ok,) = miner.rewardPriceView();
        assertFalse(ok);
        _ready();
        assertTrue(miner.accruing());
        (bool ok2, uint256 p) = miner.rewardPriceView();
        assertTrue(ok2);
        assertApproxEqRel(p, 0.001e18, 1e12, "0.001 USDT per XYY");
    }

    function test_v2_claimPaysAtTwap() public {
        _ready();
        _depositBoth(a, 1000e18, address(0));
        _keep(1 days, 1 hours);
        (uint256 usd,) = miner.pendingUsd(a);
        vm.prank(a);
        uint256 got = miner.claim(0);
        assertApproxEqRel(got, usd * 1000, 1e9, "usd / 0.001");
        assertEq(xyy.balanceOf(a), got);
    }

    function test_v2_pumpPaysAtSpot_dumpPaysAtAverage_neverPauses() public {
        _ready();
        _depositBoth(a, 1000e18, address(0));
        _keep(6 hours, 1 hours);
        (uint256 usd,) = miner.pendingUsd(a);
        // sudden 4x pump: claims price at the higher spot
        pair.setReservesFor(address(xyy), 50_000_000e18, 200_000e18);
        miner.checkpoint();
        assertTrue(miner.accruing(), "no pause on price swings");
        (bool ok, uint256 p) = miner.rewardPriceView();
        assertTrue(ok);
        assertApproxEqRel(p, 0.004e18, 0.001e18, "spot after the pump: 200k USDT / 50M XYY");
        vm.prank(a);
        uint256 got = miner.claim(0);
        assertApproxEqRel(got, usd * 250, 0.001e18, "usd / 0.004");
        // later a sudden dump: claims keep using the (higher) average, so dumping buys nothing
        _keep(2 hours, 10 minutes);
        (uint256 usd2,) = miner.pendingUsd(a);
        (, uint256 pAvg) = miner.rewardPriceView();
        pair.setReservesFor(address(xyy), 200_000_000e18, 50_000e18);
        (, uint256 pAfterDump) = miner.rewardPriceView();
        assertApproxEqRel(pAfterDump, pAvg, 0.001e18);
        vm.prank(a);
        uint256 got2 = miner.claim(0);
        assertApproxEqRel(got2, usd2 * 1e18 / pAvg, 0.001e18);
        assertLt(got2, usd2 * 1e18 / 0.00025e18, "far fewer than the dumped spot would give");
    }

    function test_v2_fastRiseKeepsRunning() public {
        _ready();
        _depositBoth(a, 1000e18, address(0));
        (uint256 p0,) = miner.pendingUsd(a);
        // price rises 10% every 20 minutes for 4 hours
        uint256 rx = 100_000_000e18;
        uint256 ru = 100_000e18;
        for (uint256 i; i < 12; ++i) {
            ru = ru * 110 / 100;
            pair.setReservesFor(address(xyy), uint112(rx), uint112(ru));
            _keep(20 minutes, 10 minutes);
            assertTrue(miner.accruing(), "fast rise never pauses");
        }
        (uint256 p1,) = miner.pendingUsd(a);
        assertApproxEqRel(p1 - p0, miner.valueUsd(a) * 85 / 10000 * 4 / 24, 1e12, "4 hours fully credited");
        vm.prank(a);
        miner.claim(0);
    }

    function test_v2_shortPumpBarelyMovesTwap() public {
        _ready();
        _keep(2 hours, 10 minutes);
        // pump 4x for 60 seconds, then back (attacker cannot hold it for the whole window cheaply)
        pair.setReservesFor(address(xyy), 50_000_000e18, 200_000e18);
        vm.warp(block.timestamp + 60);
        pair.setReservesFor(address(xyy), 100_000_000e18, 100_000e18);
        vm.warp(block.timestamp + 1);
        (bool ok, uint256 p) = miner.rewardPriceView();
        assertTrue(ok);
        // 60s at 4x lifts a >=30 min average by ~10%; a higher price only means claimers get fewer tokens
        assertLt(p, 0.0012e18, "a short pump moves the average only a little");
        assertGe(p, 0.001e18, "and the claim price never drops below the normal average");
        // once the pump is out of the averaging window the price is normal again
        _keep(1 hours, 10 minutes);
        (bool ok2, uint256 p2) = miner.rewardPriceView();
        assertTrue(ok2);
        assertApproxEqRel(p2, 0.001e18, 0.001e18);
    }

    function test_v2_sustainedMoveIsTracked() public {
        _ready();
        // price drifts down 2% and stays there
        pair.setReservesFor(address(xyy), 102_000_000e18, 100_000e18);
        _keep(2 hours, 10 minutes);
        (bool ok, uint256 p) = miner.rewardPriceView();
        assertTrue(ok);
        assertApproxEqRel(p, uint256(1e15) * 100 / 102, 0.002e18);
    }

    function test_v2_keeperOffline_staleSnapshotsDisablePrice() public {
        _ready();
        vm.warp(block.timestamp + 3 hours); // no checkpoints: newest snapshot is 3h old (> 4 x 30 min)
        (bool ok,) = miner.rewardPriceView();
        assertFalse(ok);
        miner.checkpoint(); // records a fresh snapshot, but nothing is 30 min old yet
        assertFalse(miner.accruing());
        _ready();
        assertTrue(miner.accruing());
    }

    function test_v2_snapshotRateLimited() public {
        uint8 before = miner.obsCount();
        miner.checkpoint();
        miner.checkpoint();
        assertEq(miner.obsCount(), before, "at most one snapshot per TWAP_WINDOW/6");
        vm.warp(block.timestamp + 5 minutes);
        miner.checkpoint();
        assertEq(miner.obsCount(), before + 1);
        // ring buffer wraps without growing
        for (uint256 i; i < 40; ++i) {
            vm.warp(block.timestamp + 5 minutes);
            miner.checkpoint();
        }
        assertEq(miner.obsCount(), 24);
        (bool ok,) = miner.rewardPriceView();
        assertTrue(ok);
    }

    function test_v2_wrongFactoryRejected() public {
        MockV2Factory other = new MockV2Factory();
        XiyangMiner.Config memory c = _config();
        c.v2Factory = address(other);
        vm.expectRevert(abi.encodeWithSelector(XiyangMiner.BadConfig.selector, "v2 factory"));
        new XiyangMiner(c);
        // a pair the factory does not know
        MockV2Pair fake = new MockV2Pair(address(xyy), address(usdt));
        c = _config();
        c.rewardPool = address(fake);
        vm.expectRevert(abi.encodeWithSelector(XiyangMiner.BadConfig.selector, "v2 factory"));
        new XiyangMiner(c);
    }

    function test_v2_pairWithoutRewardTokenRejected() public {
        MockV2Pair p2 = MockV2Pair(v2f.createPair(address(pop), address(usdt)));
        XiyangMiner.Config memory c = _config();
        c.rewardPool = address(p2);
        vm.expectRevert(abi.encodeWithSelector(XiyangMiner.BadConfig.selector, "reward pool tokens"));
        new XiyangMiner(c);
    }

    function test_v2_viaPopRoute() public {
        // XYY/POP V2 pair: 1 XYY = 0.1 POP, and POP = 0.01 USDT on the V3 pool -> 0.001 USDT
        MockV2Pair pp = MockV2Pair(v2f.createPair(address(xyy), address(pop)));
        pp.setReservesFor(address(xyy), 100_000_000e18, 10_000_000e18);
        XiyangMiner.Config memory c = _config();
        c.rewardPool = address(pp);
        XiyangMiner m2 = new XiyangMiner(c);
        assertTrue(m2.REWARD_VIA_POP());
        m2.checkpoint();
        vm.warp(block.timestamp + 31 minutes);
        m2.checkpoint();
        (bool ok, uint256 p) = m2.rewardPriceView();
        assertTrue(ok);
        assertApproxEqRel(p, 0.001e18, 0.001e18);
    }
}
