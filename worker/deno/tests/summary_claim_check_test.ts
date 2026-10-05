/**
 * Tests for the first-run PR-summary claim check (Issue #3257).
 *
 * Real temporary files for the Test Plan backstop — its whole job is
 * reading repo-relative test files from disk — and real calls (not stubs)
 * for the deterministic word-matching logic. The model seam (`askQuestion`)
 * and git seam (`runGit`) are faked for `runSummaryClaimCheck`, mirroring
 * `pr_feedback_drift_check_3143_test.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { DRIFT_VERDICT_OPEN } from "../lib/pr_feedback_drift_check.ts";
import {
  buildSummaryClaimGateComment,
  buildSummaryClaimQuestionPrompt,
  describeTestPlanClaimProblem,
  findTestPlanClaimProblems,
  runSummaryClaimCheck,
  summaryClaimBlockReason,
  summaryClaimCheckBlocked,
  type SummaryClaimCheckResult,
} from "../lib/summary_claim_check.ts";
import { assertLinearGrowth } from "./support/growth.ts";
import type { Logger, Result } from "../types.ts";

function makeLogger(): Pick<Logger, "info" | "warn" | "error"> & {
  errors: string[];
  warns: string[];
} {
  const errors: string[] = [];
  const warns: string[] = [];
  return {
    errors,
    warns,
    info: () => {},
    warn: (message: string) => {
      warns.push(message);
    },
    error: (message: string) => {
      errors.push(message);
    },
  };
}

// ---------------------------------------------------------------------------
// findTestPlanClaimProblems
// ---------------------------------------------------------------------------

const SUMMARY_WITH_COVERAGE_CLAIM = (testFile: string, quote: string) =>
  `## Test Plan\n\n- \`${testFile}\` covers "${quote}"\n`;

Deno.test("findTestPlanClaimProblems - #3132-shaped: unrelated test content is a no-matching-test problem", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/result_placeholder_gate_test.ts",
    "caps on scan size and named tokens",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/result_placeholder_gate_test.ts"],
    readFile: async () =>
      `Deno.test("rejects an empty placeholder", () => {\n  assertEquals(1, 1);\n});\n`,
  });
  assertEquals(result.problems.length, 1);
  assertEquals(result.problems[0]?.kind, "no-matching-test");
  assertEquals(
    result.problems[0]?.testFile,
    "worker/deno/tests/result_placeholder_gate_test.ts",
  );
});

Deno.test("findTestPlanClaimProblems - a matching Deno.test name confirms the claim, no problem", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/result_placeholder_gate_test.ts",
    "caps on scan size and named tokens",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/result_placeholder_gate_test.ts"],
    readFile: async () =>
      `Deno.test("caps the scan size and the named tokens", () => {\n  assertEquals(1, 1);\n});\n`,
  });
  assertEquals(result.problems, []);
});

Deno.test("findTestPlanClaimProblems - a missing file is a missing-file problem", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/nonexistent_test.ts",
    "handles the empty input case correctly",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/result_placeholder_gate_test.ts"],
    readFile: async () => undefined,
  });
  assertEquals(result.problems.length, 1);
  assertEquals(result.problems[0]?.kind, "missing-file");
  assertEquals(result.problems[0]?.testFile, "worker/deno/tests/nonexistent_test.ts");
});

Deno.test("findTestPlanClaimProblems - a bare basename resolves by unique suffix", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "foo_test.ts",
    "rejects a malformed header entirely",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async (path) => {
      assertEquals(path, "worker/deno/tests/foo_test.ts");
      return `Deno.test("rejects a malformed header entirely", () => {});\n`;
    },
  });
  assertEquals(result.problems, []);
  assertEquals(result.notChecked, []);
});

Deno.test("findTestPlanClaimProblems - an ambiguous basename is notChecked, no problem", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "foo_test.ts",
    "rejects a malformed header entirely",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: [
      "worker/deno/tests/foo_test.ts",
      "worker/other/foo_test.ts",
    ],
    readFile: async () => {
      throw new Error("must not be read — ambiguous reference");
    },
  });
  assertEquals(result.problems, []);
  assert(
    result.notChecked.some((n) => n.includes("more than one")),
    `expected an ambiguity note, got ${JSON.stringify(result.notChecked)}`,
  );
});

Deno.test("findTestPlanClaimProblems - a quoted phrase inside backticks is not read as a behaviour", async () => {
  const summary =
    `## Test Plan\n\n- \`worker/deno/tests/foo_test.ts\` runs \`"not a behaviour claim"\`\n`;
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => {
      throw new Error("must not be read — no quoted behaviour outside backticks");
    },
  });
  assertEquals(result.problems, []);
  assertEquals(result.notChecked, []);
});

Deno.test("findTestPlanClaimProblems - a one-significant-word quote is ignored", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts",
    "it works",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => {
      throw new Error("must not be read — quote has fewer than 2 significant words");
    },
  });
  assertEquals(result.problems, []);
  assertEquals(result.notChecked, []);
});

Deno.test("findTestPlanClaimProblems - a block with no test path is ignored", async () => {
  const summary =
    `## Test Plan\n\n- Manually verified "the whole login flow end to end"\n`;
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: [],
    readFile: async () => {
      throw new Error("must not be read — block names no test file");
    },
  });
  assertEquals(result.problems, []);
  assertEquals(result.notChecked, []);
});

Deno.test("findTestPlanClaimProblems - a cap of 50 claims reports the unchecked count", async () => {
  const lines = ["## Test Plan", ""];
  for (let i = 0; i < 51; i++) {
    lines.push(
      `- \`worker/deno/tests/foo_test.ts\` covers "distinct behaviour number ${i} here"`,
    );
  }
  const summary = lines.join("\n");
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => `Deno.test("something else entirely", () => {});\n`,
  });
  assertEquals(result.problems.length, 50);
  assert(
    result.notChecked.some((n) => /\b1\b.*not checked|not checked.*\b1\b/.test(n)),
    `expected a note about 1 unchecked claim, got ${JSON.stringify(result.notChecked)}`,
  );
});

// ---------------------------------------------------------------------------
// buildSummaryClaimQuestionPrompt
// ---------------------------------------------------------------------------

Deno.test("buildSummaryClaimQuestionPrompt - builds a well-formed question", () => {
  const prompt = buildSummaryClaimQuestionPrompt({
    repo: "acme/widgets",
    issueNumber: 42,
    baseRef: "origin/main",
    summaryPath: "docs/archive/pr-summaries/pr-summary-99.md",
    boundaryId: "0123456789ab",
  });
  assertStringIncludes(prompt, "git diff origin/main...HEAD");
  assertStringIncludes(prompt, "docs/archive/pr-summaries/pr-summary-99.md");
  assertStringIncludes(prompt, "BOUNDARY_0123456789ab");
  assertStringIncludes(prompt, DRIFT_VERDICT_OPEN);
});

Deno.test("buildSummaryClaimQuestionPrompt - throws on a flag-shaped base ref", () => {
  assertThrows(() =>
    buildSummaryClaimQuestionPrompt({
      repo: "acme/widgets",
      issueNumber: 1,
      baseRef: "--output=/tmp/x",
      summaryPath: ".pr_summary",
    })
  );
});

Deno.test("buildSummaryClaimQuestionPrompt - throws on a base ref containing '..'", () => {
  assertThrows(() =>
    buildSummaryClaimQuestionPrompt({
      repo: "acme/widgets",
      issueNumber: 1,
      baseRef: "a..b",
      summaryPath: ".pr_summary",
    })
  );
});

Deno.test("buildSummaryClaimQuestionPrompt - throws on an unrecognised summary path", () => {
  assertThrows(() =>
    buildSummaryClaimQuestionPrompt({
      repo: "acme/widgets",
      issueNumber: 1,
      baseRef: "origin/main",
      summaryPath: "../etc/passwd",
    })
  );
});

// ---------------------------------------------------------------------------
// runSummaryClaimCheck
// ---------------------------------------------------------------------------

function okGit(stdout: string) {
  return async () => ({ code: 0, stdout, stderr: "" });
}

function okResult(value: string): Result<string> {
  return { ok: true, value };
}

function errResult(message: string): Result<string> {
  return { ok: false, error: new Error(message) };
}

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-7.md";

Deno.test("runSummaryClaimCheck - #3252-shaped confirmed finding blocks", async () => {
  const summaryContent =
    "## Summary\n\n`phraseAnywhere()` escapes the phrase and joins its " +
    "words with `\\s+`.\n";
  const verdict = JSON.stringify({
    findings: [
      {
        file: SUMMARY_PATH,
        sentence:
          "`phraseAnywhere()` escapes the phrase and joins its words with `\\s+`.",
        reason: "the head's phraseAnywhere builds no regex",
      },
    ],
  });
  const logger = makeLogger();
  const result = await runSummaryClaimCheck(
    {
      repo: "acme/widgets",
      issueNumber: 7,
      repoPath: "/does/not/matter",
      baseRef: "origin/main",
      summaryPath: SUMMARY_PATH,
      summaryContent,
    },
    {
      runGit: okGit(""),
      askQuestion: async () =>
        okResult(`${DRIFT_VERDICT_OPEN}\n${verdict}\n<!-- /vibe-drift-verdict -->`),
      logger,
    },
  );
  assertEquals(result.findings.length, 1);
  assertEquals(result.unconfirmedFindings, []);
  assert(summaryClaimCheckBlocked(result));
});

Deno.test("runSummaryClaimCheck - a misquoted sentence is unconfirmed, not blocked", async () => {
  const summaryContent = "## Summary\n\n`phraseAnywhere()` does something else.\n";
  const verdict = JSON.stringify({
    findings: [
      {
        file: SUMMARY_PATH,
        sentence: "`phraseAnywhere()` escapes the phrase and joins its words.",
        reason: "misquoted",
      },
    ],
  });
  const result = await runSummaryClaimCheck(
    {
      repo: "acme/widgets",
      issueNumber: 7,
      repoPath: "/does/not/matter",
      baseRef: "origin/main",
      summaryPath: SUMMARY_PATH,
      summaryContent,
    },
    {
      runGit: okGit(""),
      askQuestion: async () =>
        okResult(`${DRIFT_VERDICT_OPEN}\n${verdict}\n<!-- /vibe-drift-verdict -->`),
      logger: makeLogger(),
    },
  );
  assertEquals(result.findings, []);
  assertEquals(result.unconfirmedFindings.length, 1);
  assertFalse(summaryClaimCheckBlocked(result));
});

Deno.test("runSummaryClaimCheck - a finding naming another file is unconfirmed", async () => {
  const summaryContent = "## Summary\n\nSome text.\n";
  const verdict = JSON.stringify({
    findings: [
      {
        file: "docs/archive/pr-summaries/pr-summary-8.md",
        sentence: "Some text.",
        reason: "wrong file",
      },
    ],
  });
  const result = await runSummaryClaimCheck(
    {
      repo: "acme/widgets",
      issueNumber: 7,
      repoPath: "/does/not/matter",
      baseRef: "origin/main",
      summaryPath: SUMMARY_PATH,
      summaryContent,
    },
    {
      runGit: okGit(""),
      askQuestion: async () =>
        okResult(`${DRIFT_VERDICT_OPEN}\n${verdict}\n<!-- /vibe-drift-verdict -->`),
      logger: makeLogger(),
    },
  );
  assertEquals(result.findings, []);
  assertEquals(result.unconfirmedFindings.length, 1);
  assertFalse(summaryClaimCheckBlocked(result));
});

Deno.test("runSummaryClaimCheck - askQuestion error is notChecked, not blocked", async () => {
  const logger = makeLogger();
  const result = await runSummaryClaimCheck(
    {
      repo: "acme/widgets",
      issueNumber: 7,
      repoPath: "/does/not/matter",
      baseRef: "origin/main",
      summaryPath: SUMMARY_PATH,
      summaryContent: "## Summary\n\nText.\n",
    },
    {
      runGit: okGit(""),
      askQuestion: async () => errResult("the agent could not be launched"),
      logger,
    },
  );
  assertEquals(result.findings, []);
  assertFalse(summaryClaimCheckBlocked(result));
  assert(
    result.notChecked.some((n) => n.includes("could not be launched")),
    `expected the askQuestion error recorded, got ${JSON.stringify(result.notChecked)}`,
  );
  assert(logger.errors.length > 0);
});

Deno.test("runSummaryClaimCheck - a null baseRef never calls askQuestion", async () => {
  let called = false;
  const result = await runSummaryClaimCheck(
    {
      repo: "acme/widgets",
      issueNumber: 7,
      repoPath: "/does/not/matter",
      baseRef: null,
      summaryPath: SUMMARY_PATH,
      summaryContent: "## Summary\n\nText.\n",
    },
    {
      runGit: okGit(""),
      askQuestion: async () => {
        called = true;
        return okResult("");
      },
      logger: makeLogger(),
    },
  );
  assertFalse(called);
  assert(result.notChecked.some((n) => n.includes("base ref")));
});

Deno.test("runSummaryClaimCheck - a reply with no verdict block is notChecked", async () => {
  const result = await runSummaryClaimCheck(
    {
      repo: "acme/widgets",
      issueNumber: 7,
      repoPath: "/does/not/matter",
      baseRef: "origin/main",
      summaryPath: SUMMARY_PATH,
      summaryContent: "## Summary\n\nText.\n",
    },
    {
      runGit: okGit(""),
      askQuestion: async () => okResult("I looked and found nothing worth noting."),
      logger: makeLogger(),
    },
  );
  assertEquals(result.findings, []);
  assertFalse(summaryClaimCheckBlocked(result));
  assert(result.notChecked.length > 0);
});

// ---------------------------------------------------------------------------
// Comment / reason rendering
// ---------------------------------------------------------------------------

Deno.test("buildSummaryClaimGateComment - includes the sentence, the Test Plan problem, and the example step", () => {
  const result: SummaryClaimCheckResult = {
    findings: [
      {
        file: SUMMARY_PATH,
        sentence: "`parseRow()` escapes the phrase.",
        reason: "parseRow does not escape anything",
      },
    ],
    unconfirmedFindings: [],
    testPlanProblems: [
      {
        line: "- `foo_test.ts` covers \"the thing\"",
        testFile: "worker/deno/tests/foo_test.ts",
        quote: "the thing",
        kind: "no-matching-test",
      },
    ],
    notChecked: [],
  };
  const comment = buildSummaryClaimGateComment(result);
  assertStringIncludes(comment, "parseRow() escapes the phrase.");
  assertStringIncludes(
    comment,
    describeTestPlanClaimProblem(result.testPlanProblems[0]!),
  );
  assertStringIncludes(comment, "for example");
});

Deno.test("summaryClaimBlockReason - starts with the expected prefix", () => {
  const result: SummaryClaimCheckResult = {
    findings: [
      { file: SUMMARY_PATH, sentence: "Some sentence.", reason: "wrong" },
    ],
    unconfirmedFindings: [],
    testPlanProblems: [],
    notChecked: [],
  };
  assertStringIncludes(
    summaryClaimBlockReason(result),
    "PR summary describes named code wrongly",
  );
  assert(summaryClaimBlockReason(result).startsWith(
    "PR summary describes named code wrongly",
  ));
});

// ---------------------------------------------------------------------------
// Hostile-input growth checks, one per untrusted-text regex.
// ---------------------------------------------------------------------------

Deno.test("findTestPlanClaimProblems - a hostile unterminated backtick run scales linearly", async () => {
  await assertLinearGrowth(
    "backtick span scan",
    (chars) => `## Test Plan\n\n- \`${"a".repeat(chars)}x\n`,
    (input) =>
      findTestPlanClaimProblems({
        summary: input,
        trackedFiles: [],
        readFile: async () => undefined,
      }),
    { baseChars: 10_000 },
  );
});

Deno.test("findTestPlanClaimProblems - a hostile unterminated quote run scales linearly", async () => {
  await assertLinearGrowth(
    "quote span scan",
    (chars) =>
      `## Test Plan\n\n- \`worker/deno/tests/foo_test.ts\` covers "${
        "a".repeat(chars)
      }x\n`,
    (input) =>
      findTestPlanClaimProblems({
        summary: input,
        trackedFiles: ["worker/deno/tests/foo_test.ts"],
        readFile: async () => `Deno.test("x", () => {});\n`,
      }),
    { baseChars: 10_000 },
  );
});

Deno.test("findTestPlanClaimProblems - a hostile test-file body scales linearly in the declaration splitter", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts",
    "a distinct behaviour claim here",
  );
  await assertLinearGrowth(
    "test-declaration splitter",
    (chars) => `${"a".repeat(chars)}\nDeno.test(`,
    (input) =>
      findTestPlanClaimProblems({
        summary,
        trackedFiles: ["worker/deno/tests/foo_test.ts"],
        readFile: async () => input,
      }),
    { baseChars: 10_000 },
  );
});
