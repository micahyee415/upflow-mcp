/**
 * Upflow API Client
 *
 * Handles authentication (X-Api-Key + X-Api-Secret headers),
 * auto-pagination for list endpoints, and human-readable error messages.
 *
 * Auth: X-Api-Key and X-Api-Secret headers on every request
 * Base URL: https://api.upflow.io/v1
 * Sandbox:  https://api.sandbox.upflow.io/v1
 */

export type QueryParamValue = string | number | boolean | undefined;

/**
 * Convert a params object to URLSearchParams, dropping undefined values.
 */
export function buildQueryParams(
  params: Record<string, QueryParamValue>
): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      sp.set(key, String(value));
    }
  }
  return sp;
}

/**
 * Format an Upflow HTTP error into a readable string for Claude / Finance.
 */
export async function formatUpflowError(
  status: number,
  message: string
): Promise<string> {
  switch (status) {
    case 401:
      return "Invalid Upflow credentials — check UPFLOW_API_KEY and UPFLOW_API_SECRET";
    case 404:
      return `Not found: ${message}`;
    case 400:
      return `Validation error: ${message}`;
    case 429:
      return "Upflow rate limit reached — please retry in a moment";
    default:
      return `Upflow API error (${status}): ${message}`;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, QueryParamValue>;
  body?: unknown;
}

// Upflow uses endpoint-specific envelope keys — no generic "data" wrapper.
// All list responses share the same pagination fields.
interface ListResponse {
  invoices?: unknown[];
  customers?: unknown[];
  payments?: unknown[];
  items?: unknown[];  // actions, notes, and some other endpoints
  data?: unknown[];   // fallback (not used by Upflow, kept for safety)
  offset?: number;
  limit?: number;
  total?: number;
}

export class UpflowClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(apiKey: string, apiSecret: string, sandbox = false) {
    this.baseUrl = sandbox
      ? "https://api.sandbox.upflow.io/v1"
      : "https://api.upflow.io/v1";
    this.headers = {
      "X-Api-Key": apiKey,
      "X-Api-Secret": apiSecret,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", params = {}, body } = options;

    const url = new URL(`${this.baseUrl}${path}`);
    const sp = buildQueryParams(params);
    sp.forEach((value, key) => url.searchParams.set(key, value));

    const response = await fetch(url.toString(), {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000), // 10-second timeout per request
    }).catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new Error("Upflow API request timed out — please try again.");
      }
      throw new Error(
        `Upflow API network error: ${err instanceof Error ? err.message : String(err)}`
      );
    });

    if (!response.ok) {
      let errorMessage: string;
      try {
        const errorBody = (await response.json()) as {
          message?: string;
          error?: string;
        };
        errorMessage =
          errorBody.message ?? errorBody.error ?? response.statusText;
      } catch {
        errorMessage = response.statusText;
      }
      throw new Error(await formatUpflowError(response.status, errorMessage));
    }

    // 204 No Content — return undefined cast to T
    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * Fetch all pages of a list endpoint, up to maxRecords.
   *
   * Upflow pagination: offset + limit (not page-based).
   * Response keys are endpoint-specific (invoices, customers, items, etc.)
   * not a generic "data" wrapper — we auto-detect the correct key.
   *
   * NOTE: Upflow's API does not support server-side filtering by state or date.
   * Callers must apply those filters client-side after fetching.
   */
  async listAll<T>(
    path: string,
    params: Record<string, QueryParamValue> = {},
    maxRecords = 500
  ): Promise<T[]> {
    const pageSize = 500; // Upflow supports up to 500 per page
    let offset = 0;
    const all: T[] = [];

    while (all.length < maxRecords) {
      const fetchLimit = Math.min(pageSize, maxRecords - all.length);
      const response = await this.request<ListResponse>(path, {
        params: { ...params, offset, limit: fetchLimit },
      });

      // Auto-detect the response envelope key — Upflow uses different keys
      // per endpoint (invoices, customers, items) rather than a generic "data" key.
      const page = (
        Array.isArray(response.invoices) ? response.invoices :
        Array.isArray(response.customers) ? response.customers :
        Array.isArray(response.payments) ? response.payments :
        Array.isArray(response.items) ? response.items :
        Array.isArray(response.data) ? response.data :
        []
      ) as T[];

      all.push(...page);
      offset += page.length;

      if (page.length < fetchLimit) break; // last page
    }

    return all.slice(0, maxRecords);
  }
}
