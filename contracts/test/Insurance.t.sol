// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {PopInsurance} from "../src/PopInsurance.sol";
import {MockERC20} from "./utils/Mocks.sol";

/// POP 保险池: buying, selling lot by lot, compensation, profit fee split, 7-level referral, books, admin, abuse cases.
/// Fixture pool: 0.01 USDT per POP, 1M USDT / 100M POP, fee 0.05%.
contract InsuranceTest is BaseTest {
    PopInsurance internal ins;
    address internal admin = makeAddr("admin"); // 主管理员 (written in at deployment)
    address internal poolW = makeAddr("poolWallet"); // 资金池钱包
    address internal sub1 = makeAddr("sub1");

    address internal u = makeAddr("u");

    function setUp() public override {
        super.setUp();
        vm.prank(makeAddr("anyDeployer")); // anyone can deploy; the 主管理员 is written in
        ins = new PopInsurance(
            PopInsurance.Config({usdt: address(usdt), pop: address(pop), pool: pool, miner: address(miner), poolWallet: poolW, owner: admin})
        );
        usdt.mint(poolW, 100_000e18);
        vm.prank(poolW);
        usdt.approve(address(ins), 50_000e18);
        // the pool wallet's USDT already sitting there counts as insurance
        vm.prank(admin);
        ins.adjustBook(0, 50_000e18);
    }

    // ---------------------------------------------------------------- helpers

    function _buy(address who, uint256 amt) internal returns (uint256 id) {
        usdt.mint(who, amt);
        uint256 r = ins.rev();
        vm.startPrank(who);
        usdt.approve(address(ins), amt); // exactly this purchase
        id = ins.buy(amt, 1, block.timestamp + 600, r);
        vm.stopPrank();
    }

    function _sell(address who, uint256 id, uint256 q) internal returns (uint256 toUser, uint256 comp) {
        vm.prank(who);
        (toUser, comp) = ins.sell(id, q, 0, block.timestamp + 600);
    }

    function _lot(address who, uint256 id) internal view returns (PopInsurance.Lot memory) {
        return ins.lotOf(who, id);
    }

    /// move the POP price and let the 15-minute average follow (and the miner keep checkpointing)
    function _movePrice(bool up, uint256 usdtOrPop) internal {
        if (up) _swap(address(usdt), pool, usdtOrPop);
        else _swap(address(pop), pool, usdtOrPop);
        vm.warp(block.timestamp + 1200);
        miner.checkpoint();
    }

    function _wait(uint256 d) internal {
        vm.warp(block.timestamp + d);
        miner.checkpoint();
    }

    function _book(uint8 b) internal view returns (PopInsurance.Book memory) {
        return ins.books()[b];
    }

    // ---------------------------------------------------------------- buying

    function test_buy_records_lot_and_fee() public {
        uint256 w0 = usdt.balanceOf(poolW);
        uint256 id = _buy(u, 1000e18);
        PopInsurance.Lot memory l = _lot(u, id);
        assertEq(id, 0);
        assertEq(l.paid, 1000e18);
        assertEq(usdt.balanceOf(poolW) - w0, 15e18, "1.5% buy fee to the pool wallet");
        assertEq(_book(0).left, 50_000e18 + 15e18, "fee booked as insurance");
        // ~985 USDT of POP at 0.01 (minus 0.05% pool fee and a little price impact)
        assertApproxEqRel(l.bought, 98_500e18, 0.002e18);
        assertEq(l.left, l.bought);
        assertLe(l.baseLeft, 985e18, "base never above what really bought the POP");
        assertApproxEqRel(l.baseLeft, 985e18, 0.002e18);
        assertEq(l.rule.profitFeeBps, 1500);
        assertEq(l.rule.compRatioBps, 10_000);
        assertEq(l.rule.waitDays, 15);
        assertEq(ins.totalPop(), l.bought);
        assertEq(pop.balanceOf(address(ins)), ins.totalPop(), "custody = POP held for users");
        assertEq(ins.participants(), 1);
        assertEq(ins.holdCost(u), 1000e18);
    }

    function test_buy_limits() public {
        usdt.mint(u, 100_000e18);
        uint256 r = ins.rev();
        vm.startPrank(u);
        usdt.approve(address(ins), type(uint256).max);
        vm.expectRevert(PopInsurance.BadAmount.selector);
        ins.buy(199e18, 1, block.timestamp + 60, r);
        vm.expectRevert(PopInsurance.BadAmount.selector);
        ins.buy(2001e18, 1, block.timestamp + 60, r);
        ins.buy(2000e18, 1, block.timestamp + 60, r);
        ins.buy(2000e18, 1, block.timestamp + 60, r);
        vm.expectRevert(PopInsurance.WalletLimit.selector); // 4000 per wallet per day
        ins.buy(200e18, 1, block.timestamp + 60, r);
        vm.expectRevert(PopInsurance.RulesChanged.selector);
        ins.buy(200e18, 1, block.timestamp + 60, r + 1);
        vm.expectRevert(PopInsurance.Expired.selector);
        ins.buy(200e18, 1, block.timestamp - 1, r);
        vm.stopPrank();
        (uint256 mine, uint256 net) = ins.quotaLeft(u);
        assertEq(mine, 0);
        assertEq(net, 46_000e18);
        // next Beijing day: quota is back
        _wait(1 days);
        (mine,) = ins.quotaLeft(u);
        assertEq(mine, 4000e18);
    }

    function test_global_daily_limit() public {
        vm.prank(admin);
        ins.setDailyLimits(3000e18, 4000e18);
        _buy(u, 2000e18);
        address v = makeAddr("v");
        usdt.mint(v, 2000e18);
        uint256 r = ins.rev();
        vm.startPrank(v);
        usdt.approve(address(ins), 2000e18);
        vm.expectRevert(PopInsurance.GlobalLimit.selector);
        ins.buy(1500e18, 1, block.timestamp + 60, r);
        ins.buy(1000e18, 1, block.timestamp + 60, r);
        vm.stopPrank();
    }

    function test_max_open_lots() public {
        vm.prank(admin);
        ins.setDailyLimits(1_000_000e18, 1_000_000e18);
        for (uint256 i; i < 64; i++) {
            _buy(u, 200e18);
        }
        usdt.mint(u, 200e18);
        uint256 r = ins.rev();
        vm.startPrank(u);
        usdt.approve(address(ins), 200e18);
        vm.expectRevert(PopInsurance.TooManyLots.selector);
        ins.buy(200e18, 1, block.timestamp + 60, r);
        vm.stopPrank();
        // sell one lot completely -> room for one more
        _sell(u, 3, _lot(u, 3).left);
        _buy(u, 200e18);
        assertEq(ins.openLots(u), 64);
    }

    function test_paused_blocks_buys_not_sells() public {
        uint256 id = _buy(u, 1000e18);
        vm.prank(admin);
        ins.setPaused(true);
        usdt.mint(u, 500e18);
        uint256 r = ins.rev();
        vm.startPrank(u);
        usdt.approve(address(ins), 500e18);
        vm.expectRevert(PopInsurance.Paused.selector);
        ins.buy(500e18, 1, block.timestamp + 60, r);
        vm.stopPrank();
        (uint256 toUser,) = _sell(u, id, _lot(u, id).left);
        assertGt(toUser, 900e18, "selling works while paused");
    }

    // ---------------------------------------------------------------- selling

    function test_sell_profit_fee_and_split() public {
        uint256 id = _buy(u, 1000e18);
        _movePrice(true, 200_000e18); // POP up ~45%
        uint256 w0 = usdt.balanceOf(poolW);
        PopInsurance.Book memory i0 = _book(0);
        uint256 b0 = usdt.balanceOf(u);
        (uint256 toUser, uint256 comp) = _sell(u, id, _lot(u, id).left);
        assertEq(comp, 0, "profit: no compensation");
        assertEq(usdt.balanceOf(u) - b0, toUser);
        // proceeds - fee = toUser; fee = 15% of (proceeds - 1000)
        uint256 proceeds = (toUser * 10_000 - 1000e18 * 1500) / 8500; // toUser = p - 0.15(p - 1000)
        uint256 fee = proceeds - toUser;
        assertGt(proceeds, 1300e18);
        assertApproxEqAbs(fee, ((proceeds - 1000e18) * 1500) / 10_000, 1e6);
        // no uplines: the whole fee goes to the pool wallet, split 5:3:7
        assertApproxEqAbs(usdt.balanceOf(poolW) - w0, fee, 1);
        assertApproxEqAbs(_book(0).left - i0.left, (fee * 5) / 15, 1);
        assertApproxEqAbs(_book(1).left, (fee * 3) / 15, 1);
        assertApproxEqAbs(_book(2).left, fee - (fee * 5) / 15 - (fee * 3) / 15, 2);
        assertEq(ins.totalPop(), 0);
        assertEq(pop.balanceOf(address(ins)), 0);
        assertEq(ins.openLots(u), 0);
        assertEq(ins.holdCost(u), 0);
    }

    function test_loss_before_wait_no_comp() public {
        uint256 id = _buy(u, 1000e18);
        _movePrice(false, 20_000_000e18); // POP down ~30%
        _wait(14 days);
        (uint256 toUser, uint256 comp) = _sell(u, id, _lot(u, id).left);
        assertEq(comp, 0, "14 days: not yet");
        assertLt(toUser, 800e18);
    }

    function test_loss_after_wait_full_comp() public {
        uint256 id = _buy(u, 1000e18);
        uint256 base = _lot(u, id).baseLeft;
        _movePrice(false, 20_000_000e18); // POP down ~30%
        _wait(15 days);
        uint256 w0 = usdt.balanceOf(poolW);
        uint256 b0 = usdt.balanceOf(u);
        (uint256 toUser, uint256 comp) = _sell(u, id, _lot(u, id).left);
        assertGt(comp, 250e18, "about the 30% loss");
        assertEq(usdt.balanceOf(u) - b0, toUser + comp);
        assertEq(w0 - usdt.balanceOf(poolW), comp, "paid by the pool wallet");
        // full compensation: the seller ends with ~what really bought the POP (985), never more
        assertLe(toUser + comp, base + 1);
        assertApproxEqRel(toUser + comp, base, 0.002e18);
        assertEq(_book(0).outflow, comp);
        assertEq(ins.totalComp(), comp);
    }

    function test_partial_sells_are_proportional() public {
        uint256 id = _buy(u, 2000e18);
        _movePrice(false, 20_000_000e18);
        _wait(16 days);
        PopInsurance.Lot memory l = _lot(u, id);
        (uint256 t1, uint256 c1) = _sell(u, id, l.left / 4);
        PopInsurance.Lot memory l2 = _lot(u, id);
        assertEq(l2.left, l.left - l.left / 4);
        assertApproxEqAbs(l2.paidLeft, 1500e18, 1e3);
        (uint256 t2, uint256 c2) = _sell(u, id, l2.left);
        assertEq(_lot(u, id).left, 0);
        assertEq(_lot(u, id).paidLeft, 0);
        assertEq(_lot(u, id).baseLeft, 0);
        // the two parts together are compensated like one sale (within price impact)
        assertApproxEqRel(t1 + c1 + t2 + c2, l.baseLeft, 0.003e18);
        assertApproxEqRel(c2, 3 * c1, 0.02e18);
    }

    function test_comp_cap_and_ratio() public {
        vm.prank(admin);
        ins.setRules(200e18, 2000e18, 150, 1500, 5000, 1000, 15, 200e18); // 50%, cap 10% of principal
        uint256 id = _buy(u, 1000e18);
        _movePrice(false, 40_000_000e18); // ~50% down
        _wait(15 days);
        (, uint256 comp) = _sell(u, id, _lot(u, id).left);
        assertEq(comp, 100e18, "cap: 10% of 1000");
    }

    function test_comp_limited_by_book_allowance_balance() public {
        uint256 id = _buy(u, 1000e18);
        _movePrice(false, 20_000_000e18);
        _wait(15 days);
        vm.prank(poolW);
        usdt.approve(address(ins), 50e18); // allowance 50
        (uint256 toUser, uint256 comp) = _sell(u, id, _lot(u, id).left);
        assertEq(comp, 50e18);
        assertGt(toUser, 600e18);

        // empty book -> no compensation, the sale still goes through
        uint256 id2 = _buy(u, 1000e18);
        vm.prank(admin);
        ins.adjustBook(0, 0);
        vm.prank(poolW);
        usdt.approve(address(ins), 50_000e18);
        _movePrice(false, 20_000_000e18);
        _wait(15 days);
        (uint256 t2, uint256 c2) = _sell(u, id2, _lot(u, id2).left);
        assertEq(c2, 0);
        assertGt(t2, 400e18);
    }

    function test_rules_locked_per_lot() public {
        uint256 a = _buy(u, 1000e18);
        vm.prank(admin);
        ins.setRules(200e18, 2000e18, 300, 2000, 5000, 10_000, 30, 200e18);
        uint256 b = _buy(u, 1000e18);
        assertEq(_lot(u, a).rule.compRatioBps, 10_000);
        assertEq(_lot(u, a).rule.profitFeeBps, 1500);
        assertEq(_lot(u, a).rule.waitDays, 15);
        assertEq(_lot(u, b).rule.compRatioBps, 5000);
        assertEq(_lot(u, b).rule.profitFeeBps, 2000);
        assertEq(_lot(u, b).rule.waitDays, 30);
        assertEq(_lot(u, b).paid, 1000e18);
        _movePrice(false, 20_000_000e18);
        _wait(16 days);
        (uint256 ta, uint256 ca) = _sell(u, a, _lot(u, a).left); // old lot: 15 days, 100%
        (, uint256 cb) = _sell(u, b, _lot(u, b).left); // new lot: 30 days -> nothing yet
        assertApproxEqRel(ta + ca, _lot(u, a).paid * 985 / 1000, 0.005e18);
        assertEq(cb, 0);
    }

    // ---------------------------------------------------------------- abuse

    /// dump the price right before selling (one block): the 15-minute average does not move, so no extra compensation
    function test_flash_dump_before_sell_gets_no_comp() public {
        uint256 id = _buy(u, 1000e18);
        _wait(15 days);
        _swap(address(pop), pool, 40_000_000e18); // same block, ~50% down
        (uint256 toUser, uint256 comp) = _sell(u, id, _lot(u, id).left);
        assertLt(toUser, 600e18, "sold at the dumped price");
        assertLt(comp, 2e18, "loss measured at the average price: ~0");
    }

    /// pump the price right before buying: refused (spot too far from the average)
    function test_pump_before_buy_refused() public {
        _swap(address(usdt), pool, 100_000e18); // ~+20% in one block
        usdt.mint(u, 1000e18);
        uint256 r = ins.rev();
        vm.startPrank(u);
        usdt.approve(address(ins), 1000e18);
        vm.expectRevert(PopInsurance.PriceUnstable.selector);
        ins.buy(1000e18, 1, block.timestamp + 60, r);
        vm.stopPrank();
    }

    /// a smaller pump (inside the protection): the lot's base is capped at the average-price value of the POP
    function test_small_pump_base_capped_at_average_value() public {
        _swap(address(usdt), pool, 12_000e18); // ~+2.4%, under the 3% protection
        uint256 id = _buy(u, 1000e18);
        PopInsurance.Lot memory l = _lot(u, id);
        assertLt(l.baseLeft, 970e18, "base = average-price value, below the 985 paid in");
    }

    /// splitting into small lots gives no advantage: same compensation per USDT
    function test_small_lots_no_advantage() public {
        address big = makeAddr("big");
        address small = makeAddr("small");
        uint256 idBig = _buy(big, 1000e18);
        uint256[5] memory ids;
        for (uint256 i; i < 5; i++) {
            ids[i] = _buy(small, 200e18);
        }
        _movePrice(false, 30_000_000e18);
        _wait(15 days);
        (uint256 tb, uint256 cb) = _sell(big, idBig, _lot(big, idBig).left);
        uint256 ts;
        for (uint256 i; i < 5; i++) {
            (uint256 t, uint256 c) = _sell(small, ids[i], _lot(small, ids[i]).left);
            ts += t + c;
        }
        assertApproxEqRel(ts, tb + cb, 0.01e18);
    }

    function test_pool_wallet_selling_gets_no_comp() public {
        usdt.mint(poolW, 1000e18);
        uint256 r = ins.rev();
        vm.startPrank(poolW);
        usdt.approve(address(ins), 50_000e18 + 1000e18);
        uint256 id = ins.buy(1000e18, 1, block.timestamp + 60, r);
        vm.stopPrank();
        _movePrice(false, 20_000_000e18);
        _wait(15 days);
        (, uint256 comp) = _sell(poolW, id, _lot(poolW, id).left);
        assertEq(comp, 0);
    }

    // ---------------------------------------------------------------- referral (7 levels)

    /// chain: a1 <- seller, a2 <- a1, ...; uplines need joined miner wallets
    function test_referral_levels() public {
        address a2 = makeAddr("a2");
        address a1 = makeAddr("a1");
        address x = makeAddr("x");
        address seller = makeAddr("seller");
        _depositUsdt(a2, 20e18, address(0)); // a2 joined the miner (any amount): can be a referrer
        _depositUsdt(a1, 20e18, a2);
        vm.prank(seller);
        miner.bind(a1);
        vm.prank(x);
        miner.bind(a2);

        _buy(seller, 1000e18); // seller: effective direct of a1
        assertEq(ins.effDirects(a1), 1);
        assertEq(ins.effDirects(a2), 0);
        _buy(a1, 300e18); // a1: effective direct of a2
        assertEq(ins.effDirects(a2), 1);

        _movePrice(true, 200_000e18);
        uint256 id = 0;
        uint256 b1 = usdt.balanceOf(a1);
        uint256 b2 = usdt.balanceOf(a2);
        _sell(seller, id, _lot(seller, id).left);
        uint256 got1 = usdt.balanceOf(a1) - b1;
        assertGt(got1, 0, "level 1 paid: a1 has 1 effective direct");
        assertEq(usdt.balanceOf(a2), b2, "level 2 not paid: a2 has only 1 effective direct");
        assertEq(ins.refEarned(a1), got1);
        // seller sold out -> no longer an effective direct of a1
        assertEq(ins.effDirects(a1), 0);

        // a2 gets a second effective direct -> level 2 opens
        _buy(x, 200e18);
        assertEq(ins.effDirects(a2), 2);
        _buy(seller, 1000e18);
        _movePrice(true, 200_000e18);
        b1 = usdt.balanceOf(a1);
        b2 = usdt.balanceOf(a2);
        PopInsurance.Book memory d0 = _book(2);
        _sell(seller, 1, _lot(seller, 1).left);
        uint256 l1 = usdt.balanceOf(a1) - b1;
        uint256 l2 = usdt.balanceOf(a2) - b2;
        assertGt(l2, 0, "level 2 paid");
        assertEq(l1, l2, "every level gets the same share (1/7 of the referral part)");
        // 5 levels unpaid -> kept in the referral book
        assertApproxEqAbs(_book(2).left - d0.left, l1 * 5, 10);
    }

    function test_threshold_change_and_refresh() public {
        address a1 = makeAddr("a1");
        _depositUsdt(a1, 20e18, address(0));
        vm.prank(u);
        miner.bind(a1);
        _buy(u, 300e18);
        assertEq(ins.effDirects(a1), 1);
        vm.prank(admin);
        ins.setRules(200e18, 2000e18, 150, 1500, 10_000, 10_000, 15, 500e18); // threshold 500
        assertEq(ins.effDirects(a1), 1, "not recounted until the wallet acts or is refreshed");
        address[] memory list = new address[](1);
        list[0] = u;
        ins.refresh(list);
        assertEq(ins.effDirects(a1), 0);
        (,, uint256 levels,, bool eff,) = ins.userInfo(u);
        assertFalse(eff);
        assertEq(levels, 0);
    }

    // ---------------------------------------------------------------- books

    function test_books_move_adjust_deposit() public {
        _buy(u, 1000e18);
        vm.startPrank(admin);
        ins.moveBook(0, 1, 1000e18);
        assertEq(_book(0).left, 50_015e18 - 1000e18);
        assertEq(_book(1).left, 1000e18);
        vm.expectRevert(PopInsurance.BadAmount.selector);
        ins.moveBook(2, 0, 1);
        ins.adjustBook(2, 77e18);
        vm.stopPrank();
        assertEq(_book(2).left, 77e18);
        // anyone can put real USDT into the insurance book (it lands in the pool wallet)
        address donor = makeAddr("donor");
        usdt.mint(donor, 500e18);
        uint256 w0 = usdt.balanceOf(poolW);
        vm.startPrank(donor);
        usdt.approve(address(ins), 500e18);
        ins.deposit(0, 500e18);
        vm.stopPrank();
        assertEq(usdt.balanceOf(poolW) - w0, 500e18);
        assertEq(_book(0).left, 49_515e18);
    }

    // ---------------------------------------------------------------- admin

    function test_owner_is_written_in_not_the_deployer() public {
        assertEq(ins.owner(), admin);
        assertEq(ins.poolWallet(), poolW);
        vm.prank(makeAddr("anyDeployer"));
        vm.expectRevert(PopInsurance.NotOwner.selector);
        ins.setPaused(true);
        vm.expectRevert(PopInsurance.BadConfig.selector);
        new PopInsurance(PopInsurance.Config({usdt: address(usdt), pop: address(pop), pool: pool, miner: address(miner), poolWallet: poolW, owner: address(0)}));
    }

    function test_admin_permissions_and_bounds() public {
        vm.expectRevert(PopInsurance.NotOwner.selector);
        ins.setRules(200e18, 2000e18, 150, 1500, 10_000, 10_000, 15, 200e18);
        vm.expectRevert(PopInsurance.NotAdmin.selector);
        ins.setDailyLimits(1, 1);

        vm.startPrank(admin);
        ins.setSub(sub1, true);
        ins.setSub(makeAddr("s2"), true);
        ins.setSub(makeAddr("s3"), true);
        vm.expectRevert(PopInsurance.BadConfig.selector);
        ins.setSub(makeAddr("s4"), true); // at most 3
        vm.expectRevert(PopInsurance.BadConfig.selector);
        ins.setRules(200e18, 2000e18, 1001, 1500, 10_000, 10_000, 15, 200e18); // buy fee > 10%
        vm.expectRevert(PopInsurance.BadConfig.selector);
        ins.setRules(200e18, 2000e18, 150, 5001, 10_000, 10_000, 15, 200e18); // profit fee > 50%
        vm.expectRevert(PopInsurance.BadConfig.selector);
        ins.setRules(200e18, 2000e18, 150, 1500, 10_001, 10_000, 15, 200e18); // ratio > 100%
        vm.stopPrank();
        assertEq(ins.subs().length, 3);

        // a sub-admin: daily limits only
        uint256 r0 = ins.rev();
        vm.startPrank(sub1);
        ins.setDailyLimits(80_000e18, 5000e18);
        vm.expectRevert(PopInsurance.NotOwner.selector);
        ins.setRules(200e18, 2000e18, 150, 1500, 10_000, 10_000, 15, 200e18);
        vm.expectRevert(PopInsurance.NotOwner.selector);
        ins.setPaused(true);
        vm.expectRevert(PopInsurance.NotOwner.selector);
        ins.setPoolWallet(sub1);
        vm.expectRevert(PopInsurance.NotOwner.selector);
        ins.moveBook(0, 1, 1);
        vm.stopPrank();
        assertEq(ins.rev(), r0 + 1, "limit change bumps rev");
        assertEq(ins.getParams().globalDaily, 80_000e18);

        vm.prank(admin);
        ins.setSub(sub1, false);
        vm.prank(sub1);
        vm.expectRevert(PopInsurance.NotAdmin.selector);
        ins.setDailyLimits(1, 1);
        assertEq(ins.subs().length, 2);
    }

    function test_split_change_and_pool_wallet_change() public {
        vm.startPrank(admin);
        ins.setSplit(1, 1, 0);
        address w2 = makeAddr("w2");
        ins.setPoolWallet(w2);
        vm.stopPrank();
        uint256 id = _buy(u, 1000e18);
        assertEq(usdt.balanceOf(w2), 15e18, "buy fee to the new pool wallet");
        _movePrice(true, 200_000e18);
        _sell(u, id, _lot(u, id).left);
        assertEq(_book(2).inflow, 0, "no referral part");
        assertApproxEqAbs(_book(1).left, _book(1).inflow, 0);
    }

    /// nothing touches the miner: its user records stay as they were
    function test_miner_untouched() public {
        address a1 = makeAddr("a1");
        _depositUsdt(a1, 20e18, address(0));
        vm.prank(u);
        miner.bind(a1);
        address r0 = miner.getUser(u).referrer;
        bool j0 = miner.getUser(u).joined;
        uint256 id = _buy(u, 1000e18);
        _movePrice(true, 100_000e18);
        _sell(u, id, _lot(u, id).left);
        address r1 = miner.getUser(u).referrer;
        bool j1 = miner.getUser(u).joined;
        assertEq(r0, r1);
        assertEq(j0, j1);
        assertFalse(j1, "buying in the insurance pool is not a mining deposit");
    }

    function test_cannot_sell_others_lot_or_too_much() public {
        uint256 id = _buy(u, 1000e18);
        address v = makeAddr("v");
        vm.prank(v);
        vm.expectRevert(PopInsurance.BadLot.selector);
        ins.sell(id, 1, 0, block.timestamp + 60);
        uint256 left = _lot(u, id).left;
        vm.prank(u);
        vm.expectRevert(PopInsurance.BadAmount.selector);
        ins.sell(id, left + 1, 0, block.timestamp + 60);
    }

    function test_swap_callback_only_from_pool() public {
        vm.expectRevert(bytes("cb"));
        ins.pancakeV3SwapCallback(1, 1, "");
        vm.prank(pool);
        vm.expectRevert(bytes("cb"));
        ins.uniswapV3SwapCallback(1, 1, ""); // not inside a swap
    }

    /// numbers for the report (forge test -vv --match-test test_report)
    function test_report() public {
        uint256 id = _buy(u, 1000e18);
        emit log_named_decimal_uint("buy 1000 U -> POP", _lot(u, id).bought, 18);
        _movePrice(false, 20_000_000e18);
        _wait(15 days);
        (uint256 t, uint256 c) = _sell(u, id, _lot(u, id).left);
        emit log_named_decimal_uint("after 15 days, price down: sale proceeds", t, 18);
        emit log_named_decimal_uint("compensation", c, 18);
        emit log_named_decimal_uint("total back", t + c, 18);
        uint256 id2 = _buy(u, 1000e18);
        _movePrice(true, 300_000e18);
        (uint256 t2,) = _sell(u, id2, _lot(u, id2).left);
        emit log_named_decimal_uint("price up: back after 15% profit fee", t2, 18);
    }
}
