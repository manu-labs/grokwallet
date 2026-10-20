#!/usr/bin/env node
import { main } from "../src/cli.js";
import { redact } from "../src/redact.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code ?? 0);
  })
  .catch((error) => {
    const message = redact(error instanceof Error ? error.message : "command failed");
    process.stderr.write(`${message}\n`);
    process.exit(error && Number.isInteger(error.exitCode) ? error.exitCode : 1);
  });
