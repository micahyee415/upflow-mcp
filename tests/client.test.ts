import { describe, it, expect } from "vitest";

describe("formatUpflowError", () => {
  it("formats 401 as credential error", async () => {
    const { formatUpflowError } = await import("../src/client.js");
    const result = await formatUpflowError(401, "Unauthorized");
    expect(result).toBe(
      "Invalid Upflow credentials — check UPFLOW_API_KEY and UPFLOW_API_SECRET"
    );
  });

  it("formats 404 with the server message", async () => {
    const { formatUpflowError } = await import("../src/client.js");
    const result = await formatUpflowError(404, "Customer not found");
    expect(result).toBe("Not found: Customer not found");
  });

  it("formats 400 as validation error", async () => {
    const { formatUpflowError } = await import("../src/client.js");
    const result = await formatUpflowError(400, "amount is required");
    expect(result).toBe("Validation error: amount is required");
  });

  it("formats 429 as rate limit", async () => {
    const { formatUpflowError } = await import("../src/client.js");
    const result = await formatUpflowError(429, "Too Many Requests");
    expect(result).toBe(
      "Upflow rate limit reached — please retry in a moment"
    );
  });

  it("formats 500 as generic API error", async () => {
    const { formatUpflowError } = await import("../src/client.js");
    const result = await formatUpflowError(500, "Internal Server Error");
    expect(result).toBe("Upflow API error (500): Internal Server Error");
  });
});

describe("buildQueryParams", () => {
  it("omits undefined values", async () => {
    const { buildQueryParams } = await import("../src/client.js");
    const params = buildQueryParams({ name: "Acme", status: undefined, limit: 100 });
    expect(params.get("name")).toBe("Acme");
    expect(params.get("limit")).toBe("100");
    expect(params.has("status")).toBe(false);
  });

  it("includes false boolean values", async () => {
    const { buildQueryParams } = await import("../src/client.js");
    const params = buildQueryParams({ active: false });
    expect(params.get("active")).toBe("false");
  });
});
