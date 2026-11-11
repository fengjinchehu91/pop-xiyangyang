// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PopInsurance} from "../src/PopInsurance.sol";
import {MockERC20, Swapper} from "../test/utils/Mocks.sol";

/// Local POP 保险池 test chain, on top of LockScenario (pool + mining contract + referral chain U0 <- ... <- U4):
///   ins()  the insurance contract (deployed by anvil #0; 主管理员 written in = anvil #10); 资金池钱包 = anvil #11
///          (100,000 USDT, fixed allowance 50,000, insurance book set to 50,000)
contract InsScenario is Script {
    string constant MN = "test test test test test test test test test test test junk";

    function _out() internal view returns (string memory) {
        return vm.envOr("OUT", string("./ins-chain.json"));
    }

    function key(uint32 i) public pure returns (uint256) {
        return vm.deriveKey(MN, i);
    }

    function ins() external {
        string memory dj = vm.readFile(_out());
        address miner = vm.parseJsonAddress(dj, ".miner");
        address pool = vm.parseJsonAddress(dj, ".pool");
        MockERC20 usdt = MockERC20(vm.parseJsonAddress(dj, ".usdt"));
        address pop = vm.parseJsonAddress(dj, ".pop");
        uint256 kAdmin = key(10);
        uint256 kWallet = key(11);
        address wallet = vm.addr(kWallet);

        // anyone deploys (here anvil #0); the 主管理员 and the pool wallet are written in
        vm.startBroadcast(key(0));
        PopInsurance c = new PopInsurance(
            PopInsurance.Config({usdt: address(usdt), pop: pop, pool: pool, miner: miner, poolWallet: wallet, owner: vm.addr(kAdmin)})
        );
        vm.stopBroadcast();
        vm.startBroadcast(kAdmin);
        c.adjustBook(0, 50_000e18);
        vm.stopBroadcast();

        vm.startBroadcast(kWallet);
        usdt.mint(wallet, 100_000e18);
        usdt.approve(address(c), 50_000e18); // fixed amount
        vm.stopBroadcast();

        string memory j = "ins";
        vm.serializeAddress(j, "ins", address(c));
        vm.serializeAddress(j, "admin", vm.addr(kAdmin));
        vm.serializeAddress(j, "sub", vm.addr(key(12)));
        string memory out = vm.serializeAddress(j, "poolWallet", wallet);
        vm.writeJson(out, "./ins-deploy.json");
        console2.log("ins", address(c));
    }

    /// move the POP price with a big trade from a trader wallet (anvil #13): up = buy POP with `amount` USDT,
    /// down = sell `amount` POP
    function move(bool up, uint256 amount) external {
        string memory dj = vm.readFile(_out());
        address pool = vm.parseJsonAddress(dj, ".pool");
        MockERC20 usdt = MockERC20(vm.parseJsonAddress(dj, ".usdt"));
        MockERC20 pop = MockERC20(vm.parseJsonAddress(dj, ".pop"));
        uint256 k = key(13);
        vm.startBroadcast(k);
        Swapper sw = new Swapper();
        MockERC20 t = up ? usdt : pop;
        t.mint(vm.addr(k), amount);
        t.approve(address(sw), amount);
        sw.swapExactIn(pool, address(t), amount);
        vm.stopBroadcast();
    }
}
