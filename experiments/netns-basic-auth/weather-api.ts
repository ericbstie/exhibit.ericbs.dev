// Commercial "weather" API.
// Requires HTTP Basic auth. Single endpoint: GET /sunny -> {"sunny": true|false}
// Listens on 0.0.0.0:1234 so it is reachable from inside a network namespace.

const PORT = 1234;
const USER = "acme";
const PASS = "s3cr3t";
const EXPECTED = "Basic " + btoa(`${USER}:${PASS}`);

function unauthorized() {
  return new Response("Unauthorized\n", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="weather"' },
  });
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization");
    const who = req.headers.get("x-forwarded-for") ?? "";

    if (url.pathname !== "/sunny") {
      return new Response("Not found\n", { status: 404 });
    }

    if (auth !== EXPECTED) {
      console.log(`[weather-api] 401  no/invalid auth (got: ${auth ?? "none"}) ${who}`);
      return unauthorized();
    }

    const sunny = Math.random() < 0.5;
    console.log(`[weather-api] 200  authed -> sunny=${sunny} ${who}`);
    return Response.json({ sunny });
  },
});

console.log(`[weather-api] listening on http://0.0.0.0:${PORT}  (user=${USER})`);
