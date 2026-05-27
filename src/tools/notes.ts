/**
 * Upflow Note Tools
 *
 * list_notes  — list collection notes on a customer account
 * create_note — log a note on a customer
 * delete_note — remove a note
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UpflowClient } from "../client.js";

export function registerNoteTools(
  server: McpServer,
  client: UpflowClient,
  canWrite: boolean
): void {
  server.tool(
    "list_notes",
    "List all collection notes on a customer account in Upflow.",
    {
      customer_id: z
        .string()
        .min(1)
        .describe('Upflow customer ID or "external:{salesforce_account_id}"'),
    },
    async ({ customer_id }) => {
      const notes = await client.listAll(`/customers/${customer_id}/notes`);
      return {
        content: [{ type: "text", text: JSON.stringify(notes, null, 2) }],
      };
    }
  );

  if (canWrite) {
  server.tool(
    "create_note",
    "Log a collections note on a customer account in Upflow. Use this to record calls, emails, commitments to pay, or any other account activity.",
    {
      customer_id: z
        .string()
        .min(1)
        .describe('Upflow customer ID or "external:{salesforce_account_id}"'),
      content: z.string().min(1).max(10_000).describe("Note content (plain text, max 10,000 characters)"),
    },
    async ({ customer_id, content }) => {
      const note = await client.request(`/customers/${customer_id}/notes`, {
        method: "POST",
        body: { content },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(note, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_note",
    "Delete a note from a customer account in Upflow.",
    {
      customer_id: z
        .string()
        .min(1)
        .describe('Upflow customer ID or "external:{salesforce_account_id}"'),
      note_id: z.string().min(1).describe("Upflow note ID to delete"),
    },
    async ({ customer_id, note_id }) => {
      await client.request(
        `/customers/${customer_id}/notes/${note_id}`,
        { method: "DELETE" }
      );
      return {
        content: [
          { type: "text", text: `Note ${note_id} deleted successfully.` },
        ],
      };
    }
  );
  } // end canWrite
}
