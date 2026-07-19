import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upsertRoute } from "../../src/server/caddy.ts";
import { httpGet } from "../../src/server/http.ts";
import { CADDY_ADMIN, E2E, INGRESS_PORT, resetCaddy, sleep } from "./harness.ts";

// T3 (#24): install/replace a Caddy HTTP route through the admin API so
// requests for a Host reach the target — stub targets, no systemd involved.
describe.skipIf(!E2E)("route a domain through Caddy", () => {
  const stubs: Array<{ stop: () => void }> = [];

  function stub(port: number, body: string): void {
    stubs.push(Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(body) }));
  }

  beforeAll(async () => {
    await resetCaddy();
    stub(4301, "stub-A");
    stub(4302, "stub-B");
  });
  afterAll(() => {
    for (const s of stubs) s.stop();
  });

  test("a routed Host reaches its target", async () => {
    await upsertRoute(CADDY_ADMIN, ":80", "t3-one.test", { host: "127.0.0.1", port: 4301 });
    const res = await httpGet("127.0.0.1", INGRESS_PORT, "t3-one.test");
    expect(res.status).toBe(200);
    expect(res.raw).toContain("stub-A");
  });

  test("two domains route independently to two distinct targets", async () => {
    await upsertRoute(CADDY_ADMIN, ":80", "t3-two.test", { host: "127.0.0.1", port: 4302 });
    expect((await httpGet("127.0.0.1", INGRESS_PORT, "t3-one.test")).raw).toContain("stub-A");
    expect((await httpGet("127.0.0.1", INGRESS_PORT, "t3-two.test")).raw).toContain("stub-B");
  });

  test("replacing a route is zero-downtime — no dropped request during the swap", async () => {
    const results: Array<{ status: number; raw: string }> = [];
    let stop = false;
    const hammer = (async () => {
      while (!stop) {
        results.push(await httpGet("127.0.0.1", INGRESS_PORT, "t3-one.test"));
        await sleep(5);
      }
    })();

    await sleep(100);
    await upsertRoute(CADDY_ADMIN, ":80", "t3-one.test", { host: "127.0.0.1", port: 4302 });
    await sleep(200);
    stop = true;
    await hammer;

    expect(results.length).toBeGreaterThan(10);
    for (const r of results) expect(r.status).toBe(200);
    expect(results[0]!.raw).toContain("stub-A");
    expect(results[results.length - 1]!.raw).toContain("stub-B");
  });
});
