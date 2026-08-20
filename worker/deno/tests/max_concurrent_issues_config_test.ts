/**
 * Tests for the maxConcurrentIssues host config key (Issue #4174).
 *
 * The foundation of the concurrent-issue-slots epic (#4168): a configured,
 * validated slot count that defaults to 1 so the change is inert until an
 * operator opts in. This issue only makes the number available and legal —
 * Above one slot the Priority-2 scan runs as a pool (Issue #4177); the
 * default is two (VibeCoder#170).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import type { ConfigFile, WorkerConfig } from "../types.ts";
import {
  buildDefaultWorkerConfig,
  OPERATIONAL_DEFAULTS,
} from "../lib/config_defaults.ts";
import { validateConfigFull } from "../lib/config_validator.ts";
import { detectUnknownConfigKeys } from "../lib/config_unknown_keys.ts";

function validConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    prReviewers: ["reviewer"],
    repos: ["org/repo"],
    issueLabels: ["work-on"],
    authorisedCommenters: ["testuser"],
    ...overrides,
  }) as WorkerConfig;
}

Deno.test("maxConcurrentIssues - defaults to 2 (Issue #4174, VibeCoder#170)", () => {
  assertEquals(OPERATIONAL_DEFAULTS.maxConcurrentIssues, 2);
  assertEquals(validConfig().maxConcurrentIssues, 2);
});

Deno.test("maxConcurrentIssues - a valid value in range validates (Issue #4174)", () => {
  const result = validateConfigFull(validConfig(), {
    max_concurrent_issues: 3,
  } as ConfigFile);
  assertEquals(result.valid, true, result.errors.join("; "));
});

Deno.test("maxConcurrentIssues - out-of-range and non-integer values fail validation (Issue #4174)", () => {
  for (const bad of [0, -1, 2.5, 9, "two"]) {
    const result = validateConfigFull(validConfig(), {
      max_concurrent_issues: bad as number,
    } as ConfigFile);
    assertEquals(
      result.valid,
      false,
      `value ${JSON.stringify(bad)} should have failed`,
    );
    assert(
      result.errors.some((e) => e.includes("max_concurrent_issues")),
      `error must name the key for ${JSON.stringify(bad)}: ${
        result.errors.join("; ")
      }`,
    );
  }
});

Deno.test("maxConcurrentIssues - absent raw value is valid (defaults apply) (Issue #4174)", () => {
  const result = validateConfigFull(validConfig(), {} as ConfigFile);
  assertEquals(result.valid, true, result.errors.join("; "));
});

Deno.test("maxConcurrentIssues - the key is recognised, not flagged unknown (Issue #4174)", () => {
  const warnings = detectUnknownConfigKeys({ max_concurrent_issues: 2 });
  assertEquals(
    warnings.some((w) => w.field === "max_concurrent_issues"),
    false,
    "max_concurrent_issues must be a known key",
  );
});
