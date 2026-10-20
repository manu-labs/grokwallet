#!/usr/bin/env node
// Write app/out/_headers from the HTML in a Next.js static export.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectScriptHashes, renderHeaders } from "./page-headers.mjs";

const outDir = process.argv[2];
if (!outDir) {
  process.stderr.write("usage: write-headers.mjs <export-directory>\n");
  process.exit(2);
}

const hashes = collectScriptHashes(outDir);
if (hashes.length === 0) {
  process.stderr.write("no inline scripts found; refusing to write a CSP without hashes\n");
  process.exit(1);
}
writeFileSync(join(outDir, "_headers"), renderHeaders(hashes));
process.stdout.write(`wrote ${hashes.length} script hashes to ${join(outDir, "_headers")}\n`);
