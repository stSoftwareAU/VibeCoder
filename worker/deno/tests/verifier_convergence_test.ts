/**
 * Verifier convergence on a retry (Issue #4234, point 5). The changed lines
 * come from real `git diff -U0` text read by `parseDiffChangedLines`.
 */

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import type { ClaudeRunResult } from "../lib/claude_runner.ts";
import { parseDiffChangedLines } from "../lib/caller_checks.ts";
import {
  buildPrePrVerifierGateComment,
  PRE_PR_VERIFIER_COMMENT_HEADING,
  type PrePrVerifierResult,
  type ReviewFinding,
  type ReviewReply,
} from "../lib/pre_pr_verifier.ts";
import {
  applyConvergence,
  buildAdvisoryFindingsComment,
  findingToEarlierText,
  PRE_PR_VERIFIER_ADVISORY_HEADING,
  previousFindingsFromGateComment,
  splitFindingsForRetry,
} from "../lib/verifier_convergence.ts";

// `git diff -U0`: a.ts lines 10 and 11 are rewritten; b.ts loses two lines
// after line 39, so the deletion anchors on line 39.
const DIFF = [
  "diff --git a/worker/deno/lib/a.ts b/worker/deno/lib/a.ts",
  "index 1111111..2222222 100644",
  "--- a/worker/deno/lib/a.ts",
  "+++ b/worker/deno/lib/a.ts",
  "@@ -10 +10,2 @@ export function f() {",
  "-  return 1;",
  "+  return 2;",
  "+  return 3;",
  "diff --git a/worker/deno/lib/b.ts b/worker/deno/lib/b.ts",
  "index 3333333..4444444 100644",
  "--- a/worker/deno/lib/b.ts",
  "+++ b/worker/deno/lib/b.ts",
  "@@ -40,2 +39,0 @@ export function g() {",
  "-gone one",
  "-gone two",
  "",
].join("\n");

// A quoted header (a non-ASCII name) is counted as unparsed.
const QUOTED_DIFF = [
  'diff --git "a/worker/deno/lib/caf\\303\\251.ts" "b/worker/deno/lib/caf\\303\\251.ts"',
  "index 5555555..6666666 100644",
  '--- "a/worker/deno/lib/caf\\303\\251.ts"',
  '+++ "b/worker/deno/lib/caf\\303\\251.ts"',
  "@@ -1 +1 @@",
  "-x",
  "+y",
  "",
].join("\n");

const changed = parseDiffChangedLines(DIFF);
const unparsedChanged = parseDiffChangedLines(QUOTED_DIFF);

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  file: "worker/deno/lib/a.ts",
  line: 50,
  problem: "a problem",
  ...over,
});

const UNCHANGED_LINE = finding({ severity: "medium" });

Deno.test("fixture: the diff parses to the lines it changes, and quoted names count as unparsed", () => {
  assertEquals(changed.unparsed, 0);
  assertEquals(changed.files.get("worker/deno/lib/a.ts"), [10, 11]);
  assertEquals(changed.files.get("worker/deno/lib/b.ts"), [39]);
  assertEquals(unparsedChanged.unparsed, 1);
});

Deno.test("isRetry false keeps every finding blocking, whatever its severity", () => {
  const findings = [
    UNCHANGED_LINE,
    finding({ severity: "low" }),
    finding({}),
  ];
  const split = splitFindingsForRetry({
    findings,
    isRetry: false,
    changed,
  });
  assertEquals(split.blocking, findings);
  assertEquals(split.advisory, []);
});

Deno.test("on a retry a medium finding on an unchanged line is advisory", () => {
  const split = splitFindingsForRetry({
    findings: [UNCHANGED_LINE],
    isRetry: true,
    changed,
  });
  assertEquals(split.advisory, [UNCHANGED_LINE]);
  assertEquals(split.blocking, []);
});

Deno.test("on a retry a low or unset severity on an unchanged line is advisory", () => {
  const low = finding({ severity: "low" });
  const unset = finding({ line: 51 });
  const split = splitFindingsForRetry({
    findings: [low, unset],
    isRetry: true,
    changed,
  });
  assertEquals(split.advisory, [low, unset]);
  assertEquals(split.blocking, []);
});

Deno.test("the same unchanged-line finding blocks at severity high or critical", () => {
  const high = finding({ severity: "high" });
  const critical = finding({ severity: "critical" });
  const split = splitFindingsForRetry({
    findings: [high, critical],
    isRetry: true,
    changed,
  });
  assertEquals(split.blocking, [high, critical]);
  assertEquals(split.advisory, []);
});

Deno.test("a finding on a changed line blocks on a retry, including a deletion anchor", () => {
  const onChanged = finding({ line: 11, severity: "low" });
  const onDeletion = finding({
    file: "worker/deno/lib/b.ts",
    line: 39,
    severity: "medium",
  });
  const split = splitFindingsForRetry({
    findings: [onChanged, onDeletion],
    isRetry: true,
    changed,
  });
  assertEquals(split.blocking, [onChanged, onDeletion]);
  assertEquals(split.advisory, []);
});

Deno.test("a synthetic finding blocks on a retry even on a line the change does not touch", () => {
  const earlier = finding({
    file: "(earlier review)",
    line: 7,
    severity: "low",
  });
  const checkout = finding({
    file: "(issue checkout)",
    line: 3,
    severity: "low",
  });
  const split = splitFindingsForRetry({
    findings: [earlier, checkout],
    isRetry: true,
    changed,
  });
  assertEquals(split.blocking, [earlier, checkout]);
  assertEquals(split.advisory, []);
});

Deno.test("a finding at line 0 blocks on a retry, in a changed file or not", () => {
  const inChanged = finding({ line: 0, severity: "low" });
  const notInDiff = finding({
    file: "worker/deno/lib/other.ts",
    line: 0,
    severity: "low",
  });
  const split = splitFindingsForRetry({
    findings: [inChanged, notInDiff],
    isRetry: true,
    changed,
  });
  assertEquals(split.blocking, [inChanged, notInDiff]);
  assertEquals(split.advisory, []);
});

Deno.test("a null diff fails closed: every finding blocks on a retry", () => {
  const split = splitFindingsForRetry({
    findings: [UNCHANGED_LINE],
    isRetry: true,
    changed: null,
  });
  assertEquals(split.blocking, [UNCHANGED_LINE]);
  assertEquals(split.advisory, []);
});

Deno.test("an unparsed diff fails closed: a finding in a file the diff does not touch blocks", () => {
  const elsewhere = finding({
    file: "worker/deno/lib/other.ts",
    line: 5,
    severity: "medium",
  });
  const split = splitFindingsForRetry({
    findings: [elsewhere],
    isRetry: true,
    changed: unparsedChanged,
  });
  assertEquals(split.blocking, [elsewhere]);
  assertEquals(split.advisory, []);
});

Deno.test("a file the diff does not touch is advisory on a retry", () => {
  const elsewhere = finding({
    file: "worker/deno/lib/other.ts",
    line: 5,
    severity: "medium",
  });
  const split = splitFindingsForRetry({
    findings: [elsewhere],
    isRetry: true,
    changed,
  });
  assertEquals(split.advisory, [elsewhere]);
  assertEquals(split.blocking, []);
});

Deno.test("a path spelled with ./ or backslashes is placed as its git spelling", () => {
  const dotSlash = finding({
    file: "./worker/deno/lib/a.ts",
    line: 11,
    severity: "medium",
  });
  const backslash = finding({
    file: "worker\\deno\\lib\\a.ts",
    line: 11,
    severity: "medium",
  });
  const unchangedDotSlash = finding({
    file: "./worker/deno/lib/a.ts",
    line: 50,
    severity: "medium",
  });
  const split = splitFindingsForRetry({
    findings: [dotSlash, backslash, unchangedDotSlash],
    isRetry: true,
    changed,
  });
  assertEquals(split.blocking, [dotSlash, backslash]);
  assertEquals(split.advisory, [unchangedDotSlash]);
});

Deno.test("an absolute, drive-letter or .. path blocks on a retry, whatever its line", () => {
  const absolute = finding({
    file: "/abs/worker/deno/lib/a.ts",
    line: 50,
    severity: "medium",
  });
  const parent = finding({
    file: "../x.ts",
    line: 50,
    severity: "medium",
  });
  const drive = finding({
    file: "C:\\repo\\worker\\deno\\lib\\a.ts",
    line: 50,
    severity: "medium",
  });
  const inside = finding({
    file: "worker/deno/../lib/other.ts",
    line: 5,
    severity: "medium",
  });
  const split = splitFindingsForRetry({
    findings: [absolute, parent, drive, inside],
    isRetry: true,
    changed,
  });
  assertEquals(split.blocking, [absolute, parent, drive, inside]);
  assertEquals(split.advisory, []);
});

Deno.test("applyConvergence returns the same object when nothing is demoted", () => {
  const result: PrePrVerifierResult = {
    status: "checked",
    review: reviewWith([finding({ severity: "high" })]),
  };
  const split = splitFindingsForRetry({
    findings: result.review.findings,
    isRetry: true,
    changed,
  });
  assertStrictEquals(applyConvergence(result, split), result);
});

Deno.test("applyConvergence drops advisory findings and keeps the checklist and run", () => {
  const blocking = finding({ severity: "high" });
  const advisory = UNCHANGED_LINE;
  const run = { output: "{}" } as unknown as ClaudeRunResult;
  const review = {
    ...reviewWith([blocking, advisory]),
    checklist: [{
      checklist: "c",
      item: "i",
      verdict: "missing" as const,
      note: "n",
    }],
  };
  const result: PrePrVerifierResult = { status: "checked", review, run };
  const split = splitFindingsForRetry({
    findings: review.findings,
    isRetry: true,
    changed,
  });
  const applied = applyConvergence(result, split);
  assert(applied.status === "checked");
  assertEquals(applied.review.findings, [blocking]);
  assertEquals(applied.review.checklist, review.checklist);
  assertStrictEquals(applied.run, run);
});

Deno.test("applyConvergence passes a not_checked result through unchanged", () => {
  const result: PrePrVerifierResult = {
    status: "not_checked",
    reason: "verifier timed out",
  };
  const split = splitFindingsForRetry({
    findings: [UNCHANGED_LINE],
    isRetry: true,
    changed,
  });
  assertStrictEquals(applyConvergence(result, split), result);
});

Deno.test("findingToEarlierText reads like the gate comment's bullet", () => {
  assertEquals(
    findingToEarlierText(
      finding({ problem: "returns the stale value", fix: "read it again" }),
    ),
    "`worker/deno/lib/a.ts:50` — returns the stale value — fix: read it again",
  );
  assertEquals(
    findingToEarlierText(finding({ problem: "no fix given" })),
    "`worker/deno/lib/a.ts:50` — no fix given",
  );
});

Deno.test("the gate comment round-trips: each finding comes back as its earlier text", () => {
  const findings = [
    finding({ problem: "first problem", fix: "first fix" }),
    finding({ file: "worker/deno/lib/b.ts", line: 39, problem: "second" }),
  ];
  const comment = buildPrePrVerifierGateComment(reviewWith(findings));
  const back = previousFindingsFromGateComment(comment);
  assertEquals(back.length, findings.length);
  assertEquals(back, findings.map(findingToEarlierText));
  findings.forEach((f, i) => assertStringIncludes(back[i]!, f.problem));
});

Deno.test("the gate comment round-trip keeps the missing-checklist bullets too", () => {
  const review: ReviewReply = {
    ...reviewWith([finding({ problem: "a finding" })]),
    checklist: [{
      checklist: "security",
      item: "input is validated",
      verdict: "missing",
      note: "not checked",
    }],
  };
  const back = previousFindingsFromGateComment(
    buildPrePrVerifierGateComment(review),
  );
  assertEquals(back.length, 2);
  assertStringIncludes(back[0]!, "a finding");
  assertStringIncludes(back[1]!, "input is validated");
});

Deno.test("previousFindingsFromGateComment returns [] for a comment that is not the gate comment", () => {
  assertEquals(previousFindingsFromGateComment("Looks good to me."), []);
  assertEquals(
    previousFindingsFromGateComment(
      `Please see below.\n${PRE_PR_VERIFIER_COMMENT_HEADING}\n- \`a.ts:1\` — x`,
    ),
    [],
  );
});

Deno.test("the advisory comment is empty for no findings and names its heading otherwise", () => {
  assertEquals(buildAdvisoryFindingsComment([]), "");
  const comment = buildAdvisoryFindingsComment([UNCHANGED_LINE]);
  assert(comment.startsWith(PRE_PR_VERIFIER_ADVISORY_HEADING));
  assertStringIncludes(comment, "- `worker/deno/lib/a.ts:50` — a problem");
});

function reviewWith(findings: ReviewFinding[]): ReviewReply {
  return {
    summary: "a summary",
    findings,
    testChanges: "none",
    testChangeNotes: [],
    unrelatedIssues: [],
    checklist: [],
    closure: [],
  };
}
