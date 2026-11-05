import { build } from "esbuild";
const banner = `// 喜羊羊矿场 · 自动检查服务（Cloudflare Workers 版）
// 用法：把这个文件的全部内容粘贴到 Cloudflare Worker 的代码编辑器里（替换原来的全部内容），然后点“部署”。
// 需要：机密 KEEPER_KEY（新建的检查钱包私钥，只放少量 BNB）+ KV 绑定 STATE + Cron 触发器 */10 * * * *
// 包含的开源库：noble-secp256k1 3.2.0、noble-hashes 2.4.0（MIT 许可，Paul Miller）。`;
const common = { bundle: true, format: "esm", target: "es2022", platform: "neutral", legalComments: "inline", logLevel: "warning" };
// what goes to Cloudflare (default export only)
await build({ ...common, entryPoints: ["src/cf-entry.js"], outfile: "dist/worker.js", banner: { js: banner } });
// same code with named exports, for the tests
await build({ ...common, entryPoints: ["src/worker.js"], outfile: "dist/worker.test.mjs" });
console.log("ok");
