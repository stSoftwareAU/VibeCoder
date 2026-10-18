/**
 * Unit tests for the PR summary facts helpers (Issue #3535, part of #3396).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { MAX_ENTRIES, MAX_SCAN_CHARS } from "../lib/branch_outcomes_gate.ts";
import {
  findStaleCitations,
  parseDiffHunks,
} from "../lib/branch_outcome_citations.ts";
import {
  renderBranchOutcomes,
  type SummaryFacts,
} from "../lib/summary_facts.ts";
import {
  applyBranchOutcomesFacts as applyFactsResult,
  BRANCH_OUTCOMES_END_MARKER,
  BRANCH_OUTCOMES_MARKER,
  loadPrSummaryFacts,
  prSummaryDigestInput,
  prSummaryFactsPath,
  resolveBranchOutcomesFacts,
} from "../lib/pr_summary_facts.ts";

/** Unwrap results to compare rendered text and assert specific refusal errors. */
function applyBranchOutcomesFacts(summary: string, rendered: string): string {
  const result = applyFactsResult(summary, rendered);
  if (!result.ok) throw result.error;
  return result.value;
}

Deno.test("applyBranchOutcomesFacts refuses duplicate ownership markers (Issue #3979)", () => {
  assertThrows(
    () =>
      applyBranchOutcomesFacts(
        `a\n${BRANCH_OUTCOMES_MARKER}\nb\n${BRANCH_OUTCOMES_MARKER}\n`,
        "LIST",
      ),
    Error,
    "unmatched renderer markers",
  );
  assert(
    applyBranchOutcomesFacts(`a\n${BRANCH_OUTCOMES_MARKER}\nb\n`, "LIST")
      .includes("b\n"),
  );
});

Deno.test("applyBranchOutcomesFacts appends an owned block when the marker is absent", () => {
  for (
    const prefix of ["body", "body\n", "body\n\n", "body\n\n\n", "body\r\n"]
  ) {
    const expected = prefix + (prefix.endsWith("\n") ? "" : "\n\n") +
      `${BRANCH_OUTCOMES_MARKER}\nLIST\n${BRANCH_OUTCOMES_END_MARKER}\n`;
    assertEquals(applyBranchOutcomesFacts(prefix, "LIST"), expected);
    assertEquals(applyBranchOutcomesFacts(expected, "LIST"), expected);
  }
});

Deno.test("applyBranchOutcomesFacts returns an owned block for an empty summary", () => {
  assertEquals(
    applyBranchOutcomesFacts("  \n", "LIST"),
    `${BRANCH_OUTCOMES_MARKER}\nLIST\n${BRANCH_OUTCOMES_END_MARKER}\n`,
  );
});

Deno.test("prSummaryDigestInput leaves the summary unchanged without facts", () => {
  assertEquals(prSummaryDigestInput("summary", null), "summary");
});

Deno.test("prSummaryDigestInput differs when facts are present", () => {
  const withFacts = prSummaryDigestInput("summary", "{}");
  assertNotEquals(withFacts, "summary");
  assertNotEquals(withFacts, prSummaryDigestInput("summary", '{"a":1}'));
});

Deno.test("loadPrSummaryFacts returns null when the file is missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await loadPrSummaryFacts(dir, 7), { ok: true, value: null });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadPrSummaryFacts reads the file content", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, { recursive: true });
    await Deno.writeTextFile(`${dir}/${prSummaryFactsPath(7)}`, "{}");
    assertEquals(await loadPrSummaryFacts(dir, 7), {
      ok: true,
      value: { content: "{}", relativePath: prSummaryFactsPath(7) },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadPrSummaryFacts reports an unreadable path, naming it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/${prSummaryFactsPath(7)}`, { recursive: true });
    const result = await loadPrSummaryFacts(dir, 7);
    assertEquals(result.ok, false);
    assert(!result.ok);
    assert(result.error.message.includes(prSummaryFactsPath(7)));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveBranchOutcomesFacts names the file and has no content when it is unreadable", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/${prSummaryFactsPath(7)}`, { recursive: true });
    const outcome = await resolveBranchOutcomesFacts(dir, 7);
    assert(outcome.kind === "error");
    assertEquals(outcome.relativePath, prSummaryFactsPath(7));
    assertEquals(outcome.content, null);
    assert(outcome.reason.includes("could not be read"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveBranchOutcomesFacts keeps the file name and raw content when it is invalid", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, { recursive: true });
    await Deno.writeTextFile(`${dir}/${prSummaryFactsPath(7)}`, "{ not json");
    const outcome = await resolveBranchOutcomesFacts(dir, 7);
    assert(outcome.kind === "error");
    assertEquals(outcome.relativePath, prSummaryFactsPath(7));
    assertEquals(outcome.content, "{ not json");
    assert(outcome.reason.includes("is invalid"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("facts replace a legacy duplicate once and preserve unrelated narrative (Issue #3979)", () => {
  const legacy =
    "**Branch outcomes:**\n\n- `lib/old.ts:7` — old outcome — test `tests/old_test.ts` (`old test`) — flip: `went red`";
  const rendered =
    "**Branch outcomes:**\n\n- `lib/new.ts:9` — current outcome — test `tests/new_test.ts` (`current test`) — flip: `went red`";
  const summary =
    `## Test Plan\n\nKeep this introduction.\n\n${BRANCH_OUTCOMES_MARKER}\n\n${legacy}\n\nBranch outcomes: none added\n\nKeep this closing note.\n\n## Deployment\n\nKeep deployment instructions.\n`;
  const result = applyBranchOutcomesFacts(summary, rendered);
  assertEquals(result.match(/\*\*Branch outcomes:\*\*/g)?.length, 1);
  assert(!result.includes("lib/old.ts"));
  assert(result.includes("Keep this introduction."));
  assert(result.includes("Keep this closing note."));
  assert(result.includes("Keep deployment instructions."));
  assertEquals(applyBranchOutcomesFacts(result, rendered), result);
});

Deno.test("facts cannot erase ambiguous evidence or an unreached-outcome admission (Issue #3979)", () => {
  const none = "Branch outcomes: none added";
  const owned =
    `${BRANCH_OUTCOMES_MARKER}\n${none}\n${BRANCH_OUTCOMES_END_MARKER}\n`;
  const entries = (count: number) =>
    "**Branch outcomes:**\n\n" + Array.from(
      { length: count },
      (_, i) => `- lib/a.ts:${i + 1} — fixture outcome`,
    ).join("\n");
  const cases = [
    {
      input: `${BRANCH_OUTCOMES_END_MARKER}\n`,
      cause: "unmatched renderer markers",
      legal: owned,
    },
    {
      input: owned + BRANCH_OUTCOMES_END_MARKER,
      cause: "unmatched renderer markers",
      legal: owned,
    },
    {
      input: `${BRANCH_OUTCOMES_END_MARKER}\n${BRANCH_OUTCOMES_MARKER}`,
      cause: "unmatched renderer markers",
      legal: owned,
    },
    ...[
      "`Branch outcomes: none added`",
      "- `Branch outcomes: none added`",
      "**`Branch outcomes: none added`**",
      "`Branch outcomes: none\nadded`",
      "- `Branch outcomes: none\n  added`",
    ].map((input) => ({ input, cause: "inline-code header", legal: none })),
    {
      input: "x".repeat(MAX_SCAN_CHARS + 1),
      cause: "summary exceeds the parser limit",
      legal: "x",
    },
    {
      input: entries(MAX_ENTRIES + 1),
      cause: "unowned evidence",
      legal: entries(MAX_ENTRIES),
    },
    {
      input:
        "**Branch outcomes:**\n\n- A reviewer finding still needs investigation.\n",
      cause: "unowned evidence",
      legal: "**Branch outcomes:**\n\n- lib/a.ts:9 — reviewed outcome\n",
    },
    {
      input:
        "**Branch outcomes:**\n\n- lib/a.ts:9 — no test reaches this outcome\n",
      cause: "admits no test reaches its outcome",
      legal:
        "**Branch outcomes:**\n\n- lib/a.ts:9 — outcome — test tests/a_test.ts\n",
    },
    {
      input: "**Branch outcomes:** unresolved evidence\n",
      cause: "unowned evidence",
      legal: "**Branch outcomes:** none added\n",
    },
    {
      input:
        "**Branch outcomes:**\n\n- lib/a.ts:1 — outcome\nUnrelated deployment note.",
      cause: "unowned evidence",
      legal:
        "**Branch outcomes:**\n\n- lib/a.ts:1 — outcome\n\nUnrelated deployment note.",
    },
  ];
  for (const { input, cause, legal } of cases) {
    assertThrows(() => applyBranchOutcomesFacts(input, none), Error, cause);
    assert(
      applyBranchOutcomesFacts(legal, none).includes(BRANCH_OUTCOMES_MARKER),
    );
  }
});

Deno.test("facts preserve line endings and fenced examples outside the owned block (Issue #3979)", () => {
  const prefix =
    `## Example\r\n\r\n\`\`\`md\r\n${BRANCH_OUTCOMES_MARKER}\r\nBranch outcomes: none added\r\n${BRANCH_OUTCOMES_END_MARKER}\r\n\`\`\`\r\n\r\n`;
  const summary = prefix + BRANCH_OUTCOMES_MARKER + "\r\n";
  const result = applyBranchOutcomesFacts(
    summary,
    "Branch outcomes: none added",
  );
  assert(result.startsWith(prefix));
  assertEquals(
    applyBranchOutcomesFacts(result, "Branch outcomes: none added"),
    result,
  );
});

Deno.test("rendering retains stale anchors for the existing head-drift check instead of retargeting them (Issue #3979)", () => {
  const facts: SummaryFacts = {
    version: 1,
    branchOutcomes: {
      noneAdded: false,
      entries: [{
        path: "lib/a.ts",
        line: 2,
        outcome: "error",
        test: "tests/a_test.ts",
        testName: "rejects invalid input",
        flipWentRed: "synthetic fixture: removing the guard failed",
      }],
    },
  };
  const previous = applyBranchOutcomesFacts(
    BRANCH_OUTCOMES_MARKER,
    renderBranchOutcomes(facts),
  );
  const current = applyBranchOutcomesFacts(
    previous,
    renderBranchOutcomes(facts),
  );
  assert(current.includes("lib/a.ts:2"));
  const result = findStaleCitations({
    summaryPath: "summary.md",
    previousSummary: previous,
    currentSummary: current,
    previousFacts: facts,
    currentFacts: facts,
    currentFactsPath: "summary.facts.json",
    changedFiles: ["lib/a.ts"],
    hunksByPath: new Map([["lib/a.ts", parseDiffHunks("@@ -1,0 +2,2 @@\n")!]]),
  });
  assertEquals(result.stale.length, 1);
  assert(result.stale[0]!.includes("summary.facts.json"));
});

Deno.test("rendering cannot move evidence beyond the existing parser limit (Issue #3979)", () => {
  assertThrows(
    () =>
      applyBranchOutcomesFacts(
        "x".repeat(MAX_SCAN_CHARS - 10),
        "Branch outcomes: none added",
      ),
    Error,
    "parser limit",
  );
});

Deno.test("oversized legacy evidence is refused before ownership is inferred from a partial parse (Issue #3979)", () => {
  const prefix = "x".repeat(MAX_SCAN_CHARS - 500);
  const entries = "- lib/a.ts:9 — synthetic outcome\n".repeat(6);
  const tail = "- lib/a.ts:99 — " + "x".repeat(500) +
    " synthetic outcome\n";
  const summary = `${prefix}\n**Branch outcomes:**\n\n${entries}${tail}`;
  assert(summary.length > MAX_SCAN_CHARS);
  const complete = summary.replace(prefix, "prefix");
  assert(
    applyBranchOutcomesFacts(complete, "Branch outcomes: none added").includes(
      BRANCH_OUTCOMES_MARKER,
    ),
  );
  assertThrows(
    () => applyBranchOutcomesFacts(summary, "Branch outcomes: none added"),
    Error,
    "parser limit",
  );
});

Deno.test("a known renderer marker directly after a legacy entry is a boundary (Issue #3979)", () => {
  const legacy =
    "**Branch outcomes:**\n\n- `lib/a.ts:1` — outcome — test `tests/a_test.ts` — flip: went red\n";
  const rendered = "Branch outcomes: none added";
  const result = applyBranchOutcomesFacts(
    legacy + BRANCH_OUTCOMES_MARKER + "\n",
    rendered,
  );
  assert(!result.includes("lib/a.ts"));
  assertEquals(result.match(/vibe-branch-outcomes -->/g)?.length, 2);
  assertEquals(applyBranchOutcomesFacts(result, rendered), result);
});
