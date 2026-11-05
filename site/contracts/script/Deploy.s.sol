// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {XiyangMiner} from "../src/XiyangMiner.sol";

/// Deploys XiyangMiner. All addresses come from env and are re-validated by the constructor
/// (pool tokens, factory.getPool, NPM.factory, reward pool pairing, decimals).
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast   (local/fork only unless you decide otherwise)
/// No private key is stored in this repo; pass one via --account / --ledger / --private-key at run time.
contract Deploy is Script {
    function run() external returns (XiyangMiner m) {
        XiyangMiner.Config memory c = XiyangMiner.Config({
            pool: vm.envAddress("POOL"),
            npm: vm.envAddress("NPM"),
            pop: vm.envAddress("POP"),
            usdt: vm.envAddress("USDT"),
            reward: vm.envAddress("REWARD"),
            rewardPool: vm.envAddress("REWARD_POOL"),
            rewardPoolIsV2: vm.envOr("REWARD_POOL_IS_V2", false),
            v2Factory: vm.envOr("V2_FACTORY", address(0)),
            operator: vm.envAddress("OPERATOR"),
            twapWindow: uint32(vm.envOr("TWAP_WINDOW", uint256(1800))),
            maxTickDeviation: int24(int256(vm.envOr("MAX_TICK_DEVIATION", uint256(300)))),
            minPoolLiquidity: uint128(vm.envOr("MIN_POOL_LIQUIDITY", uint256(1))),
            minRewardPoolLiquidity: uint128(vm.envOr("MIN_REWARD_POOL_LIQUIDITY", uint256(1))),
            maxValuationAge: uint32(vm.envOr("MAX_VALUATION_AGE", uint256(7200))),
            runwayDays: uint16(vm.envOr("RUNWAY_DAYS", uint256(3))),
            maxUplineSearch: uint8(vm.envOr("MAX_UPLINE_SEARCH", uint256(10)))
        });
        vm.startBroadcast();
        m = new XiyangMiner(c);
        vm.stopBroadcast();
        console2.log("XiyangMiner", address(m));
        console2.log("tickLower", int256(m.TICK_LOWER()));
        console2.log("tickUpper", int256(m.TICK_UPPER()));
    }
}
