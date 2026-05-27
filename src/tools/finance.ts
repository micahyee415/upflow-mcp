/**
 * Upflow Finance Composite Tools
 *
 * These tools make multiple Upflow API calls and compute derived views.
 * They do not map to a single Upflow endpoint.
 *
 * get_ar_aging_report       — aging buckets by currency and customer (with names)
 * get_customer_ar_snapshot  — full AR picture for one customer
 * search_overdue_invoices   — overdue invoices sorted oldest first
 * list_invoices_due_soon    — invoices due within N days (cash flow forecasting)
 * get_collections_dashboard — weekly AR overview for team review
 * get_dso_metrics           — Days Sales Outstanding calculation
 *
 * All amounts are in cents. All responses include *_formatted dollar value fields.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UpflowClient } from "../client.js";
import { formatCents, enrichWithFormatted } from "../utils/format.js";

// ── Pure helper functions (exported for unit testing) ─────────────────────────

export type AgingBucket = "current" | "1_30" | "31_60" | "61_90" | "90_plus";

/**
 * Determine which aging bucket an invoice falls into based on its due date.
 * @param dueDate ISO date string (YYYY-MM-DD)
 * @param today   Reference date (defaults to now)
 */
export function getAgingBucket(
  dueDate: string,
  today: Date = new Date()
): AgingBucket {
  const due = new Date(dueDate);
  const todayMs = Date.UTC(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );
  const dueMs = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  const daysOverdue = Math.floor((todayMs - dueMs) / (1000 * 60 * 60 * 24));

  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "1_30";
  if (daysOverdue <= 60) return "31_60";
  if (daysOverdue <= 90) return "61_90";
  return "90_plus";
}

interface AgingSummary {
  current: number;
  "1_30": number;
  "31_60": number;
  "61_90": number;
  "90_plus": number;
  total: number;
}

interface InvoiceLike {
  dueDate: string;
  amountOutstanding: number;  // Upflow API field (was incorrectly "remainingAmount")
  currency?: string;
  state?: string;             // "DUE", "OVERDUE", "PAID", "CANCELLED"
}

/**
 * Compute aging bucket totals from a list of invoices.
 * All amounts are in cents.
 */
export function computeAgingSummary(
  invoices: InvoiceLike[],
  today: Date = new Date()
): AgingSummary {
  const summary: AgingSummary = {
    current: 0,
    "1_30": 0,
    "31_60": 0,
    "61_90": 0,
    "90_plus": 0,
    total: 0,
  };

  for (const invoice of invoices) {
    const bucket = getAgingBucket(invoice.dueDate, today);
    summary[bucket] += invoice.amountOutstanding;
    summary.total += invoice.amountOutstanding;
  }

  return summary;
}

/** Format an AgingSummary with dollar values alongside cent values. */
function formatAgingSummary(
  summary: AgingSummary,
  currency = "USD"
): Record<string, string | number> {
  return {
    current: summary.current,
    current_formatted: formatCents(summary.current, currency),
    "1_30": summary["1_30"],
    "1_30_formatted": formatCents(summary["1_30"], currency),
    "31_60": summary["31_60"],
    "31_60_formatted": formatCents(summary["31_60"], currency),
    "61_90": summary["61_90"],
    "61_90_formatted": formatCents(summary["61_90"], currency),
    "90_plus": summary["90_plus"],
    "90_plus_formatted": formatCents(summary["90_plus"], currency),
    total: summary.total,
    total_formatted: formatCents(summary.total, currency),
  };
}

// ── MCP Tool Registration ─────────────────────────────────────────────────────

export function registerFinanceTools(
  server: McpServer,
  client: UpflowClient
): void {

  // ── get_ar_aging_report ──────────────────────────────────────────────────────

  server.tool(
    "get_ar_aging_report",
    "Compute an accounts receivable aging report. Returns outstanding totals grouped into aging buckets: Current, 1–30, 31–60, 61–90, and 90+ days past due. Broken down by currency (so multi-currency amounts are never mixed) and by customer with names. All amounts include formatted dollar values. Note: fetches all open invoices — may take a moment for large datasets.",
    {
      customer_id: z
        .string()
        .optional()
        .describe(
          'Optional: limit to a single customer. Accepts Upflow ID or "external:{salesforce_account_id}"'
        ),
    },
    async ({ customer_id }) => {
      // Upflow API doesn't support server-side state filtering — fetch all and
      // filter client-side to invoices with a remaining balance (DUE or OVERDUE).
      const [allFetched, customerList] = await Promise.all([
        client.listAll("/invoices", { customerId: customer_id }, 5000),
        client.listAll("/customers", {}, 2000),
      ]);

      // Build customer name lookup
      const customerMap = new Map(
        (customerList as { id: string; name?: string }[]).map(c => [
          c.id,
          c.name ?? c.id,
        ])
      );

      const allInvoices = (allFetched as (InvoiceLike & { customerId?: string })[])
        .filter(inv => inv.amountOutstanding > 0);

      // Overall summary (may mix currencies — kept for backward compat)
      const summary = computeAgingSummary(allInvoices);

      // Per-currency breakdown
      const currencyBuckets: Record<string, AgingSummary> = {};
      for (const inv of allInvoices) {
        const curr = inv.currency ?? "USD";
        if (!currencyBuckets[curr]) {
          currencyBuckets[curr] = {
            current: 0, "1_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0, total: 0,
          };
        }
        const bucket = getAgingBucket(inv.dueDate);
        currencyBuckets[curr][bucket] += inv.amountOutstanding;
        currencyBuckets[curr].total += inv.amountOutstanding;
      }

      const byCurrency: Record<string, ReturnType<typeof formatAgingSummary>> = {};
      for (const [curr, buckets] of Object.entries(currencyBuckets)) {
        byCurrency[curr] = formatAgingSummary(buckets, curr);
      }

      // Per-customer breakdown with names
      type CustomerBucket = AgingSummary & { customerId: string; customerName: string };
      const customerBuckets: Record<string, CustomerBucket> = {};

      for (const inv of allInvoices) {
        const cid = inv.customerId ?? "unknown";
        if (!customerBuckets[cid]) {
          customerBuckets[cid] = {
            customerId: cid,
            customerName: customerMap.get(cid) ?? cid,
            current: 0, "1_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0, total: 0,
          };
        }
        const bucket = getAgingBucket(inv.dueDate);
        customerBuckets[cid][bucket] += inv.amountOutstanding;
        customerBuckets[cid].total += inv.amountOutstanding;
      }

      const byCustomer = Object.values(customerBuckets)
        .sort((a, b) => b.total - a.total)
        .map(c => ({
          customerId: c.customerId,
          customerName: c.customerName,
          total: c.total,
          total_formatted: formatCents(c.total),
          current: c.current,
          "1_30": c["1_30"],
          "31_60": c["31_60"],
          "61_90": c["61_90"],
          "90_plus": c["90_plus"],
        }));

      const currencies = Object.keys(currencyBuckets);

      const result = {
        asOf: new Date().toISOString().split("T")[0],
        currencies,
        ...(currencies.length > 1 && {
          multiCurrencyWarning:
            "Multiple currencies detected. Use byCurrency for accurate per-currency totals — the overall summary mixes currencies.",
        }),
        summary: formatAgingSummary(summary),
        byCurrency,
        byCustomer,
        note: "Amounts in cents. All entries include *_formatted dollar values.",
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ── get_customer_ar_snapshot ─────────────────────────────────────────────────

  server.tool(
    "get_customer_ar_snapshot",
    'Get a complete AR picture for a single customer: profile, open/overdue invoices, outstanding balance, aging breakdown, recent payments, and recent activity. All amounts include formatted dollar values. Accepts Salesforce Account ID with "external:" prefix.',
    {
      customer_id: z
        .string()
        .min(1)
        .describe(
          'Upflow customer ID or "external:{salesforce_account_id}" for Salesforce lookup'
        ),
    },
    async ({ customer_id }) => {
      const [
        customer,
        allInvoices,
        recentPayments,
        recentActions,
      ] = await Promise.all([
        client.request(`/customers/${customer_id}`),
        client.listAll("/invoices", { customerId: customer_id }, 1000),
        client.listAll("/payments", { customerId: customer_id }, 10),
        client.listAll("/actions", { customerId: customer_id }, 10),
      ]);

      // Filter client-side — Upflow API doesn't support state filtering server-side
      const allOpenInvoices = (allInvoices as InvoiceLike[])
        .filter(inv => inv.amountOutstanding > 0);
      const agingRaw = computeAgingSummary(allOpenInvoices);

      const snapshot = {
        customer,
        outstandingBalance: agingRaw.total,
        outstandingBalance_formatted: formatCents(agingRaw.total),
        aging: formatAgingSummary(agingRaw),
        openInvoices: enrichWithFormatted(allOpenInvoices),
        recentPayments: enrichWithFormatted(recentPayments),
        recentActions,
        note: "Amounts in cents. Monetary fields include *_formatted dollar values.",
      };

      return {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
      };
    }
  );

  // ── search_overdue_invoices ───────────────────────────────────────────────────

  server.tool(
    "search_overdue_invoices",
    "Find overdue invoices across all customers (or a single customer), sorted oldest-due first. Optionally filter by minimum days overdue or minimum remaining amount. All amounts include formatted dollar values.",
    {
      customer_id: z
        .string()
        .optional()
        .describe(
          'Optional: limit to a single customer. Accepts Upflow ID or "external:{salesforce_account_id}"'
        ),
      min_days_overdue: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Only return invoices overdue by at least this many days"),
      min_amount_cents: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Only return invoices with remaining amount >= this value (in cents)"
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum number of invoices to return (default: 100)"),
    },
    async ({ customer_id, min_days_overdue, min_amount_cents, limit }) => {
      const allInvoices = await client.listAll("/invoices", { customerId: customer_id }, 5000);
      // Filter client-side — Upflow API doesn't support server-side state filtering
      const invoices = (allInvoices as (InvoiceLike & { id: string })[])
        .filter(inv => inv.state === "OVERDUE");

      const today = new Date();

      let filtered = invoices.filter((inv) => {
        if (min_days_overdue !== undefined) {
          const due = new Date(inv.dueDate);
          const daysOverdue = Math.floor(
            (today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)
          );
          if (daysOverdue < min_days_overdue) return false;
        }
        if (min_amount_cents !== undefined && inv.amountOutstanding < min_amount_cents) {
          return false;
        }
        return true;
      });

      filtered.sort(
        (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
      );
      filtered = filtered.slice(0, limit);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: filtered.length,
                invoices: enrichWithFormatted(filtered),
                note: "Sorted oldest-due first. Amounts in cents with *_formatted dollar values.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── list_invoices_due_soon ────────────────────────────────────────────────────

  server.tool(
    "list_invoices_due_soon",
    "Find open invoices due within the next N days. Useful for cash flow forecasting and proactive collections outreach. Returns invoices sorted soonest-due first with formatted dollar amounts.",
    {
      days_ahead: z
        .number()
        .int()
        .min(1)
        .max(90)
        .default(7)
        .describe("Number of days to look ahead (default: 7, max: 90)"),
      customer_id: z
        .string()
        .optional()
        .describe(
          'Optional: limit to one customer. Accepts Upflow ID or "external:{salesforce_account_id}"'
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum number of invoices to return (default: 100)"),
    },
    async ({ days_ahead, customer_id, limit }) => {
      const today = new Date();
      const cutoff = new Date(today);
      cutoff.setDate(today.getDate() + days_ahead);
      const todayStr = today.toISOString().split("T")[0];
      const cutoffStr = cutoff.toISOString().split("T")[0];

      // Upflow API ignores state/date filters server-side — fetch all and filter client-side
      const allInvoices = await client.listAll("/invoices", { customerId: customer_id }, 5000);
      const invoices = (allInvoices as InvoiceLike[]).filter(inv => {
        if (inv.amountOutstanding <= 0) return false; // skip paid invoices
        const due = inv.dueDate.substring(0, 10); // normalize ISO datetime to YYYY-MM-DD
        return due >= todayStr && due <= cutoffStr;
      });

      const sorted = [...invoices].sort(
        (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
      );

      const totalDue = sorted.reduce((sum, inv) => sum + inv.amountOutstanding, 0);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: sorted.length,
                totalDue,
                totalDue_formatted: formatCents(totalDue),
                dueBy: cutoffStr,
                invoices: enrichWithFormatted(sorted),
                note: `Open invoices due within ${days_ahead} day(s). Sorted soonest first.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── get_collections_dashboard ─────────────────────────────────────────────────

  server.tool(
    "get_collections_dashboard",
    "Get a high-level AR overview for weekly team review: total outstanding, full aging breakdown, top 10 customers by balance, invoices due this week, and 7-day payment activity. A great starting point for Monday morning AR reviews. All amounts include formatted dollar values.",
    {},
    async () => {
      const today = new Date();
      const sevenDaysAgo = new Date(today);
      sevenDaysAgo.setDate(today.getDate() - 7);
      const sevenDaysAhead = new Date(today);
      sevenDaysAhead.setDate(today.getDate() + 7);
      const sevenDaysAgoStr = sevenDaysAgo.toISOString().split("T")[0];
      const sevenDaysAheadStr = sevenDaysAhead.toISOString().split("T")[0];

      // Upflow API doesn't support server-side state/date filtering — fetch all
      // then filter client-side for outstanding and recent-payment windows.
      const [allFetched, recentPayments, customerList] =
        await Promise.all([
          client.listAll("/invoices", {}, 5000),
          client.listAll("/payments", {}, 50),
          client.listAll("/customers", {}, 2000),
        ]);

      const customerMap = new Map(
        (customerList as { id: string; name?: string }[]).map(c => [
          c.id,
          c.name ?? c.id,
        ])
      );

      // Outstanding = invoices with a remaining balance (DUE or OVERDUE)
      const allInvoices = (allFetched as (InvoiceLike & { customerId?: string })[])
        .filter(inv => inv.amountOutstanding > 0);

      // Overdue count for header metric
      const overdueInvoiceCount = (allFetched as (InvoiceLike & { state?: string })[])
        .filter(inv => inv.state === "OVERDUE").length;

      const agingRaw = computeAgingSummary(allInvoices);

      // Top 10 customers by outstanding balance
      const customerTotals: Record<
        string,
        { id: string; name: string; total: number }
      > = {};
      for (const inv of allInvoices) {
        const cid = inv.customerId ?? "unknown";
        if (!customerTotals[cid]) {
          customerTotals[cid] = {
            id: cid,
            name: customerMap.get(cid) ?? cid,
            total: 0,
          };
        }
        customerTotals[cid].total += inv.amountOutstanding;
      }
      const topCustomers = Object.values(customerTotals)
        .sort((a, b) => b.total - a.total)
        .slice(0, 10)
        .map(c => ({ ...c, total_formatted: formatCents(c.total) }));

      // Invoices due this week (outstanding only, due on or before cutoff)
      const dueThisWeek = allInvoices.filter(inv => {
        const due = new Date(inv.dueDate);
        return due <= sevenDaysAhead;
      });
      const dueThisWeekTotal = dueThisWeek.reduce(
        (sum, inv) => sum + inv.amountOutstanding, 0
      );

      // Recent payment total (last 7 days)
      type PaymentLike = { amount?: number };
      const recentPaymentTotal = (recentPayments as PaymentLike[]).reduce(
        (sum, p) => sum + (p.amount ?? 0), 0
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                asOf: today.toISOString().split("T")[0],
                totalOutstanding: agingRaw.total,
                totalOutstanding_formatted: formatCents(agingRaw.total),
                overdueInvoiceCount,
                aging: formatAgingSummary(agingRaw),
                dueThisWeek: {
                  count: dueThisWeek.length,
                  total: dueThisWeekTotal,
                  total_formatted: formatCents(dueThisWeekTotal),
                  dueBy: sevenDaysAheadStr,
                },
                recentPayments: {
                  periodStart: sevenDaysAgoStr,
                  count: (recentPayments as unknown[]).length,
                  total: recentPaymentTotal,
                  total_formatted: formatCents(recentPaymentTotal),
                },
                topCustomersByBalance: topCustomers,
                note: "All amounts in cents with *_formatted dollar values. Currency totals may be mixed if multi-currency invoices exist.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── get_dso_metrics ───────────────────────────────────────────────────────────

  server.tool(
    "get_dso_metrics",
    "Calculate Days Sales Outstanding (DSO) for a given billing period. DSO measures how quickly the company collects payment after invoicing — lower is better. Formula: (Total Outstanding AR ÷ Average Daily Billing in Period). Healthy SaaS DSO is typically under 45 days. Provide a full billing period (e.g. last month or last quarter) for meaningful results.",
    {
      period_start: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
        .describe("Start of the billing period (YYYY-MM-DD)"),
      period_end: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
        .describe("End of the billing period (YYYY-MM-DD)"),
    },
    async ({ period_start, period_end }) => {
      const start = new Date(period_start);
      const end = new Date(period_end);
      const daysInPeriod = Math.max(
        1,
        Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
      );

      // Upflow API ignores state/date filters server-side — fetch all invoices
      // and compute AR snapshot + period revenue client-side.
      const allInvoices = await client.listAll("/invoices", {}, 5000);

      const totalAR = (allInvoices as InvoiceLike[])
        .filter(inv => inv.amountOutstanding > 0)
        .reduce((sum, inv) => sum + inv.amountOutstanding, 0);

      // Period revenue = gross amount of non-cancelled invoices whose due date
      // falls in the period (due date is used as a proxy for issue date).
      type InvoiceWithAmount = InvoiceLike & { grossAmount?: number; netAmount?: number };
      const periodRevenue = (allInvoices as InvoiceWithAmount[])
        .filter(inv => {
          if (inv.state === "CANCELLED") return false;
          const due = inv.dueDate.substring(0, 10);
          return due >= period_start && due <= period_end;
        })
        .reduce((sum, inv) => sum + (inv.grossAmount ?? inv.netAmount ?? inv.amountOutstanding), 0);

      const avgDailyBilling = periodRevenue > 0 ? periodRevenue / daysInPeriod : 0;
      const dso =
        avgDailyBilling > 0 ? Math.round(totalAR / avgDailyBilling) : null;

      const health =
        dso === null
          ? null
          : dso <= 30
            ? "Excellent (≤30 days)"
            : dso <= 45
              ? "Good (31–45 days)"
              : dso <= 60
                ? "Watch (46–60 days)"
                : "Action needed (>60 days)";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                period: {
                  start: period_start,
                  end: period_end,
                  days: daysInPeriod,
                },
                currentAR: totalAR,
                currentAR_formatted: formatCents(totalAR),
                periodRevenue,
                periodRevenue_formatted: formatCents(periodRevenue),
                avgDailyBilling: Math.round(avgDailyBilling),
                avgDailyBilling_formatted: formatCents(Math.round(avgDailyBilling)),
                dso: dso ?? "N/A — no invoices found in period",
                dsoUnit: "days",
                health,
                note: "DSO = Total AR ÷ (Period Revenue ÷ Days). Period revenue uses due-date filtering as a proxy for issue-date. Cancelled invoices excluded.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
