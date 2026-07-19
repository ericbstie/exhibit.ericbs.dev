import { describe, expect, test } from "bun:test";
import { releaseNameFor } from "../src/server/releases.ts";

// Spec (ADR 0005): releases are identified by timestamp only; same-second
// collisions get a `-<n>` suffix.
describe("releaseNameFor", () => {
  const t = new Date(Date.UTC(2026, 6, 19, 10, 45, 1));

  test("formats the timestamp as UTC YYYYMMDD-HHMMSS", () => {
    expect(releaseNameFor(t, [])).toBe("20260719-104501");
  });

  test("suffixes a same-second collision with -2, then -3", () => {
    expect(releaseNameFor(t, ["20260719-104501"])).toBe("20260719-104501-2");
    expect(releaseNameFor(t, ["20260719-104501", "20260719-104501-2"])).toBe(
      "20260719-104501-3",
    );
  });

  test("collision suffixes preserve chronological ordering under sort", () => {
    const names = ["20260719-104502", "20260719-104501-2", "20260719-104501"];
    expect([...names].sort()).toEqual([
      "20260719-104501",
      "20260719-104501-2",
      "20260719-104502",
    ]);
  });
});
