// PROTOTYPE — throwaway. Declared upstreams for the credential proxy.
//
// In production this table is NOT a source file: it *is* the fnox `env = false`
// M2M credential set (ADR 0001 §3 "allowlist = the fnox M2M set"), which under
// ADR 0002 lives in a fnox profile encrypted to the PROXY's age recipient so the
// app is cryptographically unable to read it. Here we hard-code an equivalent
// map purely to exercise the proxy's attach/skip logic. The proxy reads it; the
// app never sees it.
//
// The set is keyed by upstream host. Presence in the set = "declared upstream"
// (the allowlist). The value is the credential the proxy attaches, per-domain.

export interface Upstream {
  /** Credential the proxy injects as the `Authorization` header value. */
  credential: string;
}

// The declared M2M set. weather.test is a paid API we hold an M2M token for.
// unknown.test is deliberately ABSENT — it models a host the app can route to
// but that we hold no credential for (declared-upstreams-only proof).
// secure.test is present but only reachable over https:// (CONNECT), so it can
// never receive this credential — the documented http-only limit.
export const M2M_SET: Record<string, Upstream> = {
  "weather.test": { credential: "Bearer wthr_m2m_5f3c9a2e_PROXYHELD" },
  "secure.test": { credential: "Bearer scr_m2m_should_never_be_sent" },
};

// The proxy identifies the calling app by the source veth IP of the connection
// (ADR 0009/0011: "the veth IP — not a port — addresses the app"). This maps
// that IP back to the app's domain identity for the audit log's `app` field.
export const APP_BY_SRC_IP: Record<string, string> = {
  "10.0.0.2": "weather-app.exhibit.test",
};
