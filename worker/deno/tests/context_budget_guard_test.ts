/**
 * Tests for `lib/context_budget_guard.ts` — the shared prompt component
 * breakdown and escalation copy behind the hard context ceiling (Issue #3713).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildContextBudgetEscalationReason,
  buildContextComponents,
  CONTEXT_BUDGET_NEXT_STEP,
} from "../lib/context_budget_guard.ts";
import { checkContextBudget } from "../lib/context_budget.ts";

Deno.test("context_budget_guard - measures every supplied component", () => {
  const components = buildContextComponents({
    systemPrompt: "s".repeat(400),
    userPrompt: "u".repeat(80),
    issueBody: "i".repeat(40),
    customInstructions: "c".repeat(20),
    recentActivity: "r".repeat(16),
    ciFailureContext: "f".repeat(8),
  });

  assertEquals(components.map((c) => c.name), [
    "system",
    "dynamic",
    "issue",
    "custom_instructions",
    "recent_activity",
    "ci_failure_log",
  ]);
  assertEquals(components.map((c) => c.tokens), [100, 20, 10, 5, 4, 2]);
});

Deno.test("context_budget_guard - omits empty optional components", () => {
  const components = buildContextComponents({
    userPrompt: "u".repeat(80),
    issueBody: "",
  });

  assertEquals(components.map((c) => c.name), ["dynamic", "issue"]);
  assertEquals(components[1]!.tokens, 0);
});

Deno.test("context_budget_guard - escalation reason names the largest component", () => {
  const result = checkContextBudget(
    [
      { name: "system", tokens: 10_000 },
      { name: "ci_failure_log", tokens: 990_000 },
    ],
    "opus",
  );
  assertEquals(result.ok, false);

  const reason = buildContextBudgetEscalationReason(result);

  assertStringIncludes(reason, "95%");
  assertStringIncludes(reason, "ci_failure_log");
  assertStringIncludes(reason, "990,000");
  assertStringIncludes(reason, "stopped before invoking Claude");
});

Deno.test("context_budget_guard - escalation reason survives an empty breakdown", () => {
  const result = checkContextBudget([], "opus", {
    blockThresholdPercent: 0.0001,
  });
  // A zero-token prompt is under any positive ceiling — force the blocked
  // shape to confirm the reason builder never throws without components.
  const reason = buildContextBudgetEscalationReason({
    ...result,
    ok: false,
    blockReason: "Context usage (99.0%) reached the hard ceiling of 95%.",
  });

  assertStringIncludes(reason, "99.0%");
  assert(!reason.includes("Largest component"));
});

Deno.test("context_budget_guard - next step tells the human what to do", () => {
  assertStringIncludes(CONTEXT_BUDGET_NEXT_STEP, "needs-human");
  assertStringIncludes(CONTEXT_BUDGET_NEXT_STEP, "work-on");
});
