import { CliError } from "./redact.js";
import {
  addresses,
  balance,
  cap,
  HELP,
  login,
  logout,
  sendErc20,
  sendEth,
  sendSol,
  signMessage,
  signTypedData,
  status,
} from "./commands.js";
import { walletConnectCommand } from "./wc/commands.js";

export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      setFlag(flags, body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) setFlag(flags, body, true);
    else {
      setFlag(flags, body, next);
      i += 1;
    }
  }
  return { command: positionals[0], rest: positionals.slice(1), flags };
}

function setFlag(flags, key, value) {
  if (!Object.prototype.hasOwnProperty.call(flags, key)) {
    flags[key] = value;
    return;
  }
  const current = flags[key];
  flags[key] = Array.isArray(current) ? current.concat([value]) : [current, value];
}

export async function main(argv) {
  const { command, rest, flags } = parseArgs(argv);
  if (!command || command === "help" || flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  switch (command) {
    case "login":
      await login();
      return 0;
    case "status":
      status();
      return 0;
    case "addresses":
      await addresses();
      return 0;
    case "balance":
      await balance(flags);
      return 0;
    case "send-eth":
      await sendEth(flags);
      return 0;
    case "send-erc20":
      await sendErc20(flags);
      return 0;
    case "send-sol":
      await sendSol(flags);
      return 0;
    case "sign-message":
      await signMessage(flags);
      return 0;
    case "sign-typed-data":
      await signTypedData(flags);
      return 0;
    case "cap":
      cap(rest, flags);
      return 0;
    case "wc":
      return (await walletConnectCommand(rest, flags)) || 0;
    case "logout":
      logout();
      return 0;
    default:
      throw new CliError(`unknown command ${command}`);
  }
}
