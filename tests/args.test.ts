import { describe, expect, test } from "bun:test";
import { parseDeployArgs } from "../src/shared/args.ts";

// #32: one parser for `deploy --domain <d> [-- <cmd>]`, shared by both ends
// of the SSH boundary.
describe("parseDeployArgs", () => {
  test("parses domain and run command", () => {
    expect(parseDeployArgs(["--domain", "a.test", "--", "python3", "app.py"])).toEqual({
      domain: "a.test",
      runCmd: ["python3", "app.py"],
    });
  });

  test("no -- means no run command (callers apply their default)", () => {
    expect(parseDeployArgs(["--domain", "a.test"])).toEqual({ domain: "a.test", runCmd: null });
  });

  test.each([
    [[], "deploy requires --domain <domain>"],
    [["--domain"], "--domain requires a value"],
    [["--domain", "a.test", "--"], "empty run command after --"],
    [["--bogus"], "unknown argument: --bogus"],
  ])("rejects %j", (args, error) => {
    expect(parseDeployArgs(args as string[])).toEqual({ error });
  });
});
