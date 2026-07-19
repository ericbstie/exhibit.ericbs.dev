#!/usr/bin/env bun
/**
 * `ex` — the laptop CLI (spec #20). Every remote subcommand shells out to the
 * system `ssh` and execs `exhibit-server` on the VPS (ADR 0006): the deploy
 * archive streams over stdin, NDJSON step-events stream back over stdout.
 */
import pkg from "../../package.json";
import type { DeployEvent } from "../server/events.ts";
import { quoteWord } from "../shared/words.ts";
import { readConfig, writeConfig } from "./config.ts";

const USAGE = `ex ${pkg.version} — publish webapps instantly with ease

Usage:
  ex login <ssh-target> [--root <remote-exhibit-root>]
  ex deploy --domain <domain> [-- <run command>]
  ex ls
  ex logs <domain> [--follow] [-n <lines>]
  ex --help | --version
`;

function requireTarget(): { target: string; root?: string } {
  const config = readConfig();
  if (!config.target) {
    console.error("no server configured — run `ex login <ssh-target>` first");
    process.exit(2);
  }
  return { target: config.target, root: config.root };
}

/** Build the remote command string ssh will hand to the login shell. */
function remoteCommand(root: string | undefined, words: string[]): string {
  const prefix = root ? `EXHIBIT_ROOT=${quoteWord(root)} ` : "";
  return prefix + words.map(quoteWord).join(" ");
}

function cmdLogin(args: string[]): number {
  const target = args.find((a) => !a.startsWith("-"));
  if (!target) {
    console.error("login requires <ssh-target>");
    return 2;
  }
  const rootFlag = args.indexOf("--root");
  const root = rootFlag !== -1 ? args[rootFlag + 1] : undefined;
  writeConfig({ target, root });
  console.log(`logged in to ${target}${root ? ` (root ${root})` : ""}`);
  return 0;
}

function renderEvent(line: string): void {
  let event: DeployEvent;
  try {
    event = JSON.parse(line);
  } catch {
    console.log(line);
    return;
  }
  if (event.event === "step") {
    const detail = "detail" in event && event.detail ? ` (${event.detail})` : "";
    if (event.status === "start") console.log(`→ ${event.step}`);
    else if (event.status === "ok") console.log(`✓ ${event.step}${detail}`);
    else if (event.status === "skip") console.log(`- ${event.step}${detail}`);
    else console.log(`✗ ${event.step}${detail}`);
  } else if (event.event === "deployed") {
    console.log(`deployed ${event.domain} — release ${event.release} → ${event.target}`);
    console.log(`try: curl http://${event.domain}`);
  } else if (event.event === "error") {
    console.error(`deploy failed: ${event.message}`);
  } else {
    console.log(line);
  }
}

async function cmdDeploy(args: string[]): Promise<number> {
  let domain: string | undefined;
  let runCmd: string[] = [];
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
  const { target, root } = requireTarget();

  const head = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], { stdout: "ignore" });
  if (head.exitCode !== 0) {
    console.error("not a git repository with a commit — `ex deploy` ships `git archive HEAD`");
    return 2;
  }
  // Only committed content deploys; a dirty tree is a warning, not an error.
  const status = Bun.spawnSync(["git", "status", "--porcelain"]);
  if (status.stdout.toString().trim() !== "") {
    console.error("warning: working tree is dirty — deploying committed HEAD only");
  }

  const words = ["exhibit-server", "deploy", "--domain", domain];
  if (runCmd.length > 0) words.push("--", ...runCmd);

  const archive = Bun.spawn(["git", "archive", "HEAD"], { stdout: "pipe", stderr: "inherit" });
  const ssh = Bun.spawn(["ssh", target, remoteCommand(root, words)], {
    stdin: archive.stdout,
    stdout: "pipe",
    stderr: "inherit",
  });

  // Relay the server's NDJSON step-events as live progress.
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of ssh.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      renderEvent(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  if (buffer.trim()) renderEvent(buffer);

  const [archiveCode, sshCode] = await Promise.all([archive.exited, ssh.exited]);
  if (archiveCode !== 0) {
    console.error(`git archive exited ${archiveCode}`);
    return 1;
  }
  return sshCode;
}

async function relay(words: string[]): Promise<number> {
  const { target, root } = requireTarget();
  const proc = Bun.spawn(["ssh", target, remoteCommand(root, words)], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "login":
      return cmdLogin(rest);
    case "deploy":
      return cmdDeploy(rest);
    case "ls":
      return relay(["exhibit-server", "ls"]);
    case "logs": {
      const domain = rest.find((a) => !a.startsWith("-"));
      if (!domain) {
        console.error("logs requires <domain>");
        return 2;
      }
      const words = ["exhibit-server", "logs", domain];
      if (rest.includes("--follow") || rest.includes("-f")) words.push("--follow");
      const n = rest.indexOf("-n");
      if (n !== -1 && rest[n + 1]) words.push("-n", rest[n + 1]!);
      return relay(words);
    }
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
