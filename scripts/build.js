const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const version = require(path.join(root, "package.json")).version;
if (!fs.existsSync(path.join(root, "shared", "top-sites.js"))) throw new Error("Run the top-sites catalog generator before building.");
for (const browser of ["firefox", "chrome"]) {
  const target = path.join(root, "build", browser);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(root, "shared"), target, { recursive: true });
  fs.copyFileSync(path.join(root, browser, "manifest.json"), path.join(target, "manifest.json"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  const zip = path.join(root, "dist", `organizer-${browser}-v${version}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync("zip", ["-qr", zip, "."], { cwd: target });
}
console.log(`Built Firefox and Chrome v${version}.`);
