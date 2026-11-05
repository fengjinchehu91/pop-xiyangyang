// team statistics from Joined / Deposited / Withdrawn logs
import { teamOf, __test } from "../dist/worker.test.mjs";
const { applyLog, T_JOINED, T_DEPOSITED, T_WITHDRAWN } = __test;
let fails = 0;
const check = (n, c, x = "") => { if (!c) fails++; console.log(c ? "ok  " : "FAIL", n, x); };
const W = (v) => BigInt(v).toString(16).padStart(64, "0");
const A = (i) => "0x" + i.toString(16).padStart(40, "0");
const T = (a) => "0x" + a.slice(2).padStart(64, "0");
const E18 = 10n ** 18n;
const users = {};
const join = (u, r) => applyLog(users, { topics: [T_JOINED, T(u), T(r || A(0)), T(A(0))], data: "0x" + W(0) });
const dep = (u, liq, usdtIn, popIn, swapped, usdtRef, popRef) =>
  applyLog(users, { topics: [T_DEPOSITED, T(u), "0x" + W(1)], data: "0x" + [liq, usdtIn, popIn, swapped, 0n, usdtRef, popRef].map(W).join("") });
const wd = (u, liq) => applyLog(users, { topics: [T_WITHDRAWN, T(u)], data: "0x" + [liq, 0n, 0n, 0n, 0n].map(W).join("") });
// tree: root -> a, b ; a -> c ; c -> d (4 levels)
const [root, a, b, c, d] = [1, 2, 3, 4, 5].map(A);
join(root, null); dep(root, 1000n, 500n * E18, 0n, 250n * E18, 0n, 0n);
join(a, root); dep(a, 100n, 300n * E18, 0n, 150n * E18, 1n * E18, 0n); // USDT only: 299 net
join(b, root); dep(b, 200n, 100n * E18, 600000n * E18, 0n, 2n * E18, 1000n * E18); // USDT+POP: 98 USDT + 599000 POP, value 196
join(c, a); dep(c, 50n, 50n * E18, 0n, 25n * E18, 0n, 0n);
join(d, c); dep(d, 10n, 20n * E18, 0n, 10n * E18, 0n, 0n); wd(d, 4n);
const t = teamOf(users, root);
check("direct = 2", t.direct === 2, JSON.stringify(t));
check("indirect = 1 (second level only)", t.indirect === 1);
check("team = all 4 levels below, without self", t.team === 4);
const near = (x, y) => Math.abs(Number(BigInt(x) - y)) <= Number(y) * 1e-12;
check("USDT-only total (299 + 50 + 20)", near(t.usdtOnly, 369n * E18), t.usdtOnly);
check("USDT+POP: USDT part 98, POP part 599000, value 196", near(t.bothUsdt, 98n * E18) && near(t.bothPop, 599000n * E18) && near(t.bothValue, 196n * E18), JSON.stringify(t));
check("current liquidity after withdrawals (100+200+50+6)", t.liquidity === "356", t.liquidity);
const ta = teamOf(users, a.toUpperCase().replace("0X", "0x"));
check("sub-team of a: c and d", ta.team === 2 && ta.direct === 1 && ta.indirect === 1);
check("leaf has an empty team", teamOf(users, d).team === 0);
check("unknown wallet: empty", teamOf(users, A(99)).team === 0);
// old-format entries [liq, hasRef] keep working
const old = { [A(7)]: ["5", 0] };
applyLog(old, { topics: [T_JOINED, T(A(7)), T(root), T(A(0))], data: "0x" + W(0) });
check("old 2-field entries are upgraded", old[A(7)].length === 7 && old[A(7)][2] === root.toLowerCase());
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
