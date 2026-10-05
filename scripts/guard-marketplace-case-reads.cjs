// Optional preload for local Central validation only. Never loaded by production.
const { appendFileSync } = require("node:fs");
const originalFetch = globalThis.fetch;
const allowedHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method || (input instanceof Request ? input.method : "GET");
  const allowed = (url.host === allowedHost && url.pathname.startsWith("/rest/v1/") && ["GET", "HEAD"].includes(method)) || ["localhost", "127.0.0.1"].includes(url.hostname);
  if (process.env.CASE_READ_AUDIT_FILE) appendFileSync(process.env.CASE_READ_AUDIT_FILE, JSON.stringify({ host: url.host, path: url.pathname, method, allowed }) + "\n");
  if (!allowed) throw new Error(`Read-only Central validation blocked ${method} ${url.host}${url.pathname}`);
  return originalFetch(input, init);
};
