> **📦 Archived reference implementation** — built 2025–2026 while running IT solo at an HR-tech SaaS. Kept as a portfolio piece; dependencies are frozen as of archiving (August 2026). More projects: [github.com/micahyee415](https://github.com/micahyee415).

# upflow-mcp-server

> A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for the [Upflow](https://upflow.io) accounts-receivable API — invoices, payments, customers, and finance tooling.

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.x-purple)
![Node](https://img.shields.io/badge/Node-20-339933?logo=nodedotjs&logoColor=white)

---

## Overview

`upflow-mcp-server` exposes Upflow's AR data to Claude (and any MCP-compatible client) as a set of structured tools. Finance and collections teams can ask Claude natural-language questions — "Which customers are more than 60 days overdue?", "What is our DSO this quarter?", "Generate a payment portal link for Acme Corp" — and get answers backed by live Upflow data.

Key design choices:

- **Read/write split** — all authenticated users get read-only tools; write tools (`create_invoice`, `create_payment`, etc.) are gated behind a `WRITE_ALLOWLIST` of approved email addresses.
- **Client-side filtering** — Upflow's API does not enforce server-side `state` or date filters; all filtering is applied in-process after fetching.
- **Cents-first, formatted-second** — all monetary values are stored and passed as integers (cents). Every response also includes `*_formatted` fields (e.g. `amount_formatted: "$1,500.00"`) so Finance users never need to divide by 100.
- **Stateless per-request** — each MCP request creates a fresh server instance; no session state is held between calls, which makes Cloud Run cold-start deployments safe.

---

## MCP Tools

### Customers

| Tool | Access | Description |
|---|---|---|
| `list_customers` | Read | List customers, optionally filtered by name |
| `get_customer` | Read | Get one customer by Upflow ID or Salesforce `external:` ID |
| `update_customer` | Write | Update account manager or custom fields |
| `get_customer_portal_url` | Read | Generate a self-service payment portal URL for a customer |

### Invoices

| Tool | Access | Description |
|---|---|---|
| `list_invoices` | Read | List invoices with filters: customer, status, date range, overdue-only |
| `get_invoice` | Read | Get one invoice with full detail and formatted amounts |
| `create_invoice` | Write | Create a new invoice (amount in cents) |
| `update_invoice` | Write | Update due date, reference, or cancel an open invoice |

### Payments

| Tool | Access | Description |
|---|---|---|
| `list_payments` | Read | List payments, optionally filtered by customer or date range |
| `get_payment` | Read | Get one payment with formatted amounts |
| `create_payment` | Write | Record a payment against a customer (amount in cents) |
| `delete_payment` | Write | Remove an erroneously recorded payment |

### Notes

| Tool | Access | Description |
|---|---|---|
| `list_notes` | Read | List collection notes on a customer account |
| `create_note` | Write | Log a collections note (call, email, commitment, etc.) |
| `delete_note` | Write | Delete a note from a customer account |

### Actions (Activity Log)

| Tool | Access | Description |
|---|---|---|
| `list_actions` | Read | List activity log events, filterable by customer, date, or action type |
| `get_action` | Read | Get full detail on a single activity event |

### Finance (Composite Tools)

These tools make multiple Upflow API calls and compute derived views entirely in-process.

| Tool | Access | Description |
|---|---|---|
| `get_ar_aging_report` | Read | AR aging buckets (Current, 1–30, 31–60, 61–90, 90+ days past due), broken down by currency and customer with names |
| `get_customer_ar_snapshot` | Read | Full AR picture for one customer: profile, open invoices, outstanding balance, aging, recent payments, recent activity |
| `search_overdue_invoices` | Read | Overdue invoices sorted oldest-due first, with optional min-days and min-amount filters |
| `list_invoices_due_soon` | Read | Open invoices due within N days (default 7), sorted soonest first — useful for cash flow forecasting |
| `get_collections_dashboard` | Read | Weekly AR overview: total outstanding, aging breakdown, top 10 customers by balance, due-this-week summary, 7-day payment activity |
| `get_dso_metrics` | Read | Days Sales Outstanding calculation for a billing period with health rating (Excellent / Good / Watch / Action needed) |

**Total: 23 tools** (13 read-only, 10 write-gated)

---

## Architecture

### Transport

Uses MCP's **StreamableHTTP** transport (`/mcp` endpoint). Each request is handled statelessly — a fresh `McpServer` instance is created per request, so no session affinity or sticky routing is needed.

### Authentication

Authentication is handled via **Google OAuth 2.0** (OpenID Connect):

1. Claude.ai discovers OAuth metadata from `/.well-known/oauth-authorization-server` (RFC 8414).
2. Claude registers itself via `/register` (RFC 7591 dynamic client registration), which returns the GCP OAuth client credentials.
3. On each MCP request, Claude sends a Google Bearer token in the `Authorization` header.
4. The server validates the token against Google's `tokeninfo` endpoint (no JWT library required) and confirms:
   - Token is valid and not expired
   - Email is verified
   - Email domain matches `ALLOWED_DOMAIN` (default: `example.com`)
   - Token `aud` claim matches `GOOGLE_CLIENT_ID` (prevents cross-app token reuse)
5. Validated tokens are cached in-memory for up to 60 seconds to avoid redundant Google API calls.

### Read vs. Write Access

All authenticated users with a valid `@ALLOWED_DOMAIN` email receive **read-only** tools. Write tools are additionally gated behind a `WRITE_ALLOWLIST` environment variable — a comma-separated list of email addresses. Users not on the list see only read tools.

### Sandbox vs. Production

Set `UPFLOW_SANDBOX=true` to route all Upflow API calls to `https://api.sandbox.upflow.io/v1` instead of `https://api.upflow.io/v1`. The server logs a startup banner when sandbox mode is active.

### Cents / Dollar Formatting

Upflow stores all monetary values as integers (cents). Two utilities in `src/utils/format.ts` handle display:

- `formatCents(cents, currency)` — converts an integer cent value to a locale-formatted currency string using `Intl.NumberFormat`. Example: `formatCents(150000, 'USD')` → `'$1,500.00'`. Falls back to `"1500.00 XYZ"` for unknown currency codes.
- `enrichWithFormatted(obj)` — recursively walks an API response object and adds `*_formatted` fields alongside known cent fields (`amount`, `remainingAmount`, `paidAmount`). Arrays are processed item by item.

All tool responses include both raw cent values and pre-formatted dollar strings.

### Deployment

Designed for **GCP Cloud Run** via Docker. A `cloudbuild.yaml` is included for automated builds via Cloud Build. The service:

- Listens on `PORT` (injected by Cloud Run, defaults to 8080)
- Reads Upflow and Google OAuth secrets from environment variables (provisioned via GCP Secret Manager in production)
- Handles `SIGTERM` gracefully — drains in-flight requests before exiting

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 (Alpine Docker image) |
| Language | TypeScript 5.x, ES2022, NodeNext modules |
| MCP SDK | `@modelcontextprotocol/sdk` v1.x |
| HTTP server | Express 4.x |
| Rate limiting | `express-rate-limit` |
| Schema validation | Zod |
| Testing | Vitest |
| Build | `tsc`, two-stage Docker build |
| Deploy | GCP Cloud Run via Cloud Build |

---

## Getting Started

### Prerequisites

- Node.js 20+
- An [Upflow](https://upflow.io) account with API credentials (key + secret from the Upflow dashboard)
- A GCP project with an OAuth 2.0 client configured for Google Sign-In (required for the remote HTTP deployment; not needed for local stdio use)

### Install

```bash
git clone https://github.com/micahyee415/upflow-mcp
cd upflow-mcp
npm install
npm run build
```

### Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `UPFLOW_API_KEY` | Yes | Upflow API key (from Upflow dashboard) |
| `UPFLOW_API_SECRET` | Yes | Upflow API secret (from Upflow dashboard) |
| `GOOGLE_CLIENT_ID` | Yes (remote) | GCP OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Yes (remote) | GCP OAuth 2.0 client secret |
| `UPFLOW_SANDBOX` | No | Set to `true` to use Upflow's sandbox API |
| `ALLOWED_DOMAIN` | No | Email domain for access control (default: `example.com`) |
| `WRITE_ALLOWLIST` | No | Comma-separated emails granted write tool access |
| `SERVER_URL` | No | Public URL of this service, used in OAuth metadata |
| `PORT` | No | HTTP port (default: `8080`; Cloud Run sets this automatically) |

**Security note:** In production, provision secrets via GCP Secret Manager rather than `.env` files. Never commit credentials to source control.

### Run (local development)

```bash
# Build and start
npm run build && npm start

# Or watch mode during development
npm run dev
```

The server starts on `http://localhost:8080` by default.

### Deploy to GCP Cloud Run

The included `cloudbuild.yaml` builds a Docker image and deploys to Cloud Run:

```bash
gcloud builds submit --config cloudbuild.yaml --project your-gcp-project .
```

Set `PROJECT_ID` to your GCP project. Secrets are pulled from GCP Secret Manager at deploy time via `--set-secrets`.

After deploy, restore public invoker access if needed:

```bash
gcloud run services add-iam-policy-binding upflow-mcp \
  --region=us-central1 \
  --member=allUsers \
  --role=roles/run.invoker \
  --project=your-gcp-project
```

---

## Connecting an MCP Client

Point your MCP client (Claude.ai, Claude Desktop, or any MCP-compatible tool) at the server's `/mcp` endpoint:

```
https://your-service.example.com/mcp
```

The server advertises OAuth discovery metadata at:

```
https://your-service.example.com/.well-known/oauth-authorization-server
https://your-service.example.com/.well-known/oauth-protected-resource
```

Claude.ai will automatically walk the OAuth flow using these endpoints.

---

## Security

- **Google OAuth domain restriction** — only `@ALLOWED_DOMAIN` accounts can authenticate. The token audience claim is validated to prevent token reuse from other Google-integrated apps.
- **Token cache** — validated tokens are cached in-memory (SHA-256 hashed key, 60-second TTL, 500-entry cap with LRU eviction) to reduce calls to Google's tokeninfo endpoint.
- **Write allowlist** — write-mutating tools are registered only for users explicitly listed in `WRITE_ALLOWLIST`. All other users see read-only tools.
- **Rate limiting** — `/register` is capped at 30 requests per 15 minutes; `/mcp` at 120 requests per minute. Registration requests from non-Claude origins are rejected (prevents OAuth credential harvesting).
- **Security headers** — all responses include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`, and `Cache-Control: no-store`.
- **Request timeouts** — all Upflow API calls time out after 10 seconds; Google tokeninfo calls time out after 5 seconds.
- **Payload size limit** — Express JSON body is capped at 512 KB; note content is capped at 10,000 characters.

---

## License

No license file is included in this repository. All rights reserved unless otherwise stated.
