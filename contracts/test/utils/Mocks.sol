// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "oz5/token/ERC20/ERC20.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// 1% burned on every transfer (simulates a transfer-tax token)
contract TaxToken is MockERC20 {
    bool public taxOn;

    constructor() MockERC20("Tax", "TAX", 18) {}

    function setTax(bool on) external {
        taxOn = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (taxOn && from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

interface IV3PoolLike {
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// Test helper: swaps exact input on a V3 pool, paying in the callback.
contract Swapper {
    uint160 internal constant MIN_SQRT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;

    function swapExactIn(address pool, address tokenIn, uint256 amountIn) external returns (uint256 out) {
        bool zeroForOne = tokenIn == IV3PoolLike(pool).token0();
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        (int256 a0, int256 a1) =
            IV3PoolLike(pool).swap(msg.sender, zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT : MAX_SQRT, abi.encode(pool));
        out = uint256(-(zeroForOne ? a1 : a0));
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "pool");
        if (a0 > 0) IERC20(IV3PoolLike(pool).token0()).transfer(pool, uint256(a0));
        if (a1 > 0) IERC20(IV3PoolLike(pool).token1()).transfer(pool, uint256(a1));
    }
}

/// PancakeSwap/Uniswap V2 pair price-accumulator replica (same _update math as UniswapV2Pair: UQ112x112 price
/// cumulatives, uint32 timestamps, overflow allowed). Reserves are set directly to simulate trades.
contract MockV2Pair {
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

    /// set reserves as of now (like a swap/sync): accumulate old price for elapsed time, then update
    function setReserves(uint112 r0, uint112 r1) external {
        uint32 ts = uint32(block.timestamp);
        unchecked {
            uint32 elapsed = ts - blockTimestampLast;
            if (elapsed > 0 && reserve0 != 0 && reserve1 != 0) {
                price0CumulativeLast += ((uint256(reserve1) << 112) / reserve0) * elapsed;
                price1CumulativeLast += ((uint256(reserve0) << 112) / reserve1) * elapsed;
            }
        }
        reserve0 = r0;
        reserve1 = r1;
        blockTimestampLast = ts;
    }

    /// set reserves given amounts of tokenA / tokenB (helper for tests)
    function setReservesFor(address tokenA, uint112 amtA, uint112 amtB) external {
        (uint112 r0, uint112 r1) = tokenA == token0 ? (amtA, amtB) : (amtB, amtA);
        this.setReserves(r0, r1);
    }
}

contract MockV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address a, address b) external returns (address p) {
        p = address(new MockV2Pair(a, b));
        getPair[a][b] = p;
        getPair[b][a] = p;
    }
}
