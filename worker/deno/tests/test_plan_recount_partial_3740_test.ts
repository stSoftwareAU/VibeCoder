// Tests for per-claim handling of partial additions, "now has N" totals and
// unknown files in Test Plan prose (Issue #3740).
import { assertEquals } from "@std/assert";
import {
  findTestPlanMismatches,
  findUncheckedRunResults,
  type TestDeclarationCounts,
} from "../lib/test_plan_recount.ts";
import { assertLinearGrowth } from "./support/growth.ts";

function counts(
  entries: Record<string, number>,
): Map<string, TestDeclarationCounts> {
  return new Map(
    Object.entries(entries).map(([k, v]) => [k, { total: v, runnable: v }]),
  );
}

function plan(...lines: string[]): string {
  return "## Test Plan\n\n" + lines.join("\n") + "\n";
}

function mismatchesOf(
  summary: string,
  heads: Record<string, number>,
): unknown[] {
  return findTestPlanMismatches({ summary, headCounts: counts(heads) }).map(
    (m) => [m.files, m.claimed, m.actual],
  );
}

function uncheckedLines(
  summary: string,
  heads: Record<string, number>,
): string[] {
  return findUncheckedRunResults({ summary, headCounts: counts(heads) }).map(
    (u) => u.line,
  );
}

// The #3676 review-push bullets from docs/archive/pr-summaries/pr-summary-3506.md,
// copied verbatim (lines 184-198 and 207-216). The last bullet is cut after its
// second line, as the bullet continues beyond line 216 in that file.
const FIXTURE_3676 = [
  "- PR #3676 review push (fourth round, follow-up chain): 3 tests added to",
  "  `worker/deno/tests/completion_phase_degraded_delivery_test.ts` (a healthy",
  "  run on a follow-up files no `idle-task` issue, labels it `needs-human`,",
  "  comments, and its PR body opens with the chain-stop section and does not",
  "  close it; a failed label raises no PR and posts no comment; a degraded run",
  "  on a follow-up still files one), 2 to `worker/deno/tests/pr_body_sync_test.ts`",
  "  (the re-sync keeps the section while a gap remains and drops it once none",
  "  does) and the new `worker/deno/tests/follow_up_chain_stop_test.ts` (11 tests:",
  "  the helpers, the leading-section rule (a quoted marker and a later-heading",
  "  mention do not hold the issue), and the closers leaving a chain-stop PR's",
  "  issue open). The",
  "  related suites (689 tests) passed, with `deno fmt --check`, `deno lint` and",
  "  `deno check`. Red check: forcing the chain-stop condition in the guard turned",
  "  9 completion tests red; disabling the closer branch in `pr_issue_linking.ts`",
  "  turned 2 closer tests red. The full gate was not re-run on this push.",
  "- Added to `worker/deno/tests/degraded_delivery_test.ts` (18 tests; the file",
  "  now has 65): `assessReportedGaps`, the healthy and degraded follow-up",
  "  bodies, `buildReportedGapPrSection`, `rederiveReportedGapSection` (empty",
  "  when met; gaps the section was raised with stay as they are; changed gaps",
  "  keep the number and say the follow-up may not list them; a hostile bullet",
  "  and a 50,000-digit run are not read as a number) and",
  "  `buildReportedGapStaleFollowUpSection` (exact layout and throw), and",
  "  `fileDegradedFollowUp - a parent's milestone is passed to gh issue create`.",
  "- Added to `worker/deno/tests/pr_body_sync_test.ts` (8 tests; the file now",
  "  has 54): the section is kept while a gap remains, dropped when every",
];

const REPLAY_FILES = {
  follow: "worker/deno/tests/follow_up_chain_stop_test.ts",
  sync: "worker/deno/tests/pr_body_sync_test.ts",
};

const PARTIAL =
  "the block describes partial test additions, not whole-file counts";

Deno.test("a single whole-file count ignores partial markers in its trailing description", () => {
  for (
    const description of [
      "covers the extended retry path",
      "covers a retry added to cleanup",
    ]
  ) {
    const summary = plan(
      `- New \`tests/a_test.ts\` (5 tests at head): ${description}.`,
    );
    assertEquals(mismatchesOf(summary, { "tests/a_test.ts": 6 }), [
      [["tests/a_test.ts"], 5, 6],
    ]);
    assertEquals(uncheckedLines(summary, { "tests/a_test.ts": 6 }), []);
    assertEquals(mismatchesOf(summary, { "tests/a_test.ts": 5 }), []);
  }
});

Deno.test("a single added-to figure remains partial", () => {
  const summary = plan(
    "- Added to `tests/a_test.ts` (5 tests): covers the retry path.",
  );
  assertEquals(mismatchesOf(summary, { "tests/a_test.ts": 6 }), []);
  assertEquals(
    findUncheckedRunResults({
      summary,
      headCounts: counts({ "tests/a_test.ts": 6 }),
    }).map((u) => u.reason),
    [PARTIAL],
  );
});

Deno.test("a block mixing a partial addition and a whole-file count checks only the whole-file count", () => {
  const summary = plan(
    "- 3 tests added to `tests/a_test.ts` (34 tests in all), and `tests/b_test.ts` (8 tests) passes.",
  );
  assertEquals(
    mismatchesOf(summary, { "tests/a_test.ts": 34, "tests/b_test.ts": 11 }),
    [[["tests/b_test.ts"], 8, 11]],
  );
});

Deno.test("'Added to file (N tests; the file now has M)' compares M, also when hard-wrapped", () => {
  const flat = plan(
    "- Added to `tests/c_test.ts` (8 tests; the file now has 47).",
  );
  const wrapped = plan(
    "- Added to `tests/c_test.ts` (8 tests; the file",
    "  now has 47).",
  );
  assertEquals(mismatchesOf(flat, { "tests/c_test.ts": 54 }), [
    [["tests/c_test.ts"], 47, 54],
  ]);
  assertEquals(mismatchesOf(wrapped, { "tests/c_test.ts": 54 }), [
    [["tests/c_test.ts"], 47, 54],
  ]);
});

Deno.test("negative control: correct per-file figures raise no mismatch", () => {
  const summary = plan(
    "- 3 tests added to `tests/b_test.ts` (8 tests).",
    "- Added to `tests/c_test.ts` (8 tests; the file now has 47).",
  );
  assertEquals(
    mismatchesOf(summary, { "tests/b_test.ts": 8, "tests/c_test.ts": 47 }),
    [],
  );
});

Deno.test("a pure 'N tests added to file' figure is unchecked, not compared", () => {
  const summary = plan("- 4 tests added to `tests/d_test.ts`.");
  assertEquals(mismatchesOf(summary, { "tests/d_test.ts": 10 }), []);
  assertEquals(uncheckedLines(summary, { "tests/d_test.ts": 10 }), [
    "- 4 tests added to `tests/d_test.ts`.",
  ]);
});

Deno.test("a '+3 tests' figure is unchecked, not compared", () => {
  const summary = plan("- Added `tests/e_test.ts` (+3 tests).");
  assertEquals(mismatchesOf(summary, { "tests/e_test.ts": 12 }), []);
  assertEquals(uncheckedLines(summary, { "tests/e_test.ts": 12 }), [
    "- Added `tests/e_test.ts` (+3 tests).",
  ]);
});

Deno.test("the #3676 replay: stale totals give two mismatches, corrected totals give none", () => {
  const summary = plan(...FIXTURE_3676);
  assertEquals(
    mismatchesOf(summary, {
      [REPLAY_FILES.follow]: 8,
      [REPLAY_FILES.sync]: 47,
    }),
    [
      [[REPLAY_FILES.follow], 11, 8],
      [[REPLAY_FILES.sync], 54, 47],
    ],
  );
  assertEquals(
    mismatchesOf(summary, {
      [REPLAY_FILES.follow]: 11,
      [REPLAY_FILES.sync]: 54,
    }),
    [],
  );
  assertEquals(
    uncheckedLines(summary, {
      [REPLAY_FILES.follow]: 11,
      [REPLAY_FILES.sync]: 54,
    })
      .some((line) => line.startsWith("- PR #3676 review push")),
    true,
  );
});

Deno.test("a per-claim unknown file is unchecked while the other claim is still compared", () => {
  const summary = plan(
    "- `tests/a_test.ts` (5 tests) and `tests/unchanged_test.ts` (9 tests).",
    "- Over the whole run: 20 tests passed.",
  );
  assertEquals(mismatchesOf(summary, { "tests/a_test.ts": 6 }), [
    [["tests/a_test.ts"], 5, 6],
  ]);
  const unchecked = uncheckedLines(summary, { "tests/a_test.ts": 6 });
  assertEquals(
    unchecked.some((line) => line.includes("tests/unchanged_test.ts")),
    true,
  );
  assertEquals(
    mismatchesOf(
      "## Test Plan\n\n- Over the whole run: 20 tests passed.\n",
      {},
    ),
    [],
  );
});

Deno.test("evasion spellings of the now-has total are compared both ways", () => {
  const variants = [
    "- Added to `tests/c_test.ts` (8 tests; the file NOW HAS 47).",
    "- Added to `tests/c_test.ts` (8 tests; the file **now has 47**).",
    "- Added to `tests/c_test.ts` (8 tests; the file now\thas 47).",
    "- Added to `tests/c_test.ts`  (8 tests;  the file now has 47).",
  ];
  for (const bullet of variants) {
    const summary = plan(bullet);
    assertEquals(mismatchesOf(summary, { "tests/c_test.ts": 54 }), [
      [["tests/c_test.ts"], 47, 54],
    ]);
    assertEquals(mismatchesOf(summary, { "tests/c_test.ts": 47 }), []);
  }
});

Deno.test("hostile runs of the new partial, total and bare-figure regexes grow linearly", () => {
  const headCounts = counts({ "tests/c_test.ts": 47 });
  const cases: [string, (chars: number) => string][] = [
    [
      "now-has total",
      (chars) =>
        plan(
          "- Added to `tests/c_test.ts` (8 tests; " +
            "now ".repeat(Math.floor(chars / 4)) + "has 47).",
        ),
    ],
    [
      "partial gap",
      (chars) =>
        plan(
          "- `tests/c_test.ts`" + " `".repeat(Math.floor(chars / 2)) +
            " (8 tests).",
        ),
    ],
    [
      "bare N to",
      (chars) =>
        plan(
          "- " + "1 to ".repeat(Math.floor(chars / 5)) +
            "`tests/c_test.ts` (8 tests).",
        ),
    ],
    [
      "plus sign",
      (chars) =>
        plan(
          "- `tests/c_test.ts` " + "+ ".repeat(Math.floor(chars / 2)) +
            "3 tests.",
        ),
    ],
    [
      "added marker",
      (chars) =>
        plan(
          "- " + "added ".repeat(Math.floor(chars / 6)) +
            "to `tests/c_test.ts` (8 tests).",
        ),
    ],
  ];
  for (const [label, build] of cases) {
    assertLinearGrowth(
      label,
      build,
      (summary) => findTestPlanMismatches({ summary, headCounts }),
      { baseChars: 5_000 },
    );
  }
});

Deno.test("the 1823 shape: 'Extended' governs the later figure, so both figures are unchecked (Issue #3740)", () => {
  const summary = plan(
    '- Extended `worker/deno/tests/tool_release_age_test.ts` (5 tests) for the now-exported `resolveGitHubReleaseHistory` — happy path, an empty-but-`ok` listing, a non-zero exit, a spawn failure and a malformed repo that never reaches the API — and `worker/deno/tests/pinned_actions_test.ts` (3 tests) for the `resolution` field, including that both branch-HEAD entries are `"catalogue"`.',
  );
  const heads = {
    "worker/deno/tests/tool_release_age_test.ts": 12,
    "worker/deno/tests/pinned_actions_test.ts": 7,
  };
  assertEquals(mismatchesOf(summary, heads), []);
  assertEquals(
    findUncheckedRunResults({ summary, headCounts: counts(heads) }).map(
      (u) => u.reason,
    ),
    [PARTIAL, PARTIAL],
  );
});

Deno.test("'Extended `a` (5 tests) and the new `b` (3 tests)': the new file's figure is compared, the extended one is not (Issue #3740)", () => {
  const summary = plan(
    "- Extended `tests/a_test.ts` (5 tests) and the new `tests/b_test.ts` (3 tests).",
  );
  const heads = { "tests/a_test.ts": 9, "tests/b_test.ts": 4 };
  assertEquals(mismatchesOf(summary, heads), [[["tests/b_test.ts"], 3, 4]]);
  assertEquals(
    findUncheckedRunResults({ summary, headCounts: counts(heads) }).map(
      (u) => u.reason,
    ),
    [PARTIAL],
  );
});

Deno.test("'Added `file` (N tests)' announces a new file, so the figure is compared whole (Issue #3740)", () => {
  const summary = plan(
    "- Added `worker/deno/tests/pre_pr_verifier_3395_test.ts` (33 tests), `worker/deno/tests/completion_phase_pre_pr_verifier_3395_test.ts` (10 tests), `worker/deno/tests/pr_review_brief_shared_3395_test.ts` (5 tests).",
  );
  const heads = {
    "worker/deno/tests/pre_pr_verifier_3395_test.ts": 55,
    "worker/deno/tests/completion_phase_pre_pr_verifier_3395_test.ts": 10,
    "worker/deno/tests/pr_review_brief_shared_3395_test.ts": 5,
  };
  assertEquals(mismatchesOf(summary, heads), [
    [["worker/deno/tests/pre_pr_verifier_3395_test.ts"], 33, 55],
  ]);
  assertEquals(uncheckedLines(summary, heads), []);
});

Deno.test("hostile runs of the sentence-scope and added-tail checks grow linearly (Issue #3740)", () => {
  const headCounts = counts({
    "tests/c_test.ts": 47,
    "tests/d_test.ts": 5,
  });
  const cases: [string, (chars: number) => string][] = [
    [
      "added tail before a rejected character",
      (chars) =>
        plan("- added" + " ".repeat(chars) + "! `tests/c_test.ts` (8 tests)."),
    ],
    [
      "extended sentence scope",
      (chars) =>
        plan(
          "- " + "extended ".repeat(Math.floor(chars / 9)) +
            "`tests/c_test.ts` (8 tests).",
        ),
    ],
    [
      "new override",
      (chars) =>
        plan(
          "- Extended `tests/d_test.ts` (5 tests) and " +
            "new ".repeat(Math.floor(chars / 4)) +
            "`tests/c_test.ts` (8 tests).",
        ),
    ],
  ];
  for (const [label, build] of cases) {
    assertLinearGrowth(
      label,
      build,
      (summary) => findTestPlanMismatches({ summary, headCounts }),
      { baseChars: 5_000 },
    );
  }
});
