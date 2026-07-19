#!/usr/bin/env bun
/**
 * `exhibit-server` — the single VPS-side entry point (spec #20). Invoked
 * directly or as the SSH forced-command target (ADR 0006), in which case the
 * requested subcommand arrives via SSH_ORIGINAL_COMMAND. The privilege split
 * (unprivileged front-end ↔ root exhibitd) lands behind this seam later.
 */
import { basename } from "node:path";
import pkg from "../../package.json";
import { splitWords } from "../shared/words.ts";
import { deployOp } from "./deploy.ts";
import { stdoutEmitter } from "./events.ts";
import { resolveTarget, targetString } from "./net.ts";
import { serverEnv } from "./paths.ts";
import { currentRelease, listApps, listReleases } from "./releases.ts";
import { unitName } from "./systemd.ts";

const USAGE = `exhibit-server ${pkg.version}

Usage:
  exhibit-server deploy --domain <domain> [-- <run command>]   (archive on stdin)
  exhibit-server ls
  exhibit-server logs <domain> [--follow] [-n <lines>]
  exhibit-server --help | --version
`;

function argvWords(): string[] {
  const args = process.argv.slice(2);
  if (args.length > 0) return args;
  const forced = process.env.SSH_ORIGINAL_COMMAND;
  if (!forced) return [];
  let words = splitWords(forced);
  // Accept an env-assignment prefix (e.g. EXHIBIT_ROOT=/x exhibit-server …).
  while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const eq = words[0].indexOf("=");
    process.env[words[0].slice(0, eq)] = words[0].slice(eq + 1);
    words = words.slice(1);
  }
  if (words[0] && basename(words[0]) === "exhibit-server") words = words.slice(1);
  return words;
}

async function cmdDeploy(args: string[]): Promise<number> {
  let domain: string | undefined;
  let runCmd: string[] = ["mise", "run", "production"];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--domain") {
      domain = args[++i];
    } else if (arg === "--") {
      runCmd = args.slice(i + 1);
      break;
    } else {
      console.error(`unknown argument: ${arg}`);
      return 2;
    }
  }
  if (!domain) {
    console.error("deploy requires --domain <domain>");
    return 2;
  }
  if (runCmd.length === 0) {
    console.error("empty run command after --");
    return 2;
  }
  try {
    return await deployOp(domain, runCmd, serverEnv(), stdoutEmitter);
  } catch (err) {
    stdoutEmitter({ event: "error", message: err instanceof Error ? err.message : String(err) });
    return 1;
  }
}

function cmdLs(): number {
  const env = serverEnv();
  for (const domain of listApps(env.appsDir)) {
    const target = resolveTarget(env.appsDir, domain);
    console.log(`${domain}${target ? `  ${targetString(target)}` : ""}`);
    const current = currentRelease(env.appsDir, domain);
    for (const release of listReleases(env.appsDir, domain)) {
      console.log(`${release === current ? "*" : " "} ${release}`);
    }
  }
  return 0;
}

async function cmdLogs(args: string[]): Promise<number> {
  const domain = args.find((a) => !a.startsWith("-"));
  if (!domain) {
    console.error("logs requires <domain>");
    return 2;
  }
  const jargs = ["-u", unitName(domain), "--no-pager", "-o", "cat"];
  const n = args.indexOf("-n");
  jargs.push("-n", n !== -1 && args[n + 1] ? args[n + 1]! : "100");
  if (args.includes("--follow") || args.includes("-f")) jargs.push("-f");
  const proc = Bun.spawn(["journalctl", ...jargs], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

async function main(): Promise<number> {
  const words = argvWords();
  const [cmd, ...rest] = words;
  switch (cmd) {
    case "deploy":
      return cmdDeploy(rest);
    case "ls":
      return cmdLs();
    case "logs":
      return cmdLogs(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return cmd === undefined ? 2 : 0;
    case "--version":
    case "-v":
      console.log(pkg.version);
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n${USAGE}`);
      return 2;
  }
}

process.exit(await main());
