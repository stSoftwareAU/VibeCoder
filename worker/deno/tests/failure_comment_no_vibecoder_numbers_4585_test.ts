/**
 * Regression tests for Issue #4585: the text the worker posts in a TARGET
 * repository must not carry a VibeCoder issue or PR number. A bare `#N` in the
 * target repo links to an unrelated issue there.
 *
 * Covers every FailureCategory through the real code paths: the one-line
 * cause and the detail bullets from failure_diagnosis.ts, and the full
 * "Automated Processing Failed" comment built by markIssueAsFailedOnce.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type ClarityStatus,
  type FailureCategory,
  getFailureDiagnosis,
  getFailureDiagnosisOneliner,
} from "../lib/failure_diagnosis.ts";
import {
  handleIssueFailure,
  markIssueAsFailedOnce,
} from "../lib/label_manager.ts";

/** The issue number the comment is posted against; the only `#N` a comment may carry. */
const TARGET_ISSUE = 42;

/**
 * Every FailureCategory, keyed so the compiler refuses to build without one.
 * A category added to the union fails `deno check` until it is listed here,
 * so the all-categories tests cannot silently skip a case.
 */
const ALL_CATEGORIES: Record<FailureCategory, true> = {
  timeout: true,
  rate_limit: true,
  zero_output: true,
  killed: true,
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

const CATEGORIES = Object.keys(ALL_CATEGORIES) as FailureCategory[];

const CLARITY_STATUSES: ClarityStatus[] = [
  "not_assessed",
  "assessed_clear",
  "skipped",
];

/** Every `#<digits>` token in the text, in order. */
function hashNumbers(text: string): string[] {
  return text.match(/#\d+/g) ?? [];
}

/** The `--body` argument of the `issue comment` call the builder made. */
function commentBody(calls: string[][]): string {
  const commentCall = calls.find((c) => c[0] === "issue" && c[1] === "comment");
  if (!commentCall) return "";
  const bodyIdx = commentCall.indexOf("--body");
  return bodyIdx >= 0 ? commentCall[bodyIdx + 1] ?? "" : "";
}

Deno.test("failure diagnosis - no category's one-line cause or detail names a VibeCoder number (Issue #4585)", () => {
  for (const category of CATEGORIES) {
    for (const clarity of CLARITY_STATUSES) {
      const oneliner = getFailureDiagnosisOneliner(category, clarity);
      const detail = getFailureDiagnosis(category, clarity);
      assert(oneliner.length > 0, `${category}: empty one-line cause`);
      assert(detail.length > 0, `${category}: empty detail`);
      assertEquals(
        hashNumbers(oneliner),
        [],
        `${category} (${clarity}) one-line cause carries a number: ${oneliner}`,
      );
      assertEquals(
        hashNumbers(detail),
        [],
        `${category} (${clarity}) detail carries a number: ${detail}`,
      );
    }
  }
});

Deno.test("failure comment - the posted Automated Processing Failed comment names only the target issue for every category (Issue #4585)", async () => {
  for (const category of CATEGORIES) {
    for (const repeat of [false, true]) {
      const dir = await Deno.makeTempDir({ prefix: "fc-4585-" });
      try {
        const calls: string[][] = [];
        const ghCommandFn = async (args: string[]): Promise<string> => {
          calls.push(args);
          return "";
        };

        const result = await markIssueAsFailedOnce({
          repo: "org/repo",
          issueNumber: TARGET_ISSUE,
          githubUser: "worker-user",
          category,
          failureMessage: "The run ended without a usable result",
          repeat,
        }, { ghCommandFn, cacheDir: dir });
        assertEquals(result.ok, true, `${category}: builder failed`);

        const body = commentBody(calls);
        // Guard against a vacuous pass: the real comment must have been built.
        assert(
          body.includes("## Automated Processing Failed"),
          `${category}: comment not built`,
        );
        assert(
          body.includes("### What happens next?"),
          `${category}: comment missing its next-steps section`,
        );

        const stray = hashNumbers(body).filter((n) => n !== `#${TARGET_ISSUE}`);
        assertEquals(
          stray,
          [],
          `${category} (repeat=${repeat}) comment carries a VibeCoder number: ${
            stray.join(", ")
          }`,
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    }
  }
});

// The repo_config refusal is the only path that posts the per-category detail
// bullets (getFailureDiagnosis) into a target-repo comment, so it is rendered
// through handleIssueFailure here as well.
Deno.test("failure comment - the Automated Processing Paused comment for a repo_config refusal names no VibeCoder number (Issue #4585)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "fc-4585-" });
  try {
    const calls: string[][] = [];
    const ghCommandFn = async (args: string[]): Promise<string> => {
      calls.push(args);
      return "";
    };

    const result = await handleIssueFailure({
      repo: "org/repo",
      issueNumber: TARGET_ISSUE,
      githubUser: "worker-user",
      category: "repo_config",
      failureMessage: "The milestone branch was refused by a ruleset",
    }, { ghCommandFn, cacheDir: dir });
    assertEquals(result.ok, true, "repo_config: handler failed");

    const body = commentBody(calls);
    assert(
      body.includes(
        "## Automated Processing Paused (Repository Configuration)",
      ),
      "repo_config: paused comment not built",
    );
    assert(
      body.includes("### Why this issue is NOT labelled"),
      "repo_config: detail section missing",
    );

    const stray = hashNumbers(body).filter((n) => n !== `#${TARGET_ISSUE}`);
    assertEquals(
      stray,
      [],
      `repo_config paused comment carries a VibeCoder number: ${
        stray.join(", ")
      }`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
