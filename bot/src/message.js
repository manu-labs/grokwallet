import { CliError } from "./redact.js";

export const MAX_MESSAGE_CHARS = 2000;

function present(flags, name) {
  return flags[name] !== undefined && flags[name] !== true && flags[name] !== "";
}

export function resolveMessage(flags, { readFile, readStdin } = {}) {
  const hasMessage = present(flags, "message");
  const hasFile = present(flags, "message-file");
  if (hasMessage && hasFile) throw new CliError("pass --message or --message-file, not both");
  if (!hasMessage && !hasFile) throw new CliError("missing --message or --message-file");
  let message;
  if (hasFile) {
    const path = String(flags["message-file"]);
    if (path === "-") {
      if (!readStdin) throw new CliError("could not read the message from stdin");
      message = readStdin();
    } else {
      if (!readFile) throw new CliError(`could not read ${path}`);
      message = readFile(path);
    }
  } else if (flags.message === "-") {
    if (!readStdin) throw new CliError("could not read the message from stdin");
    message = readStdin();
  } else {
    message = String(flags.message);
  }
  if (typeof message !== "string") throw new CliError("message must be text");
  if (message.length === 0) throw new CliError("message is empty");
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new CliError(`message is longer than ${MAX_MESSAGE_CHARS} characters`);
  }
  return message;
}

export function summarizeMessage(chainName, address, message) {
  return `sign ${chainName} message from ${address}\n---\n${message}\n---`;
}
