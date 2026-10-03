/**
 * Unit tests for the PR-summary branch-outcomes gate (Issue #3147).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildBranchOutcomesGateComment,
  lookupTestsAtHead,
  namedTestPaths,
  parseBranchOutcomes,
  validateBranchOutcomes,
} from "../lib/branch_outcomes_gate.ts";
import { assertLinearGrowth } from "./support/growth.ts";

// ---------------------------------------------------------------------------
// parseBranchOutcomes
// ---------------------------------------------------------------------------

Deno.test("parseBranchOutcomes - bold paragraph header with a list parses entries", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:42` — error — `worker/deno/tests/foo_test.ts::rejects bad input`\n" +
      "- `worker/deno/lib/foo.ts:48` — success — `worker/deno/tests/foo_test.ts::accepts good input`\n",
  );
  assert(record.present);
  assertEquals(record.noneDeclared, false);
  assertEquals(record.entries.length, 2);
  assertStringIncludes(record.entries[0]!, "worker/deno/lib/foo.ts:42");
  assertStringIncludes(record.entries[1]!, "worker/deno/lib/foo.ts:48");
});

Deno.test("parseBranchOutcomes - header as a list item with nested entries does not swallow a sibling bullet", () => {
  const record = parseBranchOutcomes(
    "- Branch outcomes:\n" +
      "  - entry one\n" +
      "  - entry two\n" +
      "- Docs sweep — section: none\n",
  );
  assert(record.present);
  assertEquals(record.entries, ["entry one", "entry two"]);
});

Deno.test("parseBranchOutcomes - markdown heading form with following list parses", () => {
  const record = parseBranchOutcomes(
    "#### Branch outcomes\n" +
      "- entry one\n" +
      "- entry two\n",
  );
  assert(record.present);
  assertEquals(record.entries, ["entry one", "entry two"]);
});

Deno.test("parseBranchOutcomes - continuation lines are joined onto the previous entry", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:42` — error —\n" +
      "  `worker/deno/tests/foo_test.ts::rejects bad input`\n",
  );
  assert(record.present);
  assertEquals(record.entries.length, 1);
  assertStringIncludes(
    record.entries[0]!,
    "worker/deno/tests/foo_test.ts::rejects bad input",
  );
});

Deno.test("parseBranchOutcomes - 'none added' is recognised as an honest negative", () => {
  const record = parseBranchOutcomes("**Branch outcomes:** none added\n");
  assert(record.present);
  assert(record.noneDeclared);
  assertEquals(record.entries, []);
});

Deno.test("parseBranchOutcomes - first match wins", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:** none added\n\n" +
      "**Branch outcomes:**\n- entry one\n",
  );
  assert(record.present);
  assert(record.noneDeclared);
  assertEquals(record.entries, []);
});

Deno.test("parseBranchOutcomes - absent header reports not present", () => {
  const record = parseBranchOutcomes("## Summary\n\nFixed the thing.\n");
  assertEquals(record.present, false);
});

// ---------------------------------------------------------------------------
// namedTestPaths
// ---------------------------------------------------------------------------

Deno.test("namedTestPaths - path:line and path::name forms both resolve to the test path", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- worker/deno/lib/foo.ts:42 — error — worker/deno/tests/foo_test.ts:42\n" +
      "- worker/deno/lib/foo.ts:48 — success — worker/deno/tests/foo_test.ts::accepts good input\n",
  );
  assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"]);
});

Deno.test("namedTestPaths - URLs are ignored", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- see https://example.com/foo_test.ts for background — worker/deno/tests/foo_test.ts::case\n",
  );
  assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"]);
});

Deno.test("namedTestPaths - non-test paths are not returned", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- worker/deno/lib/foo.ts:42 — error (no test named)\n",
  );
  assertEquals(namedTestPaths(record), []);
});

Deno.test("namedTestPaths - duplicate citations are deduplicated", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- worker/deno/tests/foo_test.ts::a — worker/deno/tests/foo_test.ts::b\n",
  );
  assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"]);
});

// PR #3160 review: the `./` strip (normaliseToken) and the leading-`/` skips
// had no test — removing all three left 45/45 pre-existing tests green.
Deno.test("namedTestPaths - a ./-prefixed citation is normalised, dropping the ./", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- success — ./worker/deno/tests/foo_test.ts::case\n",
  );
  assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"]);
});

Deno.test("namedTestPaths - an absolute-path token is not returned", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- success — /worker/deno/tests/foo_test.ts::case\n",
  );
  assertEquals(namedTestPaths(record), []);
});

// PR #3160 fourth review round: a `.//`-prefixed citation only becomes an
// absolute path (`/worker/...`) after normaliseToken's `./` strip, so it
// reaches the post-normalisation `token.startsWith("/")` skip and nothing
// else. This is the one case that pins that skip on its own.
Deno.test("namedTestPaths - a .//-prefixed citation normalises to an absolute path and is dropped", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- success — .//worker/deno/tests/foo_test.ts::case\n",
  );
  assertEquals(namedTestPaths(record), []);
});

// ---------------------------------------------------------------------------
// Fail-open caps (PR #3160 review): MAX_ENTRIES, MAX_TOKEN_CHARS and
// MAX_NAMED_TEST_PATHS had no test either.
// ---------------------------------------------------------------------------

Deno.test("parseBranchOutcomes - more than 100 entries are capped at 100", () => {
  const lines = Array.from(
    { length: 105 },
    (_, i) => `- worker/deno/tests/foo_test.ts::case${i}`,
  ).join("\n");
  const record = parseBranchOutcomes(`**Branch outcomes:**\n${lines}\n`);
  assertEquals(record.entries.length, 100);
});

Deno.test("namedTestPaths - a token over 300 chars is skipped", () => {
  const longPath = `worker/deno/tests/${"a".repeat(300)}_test.ts`;
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      `- success — ${longPath}::case — also worker/deno/tests/foo_test.ts::case\n`,
  );
  assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"]);
});

Deno.test("namedTestPaths - more than 50 named test paths are capped at 50", () => {
  const entries = Array.from(
    { length: 60 },
    (_, i) => `- worker/deno/tests/foo${i}_test.ts::case`,
  ).join("\n");
  const record = parseBranchOutcomes(`**Branch outcomes:**\n${entries}\n`);
  assertEquals(namedTestPaths(record).length, 50);
});

// ---------------------------------------------------------------------------
// validateBranchOutcomes
// ---------------------------------------------------------------------------

Deno.test("validateBranchOutcomes - missing list blocks when the diff changes code", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Summary\n\nDid a thing.\n",
    testsAtHead: new Set(),
  });
  assert(result.applicable);
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "no `Branch outcomes:` list");
});

Deno.test("validateBranchOutcomes - a test absent from testsAtHead blocks and is named in missingTests", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- success — worker/deno/tests/missing_test.ts::does not exist\n",
    testsAtHead: new Set(["worker/deno/tests/other_test.ts"]),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, ["worker/deno/tests/missing_test.ts"]);
});

// PR #3160 review: the missing-test message must say paths are checked
// relative to the repository root, or a run that self-checked with
// `git ls-files <path>` from a subdirectory (e.g. `worker/deno`) is blocked
// with no clue why its own check passed.
Deno.test("validateBranchOutcomes - the missing-test message names the repository-root requirement", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- success — worker/deno/tests/missing_test.ts::does not exist\n",
    testsAtHead: new Set(["worker/deno/tests/other_test.ts"]),
  });
  assertStringIncludes(result.problems[0]!, "repository root");
});

Deno.test("validateBranchOutcomes - testsAtHead null with named tests blocks (fail closed)", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- success — worker/deno/tests/foo_test.ts::case\n",
    testsAtHead: null,
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "could not confirm");
});

Deno.test("validateBranchOutcomes - all named tests present passes", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- success — worker/deno/tests/foo_test.ts::case\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
  assertEquals(result.missingTests, []);
});

// An inline (same-line) body — no list follows the header — is the one shape
// that only `namedTestPaths`' body arm reaches (PR #3160 review): a one-line
// `Branch outcomes:` summary naming a test that does not exist must still be
// caught, or the gate's own invented-test case (VibeCoder#3132) slips through.
Deno.test("validateBranchOutcomes - an inline body naming a missing test blocks (Issue #3160)", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent:
      "**Branch outcomes:** `src/foo.ts:12` — error — `worker/deno/tests/made_up_test.ts::x`\n",
    testsAtHead: new Set(["worker/deno/tests/other_test.ts"]),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, ["worker/deno/tests/made_up_test.ts"]);
});

Deno.test("validateBranchOutcomes - an inline body naming an existing test passes (Issue #3160)", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent:
      "**Branch outcomes:** `src/foo.ts:12` — error — `worker/deno/tests/foo_test.ts::x`\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
  assertEquals(result.missingTests, []);
});

Deno.test("validateBranchOutcomes - 'none added' passes", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:** none added\n",
    testsAtHead: new Set(),
  });
  assert(result.valid);
});

Deno.test("validateBranchOutcomes - an empty list blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n\n## Next heading\n",
    testsAtHead: new Set(),
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "names no outcomes");
});

Deno.test("validateBranchOutcomes - a bare placeholder blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:** tbd\n",
    testsAtHead: new Set(),
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "bare placeholder");
});

Deno.test("validateBranchOutcomes - a non-code diff (docs + test files only) is not applicable", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["README.md", "worker/deno/tests/foo_test.ts"],
    prSummaryContent: "## Summary\n",
    testsAtHead: new Set(),
  });
  assertEquals(result.applicable, false);
  assert(result.valid);
});

Deno.test("validateBranchOutcomes - changedFiles null is applicable (fail closed)", () => {
  const result = validateBranchOutcomes({
    changedFiles: null,
    prSummaryContent: "## Summary\n",
    testsAtHead: new Set(),
  });
  assert(result.applicable);
  assertEquals(result.valid, false);
});

Deno.test("buildBranchOutcomesGateComment - names the problem and the required shape", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Summary\n",
    testsAtHead: new Set(),
  });
  const comment = buildBranchOutcomesGateComment(result);
  assertStringIncludes(comment, "Branch outcomes not recorded");
  assertStringIncludes(comment, "none added");
  assertStringIncludes(comment, "repository root");
});

// ---------------------------------------------------------------------------
// Hostile input (Issue #3147, CODING-STANDARDS "Guard super-linearity by
// behaviour first") — a behaviour assertion, not a wall-clock threshold. A
// quadratic parse would make this test exceed Deno's own test timeout rather
// than merely run slowly, which is the only signal this test needs.
// ---------------------------------------------------------------------------

Deno.test("parseBranchOutcomes - a 100k-char hostile line returns a bounded, well-formed result", () => {
  const hostileEntry = "a.a.a.".repeat(20_000); // ~120k chars, no newline
  const content = `**Branch outcomes:**\n- ${hostileEntry}\n`;
  const record = parseBranchOutcomes(content);
  assert(record.present);
  assertEquals(record.entries.length, 1);
  assert(record.entries[0]!.length <= 4_000);
});

Deno.test("parseBranchOutcomes - a long run of spaces in the inline body returns a bounded result", () => {
  const spaces = " ".repeat(100_000);
  const content = `**Branch outcomes:**${spaces}none added\n`;
  const record = parseBranchOutcomes(content);
  assert(record.present);
});

Deno.test(
  "parseBranchOutcomes - a heading line with a long trailing space run scales linearly (PR #3160 review)",
  () => {
    // `## Branch outcomes` + N spaces + a trailing `x` is the shape that
    // makes two adjacent `\s*` around the optional `:?` backtrack: the run
    // of spaces matches both `\s*`s in every split, and `x` never lets the
    // `$` anchor succeed. Run this against the unfixed
    // `/^#{1,6}\s*branch\s+outcomes\s*:?\s*$/i` first to see it hang.
    const buildSummary = (chars: number) =>
      `## Branch outcomes${" ".repeat(chars)}x\n`;

    const result = assertLinearGrowth(
      "branch-outcomes heading trailing-space scan",
      buildSummary,
      (input) => parseBranchOutcomes(input),
      { baseChars: 25_000 },
    );

    // The trailing `x` means the heading never matches, so the header is
    // never found at all.
    assertEquals(result.present, false);
  },
);

// ---------------------------------------------------------------------------
// lookupTestsAtHead
// ---------------------------------------------------------------------------

Deno.test("lookupTestsAtHead - empty paths returns an empty set without calling git", async () => {
  let called = false;
  const runGit = () => {
    called = true;
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  };
  const result = await lookupTestsAtHead([], runGit);
  assertEquals(result, new Set());
  assertEquals(called, false);
});

Deno.test("lookupTestsAtHead - a failed git invocation returns null", async () => {
  const runGit = () =>
    Promise.resolve({ ok: false as const, error: new Error("spawn failed") });
  const result = await lookupTestsAtHead(
    ["worker/deno/tests/foo_test.ts"],
    runGit,
  );
  assertEquals(result, null);
});

Deno.test("lookupTestsAtHead - a non-zero exit returns null", async () => {
  const runGit = () =>
    Promise.resolve({
      ok: true as const,
      value: { code: 128, stdout: "", stderr: "fatal: bad object HEAD" },
    });
  const result = await lookupTestsAtHead(
    ["worker/deno/tests/foo_test.ts"],
    runGit,
  );
  assertEquals(result, null);
});

Deno.test("lookupTestsAtHead - parses stdout lines into the returned set", async () => {
  const runGit = () =>
    Promise.resolve({
      ok: true as const,
      value: {
        code: 0,
        stdout:
          "worker/deno/tests/foo_test.ts\nworker/deno/tests/bar_test.ts\n",
        stderr: "",
      },
    });
  const result = await lookupTestsAtHead(
    ["worker/deno/tests/foo_test.ts", "worker/deno/tests/bar_test.ts"],
    runGit,
  );
  assertEquals(
    result,
    new Set(["worker/deno/tests/foo_test.ts", "worker/deno/tests/bar_test.ts"]),
  );
});

Deno.test("lookupTestsAtHead - invokes git with --literal-pathspecs ls-tree -r --name-only HEAD --", async () => {
  let seenArgs: string[] = [];
  const runGit = (args: string[]) => {
    seenArgs = args;
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  };
  await lookupTestsAtHead(["worker/deno/tests/foo_test.ts"], runGit);
  assertEquals(
    seenArgs,
    [
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
      "--",
      "worker/deno/tests/foo_test.ts",
    ],
  );
});
