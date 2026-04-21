import { describe, it, expect } from "vitest";
import { formatUsage, usageRatio } from "./use-usage";

describe("formatUsage", () => {
  it("renders used/limit for bounded features", () => {
    expect(formatUsage(3, 150)).toBe("3 / 150");
    expect(formatUsage(0, 10)).toBe("0 / 10");
  });

  it("labels unlimited tiers", () => {
    expect(formatUsage(42, null)).toBe("42 · unlimited");
  });
});

describe("usageRatio", () => {
  it("returns 0..1 for bounded features", () => {
    expect(usageRatio(0, 100)).toBe(0);
    expect(usageRatio(50, 100)).toBe(0.5);
    expect(usageRatio(100, 100)).toBe(1);
  });

  it("clamps overflow to 1 instead of going past the track end", () => {
    expect(usageRatio(150, 100)).toBe(1);
  });

  it("returns 0 for unlimited / missing / zero limits", () => {
    expect(usageRatio(5, null)).toBe(0);
    expect(usageRatio(5, 0)).toBe(0);
  });
});
