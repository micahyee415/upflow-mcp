/**
 * Upflow Action Tools (read-only activity log)
 *
 * list_actions — list the activity/event log with filtering
 * get_action   — get detail on a single action/event
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UpflowClient } from "../client.js";

export function registerActionTools(
  server: McpServer,
  client: UpflowClient
): void {
  server.tool(
    "list_actions",
    "List Upflow activity log events. Useful for seeing what outreach or follow-up has occurred on an account. Optionally filter by customer, date range, or action type.",
    {
      customer_id: z
        .string()
        .optional()
        .describe(
          'Filter by customer. Accepts Upflow ID or "external:{salesforce_account_id}"'
        ),
      date_from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
        .optional()
        .describe("Filter actions on or after this date (YYYY-MM-DD)"),
      date_to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
        .optional()
        .describe("Filter actions on or before this date (YYYY-MM-DD)"),
      type: z
        .string()
        .optional()
        .describe(
          "Filter by action type (e.g. email_sent, call_logged, payment_recorded)"
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Maximum number of actions to return (default: 50)"),
    },
    async ({ customer_id, date_from, date_to, type, limit }) => {
      const actions = await client.listAll(
        "/actions",
        {
          customerId: customer_id,
          dateFrom: date_from,
          dateTo: date_to,
          type,
        },
        limit
      );
      return {
        content: [{ type: "text", text: JSON.stringify(actions, null, 2) }],
      };
    }
  );

  server.tool(
    "get_action",
    "Get full detail on a single Upflow activity event.",
    {
      action_id: z.string().min(1).describe("Upflow action ID"),
    },
    async ({ action_id }) => {
      const action = await client.request(`/actions/${action_id}`);
      return {
        content: [{ type: "text", text: JSON.stringify(action, null, 2) }],
      };
    }
  );
}
