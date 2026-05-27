/**
 * Upflow Invoice Tools
 *
 * list_invoices  — list invoices with rich filtering
 * get_invoice    — get one invoice with full detail
 * create_invoice — create a new invoice
 * update_invoice — update an existing invoice
 *
 * Amounts are in cents (integer). $1,500.00 = 150000.
 * All responses include *_formatted fields with dollar values.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UpflowClient } from "../client.js";
import { enrichWithFormatted } from "../utils/format.js";

const DATE_SCHEMA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

export function registerInvoiceTools(
  server: McpServer,
  client: UpflowClient,
  canWrite: boolean
): void {
  server.tool(
    "list_invoices",
    "List Upflow invoices with optional filters. Amounts are in cents (e.g. $1,500 = 150000); formatted dollar values are also included. Returns up to 500 invoices.",
    {
      customer_id: z
        .string()
        .optional()
        .describe(
          'Filter by customer. Accepts Upflow ID or "external:{salesforce_account_id}"'
        ),
      status: z
        .enum(["open", "paid", "overdue", "cancelled"])
        .optional()
        .describe("Filter by invoice status"),
      due_date_from: DATE_SCHEMA.optional().describe(
        "Filter invoices with due date on or after this date (YYYY-MM-DD)"
      ),
      due_date_to: DATE_SCHEMA.optional().describe(
        "Filter invoices with due date on or before this date (YYYY-MM-DD)"
      ),
      overdue_only: z
        .boolean()
        .optional()
        .describe("If true, return only overdue invoices"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum number of invoices to return (default: 100)"),
    },
    async ({ customer_id, status, due_date_from, due_date_to, overdue_only, limit }) => {
      // Upflow API ignores all query filters (state, date) server-side — fetch
      // a larger set and apply filters client-side.
      const fetchMax = Math.min(limit * 10, 2000);
      const raw = await client.listAll("/invoices", { customerId: customer_id }, fetchMax) as {
        dueDate?: string;
        state?: string;
        amountOutstanding?: number;
        [key: string]: unknown;
      }[];

      // Map user-facing status names to Upflow's internal state values
      const STATE_MAP: Record<string, string> = {
        open: "DUE",
        overdue: "OVERDUE",
        paid: "PAID",
        cancelled: "CANCELLED",
      };

      let filtered = raw;
      if (status) {
        const apiState = STATE_MAP[status];
        if (apiState) filtered = filtered.filter(inv => inv.state === apiState);
      }
      if (overdue_only) {
        filtered = filtered.filter(inv => inv.state === "OVERDUE");
      }
      if (due_date_from) {
        filtered = filtered.filter(inv => {
          const due = (inv.dueDate ?? "").substring(0, 10);
          return due >= due_date_from;
        });
      }
      if (due_date_to) {
        filtered = filtered.filter(inv => {
          const due = (inv.dueDate ?? "").substring(0, 10);
          return due <= due_date_to;
        });
      }

      const results = filtered.slice(0, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(enrichWithFormatted(results), null, 2) }],
      };
    }
  );

  server.tool(
    "get_invoice",
    "Get a single Upflow invoice with full detail. Amounts are in cents with formatted dollar values included.",
    {
      invoice_id: z.string().min(1).describe("Upflow invoice ID"),
    },
    async ({ invoice_id }) => {
      const invoice = await client.request(`/invoices/${invoice_id}`);
      return {
        content: [{ type: "text", text: JSON.stringify(enrichWithFormatted(invoice), null, 2) }],
      };
    }
  );

  if (canWrite) {
  server.tool(
    "create_invoice",
    "Create a new invoice in Upflow. Amount must be in cents (e.g. $1,500.00 = 150000). Response includes formatted dollar values.",
    {
      customer_id: z
        .string()
        .min(1)
        .describe('Upflow customer ID or "external:{salesforce_account_id}"'),
      amount: z
        .number()
        .int()
        .positive()
        .describe("Invoice amount in cents (e.g. $1,500 = 150000)"),
      currency: z
        .string()
        .length(3)
        .describe("ISO 4217 currency code (e.g. USD, EUR)"),
      due_date: DATE_SCHEMA.describe("Invoice due date (YYYY-MM-DD)"),
      issued_date: DATE_SCHEMA.describe("Invoice issued date (YYYY-MM-DD)"),
      reference: z
        .string()
        .optional()
        .describe("Your internal invoice reference number"),
    },
    async ({ customer_id, amount, currency, due_date, issued_date, reference }) => {
      const invoice = await client.request("/invoices", {
        method: "POST",
        body: {
          customerId: customer_id,
          amount,
          currency,
          dueDate: due_date,
          issuedDate: issued_date,
          reference,
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(enrichWithFormatted(invoice), null, 2) }],
      };
    }
  );

  server.tool(
    "update_invoice",
    "Update an existing Upflow invoice. Only provide fields you want to change. Response includes formatted dollar values.",
    {
      invoice_id: z.string().min(1).describe("Upflow invoice ID"),
      due_date: DATE_SCHEMA.optional().describe("New due date (YYYY-MM-DD)"),
      reference: z.string().optional().describe("New invoice reference number"),
      status: z
        .enum(["open", "cancelled"])
        .optional()
        .describe("New invoice status (can only cancel open invoices)"),
    },
    async ({ invoice_id, due_date, reference, status }) => {
      const body: Record<string, unknown> = {};
      if (due_date !== undefined) body.dueDate = due_date;
      if (reference !== undefined) body.reference = reference;
      if (status !== undefined) body.status = status;

      const invoice = await client.request(`/invoices/${invoice_id}`, {
        method: "PATCH",
        body,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(enrichWithFormatted(invoice), null, 2) }],
      };
    }
  );
  } // end canWrite
}
