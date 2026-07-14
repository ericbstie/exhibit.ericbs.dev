// PROTOTYPE — throwaway. The sandboxed app. Runs INSIDE the app network
// namespace. It is an ordinary HTTP client that respects the standard
// HTTP_PROXY / HTTPS_PROXY env vars Exhibit injects (ADR 0001 §2) — and holds
// NO credential of its own. It has no idea a proxy is attaching auth on its
// behalf; from its point of view it just calls the API.
//
// Usage:  bun client.ts <url>
//   env USER_TOKEN=<v>  -> app sends its OWN Authorization (a user-delegated
//                          token). Used to prove never-overwrite.
//
// Bun's fetch honours $HTTP_PROXY/$HTTPS_PROXY automatically, so nothing here
// mentions the proxy. Exactly the "app is oblivious" property Exhibit wants.

const target = process.argv[2] ?? process.env.TARGET!;
const userToken = process.env.USER_TOKEN;

const headers: Record<string, string> = {};
if (userToken) headers["authorization"] = userToken; // the app's own token, if any

try {
  const res = await fetch(target, { headers });
  const body = (await res.text()).trim();
  console.log(`HTTP ${res.status}`);
  console.log(body);
  // Non-2xx is a legitimate observable outcome for several checks (401 etc.),
  // so exit 0 on any completed response; only a dropped/blocked connection
  // (thrown below) is a failure to reach anything.
  process.exit(0);
} catch (err) {
  console.log(`NO-RESPONSE ${String(err).split("\n")[0]}`);
  process.exit(7); // connection blocked / never reached a server
}
