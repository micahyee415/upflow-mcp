# Changelog

## [1.4.1] - 2026-05-15

### Security

- Patch `fast-uri` ReDoS vulnerability via `npm audit fix` (GHSA-cc4q-3qf2-7vrm)

## [1.4.0] - 2026-04-27

### Fixed (Critical — all list tools were returning zero results)

- **Wrong response envelope key** (`response.data`) — Upflow API returns endpoint-specific keys
  (`invoices`, `customers`, `items`) not a generic `data` wrapper. All list tools silently
  returned empty arrays. Fixed by auto-detecting the correct key per response.
- **Wrong pagination parameters** (`paginationPage`/`paginationLimit`) — Upflow uses
  offset-based pagination (`offset`/`limit`). Fixed; page size increased to 500 (was 100).
- **Wrong field name for outstanding amount** (`remainingAmount`) — Upflow API field is
  `amountOutstanding`. All aging, balance, and AR calculations were returning $0.

### Fixed (Behavioral)

- **Server-side state/date filtering doesn't work** in Upflow's API — all filter params
  (`status`, `state`, `dueDateFrom`, `dueDateTo`) are silently ignored by the API. All tools
  now fetch records and apply state/date filters client-side.
- `get_ar_aging_report`, `get_collections_dashboard`, `get_dso_metrics`,
  `list_invoices_due_soon`: collapsed two-call "open + overdue" pattern into a single fetch
  filtered client-side to `amountOutstanding > 0`.
- `search_overdue_invoices`: now filters by `state === "OVERDUE"` client-side.
- `list_invoices`: added `STATE_MAP` translating user-facing status names
  (`open`→`DUE`, `overdue`→`OVERDUE`, etc.) to Upflow's internal state values.
- Aggregate tools (`get_ar_aging_report`, `get_collections_dashboard`) now fetch up to 5000
  invoices to ensure complete AR coverage (was capped at 500).

## [1.3.0] - 2026-04-20

### Security

- Updated `hono` to fix moderate HTML injection vulnerability in JSX SSR (GHSA-458j-xx4x-4375)

## [1.2.0] - 2026-04-14

### Security

- Added `express-rate-limit` — `/register` capped at 30 req/15 min, `/mcp` at 120 req/min
- `/register` now rejects requests from non-Claude origins (prevents OAuth credential harvesting)
- Added `app.set("trust proxy", 1)` so rate limiting uses real client IPs behind Cloud Run
- Added 10-second timeout to all Upflow API calls (was unbounded; could hang indefinitely)
- Added date format validation (YYYY-MM-DD regex) to all date parameters in invoices, payments, and actions tools
- Added `.max(10_000)` to note content field to prevent oversized payloads

### Added

- `src/utils/format.ts` — shared `formatCents()` and `enrichWithFormatted()` utilities
- All invoice, payment, and finance tool responses now include `*_formatted` dollar value fields
  (e.g. `amount_formatted: "$1,500.00"`) alongside cent values — no need to manually divide by 100
- `get_ar_aging_report` now breaks down aging by currency (`byCurrency` field) — multi-currency
  totals are no longer incorrectly summed
- `get_ar_aging_report` now includes customer names in `byCustomer` breakdown (fetches customer
  list in parallel)
- `get_customer_ar_snapshot` response now includes formatted dollar values on invoices and payments
- New tool: `list_invoices_due_soon` — open invoices due within N days (default 7), sorted soonest
  first; useful for cash flow forecasting
- New tool: `get_collections_dashboard` — weekly AR overview with total outstanding, aging
  breakdown, top 10 customers by balance, due-this-week summary, and 7-day payment activity
- New tool: `get_dso_metrics` — Days Sales Outstanding calculation for a billing period with health
  rating (Excellent / Good / Watch / Action needed)

### Changed

- Total tool count: 20 → 23 (added `list_invoices_due_soon`, `get_collections_dashboard`,
  `get_dso_metrics`)

## [1.1.0] - 2026-04-13

### Added

- Google OAuth authentication — access restricted to `@example.com` accounts
- Migrated to StreamableHTTP transport (stateless, per-request)
- OAuth discovery metadata endpoints (RFC 8414): `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource`
- Dynamic client registration endpoint `/register` (RFC 7591) for Claude.ai compatibility
- Bearer token validation via Google's tokeninfo endpoint with in-memory caching (60s TTL)
- Security headers on all responses (X-Content-Type-Options, X-Frame-Options, HSTS, Cache-Control)
- CORS support for claude.ai and api.claude.ai origins

### Changed

- Removed SSE transport (`/sse`, `/message` endpoints) in favor of stateless StreamableHTTP (`/mcp`)
- Removed `--min-instances=1` Cloud Run requirement (stateless transport needs no session affinity)

## [1.0.0] - 2026-04-13

### Added

- Initial implementation of Upflow MCP server
- Customer tools: `list_customers`, `get_customer`, `update_customer`, `get_customer_portal_url`
- Invoice tools: `list_invoices`, `get_invoice`, `create_invoice`, `update_invoice`
- Payment tools: `list_payments`, `get_payment`, `create_payment`, `delete_payment`
- Action tools: `list_actions`, `get_action`
- Note tools: `list_notes`, `create_note`, `delete_note`
- Finance composite tools: `get_ar_aging_report`, `get_customer_ar_snapshot`,
  `search_overdue_invoices`
- HTTP SSE transport for GCP Cloud Run
- Salesforce Account ID cross-reference via `external:` prefix
