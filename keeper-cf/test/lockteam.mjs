// team / network lock totals from the lock contract's Locked events (website display only)
import * as E from "../../app/src/vendor/ethers.min.js";
import { lockTeamOf, __test } from "../dist/worker.test.mjs";
const { applyLog, applyLockLog, freshLock, T_JOINED, T_LOCKED } = __test;
let fails = 0;
const check = (n, c, x = "") => { if (!c) fails++; console.log(c ? "ok  " : "FAIL", n, x); };
const W = (v) => BigInt(v).toString(16).padStart(64, "0");
const A = (i) => "0x" + i.toString(16).padStart(40, "0");
const T = (a) => "0x" + a.slice(2).padStart(64, "0");
const E18 = 10n ** 18n;
// the topic matches the contract's event
const iface = new E.Interface(["event Locked(address indexed user, uint256 indexed id, address indexed referrer, uint8 coin, uint16 days_, uint256 amount, uint256 reward, uint256 start)"]);
check("Locked topic = contract event", iface.getEvent("Locked").topicHash === T_LOCKED);
const users = {};
const join = (u, r) => applyLog(users, { topics: [T_JOINED, T(u), T(r || A(0)), T(A(0))], data: "0x" + W(0) });
const lk = freshLock({ lock: A(999), lockDeployBlock: 100, logChunk: 1000 });
const lockEv = (u, r, coin, days, amount, start) => {
  const ev = iface.encodeEventLog("Locked", [u, 0, r || A(0), coin, days, amount, amount / 20n, start]);
  applyLockLog(lk, { topics: ev.topics, data: ev.data });
};
// tree from mining: root -> a -> c ; root -> b.  d is bound to c but never deposited (only its lock tells us)
const [root, a, b, c, d, x] = [1, 2, 3, 4, 5, 6].map(A);
join(root, null); join(a, root); join(b, root); join(c, a);
const t0 = 1_000_000;
lockEv(root, null, 0, 100, 1000n * E18, t0); // self: not in own team
lockEv(a, root, 0, 100, 10_000n * E18, t0); // 喜羊羊 100 days
lockEv(b, root, 1, 200, 4_000n * E18, t0); // POP 200 days
lockEv(c, a, 1, 100, 2_000n * E18, t0);
lockEv(d, c, 0, 200, 8_000n * E18, t0); // 4th level, bound only
lockEv(x, null, 0, 100, 500n * E18, t0); // outside the tree
check("freshLock starts before the deploy block", lk.scanned === 99);
let r = lockTeamOf(users, lk, root, t0 + 10);
check("root team: 喜羊羊 a + d = 18,000", r.team[0] === String(18_000n * E18), JSON.stringify(r));
check("root team: POP b + c = 6,000", r.team[1] === String(6_000n * E18));
check("network: everyone, incl. self and outsiders (喜羊羊 19,500 / POP 6,000)", r.network[0] === String(19_500n * E18) && r.network[1] === String(6_000n * E18));
r = lockTeamOf(users, lk, a, t0 + 10);
check("sub-team of a: c (POP 2,000) + d (喜羊羊 8,000), all levels", r.team[0] === String(8_000n * E18) && r.team[1] === String(2_000n * E18), JSON.stringify(r));
check("bound-only locker counted through its lock's referrer", lockTeamOf(users, lk, c, t0).team[0] === String(8_000n * E18));
// release: after 10 days, 100-day locks lost 10%, 200-day locks 5%; released part is not "still locked"
r = lockTeamOf(users, lk, root, t0 + 10 * 86400 + 5);
check("after 10 days: 喜羊羊 a 9,000 + d 7,600", r.team[0] === String(16_600n * E18), r.team[0]);
check("after 10 days: POP b 3,800 + c 1,800", r.team[1] === String(5_600n * E18), r.team[1]);
check("just before 24 h nothing is released", lockTeamOf(users, lk, root, t0 + 86399).team[0] === String(18_000n * E18));
r = lockTeamOf(users, lk, root, t0 + 250 * 86400);
check("after 250 days everything released", r.team[0] === "0" && r.team[1] === "0" && r.network[0] === "0");
check("unknown wallet: empty team", lockTeamOf(users, lk, A(77), t0).team.every((v) => v === "0"));
check("upper-case address works", lockTeamOf(users, lk, a.toUpperCase().replace("0X", "0x"), t0 + 10).team[1] === String(2_000n * E18));
// a later lock is seen (memo is per state object; a new lock list rebuilds the tree when users change)
lockEv(b, root, 1, 100, 1_000n * E18, t0);
check("second lock of b counted", lockTeamOf(users, lk, root, t0 + 10).team[1] === String(7_000n * E18));
// wrong topic / bad coin ignored
applyLockLog(lk, { topics: [T_JOINED, T(a), T(root), T(A(0))], data: "0x" + W(0) });
check("other events ignored", lk.locks[a.toLowerCase()].length === 1);
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
