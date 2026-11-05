// Single-file build (everything inlined): for hosts that cannot load sibling files (sandboxed viewers).
//   node build-single.mjs [demo]
import * as esbuild from "esbuild";
import fs from "node:fs";
const demo = process.argv.includes("demo");
const SITE_URL = "https://xiyangyang.winkcto.top"; // only used for the share-card image
const r = await esbuild.build({
  entryPoints: ["src/main.tsx"], bundle: true, write: false, format: "iife", minify: true, outdir: "out",
  target: ["es2020", "safari15", "chrome90"], jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
});
const js = r.outputFiles.find((f) => f.path.endsWith(".js")).text.replace(/<\/script/gi, "<\\/script");
const css = r.outputFiles.find((f) => f.path.endsWith(".css")).text;
const assets = {};
for (const f of fs.readdirSync("public/assets")) {
  const mime = f.endsWith(".png") ? "image/png" : "image/jpeg";
  assets[f] = `data:${mime};base64,` + fs.readFileSync("public/assets/" + f).toString("base64");
}
const cfg = JSON.parse(fs.readFileSync("public/config.json", "utf8"));
if (demo) cfg.mode = "demo";
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0a4a33" />
<meta name="description" content="添加 POP/USDT 流动性，每日收获喜羊羊" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
<link rel="icon" type="image/png" sizes="96x96" href="/icons/favicon-96.png" />
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
<link rel="manifest" href="/manifest.webmanifest" />
<meta property="og:title" content="喜羊羊矿场" />
<meta property="og:description" content="添加 POP/USDT 流动性，每日收获喜羊羊" />
<meta property="og:image" content="${SITE_URL}/icons/icon-512.png" />
<title>喜羊羊矿场${demo ? "（演示）" : ""}</title>
<style>${css}</style></head>
<body><div id="root"></div>
<script>window.__XYY_CONFIG__=${JSON.stringify(cfg)};window.__XYY_ASSETS__=${JSON.stringify(assets)};</script>
<script>${js}</script>
</body></html>`;
fs.mkdirSync("dist-single", { recursive: true });
fs.writeFileSync("dist-single/index.html", html);
// site icons (TokenPocket / browsers show these next to the site name); upload them next to index.html
fs.mkdirSync("dist-single/icons", { recursive: true });
for (const f of fs.readdirSync("public/icons")) {
  const to = f === "favicon.ico" || f === "apple-touch-icon.png" ? `dist-single/${f}` : `dist-single/icons/${f}`;
  fs.copyFileSync(`public/icons/${f}`, to);
  if (f === "apple-touch-icon.png") fs.copyFileSync(`public/icons/${f}`, `dist-single/icons/${f}`);
}
fs.copyFileSync("public/manifest.webmanifest", "dist-single/manifest.webmanifest");
console.log("dist-single/index.html", (html.length / 1024 / 1024).toFixed(2), "MB");
