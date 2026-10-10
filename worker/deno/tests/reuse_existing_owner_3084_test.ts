/**
 * Tests for "call the existing owner, never copy it" (Issue #3084).
 *
 * Fleet PRs re-implemented an in-repo helper by hand instead of calling it —
 * GRQ-AutoTrader#2218 copied `buy_order`'s candidate-ordering comparator by
 * hand rather than calling it, and dropped its unrated-last rule in the
 * copy, and #2210 built the star rating by hand instead of reusing the
 * shared `StarRating` component. Neither diff was flagged, because
 * nothing in the `issue` or `pr_feedback` templates, the Spec reviewer brief,
 * or `CODING-STANDARDS.md` named an in-repo helper, component or policy
 * re-implemented by hand as a departure. These tests pin the rule the
 * templates, the shared Spec reviewer prompt constant and the coding
 * standards now carry, so a later edit that drops it fails here.
 *
 * Each pin runs against the one section of the doc that carries the rule —
 * `Instructions`, `Independent Review Before the PR`, `Making Changes` or
 * `Coding Principles` — rather than the whole file, so the test stays a
 * meaningful drift pin even if the same phrase could appear elsewhere
 * (CODING-STANDARDS.md § Documentation-drift tests, condition 1). The
 * `buildIssueRunAgents` check pins a rendered prompt value, not a doc, so it
 * flattens the whole string instead.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertStringIncludes } from "@std/assert";
import {
  buildIssueRunAgents,
  SPEC_REVIEWER_AGENT_NAME,
} from "../lib/issue_executor_agents.ts";
import {
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

Deno.test("issue - step 1 makes the agent call the existing owner instead of copying it", async () => {
  const body = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
  ).toLowerCase();

  for (
    const required of [
      "call the existing owner",
      "formats, orders, ranks, validates or decides",
      "every component or function the issue names",
      "implementation section",
      "widen its visibility",
      "`pub(crate)` → `pub`",
      "a component the issue says to reuse is a stated requirement",
    ]
  ) {
    assertStringIncludes(
      body,
      required,
      `missing from prompts/issue/prompt.md's Instructions section: "${required}"`,
    );
  }
});

Deno.test("issue - the Spec reviewer brief treats a named reuse as a criterion", async () => {
  const body = flat(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "Independent Review Before the PR",
    ),
  ).toLowerCase();

  assertStringIncludes(
    body,
    "a helper or component the issue says to reuse counts as a stated criterion",
    "missing from prompts/issue/prompt.md's Independent Review Before the " +
      "PR section",
  );
});

Deno.test("pr_feedback - a fix calls the owner and replaces a flagged copy", async () => {
  const body = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  ).toLowerCase();

  for (
    const required of [
      "call the existing owner",
      "widen its visibility",
      "replace the copy with a call to the owner",
    ]
  ) {
    assertStringIncludes(
      body,
      required,
      `missing from prompts/pr_feedback/prompt.md's Making Changes section: ` +
        `"${required}"`,
    );
  }
});

Deno.test("CODING-STANDARDS - the over-engineering checklist flags an in-repo helper copied by hand", async () => {
  const body = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Coding Principles"),
  ).toLowerCase();

  assertStringIncludes(
    body,
    "flag these four departures",
    "missing from CODING-STANDARDS.md's Coding Principles section",
  );
  assertStringIncludes(
    body,
    "an in-repo helper, component or policy re-implemented by hand instead of called",
    "missing from CODING-STANDARDS.md's Coding Principles section",
  );
});

Deno.test("spec-reviewer agent - a named reuse is a stated requirement", () => {
  const agents = buildIssueRunAgents({
    executorSplit: false,
    reviewerAgents: true,
    subAgentTier: "sonnet",
  });
  assert(agents, "the reviewer key on must build definitions");
  const prompt = flatWholeFile(agents[SPEC_REVIEWER_AGENT_NAME]!.prompt)
    .toLowerCase();

  assertStringIncludes(prompt, "says to reuse is a stated requirement");
  assertStringIncludes(
    prompt,
    "re-implements it by hand instead of calling it is not `met`",
  );
});
