// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20Metadata} from "oz5/token/ERC20/extensions/IERC20Metadata.sol";
import {XiyangMiner} from "../src/XiyangMiner.sol";
import {IPancakeV3Pool, IPancakeV3Factory, INonfungiblePositionManager} from "../src/interfaces/IPancakeV3.sol";

/// BSC fork test at a pinned block. Run:
///   BSC_RPC_URL=<archive rpc> FORK_BLOCK=<n> REWARD_POOL=<xyy V3 pool> forge test --match-contract ForkTest -vv
/// Skips (passes trivially with a log line) when BSC_RPC_URL is not set.
contract ForkTest is Test {
    address constant XYY = 0x4dDA46C9dD7e794B99eebDcfD3c82bfBD3207777;
    address constant POP = 0xA3cfB853339b77F385B994799B015cB04b208Fe6;
    address constant POOL = 0xE5ce5bc4785CD2a246151364f5A190ceE3FDb142;
    address constant OPERATOR = 0xe034Ab3ec8C6309A322c85acadbe81778836e296;
    // Candidates from PancakeSwap docs / public sources; the test asserts them on-chain.
    address constant PCS_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address constant PCS_NPM = 0x46A15B0b27311cedF172AB29E4f4766fbE7F4364;
    address constant BSC_USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant PCS_V2_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;

    bool internal live;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blk);
        live = true;
    }

    function test_fork_verifyAddresses() public view {
        if (!live) {
            console2.log("SKIPPED: BSC_RPC_URL not set");
            return;
        }
        assertEq(block.chainid, 56);
        for (uint256 i; i < 5; ++i) {
            address a = [XYY, POP, POOL, PCS_V3_FACTORY, PCS_NPM][i];
            assertGt(a.code.length, 0, "no code");
        }
        IPancakeV3Pool p = IPancakeV3Pool(POOL);
        address t0 = p.token0();
        address t1 = p.token1();
        address usdt = t0 == POP ? t1 : t0;
        assertTrue(t0 == POP || t1 == POP, "pool does not contain POP");
        assertEq(usdt, BSC_USDT, "pool quote token is not the known BSC-USD");
        assertEq(p.factory(), PCS_V3_FACTORY, "pool factory");
        assertEq(IPancakeV3Factory(PCS_V3_FACTORY).getPool(t0, t1, p.fee()), POOL, "factory.getPool");
        assertEq(INonfungiblePositionManager(PCS_NPM).factory(), PCS_V3_FACTORY, "npm factory");
        console2.log("fee", p.fee());
        console2.log("tickSpacing", uint256(int256(p.tickSpacing())));
        console2.log("USDT decimals", IERC20Metadata(usdt).decimals());
        console2.log("POP symbol", IERC20Metadata(POP).symbol());
        console2.log("POP decimals", IERC20Metadata(POP).decimals());
        console2.log("XYY symbol", IERC20Metadata(XYY).symbol());
        console2.log("XYY decimals", IERC20Metadata(XYY).decimals());
        (,, uint16 idx, uint16 card, uint16 cardNext,,) = p.slot0();
        console2.log("observation index", idx);
        console2.log("observation cardinality", card, cardNext);
        console2.log("pool liquidity", p.liquidity());
    }

    /// Transfer-behaviour probe: move tokens out of the pool (a holder) and compare sent vs received.
    function test_fork_transferTaxProbe() public {
        if (!live) return;
        address[2] memory toks = [POP, BSC_USDT];
        for (uint256 i; i < 2; ++i) {
            IERC20Metadata t = IERC20Metadata(toks[i]);
            address to = makeAddr(string(abi.encodePacked("probe", i)));
            uint256 amt = t.balanceOf(POOL) / 1000;
            vm.prank(POOL);
            t.transfer(to, amt);
            assertEq(t.balanceOf(to), amt, "transfer tax / non-standard transfer detected");
        }
        address rp = vm.envOr("REWARD_POOL", address(0xc06924c9234B39376Ea80b21aea49ae692BC5bAC));
        if (rp != address(0)) {
            IERC20Metadata x = IERC20Metadata(XYY);
            address to2 = makeAddr("probeXYY");
            uint256 amt2 = x.balanceOf(rp) / 1000;
            vm.prank(rp);
            x.transfer(to2, amt2);
            assertEq(x.balanceOf(to2), amt2, "XYY transfer tax detected: production must stay disabled");
        }
    }

    /// Full principal path on the real pool: USDT-only zap -> custody -> partial + full exit.
    function test_fork_depositWithdraw() public {
        if (!live) return;
        address rewardPool = vm.envOr("REWARD_POOL", address(0xc06924c9234B39376Ea80b21aea49ae692BC5bAC));
        if (rewardPool == address(0)) {
            console2.log("SKIPPED: REWARD_POOL (XYY V3 pool) not set");
            return;
        }
        XiyangMiner m = new XiyangMiner(
            XiyangMiner.Config({
                pool: POOL,
                npm: PCS_NPM,
                pop: POP,
                usdt: BSC_USDT,
                reward: XYY,
                rewardPool: rewardPool,
                rewardPoolIsV2: vm.envOr("REWARD_POOL_IS_V2", true),
                v2Factory: vm.envOr("V2_FACTORY", PCS_V2_FACTORY),
                operator: OPERATOR,
                twapWindow: 1800,
                maxTickDeviation: 300,
                minPoolLiquidity: 1,
                minRewardPoolLiquidity: 1,
                maxValuationAge: 7200,
                runwayDays: 3,
                maxUplineSearch: 10
            })
        );
        // simulate the operator approving a finite allowance on the fork only
        vm.prank(OPERATOR);
        IERC20Metadata(XYY).approve(address(m), 1e30);
        bool running = m.checkpoint();
        console2.log("running", running);
        console2.log("reasons", m.pauseReasons());
        if (!running) return; // oracle history / reserve not sufficient on this block: reported, not faked

        address user = makeAddr("forkUser");
        deal(BSC_USDT, user, 1000e18);
        vm.startPrank(user);
        IERC20Metadata(BSC_USDT).approve(address(m), type(uint256).max);
        uint128 liq = m.deposit(
            XiyangMiner.DepositParams({
                usdtAmount: 1000e18,
                popAmount: 0,
                swapUsdtAmount: 500e18,
                minPopFromSwap: 0,
                minUsdtUsed: 0,
                minPopUsed: 0,
                referrer: address(0),
                deadline: block.timestamp + 600
            })
        );
        assertEq(INonfungiblePositionManager(PCS_NPM).ownerOf(m.getUser(user).tokenId), address(m));
        console2.log("value USD (18d)", m.valueUsd(user));
        m.withdraw(liq / 2, 0, 0, block.timestamp);
        m.withdraw(liq - liq / 2, 0, 0, block.timestamp);
        vm.stopPrank();
        assertEq(m.getUser(user).liquidity, 0);
    }
}
