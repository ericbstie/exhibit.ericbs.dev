import { describe, expect, test } from "bun:test";

// T1 acceptance: `ex` and `exhibit-server` both start and print help/version.
async function run(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const out =
    (await new Response(proc.stdout).text()) +
    (await new Response(proc.stderr).text());
  return { code: await proc.exited, out };
}

for (const entry of ["src/ex/main.ts", "src/server/main.ts"]) {
  describe(entry, () => {
    test("prints help", async () => {
      const { code, out } = await run([entry, "--help"]);
      expect(code).toBe(0);
      expect(out).toContain("Usage:");
    });

    test("prints its version", async () => {
      const { code, out } = await run([entry, "--version"]);
      expect(code).toBe(0);
      expect(out).toMatch(/\d+\.\d+\.\d+/);
    });
  });
}
