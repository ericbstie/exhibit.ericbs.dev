/**
 * The `deploy --domain <domain> [-- <run command>]` argument shape, parsed
 * identically on both ends of the SSH boundary (`ex` sends it, `exhibit-server`
 * receives it).
 */
export type DeployArgs =
  | { domain: string; runCmd: string[] | null }
  | { error: string };

export function parseDeployArgs(args: string[]): DeployArgs {
  let domain: string | undefined;
  let runCmd: string[] | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--domain") {
      domain = args[++i];
      if (domain === undefined) return { error: "--domain requires a value" };
    } else if (arg === "--") {
      runCmd = args.slice(i + 1);
      if (runCmd.length === 0) return { error: "empty run command after --" };
      break;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  if (!domain) return { error: "deploy requires --domain <domain>" };
  return { domain, runCmd };
}
