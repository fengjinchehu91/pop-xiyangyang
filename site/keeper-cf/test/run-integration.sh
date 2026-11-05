#!/bin/bash
# fresh anvil + fresh contracts, then the worker scenario
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
pkill -f "anvil --port 854[5]" || true; sleep 1
(anvil --port 8545 --silent > /tmp/anvil-keeper.log 2>&1 &)
sleep 2
cd "$DIR/../contracts"
forge script script/KeeperScenario.s.sol --rpc-url http://127.0.0.1:8545 --broadcast > /tmp/forge-deploy.log 2>&1
cd "$DIR"
node build.mjs > /dev/null
node test/integration.mjs && node test/smoke-cf.mjs
