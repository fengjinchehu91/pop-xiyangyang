import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig } from "./config";
import { ChainBackend, humanError, switchChain, walletAccounts, walletChainId } from "./chain";
import { DemoBackend } from "./demo";
import type { AddQuote, AdminEvent, AdminUserRow, Downline, ExitQuote, Rec, RecKind, Snapshot, Step } from "./types";
import { REASON_TEXT } from "./types";
import { applySlippage, E18, fmtTime, fmtUnits, parseUnitsSafe, short, usdToToken } from "./fmt";

type Backend = ChainBackend | DemoBackend;
type Page = "mine" | "refer" | "records" | "admin";
type SheetKind = null | "add" | "exit" | "claim" | "rules";

/** basis points -> "1%" / "0.5%" */
const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
const usd0 = (x: bigint) => fmtUnits(x, 18, 0);

const A = (p: string) => ((window as any).__XYY_ASSETS__?.[p] as string) || `./assets/${p}`;
const SLIP_BPS = 100; // 1%
const QUOTE_TTL = 60_000;

// =====================================================================================================
export default function App({ cfg }: { cfg: AppConfig }) {
  const demo = cfg.mode === "demo";
  const backend = useMemo<Backend>(() => (demo ? new DemoBackend() : new ChainBackend(cfg)), [cfg, demo]);
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<string>(demo ? "0x8d3a1c9e2b47f05a8e6c1d2b3a4f5e6c7d8e70a2" : "");
  const [chainId, setChainId] = useState<number | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [page, setPage] = useState<Page>(() => (location.hash === "#admin" ? "admin" : (new URLSearchParams(location.search).get("page") as Page) || "mine"));
  const [sheet, setSheet] = useState<SheetKind>(() => (new URLSearchParams(location.search).get("sheet") as SheetKind) || null);
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState("");
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

  const refresh = useCallback(async () => {
    if (!ready) return;
    try {
      setSnap(await backend.snapshot(account || undefined));
      setLoadErr("");
    } catch (e: any) {
      setLoadErr("数据加载失败：" + humanError(e));
    }
  }, [backend, account, ready]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, demo ? 30_000 : 15_000);
    return () => clearInterval(id);
  }, [refresh, demo]);

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
  const showAdmin = isAdmin || (demo && (new URLSearchParams(location.search).get("admin") === "1" || location.hash === "#admin"));

  const live = useLive(snap, tick);

  // 首次进入：新钱包必须先绑定推荐人，才能进入网站。已绑定、已入过金的钱包和运营/管理钱包直接进入。
  const [bound, setBound] = useState(false);
  const [demoGate, setDemoGate] = useState(demo && new URLSearchParams(location.search).get("gate") !== "0");
  const me = account.toLowerCase();
  const isStaff = !!me && [snap?.owner, snap?.operator].some((x) => !!x && x.toLowerCase() === me);
  const gate = demo
    ? demoGate
    : !!snap?.configured && !bound && !isStaff && (!account || !snap.user || (!snap.user.referrer && !snap.user.joined));

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
          {snap && page === "refer" && <ReferPage cfg={cfg} snap={snap} live={live} account={account} backend={backend} onConnect={connect} toast={setToast} />}
          {snap && page === "records" && <RecordsPage cfg={cfg} account={account} backend={backend} onConnect={connect} />}
          {snap && page === "admin" && showAdmin && <AdminPage cfg={cfg} snap={snap} backend={backend} demo={demo} isAdmin={isAdmin} refresh={refresh} />}
        </main>

        <nav className="tabbar">
          {(
            [
              ["mine", "挖矿", IconPick],
              ["refer", "推荐", IconUsers],
              ["records", "记录", IconDoc],
            ] as const
          ).map(([k, label, Ic]) => (
            <button key={k} className={"tab" + (page === k ? " on" : "")} onClick={() => setPage(k)}>
              <Ic />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {showAdmin && page !== "admin" && (
          <button className="admin-fab" onClick={() => setPage("admin")}>管理</button>
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
function BindGate({ cfg, snap, backend, refParam, account, canTx, demo, onConnect, done }: { cfg: AppConfig; snap: Snapshot; backend: Backend; refParam: string; account: string; canTx: boolean; demo: boolean; onConnect: () => void; done: () => void }) {
  void cfg;
  const [typed, setTyped] = useState("");
  const fromLink = refParam || (demo ? "0x4f9e2b7c1d8a3e6f5b0c9d2e1a7b8c3d4e5f3c77" : "");
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
        <img src={A("sheep-thumb.png")} alt="" className="gate-img" />
        <h2>绑定推荐人</h2>
        <p className="gate-sub">绑定后即可进入喜羊羊矿场</p>

        {fromLink ? (
          <div className="gate-ref">
            <span>推荐人</span>
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
          <p className="gate-msg bad">这个推荐人还没有添加过流动性，暂时不能绑定。请让推荐人先添加一次流动性，再用他的推荐链接打开。</p>
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
    </main>
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
    const dailyUsd = snap.running ? (u.valueUsd * BigInt(pr.rateBps) * BigInt(pr.personalBps)) / 100_000_000n : 0n;
    const dt = BigInt(Math.max(0, Math.floor((Date.now() - snap.fetchedAt) / 1000)));
    const personalUsd = u.personalUsd + (dailyUsd * dt) / 86400n;
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
        <img src={A("xyy-coin.png")} alt="" className="brand-ic" />
        <span>喜羊羊矿场</span>
      </div>
      <div className="hdr-r">
        <span className="chip-bsc">
          <i className="chip-ic"><img src={A("bnb.png")} alt="" /></i>
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

function StatusLine({ snap }: { snap: Snapshot }) {
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
      {!img && <img src={A("banner.jpg")} alt="" className="hero-bg" />}
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
            添加流动性，
            <br />
            收获喜羊羊
          </>
        }
        img=""
        tag="每日 0.1%～0.5% · 随存随取"
      />
      <StatusLine snap={snap} />

      {!account ? (
        <div className="card center">
          <img src={A("sheep-thumb.png")} alt="" className="empty-img" />
          <p className="muted">连接钱包后查看您的流动性与收益</p>
          <button className="btn-gold" onClick={props.onConnect}>连接钱包</button>
        </div>
      ) : (
        <>
          <section className="card reward">
            <div className="reward-top">
              <img src={A("xyy-coin.png")} alt="喜羊羊" className="coin-lg" />
              <div className="grow">
                <div className="lbl-light">待领取喜羊羊（预计）</div>
                {(() => {
                  const t = live?.pendingTokens != null ? fmtUnits(live.pendingTokens, snap.rewardDecimals) : snap.rewardPrice ? "0.00" : "报价不可用";
                  return <div className={"big" + (t.length > 10 ? " long" : "")}>{t}</div>;
                })()}
              </div>
              <img src={A("chest.png")} alt="" className="reward-gift" />
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
              计价额度 {fmtUnits((live?.personalUsd ?? 0n) + (live?.dynamicUsd ?? 0n), 18, 4)} USDT · 按当前喜羊羊参考价换算
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
                <img src={A("pop-coin.png")} alt="POP" /> {fmtUnits(u?.popAmt ?? 0n, snap.popDecimals)} POP
              </span>
              <span>
                <i className="usdt-ic">U</i> {fmtUnits(u?.usdtAmt ?? 0n, snap.usdtDecimals)} USDT
              </span>
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
              <span className={"pill " + (u?.eligible ? "ok" : "no")}>{u?.eligible ? "动态资格有效" : `未达${usd0(snap.params.thresholdUsd)} USDT门槛`}</span>
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

  if (!account)
    return (
      <div className="card center">
        <img src={A("sheep-safe.png")} alt="" className="empty-img" />
        <p className="muted">连接钱包后查看推荐信息</p>
        <button className="btn-gold" onClick={onConnect}>连接钱包</button>
      </div>
    );
  const u = snap.user;
  const base = cfg.appUrl || location.origin + location.pathname;
  const link = `${base}?ref=${account}`;
  const thr = snap.params.thresholdUsd;
  const gap = u ? thr - u.valueUsd : thr;
  const effective = list ? [...list.direct, ...list.indirect].filter((d) => d.eligible).length : null;
  const rows = list ? (tab === "direct" ? list.direct : list.indirect) : [];
  return (
    <>
      <section className={"elig " + (u?.eligible ? "ok" : "no")}>
        <div className="elig-ic">{u?.eligible ? "✓" : "!"}</div>
        <div>
          <b>{u?.eligible ? "动态资格已生效" : "动态资格未生效"}</b>
          <div>{u?.eligible ? `当前LP参考价值 ≥ ${usd0(thr)} USDT` : `距 ${usd0(thr)} USDT 门槛还差 ${fmtUnits(gap > 0n ? gap : 0n, 18)} USDT`}</div>
        </div>
      </section>

      <section className="card invite">
        <div className="invite-txt">
          <b>邀请好友加入喜羊羊矿场</b>
          <p className="fine">分享链接，好友首次添加流动性时确认绑定，之后可产生动态收益。</p>
        </div>
        <img src={A("sheep-safe.png")} alt="" className="invite-img" />
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
          <span>总人数</span>
          <b>{(u?.direct ?? 0) + (u?.indirect ?? 0)}</b>
        </div>
        <div>
          <span>当前有效</span>
          <b>{effective ?? "—"}</b>
        </div>
      </section>
      <p className="fine pad">人数按实际入金过的独立钱包统计，重复入金不重复计数；一个钱包不等于一个真实自然人。有效 = 当前LP参考价值 ≥ {usd0(thr)} USDT。</p>

      <section className="card reward dyn">
        <div className="reward-top">
          <img src={A("xyy-coin.png")} alt="" className="coin-lg" />
          <div className="grow">
            <div className="lbl-light">待领取动态收益（预计）</div>
            <div className="big">
              {live?.dynamicTokens != null ? fmtUnits(live.dynamicTokens, snap.rewardDecimals) : "—"} <small>喜羊羊</small>
            </div>
          </div>
          <img src={A("coins-pair.png")} alt="" className="reward-gift" />
        </div>
        <div className="fine-light">累计实际领取动态：{fmtUnits(u?.claimedDynamic ?? 0n, snap.rewardDecimals)} 喜羊羊 · 下级结算后入账</div>
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
            <span className={"pill " + (d.eligible ? "ok" : "no")}>{d.eligible ? "有效" : "未达门槛"}</span>
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
          沿推荐链向上，第一个满足资格（LP ≥ {usd0(thr)} USDT）的上级获得 {pct(snap.params.tier1Bps)}，第二个获得 {pct(snap.params.tier2Bps)}；同一人不会同时占两个档位；找不到时该部分不分配，也不扣运营钱包。顺延不改变真实推荐关系和人数统计。向上最多查找 10 层。
        </p>
      </section>
    </>
  );
}

// =====================================================================================================
function RecordsPage({ cfg, account, backend, onConnect }: { cfg: AppConfig; account: string; backend: Backend; onConnect: () => void }) {
  const [kind, setKind] = useState<RecKind>("liquidity");
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
      <Hero title="记录" sub="查看流动性、领取及动态奖励记录（来自链上事件）" img={A("sheep-thumb.png")} />
      <div className="seg three">
        {(
          [
            ["liquidity", "流动性"],
            ["claim", "领取"],
            ["dynamic", "动态奖励"],
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
            <div className={"rec-ic " + (r.sign === "-" ? "out" : "in")}>{r.kind === "claim" ? "🎁" : r.sign === "-" ? "−" : "+"}</div>
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
        .quoteAdd(mode, usdtAmt, popAmt, SLIP_BPS)
        .then(setQ)
        .catch((e) => setQErr("报价失败：" + humanError(e)));
    }, 400);
  }, [usdtIn, popIn, mode, pairing]); // eslint-disable-line react-hooks/exhaustive-deps
  const expired = q ? now - q.createdAt > QUOTE_TTL : false;
  const needConfirmRef = !!useRef_ && !okRef;
  const go = async () => {
    if (!q) return;
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
            全价格区间，无需设置区间；滑点保护 {SLIP_BPS / 100}%，报价有效期 10 分钟。实际以链上成交为准，没用完的代币会原路退回。
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
      {steps && <Steps steps={steps} />}
      {allDone ? (
        <button className="btn-green wide" onClick={close}>完成</button>
      ) : expired ? (
        <button className="btn-gold wide" onClick={() => backend.quoteAdd(mode, usdtAmt!, popAmt!, SLIP_BPS).then(setQ)}>刷新报价</button>
      ) : (
        <button className="btn-green wide" disabled={!canTx || !q || running || !!overU || !!overP || pairing || needConfirmRef || refInvalid || !snap.running} onClick={go}>
          {running ? "处理中…" : refInvalid ? "推荐人还没有入金" : steps?.some((x) => x.status === "error") ? "重试" : !snap.running ? "当前暂停入金" : "授权并添加"}
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
      .quoteExit(account, pct, SLIP_BPS, u.liquidity, u.valueUsd, snap.params.thresholdUsd)
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
            <img src={A("pop-coin.png")} alt="" className="tok" /> POP
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
      <div className="note-gold">ⓘ 固定返还 POP + USDT，不支持修改币种；退回的是仓位实际资产，不保证等于原始入金 USDT 金额。</div>
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
  const [running, setRunning] = useState(false);
  const est = live?.pendingTokens ?? null;
  const minOut = est ? applySlippage(est, SLIP_BPS) : null;
  const go = async () => {
    if (!minOut) return;
    const s: Step[] = [{ label: "领取喜羊羊（由运营钱包授权支付）", status: "idle" }];
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
    <Sheet title="领取喜羊羊" close={close} icon={<img src={A("xyy-coin.png")} className="tok" alt="" />}>
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
      {!snap.rewardPrice && <div className="alert">喜羊羊报价暂不可用，暂不能领取。</div>}
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
        <p><b>奖励基数：</b>您存入流动性本金的当前 USDT 参考价值（按池子时间加权价格），不含待领取奖励和未领取手续费。</p>
        <p><b>每日总额度：</b>奖励基数的 {pct(pr.rateBps)}，按实际持有时间累计，不自动复利。其中本人 {pct(pr.personalBps)}，第一个有效上级 {pct(pr.tier1Bps)}，第二个有效上级 {pct(pr.tier2Bps)}（包含在每日总额度之内）。管理员调整参数只影响调整之后，已累计的收益不变。</p>
        <p><b>计价与领取：</b>奖励按 USDT 计价记账，领取时按喜羊羊「30 分钟平均价」和「现价」中较高的那个换算，由您手动领取并支付 BNB 网络费。页面数字每 3 秒更新一次预计值，不代表链上交易。</p>
        <p><b>估值更新：</b>系统每分钟自动检查，约每 25 分钟更新一次估值（需要暂停或恢复时立即更新）；两次检查之间按上一次估值计息；超过 2 小时没有有效估值会自动停止计息，恢复后不补计。</p>
        <p><b>暂停：</b>运营钱包储备/授权不足、报价失效或管理员暂停时，停止新增入金和新增计息；已累计奖励保留；随时可以退出本金。</p>
        <p><b>动态资格：</b>本人 LP 参考价值 ≥ {usd0(pr.thresholdUsd)} USDT。资格在下级每次结算时判定（下级操作或系统定期结算）；您自己退出导致失效时，从退出那一刻起停止获得动态奖励；恢复后不追溯。</p>
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

function AdminPage({ cfg, snap, backend, demo, isAdmin, refresh }: { cfg: AppConfig; snap: Snapshot; backend: Backend; demo: boolean; isAdmin: boolean; refresh: () => void }) {
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
  const daily = snap.tvlUsd ? (snap.tvlUsd * BigInt(pr.rateBps)) / 10000n : null;
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
        {!isAdmin && <div className="alert warn">{demo ? "演示：仅供查看，操作为模拟。" : "当前钱包不是管理员，链上也会拒绝操作。"}</div>}
        <p className="fine">所有权限由合约校验。管理员不能提走本金、仓位NFT或手续费，也不能修改已累计的收益；调整参数只影响调整之后，暂停不影响用户退出。</p>
      </section>
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
        <div><span>每日总发放（当前）</span><b>{fmtUnits(daily, 18)} USDT 计价</b></div>
        <div><span>参与钱包数</span><b>{snap.participants}</b></div>
        <div><span>累计实际发放</span><b>{fmtUnits(snap.totalPaidReward, snap.rewardDecimals)} 喜羊羊</b></div>
        <div><span>喜羊羊参考价（领取用）</span><b>{p ? `${fmtUnits(p, 18, 6)} USDT` : "不可用"}</b></div>
        <div><span>最近检查</span><b>{fmtTime(snap.lastCheckpoint)}</b></div>
        <div><span>运行状态</span><b className={snap.running ? "ok-t" : "err"}>{pr.ended ? "已永久结束" : snap.running ? "运行中" : "已暂停"}</b></div>
        <div><span>领取</span><b className={pr.claimPaused ? "err" : "ok-t"}>{pr.claimPaused ? "已暂停" : "开放"}</b></div>
      </section>
      <p className="fine pad">合约规定：可用支付额度要够“已累计待支付 + {snap.runwayDays || 3} 天的发放量”，不够就自动暂停，补足后自动恢复。人少时每天的发放量按至少 {usd0((100n * E18 * BigInt(pr.rateBps)) / 10000n)} USDT 计算。还能支撑的天数 = 超出要求的部分 ÷ 每天发放量；喜羊羊价格和平台规模变化都会改变这些数字。</p>
      <StatusLine snap={snap} />

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
          <label className="inp"><span>动态资格门槛（USDT）</span><div className="inp-row"><input inputMode="decimal" value={thr} onChange={(e) => setThr(e.target.value)} /></div></label>
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
function IconDoc() {
  return (<svg {...sv}><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>);
}
function IconLayers() {
  return (<svg {...sv}><path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5" /></svg>);
}
