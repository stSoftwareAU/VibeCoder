/**
 * Tests for the PR-summary gate registry and its drift check (Issue #4234).
 *
 * The drift half (the `drift - ...` tests) is the source-drift test the issue
 * asks for. It reads `lib/phases/completion_phase.ts` as text, because the
 * completion phase is the one place the full gate sequence is wired, and no
 * unit test can otherwise see a gate being added there. It parses only the
 * `import { ... } from "..."` blocks, with one regex, and it checks two things:
 *
 *   1. every gate function completion_phase imports from a gate module is
 *      listed as a `validator` in PR_SUMMARY_GATES; and
 *   2. every `validator` in PR_SUMMARY_GATES is imported by completion_phase
 *      (or, for a model gate, called as `deps.claude.<name>(`).
 *
 * If one fails, the message names the side to change. Either add or fix the
 * entry in `lib/summary_gate_registry.ts`, or, if the imported function is not
 * a PR-summary gate, narrow `GATE_MODULE` / `GATE_FUNCTION` below and say why.
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

const COMPLETION_PHASE = new URL(
  "../lib/phases/completion_phase.ts",
  import.meta.url,
);

/** Gate modules: the `_gate.ts` family plus the two model-backed gate modules. */
const GATE_MODULE =
  /(?:_gate\.ts|(?:^|\/)(?:summary_claim_check|pre_pr_verifier)\.ts)$/;

/** Gate functions the drift check holds the registry to. */
const GATE_FUNCTION =
  /^(?:validate[A-Z]\w*|find\w*Placeholders|assess[A-Z]\w*|run\w*(?:Check|Verifier))$/;

interface ImportedName {
  name: string;
  module: string;
}

/**
 * Every name in a non-type-only or type-only `import { ... } from "..."` block,
 * with its module. Aliases resolve to the imported name. Line comments inside a
 * block are dropped before the names are split.
 */
function importedNames(source: string): ImportedName[] {
  const out: ImportedName[] = [];
  const block = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)";/g;
  for (const match of source.matchAll(block)) {
    const body = match[1]!.replace(/\/\/[^\n]*/g, "");
    for (const raw of body.split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!
        .trim();
      if (/^\w+$/.test(name)) out.push({ name, module: match[2]! });
    }
  }
  return out;
}

/** Throws with the drift message, one line per problem. */
function driftFailure(problems: string[]): never {
  throw new Error(
    [
      "PR-summary gate registry drift (lib/summary_gate_registry.ts vs lib/phases/completion_phase.ts):",
      ...problems.map((p) => `  - ${p}`),
    ].join("\n"),
  );
}

// --- Drift against completion_phase.ts (sanctioned source-drift test) -------

Deno.test("drift - every gate function completion_phase imports from a gate module is in PR_SUMMARY_GATES", async () => {
  const source = await Deno.readTextFile(COMPLETION_PHASE);
  const gateFunctions = importedNames(source)
    .filter((i) => GATE_MODULE.test(i.module) && GATE_FUNCTION.test(i.name))
    .map((i) => i.name);
  // A parser that matched nothing would pass vacuously; pin a known gate.
  assert(
    gateFunctions.includes("validateDocsSweep"),
    "drift check parsed no gate functions from completion_phase.ts — the import regex or GATE_MODULE is wrong",
  );
  const validators = new Set(PR_SUMMARY_GATES.map((g) => g.validator));
  const missing = [...new Set(gateFunctions)].filter((name) =>
    !validators.has(name)
  );
  if (missing.length > 0) {
    driftFailure(
      missing.map((name) =>
        `completion_phase.ts imports the gate function ${name}, but no PR_SUMMARY_GATES entry names it as validator: add an entry for it to lib/summary_gate_registry.ts (or, if it is not a PR-summary gate, narrow GATE_MODULE / GATE_FUNCTION in tests/pr_summary_gate_registry_test.ts and say why)`
      ),
    );
  }
});

Deno.test("drift - every PR_SUMMARY_GATES validator is imported by completion_phase", async () => {
  const source = await Deno.readTextFile(COMPLETION_PHASE);
  const imported = new Set(importedNames(source).map((i) => i.name));
  const problems: string[] = [];
  for (const gate of PR_SUMMARY_GATES) {
    if (imported.has(gate.validator)) continue;
    // A model gate runs through the injected `deps.claude` seam, not an import.
    if (
      gate.localCheck === "model" &&
      source.includes(`deps.claude.${gate.validator}(`)
    ) {
      continue;
    }
    problems.push(
      `PR_SUMMARY_GATES entry "${gate.id}" names the validator ${gate.validator}, which completion_phase.ts neither imports nor calls as deps.claude.${gate.validator}(: point the entry at the function the completion phase actually calls (or fix the entry's validator) in lib/summary_gate_registry.ts`,
    );
  }
  if (problems.length > 0) driftFailure(problems);
});

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
