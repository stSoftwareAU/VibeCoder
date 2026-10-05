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
import { assertLinearGrowth, growthAllowanceMs } from "./support/growth.ts";
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
  assertEquals(
    result.problems[0]?.testFile,
    "worker/deno/tests/nonexistent_test.ts",
  );
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
      throw new Error(
        "must not be read — no quoted behaviour outside backticks",
      );
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
      throw new Error(
        "must not be read — quote has fewer than 2 significant words",
      );
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
    result.notChecked.some((n) =>
      /\b1\b.*not checked|not checked.*\b1\b/.test(n)
    ),
    `expected a note about 1 unchecked claim, got ${
      JSON.stringify(result.notChecked)
    }`,
  );
});

Deno.test("findTestPlanClaimProblems - a shared fixture in the file's preamble confirms the claim (pr-summary-1549/3222-shaped)", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/unfenced_untrusted_text_test.ts",
    "rejects a comment carrying unfenced untrusted text",
  );
  const preambleFixture =
    'const UNFENCED_SAMPLE = "rejects a comment carrying unfenced untrusted text";\n\n';
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/unfenced_untrusted_text_test.ts"],
    readFile: async () =>
      `${preambleFixture}Deno.test("does something unrelated entirely", () => {});\n`,
  });
  assertEquals(
    result.problems,
    [],
    `expected the preamble fixture to confirm the claim, got ${
      JSON.stringify(result.problems)
    }`,
  );
});

Deno.test("findTestPlanClaimProblems - an error message across an intervening backtick span must not attach to the preceding test file (pr-summary-3178-shaped)", async () => {
  const summary = "## Test Plan\n\n" +
    '- `milestone_presync_git_test.ts` "#1780 - covers the presync guard" ' +
    "but refuses `git checkout -B topic` " +
    '("Cannot update paths and switch to branch")\n';
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["milestone_presync_git_test.ts"],
    readFile: async () =>
      `Deno.test("covers presync guard for issue 1780", () => {});\n`,
  });
  assertEquals(
    result.problems,
    [],
    "the git-error quote sits across the `git checkout -B topic` backtick " +
      "span from the test file and must not attach to it, and the first " +
      `quote is covered by the test name, got ${
        JSON.stringify(result.problems)
      }`,
  );
});

Deno.test("findTestPlanClaimProblems - a quote across intervening backtick spans must not attach to the preceding test file (pr-summary-599-shaped)", async () => {
  const summary = "## Test Plan\n\n" +
    "- `tests/service_account_env_test.ts` (writes to `/tmp` and reads " +
    '`.container-state/gh-config`) and the GraphQL "API rate limit ' +
    'already exceeded" errors in `tests/run_core_test.ts`\n';
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: [
      "tests/service_account_env_test.ts",
      "tests/run_core_test.ts",
    ],
    readFile: async (path) => {
      if (path === "tests/service_account_env_test.ts") {
        return `Deno.test("writes the container state to a temp path", () => {});\n`;
      }
      return `Deno.test("something unrelated to rate limiting", () => {});\n`;
    },
  });
  assertFalse(
    result.problems.some(
      (p) => p.testFile === "tests/service_account_env_test.ts",
    ),
    `the rate-limit quote must not attach to service_account_env_test.ts, got ${
      JSON.stringify(result.problems)
    }`,
  );
});

Deno.test("findTestPlanClaimProblems - readFile returning undefined for a tracked file is notChecked, no problem", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts",
    "handles the empty input case correctly",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => undefined,
  });
  assertEquals(result.problems, []);
  assert(
    result.notChecked.some((n) => n.includes("could not be read")),
    `expected a could-not-be-read note, got ${
      JSON.stringify(result.notChecked)
    }`,
  );
});

Deno.test("findTestPlanClaimProblems - a test file over MAX_TEST_FILE_CHARS is notChecked, no problem", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts",
    "handles the empty input case correctly",
  );
  const oversized =
    `Deno.test("handles the empty input case correctly", () => {});\n` +
    " ".repeat(1_000_001);
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => oversized,
  });
  assertEquals(result.problems, []);
  assert(
    result.notChecked.some((n) => n.includes("could not be read")),
    `expected a could-not-be-read note for the oversized file, got ${
      JSON.stringify(result.notChecked)
    }`,
  );
});

Deno.test("findTestPlanClaimProblems - contrast: the same claim against a small matching file has no notChecked", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts",
    "handles the empty input case correctly",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () =>
      `Deno.test("handles the empty input case correctly", () => {});\n`,
  });
  assertEquals(result.problems, []);
  assertEquals(result.notChecked, []);
});

Deno.test("findTestPlanClaimProblems - a tracked test file with no recognised test declaration is notChecked, no problem", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts",
    "handles the empty input case correctly",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => "export const x = 1;\n",
  });
  assertEquals(result.problems, []);
  assert(
    result.notChecked.some((n) => n.includes("names no test declaration")),
    `expected a no-test-declaration note, got ${
      JSON.stringify(result.notChecked)
    }`,
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

Deno.test("buildSummaryClaimQuestionPrompt - throws on a zero issue number", () => {
  const err = assertThrows(() =>
    buildSummaryClaimQuestionPrompt({
      repo: "acme/widgets",
      issueNumber: 0,
      baseRef: "origin/main",
      summaryPath: ".pr_summary",
    })
  );
  assertStringIncludes(
    err instanceof Error ? err.message : String(err),
    "positive integer issue number",
  );
});

Deno.test("buildSummaryClaimQuestionPrompt - throws on a non-integer issue number", () => {
  const err = assertThrows(() =>
    buildSummaryClaimQuestionPrompt({
      repo: "acme/widgets",
      issueNumber: 1.5,
      baseRef: "origin/main",
      summaryPath: ".pr_summary",
    })
  );
  assertStringIncludes(
    err instanceof Error ? err.message : String(err),
    "positive integer issue number",
  );
});

Deno.test("buildSummaryClaimQuestionPrompt - the same args with a valid issue number do not throw", () => {
  const prompt = buildSummaryClaimQuestionPrompt({
    repo: "acme/widgets",
    issueNumber: 7,
    baseRef: "origin/main",
    summaryPath: ".pr_summary",
  });
  assertStringIncludes(prompt, "acme/widgets#7");
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

const SUMMARY_WITH_MISSING_FILE_CLAIM = SUMMARY_WITH_COVERAGE_CLAIM(
  "worker/deno/tests/nonexistent_test.ts",
  "handles the empty input case correctly",
);

Deno.test("runSummaryClaimCheck - runGit returning null skips the Test Plan backstop but still asks the model question", async () => {
  let askQuestionCalled = false;
  const result = await runSummaryClaimCheck(
    {
      repo: "acme/widgets",
      issueNumber: 7,
      repoPath: "/does/not/matter",
      baseRef: "origin/main",
      summaryPath: SUMMARY_PATH,
      summaryContent: SUMMARY_WITH_MISSING_FILE_CLAIM,
    },
    {
      runGit: async () => null,
      askQuestion: async () => {
        askQuestionCalled = true;
        return okResult("no findings worth noting");
      },
      logger: makeLogger(),
    },
  );
  assert(
    result.notChecked.some((n) =>
      n.includes("tracked files could not be listed")
    ),
    `expected the ls-files failure recorded, got ${
      JSON.stringify(result.notChecked)
    }`,
  );
  assertEquals(result.testPlanProblems, []);
  assert(askQuestionCalled, "expected the model question to still be asked");
});

Deno.test("runSummaryClaimCheck - a non-zero ls-files exit code skips the Test Plan backstop but still asks the model question", async () => {
  let askQuestionCalled = false;
  const result = await runSummaryClaimCheck(
    {
      repo: "acme/widgets",
      issueNumber: 7,
      repoPath: "/does/not/matter",
      baseRef: "origin/main",
      summaryPath: SUMMARY_PATH,
      summaryContent: SUMMARY_WITH_MISSING_FILE_CLAIM,
    },
    {
      runGit: async () => ({
        code: 1,
        stdout: "",
        stderr: "fatal: not a git repo",
      }),
      askQuestion: async () => {
        askQuestionCalled = true;
        return okResult("no findings worth noting");
      },
      logger: makeLogger(),
    },
  );
  assert(
    result.notChecked.some((n) =>
      n.includes("tracked files could not be listed")
    ),
    `expected the ls-files failure recorded, got ${
      JSON.stringify(result.notChecked)
    }`,
  );
  assertEquals(result.testPlanProblems, []);
  assert(askQuestionCalled, "expected the model question to still be asked");
});

Deno.test("runSummaryClaimCheck - contrast: ls-files succeeding yields the missing-file problem the above two tests skip", async () => {
  const result = await runSummaryClaimCheck(
    {
      repo: "acme/widgets",
      issueNumber: 7,
      repoPath: "/does/not/matter",
      baseRef: "origin/main",
      summaryPath: SUMMARY_PATH,
      summaryContent: SUMMARY_WITH_MISSING_FILE_CLAIM,
    },
    {
      runGit: okGit(""),
      askQuestion: async () => okResult("no findings worth noting"),
      logger: makeLogger(),
    },
  );
  assertEquals(result.testPlanProblems.length, 1);
  assertEquals(result.testPlanProblems[0]?.kind, "missing-file");
  assert(summaryClaimCheckBlocked(result));
});

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
        okResult(
          `${DRIFT_VERDICT_OPEN}\n${verdict}\n<!-- /vibe-drift-verdict -->`,
        ),
      logger,
    },
  );
  assertEquals(result.findings.length, 1);
  assertEquals(result.unconfirmedFindings, []);
  assert(summaryClaimCheckBlocked(result));
});

Deno.test("runSummaryClaimCheck - a misquoted sentence is unconfirmed, not blocked", async () => {
  const summaryContent =
    "## Summary\n\n`phraseAnywhere()` does something else.\n";
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
        okResult(
          `${DRIFT_VERDICT_OPEN}\n${verdict}\n<!-- /vibe-drift-verdict -->`,
        ),
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
        okResult(
          `${DRIFT_VERDICT_OPEN}\n${verdict}\n<!-- /vibe-drift-verdict -->`,
        ),
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
    `expected the askQuestion error recorded, got ${
      JSON.stringify(result.notChecked)
    }`,
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
      askQuestion: async () =>
        okResult("I looked and found nothing worth noting."),
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
        line: '- `foo_test.ts` covers "the thing"',
        testFile: "worker/deno/tests/foo_test.ts",
        quote: "the thing",
        kind: "no-matching-test",
      },
    ],
    notChecked: [],
  };
  const comment = buildSummaryClaimGateComment(result);
  assertStringIncludes(comment, "`parseRow()` escapes the phrase.");
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
  assert(
    summaryClaimBlockReason(result).startsWith(
      "PR summary describes named code wrongly",
    ),
  );
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

// `findTestPlanClaimProblems` only reaches the declaration splitter after an
// `await opts.readFile(...)`, so `assertLinearGrowth`'s synchronous `run`
// cannot time the work: calling an async function whose first await has not
// settled returns before the splitter ever runs. This helper measures across
// the `await` instead, reusing growth.ts's own allowance maths
// (`growthAllowanceMs`) so the tolerance matches the rest of the suite.
async function assertLinearGrowthAsync<T>(
  label: string,
  build: (chars: number) => string,
  run: (input: string) => Promise<T>,
  baseChars: number,
  sizeFactor = 4,
): Promise<T> {
  const baseInput = build(baseChars);
  const scaledInput = build(baseChars * sizeFactor);
  const actualFactor = scaledInput.length / baseInput.length;

  const t0 = performance.now();
  await run(baseInput);
  const baseMs = performance.now() - t0;

  const t1 = performance.now();
  const output = await run(scaledInput);
  const scaledMs = performance.now() - t1;

  const allowedMs = growthAllowanceMs(baseMs, actualFactor);
  assert(
    scaledMs <= allowedMs,
    `${label}: ${baseInput.length} chars took ${
      baseMs.toFixed(0)
    } ms but ${scaledInput.length} chars (${actualFactor.toFixed(1)}x) took ${
      scaledMs.toFixed(0)
    } ms, over the ${allowedMs.toFixed(0)} ms a linear rule allows`,
  );
  return output;
}

Deno.test("findTestPlanClaimProblems - a hostile test-file body scales linearly in the declaration splitter", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts",
    "a distinct behaviour claim here",
  );
  await assertLinearGrowthAsync(
    "test-declaration splitter",
    (chars) => `${"a".repeat(chars)}\nDeno.test(`,
    (input) =>
      findTestPlanClaimProblems({
        summary,
        trackedFiles: ["worker/deno/tests/foo_test.ts"],
        readFile: async () => input,
      }),
    10_000,
  );
});
