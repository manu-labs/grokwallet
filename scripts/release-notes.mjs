import { readFileSync } from "node:fs";
import { changelogSection } from "../bot/src/release-notes.js";

const version = process.argv[2] || "";
const markdown = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
process.stdout.write(changelogSection(markdown, version));
