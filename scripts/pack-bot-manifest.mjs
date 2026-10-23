import { writeManifest } from "../bot/src/verify.js";

const root = process.argv[2];
if (!root) {
  process.stderr.write("usage: pack-bot-manifest.mjs <bot-directory>\n");
  process.exit(1);
}
writeManifest(root);
