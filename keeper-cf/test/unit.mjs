// Cross-check the hand-written tx encoding / signing / ABI against ethers v6.
import * as E from "../../app/src/vendor/ethers.min.js";
import { signLegacyTx, addressOf, encodeSettleMany, __test } from "../dist/worker.test.mjs";

let fails = 0;
const eq = (name, a, b) => { if (a !== b) { fails++; console.log("FAIL", name, "\n  got ", a, "\n  want", b); } else console.log("ok  ", name); };

const iface = new E.Interface([
  "function checkpoint() returns (bool)", "function settleMany(address[])",
  "event Joined(address indexed user, address indexed referrer, address indexed referrer2, uint256 time)",
  "event Deposited(address indexed user, uint256 indexed tokenId, uint128 liquidity, uint256 usdtIn, uint256 popIn, uint256 usdtSwapped, uint256 popFromSwap, uint256 usdtRefund, uint256 popRefund)",
  "event Withdrawn(address indexed user, uint128 liquidity, uint256 popPrincipal, uint256 usdtPrincipal, uint256 popFees, uint256 usdtFees)",
]);
const addrs = Array.from({ length: 7 }, (_, i) => E.Wallet.createRandom().address);
eq("settleMany calldata", encodeSettleMany(addrs), iface.encodeFunctionData("settleMany", [addrs]));
eq("settleMany empty", encodeSettleMany([]), iface.encodeFunctionData("settleMany", [[]]));

for (let i = 0; i < 300; i++) {
  const w = E.Wallet.createRandom();
  const key = E.getBytes(w.privateKey);
  if (addressOf(key) !== w.address.toLowerCase()) { fails++; console.log("FAIL address", w.address); break; }
  const tx = {
    nonce: i % 3 === 0 ? 0 : Math.floor(Math.random() * 100000),
    gasPrice: i % 5 === 0 ? 50_000_000n : BigInt(Math.floor(Math.random() * 1e12)),
    gasLimit: BigInt(21000 + Math.floor(Math.random() * 5e6)),
    to: addrs[i % addrs.length],
    value: 0n,
    data: i % 4 === 0 ? "0x" : i % 4 === 1 ? iface.encodeFunctionData("checkpoint") : encodeSettleMany(addrs.slice(0, 1 + (i % 7))),
    chainId: i % 2 ? 56 : 31337,
  };
  const mine = signLegacyTx(tx, key);
  const ref = await w.signTransaction({ type: 0, ...tx });
  if (mine.raw !== ref) { fails++; console.log("FAIL tx", i, mine.raw, ref); break; }
  const parsed = E.Transaction.from(mine.raw);
  if (parsed.from !== w.address || parsed.hash !== mine.hash) { fails++; console.log("FAIL parse", i); break; }
}
console.log(fails ? `${fails} FAILURES` : "ok   300 random signed transactions byte-identical to ethers, sender + hash recovered");

// topics used by the worker
eq("topic Joined", __test.T_JOINED, iface.getEvent("Joined").topicHash);
eq("topic Deposited", __test.T_DEPOSITED, iface.getEvent("Deposited").topicHash);
eq("topic Withdrawn", __test.T_WITHDRAWN, iface.getEvent("Withdrawn").topicHash);
const sel = (sig) => E.id(sig).slice(2, 10);
for (const [k, sig] of [["checkpoint", "checkpoint()"], ["settleMany", "settleMany(address[])"], ["accruing", "accruing()"], ["pauseReasons", "pauseReasons()"], ["lastCheckpointTime", "lastCheckpointTime()"], ["operator", "OPERATOR()"], ["owner", "owner()"]])
  eq("selector " + sig, __test.SEL[k], sel(sig));
process.exit(fails ? 1 : 0);
