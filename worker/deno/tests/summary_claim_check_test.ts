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

Deno.test("findTestPlanClaimProblems - a directory reference is notChecked, not a missing-file problem", async () => {
  const summary = "## Test Plan\n\n" +
    '- Ran the whole suite in `worker/deno/tests/`: "all suites pass on the head"\n';
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => {
      throw new Error("must not be read — a directory is not a test file");
    },
  });
  assertEquals(
    result.problems,
    [],
    `a directory must not be a missing-file problem, got ${
      JSON.stringify(result.problems)
    }`,
  );
  assert(
    result.notChecked.some((n) =>
      n.includes("`worker/deno/tests/`") && n.includes("not checked")
    ),
    `expected a not-a-file note for the directory, got ${
      JSON.stringify(result.notChecked)
    }`,
  );
});

Deno.test("findTestPlanClaimProblems - a glob reference is notChecked, not a missing-file problem", async () => {
  const summary = "## Test Plan\n\n" +
    '- `worker/deno/tests/*_test.ts` "all suites pass on the head"\n';
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => {
      throw new Error("must not be read — a glob is not a test file");
    },
  });
  assertEquals(
    result.problems,
    [],
    `a glob must not be a missing-file problem, got ${
      JSON.stringify(result.problems)
    }`,
  );
  assert(
    result.notChecked.some((n) =>
      n.includes("`worker/deno/tests/*_test.ts`") && n.includes("not checked")
    ),
    `expected a not-a-file note for the glob, got ${
      JSON.stringify(result.notChecked)
    }`,
  );
});

Deno.test("findTestPlanClaimProblems - a reference that is a directory prefix of tracked paths is notChecked, not a missing-file problem", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "tests/unit",
    "rejects a malformed header entirely",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["tests/unit/foo_test.ts", "tests/unit/bar_test.ts"],
    readFile: async () => {
      throw new Error("must not be read — a directory is not a test file");
    },
  });
  assertEquals(
    result.problems,
    [],
    `a tracked directory must not be a missing-file problem, got ${
      JSON.stringify(result.problems)
    }`,
  );
  assert(
    result.notChecked.some((n) =>
      n.includes("`tests/unit`") && n.includes("not checked")
    ),
    `expected a not-a-file note for the directory prefix, got ${
      JSON.stringify(result.notChecked)
    }`,
  );
});

Deno.test("findTestPlanClaimProblems - a ./-prefixed reference resolves to the tracked file and is checked", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "./worker/deno/tests/foo_test.ts",
    "rejects a malformed header entirely",
  );
  const readPaths: string[] = [];
  const covered = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async (path) => {
      readPaths.push(path);
      return `Deno.test("rejects a malformed header entirely", () => {});\n`;
    },
  });
  assertEquals(readPaths, ["worker/deno/tests/foo_test.ts"]);
  assertEquals(covered.problems, []);
  assertEquals(covered.notChecked, []);

  const uncovered = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => `Deno.test("something else entirely", () => {});\n`,
  });
  assertEquals(uncovered.problems.length, 1);
  assertEquals(uncovered.problems[0]?.kind, "no-matching-test");
  assertEquals(
    uncovered.problems[0]?.testFile,
    "worker/deno/tests/foo_test.ts",
  );
});

// Claim-match rule (quoteCoveredBy / significantWords / wordsMatch): at
// least half of the quote's significant words must match, on exact, stemmed
// or 4+-char-prefix terms, with stopwords dropped.

Deno.test("findTestPlanClaimProblems - exactly half of the quote's significant words matching is covered", async () => {
  // Quote words: reject, malform, header, entirely (4). The test name shares
  // reject and header: exactly half.
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts",
    "rejects malformed header entirely",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => `Deno.test("rejects header", () => {});\n`,
  });
  assertEquals(
    result.problems,
    [],
    `half the words matching must count as covered, got ${
      JSON.stringify(result.problems)
    }`,
  );
});

Deno.test("findTestPlanClaimProblems - fewer than half of the quote's significant words matching is a no-matching-test problem", async () => {
  // Same four quote words; the test name shares only reject: one of four.
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts",
    "rejects malformed header entirely",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => `Deno.test("rejects nothing", () => {});\n`,
  });
  assertEquals(result.problems.length, 1);
  assertEquals(result.problems[0]?.kind, "no-matching-test");
});

Deno.test("findTestPlanClaimProblems - a stemmed variant of each test word is covered (rejecting/rejects, parsed/parses, header/headers)", async () => {
  // Without stemming only header/headers would match (by prefix): one of
  // three, under the half threshold.
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts",
    "rejecting a parsed header",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => `Deno.test("rejects headers it parses", () => {});\n`,
  });
  assertEquals(
    result.problems,
    [],
    `stemmed variants must match, got ${JSON.stringify(result.problems)}`,
  );
});

Deno.test("findTestPlanClaimProblems - a 4+-char prefix of each test word is covered (config/configuration, validat/validation)", async () => {
  // Neither quote word equals a test word, even after stemming: config is a
  // prefix of configuration, and validat (validates, stemmed) a prefix of
  // validation.
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts",
    "validates the config",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => `Deno.test("configuration validation", () => {});\n`,
  });
  assertEquals(
    result.problems,
    [],
    `prefix variants must match, got ${JSON.stringify(result.problems)}`,
  );
});

Deno.test("findTestPlanClaimProblems - a quote sharing only stopwords with the test is a no-matching-test problem", async () => {
  // asserts, that and every are stopwords; widget and render(s) are the
  // quote's significant words and the test has neither.
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts",
    "asserts that every widget renders",
  );
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () =>
      `Deno.test("asserts that every header parses", () => {});\n`,
  });
  assertEquals(result.problems.length, 1);
  assertEquals(result.problems[0]?.kind, "no-matching-test");
});

Deno.test("findTestPlanClaimProblems - an empty (whitespace-only) quote is skipped", async () => {
  const summary =
    `## Test Plan\n\n- \`worker/deno/tests/foo_test.ts\` covers "   "\n`;
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => {
      throw new Error("must not be read — the quote is empty");
    },
  });
  assertEquals(result.problems, []);
  assertEquals(result.notChecked, []);
});

// Reference handling: a quote before its reference, and suffix stripping.

Deno.test("findTestPlanClaimProblems - a quote before its only test-file reference is checked against that file and blocks when uncovered", async () => {
  const summary = "## Test Plan\n\n" +
    '- "rejects a malformed header entirely" in `worker/deno/tests/foo_test.ts`\n';
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => `Deno.test("something else entirely", () => {});\n`,
  });
  assertEquals(
    result.problems.length,
    1,
    `the quote must attach to the following reference, got ${
      JSON.stringify(result.problems)
    }`,
  );
  assertEquals(result.problems[0]?.kind, "no-matching-test");
  assertEquals(
    result.problems[0]?.testFile,
    "worker/deno/tests/foo_test.ts",
  );
});

Deno.test("findTestPlanClaimProblems - a quote with a backtick span between it and the following reference is not attached", async () => {
  const summary = "## Test Plan\n\n" +
    '- "rejects a malformed header entirely" via `deno test` in `worker/deno/tests/foo_test.ts`\n';
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async () => {
      throw new Error(
        "must not be read — `deno test` sits between the quote and the file",
      );
    },
  });
  assertEquals(result.problems, []);
  assertEquals(result.notChecked, []);
});

Deno.test("findTestPlanClaimProblems - a path:line reference resolves to the tracked file", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts:42",
    "rejects a malformed header entirely",
  );
  const readPaths: string[] = [];
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async (path) => {
      readPaths.push(path);
      return `Deno.test("rejects a malformed header entirely", () => {});\n`;
    },
  });
  assertEquals(readPaths, ["worker/deno/tests/foo_test.ts"]);
  assertEquals(result.problems, []);
  assertEquals(result.notChecked, []);
});

Deno.test("findTestPlanClaimProblems - a path::test reference resolves to the tracked file", async () => {
  const summary = SUMMARY_WITH_COVERAGE_CLAIM(
    "worker/deno/tests/foo_test.ts::rejects_malformed_header",
    "rejects a malformed header entirely",
  );
  const readPaths: string[] = [];
  const result = await findTestPlanClaimProblems({
    summary,
    trackedFiles: ["worker/deno/tests/foo_test.ts"],
    readFile: async (path) => {
      readPaths.push(path);
      return `Deno.test("rejects a malformed header entirely", () => {});\n`;
    },
  });
  assertEquals(readPaths, ["worker/deno/tests/foo_test.ts"]);
  assertEquals(result.problems, []);
  assertEquals(result.notChecked, []);
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
    docFiles: [],
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
      docFiles: [],
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
      docFiles: [],
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
      docFiles: [],
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
      docFiles: [],
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
      docFiles: [],
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
    docFiles: [],
  });
  assertStringIncludes(prompt, "acme/widgets#7");
});

Deno.test("buildSummaryClaimQuestionPrompt - throws on a base ref with a leading '-' that the pattern alone accepts", () => {
  assertThrows(() =>
    buildSummaryClaimQuestionPrompt({
      repo: "acme/widgets",
      issueNumber: 1,
      baseRef: "-x",
      summaryPath: ".pr_summary",
      docFiles: [],
    })
  );
});

Deno.test("buildSummaryClaimQuestionPrompt - throws on an absolute-path base ref that the pattern alone accepts", () => {
  assertThrows(() =>
    buildSummaryClaimQuestionPrompt({
      repo: "acme/widgets",
      issueNumber: 1,
      baseRef: "/etc/x",
      summaryPath: ".pr_summary",
      docFiles: [],
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
      changedFiles: [],
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
      changedFiles: [],
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
      changedFiles: [],
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
      changedFiles: [],
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
      changedFiles: [],
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
      changedFiles: [],
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
      changedFiles: [],
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
  assert(logger.warns.length > 0);
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
      changedFiles: [],
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
      changedFiles: [],
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

Deno.test("runSummaryClaimCheck - a base ref that fails validation is notChecked, does not throw, and never calls askQuestion", async () => {
  let called = false;
  const logger = makeLogger();
  const result = await runSummaryClaimCheck(
    {
      repo: "acme/widgets",
      issueNumber: 7,
      repoPath: "/does/not/matter",
      baseRef: "origin/rel+1",
      summaryPath: SUMMARY_PATH,
      changedFiles: [],
      summaryContent: "## Summary\n\nText.\n",
    },
    {
      runGit: okGit(""),
      askQuestion: async () => {
        called = true;
        return okResult("");
      },
      logger,
    },
  );
  assertFalse(called, "the question must not be asked without a prompt");
  assertFalse(summaryClaimCheckBlocked(result));
  assert(
    result.notChecked.some((n) => n.includes("well-formed base ref")),
    `expected the prompt-build failure recorded, got ${
      JSON.stringify(result.notChecked)
    }`,
  );
  assert(logger.errors.some((e) => e.includes("well-formed base ref")));
});

Deno.test("runSummaryClaimCheck - an ambiguous test-file reference reaches result.notChecked", async () => {
  const result = await runSummaryClaimCheck(
    {
      repo: "acme/widgets",
      issueNumber: 7,
      repoPath: "/does/not/matter",
      baseRef: "origin/main",
      summaryPath: SUMMARY_PATH,
      changedFiles: [],
      summaryContent: SUMMARY_WITH_COVERAGE_CLAIM(
        "foo_test.ts",
        "handles the empty input case correctly",
      ),
    },
    {
      runGit: okGit(
        "worker/deno/tests/foo_test.ts\nworker/other/foo_test.ts\n",
      ),
      askQuestion: async () => okResult("no findings worth noting"),
      logger: makeLogger(),
    },
  );
  assertEquals(result.testPlanProblems, []);
  assert(
    result.notChecked.some((n) => n.includes("more than one tracked file")),
    `expected the ambiguity note forwarded, got ${
      JSON.stringify(result.notChecked)
    }`,
  );
});

Deno.test("runSummaryClaimCheck - an unreadable tracked test file reaches result.notChecked", async () => {
  const result = await runSummaryClaimCheck(
    {
      repo: "acme/widgets",
      issueNumber: 7,
      repoPath: "/does/not/exist/anywhere",
      baseRef: "origin/main",
      summaryPath: SUMMARY_PATH,
      changedFiles: [],
      summaryContent: SUMMARY_WITH_COVERAGE_CLAIM(
        "worker/deno/tests/foo_test.ts",
        "handles the empty input case correctly",
      ),
    },
    {
      runGit: okGit("worker/deno/tests/foo_test.ts\n"),
      askQuestion: async () => okResult("no findings worth noting"),
      logger: makeLogger(),
    },
  );
  assertEquals(result.testPlanProblems, []);
  assert(
    result.notChecked.some((n) => n.includes("could not be read")),
    `expected the could-not-be-read note forwarded, got ${
      JSON.stringify(result.notChecked)
    }`,
  );
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
    docFindings: [],
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
    docFindings: [],
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

// ---------------------------------------------------------------------------
// Changed manual and prompt prose (Issue #3347)
// ---------------------------------------------------------------------------

const DOC_SENTENCE = "A negative `cash` on a cash account is refused.";

const PROMPT_BASE = {
  repo: "acme/widgets",
  issueNumber: 7,
  baseRef: "origin/main",
  summaryPath: ".pr_summary",
} as const;

Deno.test("buildSummaryClaimQuestionPrompt - docFiles add the doc instruction and files", () => {
  const withDocs = buildSummaryClaimQuestionPrompt({
    ...PROMPT_BASE,
    docFiles: ["docs/manual.md", "SECURITY.md"],
    boundaryId: "0123456789ab",
  });
  assertStringIncludes(withDocs, "docs/manual.md");
  assertStringIncludes(withDocs, "SECURITY.md");
  assertStringIncludes(
    withDocs,
    "check only the lines this branch's diff adds or edits",
  );
  assertStringIncludes(withDocs, "For the summary file:");
  const without = buildSummaryClaimQuestionPrompt({
    ...PROMPT_BASE,
    docFiles: [],
    boundaryId: "0123456789ab",
  });
  assertFalse(
    without.includes("check only the lines this branch's diff adds or edits"),
  );
  assertFalse(without.includes("For the summary file:"));
});

Deno.test("buildSummaryClaimQuestionPrompt - rejects non-prose and over-cap docFiles", () => {
  for (
    const bad of [
      "docs/archive/pr-summaries/pr-summary-3.md",
      "../x.md",
      "lib/x.ts",
    ]
  ) {
    const err = assertThrows(() =>
      buildSummaryClaimQuestionPrompt({ ...PROMPT_BASE, docFiles: [bad] })
    );
    assertStringIncludes(
      err instanceof Error ? err.message : String(err),
      `requires manual or prompt Markdown paths, got '${bad}'`,
    );
  }
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => `docs/m${i}.md`);
  assertThrows(() =>
    buildSummaryClaimQuestionPrompt({ ...PROMPT_BASE, docFiles: many(21) })
  );
  const ok = buildSummaryClaimQuestionPrompt({
    ...PROMPT_BASE,
    docFiles: many(20),
  });
  assertStringIncludes(ok, "docs/m19.md");
});

async function withDocRepo(
  files: Record<string, string>,
  body: (repoPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    for (const [name, content] of Object.entries(files)) {
      const full = `${dir}/${name}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(full, content);
    }
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function docVerdict(file: string, sentence: string): string {
  const body = JSON.stringify({
    findings: [{ file, sentence, reason: "src/capacity.rs:88 carries on" }],
  });
  return `${DRIFT_VERDICT_OPEN}\n${body}\n<!-- /vibe-drift-verdict -->`;
}

function docInput(repoPath: string, changedFiles: readonly string[] | null) {
  return {
    repo: "acme/widgets",
    issueNumber: 7,
    repoPath,
    baseRef: "origin/main",
    summaryPath: SUMMARY_PATH,
    summaryContent: "## Summary\n\nText.\n",
    changedFiles,
  };
}

Deno.test("runSummaryClaimCheck - a confirmed changed-manual finding lands in docFindings and blocks", async () => {
  await withDocRepo(
    { "docs/manual.md": `# Manual\n\n${DOC_SENTENCE}\n` },
    async (dir) => {
      let captured = "";
      const result = await runSummaryClaimCheck(
        docInput(dir, ["docs/manual.md", "lib/x.ts", SUMMARY_PATH]),
        {
          runGit: okGit(""),
          askQuestion: async (prompt) => {
            captured = prompt;
            return okResult(docVerdict("docs/manual.md", DOC_SENTENCE));
          },
          logger: makeLogger(),
        },
      );
      assertEquals(result.docFindings.length, 1);
      assertEquals(result.findings.length, 0);
      assertEquals(result.unconfirmedFindings.length, 0);
      assert(summaryClaimCheckBlocked(result));
      assertStringIncludes(captured, "docs/manual.md");
      assertFalse(captured.includes("lib/x.ts"));
    },
  );
});

Deno.test("runSummaryClaimCheck - a doc finding whose sentence is not in the file is unconfirmed", async () => {
  await withDocRepo(
    { "docs/manual.md": "# Manual\n\nSomething else.\n" },
    async (dir) => {
      const result = await runSummaryClaimCheck(
        docInput(dir, ["docs/manual.md"]),
        {
          runGit: okGit(""),
          askQuestion: async () =>
            okResult(docVerdict("docs/manual.md", DOC_SENTENCE)),
          logger: makeLogger(),
        },
      );
      assertEquals(result.docFindings.length, 0);
      assertEquals(result.unconfirmedFindings.length, 1);
      assertFalse(summaryClaimCheckBlocked(result));
    },
  );
});

Deno.test("runSummaryClaimCheck - a finding naming an unchanged file is unconfirmed", async () => {
  await withDocRepo({
    "docs/manual.md": "# Manual\n",
    "docs/other.md": `# Other\n\n${DOC_SENTENCE}\n`,
  }, async (dir) => {
    const result = await runSummaryClaimCheck(
      docInput(dir, ["docs/manual.md"]),
      {
        runGit: okGit(""),
        askQuestion: async () =>
          okResult(docVerdict("docs/other.md", DOC_SENTENCE)),
        logger: makeLogger(),
      },
    );
    assertEquals(result.docFindings.length, 0);
    assertEquals(result.unconfirmedFindings.length, 1);
    assertFalse(summaryClaimCheckBlocked(result));
  });
});

Deno.test("runSummaryClaimCheck - null changedFiles is notChecked and the doc instruction is omitted", async () => {
  const logger = makeLogger();
  let captured = "";
  const result = await runSummaryClaimCheck(
    docInput("/does/not/matter", null),
    {
      runGit: okGit(""),
      askQuestion: async (prompt) => {
        captured = prompt;
        return okResult("no findings");
      },
      logger,
    },
  );
  assert(captured.length > 0);
  assertFalse(captured.includes("check only the lines this branch's diff"));
  assert(
    result.notChecked.some((n) =>
      n.includes("changed files could not be listed")
    ),
  );
  assert(
    logger.errors.some((e) => e.includes("changed files could not be listed")),
  );
});

Deno.test("runSummaryClaimCheck - manual files over the cap are reported and left out of the prompt", async () => {
  const names = Array.from({ length: 21 }, (_, i) => `docs/m${i}.md`);
  const files: Record<string, string> = {};
  for (const n of names) files[n] = "# Doc\n";
  await withDocRepo(files, async (dir) => {
    let captured = "";
    const result = await runSummaryClaimCheck(docInput(dir, names), {
      runGit: okGit(""),
      askQuestion: async (prompt) => {
        captured = prompt;
        return okResult("no findings");
      },
      logger: makeLogger(),
    });
    const note = result.notChecked.find((n) =>
      n.includes("over the 20-file cap")
    );
    assert(note !== undefined);
    assertStringIncludes(note, "docs/m20.md");
    assertStringIncludes(captured, "docs/m19.md");
    assertFalse(captured.includes("docs/m20.md"));
  });
});

Deno.test("runSummaryClaimCheck - an absent changed manual is skipped silently; an unreadable one is notChecked", async () => {
  await withDocRepo({ "docs/dir.md/keep": "x" }, async (dir) => {
    let captured = "";
    const result = await runSummaryClaimCheck(
      docInput(dir, ["docs/gone.md", "docs/dir.md"]),
      {
        runGit: okGit(""),
        askQuestion: async (prompt) => {
          captured = prompt;
          return okResult("no findings");
        },
        logger: makeLogger(),
      },
    );
    assertFalse(captured.includes("docs/gone.md"));
    assertFalse(result.notChecked.some((n) => n.includes("docs/gone.md")));
    assert(
      result.notChecked.some((n) =>
        n.includes("docs/dir.md") && n.includes("could not be read")
      ),
    );
  });
});

Deno.test("buildSummaryClaimGateComment - a doc-only finding names the file, sentence and procedure", () => {
  const result: SummaryClaimCheckResult = {
    findings: [],
    docFindings: [
      { file: "docs/manual.md", sentence: DOC_SENTENCE, reason: "carried on" },
    ],
    unconfirmedFindings: [],
    testPlanProblems: [],
    notChecked: [],
  };
  assert(summaryClaimCheckBlocked(result));
  const comment = buildSummaryClaimGateComment(result);
  assertStringIncludes(
    comment,
    "A changed manual or prompt describes the PR's own behaviour wrongly.",
  );
  assertStringIncludes(comment, "`docs/manual.md`");
  assertStringIncludes(comment, DOC_SENTENCE);
  assertStringIncludes(comment, "rewrite that sentence in that file");
  assertStringIncludes(
    comment,
    "Fix the flagged manual or prompt sentences, not the code.",
  );
  assertFalse(comment.includes("PR summary describes named code wrongly"));
  assertEquals(
    summaryClaimBlockReason(result),
    `Changed doc describes the PR's own behaviour wrongly: \`docs/manual.md\`: ${DOC_SENTENCE}`,
  );
});

Deno.test("buildSummaryClaimGateComment - summary and doc findings render both blocks", () => {
  const result: SummaryClaimCheckResult = {
    findings: [
      { file: SUMMARY_PATH, sentence: "`parseRow()` escapes.", reason: "no" },
    ],
    docFindings: [
      { file: "docs/manual.md", sentence: DOC_SENTENCE, reason: "carried on" },
    ],
    unconfirmedFindings: [],
    testPlanProblems: [],
    notChecked: [],
  };
  const comment = buildSummaryClaimGateComment(result);
  assertStringIncludes(comment, "PR summary describes named code wrongly");
  assertStringIncludes(comment, "`parseRow()` escapes.");
  assertStringIncludes(comment, "`docs/manual.md`");
  assertStringIncludes(
    comment,
    "Fix the summary and the flagged manual or prompt sentences, not the code.",
  );
  assert(
    summaryClaimBlockReason(result).startsWith(
      "PR summary describes named code wrongly",
    ),
  );
});
