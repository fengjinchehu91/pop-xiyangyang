// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.8.15;
// Compiles the Uniswap V3 (0.8 branch) NonfungiblePositionManager for local tests.
// NOTE: run scripts/patch-init-code-hash.sh once so PoolAddress.POOL_INIT_CODE_HASH matches the locally compiled pool.
import "v3-periphery/contracts/NonfungiblePositionManager.sol";
