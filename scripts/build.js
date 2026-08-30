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
  const entries = fs.readdirSync(target);
  packZip(target, zip, entries);
}

// Produces a real ZIP (not a tar named .zip). Prefers Info-ZIP `zip`
// (Linux/macOS/CI); otherwise libarchive's bsdtar, which also writes ZIPs.
// GNU tar is often first on PATH via Git for Windows and CANNOT write ZIPs, so
// the Windows system bsdtar is tried by full path and any tar that isn't
// bsdtar is rejected. Explicit root entries (never ".") keep manifest.json at
// the archive root, which Firefox requires.
function packZip(cwd, zip, entries) {
  try {
    execFileSync("zip", ["-qr", zip, ...entries], { cwd });
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const candidates = [];
  if (process.platform === "win32" && process.env.SystemRoot) candidates.push(path.join(process.env.SystemRoot, "System32", "tar.exe"));
  candidates.push("tar");
  for (const bin of candidates) {
    let version;
    try {
      version = execFileSync(bin, ["--version"], { encoding: "utf8" });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!/bsdtar|libarchive/i.test(version)) continue;
    // The archive path is relative to cwd because an absolute Windows path's
    // drive-letter colon (e.g. "C:\...") is otherwise read as a host:path spec.
    execFileSync(bin, ["-a", "-cf", path.relative(cwd, zip), "--options", "zip:compression=deflate", ...entries], { cwd });
    return;
  }
  throw new Error("Building the store ZIPs needs Info-ZIP `zip` or libarchive `bsdtar`; GNU tar cannot write ZIP archives.");
}
console.log(`Built Firefox and Chrome v${version}.`);
