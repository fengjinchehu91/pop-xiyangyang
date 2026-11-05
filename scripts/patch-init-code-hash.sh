#!/usr/bin/env bash
# Local tests only: make Uniswap periphery's PoolAddress.POOL_INIT_CODE_HASH match the pool bytecode
# compiled in this repo (it differs from the mainnet constant when compiler settings differ).
set -euo pipefail
cd "$(dirname "$0")/../contracts"
forge build --skip test --skip script >/dev/null 2>&1 || true
forge build >/dev/null
BYTECODE=$(jq -r '.bytecode.object' out/UniswapV3Pool.sol/UniswapV3Pool.json)
HASH=$(cast keccak "$BYTECODE")
FILE=lib/v3-periphery/contracts/libraries/PoolAddress.sol
sed -i.bak -E "s/POOL_INIT_CODE_HASH = 0x[0-9a-fA-F]{64}/POOL_INIT_CODE_HASH = ${HASH}/" "$FILE"
echo "POOL_INIT_CODE_HASH -> $HASH"
forge build >/dev/null && echo "rebuilt"
