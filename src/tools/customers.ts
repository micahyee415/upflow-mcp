/**
 * Upflow Customer Tools
 *
 * list_customers          — search/list all customers
 * get_customer            — get one customer (Upflow ID or Salesforce external: ID)
 * update_customer         — update account manager or custom fields
 * get_customer_portal_url — generate a self-service payment portal URL
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UpflowClient } from "../client.js";

export function registerCustomerTools(
  server: McpServer,
  client: UpflowClient,
  canWrite: boolean
): void {
  server.tool(
    "list_customers",
    "List Upflow customers. Optionally filter by name (partial match). Returns up to 500 customers.",
    {
      name: z
        .string()
        .optional()
        .describe("Filter by customer name (partial match, case-insensitive)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum number of customers to return (default: 100)"),
    },
    async ({ name, limit }) => {
      const customers = await client.listAll("/customers", { name }, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(customers, null, 2) }],
      };
    }
  );

  server.tool(
    "get_customer",
    'Get a single Upflow customer by ID. Accepts either an Upflow customer ID or a Salesforce Account ID prefixed with "external:" (e.g. "external:0014x00001AbCdEf").',
    {
      customer_id: z
        .string()
        .min(1)
        .describe(
          'Upflow customer ID or "external:{salesforce_account_id}" for Salesforce lookup'
        ),
    },
    async ({ customer_id }) => {
      const customer = await client.request(`/customers/${customer_id}`);
      return {
        content: [{ type: "text", text: JSON.stringify(customer, null, 2) }],
      };
    }
  );

  if (canWrite) {
  server.tool(
    "update_customer",
    "Update a customer's account manager or custom fields in Upflow.",
    {
      customer_id: z
        .string()
        .min(1)
        .describe('Upflow customer ID or "external:{salesforce_account_id}"'),
      account_manager_id: z
        .string()
        .optional()
        .describe("Upflow user ID of the new account manager"),
      custom_fields: z
        .record(z.unknown())
        .optional()
        .describe("Custom field key/value pairs to update"),
    },
    async ({ customer_id, account_manager_id, custom_fields }) => {
      const body: Record<string, unknown> = {};
      if (account_manager_id !== undefined)
        body.accountManagerId = account_manager_id;
      if (custom_fields !== undefined) body.customFields = custom_fields;

      const customer = await client.request(`/customers/${customer_id}`, {
        method: "PATCH",
        body,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(customer, null, 2) }],
      };
    }
  );
  } // end canWrite

  server.tool(
    "get_customer_portal_url",
    "Generate a self-service payment portal URL for a customer. Share this URL with the customer so they can view and pay their invoices without logging into Upflow.",
    {
      customer_id: z
        .string()
        .min(1)
        .describe('Upflow customer ID or "external:{salesforce_account_id}"'),
    },
    async ({ customer_id }) => {
      const result = await client.request(
        `/customers/${customer_id}/portalUrl`,
        { method: "POST" }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
