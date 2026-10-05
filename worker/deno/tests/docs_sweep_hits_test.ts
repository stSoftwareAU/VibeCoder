/**
 * Tests for the Docs sweep term re-run (Issue #3172).
 *
 * The docs-sweep gate (Issue #3073) checked that a PR summary carried a
 * Docs sweep line naming a manual `section:`, but never re-ran the line's own
 * grep terms against the head. Fleet PRs passed with hits of their own
 * declared terms still stating removed behaviour, often in a file the line
 * listed as updated (GRQ-AutoTrader#2413, #2405). These tests pin the pure
 * parsing and the git-driven check, with git replaced by a stub that answers
 * the way `git grep -z` and `git diff --unified=0` do.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  buildDocsSweepHitsComment,
  checkDocsSweepTerms,
  DOCS_SWEEP_PATHSPECS,
  type DocsSweepGitRunner,
  extractGrepTerms,
  extractNamedLines,
  isSourceCommentLine,
  MAX_REPORTED_HITS,
  MAX_UNTOUCHED_HITS_PER_TERM,
  parseChangedLines,
  parseGitGrepOutput,
  SOURCE_COMMENT_PATHSPECS,
  termToGitGrepPattern,
} from "../lib/docs_sweep_hits.ts";
import { parseDocsSweepLine } from "../lib/docs_sweep_gate.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

// ---------------------------------------------------------------------------
// extractGrepTerms
// ---------------------------------------------------------------------------

Deno.test("extractGrepTerms - reads backticked and double-quoted terms after grep:", () => {
  const raw =
    '**Docs sweep** — grep: `ProposalStore::list`, "one session at a time"; ' +
    "section: `docs/reporting-api.md#decisions-report`; updated: `docs/x.md`";
  assertEquals(extractGrepTerms(raw), [
    "ProposalStore::list",
    "one session at a time",
  ]);
});

Deno.test("extractGrepTerms - stops at the first field separator outside a term", () => {
  const raw = 'grep: `a;b`, "c"; section: `docs/x.md#y`; updated: `docs/z.md`';
  assertEquals(extractGrepTerms(raw), ["a;b", "c"]);
});

Deno.test("extractGrepTerms - reads curly quotes as double quotes", () => {
  const raw = "grep: “maximum trade”, `min_buy`; section: none — x";
  assertEquals(extractGrepTerms(raw), ["maximum trade", "min_buy"]);
});

Deno.test("extractGrepTerms - keeps underscores and asterisks inside a term", () => {
  const raw = "grep: `retry_limit`, `replac\\w*`; section: `docs/a.md`";
  assertEquals(extractGrepTerms(raw), ["retry_limit", "replac\\w*"]);
});

Deno.test("extractGrepTerms - case-insensitive grep: label, deduplicated terms", () => {
  const raw = 'Grep: `Foo`, "foo", `bar`; section: `docs/a.md`';
  assertEquals(extractGrepTerms(raw), ["Foo", "bar"]);
});

Deno.test("extractGrepTerms - no grep: field yields no terms", () => {
  assertEquals(extractGrepTerms("section: `docs/a.md`; no hits"), []);
});

Deno.test("extractGrepTerms - an unclosed quote ends the scan without a term", () => {
  assertEquals(extractGrepTerms("grep: `foo`, `bar; section: x"), ["foo"]);
});

Deno.test("extractGrepTerms - empty terms are skipped", () => {
  assertEquals(extractGrepTerms('grep: ``, "  ", `x`; section: y'), ["x"]);
});

// ---------------------------------------------------------------------------
// parseDocsSweepLine keeps the raw body (backticks and underscores intact)
// ---------------------------------------------------------------------------

Deno.test("parseDocsSweepLine - rawBody keeps backticks and underscores for term extraction", () => {
  const summary = [
    "## Evidence",
    "",
    '- **Docs sweep** — grep: `retry_limit`, "maximum',
    '  trade"; section: `docs/a.md#b`; updated: `docs/a.md`',
    "",
    "## Test Plan",
  ].join("\n");
  const line = parseDocsSweepLine(summary);
  assertEquals(line.present, true);
  assertEquals(extractGrepTerms(line.rawBody), [
    "retry_limit",
    "maximum trade",
  ]);
});

Deno.test("parseDocsSweepLine - absent line has an empty rawBody", () => {
  assertEquals(parseDocsSweepLine("## Summary\n\nNothing.").rawBody, "");
});

// ---------------------------------------------------------------------------
// extractNamedLines
// ---------------------------------------------------------------------------

Deno.test("extractNamedLines - reads file:line and file:start-end references", () => {
  const raw = "remaining hits: `docs/replay/2026-08.md:143` — still true; " +
    "docs/bootstrap-runbook.md:655-656 still true because …; README.md:12";
  const named = extractNamedLines(raw);
  assertEquals(named.get("docs/replay/2026-08.md"), [[143, 143]]);
  assertEquals(named.get("docs/bootstrap-runbook.md"), [[655, 656]]);
  assertEquals(named.get("README.md"), [[12, 12]]);
});

Deno.test("extractNamedLines - names a non-Markdown file under docs/ too (grep hits any file there)", () => {
  const named = extractNamedLines(
    "`docs/audits/lib-sweep-coverage.json:2496-2500` — still true",
  );
  assertEquals(named.get("docs/audits/lib-sweep-coverage.json"), [[
    2496,
    2500,
  ]]);
});

Deno.test("extractNamedLines - strips a leading ./ from the path", () => {
  assertEquals(extractNamedLines("./docs/a.md:3").get("docs/a.md"), [[3, 3]]);
});

Deno.test("extractNamedLines - a path with no line number names nothing", () => {
  assertEquals(extractNamedLines("updated: `docs/a.md`").size, 0);
});

// ---------------------------------------------------------------------------
// termToGitGrepPattern
// ---------------------------------------------------------------------------

Deno.test("termToGitGrepPattern - escapes every ERE metacharacter in a literal term", () => {
  assertEquals(
    termToGitGrepPattern("a.b(c)[d]{e}|f^g$h+i?j*k\\l"),
    "a\\.b\\(c\\)\\[d\\]\\{e\\}\\|f\\^g\\$h\\+i\\?j\\*k\\\\l",
  );
});

Deno.test("termToGitGrepPattern - translates a \\w* or \\w+ stem into a word-character run", () => {
  assertEquals(
    termToGitGrepPattern("replac\\w* or remov\\w+"),
    "replac[[:alnum:]_]* or remov[[:alnum:]_]+",
  );
});

// ---------------------------------------------------------------------------
// parseGitGrepOutput
// ---------------------------------------------------------------------------

Deno.test("parseGitGrepOutput - reads `git grep -z` output at a revision", () => {
  const stdout =
    "HEAD:docs/configuration-and-backtesting.md\u0000320\u0000below the strategy's maximum trade fails\n" +
    "HEAD:README.md\u00007\u0000the maximum trade\n";
  assertEquals(parseGitGrepOutput(stdout, "maximum trade"), [
    {
      path: "docs/configuration-and-backtesting.md",
      line: 320,
      text: "below the strategy's maximum trade fails",
      term: "maximum trade",
    },
    {
      path: "README.md",
      line: 7,
      text: "the maximum trade",
      term: "maximum trade",
    },
  ]);
});

Deno.test("parseGitGrepOutput - a malformed line throws rather than being skipped", () => {
  assertThrows(() => parseGitGrepOutput("garbage with no separators\n", "x"));
});

// ---------------------------------------------------------------------------
// parseChangedLines
// ---------------------------------------------------------------------------

Deno.test("parseChangedLines - reads the new-side ranges of each hunk", () => {
  const diff = [
    "diff --git a/docs/a.md b/docs/a.md",
    "index 1..2 100644",
    "--- a/docs/a.md",
    "+++ b/docs/a.md",
    "@@ -10,2 +10,3 @@ heading",
    "-old",
    "+new",
    "@@ -40 +41 @@",
    "-x",
    "+y",
    "@@ -60,2 +61,0 @@",
    "-gone",
    "diff --git a/docs/b.md b/docs/b.md",
    "--- /dev/null",
    "+++ b/docs/b.md",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
    "diff --git a/docs/c.md b/docs/c.md",
    "--- a/docs/c.md",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-deleted",
  ].join("\n");
  const changed = parseChangedLines(diff);
  assertEquals(changed.get("docs/a.md"), [[10, 12], [41, 41]]);
  assertEquals(changed.get("docs/b.md"), [[1, 2]]);
  assertEquals(changed.has("docs/c.md"), false);
});

Deno.test("parseChangedLines - a file whose only change is a deletion is still touched", () => {
  const changed = parseChangedLines(
    "--- a/docs/a.md\n+++ b/docs/a.md\n@@ -5,2 +4,0 @@\n-gone\n-gone\n",
  );
  assertEquals(changed.get("docs/a.md"), []);
});

Deno.test("parseChangedLines - an added line starting with ++ is not read as a file header", () => {
  const changed = parseChangedLines(
    "--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1,0 +2 @@\n+++ not a header\n@@ -9 +10 @@\n",
  );
  assertEquals([...changed.keys()], ["docs/a.md"]);
  assertEquals(changed.get("docs/a.md"), [[2, 2], [10, 10]]);
});

Deno.test("parseChangedLines - a hunk header with no +++ file before it throws", () => {
  assertThrows(() => parseChangedLines("@@ -1 +1 @@\n-x\n+y\n"));
});

// ---------------------------------------------------------------------------
// checkDocsSweepTerms (git stubbed)
// ---------------------------------------------------------------------------

interface StubCall {
  args: string[];
}

/**
 * A git stub: `grep` answers per pattern — the docs pass from `grep`, the
 * source-comment pass (Issue #3219) from `sourceGrep` — and `diff` answers
 * with one patch.
 */
function stubGit(opts: {
  grep?: Record<string, string>;
  sourceGrep?: Record<string, string>;
  grepCode?: number;
  diff?: string;
  diffCode?: number;
  calls?: StubCall[];
}): DocsSweepGitRunner {
  return (args) => {
    opts.calls?.push({ args });
    if (args.includes("grep")) {
      const pattern = args[args.indexOf("-e") + 1]!;
      const answers = args.includes(":(exclude)docs")
        ? opts.sourceGrep
        : opts.grep;
      const stdout = answers?.[pattern] ?? "";
      const code = opts.grepCode ?? (stdout === "" ? 1 : 0);
      return Promise.resolve({ code, stdout, stderr: "" });
    }
    if (args.includes("diff")) {
      return Promise.resolve({
        code: opts.diffCode ?? 0,
        stdout: opts.diff ?? "",
        stderr: "",
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
}

/** The GRQ-AutoTrader#2413 replay: the sweep fixed one section and stopped. */
const REPLAY_2413_RAW = '**Docs sweep** — grep: "maximum trade", `MaxTrade`; ' +
  "section: `docs/configuration-and-backtesting.md#minimum-buy`; " +
  "updated: `docs/configuration-and-backtesting.md`; the remaining hits are " +
  "`docs/replay/2026-08.md:143` and `docs/configuration-and-backtesting.md:218`";

const REPLAY_2413_GREP = [
  "HEAD:docs/configuration-and-backtesting.md\u0000210\u0000the maximum trade is now advisory",
  "HEAD:docs/configuration-and-backtesting.md\u0000218\u0000maximum trade (still true)",
  "HEAD:docs/configuration-and-backtesting.md\u0000320\u0000...below the strategy's maximum trade fails to activate",
  "HEAD:docs/configuration-and-backtesting.md\u0000559\u0000the minimum buy sitting below the maximum trade",
  "HEAD:docs/replay/2026-08.md\u0000143\u0000replayed maximum trade",
  "",
].join("\n");

const REPLAY_2413_DIFF = [
  "diff --git a/docs/configuration-and-backtesting.md b/docs/configuration-and-backtesting.md",
  "--- a/docs/configuration-and-backtesting.md",
  "+++ b/docs/configuration-and-backtesting.md",
  "@@ -205,8 +205,8 @@",
  "",
].join("\n");

Deno.test("checkDocsSweepTerms - replay of GRQ-AutoTrader#2413 returns the two missed lines", async () => {
  const check = await checkDocsSweepTerms({
    rawBody: REPLAY_2413_RAW,
    base: "origin/main",
    runGit: stubGit({
      grep: { "maximum trade": REPLAY_2413_GREP },
      diff: REPLAY_2413_DIFF,
    }),
  });
  assertEquals(check.status, "checked");
  if (check.status !== "checked") return;
  assertEquals(
    check.staleHits.map((h) => `${h.path}:${h.line}`),
    [
      "docs/configuration-and-backtesting.md:320",
      "docs/configuration-and-backtesting.md:559",
    ],
  );
  assertEquals(check.terms, ["maximum trade", "MaxTrade"]);
});

Deno.test("checkDocsSweepTerms - greps the head case-insensitively over README, */README and docs/ minus the archive", async () => {
  const calls: StubCall[] = [];
  await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`",
    base: "origin/main",
    runGit: stubGit({
      calls,
      grep: { Foo: "HEAD:docs/a.md\u00005\u0000Foo\n" },
    }),
  });
  const grep = calls.find((c) => c.args.includes("grep"))!;
  assert(grep.args.includes("-i"), "case-insensitive");
  assert(grep.args.includes("-E"), "extended pattern (escaped literal)");
  assert(grep.args.includes("-z"), "NUL-separated output");
  assert(grep.args.includes("HEAD"), "searches the head revision");
  assertEquals(grep.args.slice(grep.args.indexOf("--") + 1), [
    ...DOCS_SWEEP_PATHSPECS,
  ]);
  assert(DOCS_SWEEP_PATHSPECS.includes(":(exclude)docs/archive"));
  const diff = calls.find((c) => c.args.includes("diff"))!;
  assert(diff.args.includes("origin/main...HEAD"));
  assert(diff.args.includes("--unified=0"));
});

Deno.test("checkDocsSweepTerms - a hit inside a changed hunk is not stale", async () => {
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`",
    base: "main",
    runGit: stubGit({
      grep: { Foo: "HEAD:docs/a.md\u000012\u0000Foo now does X\n" },
      diff: "--- a/docs/a.md\n+++ b/docs/a.md\n@@ -12 +12 @@\n",
    }),
  });
  assertEquals(check.status === "checked" && check.staleHits, []);
});

Deno.test("checkDocsSweepTerms - a hit on a line next to a changed hunk is still stale", async () => {
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`",
    base: "main",
    runGit: stubGit({
      grep: { Foo: "HEAD:docs/a.md\u000013\u0000Foo does the old thing\n" },
      diff: "--- a/docs/a.md\n+++ b/docs/a.md\n@@ -12 +12 @@\n",
    }),
  });
  assertEquals(
    check.status === "checked" && check.staleHits.map((h) => h.line),
    [13],
  );
});

Deno.test("checkDocsSweepTerms - a hit named in a file:start-end range is cleared", async () => {
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`; docs/a.md:12-14 still true",
    base: "main",
    runGit: stubGit({
      grep: { Foo: "HEAD:docs/a.md\u000013\u0000Foo\n" },
    }),
  });
  assertEquals(check.status === "checked" && check.staleHits, []);
});

Deno.test("checkDocsSweepTerms - the same line hit by two terms is reported once", async () => {
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `Foo`, `Bar`; section: `docs/a.md`",
    base: "main",
    runGit: stubGit({
      grep: {
        Foo: "HEAD:docs/a.md\u00005\u0000Foo and Bar\n",
        Bar: "HEAD:docs/a.md\u00005\u0000Foo and Bar\n",
      },
    }),
  });
  assertEquals(check.status === "checked" && check.staleHits.length, 1);
});

Deno.test("checkDocsSweepTerms - a stem term greps the inflected form (GRQ-AutoTrader#2405)", async () => {
  const calls: StubCall[] = [];
  await checkDocsSweepTerms({
    rawBody: "grep: `replac\\w* or remov\\w*`; section: `docs/a.md`",
    base: "main",
    runGit: stubGit({ calls }),
  });
  const grep = calls.find((c) => c.args.includes("grep"))!;
  assertEquals(
    grep.args[grep.args.indexOf("-e") + 1],
    "replac[[:alnum:]_]* or remov[[:alnum:]_]*",
  );
});

/** `count` grep hits of `term`, one per line of `path`. */
function grepLines(path: string, term: string, count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `HEAD:${path}\u0000${i + 1}\u0000${term} line ${i + 1}\n`,
  ).join("");
}

Deno.test("checkDocsSweepTerms - a broad term's untouched-file hits are set aside, its touched-file hits are not", async () => {
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `refused`; section: `docs/a.md`",
    base: "main",
    runGit: stubGit({
      grep: {
        refused: grepLines("docs/other.md", "refused", 11) +
          "HEAD:docs/a.md\u000050\u0000every Remove is refused\n",
      },
      diff: "--- a/docs/a.md\n+++ b/docs/a.md\n@@ -3 +3 @@\n",
    }),
  });
  assertEquals(check.status, "checked");
  if (check.status !== "checked") return;
  assertEquals(check.broadTerms, ["refused"]);
  assertEquals(check.staleHits.map((h) => `${h.path}:${h.line}`), [
    "docs/a.md:50",
  ]);
});

Deno.test("checkDocsSweepTerms - a term at the broad-term limit is still listed line by line", async () => {
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`",
    base: "main",
    runGit: stubGit({
      grep: {
        Foo: grepLines("docs/other.md", "Foo", MAX_UNTOUCHED_HITS_PER_TERM),
      },
    }),
  });
  assertEquals(check.status, "checked");
  if (check.status !== "checked") return;
  assertEquals(check.broadTerms, []);
  assertEquals(check.staleHits.length, MAX_UNTOUCHED_HITS_PER_TERM);
});

Deno.test("checkDocsSweepTerms - no hit at all never reads the diff", async () => {
  const calls: StubCall[] = [];
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`",
    base: "main",
    runGit: stubGit({ calls }),
  });
  assertEquals(check.status === "checked" && check.staleHits, []);
  assertEquals(calls.some((c) => c.args.includes("diff")), false);
});

Deno.test("checkDocsSweepTerms - no grep terms is skipped, and git is never run", async () => {
  const calls: StubCall[] = [];
  const check = await checkDocsSweepTerms({
    rawBody: "section: `docs/a.md`; no hits",
    base: "main",
    runGit: stubGit({ calls }),
  });
  assertEquals(check.status, "skipped");
  assertEquals(calls.length, 0);
});

Deno.test("checkDocsSweepTerms - a git grep error is not_checked, never a clean pass", async () => {
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`",
    base: "main",
    runGit: stubGit({ grepCode: 128 }),
  });
  assertEquals(check.status, "not_checked");
  assertStringIncludes(
    check.status === "not_checked" ? check.reason : "",
    "grep",
  );
});

Deno.test("checkDocsSweepTerms - an unreadable diff is not_checked", async () => {
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`",
    base: "main",
    runGit: stubGit({
      grep: { Foo: "HEAD:docs/a.md\u00005\u0000Foo\n" },
      diffCode: 128,
    }),
  });
  assertEquals(check.status, "not_checked");
});

Deno.test("checkDocsSweepTerms - a thrown git spawn is not_checked", async () => {
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`",
    base: "main",
    runGit: () => Promise.reject(new Error("spawn failed")),
  });
  assertEquals(check.status, "not_checked");
});

Deno.test("checkDocsSweepTerms - malformed grep output is not_checked", async () => {
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`",
    base: "main",
    runGit: stubGit({ grep: { Foo: "no separators here\n" } }),
  });
  assertEquals(check.status, "not_checked");
});

// ---------------------------------------------------------------------------
// Source doc comments outside the diff (Issue #3219)
// ---------------------------------------------------------------------------

Deno.test("isSourceCommentLine - reads line, block, doc and hash comments as comments", () => {
  for (
    const line of [
      "// the park is re-recorded",
      "  /// helper shared by both callers",
      "//! module doc",
      "/** Marker posted when a PR is parked */",
      " * the gated-head and park waits both write one",
      " */",
      "# shared by the two callers",
      "#",
    ]
  ) {
    assert(isSourceCommentLine(line), `expected a comment: ${line}`);
  }
});

Deno.test("isSourceCommentLine - code, strings, attributes and directives are not comments", () => {
  for (
    const line of [
      'export const CONFLICT_PARKED_MARKER = "<!-- parked -->";',
      "  const total = a * b; // trailing note",
      "#[derive(Debug)]",
      "#!/usr/bin/env bash",
      "#include <stdio.h>",
      "*ptr = 0;",
      "",
    ]
  ) {
    assertEquals(isSourceCommentLine(line), false, line);
  }
});

Deno.test("checkDocsSweepTerms - greps source files outside docs/ for comment lines (Issue #3219)", async () => {
  const calls: StubCall[] = [];
  await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`",
    base: "main",
    runGit: stubGit({ calls }),
  });
  const greps = calls.filter((c) => c.args.includes("grep"));
  assertEquals(greps.length, 2, "one docs pass and one source pass per term");
  const source = greps[1]!;
  assertEquals(source.args.slice(source.args.indexOf("--") + 1), [
    ...SOURCE_COMMENT_PATHSPECS,
  ]);
  assert(SOURCE_COMMENT_PATHSPECS.includes("*.ts"));
  assert(SOURCE_COMMENT_PATHSPECS.includes("*.rs"));
  assert(SOURCE_COMMENT_PATHSPECS.includes(":(exclude)docs"));
  assert(source.args.includes("HEAD") && source.args.includes("-i"));
});

/** The VibeCoder#3215 replay: the park marker's writer went, its docs stayed. */
const REPLAY_3215_SOURCE_GREP = [
  "HEAD:worker/deno/lib/merge_conflict_markers.ts\u0000220\u0000 * Marker posted when a PR is parked after the second restart.",
  'HEAD:worker/deno/lib/merge_conflict_markers.ts\u0000234\u0000export const CONFLICT_PARKED_MARKER = "<!-- vibe-parked -->";',
  "HEAD:worker/deno/lib/merge_conflict_markers.ts\u0000307\u0000 * the park is re-recorded on the next restart.",
  "HEAD:worker/deno/lib/merge_conflict_stall_watchdog.ts\u000017\u0000// the gated-head and park waits both write one",
  "HEAD:worker/deno/lib/merge_conflict_restart.ts\u000040\u0000// park the PR (removed): no longer written",
  "",
].join("\n");

Deno.test("checkDocsSweepTerms - replay of VibeCoder#3215: a stale doc comment in an untouched source file blocks", async () => {
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `park`; section: `docs/workflows/merge-conflicts.md`",
    base: "origin/main",
    runGit: stubGit({
      sourceGrep: { park: REPLAY_3215_SOURCE_GREP },
      diff: [
        "--- a/worker/deno/lib/merge_conflict_restart.ts",
        "+++ b/worker/deno/lib/merge_conflict_restart.ts",
        "@@ -38,9 +38,3 @@",
        "",
      ].join("\n"),
    }),
  });
  assertEquals(check.status, "checked");
  if (check.status !== "checked") return;
  assertEquals(
    check.staleHits.map((h) => `${h.path}:${h.line}`),
    [
      "worker/deno/lib/merge_conflict_markers.ts:220",
      "worker/deno/lib/merge_conflict_markers.ts:307",
      "worker/deno/lib/merge_conflict_stall_watchdog.ts:17",
    ],
    "code lines are not read; the diff's own changed comment is cleared",
  );
});

Deno.test("checkDocsSweepTerms - a source comment named as file:line still true is cleared", async () => {
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`; " +
      "`lib/a.ts:7` — still true because Foo stays",
    base: "main",
    runGit: stubGit({
      sourceGrep: { Foo: "HEAD:lib/a.ts\u00007\u0000// Foo does X\n" },
    }),
  });
  assertEquals(check.status === "checked" && check.staleHits, []);
});

Deno.test("checkDocsSweepTerms - the broad-term cap counts source comments apart from docs", async () => {
  const comments = Array.from(
    { length: MAX_UNTOUCHED_HITS_PER_TERM + 1 },
    (_, i) => `HEAD:lib/m${i}.ts\u00001\u0000// Foo note ${i}\n`,
  ).join("");
  const check = await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`",
    base: "main",
    runGit: stubGit({
      grep: { Foo: "HEAD:docs/a.md\u00005\u0000Foo does the old thing\n" },
      sourceGrep: { Foo: comments },
    }),
  });
  assertEquals(check.status, "checked");
  if (check.status !== "checked") return;
  assertEquals(check.broadTerms, ["Foo"]);
  assertEquals(
    check.staleHits.map((h) => `${h.path}:${h.line}`),
    ["docs/a.md:5"],
    "the docs hit is still listed when the term is broad only in source",
  );
});

Deno.test("checkDocsSweepTerms - the diff spans source files as well as docs", async () => {
  const calls: StubCall[] = [];
  await checkDocsSweepTerms({
    rawBody: "grep: `Foo`; section: `docs/a.md`",
    base: "main",
    runGit: stubGit({
      calls,
      sourceGrep: { Foo: "HEAD:lib/a.ts\u00001\u0000// Foo\n" },
    }),
  });
  const diff = calls.find((c) => c.args.includes("diff"))!;
  const pathspecs = diff.args.slice(diff.args.indexOf("--") + 1);
  for (const spec of ["docs", "README.md", "*.ts", ":(exclude)docs/archive"]) {
    assert(pathspecs.includes(spec), `diff pathspecs miss ${spec}`);
  }
  assertEquals(pathspecs.includes(":(exclude)docs"), false);
});

Deno.test("buildDocsSweepHitsComment - names source comment lines as part of the re-run", () => {
  const comment = buildDocsSweepHitsComment([
    { path: "lib/a.ts", line: 3, text: "// Foo", term: "Foo" },
  ]);
  assertStringIncludes(comment, "comment lines in source files");
});

// ---------------------------------------------------------------------------
// buildDocsSweepHitsComment
// ---------------------------------------------------------------------------

Deno.test("buildDocsSweepHitsComment - lists each file:line with its sentence, advisory only (Issue #3237)", () => {
  const comment = buildDocsSweepHitsComment([
    {
      path: "docs/a.md",
      line: 320,
      text: "below the maximum trade fails",
      term: "maximum trade",
    },
  ]);
  assertStringIncludes(comment, "`docs/a.md:320`");
  assertStringIncludes(comment, "below the maximum trade fails");
  assertStringIncludes(comment, "maximum trade");
  assertStringIncludes(comment, "still true because");
  assertStringIncludes(comment, "does not block the PR");
  assertEquals(comment.includes("fails the run"), false);
});

Deno.test("buildDocsSweepHitsComment - caps the list and says how many more", () => {
  const hits = Array.from({ length: MAX_REPORTED_HITS + 3 }, (_, i) => ({
    path: "docs/a.md",
    line: i + 1,
    text: "Foo",
    term: "Foo",
  }));
  const comment = buildDocsSweepHitsComment(hits);
  assertStringIncludes(comment, "and 3 more");
  assertEquals(
    comment.includes(`docs/a.md:${MAX_REPORTED_HITS + 1}\``),
    false,
  );
});

Deno.test("buildDocsSweepHitsComment - a sentence with backticks cannot break out of its code span", () => {
  const comment = buildDocsSweepHitsComment([
    { path: "docs/a.md", line: 1, text: "use `Foo` here", term: "Foo" },
  ]);
  assertStringIncludes(comment, "use Foo here");
});

// ---------------------------------------------------------------------------
// checkDocsSweepTerms against a real repository (the production git runner)
// ---------------------------------------------------------------------------

/** Run git in `cwd` with a fixed identity, failing the test on error. */
async function realGit(cwd: string, args: string[]): Promise<void> {
  const out = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=docs-sweep-test",
      "-c",
      "user.email=docs-sweep-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
}

Deno.test("checkDocsSweepTerms - real git: finds the missed line and the inflected form, clears edited and archived ones", async () => {
  const repo = await Deno.makeTempDir();
  try {
    await realGit(repo, ["init", "-q", "-b", "main"]);
    await Deno.mkdir(`${repo}/docs/archive`, { recursive: true });
    await Deno.mkdir(`${repo}/web`, { recursive: true });
    const manual = [
      "# Manual",
      "",
      "The maximum trade check refuses a buy.",
      "",
      "Every Remove is refused by the guard.",
      "",
      "Later: below the Maximum Trade fails to activate.",
    ];
    await Deno.writeTextFile(`${repo}/docs/manual.md`, manual.join("\n"));
    await Deno.writeTextFile(
      `${repo}/docs/archive/old.md`,
      "maximum trade in history\n",
    );
    await Deno.writeTextFile(
      `${repo}/web/README.md`,
      "Entries are replaced or removed by the guard.\n",
    );
    await Deno.writeTextFile(`${repo}/code.rs`, "fn main() {}\n");
    await Deno.writeTextFile(
      `${repo}/web/helper.ts`,
      "// Caps the maximum trade per buy.\nconst maximumTrade = 1; // maximum trade\n",
    );
    await realGit(repo, ["add", "-A"]);
    await realGit(repo, ["commit", "-q", "-m", "base"]);
    await realGit(repo, ["checkout", "-q", "-b", "feature"]);
    manual[2] = "The maximum trade is now advisory.";
    await Deno.writeTextFile(`${repo}/docs/manual.md`, manual.join("\n"));
    await Deno.writeTextFile(`${repo}/code.rs`, "fn main() { () }\n");
    await realGit(repo, ["commit", "-q", "-am", "change"]);

    const check = await checkDocsSweepTerms({
      rawBody: '**Docs sweep** — grep: "maximum trade", ' +
        "`replac\\w* or remov\\w*`; section: `docs/manual.md#manual`; " +
        "updated: `docs/manual.md`",
      base: "main",
      runGit: async (args) => {
        const result = await runGitCommand(args, { cwd: repo });
        if (!result.ok) throw result.error;
        return result.value;
      },
    });

    assertEquals(check.status, "checked");
    assertEquals(
      check.status === "checked" &&
        check.staleHits.map((h) => `${h.path}:${h.line}`).sort(),
      ["docs/manual.md:7", "web/README.md:1", "web/helper.ts:1"],
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});
