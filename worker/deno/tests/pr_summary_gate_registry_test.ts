/**
 * Tests for the PR-summary gate registry and its drift check (Issue #4234).
 *
 * The drift test runs the live completion phase (`runCompletion`, the shared
 * harness) over one summary that blocks every gate at once, and checks that the
 * gate ids the first recorded summary-rule verdict carries are exactly the
 * registry entries, less the `NOT_FOLDED` exceptions below. A gate the
 * completion phase records but the registry does not hold, or a registry entry
 * the completion phase never records, fails the test and names the id.
 *
 * An exception is an id listed in `NOT_FOLDED` with a reason beside it, never a
 * silent skip. The drift test does not read source text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { GitRunner } from "../lib/git_base_ref.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import {
  type GateReport,
  runPrSummaryCheck,
  type SummaryGateContext,
} from "../lib/pr_summary_check.ts";
import type { PrePrVerifierResult } from "../lib/pre_pr_verifier.ts";
import { PR_SUMMARY_GATES } from "../lib/summary_gate_registry.ts";
import type { SummaryClaimCheckResult } from "../lib/summary_claim_check.ts";
import {
  runCompletion,
  type Scenario,
} from "./support/completion_summary_harness.ts";

// --- Drift against the live completion phase (behavioural) ------------------

/** The file the maximal run changes as a test (its removed assertion). */
const MAXIMAL_TEST_FILE = "worker/deno/tests/maximal_block_fixture_test.ts";

/** A library file the run changes; the mutation and coverage runners name it. */
const MAXIMAL_LIB_FILE = "worker/deno/lib/summary_rule_gate_retry.ts";

/** The claim sentence the summary carries, which the scripted model names. */
const MAXIMAL_CLAIM = "The recovery turn writes the closure block.";

/**
 * A summary no gate accepts: it carries a prompt-scrubbed marker (U+2024) and a
 * result placeholder, and omits the closure, review, reproduction, docs sweep,
 * branch outcomes and unmet-criteria blocks. Its Test Plan does not account for
 * the removed assertion.
 */
const MAXIMAL_SUMMARY = [
  "## Summary",
  "",
  "Recovers in-run.",
  "",
  MAXIMAL_CLAIM,
  "",
  "<․!-- prompt-scrubbed notice -->",
  "",
  "QUALITY_RESULT_PLACEHOLDER",
  "",
  "## Test Plan",
  "",
  "- Ran the suite.",
  "",
].join("\n");

/** A test patch that drops one assertion the Test Plan does not name. */
const MAXIMAL_TEST_PATCH = [
  `diff --git a/${MAXIMAL_TEST_FILE} b/${MAXIMAL_TEST_FILE}`,
  `--- a/${MAXIMAL_TEST_FILE}`,
  `+++ b/${MAXIMAL_TEST_FILE}`,
  "@@ -2,3 +2,2 @@",
  "   const result = run();",
  "-  assertEquals(result.code, 0);",
  "   assertEquals(result.other, 1);",
  "",
].join("\n");

/**
 * The scenario that blocks every gate the completion phase folds. The bug label
 * engages the reproduction gate; the scripted runners supply the mutation and
 * coverage verdicts, the claim sentence and the verifier finding.
 */
const MAXIMAL_SCENARIO: Scenario = {
  summary: MAXIMAL_SUMMARY,
  labels: ["bug", "enhancement", "work-on"],
  claimSentences: [[MAXIMAL_CLAIM]],
  verifier: [{
    status: "checked",
    review: {
      summary: "problems found",
      findings: [{
        file: MAXIMAL_LIB_FILE,
        line: 3,
        problem: "the guard is missing",
      }],
      testChanges: "none",
      testChangeNotes: [],
      unrelatedIssues: [],
      checklist: [],
      closure: [],
    },
  }],
  mutationSurvivors: [{
    file: MAXIMAL_LIB_FILE,
    line: 3,
    description: "flip the guard",
  }],
  uncoveredLines: [{ file: MAXIMAL_TEST_FILE, line: 2 }],
  testFileChange: { file: MAXIMAL_TEST_FILE, patch: MAXIMAL_TEST_PATCH },
};

/**
 * The registry gate ids the completion phase is allowed not to record. Each
 * entry needs a reason beside it. Empty today: every registry gate is folded
 * into the summary-rule block the completion phase records.
 */
const NOT_FOLDED: readonly string[] = [];

Deno.test("drift - a maximal-blocking completion run records every registry gate, less NOT_FOLDED", async () => {
  const outcome = await runCompletion(MAXIMAL_SCENARIO);
  const first = outcome.summaryRuleBlocks[0];
  assert(
    first !== undefined,
    "the maximal-blocking run recorded no summary-rule verdict",
  );
  assert(
    first.gates !== undefined,
    "the first summary-rule verdict carries no gate ids",
  );
  const recorded = [...first.gates];
  const expected = PR_SUMMARY_GATES.map((g) => g.id).filter((id) =>
    !NOT_FOLDED.includes(id)
  );
  const problems: string[] = [];
  for (const id of new Set(recorded)) {
    if (recorded.filter((r) => r === id).length > 1) {
      problems.push(`completion phase recorded gate "${id}" more than once`);
    }
  }
  for (const id of expected) {
    if (!recorded.includes(id)) {
      problems.push(
        `registry gate "${id}" is not recorded by the completion phase: wire it into the late-verdict fold in lib/phases/completion_phase.ts, or list it in NOT_FOLDED with a reason in tests/pr_summary_gate_registry_test.ts`,
      );
    }
  }
  for (const id of recorded) {
    if (!expected.includes(id)) {
      problems.push(
        `completion phase recorded gate "${id}", which is not a registry entry in PR_SUMMARY_GATES (lib/summary_gate_registry.ts), or is listed in NOT_FOLDED: add or fix its entry, or correct NOT_FOLDED`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      [
        "PR-summary gate registry drift (lib/summary_gate_registry.ts vs the completion phase's recorded gates):",
        ...problems.map((p) => `  - ${p}`),
      ].join("\n"),
    );
  }
});

// --- Registry shape ----------------------------------------------------------

Deno.test("registry - ids and names are unique and every gate carries an issue reference", () => {
  const ids = PR_SUMMARY_GATES.map((g) => g.id);
  const names = PR_SUMMARY_GATES.map((g) => g.name);
  assertEquals(new Set(ids).size, ids.length);
  assertEquals(new Set(names).size, names.length);
  for (const gate of PR_SUMMARY_GATES) {
    assert(/^#\d+$/.test(gate.issueRef), `${gate.id} has no issue reference`);
  }
});

// --- Every registry entry has a report --------------------------------------

/** Fake git: a base resolves, the diff touches one library file. */
function fakeGit(): GitRunner {
  return (args) => {
    const ok = (stdout = "", code = 0) =>
      Promise.resolve({
        ok: true as const,
        value: { code, stdout, stderr: "" },
      });
    if (args[0] === "rev-parse") return ok();
    if (args[0] === "diff") return ok("worker/deno/lib/foo.ts\n");
    if (args.includes("ls-tree")) return ok("");
    return ok();
  };
}

const CLEAN_CLAIM: SummaryClaimCheckResult = {
  findings: [],
  docFindings: [],
  unconfirmedFindings: [],
  testPlanProblems: [],
  notChecked: [],
};

const NOT_CHECKED_VERIFIER: PrePrVerifierResult = {
  status: "not_checked",
  reason: "fake",
};

Deno.test("runPrSummaryCheck - every PR_SUMMARY_GATES entry has exactly one report, by name and ref", async () => {
  const claimCalls: SummaryGateContext[] = [];
  const result = await runPrSummaryCheck({
    summaryContent: "## Summary\n\nAdds foo.\n",
    issueNumber: null,
    summaryPath: "docs/archive/pr-summaries/pr-summary-7.md",
    baseBranch: "main",
    issueBody: "## Acceptance Criteria\n\n- [ ] foo is handled\n",
    issueTitle: "Handle foo",
    issueLabels: "enhancement",
    runGit: fakeGit(),
    repoRoot: "/repo",
    claimCheck: (ctx) => {
      claimCalls.push(ctx);
      return Promise.resolve(CLEAN_CLAIM);
    },
    verifier: () => Promise.resolve(NOT_CHECKED_VERIFIER),
  });
  assert(result.ok);
  const reports: GateReport[] = result.value;
  assertEquals(
    reports.map((r) => r.gate).sort(),
    PR_SUMMARY_GATES.map((g) => g.name).sort(),
  );
  for (const gate of PR_SUMMARY_GATES) {
    const matches = reports.filter((r) => r.gate === gate.name);
    assertEquals(matches.length, 1, `one report for ${gate.name}`);
    assertEquals(matches[0]!.issueRef, gate.issueRef);
    if (gate.localCheck === "worker-only") {
      assertEquals(matches[0]!.status, "not_checked");
      assert(
        (matches[0]!.note ?? "").length > 0,
        `${gate.name} says why it is not checked`,
      );
    }
  }
  assertEquals(claimCalls.length, 1);
  assertEquals(
    claimCalls[0]!.summaryPath,
    "docs/archive/pr-summaries/pr-summary-7.md",
  );
  assertEquals(claimCalls[0]!.changedFiles, ["worker/deno/lib/foo.ts"]);
});

// --- Removed-assertion gate, against a temp git repository ------------------

const TEST_FILE = "tests/foo_test.ts";
const REMOVED_LINE = "  assertEquals(result.code, 0);";
const BASE_TEST = [
  'Deno.test("foo", () => {',
  "  const result = run();",
  REMOVED_LINE,
  "  assertEquals(result.other, 1);",
  "});",
  "",
].join("\n");
const ISSUE_BODY = "Change the numeric score to a rating for every decision.\n";
const ACCOUNTED_SUMMARY = [
  "## Summary",
  "",
  "Drops one assertion.",
  "",
  "## Test Plan",
  "",
  "- Removed from `tests/foo_test.ts`: `assertEquals(result.code, 0)`",
  '  Required by: "Change the numeric score to a rating"',
  "",
].join("\n");
const UNACCOUNTED_SUMMARY = [
  "## Summary",
  "",
  "Drops one assertion.",
  "",
  "## Test Plan",
  "",
  "- Ran the suite.",
  "",
].join("\n");
const NO_TEST_PLAN_SUMMARY = "## Summary\n\nDrops one assertion.\n";

async function git(dir: string, args: string[]): Promise<void> {
  const r = await runGitCommand(args, { cwd: dir });
  if (!r.ok || r.value.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
}

/** A repo with `main` holding the test, and a `feature` branch that drops the assertion. */
async function repoDroppingAssertion(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "pr-summary-gates-" });
  await git(dir, ["init", "-q"]);
  await git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await Deno.mkdir(`${dir}/tests`, { recursive: true });
  await Deno.writeTextFile(`${dir}/${TEST_FILE}`, BASE_TEST);
  const identity = [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
  ];
  await git(dir, ["add", "-A"]);
  await git(dir, [...identity, "commit", "-q", "-m", "base"]);
  await git(dir, ["checkout", "-q", "-b", "feature"]);
  await Deno.writeTextFile(
    `${dir}/${TEST_FILE}`,
    BASE_TEST.replace(REMOVED_LINE + "\n", ""),
  );
  await git(dir, ["add", "-A"]);
  await git(dir, [...identity, "commit", "-q", "-m", "drop assertion"]);
  return dir;
}

/** The removed-assertion report for a summary, from the real git in `dir`. */
async function removedAssertionReportFor(
  dir: string,
  summaryContent: string,
  issueBody: string | null,
): Promise<GateReport> {
  const result = await runPrSummaryCheck({
    summaryContent,
    issueNumber: null,
    baseBranch: "main",
    issueBody,
    issueTitle: null,
    issueLabels: "enhancement",
    runGit: (args, options) => runGitCommand(args, options),
    repoRoot: dir,
  });
  assert(result.ok, result.ok ? "" : result.error.message);
  return result.value.find((r) => r.issueRef === "#3131")!;
}

Deno.test("removed-assertion gate - a dropped assertion with no Test Plan blocks", async () => {
  const dir = await repoDroppingAssertion();
  try {
    const report = await removedAssertionReportFor(
      dir,
      NO_TEST_PLAN_SUMMARY,
      ISSUE_BODY,
    );
    assertEquals(report.gate, "Removed test assertions");
    assertEquals(report.status, "blocked");
    assertStringIncludes(report.problems.join("\n"), "## Test Plan");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("removed-assertion gate - a dropped assertion the Test Plan does not name blocks", async () => {
  const dir = await repoDroppingAssertion();
  try {
    const report = await removedAssertionReportFor(
      dir,
      UNACCOUNTED_SUMMARY,
      ISSUE_BODY,
    );
    assertEquals(report.status, "blocked");
    assertStringIncludes(
      report.problems.join("\n"),
      "not named in the Test Plan",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("removed-assertion gate - a dropped assertion accounted for with a verified quote passes", async () => {
  const dir = await repoDroppingAssertion();
  try {
    const report = await removedAssertionReportFor(
      dir,
      ACCOUNTED_SUMMARY,
      ISSUE_BODY,
    );
    assertEquals(report.status, "passed");
    assertEquals(report.problems, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("removed-assertion gate - without an issue body it is not checked, not a pass", async () => {
  const dir = await repoDroppingAssertion();
  try {
    const report = await removedAssertionReportFor(
      dir,
      UNACCOUNTED_SUMMARY,
      null,
    );
    assertEquals(report.status, "not_checked");
    assertEquals(report.note, "no --issue-body-file given");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Claim check and verifier: absent, blocked, and opt-in ------------------

/** One input for the fake-git runs of the model-backed gates. */
function modelInput(
  extra: Partial<Parameters<typeof runPrSummaryCheck>[0]> = {},
): Parameters<typeof runPrSummaryCheck>[0] {
  return {
    summaryContent: "## Summary\n\nAdds foo.\n",
    issueNumber: null,
    baseBranch: "main",
    issueBody: null,
    issueTitle: null,
    issueLabels: null,
    runGit: fakeGit(),
    repoRoot: "/repo",
    ...extra,
  };
}

Deno.test("claim check - absent is not checked, never a pass", async () => {
  const result = await runPrSummaryCheck(modelInput());
  assert(result.ok);
  const report = result.value.find((r) => r.issueRef === "#3257")!;
  assertEquals(report.status, "not_checked");
  assertStringIncludes(report.note ?? "", "model call");
});

Deno.test("claim check - present and blocked is a block with the reason", async () => {
  const blocking: SummaryClaimCheckResult = {
    ...CLEAN_CLAIM,
    findings: [{
      file: "docs/archive/pr-summaries/pr-summary-7.md",
      sentence: "The gate runs first.",
      reason: "it runs last",
    }],
  };
  const result = await runPrSummaryCheck(modelInput({
    claimCheck: () => Promise.resolve(blocking),
  }));
  assert(result.ok);
  const report = result.value.find((r) => r.issueRef === "#3257")!;
  assertEquals(report.status, "blocked");
  assertStringIncludes(report.problems.join("\n"), "The gate runs first.");
});

Deno.test("claim check - present and clean passes, and an unrun part is not checked", async () => {
  const clean = await runPrSummaryCheck(modelInput({
    claimCheck: () => Promise.resolve(CLEAN_CLAIM),
  }));
  assert(clean.ok);
  assertEquals(
    clean.value.find((r) => r.issueRef === "#3257")!.status,
    "passed",
  );

  const partial = await runPrSummaryCheck(modelInput({
    claimCheck: () =>
      Promise.resolve({
        ...CLEAN_CLAIM,
        notChecked: ["model reply unreadable"],
      }),
  }));
  assert(partial.ok);
  const report = partial.value.find((r) => r.issueRef === "#3257")!;
  assertEquals(report.status, "not_checked");
  assertStringIncludes(report.note ?? "", "model reply unreadable");
});

Deno.test("verifier - opt-in: absent is not checked and the note names --verifier", async () => {
  const result = await runPrSummaryCheck(modelInput());
  assert(result.ok);
  const report = result.value.find((r) => r.issueRef === "#3395")!;
  assertEquals(report.status, "not_checked");
  assertStringIncludes(report.note ?? "", "--verifier");
});

Deno.test("verifier - present with a finding blocks; present not_checked stays not checked", async () => {
  const blocked = await runPrSummaryCheck(modelInput({
    verifier: () =>
      Promise.resolve({
        status: "checked",
        review: {
          summary: "",
          findings: [{
            file: "worker/deno/lib/foo.ts",
            line: 3,
            problem: "the guard is missing",
          }],
          testChanges: "none",
          testChangeNotes: [],
          unrelatedIssues: [],
          checklist: [],
          closure: [],
        },
      }),
  }));
  assert(blocked.ok);
  const report = blocked.value.find((r) => r.issueRef === "#3395")!;
  assertEquals(report.status, "blocked");
  assertStringIncludes(report.problems.join("\n"), "the guard is missing");

  const unchecked = await runPrSummaryCheck(modelInput({
    verifier: () => Promise.resolve(NOT_CHECKED_VERIFIER),
  }));
  assert(unchecked.ok);
  const notRun = unchecked.value.find((r) => r.issueRef === "#3395")!;
  assertEquals(notRun.status, "not_checked");
  assertEquals(notRun.note, "fake");
});

Deno.test("removed-assertion gate - an unreadable test diff with a Test Plan heading is not checked, not a pass", async () => {
  // Rename-status lists the test file; the patch call then fails, so the
  // per-assertion rule cannot run and the verdict must not read as clean.
  const git: GitRunner = (args) => {
    const ok = (stdout = "", code = 0) =>
      Promise.resolve({
        ok: true as const,
        value: { code, stdout, stderr: "" },
      });
    if (args[0] === "rev-parse") return ok();
    if (args[0] === "diff" && args.includes("--name-only")) {
      return ok(`${TEST_FILE}\n`);
    }
    if (args[0] === "diff" && args.includes("--name-status")) {
      return ok(`M\0${TEST_FILE}\0`);
    }
    if (args[0] === "diff") return ok("", 128);
    return ok();
  };
  const result = await runPrSummaryCheck({
    summaryContent:
      "## Summary\n\nDrops one assertion.\n\n## Test Plan\n\n- Ran the suite.\n",
    issueNumber: null,
    baseBranch: "main",
    issueBody: ISSUE_BODY,
    issueTitle: null,
    issueLabels: "enhancement",
    runGit: git,
    repoRoot: "/repo",
  });
  assert(result.ok);
  const report = result.value.find((r) => r.issueRef === "#3131")!;
  assertEquals(report.status, "not_checked");
  assertStringIncludes(report.note ?? "", "could not be read");
});

Deno.test("unmet-criteria gate - an issue criterion the summary leaves unmet blocks with the count", async () => {
  const result = await runPrSummaryCheck(modelInput({
    summaryContent: "## Summary\n\nAdds foo.\n",
    issueBody: "## Acceptance Criteria\n\n- [ ] foo is handled\n",
  }));
  assert(result.ok);
  const report = result.value.find((r) => r.issueRef === "#4146")!;
  assertEquals(report.gate, "Unmet acceptance criteria");
  assertEquals(report.status, "blocked");
  assertStringIncludes(report.problems[0]!, "acceptance criterion is not met");
});
