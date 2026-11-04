// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {XiyangMiner} from "../src/XiyangMiner.sol";
import {INonfungiblePositionManager} from "../src/interfaces/IPancakeV3.sol";
import {MockERC20} from "../test/utils/Mocks.sol";

interface IFactoryLike {
    function createPool(address a, address b, uint24 fee) external returns (address);
}

interface IPoolAdmin {
    function initialize(uint160 sqrtPriceX96) external;
    function increaseObservationCardinalityNext(uint16 n) external;
}

/// LOCAL CHAIN ONLY (Anvil). Deploys a real V3 factory/pool/NPM, mock USDT/POP/XYY, two pools and the miner.
///   anvil &  forge script script/LocalSetup.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
/// Uses Anvil's public default accounts: #0 deployer/LP, #1 operator (admin), #2 test user.
contract LocalSetup is Script {
    uint256 constant K0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant K1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    address constant USER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;

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
        address rpool = _pool(factory, npm, deployer, address(xyy), address(usdt), 100_000_000e18, 100_000e18);
        usdt.mint(USER, 10_000e18);
        pop.mint(USER, 1_000_000e18);
        xyy.mint(operator, 1_000_000_000e18);
        XiyangMiner m = new XiyangMiner(
            XiyangMiner.Config({
                pool: pool,
                npm: npm,
                pop: address(pop),
                usdt: address(usdt),
                reward: address(xyy),
                rewardPool: rpool,
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

        string memory j = "local";
        vm.serializeAddress(j, "miner", address(m));
        vm.serializeAddress(j, "pool", pool);
        vm.serializeAddress(j, "npm", npm);
        vm.serializeAddress(j, "factory", factory);
        vm.serializeAddress(j, "rewardPool", rpool);
        vm.serializeAddress(j, "pop", address(pop));
        vm.serializeAddress(j, "usdt", address(usdt));
        vm.serializeAddress(j, "operator", operator);
        vm.serializeAddress(j, "user", USER);
        string memory out = vm.serializeAddress(j, "reward", address(xyy));
        vm.writeJson(out, "./local-deploy.json");
        console2.log("miner", address(m));
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
