import { connect } from "node:net";

export interface HttpResult {
  status: number;
  raw: string;
}

/**
 * Minimal raw HTTP/1.1 GET. Exists because the verify and confirm-live checks
 * must set an arbitrary Host header while dialing a fixed address — which
 * fetch() forbids — and pulling in an HTTP client for two probes is overkill.
 */
export function httpGet(
  host: string,
  port: number,
  hostHeader: string,
  timeoutMs = 2000,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on("connect", () => {
      socket.write(`GET / HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const statusLine = buffer.match(/^HTTP\/1\.[01] (\d{3})/);
      if (!statusLine) return reject(new Error("no HTTP response"));
      resolve({ status: Number(statusLine[1]), raw: buffer });
    });
  });
}
