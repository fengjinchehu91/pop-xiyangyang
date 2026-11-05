# 自动检查服务（Cloudflare Workers 版）

放在 Cloudflare 上运行，不需要服务器。每 10 分钟自动运行一次：

1. **更新价格并检查**（调用合约 `checkpoint()`）：上次检查超过 25 分钟就做一次；如果合约的运行状态需要变化（运营钱包喜羊羊不够要暂停，或者补够了要恢复），这一次马上做。
2. **结算推荐奖励**（调用合约 `settleMany()`）：给“有推荐人、有本金”的钱包结算，让上级的动态收益到账。人少时每小时一次，人越多间隔越长（20 个钱包以内每小时，100 个约每 5 小时，480 个以上每天一次），手续费基本不会随人数一直涨。

检查钱包在合约里**没有任何特殊权限**，这两个函数谁都能调用，也动不了任何人的钱。它只需要一点 BNB 付手续费。

**检查钱包是程序自己创建的**：第一次运行时在 Cloudflare 里生成一个新钱包，密钥只保存在这个 Worker 自己的 KV 存储里，任何页面都不会显示，也不需要任何人复制粘贴私钥。管理后台的“自动检查服务”卡片会显示它的地址，往这个地址转 0.05 BNB 就会开始工作。（如果想用自己的钱包，也可以设置机密 `KEEPER_KEY`；程序发现填的是运营钱包或管理员钱包的私钥时会拒绝运行。）

## 现在的部署方式

和网站是同一个 Cloudflare Worker（`pop-xiyangyang`），由仓库根目录的 `wrangler.jsonc` 配置：网站文件在 `site/`，程序是 `keeper-cf/dist/worker.js`，每 10 分钟的定时任务和 KV 存储（`STATE`，首次部署时自动创建）都写在配置里。往 GitHub 推送后 Cloudflare 自动重新部署，不需要进后台设置。状态页：`你的域名/keeper`。

## 文件

```
src/worker.js        全部逻辑（读链、决定要不要发交易、签名、发送、状态页）
src/cf-entry.js      给 Cloudflare 用的入口（只导出 default）
vendor/              noble-secp256k1 3.2.0、noble-hashes 2.4.0（MIT，原样拷贝，用于签名和哈希）
build.mjs            打包：dist/worker.js（粘贴到 Cloudflare 的就是这个）
test/unit.mjs        签名、编码和 ethers 逐字节对比
test/integration.mjs 本地链完整场景（需要 Foundry：anvil / forge / cast）
test/smoke-cf.mjs    用 Cloudflare 的调用方式测试 dist/worker.js
test/cpu.mjs         测量每次运行的 CPU 时间
```

## 修改后重新打包

```bash
cd keeper-cf
npm install
npm run build          # 生成 dist/worker.js
npm run test:unit
```

把新的 `dist/worker.js` 提交到 GitHub，Cloudflare 会自动重新部署。

## 可以在 Cloudflare“变量和机密”里改的设置（都可以不填）

| 名称 | 默认 | 作用 |
|---|---|---|
| `KEEPER_KEY` | 不填（程序自己创建钱包） | 想用自己的检查钱包时填，类型选“密钥” |
| `MINER` | 0x363CBA25…7E17 | 挖矿合约地址（重新部署合约后要改） |
| `DEPLOY_BLOCK` | 131739316 | 合约部署区块 |
| `RPC_URL` / `RPC_URL_2` | publicnode / bnbchain 官方 | BSC 节点，第一个连不上自动用第二个 |
| `CHECK_MINUTES` | 25 | 最多隔多久更新一次价格 |
| `SETTLE_HOURS` | 自动 | 想固定间隔就填小时数，比如 `6` |
| `MAX_GAS_GWEI` | 1 | 手续费单价上限 |

KV 绑定和定时任务已经写在 `wrangler.jsonc` 里，不用手动设置。

## 免费版限制和应对

Cloudflare 免费版每次运行最多 10 毫秒 CPU、50 次网络请求。程序的做法：
- 签名用到的耗时计算放在启动阶段完成（启动阶段另有 1 秒额度），每次运行只用几毫秒；
- 先发最重要的“检查”交易，再做结算；结算每次最多 2 笔，每笔最多 100 个钱包，剩下的下次继续；
- 如果某次运行被中途掐断，下次会发现并自动减少每次的工作量，状态页上会写出来。

如果状态页经常出现“中途被中断”，可以把 Workers 升级到付费版（每月 5 美元，单次 CPU 上限 30 秒）。
