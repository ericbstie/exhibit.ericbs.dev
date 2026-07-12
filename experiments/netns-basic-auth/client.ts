// The webapp/client. Talks to the weather API WITHOUT attaching any auth.
// Listens on 0.0.0.0:9999. GET / -> fetches /sunny from the weather API and
// relays the result. It has no idea credentials exist; something in the
// network path is expected to attach them.

const PORT = 9999;
// Where the client THINKS the weather API lives. This host:port is what gets
// intercepted at the network layer. Override with WEATHER_API env if needed.
const WEATHER_API = process.env.WEATHER_API ?? "http://10.200.1.1:1234";

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch() {
    try {
      // Deliberately no Authorization header.
      const res = await fetch(`${WEATHER_API}/sunny`);
      const body = await res.text();
      console.log(`[client] upstream ${res.status} from ${WEATHER_API}/sunny -> ${body.trim()}`);
      return new Response(
        `client called ${WEATHER_API}/sunny (no auth attached)\n` +
          `upstream status: ${res.status}\n` +
          `upstream body: ${body}`,
        { status: res.status, headers: { "content-type": "text/plain" } },
      );
    } catch (err) {
      console.log(`[client] fetch failed: ${err}`);
      return new Response(`fetch failed: ${err}\n`, { status: 502 });
    }
  },
});

console.log(`[client] listening on http://0.0.0.0:${PORT}  -> upstream ${WEATHER_API}`);
