import { describe, it, expect } from "bun:test";
import {
  validatePlanRewrite,
  extractCompletedItems,
  extractIterationHeaders,
  planHasCompletedItems,
} from "./plan-validation.js";

describe("plan-validation", () => {
  const basePlan = `# Plan

## Iteration 1 -- Foundation
- [x] Scaffold repo -- dev notes
- [x] Wire CI

## Iteration 2 -- Core
- [ ] Add auth module
- [ ] Add API handlers
`;

  describe("extractCompletedItems", () => {
    it("finds [x] items and strips trailing dev notes", () => {
      const items = extractCompletedItems(basePlan);
      expect(items.size).toBe(2);
      expect(items.has("Scaffold repo")).toBe(true);
      expect(items.has("Wire CI")).toBe(true);
    });

    it("is case-insensitive on the x marker", () => {
      const plan = "- [X] Foo\n- [x] Bar";
      const items = extractCompletedItems(plan);
      expect(items.has("Foo")).toBe(true);
      expect(items.has("Bar")).toBe(true);
    });
  });

  describe("extractIterationHeaders", () => {
    it("returns iteration numbers as strings", () => {
      const headers = extractIterationHeaders(basePlan);
      expect(headers).toEqual(new Set(["1", "2"]));
    });
  });

  describe("planHasCompletedItems", () => {
    it("is false for a first-run plan", () => {
      const plan = "## Iteration 1 -- Foo\n- [ ] Do A\n- [ ] Do B";
      expect(planHasCompletedItems(plan)).toBe(false);
    });

    it("is true once anything is checked off", () => {
      const plan = "## Iteration 1\n- [x] Done";
      expect(planHasCompletedItems(plan)).toBe(true);
    });
  });

  describe("validatePlanRewrite", () => {
    it("accepts an append-new-iteration rewrite", () => {
      const newPlan = `${basePlan}
## Iteration 3 -- Extensions
- [ ] Add admin panel
`;
      expect(validatePlanRewrite(basePlan, newPlan)).toEqual({ valid: true });
    });

    it("rejects deletion of a completed item", () => {
      const newPlan = `# Plan

## Iteration 1 -- Foundation
- [x] Scaffold repo

## Iteration 2 -- Core
- [ ] Add auth
`;
      const res = validatePlanRewrite(basePlan, newPlan);
      expect(res.valid).toBe(false);
      if (!res.valid) expect(res.reason).toMatch(/Wire CI/);
    });

    it("rejects deletion of an iteration header", () => {
      const newPlan = `# Plan

## Iteration 1 -- Foundation
- [x] Scaffold repo
- [x] Wire CI
`;
      const res = validatePlanRewrite(basePlan, newPlan);
      expect(res.valid).toBe(false);
      if (!res.valid) expect(res.reason).toMatch(/iteration header removed/);
    });

    it("rejects empty plan", () => {
      const res = validatePlanRewrite(basePlan, "");
      expect(res.valid).toBe(false);
    });

    it("allows retitling iteration headers", () => {
      const newPlan = `# Plan

## Iteration 1 -- Foundation (renamed)
- [x] Scaffold repo -- dev notes
- [x] Wire CI

## Iteration 2 -- Core plus auth
- [ ] Add auth module
- [ ] Add API handlers
- [ ] Add rate limiter
`;
      expect(validatePlanRewrite(basePlan, newPlan)).toEqual({ valid: true });
    });
  });
});
