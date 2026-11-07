// Builds the deploy pages: self-contained (ethers + contract bytecode inlined).
//   node deploy/build-deploy.mjs
//     deploy/deploy.html       <- deploy.template.html + ../deploy-artifact.json       (XiyangMiner)
//     deploy/deploy-lock.html  <- deploy-lock.template.html + ../deploy-lock-artifact.json (XiyangLock)
import fs from "node:fs";
const ethers = fs.readFileSync(new URL("../src/vendor/ethers.umd.min.js", import.meta.url), "utf8").replace(/<\/script/gi, "<\\/script");
for (const [tplName, artName, outName] of [
  ["deploy.template.html", "../deploy-artifact.json", "deploy.html"],
  ["deploy-lock.template.html", "../deploy-lock-artifact.json", "deploy-lock.html"],
]) {
  const artUrl = new URL(artName, import.meta.url);
  if (!fs.existsSync(artUrl)) { console.log("skip", outName, "(no", artName + ")"); continue; }
  const tpl = fs.readFileSync(new URL("./" + tplName, import.meta.url), "utf8");
  const art = fs.readFileSync(artUrl, "utf8");
  const out = tpl.replace("<script>/*ETHERS*/</script>", () => `<script>${ethers}</script>`).replace("/*ARTIFACT*/", () => art);
  fs.writeFileSync(new URL("./" + outName, import.meta.url), out);
  console.log("deploy/" + outName, (out.length / 1024).toFixed(0), "KB");
}
