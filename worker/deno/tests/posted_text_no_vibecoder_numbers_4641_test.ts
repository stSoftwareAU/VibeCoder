/**
 * Regression tests for Issue #4641: failure reasons and comments the worker
 * posts in a TARGET repository must not carry a VibeCoder issue number as
 * `(Issue #N)`. GitHub resolves a bare `#N` against the repo the text is posted
 * in, so the suffix links to an unrelated issue there.
 *
 * Covers the builders that return a reason or comment string: the refusal
 * failure reason, the stale-claim hand-off comment, the timeout diagnostics,
 * the host-fault and milestone-branch release comments and the merged-PR sweep
 * close comment.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { formatStaleClaimComment } from "../lib/claim_freshness.ts";
import { formatDetailedFailureMessage } from "../lib/failure_message.ts";
import {
  type AgentRefusalOutcome,
  buildRefusalFailureReason,
} from "../lib/haiku_refusal_retry.ts";
import { buildHostFaultReleaseComment } from "../lib/host_fault_release.ts";
import { buildSweepCloseComment } from "../lib/merged_pr_issue_sweep.ts";
import { buildRefusalReleaseComment } from "../lib/milestone_branch_refusal_release.ts";

/** Every `#<digits>` token in the text, in order. */
const hashNumbers = (text: string): string[] => text.match(/#\d+/g) ?? [];

const cyberHaiku = { model: "claude-haiku-5-5", category: "cyber" };
const llmSonnet = { model: "claude-sonnet-5-5", category: "frontier_llm" };

Deno.test("buildRefusalFailureReason - a not-retried refusal carries no VibeCoder issue number", () => {
  const outcome: AgentRefusalOutcome = {
    tier: "sonnet",
    refusals: [llmSonnet],
    retry: "not-retried",
  };
  assertEquals(hashNumbers(buildRefusalFailureReason(outcome)), []);
});

Deno.test("buildRefusalFailureReason - a refused retry carries no VibeCoder issue number", () => {
  const outcome: AgentRefusalOutcome = {
    tier: "haiku",
    refusals: [cyberHaiku],
    retry: "refused",
    retryRefusals: [llmSonnet],
  };
  assertEquals(hashNumbers(buildRefusalFailureReason(outcome)), []);
});

Deno.test("formatStaleClaimComment - carries no VibeCoder issue number", () => {
  const body = formatStaleClaimComment({
    repo: "owner/repo",
    branch: "issue-333-fix",
    stale: {
      reason: "issue_closed",
      detail: "the issue closed while this run was working",
      prUrl: "https://github.com/owner/repo/pull/339",
      prNumber: 339,
    },
  });
  assertEquals(hashNumbers(body), []);
});

Deno.test("formatDetailedFailureMessage - late watchdog and incomplete kill diagnostics carry no VibeCoder issue number", () => {
  const message = formatDetailedFailureMessage("Agent timed out", {
    timedOut: true,
    outputSize: 10,
    timeoutReason: "wall-clock deadline",
    watchdogLateSeconds: 30,
    killIncompleteSeconds: 15,
  });
  assertEquals(hashNumbers(message), []);
});

Deno.test("buildHostFaultReleaseComment - carries no VibeCoder issue number", () => {
  assertEquals(
    hashNumbers(buildHostFaultReleaseComment(["clone-corrupt"])),
    [],
  );
});

Deno.test("buildRefusalReleaseComment - carries no VibeCoder issue number", () => {
  assertEquals(
    hashNumbers(buildRefusalReleaseComment("milestone/m1", ["failed"])),
    [],
  );
});

Deno.test("buildSweepCloseComment - names only the merged PR", () => {
  const body = buildSweepCloseComment(77, {
    landed: true,
    via: "default-branch",
    mergeCommit: "abc1234",
    baseRefName: "main",
  });
  assertEquals(hashNumbers(body), ["#77"]);
});
