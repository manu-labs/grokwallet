import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveMessage, summarizeMessage } from "../src/message.js";

test("message file and stdin keep real line breaks", () => {
  const dir = mkdtempSync(join(tmpdir(), "grokwallet-msg-"));
  const file = join(dir, "lighter.txt");
  const text = "register lighter\npublic key: abc\nnonce: 1\n";
  writeFileSync(file, text);
  const fromFile = resolveMessage(
    { chain: "ethereum", "message-file": file },
    { readFile: (path) => readFileSync(path, "utf8") },
  );
  assert.equal(fromFile, text);
  const fromStdin = resolveMessage(
    { chain: "ethereum", "message-file": "-" },
    { readStdin: () => "line1\nline2" },
  );
  assert.equal(fromStdin, "line1\nline2");
  assert.equal(resolveMessage({ message: "-" }, { readStdin: () => "a\nb" }), "a\nb");
  const summary = summarizeMessage("ethereum", "0xabc", fromFile);
  assert.match(summary, /sign ethereum message from 0xabc\n---\nregister lighter\npublic key: abc\nnonce: 1\n\n---/);
  assert.throws(() => resolveMessage({ message: "hello", "message-file": file }, { readFile: () => text }));
  assert.throws(() => resolveMessage({}));
});
