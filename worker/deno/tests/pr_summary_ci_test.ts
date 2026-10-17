/**
 * Tests for the PR-summary freshness and CI gate (Issue #3768).
 *
 * The pure cases exercise the judgement directly. The integration cases build
 * a real remote and clone with the git fixture and drive the CLI entry with
 * the real git runner.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { GitRunner } from "../lib/git_base_ref.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import {
  ciFailed,
  type CommitChange,
  formatCiReport,
  isCodePath,
  judgeFreshness,
  type PrSummaryCiResult,
  selectSummary,
  summaryIssueOf,
} from "../lib/pr_summary_ci.ts";
import { type CliDeps, main, parseArgs } from "../lib/pr_summary_ci_cli.ts";
import {
  commitFile,
  gitOk,
  setupGitRepoFixture,
} from "./support/git_repo_fixture.ts";

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-42.md";
const FACTS_PATH = "docs/archive/pr-summaries/pr-summary-42.facts.json";
const CODE_FILE = "worker/deno/lib/foo.ts";
const BRANCH = "issue-42-foo";

/** A summary that passes the Docs sweep and Branch outcomes gates. */
const GOOD_SUMMARY = [
  "## Summary",
  "",
  "Adds foo handling.",
  "",
  "**Docs sweep** — grep: `foo`; section: none — no manual documents it; siblings: none — no existing set gained a member",
  "",
  "**Branch outcomes:** none added",
  "",
].join("\n");

const NO_DOCS_SWEEP = GOOD_SUMMARY.split("\n").filter((line) =>
  !line.includes("Docs sweep")
).join("\n");

// --- Pure: classification ---------------------------------------------------

Deno.test("isCodePath - worker, prompts and .claude paths are code; docs and look-alikes are not", () => {
  assert(isCodePath("worker/x"));
  assert(isCodePath("prompts/x/prompt.md"));
  assert(isCodePath(".claude/agents/x.md"));
  assert(!isCodePath("docs/x"));
  assert(!isCodePath("worker.md"));
  assert(!isCodePath("docs/worker/x"));
});

Deno.test("summaryIssueOf - reads the issue from the summary and facts names only", () => {
  assertEquals(summaryIssueOf(SUMMARY_PATH), 42);
  assertEquals(summaryIssueOf(FACTS_PATH), 42);
  assertEquals(summaryIssueOf(`${SUMMARY_PATH}.bak`), null);
  assertEquals(
    summaryIssueOf("docs/archive/pr-summaries/pr-summary-012.md"),
    null,
  );
  assertEquals(
    summaryIssueOf("docs/archive/pr-summaries/pr-summary-.md"),
    null,
  );
  assertEquals(summaryIssueOf("docs/other/pr-summary-42.md"), null);
  assertEquals(summaryIssueOf("pr-summary-42.md"), null);
});

// --- Pure: freshness ----------------------------------------------------------

Deno.test("judgeFreshness - code newer than the summary is stale and names the summary commit", () => {
  const commits: CommitChange[] = [
    { sha: "c2", files: [CODE_FILE] },
    { sha: "s1", files: [SUMMARY_PATH] },
    { sha: "c1", files: ["worker/deno/lib/bar.ts"] },
  ];
  assertEquals(judgeFreshness(commits, 42), {
    kind: "stale",
    codeCommit: "c2",
    codeFiles: [CODE_FILE],
    summaryCommit: "s1",
  });
});

Deno.test("judgeFreshness - code newer with no summary commit is stale with a null summary commit", () => {
  const commits: CommitChange[] = [
    { sha: "c2", files: [CODE_FILE, "docs/x.md"] },
    { sha: "c1", files: ["prompts/p/prompt.md"] },
  ];
  assertEquals(judgeFreshness(commits, 42), {
    kind: "stale",
    codeCommit: "c2",
    codeFiles: [CODE_FILE],
    summaryCommit: null,
  });
});

Deno.test("judgeFreshness - summary newer than the code is fresh", () => {
  const commits: CommitChange[] = [
    { sha: "s2", files: [SUMMARY_PATH] },
    { sha: "c1", files: [CODE_FILE] },
  ];
  assertEquals(judgeFreshness(commits, 42), {
    kind: "fresh",
    summaryCommit: "s2",
  });
});

Deno.test("judgeFreshness - a commit touching both code and summary counts as fresh", () => {
  const commits: CommitChange[] = [
    { sha: "sc", files: [SUMMARY_PATH, CODE_FILE] },
    { sha: "c1", files: ["worker/deno/lib/bar.ts"] },
  ];
  assertEquals(judgeFreshness(commits, 42), {
    kind: "fresh",
    summaryCommit: "sc",
  });
});

Deno.test("judgeFreshness - a facts-only commit counts as a summary commit", () => {
  const commits: CommitChange[] = [
    { sha: "f1", files: [FACTS_PATH] },
    { sha: "c1", files: [CODE_FILE] },
  ];
  assertEquals(judgeFreshness(commits, 42), {
    kind: "fresh",
    summaryCommit: "f1",
  });
});

Deno.test("judgeFreshness - no code commit is no_code_change", () => {
  const commits: CommitChange[] = [{ sha: "d1", files: ["docs/x.md"] }];
  assertEquals(judgeFreshness(commits, 42), { kind: "no_code_change" });
  assertEquals(judgeFreshness([], 42), { kind: "no_code_change" });
});

// --- Pure: summary selection --------------------------------------------------

Deno.test("selectSummary - no summary in the diff is none", () => {
  assertEquals(selectSummary([CODE_FILE], BRANCH), { kind: "none" });
});

Deno.test("selectSummary - the head branch's own summary is selected", () => {
  assertEquals(selectSummary([CODE_FILE, SUMMARY_PATH], BRANCH), {
    kind: "selected",
    issueNumber: 42,
  });
});

Deno.test("selectSummary - an issue branch carrying only another issue's summary is not checked", () => {
  const s = selectSummary(
    [CODE_FILE, "docs/archive/pr-summaries/pr-summary-7.md"],
    BRANCH,
  );
  assert(s.kind === "not_checked");
  assertStringIncludes(s.reason, BRANCH);
  assertStringIncludes(s.reason, "#7");
});

Deno.test("selectSummary - a non-issue branch carrying a summary is not checked", () => {
  const s = selectSummary([SUMMARY_PATH], "milestone/foo");
  assert(s.kind === "not_checked");
  assertStringIncludes(s.reason, "milestone/foo");
  assertStringIncludes(s.reason, "#42");
});

// --- Pure: CLI arguments ------------------------------------------------------

Deno.test("parseArgs - accepts --base and --head-branch", () => {
  const r = parseArgs(["--base", "main", "--head-branch", BRANCH]);
  assert(r.ok);
  assertEquals(r.value, { baseBranch: "main", headBranch: BRANCH });
});

Deno.test("parseArgs - rejects a missing flag, unknown flag, positional, and valueless or flag-like value", () => {
  assert(!parseArgs(["--head-branch", BRANCH]).ok);
  assert(!parseArgs(["--base", "main"]).ok);
  assert(!parseArgs(["--base", "main", "--head-branch", BRANCH, "--nope"]).ok);
  assert(!parseArgs(["--base", "main", "--head-branch", BRANCH, "stray"]).ok);
  assert(!parseArgs(["--base", "main", "--head-branch"]).ok);
  assert(!parseArgs(["--base", "--head-branch", BRANCH]).ok);
});

/** Deps for `main`, recording stdout and stderr. */
function captureDeps(runGit: GitRunner = runGitCommand): {
  out: string[];
  err: string[];
  deps: CliDeps;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      readTextFile: (path: string) => Deno.readTextFile(path),
      runGit,
      repoRoot: () => Promise.resolve({ ok: true as const, value: "/repo" }),
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    },
  };
}

Deno.test("main - bad arguments exit 2 and never reach git", async () => {
  const d = captureDeps(() => Promise.reject(new Error("git must not run")));
  assertEquals(await main(["--base", "main"], d.deps), 2);
  assertStringIncludes(d.err.join("\n"), "--head-branch is required");
  assertEquals(d.out.length, 0);
});

// --- Pure: CI verdict -----------------------------------------------------------

Deno.test("ciFailed - stale, missing and blocked fail; fresh, unchecked and not-checked do not", () => {
  const checked = (
    overrides: Partial<Extract<PrSummaryCiResult, { kind: "checked" }>>,
  ): PrSummaryCiResult => ({
    kind: "checked",
    issueNumber: 42,
    summaryPath: SUMMARY_PATH,
    freshness: { kind: "fresh", summaryCommit: "s1" },
    missingSummary: false,
    gates: [],
    ...overrides,
  });
  const blocked = {
    gate: "Docs sweep",
    issueRef: "#3073",
    status: "blocked" as const,
    problems: ["no Docs sweep line"],
  };

  assert(ciFailed(checked({
    freshness: {
      kind: "stale",
      codeCommit: "c2",
      codeFiles: [CODE_FILE],
      summaryCommit: null,
    },
  })));
  assert(ciFailed(checked({ freshness: null, missingSummary: true })));
  assert(ciFailed(checked({ gates: [blocked] })));
  assert(!ciFailed(checked({})));
  assert(!ciFailed(checked({ freshness: { kind: "no_code_change" } })));
  assert(!ciFailed({ kind: "no_summary" }));
  assert(!ciFailed({ kind: "not_checked", reason: "not an issue branch" }));
});

// --- Pure: report text --------------------------------------------------------

Deno.test("formatCiReport - a control character in a code path cannot start a new log line", () => {
  const result: PrSummaryCiResult = {
    kind: "checked",
    issueNumber: 42,
    summaryPath: SUMMARY_PATH,
    freshness: {
      kind: "stale",
      codeCommit: "c2",
      codeFiles: ["worker/a\n::error::x"],
      summaryCommit: null,
    },
    missingSummary: false,
    gates: [],
  };
  const text = formatCiReport(result);
  assert(!text.includes("\n::error"));
  assertStringIncludes(text, "worker/a\\u000a::error::x");
  assertStringIncludes(text, "[BLOCKED] Summary freshness");
});

// --- Integration: a real remote and clone -------------------------------------

/** Run `body` against a fresh remote and clone, removing them afterwards. */
async function withRepo(body: (clone: string) => Promise<void>): Promise<void> {
  const fixture = await setupGitRepoFixture("issue-3768-pr-summary-ci-");
  try {
    await body(fixture.clone);
  } finally {
    await fixture.cleanup();
  }
}

/** Create the branch and switch to it. */
async function startBranch(clone: string, branch: string): Promise<void> {
  await gitOk(["checkout", "-b", branch], clone);
}

/** Commit a code change under worker/; returns its SHA. */
async function commitCode(clone: string, contents: string): Promise<string> {
  await Deno.mkdir(`${clone}/worker/deno/lib`, { recursive: true });
  return await commitFile(clone, CODE_FILE, contents, "code change");
}

/** Commit the issue-42 summary; returns its SHA. */
async function commitSummary(
  clone: string,
  contents: string = GOOD_SUMMARY,
): Promise<string> {
  await Deno.mkdir(`${clone}/docs/archive/pr-summaries`, { recursive: true });
  return await commitFile(clone, SUMMARY_PATH, contents, "summary");
}

/** Run the CLI against the clone with the real git runner. */
async function runCi(clone: string, branch: string, base = "main") {
  const d = captureDeps();
  d.deps.repoRoot = () => Promise.resolve({ ok: true as const, value: clone });
  const code = await main(
    ["--base", base, "--head-branch", branch],
    d.deps,
  );
  return { code, stdout: d.out.join("\n"), stderr: d.err.join("\n") };
}

Deno.test("pr-summary-ci - a code commit newer than the summary blocks, naming that commit", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");
    await commitSummary(clone);
    const codeSha = await commitCode(clone, "export const a = 2;\n");

    const r = await runCi(clone, BRANCH);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stdout, "[BLOCKED] Summary freshness");
    assertStringIncludes(r.stdout, codeSha);
  });
});

Deno.test("pr-summary-ci - a summary commit newer than the code passes freshness", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");
    await commitSummary(clone);

    const r = await runCi(clone, BRANCH);
    assertEquals(r.code, 0);
    assertStringIncludes(r.stdout, "[PASSED] Summary freshness");
    assertStringIncludes(r.stdout, "[NOT_CHECKED] Acceptance-criteria closure");
    assert(!r.stdout.includes("[PASSED] Acceptance-criteria closure"));
  });
});

Deno.test("pr-summary-ci - base-only merge commits are ignored, so a fresh summary still passes", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");
    await commitSummary(clone);

    // The base moves on with a code change, and the branch merges it in.
    await gitOk(["checkout", "main"], clone);
    await Deno.mkdir(`${clone}/worker/deno/lib`, { recursive: true });
    await commitFile(
      clone,
      "worker/deno/lib/base.ts",
      "export const base = 1;\n",
      "base change",
    );
    await gitOk(["push", "origin", "main"], clone);
    await gitOk(["checkout", BRANCH], clone);
    await gitOk(["fetch", "origin"], clone);
    // The merge also carries an edit of its own under worker/, so it is not a
    // bare merge; the base's commits must still not count against the summary.
    await gitOk(["merge", "--no-ff", "--no-commit", "origin/main"], clone);
    await Deno.mkdir(`${clone}/worker/deno/lib`, { recursive: true });
    await commitFile(
      clone,
      "worker/deno/lib/merged.ts",
      "export const m = 1;\n",
      "merge main",
    );

    const r = await runCi(clone, BRANCH);
    assertEquals(r.code, 0);
    assertStringIncludes(r.stdout, "[PASSED] Summary freshness");
  });
});

Deno.test("pr-summary-ci - a branch with only code changes and no summary is no summary", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");

    const r = await runCi(clone, BRANCH);
    assertEquals(r.code, 0);
    assertStringIncludes(r.stdout, "[NO SUMMARY]");
  });
});

Deno.test("pr-summary-ci - a blocked gate fails even when the summary is fresh", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");
    await commitSummary(clone, NO_DOCS_SWEEP);

    const r = await runCi(clone, BRANCH);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stdout, "[PASSED] Summary freshness");
    assertStringIncludes(r.stdout, "[BLOCKED] Docs sweep");
  });
});

Deno.test("pr-summary-ci - a non-issue head branch carrying a summary is not checked and exits 0", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, "milestone/foo");
    await commitCode(clone, "export const a = 1;\n");
    await commitSummary(clone);

    const r = await runCi(clone, "milestone/foo");
    assertEquals(r.code, 0);
    assertStringIncludes(r.stdout, "[NOT CHECKED] PR summary (#3768)");
  });
});

Deno.test("pr-summary-ci - an unresolvable base exits 2", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");
    await commitSummary(clone);

    const r = await runCi(clone, BRANCH, "nope");
    assertEquals(r.code, 2);
    assertStringIncludes(r.stderr, "not resolvable");
    assertEquals(r.stdout, "");
  });
});
