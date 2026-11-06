// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {XiyangMiner} from "../src/XiyangMiner.sol";
import {XiyangMinerV1} from "../src/legacy/XiyangMinerV1.sol";
import {INonfungiblePositionManager} from "../src/interfaces/IPancakeV3.sol";
import {MockERC20, MockV2Factory, MockV2Pair} from "../test/utils/Mocks.sol";

interface IFactoryLike2 {
    function createPool(address a, address b, uint24 fee) external returns (address);
}

interface IPoolAdmin2 {
    function initialize(uint160 sqrtPriceX96) external;
    function increaseObservationCardinalityNext(uint16 n) external;
}

/// Local migration test: the previous contract (V1, rewards by LP value) with users in a referral tree, then the
/// new contract (rewards by 入金额度) on the same pool, reward token and operator wallet.
///   run()       deploy pool + reward pair + V1, operator approves V1
///   users()     6 wallets deposit in V1: 0 (no referrer) <- 1 <- 2, 0 <- 3, 1 <- 4; wallet 5 only binds (no deposit)
///   deployNew() deploy the new contract, operator approves a fixed amount
contract MigrationScenario is Script {
    uint256 constant K0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant K1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // operator = admin

    function _out() internal view returns (string memory) {
        return vm.envOr("OUT", string("./migrate-deploy.json"));
    }

    function run() external {
        address deployer = vm.addr(K0);
        address operator = vm.addr(K1);
        vm.startBroadcast(K0);
        address factory = deployCode("out/UniswapV3Factory.sol/UniswapV3Factory.json");
        address npm = deployCode(
            "out/NonfungiblePositionManager.sol/NonfungiblePositionManager.json", abi.encode(factory, deployer, address(0))
        );
        MockERC20 usdt = new MockERC20("Binance-Peg BSC-USD", "USDT", 18);
        MockERC20 pop = new MockERC20("POP", "POP", 18);
        MockERC20 xyy = new MockERC20("XiYangYang", "XYY", 18);
        address pool = _pool(factory, npm, deployer, address(pop), address(usdt), 100_000_000e18, 1_000_000e18);
        MockV2Factory v2f = new MockV2Factory();
        MockV2Pair v2p = MockV2Pair(v2f.createPair(address(xyy), address(usdt)));
        v2p.setReservesFor(address(xyy), 100_000_000e18, 100_000e18);
        xyy.mint(operator, 1_000_000_000e18);
        XiyangMinerV1 old = new XiyangMinerV1(
            XiyangMinerV1.Config({
                pool: pool,
                npm: npm,
                pop: address(pop),
                usdt: address(usdt),
                reward: address(xyy),
                rewardPool: address(v2p),
                rewardPoolIsV2: true,
                v2Factory: address(v2f),
                operator: operator,
                twapWindow: 1800,
                maxTickDeviation: 300,
                minPoolLiquidity: 1,
                minRewardPoolLiquidity: 1,
                maxValuationAge: 7200,
                runwayDays: 3,
                maxUplineSearch: 10
            })
        );
        vm.stopBroadcast();
        vm.startBroadcast(K1);
        xyy.approve(address(old), 200_000_000e18);
        vm.stopBroadcast();

        string memory j = "mig";
        vm.serializeAddress(j, "old", address(old));
        vm.serializeAddress(j, "miner", address(old));
        vm.serializeAddress(j, "npm", npm);
        vm.serializeAddress(j, "factory", factory);
        vm.serializeAddress(j, "pool", pool);
        vm.serializeAddress(j, "v2Pair", address(v2p));
        vm.serializeAddress(j, "v2Factory", address(v2f));
        vm.serializeAddress(j, "pop", address(pop));
        vm.serializeAddress(j, "usdt", address(usdt));
        vm.serializeAddress(j, "operator", operator);
        string memory out = vm.serializeAddress(j, "reward", address(xyy));
        vm.writeJson(out, _out());
        console2.log("old miner", address(old));
    }

    /// test wallets = anvil's own accounts #2..#7 (unlocked, so the page tests can send from them)
    function userKey(uint256 i) public pure returns (uint256) {
        return vm.deriveKey("test test test test test test test test test test test junk", uint32(i + 2));
    }

    function users() external {
        string memory dj = vm.readFile(_out());
        XiyangMinerV1 m = XiyangMinerV1(vm.parseJsonAddress(dj, ".old"));
        MockERC20 usdt = MockERC20(vm.parseJsonAddress(dj, ".usdt"));
        MockERC20 pop = MockERC20(vm.parseJsonAddress(dj, ".pop"));
        uint256[6] memory refOf = [type(uint256).max, 0, 1, 0, 1, 2];
        for (uint256 i; i < 6; ++i) {
            uint256 k = userKey(i);
            address me = vm.addr(k);
            address ref = refOf[i] == type(uint256).max ? address(0) : vm.addr(userKey(refOf[i]));
            vm.startBroadcast(k);
            usdt.mint(me, 5_000e18);
            pop.mint(me, 500_000e18);
            if (i == 5) {
                m.bind(ref); // bound in the old contract, never deposited
            } else {
                uint256 amt = 300e18 + i * 100e18; // 300, 400, 500, 600, 700 USDT of value
                usdt.approve(address(m), amt / 2);
                pop.approve(address(m), amt * 50);
                m.deposit(
                    XiyangMinerV1.DepositParams({
                        usdtAmount: amt / 2,
                        popAmount: amt * 50,
                        swapUsdtAmount: 0,
                        minPopFromSwap: 0,
                        minUsdtUsed: 0,
                        minPopUsed: 0,
                        referrer: ref,
                        deadline: block.timestamp + 7 days
                    })
                );
            }
            vm.stopBroadcast();
        }
    }

    function deployNew() external {
        string memory dj = vm.readFile(_out());
        vm.startBroadcast(K0);
        XiyangMiner m = new XiyangMiner(
            XiyangMiner.Config({
                pool: vm.parseJsonAddress(dj, ".pool"),
                npm: vm.parseJsonAddress(dj, ".npm"),
                pop: vm.parseJsonAddress(dj, ".pop"),
                usdt: vm.parseJsonAddress(dj, ".usdt"),
                reward: vm.parseJsonAddress(dj, ".reward"),
                rewardPool: vm.parseJsonAddress(dj, ".v2Pair"),
                rewardPoolIsV2: true,
                v2Factory: vm.parseJsonAddress(dj, ".v2Factory"),
                operator: vm.parseJsonAddress(dj, ".operator"),
                twapWindow: 1800,
                maxTickDeviation: 300,
                minPoolLiquidity: 1,
                minRewardPoolLiquidity: 1,
                maxValuationAge: 7200,
                runwayDays: 3,
                maxUplineSearch: 10
            })
        );
        vm.stopBroadcast();
        vm.startBroadcast(K1);
        MockERC20(vm.parseJsonAddress(dj, ".reward")).approve(address(m), 300_000_000e18); // fixed amount
        vm.stopBroadcast();
        vm.writeJson(vm.toString(address(m)), _out(), ".newMiner");
        console2.log("new miner", address(m));
    }

    function _pool(address factory, address npm, address lp, address a, address b, uint256 amtA, uint256 amtB)
        internal
        returns (address p)
    {
        p = IFactoryLike2(factory).createPool(a, b, 500);
        (address t0, address t1, uint256 x0, uint256 x1) = a < b ? (a, b, amtA, amtB) : (b, a, amtB, amtA);
        IPoolAdmin2(p).initialize(uint160(Math.sqrt(Math.mulDiv(x1, 1 << 192, x0))));
        IPoolAdmin2(p).increaseObservationCardinalityNext(100);
        MockERC20(t0).mint(lp, x0);
        MockERC20(t1).mint(lp, x1);
        MockERC20(t0).approve(npm, x0);
        MockERC20(t1).approve(npm, x1);
        INonfungiblePositionManager(npm).mint(
            INonfungiblePositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: 500,
                tickLower: -887270,
                tickUpper: 887270,
                amount0Desired: x0,
                amount1Desired: x1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: lp,
                deadline: block.timestamp + 3600
            })
        );
    }
}
