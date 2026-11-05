// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {XiyangMiner} from "../src/XiyangMiner.sol";
import {INonfungiblePositionManager} from "../src/interfaces/IPancakeV3.sol";
import {MockERC20, MockV2Factory, MockV2Pair} from "../test/utils/Mocks.sol";

interface IFactoryLike {
    function createPool(address a, address b, uint24 fee) external returns (address);
}

interface IPoolAdmin {
    function initialize(uint160 sqrtPriceX96) external;
    function increaseObservationCardinalityNext(uint16 n) external;
}

/// Local test stack for the Cloudflare keeper: same shape as mainnet (V3 POP/USDT pool + V2 reward pair).
/// Step 1 (`run`): deploy + operator approval. Step 2 (`users`, after warping >30 min): N users in a referral tree.
contract KeeperScenario is Script {
    uint256 constant K0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant K1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

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
        XiyangMiner m = new XiyangMiner(
            XiyangMiner.Config({
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
        xyy.approve(address(m), 500_000_000e18);
        vm.stopBroadcast();

        string memory j = "keeper";
        vm.serializeAddress(j, "miner", address(m));
        vm.serializeAddress(j, "pool", pool);
        vm.serializeAddress(j, "v2Pair", address(v2p));
        vm.serializeAddress(j, "pop", address(pop));
        vm.serializeAddress(j, "usdt", address(usdt));
        vm.serializeAddress(j, "operator", operator);
        string memory out = vm.serializeAddress(j, "reward", address(xyy));
        vm.writeJson(out, vm.envOr("OUT", string("./keeper-deploy.json")));
        console2.log("miner", address(m));
    }

    function userKey(uint256 i) public pure returns (uint256) {
        return uint256(keccak256(abi.encode("xyy-keeper-user", i))) % 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140 + 1;
    }

    /// N users; user 0 is the root (no referrer), user i is referred by user (i-1)/3. Every 7th user deposits only
    /// 40 USDT of value (below the 100 USDT referral threshold) so that skipping ineligible uplines is exercised.
    function users() external {
        string memory dj = vm.readFile(vm.envOr("OUT", string("./keeper-deploy.json")));
        XiyangMiner m = XiyangMiner(vm.parseJsonAddress(dj, ".miner"));
        MockERC20 usdt = MockERC20(vm.parseJsonAddress(dj, ".usdt"));
        MockERC20 pop = MockERC20(vm.parseJsonAddress(dj, ".pop"));
        uint256 n = vm.envOr("N", uint256(40));
        uint256 start = vm.envOr("START", uint256(0));

        vm.startBroadcast(K0);
        for (uint256 i = start; i < start + n; ++i) {
            payable(vm.addr(userKey(i))).transfer(1 ether);
        }
        vm.stopBroadcast();

        for (uint256 i = start; i < start + n; ++i) {
            uint256 k = userKey(i);
            address ref = i == 0 ? address(0) : vm.addr(userKey((i - 1) / 3));
            uint256 amt = i % 7 == 6 ? 40e18 : 200e18 + (i % 5) * 100e18;
            vm.startBroadcast(k);
            // USDT + POP (no swap) so hundreds of test deposits do not move the pool price
            usdt.mint(vm.addr(k), amt / 2);
            usdt.approve(address(m), amt / 2);
            pop.mint(vm.addr(k), amt * 75);
            pop.approve(address(m), amt * 75);
            m.deposit(
                XiyangMiner.DepositParams({
                    usdtAmount: amt / 2,
                    popAmount: amt * 75,
                    swapUsdtAmount: 0,
                    minPopFromSwap: 0,
                    minUsdtUsed: 0,
                    minPopUsed: 0,
                    referrer: ref,
                    deadline: block.timestamp + 7 days
                })
            );
            vm.stopBroadcast();
        }
    }

    function _pool(address factory, address npm, address lp, address a, address b, uint256 amtA, uint256 amtB)
        internal
        returns (address p)
    {
        p = IFactoryLike(factory).createPool(a, b, 500);
        (address t0, address t1, uint256 x0, uint256 x1) = a < b ? (a, b, amtA, amtB) : (b, a, amtB, amtA);
        IPoolAdmin(p).initialize(uint160(Math.sqrt(Math.mulDiv(x1, 1 << 192, x0))));
        IPoolAdmin(p).increaseObservationCardinalityNext(100);
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
