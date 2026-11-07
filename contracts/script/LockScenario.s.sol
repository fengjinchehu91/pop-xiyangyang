// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {XiyangMiner} from "../src/XiyangMiner.sol";
import {INonfungiblePositionManager} from "../src/interfaces/IPancakeV3.sol";
import {MockERC20} from "../test/utils/Mocks.sol";
import {MockSwapFactory, MockSwapPair} from "../test/utils/LockMocks.sol";

interface IFactoryLike3 {
    function createPool(address a, address b, uint24 fee) external returns (address);
}

interface IPoolAdmin3 {
    function initialize(uint160 sqrtPriceX96) external;
    function increaseObservationCardinalityNext(uint16 n) external;
}

/// Local lock test chain, shaped like BSC today: POP/USDT on V3, 喜羊羊/POP on a V2 pair, the mining contract live.
///   run()   pool + 喜羊羊/POP pair + mining contract (15-minute average price), operator approves the miner
///   users() mining deposits and referral chain  U0 <- U1 <- U2 <- U3 <- U4
///           U0, U1: 200 USD in mining (eligible);  U2, U3: 50 USD (joined, not eligible);  U4: bound only
///           everyone gets 5,000 USDT; U2 and U4 also get 喜羊羊 in the wallet (for "lock what I hold")
/// The lock contract itself is deployed by the website's deploy page (tools/e2e-lock.cjs).
contract LockScenario is Script {
    uint256 constant K0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant K1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // operator = admin

    function _out() internal view returns (string memory) {
        return vm.envOr("OUT", string("./lock-deploy.json"));
    }

    function userKey(uint256 i) public pure returns (uint256) {
        return vm.deriveKey("test test test test test test test test test test test junk", uint32(i + 2));
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
        // POP = 0.01 USDT
        address pool = _pool(factory, npm, deployer, address(pop), address(usdt), 100_000_000e18, 1_000_000e18);
        // 喜羊羊 = 0.1 POP = 0.001 USDT
        MockSwapFactory sf = new MockSwapFactory();
        MockSwapPair pair = MockSwapPair(sf.createPair(address(xyy), address(pop)));
        xyy.mint(address(pair), 100_000_000e18);
        pop.mint(address(pair), 10_000_000e18);
        pair.sync();
        xyy.mint(operator, 1_000_000_000e18);
        XiyangMiner m = new XiyangMiner(
            XiyangMiner.Config({
                pool: pool,
                npm: npm,
                pop: address(pop),
                usdt: address(usdt),
                reward: address(xyy),
                rewardPool: address(pair),
                rewardPoolIsV2: true,
                v2Factory: address(sf),
                operator: operator,
                twapWindow: 900,
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
        xyy.approve(address(m), 300_000_000e18); // fixed amount
        vm.stopBroadcast();

        string memory j = "lock";
        vm.serializeAddress(j, "miner", address(m));
        vm.serializeAddress(j, "npm", npm);
        vm.serializeAddress(j, "factory", factory);
        vm.serializeAddress(j, "pool", pool);
        vm.serializeAddress(j, "pair", address(pair));
        vm.serializeAddress(j, "swapFactory", address(sf));
        vm.serializeAddress(j, "pop", address(pop));
        vm.serializeAddress(j, "usdt", address(usdt));
        vm.serializeAddress(j, "operator", operator);
        string memory out = vm.serializeAddress(j, "reward", address(xyy));
        vm.writeJson(out, _out());
        console2.log("miner", address(m));
    }

    function users() external {
        string memory dj = vm.readFile(_out());
        XiyangMiner m = XiyangMiner(vm.parseJsonAddress(dj, ".miner"));
        MockERC20 usdt = MockERC20(vm.parseJsonAddress(dj, ".usdt"));
        MockERC20 pop = MockERC20(vm.parseJsonAddress(dj, ".pop"));
        MockERC20 xyy = MockERC20(vm.parseJsonAddress(dj, ".reward"));
        uint256[5] memory value = [uint256(200e18), 200e18, 50e18, 50e18, 0];
        for (uint256 i; i < 5; ++i) {
            uint256 k = userKey(i);
            address me = vm.addr(k);
            address ref = i == 0 ? address(0) : vm.addr(userKey(i - 1));
            vm.startBroadcast(k);
            usdt.mint(me, 5_000e18);
            if (i == 2) xyy.mint(me, 400_000e18); // about 400 USD at 0.001
            if (i == 4) xyy.mint(me, 20_000e18); // about 20 USD
            uint256 amt = value[i];
            if (amt == 0) {
                m.bind(ref);
            } else {
                pop.mint(me, amt * 50);
                usdt.approve(address(m), amt / 2);
                pop.approve(address(m), amt * 50);
                m.deposit(
                    XiyangMiner.DepositParams({
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

    function _pool(address factory, address npm, address lp, address a, address b, uint256 amtA, uint256 amtB)
        internal
        returns (address p)
    {
        p = IFactoryLike3(factory).createPool(a, b, 500);
        (address t0, address t1, uint256 x0, uint256 x1) = a < b ? (a, b, amtA, amtB) : (b, a, amtB, amtA);
        IPoolAdmin3(p).initialize(uint160(Math.sqrt(Math.mulDiv(x1, 1 << 192, x0))));
        IPoolAdmin3(p).increaseObservationCardinalityNext(100);
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
