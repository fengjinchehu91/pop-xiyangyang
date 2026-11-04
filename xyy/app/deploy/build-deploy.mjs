// Builds deploy/deploy.html: one self-contained page (ethers + contract bytecode inlined).
//   node deploy/build-deploy.mjs      (reads deploy-artifact.json exported from contracts/out)
import fs from "node:fs";
const tpl = fs.readFileSync(new URL("./deploy.template.html", import.meta.url), "utf8");
const ethers = fs.readFileSync(new URL("../src/vendor/ethers.umd.min.js", import.meta.url), "utf8").replace(/<\/script/gi, "<\\/script");
const art = fs.readFileSync(new URL("../deploy-artifact.json", import.meta.url), "utf8");
const out = tpl.replace("<script>/*ETHERS*/</script>", () => `<script>${ethers}</script>`).replace("/*ARTIFACT*/", () => art);
fs.writeFileSync(new URL("./deploy.html", import.meta.url), out);
console.log("deploy/deploy.html", (out.length / 1024).toFixed(0), "KB");
