#!/usr/bin/env node
// Fail unless the built _headers matches the HTML and carries the CSP and X-Frame-Options.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPolicy, collectScriptHashes, renderHeaders } from "./page-headers.mjs";

const outDir = process.argv[2];
if (!outDir) {
  process.stderr.write("usage: check-headers.mjs <export-directory>\n");
  process.exit(2);
}

const path = join(outDir, "_headers");
const actual = readFileSync(path, "utf8");
const expected = renderHeaders(collectScriptHashes(outDir));
const problems = assertPolicy(actual);
if (actual !== expected) problems.push("_headers does not match the inline scripts in this export");
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.exit(1);
}
process.stdout.write(`_headers ok (${path})\n`);
