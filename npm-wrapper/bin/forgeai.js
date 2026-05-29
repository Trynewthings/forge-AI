#!/usr/bin/env node
/*
 * Tiny wrapper around the precompiled `forge` binary. On first run it
 * detects the host platform, downloads the matching archive from the
 * project's GitHub Release for our package.json version, caches it in
 * ~/.forgeai/binaries/v<version>/, and execs it with the user's args.
 *
 * Design choices, briefly:
 *  - Lazy download (not a postinstall) so `npx forgeai` works even when
 *    postinstall scripts are disabled (newer npm + corporate proxies).
 *  - We cache by version so reinstalling the same version is free, and
 *    different versions can coexist.
 *  - We extract the zip in-process via the system `unzip` command rather
 *    than pulling a Node unzip lib — keeps the dependency tree at zero.
 *    macOS, Linux, and Git-Bash on Windows all ship with `unzip`.
 *  - We replace this process via spawnSync inheriting stdio so signals
 *    (Ctrl-C) reach the binary cleanly; no `process.on('SIGINT')`
 *    plumbing is needed.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawnSync, execFileSync } = require("child_process");

const VERSION = require("../package.json").version;
// TODO before publishing: point this at the real GH org/repo. The npm
// package itself is platform-agnostic; only this URL needs updating.
const RELEASE_BASE = `https://github.com/Trynewthings/forge-AI/releases/download/v${VERSION}`;

function detectPlatform() {
  const platform = process.platform; // 'darwin' | 'linux' | 'win32' | ...
  const arch = process.arch;         // 'arm64' | 'x64' | ...
  // Map Node's names → our release artifact suffix.
  const archMap = { x64: "x86_64", arm64: "arm64" };
  const platMap = { darwin: "darwin", linux: "linux" };
  const platOut = platMap[platform];
  const archOut = archMap[arch];
  if (!platOut || !archOut) {
    fail(
      `Unsupported platform/arch: ${platform}/${arch}.\n` +
        `Forge currently ships binaries for darwin-arm64, darwin-x86_64, linux-x86_64.\n` +
        `Open an issue if you'd like another target.`,
    );
  }
  return { platform: platOut, arch: archOut };
}

function cacheRoot() {
  const home = os.homedir() || os.tmpdir();
  return path.join(home, ".forgeai", "binaries", `v${VERSION}`);
}

function binaryPath() {
  return path.join(cacheRoot(), process.platform === "win32" ? "forge.exe" : "forge");
}

function fail(msg) {
  process.stderr.write("forgeai: " + msg + "\n");
  process.exit(1);
}

async function downloadIfNeeded() {
  const bin = binaryPath();
  if (fs.existsSync(bin)) return bin;

  const { platform, arch } = detectPlatform();
  const archiveName = `forge-v${VERSION}-${platform}-${arch}.zip`;
  const url = `${RELEASE_BASE}/${archiveName}`;

  fs.mkdirSync(cacheRoot(), { recursive: true });
  const tmpZip = path.join(cacheRoot(), archiveName);

  process.stderr.write(`forgeai: downloading ${archiveName}…\n`);
  try {
    await download(url, tmpZip);
  } catch (err) {
    fail(
      `download failed: ${err.message}\n` +
        `URL: ${url}\n` +
        `If the release hasn't been published yet, try:\n` +
        `  • download manually from https://github.com/Trynewthings/forge-AI/releases\n` +
        `  • extract to ${cacheRoot()}/`,
    );
  }

  process.stderr.write(`forgeai: extracting…\n`);
  try {
    // -j strips the inner folder; -o overwrite without prompt;
    // -d targets the dir. `unzip` exits 0 on success.
    execFileSync("unzip", ["-jo", tmpZip, "-d", cacheRoot()], { stdio: "ignore" });
  } catch (err) {
    fail(
      `extraction failed (is \`unzip\` installed?): ${err.message}\n` +
        `Manual fix: unzip ${tmpZip} into ${cacheRoot()}/`,
    );
  }
  fs.unlinkSync(tmpZip);

  if (!fs.existsSync(bin)) {
    fail(
      `archive extracted but binary missing at ${bin}.\n` +
        `Expected the zip's inner \`forge\` executable.`,
    );
  }
  // chmod +x — npm doesn't preserve unix perms reliably across the zip.
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    /* best-effort */
  }
  return bin;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const followingRedirects = (current, hops) => {
      if (hops > 10) return reject(new Error("too many redirects"));
      https
        .get(current, (res) => {
          // GitHub Release downloads send a 302 to S3 / fastly. Chase
          // the Location header until we land on a 200.
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume(); // drain
            followingRedirects(res.headers.location, hops + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on("finish", () => file.close(() => resolve()));
          file.on("error", (err) => {
            fs.unlink(dest, () => {});
            reject(err);
          });
        })
        .on("error", reject);
    };
    followingRedirects(url, 0);
  });
}

async function main() {
  const bin = await downloadIfNeeded();
  // Hand off — inheriting stdio so the agent's terminal output reaches
  // the user, and so Ctrl-C / SIGTERM propagate to the binary directly
  // (Node doesn't intercept those when using `inherit`).
  const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
  if (result.error) fail(`exec failed: ${result.error.message}`);
  process.exit(result.status ?? 0);
}

main().catch((err) => fail(err.stack || err.message));
