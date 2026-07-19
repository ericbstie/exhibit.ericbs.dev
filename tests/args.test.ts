import { expect, test } from "bun:test";
import { parseDeployArgs } from "../src/shared/args.ts";

// #32: one parser for `deploy --domain <d> [-- <cmd>]`, shared by both ends of
// the SSH boundary. One focused test (spec #20's ponytail minimum) — the happy
// paths are exercised end-to-end; this pins the parse shape and rejections.
test("parseDeployArgs", () => {
  expect(parseDeployArgs(["--domain", "a.test", "--", "python3", "app.py"])).toEqual({
    domain: "a.test",
    runCmd: ["python3", "app.py"],
  });
  // No `--` means no run command — each caller applies its own default.
  expect(parseDeployArgs(["--domain", "a.test"])).toEqual({ domain: "a.test", runCmd: null });
  expect(parseDeployArgs([])).toEqual({ error: "deploy requires --domain <domain>" });
  expect(parseDeployArgs(["--domain"])).toEqual({ error: "--domain requires a value" });
  expect(parseDeployArgs(["--domain", "a.test", "--"])).toEqual({
    error: "empty run command after --",
  });
  expect(parseDeployArgs(["--bogus"])).toEqual({ error: "unknown argument: --bogus" });
});
