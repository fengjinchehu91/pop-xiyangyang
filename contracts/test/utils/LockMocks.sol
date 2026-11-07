// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";

/// Minimal PancakeSwap-V2-style pair that really swaps (x*y=k, 0.25% fee), for the lock contract tests.
/// Also keeps the running price sums like the real pair, so the mining contract can price 喜羊羊 from it.
contract MockSwapPair {
    address public token0;
    address public token1;
    address public factory;
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        factory = msg.sender;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    /// tokens must already have been sent here
    function sync() public {
        uint32 ts = uint32(block.timestamp);
        unchecked {
            uint32 elapsed = ts - blockTimestampLast;
            if (elapsed > 0 && reserve0 != 0 && reserve1 != 0) {
                price0CumulativeLast += ((uint256(reserve1) << 112) / reserve0) * elapsed;
                price1CumulativeLast += ((uint256(reserve0) << 112) / reserve1) * elapsed;
            }
        }
        reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20(token1).balanceOf(address(this)));
        blockTimestampLast = uint32(block.timestamp);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out > 0 || amount1Out > 0, "out");
        require(amount0Out < reserve0 && amount1Out < reserve1, "liq");
        if (amount0Out > 0) IERC20(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).transfer(to, amount1Out);
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        uint256 in0 = b0 > reserve0 - amount0Out ? b0 - (reserve0 - amount0Out) : 0;
        uint256 in1 = b1 > reserve1 - amount1Out ? b1 - (reserve1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "in");
        uint256 a0 = b0 * 10_000 - in0 * 25;
        uint256 a1 = b1 * 10_000 - in1 * 25;
        require(a0 * a1 >= uint256(reserve0) * reserve1 * 1e8, "K");
        sync();
    }

    /// simulate other people's trades: move the price by setting balances (test helper)
    function skim(address to) external {
        IERC20(token0).transfer(to, IERC20(token0).balanceOf(address(this)) - reserve0);
        IERC20(token1).transfer(to, IERC20(token1).balanceOf(address(this)) - reserve1);
    }
}

/// factory for MockSwapPair (the mining contract checks that its reward pair comes from the configured factory)
contract MockSwapFactory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address a, address b) external returns (address p) {
        p = address(new MockSwapPair(a, b));
        getPair[a][b] = p;
        getPair[b][a] = p;
    }
}
