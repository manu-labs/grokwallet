#!/usr/bin/env node
// Compare HTTP response bodies to a hash-tree manifest.
// usage: node scripts/verify-site.mjs <base-url> <manifest>
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const base = process.argv[2];
const manifestPath = process.argv[3];
if (!base || !manifestPath) {
  process.stderr.write("usage: verify-site.mjs <base-url> <manifest>\n");
  process.exit(2);
}

const root = base.replace(/\/+$/, "");
const lines = readFileSync(manifestPath, "utf8").split("\n").filter((line) => line.length > 0);
let failed = 0;
let skipped = 0;

for (const line of lines) {
  const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
  if (!match) {
    process.stderr.write(`bad manifest line: ${line}\n`);
    process.exit(1);
  }
  const expected = match[1];
  const rel = match[2];
  const url = `${root}/${rel.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
  let response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
  } catch (error) {
    process.stderr.write(`FAIL fetch ${rel}: ${error instanceof Error ? error.message : "request failed"}\n`);
    failed += 1;
    continue;
  }
  if (!response.ok) {
    if (rel === "_headers" && (response.status === 404 || response.status === 403)) {
      process.stderr.write("skip _headers: this host did not serve the Cloudflare Pages config file\n");
      skipped += 1;
      continue;
    }
    process.stderr.write(`FAIL ${response.status} ${rel}\n`);
    failed += 1;
    continue;
  }
  const hash = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
  if (hash !== expected) {
    process.stderr.write(`FAIL hash ${rel}\n`);
    failed += 1;
    continue;
  }
  if (process.env.VERIFY_SITE_VERBOSE === "1") process.stdout.write(`ok ${rel}\n`);
}

if (failed > 0) {
  process.stderr.write(`${failed} of ${lines.length} file(s) did not match ${root}\n`);
  process.exit(1);
}
process.stdout.write(`matched ${lines.length - skipped - failed} files at ${root}\n`);
