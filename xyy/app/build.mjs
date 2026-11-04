// Build: node build.mjs [--watch] [--serve]
// Uses esbuild. Dependencies: react, react-dom (npm install) — ethers v6 and qrcodegen are vendored in src/vendor.
import * as esbuild from "esbuild";
import fs from "node:fs";
const watch = process.argv.includes("--watch") || process.argv.includes("--serve");
fs.mkdirSync("dist", { recursive: true });
fs.cpSync("public", "dist", { recursive: true });
const opts = {
  entryPoints: { app: "src/main.tsx" },
  bundle: true,
  format: "esm",
  outdir: "dist",
  minify: !watch,
  sourcemap: watch,
  target: ["es2020", "safari15", "chrome90"],
  jsx: "automatic",
  loader: { ".png": "file" },
  nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(":") : [],
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
  logLevel: "info",
};
if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  if (process.argv.includes("--serve")) {
    const { port } = await ctx.serve({ servedir: "dist", port: 5173, host: "0.0.0.0" });
    console.log(`http://localhost:${port}/?mode=demo`);
  }
} else {
  await esbuild.build(opts);
}
