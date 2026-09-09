import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../src/server.js";

// Peta sesi per-instance lambda — cukup untuk pemakaian personal.
const sessions = new Map<string, StreamableHTTPServerTransport>();

// Keamanan: MCP_API_KEY wajib untuk semua POST (browser/klien lain ditolak).
const MCP_KEY = (process.env.MCP_API_KEY || "").trim();
// CORS dibuka HANYA bila MCP_CORS_ORIGIN diset; tanpa itu browser tidak bisa
// membaca respons (server-side caller seperti edge function tidak butuh CORS).
const CORS_ORIGIN = (process.env.MCP_CORS_ORIGIN || "").trim();

function cors(res: any): void {
  if (CORS_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, accept, authorization, x-client-info");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}
function sendJson(res: any, status: number, obj: unknown): void {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

// Bootstrap refresh token + mirror ke Vercel KV (rotasi selamat lintas cold start).
const KV = (() => {
  const url = (process.env.KV_REST_API_URL || "").trim();
  const token = (process.env.KV_REST_API_TOKEN || "").trim();
  return url && token ? { url: url.includes("://") ? url : "https://" + url, token } : null;
})();
const KV_KEY = "stockbit_refresh_main";
let lastMirrored = "";

async function kvGet(key: string): Promise<string | null> {
  if (!KV) return null;
  try {
    const r = await fetch(KV.url + "/get/" + key, {
      headers: { authorization: "Bearer " + KV.token },
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return typeof j?.result === "string" ? j.result : null;
  } catch {
    return null;
  }
}
async function kvSet(key: string, value: string): Promise<void> {
  if (!KV) return;
  try {
    await fetch(KV.url + "/set/" + key, {
      method: "POST",
      headers: { authorization: "Bearer " + KV.token, "content-type": "application/json" },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    /* KV tidak wajib — degradasi halus */
  }
}
async function mirrorStore(): Promise<void> {
  try {
    const { getStore } = await import("../src/auth/store.js");
    const cur = getStore().get();
    if (cur && cur !== lastMirrored) {
      lastMirrored = cur;
      await kvSet(KV_KEY, cur);
    }
  } catch { /* store belum siap — abaikan */ }
}

let authReady: Promise<void> | null = null;
async function ensureAuth(): Promise<void> {
  if (!authReady) {
    authReady = (async () => {
      try {
        const { bootstrap } = await import("../src/auth/bootstrap.js");
        const envTok = (process.env.STOCKBIT_REFRESH_TOKEN || "").trim();
        const kvTok = await kvGet(KV_KEY);
        const tok = kvTok || envTok;
        if (tok) {
          await bootstrap(tok);
          await mirrorStore();
        }
      } catch (err: any) {
        console.error("[mcp] auth bootstrap failed:", err?.message || String(err));
      }
    })();
  }
  return authReady;
}

export default async function handler(req: any, res: any): Promise<void> {
  const method = String(req.method || "GET").toUpperCase();
  const sessionId = typeof req.headers?.["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
  const parsedBody: any = req.body ?? undefined;

  if (method === "OPTIONS") { cors(res); res.statusCode = 204; res.end(); return; }
  if (method === "GET") {
    sendJson(res, 200, { name: "stockbit-mcp", ok: true, auth: !!MCP_KEY, endpoint: "POST /api/mcp — JSON-RPC (MCP Streamable HTTP)" });
    return;
  }
  if (method === "DELETE") {
    if (MCP_KEY && req.headers?.authorization !== "Bearer " + MCP_KEY) {
      sendJson(res, 401, { error: "Unauthorized: MCP_API_KEY diperlukan." });
      return;
    }
    if (sessionId) {
      const t = sessions.get(sessionId);
      if (t) { try { await t.close(); } catch {} sessions.delete(sessionId); }
    }
    cors(res); res.statusCode = 200; res.end();
    return;
  }
  if (method !== "POST") { cors(res); res.statusCode = 405; res.setHeader("Allow", "GET, POST, DELETE, OPTIONS"); res.end(); return; }

  // Gate API key: semua POST butuh Authorization: Bearer <MCP_API_KEY>
  if (MCP_KEY && req.headers?.authorization !== "Bearer " + MCP_KEY) {
    sendJson(res, 401, { error: "Unauthorized: MCP_API_KEY diperlukan." });
    return;
  }

  await ensureAuth();

  let transport = sessionId ? sessions.get(sessionId) : undefined;
  if (!transport && sessionId) {
    const isInitialize = parsedBody?.method === "initialize" || String(parsedBody ?? "").includes('"initialize"');
    if (!isInitialize) { sendJson(res, 404, { error: "Session " + sessionId + " tidak ditemukan (cold start) — initialize ulang." }); return; }
  }
  try {
    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const server = createServer();
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, parsedBody);
    if (transport.sessionId && !sessions.has(transport.sessionId)) sessions.set(transport.sessionId, transport);
  } catch (err: any) {
    try { sendJson(res, 500, { error: "MCP handler error: " + (err?.message || String(err)) }); } catch {}
  }
  await mirrorStore();
}
