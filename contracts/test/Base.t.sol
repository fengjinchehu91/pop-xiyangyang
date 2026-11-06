// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {XiyangMiner} from "../src/XiyangMiner.sol";
import {INonfungiblePositionManager} from "../src/interfaces/IPancakeV3.sol";
import {MockERC20, Swapper} from "./utils/Mocks.sol";

interface IFactoryLike {
    function createPool(address a, address b, uint24 fee) external returns (address);
}

interface IPoolAdmin {
    function initialize(uint160 sqrtPriceX96) external;
    function increaseObservationCardinalityNext(uint16 n) external;
}

/// Shared fixture: a real V3 factory/pool/NPM (Uniswap 0.8 sources; same math & ABI as Pancake V3),
/// POP/USDT pool at 0.01 USDT per POP, XYY/USDT reward pool at 0.001 USDT per XYY.
abstract contract BaseTest is Test {
    uint24 internal constant FEE = 500; // tickSpacing 10 on the Uniswap factory
    address internal factory;
    INonfungiblePositionManager internal npm;
    MockERC20 internal usdt;
    MockERC20 internal pop;
    MockERC20 internal xyy;
    address internal pool;
    address internal rewardPool;
    XiyangMiner internal miner;
    Swapper internal swapper;

    address internal operator = makeAddr("operator");
    address internal lp = makeAddr("lp");
    address internal trader = makeAddr("trader");

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        factory = deployCode("out/UniswapV3Factory.sol/UniswapV3Factory.json");
        npm = INonfungiblePositionManager(
            deployCode(
                "out/NonfungiblePositionManager.sol/NonfungiblePositionManager.json",
                abi.encode(factory, makeAddr("weth"), address(0))
            )
        );
        usdt = new MockERC20("Binance-Peg BSC-USD", "USDT", 18);
        pop = new MockERC20("POP", "POP", 18);
        xyy = _rewardToken();
        swapper = new Swapper();

        pool = _makePool(address(pop), address(usdt), 100_000_000e18, 1_000_000e18);
        rewardPool = _makePool(address(xyy), address(usdt), 100_000_000e18, 100_000e18);
        vm.warp(block.timestamp + 2 hours); // build TWAP history
        _beforeMiner();

        miner = new XiyangMiner(_config());
        xyy.mint(operator, 1_000_000_000e18);
        vm.prank(operator);
        xyy.approve(address(miner), 500_000_000e18);
        miner.checkpoint();
    }

    function _beforeMiner() internal virtual {}

    function _rewardIsV2() internal view virtual returns (bool) {
        return false;
    }

    function _v2Factory() internal view virtual returns (address) {
        return address(0);
    }

    function _rewardToken() internal virtual returns (MockERC20) {
        return new MockERC20("XiYangYang", "XYY", 18);
    }

    function _config() internal view virtual returns (XiyangMiner.Config memory c) {
        c = XiyangMiner.Config({
            pool: pool,
            npm: address(npm),
            pop: address(pop),
            usdt: address(usdt),
            reward: address(xyy),
            rewardPool: rewardPool,
            rewardPoolIsV2: _rewardIsV2(),
            v2Factory: _v2Factory(),
            operator: operator,
            twapWindow: 1800,
            maxTickDeviation: 300,
            minPoolLiquidity: 1,
            minRewardPoolLiquidity: 1,
            maxValuationAge: 7200,
            runwayDays: 3,
            maxUplineSearch: 10
        });
    }

    function _makePool(address a, address b, uint256 amtA, uint256 amtB) internal returns (address p) {
        p = IFactoryLike(factory).createPool(a, b, FEE);
        (address t0, address t1, uint256 x0, uint256 x1) = a < b ? (a, b, amtA, amtB) : (b, a, amtB, amtA);
        IPoolAdmin(p).initialize(uint160(Math.sqrt(Math.mulDiv(x1, 1 << 192, x0))));
        IPoolAdmin(p).increaseObservationCardinalityNext(100);
        MockERC20(t0).mint(lp, x0);
        MockERC20(t1).mint(lp, x1);
        vm.startPrank(lp);
        MockERC20(t0).approve(address(npm), x0);
        MockERC20(t1).approve(address(npm), x1);
        npm.mint(
            INonfungiblePositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: FEE,
                tickLower: -887270,
                tickUpper: 887270,
                amount0Desired: x0,
                amount1Desired: x1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: lp,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _fund(address u, uint256 usdtAmt, uint256 popAmt) internal {
        usdt.mint(u, usdtAmt);
        pop.mint(u, popAmt);
        vm.startPrank(u);
        usdt.approve(address(miner), type(uint256).max);
        pop.approve(address(miner), type(uint256).max);
        vm.stopPrank();
    }

    function _p(uint256 usdtAmt, uint256 popAmt, uint256 swapAmt, address ref)
        internal
        view
        returns (XiyangMiner.DepositParams memory)
    {
        return XiyangMiner.DepositParams({
            usdtAmount: usdtAmt,
            popAmount: popAmt,
            swapUsdtAmount: swapAmt,
            minPopFromSwap: 0,
            minUsdtUsed: 0,
            minPopUsed: 0,
            referrer: ref,
            deadline: block.timestamp + 600
        });
    }

    /// USDT-only zap: swap ~half (adjusted for the 0.05% fee) and add.
    function _depositUsdt(address u, uint256 amt, address ref) internal returns (uint128 liq) {
        _fund(u, amt, 0);
        vm.prank(u);
        liq = miner.deposit(_p(amt, 0, amt * 10000 / 19995, ref));
    }

    /// Two-token deposit at the pool price (0.01 USDT/POP).
    function _depositBoth(address u, uint256 usdtAmt, address ref) internal returns (uint128 liq) {
        _fund(u, usdtAmt, usdtAmt * 100);
        vm.prank(u);
        liq = miner.deposit(_p(usdtAmt, usdtAmt * 100, 0, ref));
    }

    /// keeper running every `step` seconds for `total` seconds
    function _keep(uint256 total, uint256 step) internal {
        for (uint256 t; t < total; t += step) {
            vm.warp(block.timestamp + step);
            miner.checkpoint();
        }
    }

    function _pending(address u) internal view returns (uint256 personal, uint256 dyn) {
        return miner.pendingUsd(u);
    }

    function _swap(address tokenIn, address p, uint256 amt) internal returns (uint256) {
        MockERC20(tokenIn).mint(trader, amt);
        vm.startPrank(trader);
        MockERC20(tokenIn).approve(address(swapper), amt);
        uint256 out = swapper.swapExactIn(p, tokenIn, amt);
        vm.stopPrank();
        return out;
    }
}
