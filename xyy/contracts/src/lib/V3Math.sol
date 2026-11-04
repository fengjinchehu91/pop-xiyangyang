// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Math} from "oz5/utils/math/Math.sol";
import {TickMath} from "v3-core/contracts/libraries/TickMath.sol";

/// @notice Liquidity/amount math and tick quoting for concentrated-liquidity pools.
/// Adapted from Uniswap v3-periphery LiquidityAmounts and OracleLibrary (GPL-2.0-or-later),
/// using OpenZeppelin Math.mulDiv instead of FullMath. Pancake V3 uses identical math.
library V3Math {
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    function amount0ForLiquidity(uint160 a, uint160 b, uint128 liquidity) internal pure returns (uint256) {
        if (a > b) (a, b) = (b, a);
        return Math.mulDiv(uint256(liquidity) << 96, b - a, b) / a;
    }

    function amount1ForLiquidity(uint160 a, uint160 b, uint128 liquidity) internal pure returns (uint256) {
        if (a > b) (a, b) = (b, a);
        return Math.mulDiv(liquidity, b - a, Q96);
    }

    function amountsForLiquidity(uint160 p, uint160 a, uint160 b, uint128 liquidity)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        if (a > b) (a, b) = (b, a);
        if (p <= a) {
            amount0 = amount0ForLiquidity(a, b, liquidity);
        } else if (p < b) {
            amount0 = amount0ForLiquidity(p, b, liquidity);
            amount1 = amount1ForLiquidity(a, p, liquidity);
        } else {
            amount1 = amount1ForLiquidity(a, b, liquidity);
        }
    }

    function _toUint128(uint256 x) private pure returns (uint128) {
        require(x <= type(uint128).max, "liq overflow");
        return uint128(x);
    }

    function liquidityForAmounts(uint160 p, uint160 a, uint160 b, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint128)
    {
        if (a > b) (a, b) = (b, a);
        if (p <= a) {
            return _toUint128(Math.mulDiv(amount0, Math.mulDiv(a, b, Q96), b - a));
        } else if (p < b) {
            uint256 l0 = Math.mulDiv(amount0, Math.mulDiv(p, b, Q96), b - p);
            uint256 l1 = Math.mulDiv(amount1, Q96, p - a);
            return _toUint128(l0 < l1 ? l0 : l1);
        } else {
            return _toUint128(Math.mulDiv(amount1, Q96, b - a));
        }
    }

    /// @notice Amount of quoteToken equal to baseAmount of baseToken at `tick` (token1/token0 = 1.0001^tick).
    function quoteAtTick(int24 tick, uint256 baseAmount, address baseToken, address quoteToken)
        internal
        pure
        returns (uint256)
    {
        uint160 s = TickMath.getSqrtRatioAtTick(tick);
        if (s <= type(uint128).max) {
            uint256 r = uint256(s) * s;
            return baseToken < quoteToken ? Math.mulDiv(r, baseAmount, 1 << 192) : Math.mulDiv(1 << 192, baseAmount, r);
        } else {
            uint256 r = Math.mulDiv(s, s, 1 << 64);
            return baseToken < quoteToken ? Math.mulDiv(r, baseAmount, 1 << 128) : Math.mulDiv(1 << 128, baseAmount, r);
        }
    }
}
