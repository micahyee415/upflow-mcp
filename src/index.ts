#!/usr/bin/env node

/**
 * Upflow MCP Server
 *
 * Connects Claude to the Upflow.io AR API via HTTP transport.
 * Deployed to GCP Cloud Run. Restricted to @example.com accounts via Google OAuth.
 *
 * Required env vars:
 *   UPFLOW_API_KEY        — from Upflow dashboard
 *   UPFLOW_API_SECRET     — from Upflow dashboard
 *   GOOGLE_CLIENT_ID      — GCP OAuth 2.0 client ID
 *   GOOGLE_CLIENT_SECRET  — GCP OAuth 2.0 client secret
 *
 * Optional:
 *   UPFLOW_SANDBOX=true  — use sandbox API instead of production
 *   PORT=8080            — HTTP port (Cloud Run sets this automatically)
 *   SERVER_URL           — public URL of this service (for OAuth metadata)
 *   ALLOWED_DOMAIN       — email domain to allow (default: example.com)
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

// Suppress dotenv v17 stdout banner — it contaminates MCP stdio transport
process.env.DOTENV_CONFIG_QUIET = "true";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env");
if (existsSync(envPath)) {
  config({ path: envPath });
} else {
  config();
}

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { UpflowClient } from "./client.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerPaymentTools } from "./tools/payments.js";
import { registerActionTools } from "./tools/actions.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerFinanceTools } from "./tools/finance.js";
import { verifyGoogleToken, extractBearerToken, AuthError } from "./auth.js";
import rateLimit from "express-rate-limit";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN ?? "example.com";
const SERVER_URL =
  process.env.SERVER_URL ??
  `https://your-service.example.com`;

const ALLOWED_ORIGINS = ["https://claude.ai", "https://api.claude.ai"];

// Write allowlist — comma-separated @example.com emails in WRITE_ALLOWLIST env var.
// Users on this list get write tools (create/update/delete).
// All other @example.com users get read-only access.
const WRITE_ALLOWLIST = new Set(
  (process.env.WRITE_ALLOWLIST ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

if (WRITE_ALLOWLIST.size === 0) {
  console.error("[upflow-mcp] Write tools disabled — WRITE_ALLOWLIST is empty. Set WRITE_ALLOWLIST env var to enable.");
} else {
  console.error(`[upflow-mcp] Write tools enabled for ${WRITE_ALLOWLIST.size} user(s)`);
}

// ─── Credential check ─────────────────────────────────────────────────────────

function checkCredentials(): void {
  const required = [
    "UPFLOW_API_KEY",
    "UPFLOW_API_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  ];
  const missing = required.filter((v) => !process.env[v]);

  if (missing.length > 0) {
    console.error(
      `[upflow-mcp] Missing required environment variables: ${missing.join(", ")}\n` +
        `Ensure all required env vars are set in your environment or .env file.`
    );
    process.exit(1);
  }
}

// ─── MCP server factory ───────────────────────────────────────────────────────

function createMcpServer(upflowClient: UpflowClient, canWrite: boolean): McpServer {
  const server = new McpServer({ name: "upflow-mcp", version: "1.4.0" });

  registerCustomerTools(server, upflowClient, canWrite);
  registerInvoiceTools(server, upflowClient, canWrite);
  registerPaymentTools(server, upflowClient, canWrite);
  registerActionTools(server, upflowClient);   // read-only
  registerNoteTools(server, upflowClient, canWrite);
  registerFinanceTools(server, upflowClient);  // read-only

  return server;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  checkCredentials();

  const upflowClient = new UpflowClient(
    process.env.UPFLOW_API_KEY!,
    process.env.UPFLOW_API_SECRET!,
    process.env.UPFLOW_SANDBOX === "true"
  );

  const app = express();
  app.set("trust proxy", 1); // Required for Cloud Run: use X-Forwarded-For for accurate rate limiting
  app.use(express.json({ limit: "512kb" }));

  // Rate limiters
  const registerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15-minute window
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many registration requests. Try again in 15 minutes." },
  });

  const mcpLimiter = rateLimit({
    windowMs: 60 * 1000, // 1-minute window
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Rate limit exceeded. Try again in a moment." },
  });

  // Security headers on all responses
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // ─── Health check ─────────────────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "upflow-mcp", version: "1.4.0" });
  });

  // ─── OAuth discovery metadata (RFC 8414) ──────────────────────────────────
  // Claude.ai reads these to understand how to authenticate users.

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: SERVER_URL,
      authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      token_endpoint: "https://oauth2.googleapis.com/token",
      registration_endpoint: `${SERVER_URL}/register`,
      scopes_supported: ["openid", "email", "profile"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
  });

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: SERVER_URL,
      authorization_servers: [SERVER_URL],
      scopes_supported: ["openid", "email", "profile"],
      bearer_methods_supported: ["header"],
    });
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({
      resource: `${SERVER_URL}/mcp`,
      authorization_servers: [SERVER_URL],
      scopes_supported: ["openid", "email", "profile"],
      bearer_methods_supported: ["header"],
    });
  });

  // ─── Dynamic Client Registration (RFC 7591) ───────────────────────────────
  // Claude.ai calls this to get the OAuth client credentials for the Google sign-in flow.

  app.post("/register", registerLimiter, (req, res) => {
    // Guard against credential harvesting from non-Claude origins
    const reqOrigin = req.headers.origin;
    if (reqOrigin && !ALLOWED_ORIGINS.includes(reqOrigin)) {
      res.status(403).json({ error: "Registration not permitted from this origin." });
      return;
    }
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res
        .status(500)
        .json({ error: "OAuth client credentials not configured on server." });
      return;
    }
    const redirectUris: string[] = (req.body?.redirect_uris ?? []).filter(
      (uri: unknown) => typeof uri === "string" && uri.startsWith("https://")
    );
    console.error("[upflow-mcp] Dynamic client registration", {
      origin: req.headers.origin ?? "unknown",
    });
    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    });
  });

  // ─── MCP endpoint ─────────────────────────────────────────────────────────

  app.all(["/", "/mcp"], mcpLimiter, async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      const origin = req.headers.origin;
      const allowedOrigin =
        origin && ALLOWED_ORIGINS.includes(origin)
          ? origin
          : ALLOWED_ORIGINS[0];
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS"
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Mcp-Session-Id"
      );
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      res.status(204).end();
      return;
    }

    // 1. Extract and validate Google OAuth token — confirms @example.com identity
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${SERVER_URL}/.well-known/oauth-protected-resource"`
      );
      res.status(401).json({
        error:
          "Missing Authorization header. Use Bearer <Google OAuth token>.",
      });
      return;
    }

    let userEmail: string;
    try {
      const authResult = await verifyGoogleToken(token, ALLOWED_DOMAIN);
      userEmail = authResult.email;
      console.error(`[upflow-mcp] Authenticated: ${userEmail}`);
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      console.error("[upflow-mcp] Unexpected auth error:", err);
      res.status(500).json({ error: "Authentication failed." });
      return;
    }

    // 2. CORS headers for the actual response
    const origin = req.headers.origin;
    const allowedOrigin =
      origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    // 3. Handle MCP request — fresh server per request (stateless)
    const canWrite = WRITE_ALLOWLIST.has(userEmail.toLowerCase());
    const server = createMcpServer(upflowClient, canWrite);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    console.error(
      `[upflow-mcp] Request handled for ${userEmail} (canWrite=${canWrite}): ${req.body?.method ?? "unknown"}`
    );
  });

  // ─── Start server ──────────────────────────────────────────────────────────

  const httpServer = app.listen(PORT, () => {
    console.error(`[upflow-mcp] Server listening on port ${PORT}`);
    if (process.env.UPFLOW_SANDBOX === "true") {
      console.error("[upflow-mcp] Running in SANDBOX mode");
    }
  });

  process.on("SIGTERM", () => {
    console.error("[upflow-mcp] SIGTERM received — draining connections...");
    httpServer.close(() => {
      console.error("[upflow-mcp] HTTP server closed. Exiting.");
      process.exit(0);
    });
  });
}

main().catch((error) => {
  console.error("[upflow-mcp] Fatal error:", error);
  process.exit(1);
});
