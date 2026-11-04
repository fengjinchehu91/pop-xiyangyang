#!/usr/bin/env bash
# Fetch contract dependencies into contracts/lib (pinned versions).
set -euo pipefail
cd "$(dirname "$0")/../contracts"
mkdir -p lib
clone() { [ -d "lib/$2" ] || git clone -q --depth 1 -b "$3" "https://github.com/$1" "lib/$2"; echo "lib/$2 @ $3"; }
clone foundry-rs/forge-std forge-std v1.9.4
clone OpenZeppelin/openzeppelin-contracts openzeppelin-contracts v5.1.0
clone OpenZeppelin/openzeppelin-contracts openzeppelin-contracts-v4 v4.7.0
clone Uniswap/v3-core v3-core 0.8
clone Uniswap/v3-periphery v3-periphery 0.8
