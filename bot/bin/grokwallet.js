#!/usr/bin/env node
import { main } from "../src/cli.js";
import { CliError, DryRun, redact } from "../src/redact.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code ?? 0);
  })
  .catch((error) => {
    if (error instanceof DryRun) process.exit(0);
    const message = redact(error instanceof Error ? error.message : "command failed");
    const hint =
      error instanceof CliError && error.hint
        ? error.hint
        : "See docs/troubleshooting.md, or run grokwallet doctor.";
    process.stderr.write(`${message}\n${redact(hint)}\n`);
    if (process.env.GROKWALLET_DEBUG && error instanceof Error && error.stack) {
      process.stderr.write(`${redact(error.stack)}\n`);
    }
    process.exit(error && Number.isInteger(error.exitCode) ? error.exitCode : 1);
  });
