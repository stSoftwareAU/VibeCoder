/**
 * Issue #4130: `isSplittableWorkerGateCategory` is the single test for which
 * worker gates split the parent issue on run 2.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type FailureCategory,
  getFailureCategoryDisplay,
  isSplittableWorkerGateCategory,
  normaliseFailureCategory,
} from "../lib/failure_diagnosis.ts";

/**
 * Every FailureCategory, keyed by name. The `Record` type makes this a compile
 * error until a new category is listed, so adding one cannot silently pass
 * the tests below.
 */
const ALL_CATEGORIES_BY_NAME: Record<FailureCategory, true> = {
  killed: true,
  timeout: true,
  rate_limit: true,
  zero_output: true,
  quality_check: true,
  push_failure: true,
  token_scope: true,
  no_changes: true,
  evidence_missing: true,
  workflow_gate: true,
  internal_error: true,
  missing_tools: true,
  interrupted: true,
  scheduled_release: true,
  repo_config: true,
  prompt_too_long: true,
  clone_corrupt: true,
  summary_incomplete: true,
  security_fix_gate: true,
  pre_push_gate: true,
  criteria_unmet: true,
  unknown: true,
};

const ALL_CATEGORIES = Object.keys(ALL_CATEGORIES_BY_NAME) as FailureCategory[];

/** The four display names the issue names, as users see them in comments. */
const SPLITTABLE_DISPLAY_NAMES = [
  "summary-incomplete",
  "quality-failure",
  "pre-push-gate",
  "security-fix-gate",
];

Deno.test("isSplittableWorkerGateCategory - the category list matches the runtime category set (Issue #4130)", () => {
  for (const category of ALL_CATEGORIES) {
    assertEquals(normaliseFailureCategory(category), category);
  }
});

Deno.test("isSplittableWorkerGateCategory - true for exactly the four gate categories (Issue #4130)", () => {
  const splittable = ALL_CATEGORIES.filter((c) =>
    isSplittableWorkerGateCategory(c)
  ).sort();
  assertEquals(splittable, [
    "pre_push_gate",
    "quality_check",
    "security_fix_gate",
    "summary_incomplete",
  ]);
});

Deno.test("isSplittableWorkerGateCategory - false for every other category (Issue #4130)", () => {
  const others = ALL_CATEGORIES.filter((c) =>
    !isSplittableWorkerGateCategory(c)
  );
  assertEquals(others.length, ALL_CATEGORIES.length - 4);
  for (const category of others) {
    assertEquals(isSplittableWorkerGateCategory(category), false, category);
  }
});

Deno.test("isSplittableWorkerGateCategory - true for the four display names, derived from the display function (Issue #4130)", () => {
  for (const display of SPLITTABLE_DISPLAY_NAMES) {
    const matches = ALL_CATEGORIES.filter((c) =>
      getFailureCategoryDisplay(c) === display
    );
    assertEquals(matches.length, 1, `display ${display}`);
    const category = matches[0];
    assert(category !== undefined);
    assertEquals(isSplittableWorkerGateCategory(category), true, display);
  }
});

Deno.test("isSplittableWorkerGateCategory - timeout and criteria_unmet do not split (Issue #4130)", () => {
  assertEquals(isSplittableWorkerGateCategory("timeout"), false);
  assertEquals(isSplittableWorkerGateCategory("criteria_unmet"), false);
});
