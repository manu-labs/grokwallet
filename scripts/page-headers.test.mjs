import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertPolicy, inlineScriptBodies, renderHeaders, scriptHash } from "./page-headers.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

test("hashes inline scripts and ignores external ones", () => {
  const html = '<script src="/app.js"></script><script>(self.__next_f=self.__next_f||[]).push([0])</script>';
  const bodies = inlineScriptBodies(html);
  assert.deepEqual(bodies, ["(self.__next_f=self.__next_f||[]).push([0])"]);
  assert.match(scriptHash(bodies[0]), /^'sha256-[A-Za-z0-9+/]+=*'$/);
});

test("rendered headers carry the CSP and X-Frame-Options", () => {
  const html = "<script>var approval = 1;</script>";
  const text = renderHeaders([scriptHash("var approval = 1;")]);
  assert.deepEqual(assertPolicy(text), []);
  assert.equal(inlineScriptBodies(html).length, 1);
  assert.equal(text.includes(scriptHash("var approval = 1;")), true);
  assert.equal(text.includes("X-Frame-Options: DENY"), true);
  assert.equal(text.includes("frame-ancestors 'none'"), true);
  assert.match(text, /\/oauth\/\*/);
  assert.match(text, /\/mcp\/\*/);
  assert.ok(text.indexOf("X-Frame-Options: DENY") < text.indexOf("/oauth/*"));
});

test("a policy without X-Frame-Options is rejected", () => {
  const text = renderHeaders([scriptHash("var approval = 1;")]).replace("  X-Frame-Options: DENY\n", "");
  assert.ok(assertPolicy(text).includes("missing X-Frame-Options: DENY"));
});

test("write-headers output passes check-headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "grokwallet-headers-"));
  writeFileSync(join(dir, "index.html"), "<!DOCTYPE html><script>var approval = 1;</script><script src=\"/a.js\"></script>");
  const wrote = spawnSync(process.execPath, [join(here, "write-headers.mjs"), dir], { encoding: "utf8" });
  assert.equal(wrote.status, 0, wrote.stderr);
  const checked = spawnSync(process.execPath, [join(here, "check-headers.mjs"), dir], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  const file = readFileSync(join(dir, "_headers"), "utf8");
  assert.match(file, /Content-Security-Policy:/);
  assert.match(file, /X-Frame-Options: DENY/);
});
