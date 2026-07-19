import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `ex login` state (ADR 0006): where the server is, nothing more. */
export interface ExConfig {
  /** ssh destination, e.g. `root@vps.example.com`. */
  target?: string;
  /** Remote EXHIBIT_ROOT override, when the server uses a non-default root. */
  root?: string;
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  if (env.EXHIBIT_CONFIG) return env.EXHIBIT_CONFIG;
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "exhibit", "config.toml");
}

export function readConfig(path = configPath()): ExConfig {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const get = (key: string) => text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, "m"))?.[1];
  return { target: get("target"), root: get("root") };
}

export function writeConfig(config: ExConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  let text = "";
  if (config.target) text += `target = "${config.target}"\n`;
  if (config.root) text += `root = "${config.root}"\n`;
  writeFileSync(path, text);
}
