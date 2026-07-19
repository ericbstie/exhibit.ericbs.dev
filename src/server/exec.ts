/** Thin process-execution seam shared by the systemd/mise/tar call sites. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; stdin?: "inherit" | "ignore" } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: opts.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Like `run`, but a non-zero exit is an error carrying the command's output. */
export async function mustRun(
  cmd: string[],
  opts: Parameters<typeof run>[1] = {},
): Promise<RunResult> {
  const result = await run(cmd, opts);
  if (result.code !== 0) {
    throw new Error(
      `${cmd.join(" ")} exited ${result.code}\n${result.stderr || result.stdout}`.trim(),
    );
  }
  return result;
}
