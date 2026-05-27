import { describe, it, expect } from "vitest";
import { getAgingBucket, computeAgingSummary } from "../src/tools/finance.js";

describe("getAgingBucket", () => {
  const today = new Date("2026-04-13");

  it("returns 'current' for future due dates", () => {
    expect(getAgingBucket("2026-04-20", today)).toBe("current");
  });

  it("returns 'current' for today", () => {
    expect(getAgingBucket("2026-04-13", today)).toBe("current");
  });

  it("returns '1_30' for 1 day overdue", () => {
    expect(getAgingBucket("2026-04-12", today)).toBe("1_30");
  });

  it("returns '1_30' for 30 days overdue", () => {
    expect(getAgingBucket("2026-03-14", today)).toBe("1_30");
  });

  it("returns '31_60' for 31 days overdue", () => {
    expect(getAgingBucket("2026-03-13", today)).toBe("31_60");
  });

  it("returns '31_60' for 60 days overdue", () => {
    expect(getAgingBucket("2026-02-12", today)).toBe("31_60");
  });

  it("returns '61_90' for 61 days overdue", () => {
    expect(getAgingBucket("2026-02-11", today)).toBe("61_90");
  });

  it("returns '61_90' for 90 days overdue", () => {
    expect(getAgingBucket("2026-01-13", today)).toBe("61_90");
  });

  it("returns '90_plus' for 91 days overdue", () => {
    expect(getAgingBucket("2026-01-12", today)).toBe("90_plus");
  });
});

describe("computeAgingSummary", () => {
  const today = new Date("2026-04-13");

  it("sums invoice amounts into correct buckets", () => {
    const invoices = [
      { dueDate: "2026-04-20", amountOutstanding: 50000, currency: "USD" }, // current
      { dueDate: "2026-04-01", amountOutstanding: 10000, currency: "USD" }, // 1-30
      { dueDate: "2026-03-01", amountOutstanding: 20000, currency: "USD" }, // 31-60
      { dueDate: "2026-01-01", amountOutstanding: 30000, currency: "USD" }, // 90+
    ];
    const summary = computeAgingSummary(invoices, today);
    expect(summary.current).toBe(50000);
    expect(summary["1_30"]).toBe(10000);
    expect(summary["31_60"]).toBe(20000);
    expect(summary["61_90"]).toBe(0);
    expect(summary["90_plus"]).toBe(30000);
    expect(summary.total).toBe(110000);
  });

  it("returns all zeros for empty invoice list", () => {
    const summary = computeAgingSummary([], today);
    expect(summary.total).toBe(0);
    expect(summary.current).toBe(0);
  });
});
