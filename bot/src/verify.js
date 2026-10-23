import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./redact.js";

export function installRoot() {
  return fileURLToPath(new URL("..", import.meta.url));
}

export function packageVersion(root = installRoot()) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = String(pkg.version || "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new CliError("package.json has no version");
  return version;
}

function skip(rel) {
  const parts = rel.split("/");
  if (parts.includes(".cache") && parts.includes("node_modules")) return true;
  if (rel === "SHA256SUMS") return true;
  return false;
}

export function listInstallFiles(root) {
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join("/");
      if (skip(rel)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || stat.isFile()) files.push(rel);
      else if (stat.isDirectory()) walk(path);
    }
  }
  walk(root);
  files.sort();
  return files;
}

export function hashInstallFile(root, rel) {
  if (rel.startsWith("/") || rel.split("/").includes("..")) {
    throw new CliError("manifest path escapes the install directory");
  }
  const path = join(root, rel);
  const stat = lstatSync(path);
  const hash = createHash("sha256");
  if (stat.isSymbolicLink()) {
    hash.update("symlink\0");
    hash.update(readlinkSync(path));
  } else {
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

export function manifestText(root) {
  const lines = listInstallFiles(root).map((rel) => `${hashInstallFile(root, rel)}  ${rel}`);
  return `${lines.join("\n")}\n`;
}

export function writeManifest(root) {
  const text = manifestText(root);
  writeFileSync(join(root, "SHA256SUMS"), text, { mode: 0o644 });
  return text;
}

export function verifyInstall(root = installRoot()) {
  let text;
  try {
    text = readFileSync(join(root, "SHA256SUMS"), "utf8");
  } catch {
    throw new CliError(
      "this install has no SHA256SUMS manifest",
      1,
      "Install the published grokwallet-bot tarball. A git checkout does not include the release manifest.",
    );
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) {
    throw new CliError("SHA256SUMS is empty", 1, "Reinstall the published tarball and run grokwallet verify again.");
  }
  const problems = [];
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) {
      problems.push("manifest line is not sha256sum format");
      continue;
    }
    const [, expected, rel] = match;
    let actual;
    try {
      actual = hashInstallFile(root, rel);
    } catch {
      problems.push(`missing ${rel}`);
      continue;
    }
    if (actual !== expected) problems.push(`changed ${rel}`);
  }
  if (problems.length > 0) {
    throw new CliError(
      `verify failed: ${problems.slice(0, 5).join("; ")}`,
      1,
      "Re-download grokwallet-bot.tar.gz and SHA256SUMS, run sha256sum -c, and extract again. Do not mix this tree with another install.",
    );
  }
  return lines.length;
}
