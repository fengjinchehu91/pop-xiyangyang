import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig } from "./config";
import { ChainBackend, humanError, LOCK_COIN_NAME, switchChain, walletAccounts, walletChainId } from "./chain";
import type { InsAdminAction } from "./chain";
import { DemoBackend } from "./demo";
import type { AddQuote, AdminEvent, AdminUserRow, Downline, ExitQuote, LockCoin, LockView, Rec, RecKind, Snapshot, Step, TeamStats, InsView, InsLot, InsSellQuote, InsRefRec } from "./types";
import { REASON_TEXT } from "./types";
import { applySlippage, E18, fmtTime, fmtUnits, parseUnitsSafe, short, usdToToken } from "./fmt";

type Backend = ChainBackend | DemoBackend;
type Page = "ins" | "mine" | "lock" | "refer" | "records" | "admin";
type SheetKind = null | "add" | "exit" | "claim" | "rules" | "old";

/** basis points -> "1%" / "0.5%" */
const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
const usd0 = (x: bigint) => fmtUnits(x, 18, 0);

const A = (p: string) => ((window as any).__XYY_ASSETS__?.[p] as string) || `./assets/${p}`;
const SLIP_BPS = 100; // 1%
const ZAP_SLIP_BPS = 500; // "只用 USDT" 添加时的滑点保护 5%（合约先把一半 USDT 换成 POP）
const addSlip = (mode: "usdt" | "both") => (mode === "usdt" ? ZAP_SLIP_BPS : SLIP_BPS);
const QUOTE_TTL = 60_000;
// 用户页面上显示的推荐 / 动态资格门槛固定写 100 USDT；后台改门槛（比如 80）只在管理员后台显示，资格状态仍按合约判断
const SHOW_THR = 100n * 10n ** 18n;

// =====================================================================================================
/** setInterval that only runs while the page is on screen; runs once right away when the user comes back */
function useVisibleInterval(fn: () => void, ms: number, deps: any[]) {
  useEffect(() => {
    let id: any = null;
    const start = () => {
      if (id === null) id = setInterval(fn, ms);
    };
    const stop = () => {
      if (id !== null) clearInterval(id);
      id = null;
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        fn();
        start();
      } else stop();
    };
    fn();
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export default function App({ cfg }: { cfg: AppConfig }) {
  const demo = cfg.mode === "demo";
  const backend = useMemo<Backend>(() => (demo ? new DemoBackend() : new ChainBackend(cfg)), [cfg, demo]);
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<string>(demo ? "0x8d3a1c9e2b47f05a8e6c1d2b3a4f5e6c7d8e70a2" : "");
  const [chainId, setChainId] = useState<number | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [page, setPage] = useState<Page>(() => (location.hash === "#admin" ? "admin" : (new URLSearchParams(location.search).get("page") as Page) || "ins"));
  const [recInit, setRecInit] = useState<RecKind | undefined>(undefined); // 记录 page opened on this tab (锁仓 → 查看明细)
  const [sheet, setSheet] = useState<SheetKind>(() => (new URLSearchParams(location.search).get("sheet") as SheetKind) || null);
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState("");
  // pop-up messages close by themselves: "已复制推荐链接" after 1 second, longer messages after 3 seconds (tap closes at once)
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), toast.startsWith("已复制") ? 1000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);
  const refParam = useMemo(() => {
    const r = new URLSearchParams(location.search).get("ref") || "";
    return /^0x[0-9a-fA-F]{40}$/.test(r) ? r : "";
  }, []);

  useEffect(() => {
    backend.init().then(() => setReady(true));
  }, [backend]);

  // wallet
  useEffect(() => {
    if (demo || !window.ethereum) return;
    walletAccounts(false).then((a) => setAccount(a[0] || ""));
    walletChainId().then(setChainId);
    const onAcc = (a: string[]) => setAccount(a[0] || "");
    // network switch: reload so reads/writes are rebuilt on the right chain
    const onChain = () => location.reload();
    window.ethereum.on?.("accountsChanged", onAcc);
    window.ethereum.on?.("chainChanged", onChain);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAcc);
      window.ethereum.removeListener?.("chainChanged", onChain);
    };
  }, [demo]);

  const busy = useRef<any>(null);
  const refresh = useCallback(async () => {
    const key = { backend, account };
    // same wallet's previous refresh still running: skip instead of piling up (a new wallet always refreshes)
    if (!ready || (busy.current && busy.current.backend === backend && busy.current.account === account)) return;
    busy.current = key;
    try {
      setSnap(await backend.snapshot(account || undefined));
      setLoadErr("");
    } catch (e: any) {
      setLoadErr("数据加载失败：" + humanError(e));
    } finally {
      if (busy.current === key) busy.current = null;
    }
  }, [backend, account, ready]);

  useVisibleInterval(refresh, demo ? 30_000 : 15_000, [refresh, demo]);

  // 3-second display update of estimates (not a transaction)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 3000);
    return () => clearInterval(id);
  }, []);

  const connect = async () => {
    if (demo) return;
    try {
      if (!window.ethereum) {
        setToast("未检测到钱包：请在 TokenPocket / MetaMask / Binance Web3 等钱包 App 内置浏览器中打开本页");
        return;
      }
      const a = await walletAccounts(true);
      setAccount(a[0] || "");
      setChainId(await walletChainId());
    } catch (e) {
      setToast(humanError(e));
    }
  };

  const wrongNet = !demo && !!account && chainId !== null && chainId !== cfg.chainId;
  const canTx = demo || (!!snap?.configured && !!account && !wrongNet);
  const isAdmin = !!snap && !!account && !!snap.owner && snap.owner.toLowerCase() === account.toLowerCase();
  // 保险池主管理员 / 副管理员（浏览图里先用 INS 演示数据；接合约后从合约读）
  // 保险池主管理员 / 副管理员 (read from the insurance contract)
  const [insRole, setInsRole] = useState<"owner" | "sub" | "wallet" | null>(null);
  useEffect(() => {
    let off = false;
    setInsRole(null);
    if (account && snap?.configured !== false) backend.insRole(account).then((r) => !off && setInsRole(r), () => {});
    return () => {
      off = true;
    };
  }, [backend, account, !!snap]); // eslint-disable-line react-hooks/exhaustive-deps
  const isInsAdmin = demo || insRole !== null;
  const showAdmin = isAdmin || isInsAdmin || demo; // 演示预览里总是显示「管理」按钮，方便查看后台
  const [admTab, setAdmTab] = useState<AdmTab>("mine");

  const live = useLive(snap, tick);

  // 首次进入：新钱包必须先绑定推荐人，才能进入网站。已绑定、已入过金的钱包和运营/管理钱包直接进入。
  const [bound, setBound] = useState(false);
  const [demoGate, setDemoGate] = useState(demo && new URLSearchParams(location.search).get("gate") !== "0");
  const me = account.toLowerCase();
  // staff never has to bind a referrer: mining owner / operator, and the insurance pool's admins and pool wallet
  const isStaff = !!me && ([snap?.owner, snap?.operator].some((x) => !!x && x.toLowerCase() === me) || insRole !== null);
  // 旧矿池里本来就没有推荐人的老钱包，沿用原来的情况，直接进入
  const oldTop = !!snap?.old && snap.old.joined && !snap.old.referrer;
  const gate = demo
    ? demoGate
    : !!snap?.configured && !bound && !isStaff && (!account || !snap.user || (!snap.user.referrer && !snap.user.joined && !oldTop));

  return (
    <div className="shell">
      <div className="app">
        <Header cfg={cfg} account={account} onConnect={connect} snap={snap} />
        {demo && <div className="demo-flag">演示模式 · 页面所有数字均为模拟数据，不代表真实资产，也不会发起任何交易</div>}
        {wrongNet && (
          <div className="alert warn">
            钱包网络不是 {cfg.chainName}。
            <button className="btn-mini" onClick={() => switchChain(cfg).catch((e) => setToast(humanError(e)))}>
              切换网络
            </button>
          </div>
        )}
        {snap && !snap.configured && <div className="alert">{snap.problem || "未配置"}</div>}
        {loadErr && (
          <div className="alert">
            {loadErr}
            <button className="btn-mini" onClick={refresh}>重试</button>
          </div>
        )}

        {gate && snap ? (
          <BindGate
            cfg={cfg}
            snap={snap}
            backend={backend}
            refParam={refParam}
            account={account}
            canTx={canTx}
            demo={demo}
            onConnect={connect}
            openOld={() => setSheet("old")}
            done={() => {
              setBound(true);
              setDemoGate(false);
              refresh();
            }}
          />
        ) : (
        <>
        <main className="content">
          {!snap && !loadErr && <Loading />}
          {snap && page === "mine" && (
            <MinePage cfg={cfg} snap={snap} live={live} account={account} canTx={canTx} onConnect={connect} open={setSheet} goRefer={() => setPage("refer")} />
          )}
          {snap && page === "ins" && <InsHome snap={snap} backend={backend} account={account} canTx={canTx} onConnect={connect} goRecords={() => { setRecInit("ins"); setPage("records"); }} />}
          {snap && page === "lock" && <LockPage cfg={cfg} snap={snap} account={account} backend={backend} canTx={canTx} onConnect={connect} goRecords={() => { setRecInit("lock"); setPage("records"); }} />}
          {snap && page === "refer" && <ReferPage cfg={cfg} snap={snap} live={live} account={account} backend={backend} onConnect={connect} toast={setToast} />}
          {snap && page === "records" && <RecordsPage cfg={cfg} account={account} backend={backend} onConnect={connect} initial={recInit} />}
          {snap && page === "admin" && showAdmin && <AdminPage key={admTab} cfg={cfg} snap={snap} backend={backend} demo={demo} isAdmin={isAdmin} isInsAdmin={isInsAdmin} initialTab={admTab} adminAccount={account} refresh={refresh} />}
        </main>

        <nav className="tabbar five-t">
          {(
            [
              ["ins", "保险池", IconShield],
              ["mine", "挖矿", IconPick],
              ["lock", "锁仓", IconLock],
              ["refer", "推荐", IconUsers],
              ["records", "记录", IconDoc],
            ] as const
          ).map(([k, label, Ic]) => (
            <button key={k} className={"tab" + (page === k ? " on" : "")} onClick={() => { setRecInit(undefined); setPage(k); }}>
              <Ic />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {showAdmin && page !== "admin" && (
          <button className="admin-fab" onClick={() => { setAdmTab(page === "ins" ? "ins" : page === "lock" ? "lock" : "mine"); setPage("admin"); }}>管理</button>
        )}
        </>
        )}

        {sheet === "add" && snap && (
          <AddSheet cfg={cfg} snap={snap} backend={backend} refParam={refParam} account={account} canTx={canTx} close={() => setSheet(null)} done={refresh} />
        )}
        {sheet === "exit" && snap?.user && (
          <ExitSheet snap={snap} backend={backend} account={account} canTx={canTx} close={() => setSheet(null)} done={refresh} />
        )}
        {sheet === "claim" && snap && <ClaimSheet snap={snap} live={live} backend={backend} canTx={canTx} close={() => setSheet(null)} done={refresh} />}
        {sheet === "rules" && <RulesSheet snap={snap} close={() => setSheet(null)} />}
        {sheet === "old" && snap?.old && <OldSheet snap={snap} backend={backend} canTx={canTx} close={() => setSheet(null)} done={refresh} />}
        {toast && (
          <div className="toast" onClick={() => setToast("")}>
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================================================================
/** 打开网站先绑定推荐人：推荐链接里的地址直接显示出来，确认后用钱包签一次，成功后进入网站 */
function BindGate({ cfg, snap, backend, refParam, account, canTx, demo, onConnect, openOld, done }: { cfg: AppConfig; snap: Snapshot; backend: Backend; refParam: string; account: string; canTx: boolean; demo: boolean; onConnect: () => void; openOld: () => void; done: () => void }) {
  void cfg;
  const [typed, setTyped] = useState("");
  // 老用户：自动沿用旧矿池里的推荐人
  const oldRef = snap.old?.referrer || "";
  const fromLink = oldRef || refParam || (demo ? "0x4f9e2b7c1d8a3e6f5b0c9d2e1a7b8c3d4e5f3c77" : "");
  const ref = fromLink || (typed.match(/0x[0-9a-fA-F]{40}/)?.[0] ?? "");
  const self = !!ref && !!account && ref.toLowerCase() === account.toLowerCase();
  const [joined, setJoined] = useState<boolean | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    setJoined(null);
    if (!ref || self) return;
    let off = false;
    backend.isJoined(ref).then((j) => !off && setJoined(j), () => !off && setJoined(null));
    return () => {
      off = true;
    };
  }, [ref, self, backend]);
  const ok = !!ref && !self && joined === true;
  const go = async () => {
    if (!ok) return;
    const s: Step[] = steps?.some((x) => x.status === "error") ? steps.map((x) => ({ ...x, status: "idle" as const, error: undefined })) : [{ label: "绑定推荐人（钱包确认一次）", status: "idle" }];
    setSteps(s);
    setRunning(true);
    try {
      if (await backend.bind(ref, s, setSteps)) setTimeout(done, 800);
    } catch (e) {
      setSteps((p) => (p ? p.map((x) => (x.status === "idle" || x.status === "wallet" ? { ...x, status: "error", error: humanError(e) } : x)) : p));
    } finally {
      setRunning(false);
    }
  };
  const loadingUser = !!account && !snap.user && !demo;
  return (
    <main className="content gate">
      <section className="card gate-card">
        <img src={A("sheep-thumb.webp")} alt="" className="gate-img" />
        <h2>绑定推荐人</h2>
        <p className="gate-sub">绑定后即可进入喜羊羊矿场</p>

        {fromLink ? (
          <div className="gate-ref">
            <span>{oldRef ? "推荐人（沿用旧矿池的推荐关系）" : "推荐人"}</span>
            <b className="mono">{fromLink}</b>
          </div>
        ) : (
          <label className="inp gate-inp">
            <span>推荐人钱包地址</span>
            <div className="inp-row">
              <input placeholder="粘贴推荐人地址或推荐链接" value={typed} onChange={(e) => setTyped(e.target.value.trim())} disabled={running} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            </div>
            {typed && !ref && <em className="err">没有识别到钱包地址，请检查</em>}
          </label>
        )}

        {ref && (self ? (
          <p className="gate-msg bad">不能绑定自己为推荐人，请使用别人的推荐链接打开。</p>
        ) : joined === false ? (
          oldRef ? (
            <p className="gate-msg bad">请等推荐人先在新矿池添加流动性后再绑定。</p>
          ) : (
            <p className="gate-msg bad">这个推荐人还没有添加过流动性，暂时不能绑定。请让推荐人先添加一次流动性，再用他的推荐链接打开。</p>
          )
        ) : joined === true ? (
          <p className="gate-msg ok-txt">✓ 推荐人有效，可以绑定</p>
        ) : (
          <p className="gate-msg">正在检查推荐人…</p>
        ))}

        {steps && <Steps steps={steps} />}

        {!account && !demo ? (
          <button className="btn-green wide" onClick={onConnect}>连接钱包</button>
        ) : loadingUser ? (
          <button className="btn-green wide" disabled>正在读取钱包信息…</button>
        ) : (
          <button className="btn-green wide" disabled={!ok || running || (!canTx && !demo)} onClick={go}>
            {running ? "处理中…" : steps?.some((x) => x.status === "error") ? "重试" : steps?.every((x) => x.status === "done") ? "绑定成功，正在进入…" : "确认绑定"}
          </button>
        )}
        <p className="fine gate-fine">绑定关系记录在链上，绑定后不能修改。绑定需要钱包确认一次，会花极少的 BNB 手续费。</p>
      </section>
      <OldPoolCard snap={snap} open={openOld} />
    </main>
  );
}

// ------------------------------------------------------------------ previous contract: withdraw only
/** 旧矿池里还有本金时才显示：撤回后到新矿池重新添加（旧合约已结束，只撤回、不领取） */
function OldPoolCard({ snap, open }: { snap: Snapshot; open: () => void }) {
  const o = snap.old;
  if (!o || o.liquidity === 0n) return null;
  return (
    <section className="card old-pool">
      <b>旧矿池还有您的流动性</b>
      <p className="fine">请撤回后到新矿池重新添加。</p>
      <div className="kv">
        <div><span>旧矿池流动性（参考价值）</span><b>{fmtUnits(o.valueUsd, 18)} USDT</b></div>
      </div>
      <button className="btn-gold wide" onClick={open}>从旧矿池撤回</button>
    </section>
  );
}

function OldSheet({ snap, backend, canTx, close, done }: { snap: Snapshot; backend: Backend; canTx: boolean; close: () => void; done: () => void }) {
  const [o] = useState(snap.old!); // the amounts shown when the sheet was opened
  const [amts, setAmts] = useState<[bigint, bigint] | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (o.liquidity > 0n) backend.oldAmounts(o.liquidity).then(setAmts, () => setAmts(null));
  }, [backend, o.liquidity]);
  const go = async () => {
    const s: Step[] = [{ label: "从旧矿池撤回全部流动性", status: "idle" }];
    setSteps(s);
    setRunning(true);
    try {
      await backend.withdrawOld(SLIP_BPS, s, setSteps);
    } catch (e) {
      setSteps([{ ...s[0], status: "error", error: humanError(e) }]);
    } finally {
      setRunning(false);
      done();
    }
  };
  const allDone = !!steps && steps.every((x) => x.status === "done" || x.status === "skipped");
  return (
    <Sheet title="从旧矿池撤回" close={close} icon={<span className="ic-c">⊖</span>}>
      <div className="quote">
        <b className="q-title">预计返还</b>
        <div className="qr-row">
          <span>
            <img src={A("pop-coin.webp")} alt="" className="tok" /> POP
          </span>
          <b>{amts ? fmtUnits(amts[0], snap.popDecimals) : "…"}</b>
        </div>
        <div className="qr-row">
          <span>
            <i className="usdt-ic">U</i> USDT
          </span>
          <b>{amts ? fmtUnits(amts[1], snap.usdtDecimals) : "…"}</b>
        </div>
        <p className="fine">另含这段时间的交易手续费，一起回到您的钱包。之后在新矿池重新添加即可。</p>
      </div>
      {steps && <Steps steps={steps} />}
      {allDone ? (
        <button className="btn-green wide" onClick={close}>完成</button>
      ) : (
        <button className="btn-gold wide" disabled={!canTx || running} onClick={go}>
          {running ? "处理中…" : steps?.some((x) => x.status === "error") ? "重试" : "确认撤回"}
        </button>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ 锁仓
const LOCK_SLIP_BPS = 500; // USDT 买入并锁仓：滑点保护 5%
/** the three ways to lock, shown one under the other */
const LOCK_WAYS = [
  { k: "buy", coin: 0 as LockCoin, mode: "usdt" as const, title: "USDT 买入并锁仓" },
  { k: "xyy", coin: 0 as LockCoin, mode: "wallet" as const, title: "喜羊羊代币锁仓" },
  { k: "pop", coin: 1 as LockCoin, mode: "wallet" as const, title: "POP 代币锁仓" },
];
const LOCK_PLANS = [
  { days: 100, release: "1%", bps: 500, label: "每天释放 1% · 奖励 5%" },
  { days: 200, release: "0.5%", bps: 1000, label: "每天释放 0.5% · 奖励 10%" },
] as const;

/** 锁仓 contract state for this wallet; refreshed every 15 s. [view, reload]; view null = 锁仓 not available */
function useLockView(backend: Backend, account: string): [LockView | null | undefined, () => void] {
  const [v, setV] = useState<LockView | null | undefined>(undefined);
  const [n, setN] = useState(0);
  const gen = useRef(0);
  useEffect(() => {
    const g = ++gen.current;
    return () => {
      if (gen.current === g) gen.current++;
    };
  }, [backend, account, n]);
  useVisibleInterval(() => {
    const g = gen.current;
    backend.lockView(account).then((x) => gen.current === g && setV(x), () => {});
  }, 15_000, [backend, account, n]);
  return [v, () => setN((x) => x + 1)];
}

function LockPage({ cfg, snap, account, backend, canTx, onConnect, goRecords }: { cfg: AppConfig; snap: Snapshot; account: string; backend: Backend; canTx: boolean; onConnect: () => void; goRecords: () => void }) {
  void cfg;
  const [v, reload] = useLockView(backend, account);
  const [coin, setCoin] = useState<LockCoin>(0);
  const [mode, setMode] = useState<"usdt" | "wallet">("usdt");
  const [days, setDays] = useState<100 | 200>(100);
  const [ratio, setRatio] = useState<10000 | 8000>(10000);
  const [amtStr, setAmtStr] = useState("");
  const [quote, setQuote] = useState<{ key: string; out: bigint } | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [claimSteps, setClaimSteps] = useState<Step[] | null>(null);
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const ud = snap.usdtDecimals;
  const dec = (c: LockCoin) => (c === 1 ? snap.popDecimals : snap.rewardDecimals);
  const name = (c: LockCoin) => LOCK_COIN_NAME[c];
  const buy = coin === 0 && mode === "usdt"; // POP: only from the wallet
  const amt = parseUnitsSafe(amtStr, buy ? ud : dec(coin));
  const key = `${coin}:${buy ? "usdt" : "wallet"}:${amt ?? ""}`;
  useEffect(() => {
    setQuote(null);
    if (!amt || amt <= 0n) return;
    if (!buy) {
      setQuote({ key, out: amt });
      return;
    }
    let off = false;
    const t = setTimeout(() => {
      backend.lockQuote(amt).then((out) => !off && setQuote({ key, out }), () => {});
    }, 400);
    return () => {
      off = true;
      clearTimeout(t);
    };
  }, [backend, key]);
  if (v === undefined) return <Loading />;
  if (v === null)
    return (
      <>
        <Hero title="锁仓" sub="锁仓喜羊羊或 POP，每天释放，锁仓即得奖励" img={A("sheep-safe.webp")} />
        <div className="card center"><p className="muted">锁仓即将开放，敬请期待</p></div>
      </>
    );
  const me = v.me;
  const plan = LOCK_PLANS.find((p) => p.days === days)!;
  const q = quote && quote.key === key ? quote : null;
  const lockedAmt = q ? (buy ? (q.out * BigInt(ratio)) / 10000n : q.out) : null;
  const reward = lockedAmt !== null ? (lockedAmt * BigInt(plan.bps)) / 10000n : null;
  const daily = lockedAmt !== null ? lockedAmt / BigInt(days) : null;
  const bal = me ? (buy ? me.usdt : coin === 1 ? me.pop : me.reward) : null;
  const balDec = buy ? ud : dec(coin);
  const over = amt !== null && bal !== null && amt > bal;
  const pick = (c: LockCoin, m: "usdt" | "wallet") => {
    setCoin(c);
    setMode(m);
    setAmtStr("");
    setSteps(null);
  };
  const go = async () => {
    if (!amt || amt <= 0n) return;
    const s: Step[] = buy
      ? [{ label: "授权 USDT（按本次金额）", status: "idle" }, { label: `买入并锁仓 ${days} 天`, status: "idle" }]
      : [{ label: `授权${name(coin)}（按本次数量）`, status: "idle" }, { label: `锁仓 ${days} 天`, status: "idle" }];
    const cur = steps?.some((x) => x.status === "error") ? steps.map((x) => (x.status === "error" ? { ...x, status: "idle" as const, error: undefined } : x)) : s;
    setSteps(cur);
    setRunning(true);
    try {
      const ok = buy ? await backend.lockBuy(amt, ratio, days, LOCK_SLIP_BPS, cur, setSteps) : await backend.lockWallet(coin, amt, days, cur, setSteps);
      if (ok) setAmtStr("");
    } catch (e) {
      // only the step that was about to run shows the reason
      setSteps((p) => {
        if (!p) return p;
        const i = p.findIndex((x) => x.status === "idle" || x.status === "wallet");
        return p.map((x, j) => (j === i ? { ...x, status: "error", error: humanError(e) } : x));
      });
    } finally {
      setRunning(false);
      reload();
    }
  };
  const claim = async () => {
    const s: Step[] = [{ label: "领取已释放的币", status: "idle" }];
    setClaimSteps(s);
    try {
      await backend.lockClaim(s, setClaimSteps);
    } catch (e) {
      setClaimSteps([{ ...s[0], status: "error", error: humanError(e) }]);
    } finally {
      reload();
    }
  };
  const done = !!steps && steps.every((x) => x.status === "done" || x.status === "skipped");
  const canClaim = !!me && (me.claimable[0] > 0n || me.claimable[1] > 0n);
  return (
    <>
      <Hero title="锁仓" sub="锁仓喜羊羊或 POP，每天释放，锁仓即得奖励" img={A("sheep-safe.webp")} />

      <section className="card lock-net">
        <b>全网锁仓</b>
        <div className="lock-two">
          <div><span>喜羊羊</span><b>{v.network ? fmtUnits(v.network[0], dec(0), 2) : "统计中…"}</b></div>
          <div><span>POP</span><b>{v.network ? fmtUnits(v.network[1], dec(1), 2) : "统计中…"}</b></div>
        </div>
      </section>

      {me && (
        <section className="card lock-rights">
          <div className="lr-head">
            <b>我的锁仓推荐</b>
            <button className="link-btn" onClick={goRecords}>查看明细 →</button>
          </div>
          <div className="lr-cond">
            <span>推荐资格：LP 挖矿 ≥ {usd0(SHOW_THR)} USDT</span>
            <b className={me.canRefer ? "ok-t" : "err"}>{me.canRefer ? "已满足" : "未满足"}</b>
          </div>
          <div className="lock-two">
            <div><span>团队锁仓</span>{me.team ? <CoinRows v={me.team} snap={snap} /> : <b>统计中…</b>}</div>
            <div><span>推荐奖励累计</span><CoinRows v={me.refReward} snap={snap} /></div>
          </div>
        </section>
      )}

      <section className="card lock-form">
        <div className="lbl">选择锁仓方式</div>
        <div className="opt-col">
          {LOCK_WAYS.map((w) => (
            <button key={w.k} className={coin === w.coin && (coin === 1 || mode === w.mode) ? "on" : ""} onClick={() => pick(w.coin, w.mode)}>
              <b>{w.title}</b>
            </button>
          ))}
        </div>
        <div className="lbl">选择方案</div>
        <div className="opt2">
          {LOCK_PLANS.map((p) => (
            <button key={p.days} className={days === p.days ? "on" : ""} onClick={() => setDays(p.days)}>
              <b>{p.days} 天</b>
              <span>{p.label}</span>
            </button>
          ))}
        </div>
        <div className="lbl row-sb">
          <span>{buy ? "买入金额（USDT）" : `锁仓数量（${name(coin)}）`}</span>
          {bal !== null && <span className="muted">余额 {fmtUnits(bal, balDec)}</span>}
        </div>
        <div className="inp-row">
          <input inputMode="decimal" placeholder={buy ? "请输入买入金额" : "请输入锁仓数量"} value={amtStr} onChange={(e) => setAmtStr(e.target.value.replace(/[^0-9.]/g, ""))} />
          {bal !== null && (
            <button className="btn-mini" onClick={() => setAmtStr(fmtUnits(bal, balDec, 6).replace(/,/g, ""))}>全部</button>
          )}
        </div>
        {buy && (
          <>
            <div className="lbl">锁仓比例</div>
            <div className="opt2">
              <button className={ratio === 10000 ? "on" : ""} onClick={() => setRatio(10000)}>
                <b>100% 锁仓</b>
              </button>
              <button className={ratio === 8000 ? "on" : ""} onClick={() => setRatio(8000)}>
                <b>80% 锁仓</b>
                <span>20% 到钱包</span>
              </button>
            </div>
          </>
        )}
        {/* shown only once an amount is entered and the numbers are worked out */}
        {q && lockedAmt !== null && reward !== null && daily !== null && (
          <div className="kv lock-sum">
            {buy && (
              <div>
                <span>预计买到</span>
                <b>{fmtUnits(q.out, dec(0))} 喜羊羊</b>
              </div>
            )}
            <div>
              <span>锁仓</span>
              <b>{fmtUnits(lockedAmt, dec(coin))} {name(coin)}</b>
            </div>
            {buy && ratio !== 10000 && (
              <div>
                <span>直接到钱包</span>
                <b>{fmtUnits(q.out - lockedAmt, dec(0))} 喜羊羊</b>
              </div>
            )}
            <div>
              <span>立即到账奖励</span>
              <b className="ok-t">+{fmtUnits(reward, dec(coin))} {name(coin)}</b>
            </div>
            <div>
              <span>每天释放</span>
              <b>{fmtUnits(daily, dec(coin))} {name(coin)} × {days} 次</b>
            </div>
          </div>
        )}
        <p className="fine">{buy ? `买入滑点保护 ${LOCK_SLIP_BPS / 100}%。` : ""}锁仓后每满 24 小时释放一次，不能提前解锁。</p>
        {v.paused && <div className="alert">锁仓暂时关闭（管理员已暂停新锁仓），已锁仓的照常释放和领取。</div>}
        {steps && <Steps steps={steps} />}
        {!account ? (
          <button className="btn-gold wide" onClick={onConnect}>连接钱包</button>
        ) : done ? (
          <button className="btn-green wide" onClick={() => setSteps(null)}>完成</button>
        ) : (
          <button className="btn-green wide" disabled={!canTx || running || v.paused || !amt || amt <= 0n || over || !q} onClick={go}>
            {running ? "处理中…" : over ? "余额不足" : steps?.some((x) => x.status === "error") ? "重试" : buy ? "买入并锁仓" : "确认锁仓"}
          </button>
        )}
      </section>

      {me && (
        <>
          <section className="card lock-mine">
            <b>我的锁仓</b>
            <div className="kv">
              <div>
                <span>锁仓中（未释放）</span>
                <Two v={me.stillLocked} snap={snap} />
              </div>
              <div>
                <span>可领取</span>
                <Two v={me.claimable} snap={snap} cls="ok-t" />
              </div>
            </div>
            {claimSteps && <Steps steps={claimSteps} />}
            <button className="btn-gold wide" disabled={!canTx || !canClaim || claimSteps?.some((x) => x.status === "wallet" || x.status === "pending")} onClick={claim}>
              领取已释放的币
            </button>
          </section>
          {me.locks.map((l) => {
            // the phone's clock can be a little behind the chain: never below 0
            const periods = Math.max(0, Math.min(l.days, Math.floor((now / 1000 - l.start) / 86400)));
            const next = l.start + (periods + 1) * 86400;
            return (
              <section className="card lock-item" key={l.id}>
                <div className="row-sb">
                  <b>{name(l.coin)} · {l.days} 天 · {fmtUnits(l.amount, dec(l.coin))}</b>
                  <span className="muted">{fmtCnDay(l.start)} 锁仓</span>
                </div>
                <div className="bar"><i style={{ width: `${(periods / l.days) * 100}%` }} /></div>
                <div className="row-sb fine">
                  <span>已释放 {periods} / {l.days} 次</span>
                  <span>{periods >= l.days ? "已全部释放" : `下次释放 ${fmtCnDay(next, true)}`}</span>
                </div>
              </section>
            );
          })}
        </>
      )}
    </>
  );
}

/** "11月5日" (or "11月5日 14:30" with the time) */
function fmtCnDay(sec: number, withTime = false): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日` + (withTime ? ` ${p(d.getHours())}:${p(d.getMinutes())}` : "");
}

/** a value per coin, one line each: 喜羊羊 / POP */
function Two({ v, snap, cls }: { v: [bigint, bigint]; snap: Snapshot; cls?: string }) {
  return (
    <b className={"two-l" + (cls ? " " + cls : "")}>
      <span>{fmtUnits(v[0], snap.rewardDecimals)} 喜羊羊</span>
      <span>{fmtUnits(v[1], snap.popDecimals)} POP</span>
    </b>
  );
}

/** two coin lines inside a small box: name on the left, amount on the right */
function CoinRows({ v, snap }: { v: [bigint, bigint]; snap: Snapshot }) {
  return (
    <div className="coin-rows">
      <p><em>喜羊羊</em><b>{fmtUnits(v[0], snap.rewardDecimals)}</b></p>
      <p><em>POP</em><b>{fmtUnits(v[1], snap.popDecimals)}</b></p>
    </div>
  );
}

/** admin: 锁仓 contract */
function LockAdminCard({ snap, backend, account, demo, explorer }: { snap: Snapshot; backend: Backend; account: string; demo: boolean; explorer: string }) {
  const [v, reload] = useLockView(backend, "");
  const [copied, setCopied] = useState(false);
  const [amtX, setAmtX] = useState("");
  const [amtP, setAmtP] = useState("");
  const [steps, setSteps] = useState<Step[] | null>(null);
  if (!v) return null;
  const rd = snap.rewardDecimals;
  const pd = snap.popDecimals;
  const can = demo || (!!account && v.owner.toLowerCase() === account.toLowerCase());
  const act = async (a: "pause" | "resume" | "approveXyy" | "approvePop", arg: bigint, label: string) => {
    const st: Step[] = [{ label, status: "idle" }];
    setSteps(st);
    try {
      if (await backend.lockAdmin(a, arg, st, setSteps)) reload();
    } catch (e) {
      setSteps([{ ...st[0], status: "error", error: humanError(e) }]);
    }
  };
  const xV = parseUnitsSafe(amtX, rd);
  const pV = parseUnitsSafe(amtP, pd);
  const both = (p: [bigint, bigint]) => <Two v={p} snap={snap} />;
  return (
    <section className="card btn-col lock-admin">
      <b>锁仓</b>
      <div className="lock-addr">
        <span>锁仓合约</span>
        <div className="row-sb">
          <span className="mono addr-wrap">{v.address}</span>
          <button className="btn-mini" onClick={() => navigator.clipboard?.writeText(v.address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        {explorer && (
          <a href={`${explorer}/address/${v.address}`} target="_blank" rel="noreferrer">
            在 BscScan 查看 ↗
          </a>
        )}
      </div>
      <div className="kv">
        <div><span>状态</span><b className={v.paused ? "err" : "ok-t"}>{v.paused ? "已暂停新锁仓" : "正常锁仓中"}</b></div>
        <div><span>全网锁仓（未释放）</span>{v.network ? both(v.network) : <b>统计中…</b>}</div>
        <div><span>合约里还有（含已释放未领取）</span>{both([v.totals.locked[0] - v.totals.claimed[0], v.totals.locked[1] - v.totals.claimed[1]])}</div>
        <div><span>已发奖励（自己 + 推荐）</span>{both([v.totals.ownReward[0] + v.totals.refReward[0], v.totals.ownReward[1] + v.totals.refReward[1]])}</div>
        <div><span>没人领、留在运营钱包的推荐奖励</span>{both(v.totals.refUnpaid)}</div>
        <div><span>给锁仓合约的剩余授权</span>{both(v.operator.allowance)}</div>
        <div><span>运营钱包余额</span>{both(v.operator.balance)}</div>
      </div>
      <div className="adm-group">
        <b>给锁仓合约授权的喜羊羊数量</b>
        <div className="unit-in">
          <input inputMode="decimal" placeholder="例如 5000000" value={amtX} onChange={(e) => setAmtX(e.target.value)} />
          <em>喜羊羊</em>
        </div>
        <button className="btn-gold wide" disabled={!can || !xV} onClick={() => xV && act("approveXyy", xV, `授权锁仓合约 ${amtX} 喜羊羊`)}>授权 / 补充授权喜羊羊</button>
        <p className="fine">固定额度，会替换当前授权。锁仓喜羊羊时，合约从运营钱包发喜羊羊奖励（自己 5%/10% + 推荐 5%/10%）。</p>
      </div>
      <div className="adm-group">
        <b>给锁仓合约授权的 POP 数量</b>
        <div className="unit-in">
          <input inputMode="decimal" placeholder="例如 100000" value={amtP} onChange={(e) => setAmtP(e.target.value)} />
          <em>POP</em>
        </div>
        <button className="btn-gold wide" disabled={!can || !pV} onClick={() => pV && act("approvePop", pV, `授权锁仓合约 ${amtP} POP`)}>授权 / 补充授权 POP</button>
        <p className="fine">固定额度，会替换当前授权。锁仓 POP 时，合约从运营钱包发 POP 奖励。授权或余额不够时，那一笔锁仓不会成功。</p>
      </div>
      {steps && <Steps steps={steps} />}
      <div className="adm-group">
        {v.paused ? (
          <button className="btn-line wide" disabled={!can} onClick={() => act("resume", 0n, "恢复新锁仓")}>恢复新锁仓</button>
        ) : (
          <button className="btn-line wide danger" disabled={!can} onClick={() => act("pause", 0n, "暂停新锁仓")}>暂停新锁仓</button>
        )}
        <p className="fine">{v.paused ? "现在不能新锁仓；已锁仓的照常释放和领取。" : "暂停后不能新锁仓；已锁仓的照常释放和领取。"}</p>
      </div>
    </section>
  );
}

// =====================================================================================================
// POP 保险池

const INS_SLIP_BPS = 300; // 买入 / 卖出滑点保护 3%
const DAY_S = 86400;
const nowS = () => Math.floor(Date.now() / 1000);
const minB = (...x: bigint[]) => x.reduce((a, b) => (b < a ? b : a));
const sgnU = (x: bigint, dec: number) => (x > 0n ? "+" : x < 0n ? "-" : "") + fmtUnits(x < 0n ? -x : x, dec);

function useInsView(backend: Backend, account: string): [InsView | null | undefined, () => void] {
  const [v, setV] = useState<InsView | null | undefined>(undefined);
  const [n, setN] = useState(0);
  useEffect(() => {
    let off = false;
    const get = () => backend.insView(account).then((x) => !off && setV(x), () => !off && setV((o) => (o === undefined ? null : o)));
    get();
    const id = setInterval(get, 15_000);
    return () => {
      off = true;
      clearInterval(id);
    };
  }, [backend, account, n]);
  return [v, () => setN((x) => x + 1)];
}

const insEligible = (l: InsLot) => nowS() - l.at >= l.rule.waitDays * DAY_S;
/** what the pool can really pay right now: the insurance book, the pool wallet's balance and its allowance */
const insPayable = (v: InsView) => minB(v.books[0].left, v.wallet.balance, v.wallet.allowance);

function IconShield() {
  return (<svg {...sv}><path d="M12 3l8 3v5c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6l8-3z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></svg>);
}

/** 保险池页顶部横幅（用户提供的图） */
function InsBanner({ days }: { days: number }) {
  return (
    <div className="ins-banner">
      <img className="bg" src={A("ins-hero-bg.svg")} alt="" />
      <div className="glow" />
      <img className="art" src={A("ins-hero-sheep.webp")} alt="" />
      <div className="txt">
        <h1>
          买入 POP
          <br />
          亏了有赔付
        </h1>
        <div className="ins-pill">赚了才收费 · 满 {days} 天可赔付</div>
      </div>
    </div>
  );
}

function InsHome({ snap, backend, account, canTx, onConnect, goRecords }: { snap: Snapshot; backend: Backend; account: string; canTx: boolean; onConnect: () => void; goRecords: () => void }) {
  const [v, reload] = useInsView(backend, account);
  const [sheet, setSheet] = useState<null | "buy" | "sell">(null);
  const [lot, setLot] = useState<InsLot | null>(null);
  if (v === undefined)
    return (
      <>
        <InsBanner days={15} />
        <Loading />
      </>
    );
  if (v === null)
    return (
      <>
        <InsBanner days={15} />
        <div className="card center muted">保险池暂未开放，敬请期待</div>
      </>
    );
  const p = v.params;
  const ud = snap.usdtDecimals;
  const pd = snap.popDecimals;
  const me = v.me;
  const one = 10n ** BigInt(pd);
  const valueOf = (pop: bigint) => (pop * v.price.spot) / one;
  const lots = me ? me.lots : [];
  const pop = lots.reduce((s, l) => s + l.left, 0n);
  const value = valueOf(pop);
  const cost = lots.reduce((s, l) => s + l.paidLeft, 0n);
  const pl = value - cost;
  return (
    <>
      <InsBanner days={p.waitDays} />
      <section className="card reward ins-top">
        <div className="row-sb">
          <div className="lbl-light">保险池余额</div>
          <span className="hero-tag">
            满 {p.waitDays} 天 · {p.compRatioBps >= 10_000 ? "亏多少赔多少" : `亏损赔 ${pct(p.compRatioBps)}`}
          </span>
        </div>
        <div className="big">
          {fmtUnits(insPayable(v), ud)} <small>USDT</small>
        </div>
        <div className="split">
          <div>
            <span>今日我还能买</span>
            <b>{me ? fmtUnits(me.quotaMine, ud, 0) : "—"} U</b>
          </div>
          <div>
            <span>今日全网还能买</span>
            <b>{me ? fmtUnits(me.quotaNet, ud, 0) : fmtUnits(p.globalDaily > v.stats.todayBought ? p.globalDaily - v.stats.todayBought : 0n, ud, 0)} U</b>
          </div>
        </div>
        <button className="btn-gold wide" disabled={!!account && (!canTx || v.paused)} onClick={() => (account ? setSheet("buy") : onConnect())}>
          {v.paused ? "暂停新买入" : "买入 POP"}
        </button>
        {v.paused && <p className="fine-light">管理员已暂停新买入，已买的可以照常卖出</p>}
      </section>

      {!account ? (
        <div className="card center">
          <p className="muted">连接钱包后查看你的保险池持仓</p>
          <button className="btn-gold" onClick={onConnect}>连接钱包</button>
        </div>
      ) : (
        me && (
          <>
            <section className="card">
              <div className="row-h">
                <IconShield />
                <span>我的保险池持仓（现值）</span>
              </div>
              <div className="val">
                {fmtUnits(value, ud)} <small>USDT</small>
              </div>
              <div className="assets">
                <span>
                  <img src={A("pop-coin.webp")} alt="POP" /> {fmtUnits(pop, pd)} POP
                </span>
                <span>成本 {fmtUnits(cost, ud)} USDT</span>
              </div>
              <div className="prin-row">
                <span>目前盈亏</span>
                <b className={pl >= 0n ? "ok-t" : "err-b"}>
                  {sgnU(pl, ud)} USDT{cost > 0n ? `（${pl >= 0n ? "+" : "-"}${(Number(((pl < 0n ? -pl : pl) * 10_000n) / cost) / 100).toFixed(2)}%）` : ""}
                </b>
              </div>
            </section>

            <div className="ins-sub">我的每一笔（每一笔单独卖出、单独计算）</div>
            {lots.length === 0 && <div className="card center muted">还没有买入，点上面的「买入 POP」开始</div>}
            {lots.map((l) => {
              const ok = insEligible(l);
              const passed = Math.min(l.rule.waitDays, Math.max(0, Math.floor((nowS() - l.at) / DAY_S)));
              const dleft = l.rule.waitDays - passed;
              const val = valueOf(l.left);
              const d = val - l.paidLeft;
              return (
                <section className="card lock-item" key={l.id}>
                  <div className="row-sb">
                    <b>
                      {fmtCnDay(l.at)} 买入 · {fmtUnits(l.paid, ud, 0)} U
                    </b>
                    <span className={"pill " + (ok ? "ok" : "no")}>{ok ? "✓ 已可赔付" : `还有 ${dleft} 天可赔`}</span>
                  </div>
                  <div className="bar">
                    <i style={{ width: `${(passed / l.rule.waitDays) * 100}%` }} />
                  </div>
                  <div className="ins-lot-nums">
                    <div>
                      <span>剩余</span>
                      <b>
                        {fmtUnits(l.left, pd)} <small>POP</small>
                      </b>
                    </div>
                    <div>
                      <span>现值</span>
                      <b>
                        {fmtUnits(val, ud)} <small>U</small> <em className={d >= 0n ? "ok-t" : "err-b"}>{sgnU(d, ud)}</em>
                      </b>
                    </div>
                  </div>
                  <button className="btn-green wide ins-lot-sell" disabled={!canTx} onClick={() => { setLot(l); setSheet("sell"); }}>
                    卖出这笔
                  </button>
                </section>
              );
            })}

            <InsRefer v={v} snap={snap} backend={backend} account={account} goRecords={goRecords} />
          </>
        )
      )}
      {sheet === "buy" && <InsBuySheet v={v} snap={snap} backend={backend} close={() => setSheet(null)} done={reload} />}
      {sheet === "sell" && lot && <InsSellSheet v={v} snap={snap} backend={backend} account={account} lot={lot} close={() => setSheet(null)} done={reload} />}
    </>
  );
}

function InsRefer({ v, snap, backend, account, goRecords }: { v: InsView; snap: Snapshot; backend: Backend; account: string; goRecords: () => void }) {
  const [allT, setAllT] = useState(false);
  const [allD, setAllD] = useState(false);
  const [allR, setAllR] = useState(false);
  const [recs, setRecs] = useState<InsRefRec[] | null>(null);
  useEffect(() => {
    let off = false;
    backend
      .latestBlock()
      .then((b) => backend.insRefRecs(account, b, 200_000))
      .then((r) => !off && setRecs(r), () => !off && setRecs([]));
    return () => {
      off = true;
    };
  }, [backend, account]);
  const me = v.me!;
  const p = v.params;
  const ud = snap.usdtDecimals;
  const team = me.team;
  const More = ({ on, set, label }: { on: boolean; set: (x: boolean) => void; label: string }) => (
    <button className="more-btn" onClick={() => set(!on)}>
      {on ? "收起 ▴" : `${label} ▾`}
    </button>
  );
  const levels = team ? team.levels : [];
  const ts = allT ? levels : levels.slice(0, 2);
  const directs = team ? team.directs : [];
  const ds = allD ? directs : directs.slice(0, 2);
  const rs = recs ? (allR ? recs : recs.slice(0, 2)) : [];
  return (
    <>
      <section className="card">
        <div className="row-h">
          <IconUsers />
          <span>我的保险池推荐</span>
        </div>
        <div className="counts three">
          <div><span>有效直推</span><b>{me.directs}</b></div>
          <div><span>已开代数</span><b>{me.levels}<small> / 7</small></b></div>
          <div><span>累计推广奖励</span><b>{fmtUnits(me.earned, ud)}</b><span>USDT</span></div>
        </div>
        <p className="fine">有效直推 = 直推在保险池持仓 ≥ {fmtUnits(p.directMin, ud, 0)} U。有几个有效直推就开几代，最多 7 代；每代拿下级盈利的 {pct(Math.floor((p.profitFeeBps * p.split[2]) / (p.split[0] + p.split[1] + p.split[2] || 1) / 7))}。</p>
      </section>

      <section className="card">
        <div className="row-h">
          <IconLayers />
          <span>网体关系（7 代）</span>
        </div>
        {!team ? (
          <p className="fine">统计中…（自动检查程序读取链上记录后显示）</p>
        ) : (
          <>
            <div className="ins-team">
              {ts.map((l) => (
                <div key={l.n} className={l.n <= me.levels ? "" : "off"}>
                  <b>第 {l.n} 代</b>
                  <span>
                    {l.people} 人<small>在保险池 {l.inPool} 人</small>
                  </span>
                  <em>{fmtUnits(l.hold, ud, 0)} U</em>
                  <i className={"pill " + (l.n <= me.levels ? "ok" : "no")}>{l.n <= me.levels ? "已开" : "未开"}</i>
                </div>
              ))}
            </div>
            <More on={allT} set={setAllT} label="展开全部 7 代" />
            <div className="kv ins-team-sum">
              <div><span>团队总人数</span><b>{team.people} 人</b></div>
              <div><span>团队保险池总持仓</span><b>{fmtUnits(team.hold, ud, 0)} U</b></div>
            </div>
          </>
        )}
        <p className="fine">推荐关系和喜羊羊矿场是同一套绑定；这里只统计保险池的持仓（按买入成本）。</p>
      </section>

      <section className="card list">
        <div className="row-sb ins-list-h">
          <b>我的直推（{team ? directs.length : "—"} 人）</b>
        </div>
        {team && directs.length === 0 && <div className="center muted ins-empty">还没有直推</div>}
        {ds.map((d) => (
          <div className="li" key={d.addr}>
            <div className="av"><IconUser /></div>
            <div className="grow">
              <b className="mono">{short(d.addr)}</b>
              <div className="fine">保险池持仓 {d.hold > 0n ? `${fmtUnits(d.hold, ud, 0)} U` : "没参与"}</div>
            </div>
            <span className={"pill " + (d.hold >= p.directMin ? "ok" : "no")}>{d.hold >= p.directMin ? "有效" : d.hold > 0n ? `未达 ${fmtUnits(p.directMin, ud, 0)} U` : "未参与"}</span>
          </div>
        ))}
        {directs.length > 2 && <More on={allD} set={setAllD} label={`展开全部 ${directs.length} 人`} />}
      </section>

      <section className="card list">
        <div className="row-sb ins-list-h">
          <b>推广奖励记录</b>
          <button className="link-btn" onClick={goRecords}>查看全部 →</button>
        </div>
        {!recs && <div className="center muted ins-empty">加载中…</div>}
        {recs && recs.length === 0 && <div className="center muted ins-empty">还没有推广奖励</div>}
        {rs.map((r) => (
          <div className="li rec" key={r.tx + r.level}>
            <div className="rec-ic in">+</div>
            <div className="grow">
              <b>第 {r.level} 代 · +{fmtUnits(r.amount, ud)} USDT</b>
              <div className="fine">来自 {short(r.from)}</div>
              <div className="fine">{fmtCnDay(r.time, true)}</div>
            </div>
          </div>
        ))}
        {recs && recs.length > 2 && <More on={allR} set={setAllR} label="展开" />}
      </section>
    </>
  );
}

function InsBuySheet({ v, snap, backend, close, done }: { v: InsView; snap: Snapshot; backend: Backend; close: () => void; done: () => void }) {
  const p = v.params;
  const ud = snap.usdtDecimals;
  const me = v.me!;
  const [txt, setTxt] = useState("");
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [popOut, setPopOut] = useState<bigint | null>(null);
  const x = parseUnitsSafe(txt, ud) ?? 0n;
  const fee = (x * BigInt(p.buyFeeBps)) / 10_000n;
  const bad = !x
    ? ""
    : x < p.minBuy || x > p.maxBuy
      ? `每笔 ${fmtUnits(p.minBuy, ud, 0)}～${fmtUnits(p.maxBuy, ud, 0)} USDT`
      : x > me.quotaMine
        ? `超过你今天的剩余额度 ${fmtUnits(me.quotaMine, ud, 0)} USDT`
        : x > me.usdt
          ? "USDT 余额不足"
          : "";
  useEffect(() => {
    let off = false;
    setPopOut(null);
    if (x > 0n && !bad) backend.insQuoteBuy(x, p.buyFeeBps).then((o) => !off && setPopOut(o), () => {});
    return () => {
      off = true;
    };
  }, [txt]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = async () => {
    const st: Step[] = [
      { label: `授权 ${fmtUnits(x, ud)} USDT（只授权这一笔的金额）`, status: "idle" },
      { label: "买入 POP", status: "idle" },
    ];
    setSteps(st);
    setBusy(true);
    try {
      if (await backend.insBuy(x, INS_SLIP_BPS, v.rev, p.buyFeeBps, st, setSteps)) done();
    } catch (e) {
      setSteps([{ ...st[0], status: "error", error: humanError(e) }]);
    } finally {
      setBusy(false);
    }
  };
  const quick = [200, 500, 1000, 2000].map((a) => BigInt(a) * 10n ** BigInt(ud)).filter((a) => a >= p.minBuy && a <= p.maxBuy);
  return (
    <Sheet title="买入 POP" close={close} icon={<IconShield />}>
      <label className="inp">
        <span>
          买入金额 <em>余额 {fmtUnits(me.usdt, ud)} USDT</em>
        </span>
        <div className="unit-in">
          <input inputMode="decimal" placeholder={`请输入 ${fmtUnits(p.minBuy, ud, 0)}～${fmtUnits(p.maxBuy, ud, 0)}`} value={txt} onChange={(e) => { setTxt(e.target.value); setSteps(null); }} />
          <em>USDT</em>
        </div>
      </label>
      {quick.length > 0 && (
        <div className="pct-row">
          {quick.map((a) => (
            <button key={String(a)} className={x === a ? "on" : ""} onClick={() => { setTxt(fmtUnits(a, ud, 0).replace(/,/g, "")); setSteps(null); }}>
              {fmtUnits(a, ud, 0).replace(/,/g, "")}
            </button>
          ))}
        </div>
      )}
      {x > 0n && !bad && (
        <div className="quote ins-q">
          <div className="qr-row"><span>买入手续费 {pct(p.buyFeeBps)}（进保险池）</span><b>{fmtUnits(fee, ud)} USDT</b></div>
          <div className="qr-row"><span>实际买币</span><b>{fmtUnits(x - fee, ud)} USDT</b></div>
          <div className="qr-row"><span>预计得到</span><b className="big-d">{popOut === null ? "…" : `${fmtUnits(popOut, snap.popDecimals)} POP`}</b></div>
        </div>
      )}
      {bad && <p className="err ins-err">{bad}</p>}
      <div className="note-gold ins-note">
        这一笔的规则买入时就定下：持有满 {p.waitDays} 天后卖出，{p.compRatioBps >= 10_000 ? "亏多少赔多少" : `亏损赔 ${pct(p.compRatioBps)}`}
        {p.compCapBps < 10_000 ? `（每笔最多赔本金的 ${pct(p.compCapBps)}）` : ""}；赚了收盈利的 {pct(p.profitFeeBps)}。
      </div>
      {steps && <Steps steps={steps} />}
      {steps && steps.every((s) => s.status === "done" || s.status === "skipped") ? (
        <button className="btn-gold wide" onClick={close}>完成</button>
      ) : (
        <button className="btn-gold wide" disabled={!x || !!bad || busy || v.paused} onClick={go}>
          {busy ? "处理中…" : "买入"}
        </button>
      )}
      <p className="fine">今天你还能买 {fmtUnits(me.quotaMine, ud, 0)} USDT · 全网还能买 {fmtUnits(me.quotaNet, ud, 0)} USDT · 滑点保护 {pct(INS_SLIP_BPS)}</p>
    </Sheet>
  );
}

function InsLotHead({ l, ud }: { l: InsLot; ud: number }) {
  const ok = insEligible(l);
  const dleft = l.rule.waitDays - Math.min(l.rule.waitDays, Math.max(0, Math.floor((nowS() - l.at) / DAY_S)));
  return (
    <div className="ins-lot-head">
      <div className="row-sb">
        <b>{fmtCnDay(l.at)} 买入 · {fmtUnits(l.paid, ud, 0)} U</b>
        <span className={"pill " + (ok ? "ok" : "no")}>{ok ? "✓ 已可赔付" : `还有 ${dleft} 天可赔`}</span>
      </div>
      <div className="fine">这笔规则：亏损赔 {pct(l.rule.compRatioBps)} · 盈利费 {pct(l.rule.profitFeeBps)} · 满 {l.rule.waitDays} 天</div>
    </div>
  );
}

function InsSellSheet({ v, snap, backend, account, lot, close, done }: { v: InsView; snap: Snapshot; backend: Backend; account: string; lot: InsLot; close: () => void; done: () => void }) {
  const ud = snap.usdtDecimals;
  const pd = snap.popDecimals;
  const [txt, setTxt] = useState("");
  const [exact, setExact] = useState<bigint | null>(null); // amount picked with a % button (no rounding)
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState<InsSellQuote | null | undefined>(undefined);
  const typed = parseUnitsSafe(txt, pd) ?? 0n;
  const amt = exact !== null && txt === fmtUnits(exact, pd, 6).replace(/,/g, "") ? exact : typed;
  const over = amt > lot.left;
  const ok = insEligible(lot);
  useEffect(() => {
    let off = false;
    setQ(undefined);
    if (amt > 0n && !over) {
      const t = setTimeout(() => backend.insSellQuote(account, lot, amt).then((r) => !off && setQ(r), () => !off && setQ(null)), 300);
      return () => {
        off = true;
        clearTimeout(t);
      };
    }
    return () => {
      off = true;
    };
  }, [txt, exact]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (k: bigint) => {
    const a = k === 100n ? lot.left : (lot.left * k) / 100n;
    setExact(a);
    setTxt(fmtUnits(a, pd, 6).replace(/,/g, ""));
    setSteps(null);
  };
  const go = async () => {
    const st: Step[] = [{ label: `卖出 ${fmtUnits(amt, pd)} POP`, status: "idle" }];
    setSteps(st);
    setBusy(true);
    try {
      if (await backend.insSell(lot, amt, INS_SLIP_BPS, st, setSteps)) done();
    } catch (e) {
      setSteps([{ ...st[0], status: "error", error: humanError(e) }]);
    } finally {
      setBusy(false);
    }
  };
  const pl = q ? q.proceeds - q.cost : 0n;
  return (
    <Sheet title="卖出这笔" close={close} icon={<IconShield />}>
      <InsLotHead l={lot} ud={ud} />
      <label className="inp">
        <span>
          卖出数量 <em>这笔可卖 {fmtUnits(lot.left, pd)} POP</em>
        </span>
        <div className="unit-in">
          <input inputMode="decimal" placeholder="请输入卖出数量" value={txt} onChange={(e) => { setTxt(e.target.value); setExact(null); setSteps(null); }} />
          <em>POP</em>
        </div>
      </label>
      <div className="pct-row">
        {[25n, 50n, 75n, 100n].map((k) => (
          <button key={String(k)} onClick={() => pick(k)}>
            {String(k)}%
          </button>
        ))}
      </div>
      {over && <p className="err ins-err">超过这笔的剩余数量</p>}
      {amt > 0n && !over && (
        <div className="quote ins-q">
          {q === undefined && <div className="qr-row"><span>正在计算…</span><b /></div>}
          {q === null && <div className="qr-row"><span>暂时算不出，请稍后再试</span><b /></div>}
          {q && (
            <>
              <div className="qr-row"><span>预计卖出得到</span><b>{fmtUnits(q.proceeds, ud)} USDT</b></div>
              <div className="qr-row"><span>这部分的成本</span><b>{fmtUnits(q.cost, ud)} USDT</b></div>
              <div className="qr-row"><span>盈亏</span><b className={pl >= 0n ? "ok-t" : "err-b"}>{sgnU(pl, ud)} USDT</b></div>
              {q.fee > 0n && <div className="qr-row"><span>盈利费 {pct(lot.rule.profitFeeBps)}</span><b className="err-b">-{fmtUnits(q.fee, ud)} USDT</b></div>}
              <div className="qr-row">
                <span>保险池赔付</span>
                <b className={q.comp > 0n ? "ok-t" : ""}>{q.comp > 0n ? `+${fmtUnits(q.comp, ud)} USDT` : pl >= 0n ? "赚了，不用赔" : ok ? "按平均价没亏，不赔" : `没满 ${lot.rule.waitDays} 天，不赔`}</b>
              </div>
              <div className="qr-row"><span>实际到账</span><b className="big-d">{fmtUnits(q.toUser + q.comp, ud)} USDT</b></div>
            </>
          )}
        </div>
      )}
      {steps && <Steps steps={steps} />}
      {steps && steps.every((s) => s.status === "done" || s.status === "skipped") ? (
        <button className="btn-green wide" onClick={close}>完成</button>
      ) : (
        <button className="btn-green wide" disabled={!amt || over || busy} onClick={go}>
          {busy ? "处理中…" : "卖出"}
        </button>
      )}
      <p className="fine">滑点保护 {pct(INS_SLIP_BPS)} · 实际以链上成交为准</p>
    </Sheet>
  );
}

function F({ label, value, set, unit, ro }: { label: string; value: string; set: (s: string) => void; unit: string; ro?: boolean }) {
  return (
    <label className="inp">
      <span>{label}</span>
      <div className="unit-in sm">
        <input inputMode="decimal" value={value} readOnly={ro} onChange={(e) => set(e.target.value)} />
        <em>{unit}</em>
      </div>
    </label>
  );
}

const BOOK_NAME = ["保险账", "生态账", "动态账"];
const BOOK_NOTE = ["买入手续费 + 盈利费 5 份 · 用来赔付", "盈利费 3 份 · 你自己支配", "盈利费 7 份里没人拿的"];

function InsAdminCard({ snap, backend, account, demo }: { snap: Snapshot; backend: Backend; account: string; demo: boolean }) {
  const [v, reload] = useInsView(backend, "");
  const [demoRole, setDemoRole] = useState<"main" | "sub">("main");
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [copied, setCopied] = useState("");
  const ud = snap.usdtDecimals;
  const u0 = (x: bigint) => fmtUnits(x, ud, 0).replace(/,/g, "");
  const p = v?.params;
  const [lim, setLim] = useState<[string, string]>(["", ""]);
  const [rules, setRules] = useState<string[]>([]);
  const [split, setSplit] = useState<string[]>([]);
  const [mv, setMv] = useState<[string, string, string]>(["1", "0", ""]);
  const [adj, setAdj] = useState<[string, string]>(["0", ""]);
  const [appr, setAppr] = useState("");
  const [newSub, setNewSub] = useState("");
  const [newWallet, setNewWallet] = useState("");
  useEffect(() => {
    if (!p) return;
    setLim([u0(p.globalDaily), u0(p.walletDaily)]);
    setRules([u0(p.minBuy), u0(p.maxBuy), String(p.buyFeeBps / 100), String(p.profitFeeBps / 100), String(p.compRatioBps / 100), String(p.compCapBps / 100), String(p.waitDays), u0(p.directMin)]);
    setSplit(p.split.map(String));
  }, [v?.rev, v?.params.split.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  if (v === undefined) return <Loading />;
  if (v === null) return <div className="card center muted">保险池合约还没有配置</div>;
  const isOwner = !!account && account.toLowerCase() === v.owner.toLowerCase();
  const isSubW = !!account && v.subs.some((s) => s.toLowerCase() === account.toLowerCase());
  const isWallet = !!account && account.toLowerCase() === v.poolWallet.toLowerCase();
  const main = demo ? demoRole === "main" : isOwner;
  const canLimits = demo || isOwner || isSubW;
  const act = async (a: InsAdminAction, args: any[], label: string) => {
    const st: Step[] = [{ label, status: "idle" }];
    setSteps(st);
    try {
      if (await backend.insAdmin(a, args, st, setSteps)) reload();
    } catch (e) {
      setSteps([{ ...st[0], status: "error", error: humanError(e) }]);
    }
  };
  const U = (s: string) => parseUnitsSafe(s, ud);
  const bps = (s: string) => Math.round(Number(s) * 100);
  const limErr = !U(lim[0]) && lim[0] !== "0" ? "请填写全网每天限额" : !U(lim[1]) && lim[1] !== "0" ? "请填写每个钱包每天限额" : "";
  const r = rules;
  const ruleErr =
    r.length < 8 ? "" :
    !U(r[0]) || !U(r[1]) || (U(r[1]) ?? 0n) < (U(r[0]) ?? 0n) ? "每笔最少 / 最多填写有误（最多不能小于最少）" :
    !(bps(r[2]) >= 0 && bps(r[2]) <= 1000) ? "买入手续费 0～10%" :
    !(bps(r[3]) >= 0 && bps(r[3]) <= 5000) ? "盈利费 0～50%" :
    !(bps(r[4]) >= 0 && bps(r[4]) <= 10_000) ? "赔付比例 0～100%" :
    !(bps(r[5]) >= 0 && bps(r[5]) <= 10_000) ? "每笔最多赔本金 0～100%" :
    !(Number(r[6]) >= 1 && Number(r[6]) <= 3650 && Number.isInteger(Number(r[6]))) ? "持有天数填 1～3650 的整数" :
    U(r[7]) === null ? "请填写有效直推门槛" : "";
  const splitErr = split.some((x) => !/^\d+$/.test(x) || Number(x) > 255) || split.reduce((s, x) => s + Number(x || 0), 0) === 0 ? "分配请填 0～255 的整数，不能全是 0" : "";
  const copy = (a: string) => navigator.clipboard?.writeText(a).then(() => { setCopied(a); setTimeout(() => setCopied(""), 1500); });
  return (
    <section className="card btn-col ins-admin">
      <b>保险池</b>
      {demo && (
        <div className="seg">
          <button className={main ? "on" : ""} onClick={() => setDemoRole("main")}>主管理员看到的</button>
          <button className={!main ? "on" : ""} onClick={() => setDemoRole("sub")}>副管理员看到的</button>
        </div>
      )}
      {!demo && !isOwner && !isSubW && !isWallet && <div className="alert warn">当前钱包不是保险池的主管理员或副管理员，链上会拒绝操作。</div>}
      {!demo && isWallet && !isOwner && <div className="alert warn">当前是资金池钱包：只能给合约授权，其他设置要用主管理员钱包。</div>}

      {[["主管理员", v.owner], ["资金池钱包", v.poolWallet], ["保险池合约", v.address]].map(([t, a]) => (
        <div className="lock-addr" key={t}>
          <span>{t}</span>
          <div className="row-sb">
            <span className="mono addr-wrap">{a}</span>
            <button className="btn-mini" onClick={() => copy(a)}>{copied === a ? "已复制" : "复制"}</button>
          </div>
        </div>
      ))}
      <div className="kv">
        <div><span>状态</span><b className={v.paused ? "err" : "ok-t"}>{v.paused ? "已暂停新买入" : "正常买入中"}</b></div>
        <div><span>资金池钱包余额</span><b>{fmtUnits(v.wallet.balance, ud)} USDT</b></div>
        <div><span>给合约的剩余授权</span><b>{fmtUnits(v.wallet.allowance, ud)} USDT</b></div>
        <div><span>现在最多能赔</span><b>{fmtUnits(insPayable(v), ud)} USDT</b></div>
      </div>

      <div className="ins-books">
        {v.books.map((b, i) => (
          <div key={i}>
            <div className="row-sb">
              <span>{BOOK_NAME[i]}</span>
              <b>{fmtUnits(b.left, ud)} <small>USDT</small></b>
            </div>
            <em>{BOOK_NOTE[i]}</em>
            <p>累计进账 {fmtUnits(b.inflow, ud)} · {i === 0 ? "已赔付" : i === 2 ? "已支出" : "已支出"} {fmtUnits(b.outflow, ud)}</p>
          </div>
        ))}
      </div>
      <p className="fine">三本账的钱都在资金池钱包里，合约只记账。赔付最多赔到「保险账剩余、钱包余额、剩余授权」里最小的那个。</p>

      <div className="kv ins-stats">
        <div><span>参与人数</span><b>{v.stats.participants} 人</b></div>
        <div><span>合约里的 POP</span><b>{fmtUnits(v.stats.totalPop, snap.popDecimals)} POP</b></div>
        <div><span>今日全网已买</span><b>{fmtUnits(v.stats.todayBought, ud, 0)} / {fmtUnits(v.params.globalDaily, ud, 0)} USDT</b></div>
        <div><span>累计买入</span><b>{fmtUnits(v.stats.totalBought, ud)} USDT</b></div>
        <div><span>累计赔付</span><b>{fmtUnits(v.stats.totalComp, ud)} USDT</b></div>
        <div><span>累计推广奖励</span><b>{fmtUnits(v.stats.totalRef, ud)} USDT</b></div>
      </div>

      <div className="adm-group">
        <b>每天限额 <em className="ins-who">主、副管理员都能改</em></b>
        <div className="grid-in">
          <F label="全网每天" value={lim[0]} set={(x) => setLim([x, lim[1]])} unit="U" ro={!canLimits} />
          <F label="每个钱包每天" value={lim[1]} set={(x) => setLim([lim[0], x])} unit="U" ro={!canLimits} />
        </div>
        {limErr && <p className="err">{limErr}</p>}
        <button className="btn-gold wide" disabled={!canLimits || !!limErr} onClick={() => act("dailyLimits", [U(lim[0]) ?? 0n, U(lim[1]) ?? 0n], `保存每天限额：全网 ${lim[0]} U，每个钱包 ${lim[1]} U`)}>
          保存每天限额
        </button>
      </div>

      <div className="adm-group">
        <b>买入与赔付规则 <em className="ins-who">{main ? "只有主管理员能改" : "只能看，只有主管理员能改"}</em></b>
        {r.length === 8 && (
          <div className="grid-in">
            {[["每笔最少", "U"], ["每笔最多", "U"], ["买入手续费", "%"], ["盈利费", "%"], ["赔付比例", "%"], ["每笔最多赔本金的", "%"], ["持有多少天后才赔", "天"], ["有效直推门槛", "U"]].map(([lb, un], i) => (
              <F key={lb} label={lb} value={r[i]} set={(x) => setRules(r.map((y, j) => (j === i ? x : y)))} unit={un} ro={!main} />
            ))}
          </div>
        )}
        {main && ruleErr && <p className="err">{ruleErr}</p>}
        {main && (
          <button
            className="btn-gold wide"
            disabled={!!ruleErr}
            onClick={() => act("rules", [U(r[0]), U(r[1]), bps(r[2]), bps(r[3]), bps(r[4]), bps(r[5]), Number(r[6]), U(r[7])], `保存规则：每笔 ${r[0]}～${r[1]} U，手续费 ${r[2]}%，盈利费 ${r[3]}%，赔付 ${r[4]}%，封顶 ${r[5]}%，满 ${r[6]} 天，有效直推 ${r[7]} U`)}
          >
            保存规则
          </button>
        )}
        <div className="ins-split">
          <span>盈利费分配</span>
          <div className="grid-in three">
            {["保险", "生态", "动态"].map((lb, i) => (
              <F key={lb} label={lb} value={split[i] ?? ""} set={(x) => setSplit(split.map((y, j) => (j === i ? x : y)))} unit="份" ro={!main} />
            ))}
          </div>
        </div>
        {main && splitErr && <p className="err">{splitErr}</p>}
        {main && (
          <button className="btn-line wide" disabled={!!splitErr} onClick={() => act("split", split.map(Number), `保存盈利费分配 ${split.join(":")}`)}>
            保存分配
          </button>
        )}
        <p className="fine">规则只影响之后的新买入，已经买的那些笔还按买入时的规则。买入手续费最高 10%，盈利费最高 50%。用户正在下单时改了规则，那一笔会自动失败、不扣钱。</p>
      </div>

      {(main || isWallet) && (
          <div className="adm-group">
            <b>资金池钱包给合约授权</b>
            <div className="unit-in">
              <input inputMode="decimal" placeholder="例如 20000" value={appr} onChange={(e) => setAppr(e.target.value)} />
              <em>USDT</em>
            </div>
            <button className="btn-gold wide" disabled={(!demo && !isWallet) || !U(appr)} onClick={() => act("approve", [U(appr)], `资金池钱包授权合约 ${appr} USDT`)}>
              授权 / 补充授权
            </button>
            <p className="fine">{isWallet || demo ? "" : "要用资金池钱包连接网站才能操作。"}固定额度，会替换当前授权；合约只能按规则从这里扣钱赔付。</p>
          </div>

      )}
      {main && (
        <>
          <div className="adm-group">
            <b>调整账目</b>
            <div className="grid-in">
              <label className="inp">
                <span>从</span>
                <select className="sel" value={mv[0]} onChange={(e) => setMv([e.target.value, mv[1], mv[2]])}>
                  {BOOK_NAME.map((n, i) => <option key={i} value={i}>{n}</option>)}
                </select>
              </label>
              <label className="inp">
                <span>划到</span>
                <select className="sel" value={mv[1]} onChange={(e) => setMv([mv[0], e.target.value, mv[2]])}>
                  {BOOK_NAME.map((n, i) => <option key={i} value={i}>{n}</option>)}
                </select>
              </label>
            </div>
            <div className="unit-in">
              <input inputMode="decimal" placeholder="划转金额" value={mv[2]} onChange={(e) => setMv([mv[0], mv[1], e.target.value])} />
              <em>USDT</em>
            </div>
            <button className="btn-line wide" disabled={mv[0] === mv[1] || !U(mv[2])} onClick={() => act("moveBook", [Number(mv[0]), Number(mv[1]), U(mv[2])], `从${BOOK_NAME[Number(mv[0])]}划 ${mv[2]} USDT 到${BOOK_NAME[Number(mv[1])]}`)}>
              划转
            </button>
            <div className="grid-in">
              <label className="inp">
                <span>直接改数字</span>
                <select className="sel" value={adj[0]} onChange={(e) => setAdj([e.target.value, adj[1]])}>
                  {BOOK_NAME.map((n, i) => <option key={i} value={i}>{n}</option>)}
                </select>
              </label>
              <F label="改成" value={adj[1]} set={(x) => setAdj([adj[0], x])} unit="U" />
            </div>
            <button className="btn-line wide" disabled={U(adj[1]) === null} onClick={() => act("adjustBook", [Number(adj[0]), U(adj[1])], `把${BOOK_NAME[Number(adj[0])]}改成 ${adj[1]} USDT`)}>
              改数字
            </button>
            <p className="fine">只是改账，钱一直都在资金池钱包里。比如资金池钱包里本来就有 1 万 USDT 要算作保险，就把保险账改成 10000。</p>
          </div>

          <div className="adm-group">
            <b>副管理员（最多 3 个）</b>
            {v.subs.length === 0 && <p className="fine">还没有副管理员</p>}
            {v.subs.map((a) => (
              <div className="row-sb ins-sub-li" key={a}>
                <span className="mono">{short(a)}</span>
                <button className="btn-mini" onClick={() => act("delSub", [a], `删除副管理员 ${short(a)}`)}>删除</button>
              </div>
            ))}
            <div className="inp-row">
              <input placeholder="新副管理员钱包地址 0x…" value={newSub} onChange={(e) => setNewSub(e.target.value.trim())} />
            </div>
            <button className="btn-line wide" disabled={v.subs.length >= 3 || !/^0x[0-9a-fA-F]{40}$/.test(newSub)} onClick={() => act("addSub", [newSub], `添加副管理员 ${short(newSub)}`)}>
              添加副管理员
            </button>
            <p className="fine">副管理员只能改每天限额，其他都只能看。</p>
          </div>

          <div className="adm-group">
            <b>更换资金池钱包</b>
            <div className="inp-row">
              <input placeholder="新资金池钱包地址 0x…" value={newWallet} onChange={(e) => setNewWallet(e.target.value.trim())} />
            </div>
            <button className="btn-line wide" disabled={!/^0x[0-9a-fA-F]{40}$/.test(newWallet)} onClick={() => act("poolWallet", [newWallet], `资金池钱包换成 ${short(newWallet)}`)}>
              更换
            </button>
            <p className="fine">换钱包后：新钱包要重新授权，旧钱包里的钱需要自己转过去，三本账的数字不变。</p>
          </div>

          <div className="adm-group">
            {v.paused ? (
              <button className="btn-line wide" onClick={() => act("resume", [], "恢复新买入")}>恢复新买入</button>
            ) : (
              <button className="btn-line wide danger" onClick={() => act("pause", [], "暂停新买入")}>暂停新买入</button>
            )}
            <p className="fine">暂停后不能新买入；卖出照常，谁都不能暂停卖出。</p>
          </div>
        </>
      )}
      {steps && <Steps steps={steps} />}
    </section>
  );
}

// ------------------------------------------------------------------ team statistics (referral page + admin lookup)
function useTeam(backend: Backend, addr: string): TeamStats | null {
  const [t, setT] = useState<TeamStats | null>(null);
  useEffect(() => {
    setT(null);
    if (!addr) return;
    let off = false;
    const get = () => backend.teamStats(addr).then((x) => !off && x && setT(x), () => {});
    get();
    const id = setInterval(get, 60_000);
    return () => {
      off = true;
      clearInterval(id);
    };
  }, [backend, addr]);
  return t;
}

function TeamCard({ snap, team }: { snap: Snapshot; team: TeamStats | null }) {
  const ud = snap.usdtDecimals;
  const pd = snap.popDecimals;
  const v = (x: bigint | undefined, d: number) => (team && x !== undefined ? fmtUnits(x, d) : "—");
  return (
    <section className="card team">
      <div className="team-h">团队累计入金</div>
      <div className="kv">
        <div><span>用 USDT 添加</span><b>{v(team?.usdtOnly, ud)} USDT</b></div>
        <div><span>用 USDT + POP 添加</span><b><i className="nw">{v(team?.bothUsdt, ud)} USDT</i><i className="nw">+ {v(team?.bothPop, pd)} POP</i></b></div>
        <div><span>合计（约）</span><b className="team-sum">{team ? fmtUnits(team.usdtOnly + team.bothValue, ud) : "—"} USDT</b></div>
      </div>
      <div className="team-h">团队当前质押</div>
      <div className="kv">
        <div><span>池子里现有</span><b><i className="nw">{v(team?.nowPop, pd)} POP</i><i className="nw">+ {v(team?.nowUsdt, ud)} USDT</i></b></div>
        <div><span>约合</span><b className="team-sum">{v(team?.nowValueUsd, 18)} USDT</b></div>
      </div>
    </section>
  );
}

/** admin: look up any wallet's team */
function TeamLookup({ snap, backend }: { snap: Snapshot; backend: Backend }) {
  const [input, setInput] = useState("");
  const [addr, setAddr] = useState("");
  const team = useTeam(backend, addr);
  const ok = /^0x[0-9a-fA-F]{40}$/.test(input.trim());
  return (
    <section className="card">
      <b>查询团队</b>
      <p className="fine">输入任意钱包地址，查看他的直推、间推、团队总人数和团队入金。</p>
      <div className="inp-row">
        <input placeholder="钱包地址 0x…" value={input} onChange={(e) => setInput(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <button className="btn-green sm" disabled={!ok} onClick={() => setAddr(input.trim())}>查询</button>
      </div>
      {addr && (
        <>
          <div className="counts team-counts">
            <div><span>直推</span><b>{team ? team.direct : "—"}</b></div>
            <div><span>间推</span><b>{team ? team.indirect : "—"}</b></div>
            <div><span>团队总人数</span><b>{team ? team.team : "—"}</b></div>
          </div>
          <TeamCard snap={snap} team={team} />
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ live estimate (display only)
interface Live {
  personalUsd: bigint;
  dynamicUsd: bigint;
  pendingTokens: bigint | null;
  personalTokens: bigint | null;
  dynamicTokens: bigint | null;
  dailyTokens: bigint | null;
  dailyUsd: bigint;
}
function useLive(snap: Snapshot | null, tick: number): Live | null {
  return useMemo(() => {
    if (!snap?.user) return null;
    const u = snap.user;
    const pr = snap.params;
    const dailyUsd = (u.principalUsd * BigInt(pr.rateBps) * BigInt(pr.personalBps)) / 100_000_000n; // 按入金额度
    const dt = BigInt(Math.max(0, Math.floor((Date.now() - snap.fetchedAt) / 1000)));
    const personalUsd = u.personalUsd + (snap.running ? (dailyUsd * dt) / 86400n : 0n);
    const p = snap.rewardPrice;
    const d = snap.rewardDecimals;
    const tok = (x: bigint) => usdToToken(x, p, d);
    return {
      personalUsd,
      dynamicUsd: u.dynamicUsd,
      pendingTokens: tok(personalUsd + u.dynamicUsd),
      personalTokens: tok(personalUsd),
      dynamicTokens: tok(u.dynamicUsd),
      dailyTokens: tok(dailyUsd),
      dailyUsd,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, tick]);
}

// =====================================================================================================
function Header({ cfg, account, onConnect, snap }: { cfg: AppConfig; account: string; onConnect: () => void; snap: Snapshot | null }) {
  void snap;
  return (
    <header className="hdr">
      <div className="brand">
        <img src={A("xyy-coin.webp")} alt="" className="brand-ic" />
        <span>喜羊羊矿场</span>
      </div>
      <div className="hdr-r">
        <span className="chip-bsc">
          <i className="chip-ic"><img src={A("bnb.webp")} alt="" /></i>
          <b>{cfg.chainId === 56 ? "BSC" : `链 ${cfg.chainId}`}</b>
        </span>
        <button className="wallet-btn" onClick={onConnect}>
          {account ? short(account) : "连接钱包"}
        </button>
      </div>
    </header>
  );
}

function Loading() {
  return (
    <div className="card center muted">
      <div className="spinner" />
      正在读取链上数据…
    </div>
  );
}

function StatusLine({ snap, account, force }: { snap: Snapshot; account?: string; force?: boolean }) {
  // 暂停提示只给管理员/运营钱包看；普通用户的页面不显示
  const me = (account || "").toLowerCase();
  if (!force && (!me || ![snap.owner, snap.operator].some((x) => !!x && x.toLowerCase() === me))) return null;
  if (!snap.configured) return <div className="status bad">数据不可用 · {snap.problem}</div>;
  if (snap.running) return null; // 正常运行时不显示提示栏，只在暂停时提醒
  const rs = REASON_TEXT.filter(([b]) => snap.reasons & b).map(([, t]) => t);
  return (
    <div className="status bad">
      <i className="dot" />
      已暂停新增入金与计息：{rs.join("；") || "等待首次检查"}。本金退出不受影响，已累计奖励保留。
    </div>
  );
}

function Hero({ title, sub, img, tag }: { title: React.ReactNode; sub?: string; img: string; tag?: string }) {
  return (
    <section className={"hero" + (img ? " plain" : "")}>
      {!img && <img src={A("banner.webp")} alt="" className="hero-bg" />}
      <div className="hero-txt">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
        {tag && <span className="hero-tag">{tag}</span>}
      </div>
      {img && <img className="hero-mascot" src={img} alt="" />}
    </section>
  );
}

// =====================================================================================================
function MinePage(props: {
  cfg: AppConfig;
  snap: Snapshot;
  live: Live | null;
  account: string;
  canTx: boolean;
  onConnect: () => void;
  open: (s: SheetKind) => void;
  goRefer: () => void;
}) {
  const { cfg, snap, live, account, canTx, open } = props;
  const u = snap.user;
  const isOperator = !!account && !!snap.operator && account.toLowerCase() === snap.operator.toLowerCase();
  return (
    <>
      <Hero
        title={
          <>
            添加流动性
            <br />
            收获喜羊羊
          </>
        }
        img=""
        tag="每日 0.5%～1% · 随存随取"
      />
      <StatusLine snap={snap} account={account} />
      {account && <OldPoolCard snap={snap} open={() => open("old")} />}

      {!account ? (
        <div className="card center">
          <img src={A("sheep-thumb.webp")} alt="" className="empty-img" />
          <p className="muted">连接钱包后查看您的流动性与收益</p>
          <button className="btn-gold" onClick={props.onConnect}>连接钱包</button>
        </div>
      ) : (
        <>
          <section className="card reward">
            <div className="reward-top">
              <img src={A("xyy-coin.webp")} alt="喜羊羊" className="coin-lg" />
              <div className="grow">
                <div className="lbl-light">待领取喜羊羊（预计）</div>
                {(() => {
                  const t = live?.pendingTokens != null ? fmtUnits(live.pendingTokens, snap.rewardDecimals) : snap.rewardPrice ? "0.00" : "报价不可用";
                  return <div className={"big" + (t.length > 10 ? " long" : "")}>{t}</div>;
                })()}
              </div>
              <img src={A("chest.webp")} alt="" className="reward-gift" />
            </div>
            <div className="split">
              <div>
                <span>个人收益</span>
                <b>{live?.personalTokens != null ? fmtUnits(live.personalTokens, snap.rewardDecimals) : "—"}</b>
              </div>
              <div>
                <span>动态收益</span>
                <b>{live?.dynamicTokens != null ? fmtUnits(live.dynamicTokens, snap.rewardDecimals) : "—"}</b>
              </div>
            </div>
            <div className="usd-note">
              按当前喜羊羊参考价换算
            </div>
            <button className="btn-gold wide" disabled={!canTx || !u || isOperator || snap.params.claimPaused || (live?.personalUsd ?? 0n) + (live?.dynamicUsd ?? 0n) === 0n} onClick={() => open("claim")}>
              {isOperator ? "运营钱包无需领取" : snap.params.claimPaused ? "领取暂时关闭" : "领取喜羊羊"}
            </button>
            {isOperator && <p className="fine-light">奖励本来就是从运营钱包发出的，运营钱包给自己领取等于自己转给自己，合约不支持，也不会有任何损失。</p>}
            {snap.params.claimPaused && <p className="fine-light">管理员已暂停领取，收益照常累计，恢复后可领取</p>}
            <p className="fine-light">预计数量随价格变化，以领取时结算为准</p>
          </section>

          <section className="card">
            <div className="row-h">
              <IconLayers />
              <span>我的流动性（参考价值）</span>
            </div>
            <div className={"val" + (fmtUnits(u?.valueUsd ?? 0n, 18).length > 12 ? " long" : "")}>
              {fmtUnits(u?.valueUsd ?? 0n, 18)} <small>USDT</small>
            </div>
            <div className="assets">
              <span>
                <img src={A("pop-coin.webp")} alt="POP" /> {fmtUnits(u?.popAmt ?? 0n, snap.popDecimals)} POP
              </span>
              <span>
                <i className="usdt-ic">U</i> {fmtUnits(u?.usdtAmt ?? 0n, snap.usdtDecimals)} USDT
              </span>
            </div>
            <div className="prin-row">
              <span>入金额度</span>
              <b>{fmtUnits(u?.principalUsd ?? 0n, 18)} USDT</b>
            </div>
            <div className="btn-row">
              <button className="btn-green" disabled={!canTx} onClick={() => open("add")}>
                ⊕ 添加流动性
              </button>
              <button className="btn-line" disabled={!canTx || !u || u.liquidity === 0n} onClick={() => open("exit")}>
                ⊖ 撤回流动性
              </button>
            </div>
          </section>

          <div className="grid2">
            <section className="card mini">
              <div className="mini-l">预计每日个人收益</div>
              <div className="mini-v">
                {live?.dailyTokens != null ? fmtUnits(live.dailyTokens, snap.rewardDecimals) : "—"} <small>喜羊羊</small>
              </div>
              <div className="fine">≈ {fmtUnits(live?.dailyUsd ?? 0n, 18, 3)} USDT 计价</div>
            </section>
            <section className="card mini">
              <div className="mini-l">累计已领取</div>
              <div className="mini-v">
                {fmtUnits((u?.claimedPersonal ?? 0n) + (u?.claimedDynamic ?? 0n), snap.rewardDecimals)} <small>喜羊羊</small>
              </div>
              <div className="fine">
                个人 {fmtUnits(u?.claimedPersonal ?? 0n, snap.rewardDecimals, 0)} / 动态 {fmtUnits(u?.claimedDynamic ?? 0n, snap.rewardDecimals, 0)}（实际到账）
              </div>
            </section>
          </div>

          <section className="card tap" onClick={props.goRefer}>
            <div className="row-sb">
              <div>
                <div className="row-h">
                  <IconUsers />
                  <span>推荐概览</span>
                </div>
                <div className="fine">
                  直推 {u?.direct ?? 0} · 间推 {u?.indirect ?? 0} · 合计 {(u?.direct ?? 0) + (u?.indirect ?? 0)}
                </div>
              </div>
              <span className={"pill " + (u?.eligible ? "ok" : "no")}>{u?.eligible ? "动态资格有效" : !u || u.liquidity === 0n ? "动态资格未生效" : `未达${usd0(SHOW_THR)} USDT门槛`}</span>
            </div>
          </section>
        </>
      )}
    </>
  );
}

// =====================================================================================================
function ReferPage({ cfg, snap, live, account, backend, onConnect, toast }: { cfg: AppConfig; snap: Snapshot; live: Live | null; account: string; backend: Backend; onConnect: () => void; toast: (s: string) => void }) {
  const [tab, setTab] = useState<"direct" | "indirect">("direct");
  const [list, setList] = useState<{ direct: Downline[]; indirect: Downline[] } | null>(null);
  const [err, setErr] = useState("");
  const [nextTo, setNextTo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const SPAN = 200_000;
  const none = (snap.user?.direct ?? 0) + (snap.user?.indirect ?? 0) === 0;
  const load = useCallback(
    async (to?: number) => {
      if (!account || !snap.configured) return;
      if (none) {
        setList({ direct: [], indirect: [] });
        setNextTo(null);
        setErr("");
        return;
      }
      setBusy(true);
      try {
        const top = to ?? (await backend.latestBlock());
        const r = await backend.downlines(account, top, SPAN);
        setList((p) => ({ direct: [...(to ? p?.direct ?? [] : []), ...r.direct], indirect: [...(to ? p?.indirect ?? [] : []), ...r.indirect] }));
        setNextTo(r.nextTo);
        setErr("");
      } catch (e) {
        setErr("load");
      } finally {
        setBusy(false);
      }
    },
    [account, backend, snap.configured, none],
  );
  useEffect(() => {
    load();
  }, [load]);
  const team = useTeam(backend, account);

  if (!account)
    return (
      <div className="card center">
        <img src={A("sheep-safe.webp")} alt="" className="empty-img" />
        <p className="muted">连接钱包后查看推荐信息</p>
        <button className="btn-gold" onClick={onConnect}>连接钱包</button>
      </div>
    );
  const u = snap.user;
  const base = cfg.appUrl || location.origin + location.pathname;
  const link = `${base}?ref=${account}`;
  // 动态资格以合约为准；页面上显示的门槛固定 100 USDT（「还差」也按 100 算）
  const thr = SHOW_THR;
  const T = usd0(thr);
  const meElig = !!u && u.eligible;
  const gap = u ? thr - u.principalUsd : thr;
  const dElig = (d: Downline) => d.eligible;
  const effective = list ? [...list.direct, ...list.indirect].filter(dElig).length : null;
  const rows = list ? (tab === "direct" ? list.direct : list.indirect) : [];
  return (
    <>
      <section className={"elig " + (meElig ? "ok" : "no")}>
        <div className="elig-ic">{meElig ? "✓" : "!"}</div>
        <div>
          <b>{meElig ? "动态资格已生效" : "动态资格未生效"}</b>
          <div>
            {meElig
              ? `入金 ≥ ${T} USDT 即可享受动态资格`
              : !u || u.liquidity === 0n
                ? u?.joined
                  ? `已撤回流动性，重新添加 ≥ ${T} USDT 即可恢复`
                  : `添加 ≥ ${T} USDT 流动性即可享受动态资格`
                : `距 ${T} USDT 还差 ${fmtUnits(gap > 0n ? gap : 0n, 18)} USDT`}
          </div>
        </div>
      </section>

      <section className="card invite">
        <div className="invite-txt">
          <b>邀请好友加入喜羊羊矿场</b>
          <p className="fine">分享链接，好友打开后绑定你为推荐人，之后可产生动态收益。</p>
        </div>
        <img src={A("sheep-safe.webp")} alt="" className="invite-img" />
        <div className="link-row">
          <span className="link-txt">{link}</span>
          <button
            className="btn-green sm"
            onClick={() => {
              navigator.clipboard?.writeText(link).then(
                () => toast("已复制推荐链接"),
                () => toast("复制失败，请长按链接手动复制"),
              );
            }}
          >
            复制链接
          </button>
        </div>
      </section>

      <section className="card counts">
        <div>
          <span>直推</span>
          <b>{u?.direct ?? 0}</b>
        </div>
        <div>
          <span>间推</span>
          <b>{u?.indirect ?? 0}</b>
        </div>
        <div>
          <span>团队总人数</span>
          <b>{team ? team.team : "—"}</b>
        </div>
        <div>
          <span>当前有效</span>
          <b>{effective ?? "—"}</b>
        </div>
      </section>
      <p className="fine pad">人数只算添加过流动性的钱包，重复添加不重复计数；团队总人数包括你下面所有层级，不含你自己。有效 = 入金 ≥ {T} USDT。</p>
      <TeamCard snap={snap} team={team} />

      <section className="card reward dyn">
        <div className="reward-top">
          <img src={A("xyy-coin.webp")} alt="" className="coin-lg" />
          <div className="grow">
            <div className="lbl-light">待领取动态收益（预计）</div>
            <div className="big">
              {live?.dynamicTokens != null ? fmtUnits(live.dynamicTokens, snap.rewardDecimals) : "—"} <small>喜羊羊</small>
            </div>
          </div>
          <img src={A("coins-pair.webp")} alt="" className="reward-gift" />
        </div>
        <div className="fine-light">累计实际领取动态：{fmtUnits(u?.claimedDynamic ?? 0n, snap.rewardDecimals)} 喜羊羊</div>
      </section>

      <div className="seg">
        <button className={tab === "direct" ? "on" : ""} onClick={() => setTab("direct")}>
          直推
        </button>
        <button className={tab === "indirect" ? "on" : ""} onClick={() => setTab("indirect")}>
          间推
        </button>
      </div>
      <section className="card list">
        {err && !list && (
          <div className="center muted">
            名单暂时没有加载出来 <button className="btn-mini" disabled={busy} onClick={() => load()}>重新加载</button>
          </div>
        )}
        {!list && !err && <div className="center muted">加载中…</div>}
        {list && rows.length === 0 && <div className="center muted">{tab === "direct" ? "还没有直推的好友" : "还没有间推的好友"}</div>}
        {rows.map((d) => (
          <div className="li" key={d.address}>
            <div className="av">
              <IconUser />
            </div>
            <div className="grow">
              <b className="mono">{short(d.address)}</b>
              <div className="fine">
                首次入金 {fmtTime(d.firstDepositAt)} · LP {fmtUnits(d.valueUsd, 18)} USDT
              </div>
            </div>
            <span className={"pill " + (dElig(d) ? "ok" : "no")}>{dElig(d) ? "有效" : "未达门槛"}</span>
          </div>
        ))}
        {nextTo !== null && (
          <button className="btn-line wide" disabled={busy} onClick={() => load(nextTo)}>
            {busy ? "加载中…" : "加载更早的记录"}
          </button>
        )}
      </section>

      <section className="card rules-mini">
        <b>顺延规则</b>
        <p className="fine">
          沿推荐链向上，第一个满足资格（入金 ≥ {T} USDT）的上级获得 {pct(snap.params.tier1Bps)}，第二个获得 {pct(snap.params.tier2Bps)}；同一人不会同时占两个档位；找不到时该部分不分配，也不扣运营钱包。顺延不改变真实推荐关系和人数统计。向上最多查找 10 层。
        </p>
      </section>
    </>
  );
}

// =====================================================================================================
function RecordsPage({ cfg, account, backend, onConnect, initial }: { cfg: AppConfig; account: string; backend: Backend; onConnect: () => void; initial?: RecKind }) {
  const [kind, setKind] = useState<RecKind>(initial ?? "liquidity");
  const [items, setItems] = useState<Rec[] | null>(null);
  const [nextTo, setNextTo] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const SPAN = 50_000;
  const load = useCallback(
    async (to?: number) => {
      if (!account) return;
      setBusy(true);
      try {
        const top = to ?? (await backend.latestBlock());
        const r = await backend.records(account, kind, top, SPAN);
        setItems((p) => [...(to ? p ?? [] : []), ...r.items]);
        setNextTo(r.nextTo);
        setErr("");
      } catch (e) {
        setErr("load");
      } finally {
        setBusy(false);
      }
    },
    [account, backend, kind],
  );
  useEffect(() => {
    setItems(null);
    load();
  }, [load]);
  if (!account)
    return (
      <div className="card center">
        <p className="muted">连接钱包后查看记录</p>
        <button className="btn-gold" onClick={onConnect}>连接钱包</button>
      </div>
    );
  return (
    <>
      <Hero title="记录" sub="查看流动性、领取、动态奖励、锁仓及保险池记录（来自链上事件）" img={A("sheep-thumb.webp")} />
      <div className="seg four five rec-tabs">
        {(
          [
            ["liquidity", "流动性"],
            ["claim", "领取"],
            ["dynamic", "动态奖励"],
            ["lock", "锁仓"],
            ["ins", "保险池"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
            {l}
          </button>
        ))}
      </div>
      <section className="card list">
        {err && !items && (
          <div className="center muted">
            记录暂时没有加载出来 <button className="btn-mini" disabled={busy} onClick={() => load()}>重新加载</button>
          </div>
        )}
        {!items && !err && <div className="center muted">加载中…</div>}
        {items && items.length === 0 && <div className="center muted">暂无记录（仅显示最近区块范围，可加载更早）</div>}
        {items?.map((r, i) => (
          <div className="li rec" key={r.tx + i}>
            <div className={"rec-ic " + (r.sign === "-" ? "out" : "in")}>{r.kind === "claim" ? "🎁" : r.kind === "lock" && r.sign === "-" ? "🔒" : r.sign === "-" ? "−" : "+"}</div>
            <div className="grow">
              <b>{r.title}</b>
              {r.lines.map((l) => (
                <div className="fine" key={l.label}>
                  {l.label}：{l.value}
                </div>
              ))}
              <div className="fine">{fmtTime(r.time)}</div>
            </div>
            <div className="rec-r">
              <span className="pill ok">{r.status}</span>
              {!r.tx.startsWith("0xdemo") && (
                <a href={`${cfg.explorer}/tx/${r.tx}`} target="_blank" rel="noreferrer" className="ext" aria-label="交易详情">
                  ↗
                </a>
              )}
            </div>
          </div>
        ))}
        {nextTo !== null && items && (
          <button className="btn-line wide" disabled={busy} onClick={() => load(nextTo)}>
            {busy ? "加载中…" : "加载更早的记录"}
          </button>
        )}
      </section>
    </>
  );
}

// =====================================================================================================
function Sheet({ title, close, children, icon }: { title: string; close: () => void; children: React.ReactNode; icon?: React.ReactNode }) {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);
  return (
    <div className="sheet-mask" onClick={close}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="grab" />
        <div className="sheet-h">
          {icon}
          <b>{title}</b>
          <button className="x" onClick={close} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  const txt: Record<string, string> = { idle: "待处理", wallet: "请在钱包中确认", pending: "链上确认中", done: "完成", error: "失败", skipped: "无需操作" };
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li key={i} className={s.status}>
          <span className="n">{s.status === "done" || s.status === "skipped" ? "✓" : i + 1}</span>
          <div className="grow">
            <b>{s.label}</b>
            <div className="fine">
              {txt[s.status]}
              {s.error ? ` · ${s.error}` : ""}
            </div>
          </div>
          {(s.status === "wallet" || s.status === "pending") && <span className="spinner sm" />}
        </li>
      ))}
    </ol>
  );
}

function AddSheet({ cfg, snap, backend, refParam, account, canTx, close, done }: { cfg: AppConfig; snap: Snapshot; backend: Backend; refParam: string; account: string; canTx: boolean; close: () => void; done: () => void }) {
  // 仅 USDT：合约把约一半换成 POP；USDT + POP：自带两种币，按池子价格自动配比
  const [mode, setMode] = useState<"usdt" | "both">("usdt");
  const [usdtIn, setUsdtIn] = useState("");
  const [popIn, setPopIn] = useState("");
  const [pairing, setPairing] = useState(false);
  const pairSeq = useRef(0);
  const [q, setQ] = useState<AddQuote | null>(null);
  const [qErr, setQErr] = useState("");
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [running, setRunning] = useState(false);
  const [okRef, setOkRef] = useState(false);
  const [now, setNow] = useState(Date.now());
  const u = snap.user;
  const firstTime = !u?.joined;
  const selfRef = refParam && refParam.toLowerCase() === account.toLowerCase();
  const useRef_ = firstTime && !u?.referrer && refParam && !selfRef ? refParam : "";
  // a referrer must have deposited before; otherwise the contract would refuse the deposit
  const [refJoined, setRefJoined] = useState<boolean | null>(null);
  useEffect(() => {
    setRefJoined(null);
    if (!useRef_) return;
    backend.isJoined(useRef_).then(setRefJoined, () => setRefJoined(null));
  }, [useRef_, backend]);
  const refInvalid = !!useRef_ && refJoined === false;
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const usdtAmt = parseUnitsSafe(usdtIn, snap.usdtDecimals);
  const popAmt = mode === "both" ? parseUnitsSafe(popIn, snap.popDecimals) : 0n;
  const overU = usdtAmt !== null && snap.balances && usdtAmt > snap.balances.usdt;

  const overP = mode === "both" && popAmt !== null && snap.balances && popAmt > snap.balances.pop;
  const plain = (v: bigint, d: number) => fmtUnits(v, d, 6).replace(/,/g, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  // 改一边，另一边按池子当前价格自动算出来
  const fillOther = (from: "usdt" | "pop", text: string) => {
    if (from === "usdt") setUsdtIn(text);
    else setPopIn(text);
    if (mode !== "both") return;
    const amt = parseUnitsSafe(text, from === "usdt" ? snap.usdtDecimals : snap.popDecimals);
    const seq = ++pairSeq.current;
    if (!amt || amt === 0n) {
      if (from === "usdt") setPopIn("");
      else setUsdtIn("");
      return;
    }
    setPairing(true);
    backend
      .pairAmount(from, amt)
      .then((o) => {
        if (seq !== pairSeq.current) return;
        if (from === "usdt") setPopIn(plain(o, snap.popDecimals));
        else setUsdtIn(plain(o, snap.usdtDecimals));
      })
      .catch(() => {})
      .finally(() => seq === pairSeq.current && setPairing(false));
  };
  const switchMode = (m: "usdt" | "both") => {
    setMode(m);
    setPopIn("");
    pairSeq.current++;
    setPairing(false);
    if (m === "both" && usdtAmt && usdtAmt > 0n) {
      const seq = pairSeq.current;
      setPairing(true);
      backend
        .pairAmount("usdt", usdtAmt)
        .then((o) => seq === pairSeq.current && setPopIn(plain(o, snap.popDecimals)))
        .catch(() => {})
        .finally(() => seq === pairSeq.current && setPairing(false));
    }
  };
  const timer = useRef<any>(null);
  useEffect(() => {
    setQ(null);
    setQErr("");
    if (!usdtAmt || usdtAmt === 0n || popAmt === null || (mode === "both" && (popAmt === 0n || pairing))) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      backend
        .quoteAdd(mode, usdtAmt, popAmt, addSlip(mode))
        .then(setQ)
        .catch((e) => setQErr("报价失败：" + humanError(e)));
    }, 400);
  }, [usdtIn, popIn, mode, pairing]); // eslint-disable-line react-hooks/exhaustive-deps
  const expired = q ? now - q.createdAt > QUOTE_TTL : false;
  const needConfirmRef = !!useRef_ && !okRef;
  const [waitNote, setWaitNote] = useState(false);
  const go = async () => {
    if (!q) return;
    // the contract is not taking new liquidity this moment (e.g. refreshing prices): say so before any approval is signed
    if (!snap.running) {
      setWaitNote(true);
      return;
    }
    setWaitNote(false);
    const fresh: Step[] = [
      { label: "授权 USDT（按本次金额）", status: "idle" },
      ...(q.popAmount > 0n ? [{ label: "授权 POP（按本次金额）", status: "idle" as const }] : []),
      { label: "添加流动性并由合约托管仓位", status: "idle" },
    ];
    // resume after a rejected/failed step: keep completed approvals, retry from the failed step
    const s = steps?.some((x) => x.status === "error") ? steps.map((x) => (x.status === "error" ? { ...x, status: "idle" as const, error: undefined } : x)) : fresh;
    setSteps(s);
    setRunning(true);
    try {
      const ok = await backend.deposit(q, useRef_, s, setSteps);
      if (ok) done();
    } catch (e) {
      setSteps((p) => (p ? p.map((x) => (x.status === "idle" || x.status === "wallet" ? { ...x, status: "error", error: humanError(e) } : x)) : p));
    } finally {
      setRunning(false);
    }
  };
  const allDone = steps?.every((x) => x.status === "done" || x.status === "skipped");
  void cfg;
  return (
    <Sheet title="添加流动性" close={close} icon={<span className="ic-c">⊕</span>}>
      <div className="seg">
        <button className={mode === "usdt" ? "on" : ""} onClick={() => switchMode("usdt")} disabled={running}>
          仅 USDT
        </button>
        <button className={mode === "both" ? "on" : ""} onClick={() => switchMode("both")} disabled={running}>
          USDT + POP
        </button>
      </div>
      <label className="inp">
        <span>
          USDT 数量 <em>余额 {fmtUnits(snap.balances?.usdt ?? null, snap.usdtDecimals)}</em>
        </span>
        <div className="inp-row">
          <input inputMode="decimal" placeholder="0.00" value={usdtIn} onChange={(e) => fillOther("usdt", e.target.value)} disabled={running} />
          <button className="btn-mini" onClick={() => { if (!snap.balances) return; fillOther("usdt", plain(snap.balances.usdt, snap.usdtDecimals)); }}>
            全部
          </button>
        </div>
        {overU && <em className="err">USDT 余额不足</em>}
      </label>
      {mode === "both" && (
        <label className="inp">
          <span>
            POP 数量 <em>余额 {fmtUnits(snap.balances?.pop ?? null, snap.popDecimals)}</em>
          </span>
          <div className="inp-row">
            <input inputMode="decimal" placeholder="0.00" value={popIn} onChange={(e) => fillOther("pop", e.target.value)} disabled={running} />
            <button className="btn-mini" onClick={() => { if (!snap.balances) return; fillOther("pop", plain(snap.balances.pop, snap.popDecimals)); }}>
              全部
            </button>
          </div>
          {overP ? (
            <em className="err">POP 余额不足，可以减少 USDT 数量</em>
          ) : usdtAmt && popAmt && !pairing ? (
            <em className="ok-txt">已按当前池子价格自动配好对应数量</em>
          ) : null}
        </label>
      )}
      {qErr && <div className="alert">{qErr}</div>}
      {q && (
        <div className="quote">
          {q.mode === "usdt" && (
            <div className="qr-row">
              <span>其中兑换为 POP</span>
              <b>
                {fmtUnits(q.swapUsdt, snap.usdtDecimals)} USDT → ≈{fmtUnits(q.expectedPopFromSwap, snap.popDecimals)} POP
              </b>
            </div>
          )}
          <div className="qr-row">
            <span>预计使用</span>
            <b>
              {fmtUnits(q.usdtUsed, snap.usdtDecimals)} USDT + {fmtUnits(q.popUsed, snap.popDecimals)} POP
            </b>
          </div>
          <div className="qr-row">
            <span>预计退回余量</span>
            <b>
              {fmtUnits(q.usdtRefund, snap.usdtDecimals)} USDT / {fmtUnits(q.popRefund, snap.popDecimals)} POP
            </b>
          </div>
          <div className="qr-row">
            <span>预计LP参考价值</span>
            <b>≈ {fmtUnits(q.estValueUsd, 18)} USDT</b>
          </div>
          <p className="fine">
            {mode === "usdt"
              ? "只需要 USDT：合约会自动把大约一半换成 POP，再一起加入池子。"
              : "输入任意一边，另一边会按池子当前价格自动算好，两种币一起加入池子。"}
            全价格区间，无需设置区间；滑点保护 {addSlip(mode) / 100}%，报价有效期 10 分钟。实际以链上成交为准，没用完的代币会原路退回。
            {expired && <b className="err"> 报价已过期，请刷新。</b>}
          </p>
        </div>
      )}
      {firstTime && (
        <div className="refbox">
          {u?.referrer ? (
            <span>已绑定推荐人 {short(u.referrer)}</span>
          ) : refInvalid ? (
            <span className="fine">
              推荐人 <b className="mono">{short(useRef_)}</b> 还没有入过金，暂时不能绑定。请让推荐人先入一次金，再用他的推荐链接打开；也可以直接打开网站首页入金，但之后就不能再绑定推荐人了。
            </span>
          ) : useRef_ ? (
            <label className="chk">
              <input type="checkbox" checked={okRef} onChange={(e) => setOkRef(e.target.checked)} />
              <span>
                确认绑定推荐人 <b className="mono">{short(useRef_)}</b>（首次入金时绑定，之后不可修改）
              </span>
            </label>
          ) : (
            <span className="fine">
              {selfRef ? "不能绑定自己为推荐人。" : ""}未检测到推荐链接，本次将不绑定推荐人（之后无法补绑）。
            </span>
          )}
        </div>
      )}
      {waitNote && !snap.running && <p className="fine wait-note">请稍后再试</p>}
      {steps && <Steps steps={steps} />}
      {allDone ? (
        <button className="btn-green wide" onClick={close}>完成</button>
      ) : expired ? (
        <button className="btn-gold wide" onClick={() => backend.quoteAdd(mode, usdtAmt!, popAmt!, addSlip(mode)).then(setQ)}>刷新报价</button>
      ) : (
        <button className="btn-green wide" disabled={!canTx || !q || running || !!overU || !!overP || pairing || needConfirmRef || refInvalid} onClick={go}>
          {running ? "处理中…" : refInvalid ? "推荐人还没有入金" : steps?.some((x) => x.status === "error") ? "重试" : "授权并添加"}
        </button>
      )}
    </Sheet>
  );
}

function ExitSheet({ snap, backend, account, canTx, close, done }: { snap: Snapshot; backend: Backend; account: string; canTx: boolean; close: () => void; done: () => void }) {
  const u = snap.user!;
  const [pct, setPct] = useState(5000);
  const [q, setQ] = useState<ExitQuote | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    setQ(null);
    backend
      .quoteExit(account, pct, SLIP_BPS, u.liquidity, u.valueUsd, u.principalUsd, snap.params.thresholdUsd)
      .then(setQ)
      .catch((e) => setErr("报价失败：" + humanError(e)));
  }, [pct]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = async () => {
    if (!q) return;
    const s: Step[] = [{ label: "解除流动性，返还 POP + USDT 及手续费", status: "idle" }];
    setSteps(s);
    setRunning(true);
    try {
      if (await backend.withdraw(q, s, setSteps)) done();
    } catch (e) {
      setSteps([{ ...s[0], status: "error", error: humanError(e) }]);
    } finally {
      setRunning(false);
    }
  };
  const allDone = steps?.every((x) => x.status === "done");
  return (
    <Sheet title="撤回流动性" close={close} icon={<span className="ic-c">⊖</span>}>
      <div className="pct-big">{pct >= 10000 ? "全部" : `${pct / 100}%`}</div>
      <div className="pct-row">
        {[2500, 5000, 7500, 10000].map((p) => (
          <button key={p} className={pct === p ? "on" : ""} onClick={() => setPct(p)} disabled={running}>
            {p === 10000 ? "全部" : `${p / 100}%`}
          </button>
        ))}
      </div>
      <input type="range" min={100} max={10000} step={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} disabled={running} className="range" aria-label="退出比例" />
      {err && <div className="alert">{err}</div>}
      <div className="quote">
        <b className="q-title">预计返还</b>
        <div className="qr-row">
          <span>
            <img src={A("pop-coin.webp")} alt="" className="tok" /> POP
          </span>
          <b>{q ? fmtUnits(q.pop, snap.popDecimals) : "…"}</b>
        </div>
        <div className="qr-row">
          <span>
            <i className="usdt-ic">U</i> USDT
          </span>
          <b>{q ? fmtUnits(q.usdt, snap.usdtDecimals) : "…"}</b>
        </div>
        <p className="fine">另含该仓位累计的交易手续费（归您所有，退出时一并结算）。按当前池子价格估算，最少到账保护 {SLIP_BPS / 100}%。</p>
      </div>
      <div className="quote">
        <div className="qr-row">
          <span>剩余LP参考价值</span>
          <b>{q ? fmtUnits(q.remainingValueUsd, 18) : "…"} USDT</b>
        </div>
        <div className="qr-row">
          <span>动态资格</span>
          <b className={q?.eligibleAfter ? "ok-t" : "err"}>{q ? (q.eligibleAfter ? "保持有效" : u.eligible ? "将失效" : "未达门槛") : "…"}</b>
        </div>
      </div>
      <p className="fine">✓ 已累计的个人和动态奖励保留，可另行领取；退出不会强制领取喜羊羊。断开钱包不等于退出。</p>
      {steps && <Steps steps={steps} />}
      {allDone ? (
        <button className="btn-green wide" onClick={close}>完成</button>
      ) : (
        <button className="btn-green wide" disabled={!canTx || !q || running || q.liquidity === 0n} onClick={go}>
          {running ? "处理中…" : steps?.some((x) => x.status === "error") ? "重试" : "确认撤回"}
        </button>
      )}
    </Sheet>
  );
}

function ClaimSheet({ snap, live, backend, canTx, close, done }: { snap: Snapshot; live: Live | null; backend: Backend; canTx: boolean; close: () => void; done: () => void }) {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [tip, setTip] = useState(false);
  const [running, setRunning] = useState(false);
  const est = live?.pendingTokens ?? null;
  const minOut = est ? applySlippage(est, SLIP_BPS) : null;
  const go = async () => {
    if (!minOut) return;
    const s: Step[] = [{ label: "领取喜羊羊", status: "idle" }];
    if (snap.rewardPriceEstimated) {
      // the contract's price is refreshing: nothing is sent; just a short hint
      setTip(true);
      return;
    }
    setTip(false);
    setSteps(s);
    setRunning(true);
    try {
      if (await backend.claim(minOut, s, setSteps)) done();
    } catch (e) {
      setSteps([{ ...s[0], status: "error", error: humanError(e) }]);
    } finally {
      setRunning(false);
    }
  };
  return (
    <Sheet title="领取喜羊羊" close={close} icon={<img src={A("xyy-coin.webp")} className="tok" alt="" />}>
      <div className="quote">
        <div className="qr-row">
          <span>个人收益</span>
          <b>{fmtUnits(live?.personalTokens ?? null, snap.rewardDecimals)}</b>
        </div>
        <div className="qr-row">
          <span>动态收益</span>
          <b>{fmtUnits(live?.dynamicTokens ?? null, snap.rewardDecimals)}</b>
        </div>
        <div className="qr-row">
          <span>预计到账</span>
          <b className="big-d">{fmtUnits(est, snap.rewardDecimals)} 喜羊羊</b>
        </div>
        <div className="qr-row">
          <span>最少到账（价格保护 {SLIP_BPS / 100}%）</span>
          <b>{fmtUnits(minOut, snap.rewardDecimals)}</b>
        </div>
        <p className="fine">按领取时链上时间加权参考价把 USDT 计价额度换算为喜羊羊；网络手续费（BNB）由您支付。失败时整笔回滚，奖励不会丢失。</p>
      </div>
      {tip && snap.rewardPriceEstimated && <p className="fine wait-note">请稍后再试</p>}
      {steps && <Steps steps={steps} />}
      {steps?.every((x) => x.status === "done") ? (
        <button className="btn-green wide" onClick={close}>完成</button>
      ) : (
        <button className="btn-gold wide" disabled={!canTx || !minOut || running} onClick={go}>
          {running ? "处理中…" : steps?.some((x) => x.status === "error") ? "重试" : "确认领取"}
        </button>
      )}
    </Sheet>
  );
}

function RulesSheet({ snap, close }: { snap: Snapshot | null; close: () => void }) {
  const pr = snap?.params ?? { rateBps: 100, personalBps: 8500, tier1Bps: 1000, tier2Bps: 500, thresholdUsd: 100n * E18 };
  return (
    <Sheet title="奖励规则" close={close}>
      <div className="rules">
        <p><b>奖励基数：</b>您的入金额度：添加流动性时按 POP/USDT {snap?.twapMinutes ?? 15} 分钟平均价折算成 USDT 记下，之后币价涨跌不影响；再次添加会累加，撤回时按撤回比例扣减，全部撤回为 0。</p>
        <p><b>每日总额度：</b>奖励基数的 {pct(pr.rateBps)}，按实际持有时间累计，不自动复利。其中本人 {pct(pr.personalBps)}，第一个有效上级 {pct(pr.tier1Bps)}，第二个有效上级 {pct(pr.tier2Bps)}（包含在每日总额度之内）。管理员调整参数只影响调整之后，已累计的收益不变。</p>
        <p><b>计价与领取：</b>奖励按 USDT 计价记账，领取时按喜羊羊「{snap?.twapMinutes ?? 15} 分钟平均价」和「现价」中较高的那个换算，由您手动领取并支付 BNB 网络费。页面数字每 3 秒更新一次预计值，不代表链上交易。</p>
        <p><b>自动检查：</b>系统每分钟自动检查，约每 25 分钟记录一次收益（需要暂停或恢复时立即更新）；超过 2 小时没有检查会自动停止计息，恢复后不补计。</p>
        <p><b>暂停：</b>运营钱包储备/授权不足、喜羊羊报价失效或管理员暂停时，停止新增入金和新增计息；已累计奖励保留；随时可以退出本金。</p>
        <p><b>动态资格：</b>入金额度 ≥ {usd0(SHOW_THR)} USDT（按添加时的价格计算，撤回时按比例扣减）。资格在下级每次结算时判定（下级操作或系统定期结算）；您自己退出导致失效时，从退出那一刻起停止获得动态奖励；恢复后不追溯。</p>
        <p><b>退出：</b>固定返还 POP + USDT 及该仓位手续费，不保证等于原入金金额。</p>
        <p><b>风险：</b>奖励来自运营钱包持有的喜羊羊，不是增发，也不保证一直足额兑付；价格波动会影响到手数量与本金价值。</p>
      </div>
    </Sheet>
  );
}

// =====================================================================================================
type AdminTab = "users" | "daily" | "refs" | "flows";

// status of the automatic check service, served by the same Cloudflare Worker as this page (/keeper.json)
type KeeperStatus = {
  ran: boolean; at: number | null; ok: boolean; accruing: boolean | null; keeper: string | null; balance: string | null;
  lowBalance: boolean | null; daysLeft: number | null; users: number; toSettle: number; settleHours: number | null;
  lastSettle: number | null; lastCheckpoint: number | null; errors: string[];
  legacy?: { miner: string; done: boolean; started: boolean; left: number } | null; // final referral settlement of the previous contract
};
function KeeperCard({ cfg }: { cfg: AppConfig }) {
  const [k, setK] = useState<KeeperStatus | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("./keeper.json", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => alive && setK(j && typeof j.ran === "boolean" ? j : null))
        .catch(() => alive && setK(null));
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!k) return null; // page not served by the Worker (e.g. opened as a local file)
  const now = Date.now() / 1000;
  const fresh = !!k.at && now - k.at < 30 * 60;
  const bnb = k.balance !== null ? Number(BigInt(k.balance) / 10n ** 12n) / 1e6 : null;
  const state = !k.ran ? ["wait", "还没开始运行（1 分钟左右）"] : k.lowBalance ? ["warn", "等待充值手续费"] : k.ok && fresh ? ["ok", "正常运行，每分钟自动检查"] : ["warn", fresh ? "有问题，见下方" : "超过 30 分钟没有运行"];
  return (
    <section className="card kv">
      <b>自动检查服务</b>
      <div><span>状态</span><b className={state[0] === "ok" ? "ok-txt" : ""}>{state[1]}</b></div>
      {k.keeper && (
        <div>
          <span>检查钱包（付手续费用）</span>
          <b className="mono">
            {short(k.keeper)}{" "}
            <button className="btn-mini" onClick={() => navigator.clipboard?.writeText(k.keeper!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
              {copied ? "已复制" : "复制"}
            </button>
          </b>
        </div>
      )}
      {bnb !== null && <div><span>检查钱包余额</span><b>{bnb.toFixed(4)} BNB{k.daysLeft !== null ? `，约还能用 ${Math.floor(k.daysLeft)} 天` : ""}</b></div>}
      {k.at && <div><span>最近一次运行</span><b>{fmtTime(k.at)}</b></div>}
      <div><span>推荐奖励自动结算</span><b>{k.lastSettle ? `最近 ${fmtTime(k.lastSettle)}` : "还没有需要结算的"}{k.settleHours ? ` · 约每 ${Math.round(k.settleHours * 10) / 10} 小时` : ""}</b></div>
      {k.lowBalance && k.keeper && (
        <div className="alert warn">
          请用任意钱包往下面这个检查钱包地址转 <b className="nowrap">0.01 BNB</b>（BSC 链），转入后 1 分钟内自动开始工作。这个钱包只用来付检查的手续费，没有任何其他权限。
          <span className="addr-full mono">{k.keeper}</span>
        </div>
      )}
      {!k.lowBalance && k.errors.length > 0 && <div className="alert warn">{k.errors.join("；")}</div>}
      <p className="fine">自动检查服务会定时更新价格、在储备不足时暂停、补足后恢复，并给推荐人结算奖励，不需要手动操作。<a href={`${cfg.explorer}/address/${k.keeper ?? ""}`} target="_blank" rel="noreferrer">在区块浏览器查看 ↗</a></p>
    </section>
  );
}

type AdmTab = "mine" | "lock" | "ins";
const ADM_TAB_NAME: Record<AdmTab, string> = { mine: "挖矿", lock: "锁仓", ins: "保险池" };

function AdminPage({ cfg, snap, backend, demo, isAdmin, isInsAdmin, initialTab, adminAccount, refresh }: { cfg: AppConfig; snap: Snapshot; backend: Backend; demo: boolean; isAdmin: boolean; isInsAdmin: boolean; initialTab: AdmTab; adminAccount: string; refresh: () => void }) {
  // 三个后台分开：挖矿、锁仓给矿场管理员；保险池给保险池主管理员 / 副管理员（演示里三块都能看）
  const tabs: AdmTab[] = demo ? ["mine", "lock", "ins"] : [...(isAdmin ? (["mine", "lock"] as AdmTab[]) : []), ...(isInsAdmin ? (["ins"] as AdmTab[]) : [])];
  const [tab, setTab] = useState<AdmTab>(tabs.includes(initialTab) ? initialTab : tabs[0] ?? "mine");
  const can = isAdmin || demo;
  const pr = snap.params;
  const [amt, setAmt] = useState("");
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [log, setLog] = useState<{ text: string; time: number; tx: string }[] | null>(null);
  // reward params (percent strings)
  const [rate, setRate] = useState(String(pr.rateBps / 100));
  const [pP, setPP] = useState(String(pr.personalBps / 100));
  const [p1, setP1] = useState(String(pr.tier1Bps / 100));
  const [p2, setP2] = useState(String(pr.tier2Bps / 100));
  const [thr, setThr] = useState(fmtUnits(pr.thresholdUsd, 18, 0).replace(/,/g, ""));
  // safety params
  const [dev, setDev] = useState(String(pr.maxTickDeviation / 100));
  const [mpl, setMpl] = useState(pr.minPoolLiquidity.toString());
  const [mrl, setMrl] = useState(pr.minRewardPoolLiquidity.toString());
  const [run, setRun] = useState(String(snap.runwayDays || 3));
  const [endText, setEndText] = useState("");
  useEffect(() => {
    backend
      .latestBlock()
      .then((b) => backend.adminLog(b, 200_000))
      .then(setLog)
      .catch(() => setLog([]));
  }, [backend]);
  const r = snap.reserve;
  const p = snap.rewardPrice;
  const needTokens = r && p ? usdToToken(r.liabilityUsd, p, snap.rewardDecimals) : null;
  const usableUsd = r && p ? (r.usable * p) / 10n ** BigInt(snap.rewardDecimals) : null;
  const daily = snap.totalPrincipalUsd !== null ? (snap.totalPrincipalUsd * BigInt(pr.rateBps)) / 10000n : null; // 按全部入金额度
  // the contract's own rule: usable reserve >= unpaid + runwayDays x max(daily emission, emission of 100 USDT)
  const minDaily = (100n * E18 * BigInt(pr.rateBps)) / 10000n;
  const effDaily = daily !== null && daily > minDaily ? daily : minDaily;
  const requiredUsd = r ? r.liabilityUsd + BigInt(snap.runwayDays || 0) * effDaily : null;
  const requiredTokens = requiredUsd !== null && p ? usdToToken(requiredUsd, p, snap.rewardDecimals) : null;
  const shortTokens = requiredTokens !== null && r && r.usable < requiredTokens ? requiredTokens - r.usable : null;
  const days =
    usableUsd !== null && requiredUsd !== null && effDaily > 0n && usableUsd >= requiredUsd
      ? Number(((usableUsd - requiredUsd) * 100n) / effDaily) / 100
      : null;
  const act = async (a: string, label: string, arg: any = 0n) => {
    const st: Step[] = [{ label, status: "idle" }];
    setSteps(st);
    try {
      if (await backend.admin(a as any, arg, st, setSteps)) refresh();
    } catch (e) {
      setSteps([{ ...st[0], status: "error", error: humanError(e) }]);
    }
  };
  const approveAmt = parseUnitsSafe(amt, snap.rewardDecimals);
  const toBps = (x: string) => Math.round(Number(x) * 100);
  const rb = toBps(rate), pb = toBps(pP), b1 = toBps(p1), b2 = toBps(p2);
  const thrUsd = parseUnitsSafe(thr, 18);
  const rewardErr =
    !(rb >= 1 && rb <= 300) ? "每日收益率需在 0.01% ~ 3% 之间" :
    [pb, b1, b2].some((x) => !Number.isFinite(x) || x < 0) ? "比例不能为负" :
    pb + b1 + b2 !== 10000 ? `三项比例加起来必须等于 100%（现在是 ${(pb + b1 + b2) / 100}%）` :
    !thrUsd || thrUsd < E18 || thrUsd > 1_000_000n * E18 ? "门槛需在 1 ~ 1,000,000 USDT 之间" : "";
  const devBps = toBps(dev);
  const runN = Number(run);
  const safetyErr =
    !(devBps >= 1 && devBps <= 2000) ? "入金价格偏离需在 0.01% ~ 20% 之间" :
    !/^\d+$/.test(mpl) || !/^\d+$/.test(mrl) ? "最低流动性请填整数" :
    !(runN >= 1 && runN <= 30 && Number.isInteger(runN)) ? "储备覆盖天数需在 1 ~ 30 之间" : "";
  return (
    <>
      <section className="card">
        <b className="h2">管理后台</b>
        {tabs.length > 1 && (
          <div className="seg three adm-tabs">
            {tabs.map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {ADM_TAB_NAME[t]}
              </button>
            ))}
          </div>
        )}
        {tab === "mine" && !isAdmin && <div className="alert warn">{demo ? "演示：仅供查看，操作为模拟。" : "当前钱包不是管理员，链上也会拒绝操作。"}</div>}
        {tab === "mine" && <p className="fine">所有权限由合约校验。管理员不能提走本金、仓位NFT或手续费，也不能修改已累计的收益；调整参数只影响调整之后，暂停不影响用户退出。</p>}
        {tab === "lock" && <p className="fine">锁仓合约的后台，和挖矿、保险池分开管理。</p>}
        {tab === "ins" && <p className="fine">保险池的后台，只有保险池主管理员和副管理员能进，和挖矿、锁仓分开管理。</p>}
      </section>
      {tab === "ins" && <InsAdminCard snap={snap} backend={backend} account={adminAccount} demo={demo} />}
      {tab === "lock" && <LockAdminCard snap={snap} backend={backend} account={adminAccount} demo={demo} explorer={cfg.explorer} />}
      {tab === "mine" && (
      <>
      <section className="card kv">
        <div><span>运营钱包</span><b className="mono">{short(snap.operator)}</b></div>
        <div><span>喜羊羊余额</span><b>{fmtUnits(r?.balance ?? null, snap.rewardDecimals)}</b></div>
        <div><span>剩余授权额度</span><b>{fmtUnits(r?.allowance ?? null, snap.rewardDecimals)}</b></div>
        <div><span>可用支付额度</span><b>{fmtUnits(r?.usable ?? null, snap.rewardDecimals)}</b></div>
        <div><span>已累计待支付（上限估算）</span><b>{fmtUnits(r?.liabilityUsd ?? null, 18)} USDT ≈ {fmtUnits(needTokens, snap.rewardDecimals)} 喜羊羊</b></div>
        <div><span>合约要求至少可用</span><b>{requiredTokens !== null ? `${fmtUnits(requiredTokens, snap.rewardDecimals, 0)} 喜羊羊` : "—"}</b></div>
        <div><span>估算还能支撑</span><b className={shortTokens ? "err" : ""}>{shortTokens ? "已不足，会自动暂停" : days !== null ? `约 ${days.toFixed(1)} 天` : "—"}</b></div>
        {shortTokens && (
          <div className="alert warn">
            可用支付额度（余额和授权额度里较小的那个）还差约 <b>{fmtUnits(shortTokens, snap.rewardDecimals, 0)} 喜羊羊</b>。请在下面“授权 / 补充授权”里填一个更大的数，并确保运营钱包里有这么多喜羊羊；建议多留一些，喜羊羊价格下跌时要求会变高。
          </div>
        )}
        <div><span>平台LP参考价值</span><b>{fmtUnits(snap.tvlUsd, 18)} USDT</b></div>
        <div><span>全部入金额度</span><b>{fmtUnits(snap.totalPrincipalUsd, 18)} USDT</b></div>
        <div><span>每日总发放（当前）</span><b>{fmtUnits(daily, 18)} USDT 计价</b></div>
        <div><span>参与钱包数</span><b>{snap.participants}</b></div>
        <div><span>累计实际发放</span><b>{fmtUnits(snap.totalPaidReward, snap.rewardDecimals)} 喜羊羊</b></div>
        <div><span>喜羊羊参考价（领取用）</span><b>{p ? `${fmtUnits(p, 18, 6)} USDT${snap.rewardPriceEstimated ? "（实时估算）" : ""}` : "不可用"}</b></div>
        <div><span>最近检查</span><b>{fmtTime(snap.lastCheckpoint)}</b></div>
        <div><span>运行状态</span><b className={snap.running ? "ok-t" : "err"}>{pr.ended ? "已永久结束" : snap.running ? "运行中" : "已暂停"}</b></div>
        <div><span>领取</span><b className={pr.claimPaused ? "err" : "ok-t"}>{pr.claimPaused ? "已暂停" : "开放"}</b></div>
      </section>
      <p className="fine pad">合约规定：可用支付额度要够“已累计待支付 + {snap.runwayDays || 3} 天的发放量”，不够就自动暂停，补足后自动恢复。人少时每天的发放量按至少 {usd0((100n * E18 * BigInt(pr.rateBps)) / 10000n)} USDT 计算。还能支撑的天数 = 超出要求的部分 ÷ 每天发放量；喜羊羊价格和平台规模变化都会改变这些数字。</p>
      <StatusLine snap={snap} force />

      <KeeperCard cfg={cfg} />

      <section className="card btn-col">
        <b>运行控制</b>
        {snap.adminPaused ? (
          <button className="btn-green wide" disabled={!can || pr.ended} onClick={() => act("resume", "恢复新增入金与计息")}>恢复新增入金与计息</button>
        ) : (
          <button className="btn-line wide danger" disabled={!can} onClick={() => act("pause", "暂停新增入金与计息")}>暂停新增入金与计息</button>
        )}
        <p className="fine">暂停期间不累计收益、恢复后不补发；恢复时合约会重新检查价格和储备，不满足则保持暂停。</p>
        {pr.claimPaused ? (
          <button className="btn-green wide" disabled={!can} onClick={() => act("claimResume", "恢复领取")}>恢复领取</button>
        ) : (
          <button className="btn-line wide danger" disabled={!can} onClick={() => act("claimPause", "暂停领取")}>暂停领取（收益照常累计）</button>
        )}
        {!pr.ended && (
          <div className="danger-box">
            <b>永久结束挖矿</b>
            <p className="fine">结束后不再累计任何收益、不能再入金，而且<b>不能恢复</b>。用户已累计的奖励仍可领取（除非暂停领取），本金随时可以退出。请输入「确认结束」后才能点击。</p>
            <div className="inp-row">
              <input placeholder="确认结束" value={endText} onChange={(e) => setEndText(e.target.value)} />
            </div>
            <button className="btn-line wide danger" disabled={!can || endText.trim() !== "确认结束"} onClick={() => act("end", "永久结束挖矿")}>永久结束挖矿</button>
          </div>
        )}
        {steps && <Steps steps={steps} />}
      </section>

      <section className="card">
        <b>奖励参数</b>
        <p className="fine">立即生效，只影响之后的收益；之前的收益按旧参数结算，不会改变。</p>
        <div className="grid-in">
          <label className="inp"><span>每日收益率（%）</span><div className="inp-row"><input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></div></label>
          <label className="inp"><span>动态资格门槛（入金额度，USDT）</span><div className="inp-row"><input inputMode="decimal" value={thr} onChange={(e) => setThr(e.target.value)} /></div></label>
          <label className="inp"><span>本人（%）</span><div className="inp-row"><input inputMode="decimal" value={pP} onChange={(e) => setPP(e.target.value)} /></div></label>
          <label className="inp"><span>一代上级（%）</span><div className="inp-row"><input inputMode="decimal" value={p1} onChange={(e) => setP1(e.target.value)} /></div></label>
          <label className="inp"><span>二代上级（%）</span><div className="inp-row"><input inputMode="decimal" value={p2} onChange={(e) => setP2(e.target.value)} /></div></label>
        </div>
        <p className="fine">三项比例是每日总额度的分配，加起来必须等于 100%（例：85 / 10 / 5）。当前：{pct(pr.rateBps)}/天，{pct(pr.personalBps)} / {pct(pr.tier1Bps)} / {pct(pr.tier2Bps)}，门槛 {usd0(pr.thresholdUsd)} USDT。</p>
        {rewardErr && <div className="alert">{rewardErr}</div>}
        <button className="btn-green wide" disabled={!can || !!rewardErr} onClick={() => act("rewardParams", `保存奖励参数：${rate}%/天，${pP}/${p1}/${p2}，门槛 ${thr} USDT`, { rateBps: rb, personalBps: pb, tier1Bps: b1, tier2Bps: b2, thresholdUsd: thrUsd })}>
          保存奖励参数
        </button>
      </section>

      <section className="card">
        <b>安全参数</b>
        <div className="grid-in">
          <label className="inp"><span>入金价格偏离上限（%）</span><div className="inp-row"><input inputMode="decimal" value={dev} onChange={(e) => setDev(e.target.value)} /></div></label>
          <label className="inp"><span>储备覆盖天数</span><div className="inp-row"><input inputMode="numeric" value={run} onChange={(e) => setRun(e.target.value)} /></div></label>
          <label className="inp"><span>POP/USDT 池最低流动性</span><div className="inp-row"><input inputMode="numeric" value={mpl} onChange={(e) => setMpl(e.target.value)} /></div></label>
          <label className="inp"><span>喜羊羊池最低流动性</span><div className="inp-row"><input inputMode="numeric" value={mrl} onChange={(e) => setMrl(e.target.value)} /></div></label>
        </div>
        <p className="fine">入金价格偏离：POP 现价被拉偏超过这个比例时，暂不接受新入金（防夹子攻击），不影响计息和领取。最低流动性：池子比这还浅时停止计息（V2 喜羊羊池按池中 USDT/POP 的最小单位数量计）。储备覆盖天数：运营钱包可用额度要能覆盖「待支付 + 这么多天的发放」，否则自动暂停。</p>
        {safetyErr && <div className="alert">{safetyErr}</div>}
        <button className="btn-green wide" disabled={!can || !!safetyErr} onClick={() => act("safetyParams", "保存安全参数", { maxTickDeviation: devBps, minPoolLiquidity: BigInt(mpl || "0"), minRewardPoolLiquidity: BigInt(mrl || "0"), runwayDays: runN })}>
          保存安全参数
        </button>
      </section>

      <section className="card">
        <b>授权 / 补充授权</b>
        <p className="fine">由运营钱包直接对喜羊羊代币执行 approve（设置为新额度，有限额度，不默认无限）。补充储备：把喜羊羊转入运营钱包 {snap.operator}。</p>
        <div className="inp-row">
          <input inputMode="decimal" placeholder="新的授权额度（喜羊羊）" value={amt} onChange={(e) => setAmt(e.target.value)} />
          <button className="btn-green sm" disabled={!approveAmt || !can} onClick={() => act("approve", `授权 ${amt} 喜羊羊给挖矿合约`, approveAmt!)}>
            授权
          </button>
        </div>
      </section>

      <TeamLookup snap={snap} backend={backend} />
      <AdminData cfg={cfg} snap={snap} backend={backend} />

      <section className="card list">
        <b>管理与状态记录</b>
        {!log && <div className="muted center">加载中…</div>}
        {log && log.length === 0 && <div className="muted center">暂无记录</div>}
        {log?.map((l, i) => (
          <div className="li" key={i}>
            <div className="grow">
              <b>{l.text}</b>
              <div className="fine">{fmtTime(l.time)}</div>
            </div>
            {!l.tx.startsWith("0xdemo") && <a className="ext" href={`${cfg.explorer}/tx/${l.tx}`} target="_blank" rel="noreferrer">↗</a>}
          </div>
        ))}
      </section>
      </>
      )}
    </>
  );
}

const dayKey = (t: number) => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function AdminData({ cfg, snap, backend }: { cfg: AppConfig; snap: Snapshot; backend: Backend }) {
  const [tab, setTab] = useState<AdminTab>("users");
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [prog, setProg] = useState<[number, number] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<AdminUserRow[] | null>(null);
  const [openRef, setOpenRef] = useState("");
  const PAGE = 20;
  const load = async () => {
    setErr("");
    setEvents(null);
    try {
      setEvents(await backend.adminScan((d, t) => setProg([d, t])));
    } catch (e) {
      setErr("数据加载失败：" + humanError(e) + "（区块范围太大时可在 config.json 调小 logChunk 或换数据节点）");
    }
  };
  const ud = snap.usdtDecimals, pd = snap.popDecimals, rd = snap.rewardDecimals;
  const joined = useMemo(() => (events ?? []).filter((e) => e.name === "Joined").sort((a, b) => b.time - a.time), [events]);
  const users = useMemo(() => joined.filter((e) => !q || e.user.toLowerCase().includes(q.toLowerCase())).map((e) => e.user), [joined, q]);
  useEffect(() => {
    if (!events || tab !== "users") return;
    setRows(null);
    backend.userRows(users.slice(page * PAGE, page * PAGE + PAGE)).then(setRows).catch((e) => setErr(humanError(e)));
  }, [events, tab, page, users, backend]);
  const daily = useMemo(() => {
    const m = new Map<string, { joins: number; deps: number; usdtIn: bigint; popIn: bigint; wds: number; usdtOut: bigint; popOut: bigint; claims: number; reward: bigint }>();
    for (const e of events ?? []) {
      const k = dayKey(e.time);
      const d = m.get(k) ?? { joins: 0, deps: 0, usdtIn: 0n, popIn: 0n, wds: 0, usdtOut: 0n, popOut: 0n, claims: 0, reward: 0n };
      if (e.name === "Joined") d.joins++;
      if (e.name === "Deposited") { d.deps++; d.usdtIn += e.args.usdtIn - e.args.usdtRefund; d.popIn += e.args.popIn - e.args.popRefund; }
      if (e.name === "Withdrawn") { d.wds++; d.usdtOut += e.args.usdtPrincipal; d.popOut += e.args.popPrincipal; }
      if (e.name === "Claimed") { d.claims++; d.reward += e.args.personalReward + e.args.dynamicReward; }
      m.set(k, d);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [events]);
  const refs = useMemo(() => {
    const m = new Map<string, { direct: string[]; indirect: number; dynUsd: bigint }>();
    const get = (a: string) => m.get(a.toLowerCase()) ?? (m.set(a.toLowerCase(), { direct: [], indirect: 0, dynUsd: 0n }), m.get(a.toLowerCase())!);
    const Z = "0x0000000000000000000000000000000000000000";
    for (const e of events ?? []) {
      if (e.name === "Joined") {
        if (e.args.referrer && e.args.referrer !== Z) get(e.args.referrer).direct.push(e.user);
        if (e.args.referrer2 && e.args.referrer2 !== Z) get(e.args.referrer2).indirect++;
      }
      if (e.name === "DynamicAccrued") get(e.user).dynUsd += e.args.usd;
    }
    return [...m.entries()].filter(([, v]) => v.direct.length || v.indirect).sort((a, b) => b[1].direct.length + b[1].indirect - (a[1].direct.length + a[1].indirect));
  }, [events]);
  const flows = useMemo(
    () => (events ?? []).filter((e) => (e.name === "Deposited" || e.name === "Withdrawn" || e.name === "Claimed") && (!q || e.user.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => b.time - a.time),
    [events, q],
  );
  const [flowN, setFlowN] = useState(30);
  const flowText = (e: AdminEvent) =>
    e.name === "Deposited"
      ? `入金 ${fmtUnits(e.args.usdtIn - e.args.usdtRefund, ud)} USDT${e.args.popIn > 0n ? ` + ${fmtUnits(e.args.popIn - e.args.popRefund, pd)} POP` : ""}`
      : e.name === "Withdrawn"
        ? `退出 ${fmtUnits(e.args.popPrincipal, pd)} POP + ${fmtUnits(e.args.usdtPrincipal, ud)} USDT（手续费 ${fmtUnits(e.args.popFees, pd, 2)} POP + ${fmtUnits(e.args.usdtFees, ud, 2)} USDT）`
        : `领取 ${fmtUnits(e.args.personalReward + e.args.dynamicReward, rd)} 喜羊羊`;
  return (
    <section className="card list">
      <b>数据</b>
      <div className="seg four">
        {([["users", "用户列表"], ["daily", "每日统计"], ["refs", "推荐总览"], ["flows", "资金流水"]] as const).map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => { setTab(k); setPage(0); }}>{l}</button>
        ))}
      </div>
      {!events && (
        <>
          <p className="fine">从合约部署区块开始读取全部链上事件（入金、退出、领取、加入、推荐奖励），在你的浏览器里统计，不经过任何服务器。用户多时需要一点时间。</p>
          {prog && <div className="fine">已读取 {Math.round((prog[0] / prog[1]) * 100)}% 区块…</div>}
          <button className="btn-green wide" onClick={load} disabled={!!prog && !err && !events}>{prog && !err ? "读取中…" : "读取数据"}</button>
        </>
      )}
      {err && <div className="alert">{err}<button className="btn-mini" onClick={load}>重试</button></div>}
      {events && (
        <>
          <div className="row-sb fine">共 {joined.length} 个钱包，{events.length} 条事件 <button className="btn-mini" onClick={load}>刷新</button></div>
          {(tab === "users" || tab === "flows") && (
            <div className="inp-row"><input placeholder="按地址搜索" value={q} onChange={(e) => { setQ(e.target.value.trim()); setPage(0); }} /></div>
          )}
          {tab === "users" && (
            <>
              {!rows && <div className="center muted">加载中…</div>}
              {rows?.length === 0 && <div className="center muted">暂无数据</div>}
              {rows?.map((u) => (
                <div className="li" key={u.address}>
                  <div className="grow">
                    <b className="mono">{short(u.address)}</b> <span className={"pill " + (u.eligible ? "ok" : "no")}>{u.eligible ? "有效" : "未达门槛"}</span>
                    <div className="fine">LP {fmtUnits(u.valueUsd, 18)} USDT · 待领取 {fmtUnits(u.pendingUsd, 18, 2)} USDT 计价 · 已领取 {fmtUnits(u.claimedReward, rd, 0)} 喜羊羊</div>
                    <div className="fine">推荐人 {u.referrer ? short(u.referrer) : "无"} · 直推 {u.direct} · 间推 {u.indirect} · 首次入金 {fmtTime(u.firstDepositAt)}</div>
                  </div>
                  {cfg.explorer && <a className="ext" href={`${cfg.explorer}/address/${u.address}`} target="_blank" rel="noreferrer">↗</a>}
                </div>
              ))}
              <div className="pager">
                <button className="btn-line" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
                <span className="fine">{page + 1} / {Math.max(1, Math.ceil(users.length / PAGE))}</span>
                <button className="btn-line" disabled={(page + 1) * PAGE >= users.length} onClick={() => setPage(page + 1)}>下一页</button>
              </div>
            </>
          )}
          {tab === "daily" && (
            <>
              {daily.length === 0 && <div className="center muted">暂无数据</div>}
              {daily.map(([k, d]) => (
                <div className="li" key={k}>
                  <div className="grow">
                    <b>{k}</b>
                    <div className="fine">新加入 {d.joins} 个钱包 · 入金 {d.deps} 笔：{fmtUnits(d.usdtIn, ud)} USDT{d.popIn > 0n ? ` + ${fmtUnits(d.popIn, pd)} POP` : ""}</div>
                    <div className="fine">退出 {d.wds} 笔：{fmtUnits(d.popOut, pd)} POP + {fmtUnits(d.usdtOut, ud)} USDT</div>
                    <div className="fine">领取 {d.claims} 笔，共发放 <b>{fmtUnits(d.reward, rd)} 喜羊羊</b></div>
                  </div>
                </div>
              ))}
            </>
          )}
          {tab === "refs" && (
            <>
              {refs.length === 0 && <div className="center muted">暂无推荐关系</div>}
              {refs.slice(0, 200).map(([a, v]) => (
                <div key={a}>
                  <div className="li tap-li" onClick={() => setOpenRef(openRef === a ? "" : a)}>
                    <div className="grow">
                      <b className="mono">{short(a)}</b>
                      <div className="fine">直推 {v.direct.length} · 间推 {v.indirect} · 合计 {v.direct.length + v.indirect} · 累计动态收益 {fmtUnits(v.dynUsd, 18, 2)} USDT 计价</div>
                    </div>
                    <span className="fine">{openRef === a ? "收起" : "展开"}</span>
                  </div>
                  {openRef === a && (
                    <div className="sub-list">
                      {v.direct.map((d) => <div className="fine mono" key={d}>└ {d}</div>)}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
          {tab === "flows" && (
            <>
              {flows.length === 0 && <div className="center muted">暂无记录</div>}
              {flows.slice(0, flowN).map((e, i) => (
                <div className="li" key={e.tx + i}>
                  <div className="grow">
                    <b>{flowText(e)}</b>
                    <div className="fine mono">{short(e.user)} · {fmtTime(e.time)}</div>
                  </div>
                  {!e.tx.startsWith("0xdemo") && <a className="ext" href={`${cfg.explorer}/tx/${e.tx}`} target="_blank" rel="noreferrer">↗</a>}
                </div>
              ))}
              {flows.length > flowN && <button className="btn-line wide" onClick={() => setFlowN(flowN + 30)}>加载更多</button>}
            </>
          )}
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ icons (inline SVG)
const sv = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
function IconPick() {
  return (<svg {...sv}><path d="M14 4l6 6M4 20l9-9M15 3c3 0 6 3 6 6l-3-1-4-4-1-3z" /></svg>);
}
function IconUsers() {
  return (<svg {...sv}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 010 7M18.5 14.8c1.6.8 2.6 2.6 3 5.2" /></svg>);
}
function IconUser() {
  return (<svg {...sv}><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4.2-6 8-6s7 2 8 6" /></svg>);
}
function IconLock() {
  return (<svg {...sv}><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 018 0v3M12 14v3" /></svg>);
}
function IconDoc() {
  return (<svg {...sv}><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>);
}
function IconLayers() {
  return (<svg {...sv}><path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5" /></svg>);
}
