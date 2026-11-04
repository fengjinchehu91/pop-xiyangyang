import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig } from "./config";
import { ChainBackend, humanError, switchChain, walletAccounts, walletChainId } from "./chain";
import { DemoBackend } from "./demo";
import type { AddQuote, Downline, ExitQuote, Rec, RecKind, Snapshot, Step } from "./types";
import { REASON_TEXT } from "./types";
import { applySlippage, E18, fmtTime, fmtUnits, parseUnitsSafe, short, usdToToken } from "./fmt";
import qrcodegen from "./vendor/qrcodegen";

type Backend = ChainBackend | DemoBackend;
type Page = "mine" | "refer" | "records" | "admin";
type SheetKind = null | "add" | "exit" | "claim" | "rules";

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
    const onChain = (c: string) => setChainId(parseInt(c, 16));
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

        {sheet === "add" && snap && (
          <AddSheet cfg={cfg} snap={snap} backend={backend} refParam={refParam} account={account} canTx={canTx} close={() => setSheet(null)} done={refresh} />
        )}
        {sheet === "exit" && snap?.user && (
          <ExitSheet snap={snap} backend={backend} account={account} canTx={canTx} close={() => setSheet(null)} done={refresh} />
        )}
        {sheet === "claim" && snap && <ClaimSheet snap={snap} live={live} backend={backend} canTx={canTx} close={() => setSheet(null)} done={refresh} />}
        {sheet === "rules" && <RulesSheet close={() => setSheet(null)} />}
        {toast && (
          <div className="toast" onClick={() => setToast("")}>
            {toast}
          </div>
        )}
      </div>
    </div>
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
    const dailyUsd = snap.running ? (u.valueUsd * 85n) / 10000n : 0n;
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
          <IconBnb />
          {cfg.chainId === 56 ? "BSC" : `链 ${cfg.chainId}`}
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
  if (snap.running)
    return (
      <div className="status ok">
        <i className="dot" />
        运行中 · 最近检查 {fmtTime(snap.lastCheckpoint)}
      </div>
    );
  const rs = REASON_TEXT.filter(([b]) => snap.reasons & b).map(([, t]) => t);
  return (
    <div className="status bad">
      <i className="dot" />
      已暂停新增入金与计息：{rs.join("；") || "等待首次检查"}。本金退出不受影响，已累计奖励保留。
    </div>
  );
}

function Hero({ title, sub, img }: { title: React.ReactNode; sub?: string; img: string }) {
  return (
    <section className={"hero" + (img ? " plain" : "")}>
      {!img && <img src={A("banner.jpg")} alt="" className="hero-bg" />}
      <div className="hero-txt">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
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
  const ex = (a: string) => `${cfg.explorer}/address/${a}`;
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
                <div className="big">{live?.pendingTokens != null ? fmtUnits(live.pendingTokens, snap.rewardDecimals) : snap.rewardPrice ? "0.00" : "报价不可用"}</div>
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
            <button className="btn-gold wide" disabled={!canTx || !u || (live?.personalUsd ?? 0n) + (live?.dynamicUsd ?? 0n) === 0n} onClick={() => open("claim")}>
              领取喜羊羊
            </button>
            <p className="fine-light">预计数量随价格变化，以领取时结算为准</p>
          </section>

          <section className="card">
            <div className="row-h">
              <IconLayers />
              <span>我的流动性（参考价值）</span>
            </div>
            <div className="val">
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
                ⊖ 退出流动性
              </button>
            </div>
            <p className="fine">参考价值按池子时间加权价格估算，不含待领取奖励和未领取交易手续费。</p>
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
              <span className={"pill " + (u?.eligible ? "ok" : "no")}>{u?.eligible ? "动态资格有效" : "未达100 USDT门槛"}</span>
            </div>
          </section>
        </>
      )}

      <section className="card links">
        <button className="link-btn" onClick={() => open("rules")}>📖 奖励规则</button>
        {snap.addresses.miner && !/^0x0+$/.test(snap.addresses.miner) && (
          <a href={ex(snap.addresses.miner)} target="_blank" rel="noreferrer">挖矿合约 ↗</a>
        )}
        <a href={ex(snap.addresses.pool)} target="_blank" rel="noreferrer">POP/USDT 池 ↗</a>
        <a href={ex(snap.addresses.reward)} target="_blank" rel="noreferrer">喜羊羊代币 ↗</a>
      </section>
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
  const load = useCallback(
    async (to?: number) => {
      if (!account || !snap.configured) return;
      setBusy(true);
      try {
        const top = to ?? (await backend.latestBlock());
        const r = await backend.downlines(account, top, SPAN);
        setList((p) => ({ direct: [...(to ? p?.direct ?? [] : []), ...r.direct], indirect: [...(to ? p?.indirect ?? [] : []), ...r.indirect] }));
        setNextTo(r.nextTo);
        setErr("");
      } catch (e) {
        setErr("列表加载失败：" + humanError(e));
      } finally {
        setBusy(false);
      }
    },
    [account, backend, snap.configured],
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
  const gap = u ? 100n * E18 - u.valueUsd : 100n * E18;
  const effective = list ? [...list.direct, ...list.indirect].filter((d) => d.eligible).length : null;
  const rows = list ? (tab === "direct" ? list.direct : list.indirect) : [];
  return (
    <>
      <section className={"elig " + (u?.eligible ? "ok" : "no")}>
        <div className="elig-ic">{u?.eligible ? "✓" : "!"}</div>
        <div>
          <b>{u?.eligible ? "动态资格已生效" : "动态资格未生效"}</b>
          <div>{u?.eligible ? "当前LP参考价值 ≥ 100 USDT" : `距 100 USDT 门槛还差 ${fmtUnits(gap > 0n ? gap : 0n, 18)} USDT`}</div>
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
        <QR text={link} />
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
      <p className="fine pad">人数按实际入金过的独立钱包统计，重复入金不重复计数；一个钱包不等于一个真实自然人。有效 = 当前LP参考价值 ≥ 100 USDT。</p>

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
        {err && <div className="alert">{err}</div>}
        {!list && !err && <div className="center muted">加载中…</div>}
        {list && rows.length === 0 && <div className="center muted">暂无数据</div>}
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
          沿推荐链向上，第一个满足资格（LP ≥ 100 USDT）的上级获得 10%，第二个获得 5%；同一人不会同时占两个档位；找不到时该部分不分配，也不扣运营钱包。顺延不改变真实推荐关系和人数统计。向上最多查找 10 层。
        </p>
      </section>
    </>
  );
}

function QR({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
    const n = qr.size;
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.getModule(x, y)) d += `M${x + 2},${y + 2}h1v1h-1z`;
    return { d, n: n + 4 };
  }, [text]);
  return (
    <div className="qr">
      <svg viewBox={`0 0 ${svg.n} ${svg.n}`} shapeRendering="crispEdges" role="img" aria-label="推荐链接二维码">
        <rect width="100%" height="100%" fill="#fff" />
        <path d={svg.d} fill="#0b3b2a" />
      </svg>
      <span className="fine">扫码打开推荐链接</span>
    </div>
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
        setErr("记录加载失败：" + humanError(e));
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
        {err && (
          <div className="alert">
            {err}
            <button className="btn-mini" onClick={() => load()}>重试</button>
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
  const [mode, setMode] = useState<"usdt" | "both">("usdt");
  const [usdtIn, setUsdtIn] = useState("");
  const [popIn, setPopIn] = useState("");
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
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const usdtAmt = parseUnitsSafe(usdtIn, snap.usdtDecimals);
  const popAmt = mode === "both" ? parseUnitsSafe(popIn, snap.popDecimals) : 0n;
  const overU = usdtAmt !== null && snap.balances && usdtAmt > snap.balances.usdt;
  const overP = popAmt !== null && snap.balances && popAmt > snap.balances.pop;
  const timer = useRef<any>(null);
  useEffect(() => {
    setQ(null);
    setQErr("");
    if (!usdtAmt || usdtAmt === 0n || popAmt === null || (mode === "both" && popAmt === 0n)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      backend
        .quoteAdd(mode, usdtAmt, popAmt, SLIP_BPS)
        .then(setQ)
        .catch((e) => setQErr("报价失败：" + humanError(e)));
    }, 400);
  }, [usdtIn, popIn, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const expired = q ? now - q.createdAt > QUOTE_TTL : false;
  const needConfirmRef = !!useRef_ && !okRef;
  const go = async () => {
    if (!q) return;
    const fresh: Step[] = [
      { label: "授权 USDT（按本次金额）", status: "idle" },
      { label: "授权 POP（按本次金额）", status: q.popAmount > 0n ? "idle" : "skipped" },
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
        <button className={mode === "usdt" ? "on" : ""} onClick={() => setMode("usdt")} disabled={running}>
          仅 USDT
        </button>
        <button className={mode === "both" ? "on" : ""} onClick={() => setMode("both")} disabled={running}>
          USDT + POP
        </button>
      </div>
      <label className="inp">
        <span>
          USDT 数量 <em>余额 {fmtUnits(snap.balances?.usdt ?? null, snap.usdtDecimals)}</em>
        </span>
        <div className="inp-row">
          <input inputMode="decimal" placeholder="0.00" value={usdtIn} onChange={(e) => setUsdtIn(e.target.value)} disabled={running} />
          <button className="btn-mini" onClick={() => snap.balances && setUsdtIn(fmtUnits(snap.balances.usdt, snap.usdtDecimals, 6).replace(/,/g, ""))}>
            全部
          </button>
        </div>
        {overU && <em className="err">余额不足</em>}
      </label>
      {mode === "both" && (
        <label className="inp">
          <span>
            POP 数量 <em>余额 {fmtUnits(snap.balances?.pop ?? null, snap.popDecimals)}</em>
          </span>
          <div className="inp-row">
            <input inputMode="decimal" placeholder="0.00" value={popIn} onChange={(e) => setPopIn(e.target.value)} disabled={running} />
          </div>
          {overP && <em className="err">余额不足</em>}
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
            全价格区间，无需设置区间；滑点保护 {SLIP_BPS / 100}%（单币模式兑换与建仓各自保护），有效期 10 分钟。实际以链上成交为准，未用完的代币原路退回。
            {expired && <b className="err"> 报价已过期，请刷新。</b>}
          </p>
        </div>
      )}
      {firstTime && (
        <div className="refbox">
          {u?.referrer ? (
            <span>已绑定推荐人 {short(u.referrer)}</span>
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
        <button className="btn-green wide" disabled={!canTx || !q || running || !!overU || !!overP || needConfirmRef || !snap.running} onClick={go}>
          {running ? "处理中…" : steps?.some((x) => x.status === "error") ? "重试" : !snap.running ? "当前暂停入金" : "授权并添加"}
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
      .quoteExit(account, pct, SLIP_BPS, u.liquidity, u.valueUsd)
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
    <Sheet title="退出流动性" close={close} icon={<span className="ic-c">⊖</span>}>
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
          {running ? "处理中…" : steps?.some((x) => x.status === "error") ? "重试" : "确认退出"}
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

function RulesSheet({ close }: { close: () => void }) {
  return (
    <Sheet title="奖励规则" close={close}>
      <div className="rules">
        <p><b>奖励基数：</b>您存入流动性本金的当前 USDT 参考价值（按池子时间加权价格），不含待领取奖励和未领取手续费。</p>
        <p><b>每日总额度：</b>奖励基数的 1%，按实际持有时间累计，不自动复利。其中本人 85%，第一个有效上级 10%，第二个有效上级 5%（包含在 1% 之内）。</p>
        <p><b>计价与领取：</b>奖励按 USDT 计价记账，领取时按喜羊羊的链上参考价换算，由您手动领取并支付 BNB 网络费。页面数字每 3 秒更新一次预计值，不代表链上交易。</p>
        <p><b>估值更新：</b>系统约每 10 分钟做一次链上检查；两次检查之间按上一次估值计息；超过 2 小时没有有效估值会自动停止计息，恢复后不补计。</p>
        <p><b>暂停：</b>运营钱包储备/授权不足、报价失效或管理员暂停时，停止新增入金和新增计息；已累计奖励保留；随时可以退出本金。</p>
        <p><b>动态资格：</b>本人 LP 参考价值 ≥ 100 USDT。资格在下级每次结算时判定（下级操作或系统定期结算）；您自己退出导致失效时，从退出那一刻起停止获得动态奖励；恢复后不追溯。</p>
        <p><b>退出：</b>固定返还 POP + USDT 及该仓位手续费，不保证等于原入金金额。</p>
        <p><b>风险：</b>奖励来自运营钱包持有的喜羊羊，不是增发，也不保证一直足额兑付；价格波动会影响到手数量与本金价值。</p>
      </div>
    </Sheet>
  );
}

// =====================================================================================================
function AdminPage({ cfg, snap, backend, demo, isAdmin, refresh }: { cfg: AppConfig; snap: Snapshot; backend: Backend; demo: boolean; isAdmin: boolean; refresh: () => void }) {
  const [amt, setAmt] = useState("");
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [log, setLog] = useState<{ text: string; time: number; tx: string }[] | null>(null);
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
  const daily = snap.tvlUsd ? snap.tvlUsd / 100n : null;
  const days = usableUsd !== null && daily && daily > 0n && r ? Number(((usableUsd - r.liabilityUsd) * 100n) / daily) / 100 : null;
  const act = async (a: "pause" | "resume" | "checkpoint" | "approve", label: string, arg = 0n) => {
    const s: Step[] = [{ label, status: "idle" }];
    setSteps(s);
    try {
      if (await backend.admin(a as any, arg, s, setSteps)) refresh();
    } catch (e) {
      setSteps([{ ...s[0], status: "error", error: humanError(e) }]);
    }
  };
  const approveAmt = parseUnitsSafe(amt, snap.rewardDecimals);
  return (
    <>
      <section className="card">
        <b className="h2">管理后台</b>
        {!isAdmin && <div className="alert warn">{demo ? "演示：仅供查看，操作为模拟。" : "当前钱包不是管理员，链上也会拒绝操作。"}</div>}
        <p className="fine">所有权限由合约校验。合约没有提走本金、仓位NFT、手续费或修改用户奖励的接口；暂停不影响用户退出。</p>
      </section>
      <section className="card kv">
        <div><span>运营钱包</span><b className="mono">{short(snap.operator)}</b></div>
        <div><span>喜羊羊余额</span><b>{fmtUnits(r?.balance ?? null, snap.rewardDecimals)}</b></div>
        <div><span>剩余授权额度</span><b>{fmtUnits(r?.allowance ?? null, snap.rewardDecimals)}</b></div>
        <div><span>可用支付额度</span><b>{fmtUnits(r?.usable ?? null, snap.rewardDecimals)}</b></div>
        <div><span>已累计待支付（上限估算）</span><b>{fmtUnits(r?.liabilityUsd ?? null, 18)} USDT ≈ {fmtUnits(needTokens, snap.rewardDecimals)} 喜羊羊</b></div>
        <div><span>估算可支撑</span><b>{days !== null ? `${days.toFixed(1)} 天` : "—"}</b></div>
        <div><span>平台LP参考价值</span><b>{fmtUnits(snap.tvlUsd, 18)} USDT</b></div>
        <div><span>参与钱包数</span><b>{snap.participants}</b></div>
        <div><span>累计实际发放</span><b>{fmtUnits(snap.totalPaidReward, snap.rewardDecimals)} 喜羊羊</b></div>
        <div><span>喜羊羊参考价</span><b>{p ? `${fmtUnits(p, 18, 6)} USDT` : "不可用"}</b></div>
        <div><span>最近检查</span><b>{fmtTime(snap.lastCheckpoint)}</b></div>
        <div><span>运行状态</span><b className={snap.running ? "ok-t" : "err"}>{snap.running ? "运行中" : "已暂停"}</b></div>
      </section>
      <p className="fine pad">估算可支撑时间 =（可用额度折算 USDT − 已累计待支付）÷ 当前每日总额度；喜羊羊价格和平台规模变化都会改变这个数字。待支付是上限估算（含可能不分配的推荐部分）。</p>
      <StatusLine snap={snap} />
      <section className="card">
        <b>授权 / 补充授权</b>
        <p className="fine">由运营钱包直接对喜羊羊代币执行 approve（设置为新额度，有限额度，不默认无限）。补充储备：把喜羊羊转入运营钱包 {snap.operator}。</p>
        <div className="inp-row">
          <input inputMode="decimal" placeholder="新的授权额度（喜羊羊）" value={amt} onChange={(e) => setAmt(e.target.value)} />
          <button className="btn-green sm" disabled={!approveAmt || (!isAdmin && !demo)} onClick={() => act("approve", `授权 ${amt} 喜羊羊给挖矿合约`, approveAmt!)}>
            授权
          </button>
        </div>
      </section>
      <section className="card btn-col">
        <button className="btn-line wide" disabled={!isAdmin && !demo} onClick={() => act("checkpoint", "立即执行链上检查")}>立即检查（任何人可调用）</button>
        {snap.adminPaused ? (
          <button className="btn-green wide" disabled={!isAdmin && !demo} onClick={() => act("resume", "恢复（合约会先检查储备与报价）")}>恢复新增入金与计息</button>
        ) : (
          <button className="btn-line wide danger" disabled={!isAdmin && !demo} onClick={() => act("pause", "暂停新增入金与计息")}>暂停新增入金与计息</button>
        )}
        <p className="fine">恢复时合约会重新检查估值、喜羊羊报价和储备覆盖；任一不满足则保持暂停。恢复从该检查时刻开始计息，不补计暂停期间。</p>
        {steps && <Steps steps={steps} />}
      </section>
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
function IconBnb() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="#F0B90B"><path d="M12 2l3 3-3 3-3-3 3-3zm-5 5l3 3-3 3-3-3 3-3zm10 0l3 3-3 3-3-3 3-3zm-5 5l3 3-3 3-3-3 3-3zm0 5l3 3-3 3-3-3 3-3z" /></svg>);
}
