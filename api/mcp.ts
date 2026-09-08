import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../src/server.js";

// Peta sesi per-instance lambda — cukup untuk pemakaian personal.
const sessions = new Map<string, StreamableHTTPServerTransport>();

function cors(res: any): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, accept, authorization, x-client-info");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}
function sendJson(res: any, status: number, obj: unknown): void {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

export default async function handler(req: any, res: any): Promise<void> {
  const method = String(req.method || "GET").toUpperCase();
  const sessionId = typeof req.headers?.["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
  const parsedBody: any = req.body ?? undefined;

  if (method === "OPTIONS") { cors(res); res.statusCode = 204; res.end(); return; }
  if (method === "GET") {
    sendJson(res, 200, { name: "stockbit-mcp", ok: true, endpoint: "POST /api/mcp — JSON-RPC (MCP Streamable HTTP)" });
    return;
  }
  if (method === "DELETE") {
    if (sessionId) {
      const t = sessions.get(sessionId);
      if (t) { try { await t.close(); } catch {} sessions.delete(sessionId); }
    }
    cors(res); res.statusCode = 200; res.end();
    return;
  }
  if (method !== "POST") { cors(res); res.statusCode = 405; res.setHeader("Allow", "GET, POST, DELETE, OPTIONS"); res.end(); return; }

  let transport = sessionId ? sessions.get(sessionId) : undefined;
  if (!transport && sessionId) {
    const isInitialize = parsedBody?.method === "initialize" || String(parsedBody ?? "").includes('"initialize"');
    if (!isInitialize) { sendJson(res, 404, { error: `Session ${sessionId} tidak ditemukan (cold start) — initialize ulang.` }); return; }
  }
  try {
    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const server = createServer(); // profile default (core tools)
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, parsedBody);
    if (transport.sessionId && !sessions.has(transport.sessionId)) sessions.set(transport.sessionId, transport);
  } catch (err: any) {
    try { sendJson(res, 500, { error: `MCP handler error: ${err?.message || String(err)}` }); } catch {}
  }
}
