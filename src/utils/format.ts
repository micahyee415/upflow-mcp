/**
 * Formatting utilities for Upflow MCP tool responses.
 *
 * Upflow stores all monetary amounts in cents (integers).
 * These helpers convert to display-friendly dollar amounts
 * and enrich API responses with pre-formatted fields so
 * Finance team members don't need to manually divide by 100.
 */

const CENT_FIELDS = ["amount", "remainingAmount", "paidAmount"] as const;

/**
 * Format a cent amount as a currency string.
 * @example formatCents(150000, 'USD') → '$1,500.00'
 */
export function formatCents(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    // Fallback for unknown/unsupported currency codes
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Recursively enrich an API response by adding `*_formatted` fields
 * next to known cent-value fields. Arrays are processed item by item.
 *
 * @example
 * enrichWithFormatted({ amount: 150000, currency: 'USD' })
 * // → { amount: 150000, amount_formatted: '$1,500.00', currency: 'USD' }
 */
export function enrichWithFormatted(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(enrichWithFormatted);
  }
  if (obj !== null && typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    const result: Record<string, unknown> = { ...record };
    const currency =
      typeof record.currency === "string" ? record.currency : "USD";
    for (const field of CENT_FIELDS) {
      if (typeof record[field] === "number") {
        result[`${field}_formatted`] = formatCents(
          record[field] as number,
          currency
        );
      }
    }
    return result;
  }
  return obj;
}
