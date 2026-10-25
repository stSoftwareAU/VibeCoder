/**
 * Tests for `lib/context_budget_guard.ts` — the shared prompt component
 * breakdown and the planning hand-off behind the hard context ceiling
 * (Issues #3713, #4298).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildContextBudgetEscalationReason,
  buildContextComponents,
  handOffOversizedIssueToPlanning,
} from "../lib/context_budget_guard.ts";
import { checkContextBudget } from "../lib/context_budget.ts";
import { buildPlanningHandoffMarker } from "../lib/planning_handoff.ts";
import { createLogger } from "../lib/logger.ts";
import type { GitHubClient } from "../types.ts";

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

Deno.test("context_budget_guard - an issue already planned once is retried, not handed to anyone (Issue #4298)", async () => {
  const labels: string[] = [];
  const comments: string[] = [];
  const client = {
    getIssueComments: () =>
      Promise.resolve([{ body: `earlier\n${buildPlanningHandoffMarker()}` }]),
    addLabel: (_r: string, _n: number, label: string) => {
      labels.push(label);
      return Promise.resolve();
    },
    postComment: (_r: string, _n: number, body: string) => {
      comments.push(body);
      return Promise.resolve(undefined);
    },
  } as unknown as GitHubClient;

  const handoff = await handOffOversizedIssueToPlanning({
    ghClient: client,
    repo: "org/repo",
    issueNumber: 7,
    githubUser: "bot",
    issueLabels: ["work-on"],
    reason: "too big",
    logger: createLogger({ host: "" }),
  });

  assertEquals(handoff.applied, false);
  assertEquals(labels, []);
  assertEquals(comments, []);
});
