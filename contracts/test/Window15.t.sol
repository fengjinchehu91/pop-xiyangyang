// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {XiyangMiner} from "../src/XiyangMiner.sol";
import {MockV2Factory, MockV2Pair} from "./utils/Mocks.sol";

/// The mainnet setting: 15-minute average price (twapWindow 900) with the 喜羊羊 price from a V2 pair.
/// Snapshots older than 4 x 15 = 60 minutes are not used, so the keeper's 25-minute checks must keep it running.
contract Window15Test is BaseTest {
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

    function _config() internal view override returns (XiyangMiner.Config memory c) {
        c = super._config();
        c.twapWindow = 900;
    }

    function test_15min_windowStored() public view {
        assertEq(miner.TWAP_WINDOW(), 900);
    }

    function test_15min_startsAfter15Minutes() public {
        assertFalse(miner.accruing(), "no price history right after deployment");
        vm.warp(block.timestamp + 14 minutes);
        miner.checkpoint();
        assertFalse(miner.accruing(), "still under 15 minutes");
        vm.warp(block.timestamp + 2 minutes);
        miner.checkpoint();
        assertTrue(miner.accruing(), "running after 15 minutes");
        (bool ok, uint256 p) = miner.rewardPriceView();
        assertTrue(ok);
        assertApproxEqRel(p, 0.001e18, 1e12);
    }

    function _ready() internal {
        vm.warp(block.timestamp + 16 minutes);
        miner.checkpoint();
        assertTrue(miner.accruing());
    }

    function test_15min_principalBookedAndDeposit() public {
        _ready();
        _depositBoth(a, 1000e18, address(0));
        XiyangMiner.User memory u = miner.getUser(a);
        assertApproxEqRel(u.principalUsd, 2000e18, 0.01e18, "principal ~ value put in (1000 USDT + 1000 USDT of POP)");
    }

    function test_15min_keeperEvery25Minutes_staysRunningForADay() public {
        _ready();
        _depositBoth(a, 1000e18, address(0));
        for (uint256 i; i < 58; ++i) {
            vm.warp(block.timestamp + 25 minutes);
            miner.checkpoint();
            assertTrue(miner.accruing(), "25-minute checks keep it running");
        }
        (uint256 usd,) = miner.pendingUsd(a);
        // 58 x 25 min = 24.17 h at 1%/day x 85% on ~2000 principal
        uint256 expected = uint256(2000e18) * 85 / 10000 * 1450 / 1440;
        assertApproxEqRel(usd, expected, 0.01e18);
    }

    function test_15min_busyClaimsAndDepositsDoNotBreakThePrice() public {
        _ready();
        _depositBoth(a, 1000e18, address(0));
        for (uint256 i; i < 60; ++i) {
            vm.warp(block.timestamp + 3 minutes);
            miner.checkpoint(); // every user action records a snapshot like this
            assertTrue(miner.accruing());
        }
        vm.prank(a);
        assertGt(miner.claim(0), 0);
    }

    function test_15min_keeperOfflineOverAnHour_pausesThenRecoversByItself() public {
        _ready();
        _depositBoth(a, 1000e18, address(0));
        vm.warp(block.timestamp + 61 minutes);
        miner.checkpoint();
        assertFalse(miner.accruing(), "snapshots older than 60 minutes are not used");
        assertEq(miner.pauseReasons() & miner.R_REWARD_PRICE_INVALID(), miner.R_REWARD_PRICE_INVALID());
        vm.warp(block.timestamp + 16 minutes);
        miner.checkpoint();
        assertTrue(miner.accruing(), "back to normal once the keeper runs again");
    }
}
