/**
 * Gateway: `exodus_fetch` — read/write passthrough for the companion web app.
 *
 * The app (Signalisis) uses this server as its PRIMARY data source: the app sends the exodus
 * path it needs, this tool fetches it through the SAME authenticated session every other tool
 * uses (including the refresh chain), and hands the RAW payload back. The app keeps its own
 * parsing and calculation engines — this tool only guarantees the wire data is the same valid
 * live data the rest of this server reads.
 *
 * Security:
 *  - Access to this server is already gated by `MCP_API_KEY` in `api/mcp.ts` (Vercel).
 *  - Only path prefixes the app actually uses are allowed. GET prefixes are read-only; writes
 *    are restricted to the small set of routes the app is allowed to mutate (screener templates,
 *    watchlist, trending).
 *  - The raw payload is returned unchanged, so the app's parser sees exactly what exodus sent.
 */
import { z } from "zod";
import { ensureFresh } from "../auth/session.js";
import { HOSTS } from "../config.js";
import { runTool } from "./_format.js";
import type { Definer } from "./_define.js";

/** GET (read-only) prefixes the web app is allowed to request. */
const ALLOWED_GET_PREFIXES: string[] = [
  "/quote",
  "/orderbook",
  "/keystats",
  "/ratios",
  "/findata-view",
  "/emitten",
  "/marketdetectors",
  "/broker",
  "/insider",
  "/insider-transaction",
  "/corpaction",
  "/stream",
  "/screener",
  "/watchlist",
  "/search",
  "/company-price-feed",
  "/charts",
  "/chartbit",
  "/order-trade",
  "/paywall",
  "/analyst-ratings",
  "/price-series",
  "/sectors",
  "/hotlist",
  "/trending",
  "/index",
  "/top-stock",
  "/dividend",
  "/divident",
  "/news",
  "/user",
];

/** Write methods per prefix. A prefix not listed here can only be GET. */
const ALLOWED_WRITES: Record<string, ("POST" | "DELETE")[]> = {
  "/screener/templates": ["POST", "DELETE"],
  "/screener/favorites": ["POST", "DELETE"],
  "/watchlist": ["POST", "DELETE"],
  "/stream/v3/trending": ["POST"],
  "/chartbit/charts": ["POST", "DELETE"],
};

function allowed(method: string, path: string): boolean {
  const clean = path.split("?")[0];
  if (method === "GET") {
    return ALLOWED_GET_PREFIXES.some((p) => clean === p || clean.startsWith(p + "/"));
  }
  const writes = ALLOWED_WRITES[clean] ?? ALLOWED_WRITES[clean.split("/").slice(0, 3).join("/")];
  return !!writes && writes.includes(method as "POST" | "DELETE");
}

export function registerGatewayTools(define: Definer): void {
  define.read(
    "exodus_fetch",
    "Fetch a Stockbit exodus endpoint directly and return the RAW payload, for the companion " +
      "web app that keeps its own parsing. Use ONLY the paths this server's other tools expose — " +
      "the whitelist is exactly those prefixes. `method` defaults to GET; POST/DELETE are only " +
      "allowed for screener templates, watchlist and the trending stream. The response is the " +
      "exodus body exactly as sent (JSON, or text when exodus replies with text).",
    {
      path: z.string().describe("Exodus path, e.g. /quote?symbols=BBCA or /emitten/BBCA/info"),
      method: z.enum(["GET", "POST", "DELETE"]).optional().default("GET"),
      body: z.any().optional().describe("JSON body for POST (screener templates / trending)."),
    },
    async ({ path, method, body }) => {
      return runTool(async () => {
        const m = (method ?? "GET").toUpperCase();
        if (typeof path !== "string" || !path.startsWith("/")) {
          throw new Error("path must start with '/'");
        }
        if (!allowed(m, path)) {
          throw new Error(`Path ${JSON.stringify(path.split("?")[0])} is not whitelisted for ${m}`);
        }
        // Same authenticated session (and refresh chain) every other tool uses.
        const token = await ensureFresh("main");
        const hasBody = m !== "GET";
        const res = await fetch(HOSTS.exodus + path, {
          method: m,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(hasBody ? { "content-type": "application/json" } : {}),
            origin: "https://stockbit.com",
            referer: "https://stockbit.com/",
          },
          ...(hasBody ? { body: JSON.stringify(body ?? {}) } : {}),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          /* exodus answered with non-JSON (e.g. an error page) — pass the text through. */
        }
        if (!res.ok) {
          const brief =
            typeof parsed === "string"
              ? parsed.slice(0, 200)
              : JSON.stringify(parsed).slice(0, 200);
          throw new Error(`exodus ${res.status} for ${path}: ${brief}`);
        }
        return parsed;
      });
    },
  );
}
