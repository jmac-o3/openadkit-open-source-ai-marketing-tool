#!/usr/bin/env node
/**
 * Stamp the service worker with the current git SHA so each deploy invalidates
 * the previous shell cache. Without this, sw.js ships with a hardcoded VERSION
 * string that never changes across deploys → the activate-phase cleanup never
 * deletes the old cache and users get stale UI shells. (Audit finding #38.)
 *
 * Wired into package.json `postbuild` so it runs automatically after `next build`.
 * Reads the SHA from NEXT_PUBLIC_BUILD_ID (Vercel sets this), falling back to
 * `git rev-parse --short HEAD`. Writes back to public/sw.js in place.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SW_PATH = path.join(__dirname, "..", "public", "sw.js");

function resolveBuildId() {
  if (process.env.NEXT_PUBLIC_BUILD_ID) return process.env.NEXT_PUBLIC_BUILD_ID;
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12);
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return String(Date.now());
  }
}

// Matches the VERSION declaration whatever it currently holds — the raw
// __BUILD_ID__ token on a fresh checkout, or a SHA from a previous build.
const VERSION_RE = /const VERSION = "[^"]*";/;

function main() {
  const buildId = resolveBuildId();
  const sw = fs.readFileSync(SW_PATH, "utf8");

  // Rewrite the VERSION line rather than substituting a one-shot token.
  //
  // The original implementation replaced __BUILD_ID__ in place, which consumed
  // the token: the FIRST build stamped a SHA, and every build afterwards found
  // no token and bailed with "skipping". public/sw.js is committed, so the
  // stale SHA was then shipped on every subsequent deploy — meaning VERSION
  // never changed, the activate handler's `keys.filter(k => k !== VERSION)`
  // never matched anything, and no old cache was ever deleted. That is exactly
  // the stale-shell bug this script exists to prevent. Matching on the line
  // makes it idempotent and re-runnable.
  if (!VERSION_RE.test(sw)) {
    console.error(`[sw-stamp] FAILED: no \`const VERSION = "…";\` line in ${SW_PATH}.`);
    console.error("[sw-stamp] The service worker cache would never invalidate. Fix sw.js.");
    process.exit(1);
  }
  const next = `const VERSION = "openadkit-${buildId}";`;
  const stamped = sw.replace(VERSION_RE, next);
  if (stamped === sw) {
    console.log(`[sw-stamp] sw.js already at openadkit-${buildId}, nothing to do.`);
    return;
  }
  fs.writeFileSync(SW_PATH, stamped, "utf8");
  console.log(`[sw-stamp] sw.js VERSION → openadkit-${buildId}`);
}

main();
