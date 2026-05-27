/**
 * Upflow Payment Tools
 *
 * list_payments  — list payments filtered by customer or date range
 * get_payment    — get one payment
 * create_payment — record a payment against a customer
 * delete_payment — remove an erroneously recorded payment
 *
 * Amounts are in cents (integer). All responses include *_formatted dollar values.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UpflowClient } from "../client.js";
import { enrichWithFormatted } from "../utils/format.js";

const DATE_SCHEMA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

export function registerPaymentTools(
  server: McpServer,
  client: UpflowClient,
  canWrite: boolean
): void {
  server.tool(
    "list_payments",
    "List Upflow payments. Optionally filter by customer or date range. Amounts are in cents with formatted dollar values included.",
    {
      customer_id: z
        .string()
        .optional()
        .describe(
          'Filter by customer. Accepts Upflow ID or "external:{salesforce_account_id}"'
        ),
      date_from: DATE_SCHEMA.optional().describe(
        "Filter payments on or after this date (YYYY-MM-DD)"
      ),
      date_to: DATE_SCHEMA.optional().describe(
        "Filter payments on or before this date (YYYY-MM-DD)"
      ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum number of payments to return (default: 100)"),
    },
    async ({ customer_id, date_from, date_to, limit }) => {
      const payments = await client.listAll(
        "/payments",
        { customerId: customer_id, dateFrom: date_from, dateTo: date_to },
        limit
      );
      return {
        content: [{ type: "text", text: JSON.stringify(enrichWithFormatted(payments), null, 2) }],
      };
    }
  );

  server.tool(
    "get_payment",
    "Get a single Upflow payment by ID. Amounts are in cents with formatted dollar values included.",
    {
      payment_id: z.string().min(1).describe("Upflow payment ID"),
    },
    async ({ payment_id }) => {
      const payment = await client.request(`/payments/${payment_id}`);
      return {
        content: [{ type: "text", text: JSON.stringify(enrichWithFormatted(payment), null, 2) }],
      };
    }
  );

  if (canWrite) {
  server.tool(
    "create_payment",
    "Record a payment against a customer in Upflow. Amount must be in cents (e.g. $1,000 = 100000). Response includes formatted dollar values.",
    {
      customer_id: z
        .string()
        .min(1)
        .describe('Upflow customer ID or "external:{salesforce_account_id}"'),
      amount: z
        .number()
        .int()
        .positive()
        .describe("Payment amount in cents (e.g. $1,000 = 100000)"),
      currency: z.string().length(3).describe("ISO 4217 currency code (e.g. USD)"),
      date: DATE_SCHEMA.describe("Payment date (YYYY-MM-DD)"),
      reference: z
        .string()
        .optional()
        .describe("Payment reference (e.g. check number, wire reference)"),
    },
    async ({ customer_id, amount, currency, date, reference }) => {
      const payment = await client.request("/payments", {
        method: "POST",
        body: { customerId: customer_id, amount, currency, date, reference },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(enrichWithFormatted(payment), null, 2) }],
      };
    }
  );

  server.tool(
    "delete_payment",
    "Delete an erroneously recorded payment from Upflow. This cannot be undone.",
    {
      payment_id: z.string().min(1).describe("Upflow payment ID to delete"),
    },
    async ({ payment_id }) => {
      await client.request(`/payments/${payment_id}`, { method: "DELETE" });
      return {
        content: [
          { type: "text", text: `Payment ${payment_id} deleted successfully.` },
        ],
      };
    }
  );
  } // end canWrite
}
