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
  listPrCommits,
  type PrSummaryCiResult,
  runPrSummaryCi,
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

Deno.test("summaryIssueOf - a number beyond the safe integer range is null", () => {
  assertEquals(
    summaryIssueOf(
      "docs/archive/pr-summaries/pr-summary-12345678901234567890.md",
    ),
    null,
  );
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
  assert(ciFailed(checked({ freshness: { kind: "summary_missing" } })));
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
    const summarySha = await commitSummary(clone);

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
    // The note must name the summary commit, not the merge: a merge that
    // brought the base in must never be taken for the summary's own commit.
    assertStringIncludes(r.stdout, `changed in commit ${summarySha}`);
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

/**
 * Commit `file` with fixed author and committer dates, so a commit can be
 * dated older than its parent; returns its SHA.
 */
async function commitFileDated(
  clone: string,
  file: string,
  contents: string,
  isoDate: string,
): Promise<string> {
  const dir = file.slice(0, file.lastIndexOf("/"));
  await Deno.mkdir(`${clone}/${dir}`, { recursive: true });
  await Deno.writeTextFile(`${clone}/${file}`, contents);
  await gitOk(["add", file], clone);
  const out = await new Deno.Command("git", {
    args: ["commit", "-m", "dated change"],
    cwd: clone,
    env: { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `dated commit failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return (await gitOk(["rev-parse", "HEAD"], clone)).trim();
}

Deno.test("pr-summary-ci - a code commit that is a child of the summary but dated earlier is still stale", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    // S: the summary, dated 2021. C: its child with the code change, dated
    // 2020, so C is older than S by date.
    const summarySha = await commitFileDated(
      clone,
      SUMMARY_PATH,
      GOOD_SUMMARY,
      "2021-01-02T00:00:00Z",
    );
    const codeSha = await commitFileDated(
      clone,
      CODE_FILE,
      "export const a = 2;\n",
      "2020-01-01T00:00:00Z",
    );
    // X: a second child of the summary on a side branch, dated now, merged
    // in as M. Only a merge leaves two commits queued at once, so only there
    // does the commit-date order differ from the parent-child order.
    await gitOk(["checkout", "-b", "side-x", summarySha], clone);
    const sideSha = await commitFileDated(
      clone,
      "docs/side.md",
      "side\n",
      new Date().toISOString(),
    );
    await gitOk(["checkout", BRANCH], clone);
    await gitOk(["merge", "--no-ff", "-m", "merge side", sideSha], clone);

    const r = await runCi(clone, BRANCH);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stdout, "[BLOCKED] Summary freshness");
    assertStringIncludes(r.stdout, codeSha);
  });
});

Deno.test("pr-summary-ci - a branch changing only the facts file, with no summary, is blocked", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");
    await Deno.mkdir(`${clone}/docs/archive/pr-summaries`, { recursive: true });
    await commitFile(clone, FACTS_PATH, "{}\n", "facts only");

    const r = await runCi(clone, BRANCH);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stdout, "[BLOCKED] Summary freshness");
    assertStringIncludes(
      r.stdout,
      `the facts file ${FACTS_PATH} is on the branch but the summary ${SUMMARY_PATH} is not`,
    );
  });
});

// --- Branch-outcome coverage: report escaping and counting -------------------

Deno.test("formatCiReport - a DEL character in a code path is escaped, not printed raw", () => {
  const text = formatCiReport({
    kind: "checked",
    issueNumber: 42,
    summaryPath: SUMMARY_PATH,
    freshness: {
      kind: "stale",
      codeCommit: "c2",
      codeFiles: ["worker/a\x7fb"],
      summaryCommit: null,
    },
    gates: [],
  });
  assertStringIncludes(text, "worker/a\\u007fb");
  assert(!text.includes("\x7f"));
});

Deno.test("formatCiReport - a stale result lists five code paths and counts the rest", () => {
  const codeFiles = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"].map((n) =>
    `worker/${n}.ts`
  );
  const text = formatCiReport({
    kind: "checked",
    issueNumber: 42,
    summaryPath: SUMMARY_PATH,
    freshness: {
      kind: "stale",
      codeCommit: "c2",
      codeFiles,
      summaryCommit: null,
    },
    gates: [],
  });
  assertStringIncludes(
    text,
    "worker/f1.ts, worker/f2.ts, worker/f3.ts, worker/f4.ts, worker/f5.ts and 2 more",
  );
  assert(!text.includes("worker/f6.ts"));
});

// --- Branch-outcome coverage: git runner failures ----------------------------

Deno.test("listPrCommits - a runner error names the git command and its cause", async () => {
  const runGit: GitRunner = () =>
    Promise.resolve({ ok: false as const, error: new Error("spawn failed") });
  const r = await listPrCommits(runGit, "origin/main", "/repo");
  assert(!r.ok);
  assertStringIncludes(r.error.message, "git rev-list");
  assertStringIncludes(r.error.message, "spawn failed");
});

Deno.test("listPrCommits - a non-zero diff-tree exit names the exit code and git's stderr", async () => {
  const runGit: GitRunner = (args) =>
    Promise.resolve(
      args[0] === "rev-list"
        ? {
          ok: true as const,
          value: { code: 0, stdout: "deadbeef\n", stderr: "" },
        }
        : {
          ok: true as const,
          value: {
            code: 128,
            stdout: "",
            stderr: "fatal: bad object deadbeef\n",
          },
        },
    );
  const r = await listPrCommits(runGit, "origin/main", "/repo");
  assert(!r.ok);
  assertStringIncludes(r.error.message, "exited 128");
  assertStringIncludes(r.error.message, "fatal: bad object deadbeef");
});

// --- Branch-outcome coverage: summary read and repository root ---------------

Deno.test("runPrSummaryCi - an unreadable summary, other than missing, is an error", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");
    await commitSummary(clone);

    const r = await runPrSummaryCi({
      baseBranch: "main",
      headBranch: BRANCH,
      runGit: runGitCommand,
      repoRoot: clone,
      readTextFile: () =>
        Promise.reject(new Deno.errors.PermissionDenied("denied")),
    });
    assert(!r.ok);
    assertStringIncludes(r.error.message, "Failed to read PR summary");
    assertStringIncludes(r.error.message, "denied");
  });
});

Deno.test("main - an unreadable repository root exits 2 and names the cause", async () => {
  const d = captureDeps(() => Promise.reject(new Error("git must not run")));
  d.deps.repoRoot = () =>
    Promise.resolve({
      ok: false as const,
      error: new Error("not a git repository"),
    });
  assertEquals(
    await main(["--base", "main", "--head-branch", BRANCH], d.deps),
    2,
  );
  assertStringIncludes(d.err.join("\n"), "not a git repository");
  assertEquals(d.out.length, 0);
});

// --- Branch-outcome coverage: git failures reached through runPrSummaryCi ----

/**
 * The real git runner, except that the `nth` call of `subcommand` fails with
 * exit 128. Also returns a count of the calls seen for that subcommand.
 */
function failNthGitCall(
  subcommand: string,
  nth: number,
): { runGit: GitRunner; seen: () => number } {
  let seen = 0;
  const runGit: GitRunner = (args, options) => {
    if (args[0] === subcommand) {
      seen++;
      if (seen === nth) {
        return Promise.resolve({
          ok: true as const,
          value: {
            code: 128,
            stdout: "",
            stderr: "fatal: simulated diff failure\n",
          },
        });
      }
    }
    return runGitCommand(args, options);
  };
  return { runGit, seen: () => seen };
}

Deno.test("runPrSummaryCi - a git failure inside the PR-summary gates is returned as an error", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");
    await commitSummary(clone);

    // The first diff is runPrSummaryCi's own; the second is the gates'.
    const git = failNthGitCall("diff", 2);
    const r = await runPrSummaryCi({
      baseBranch: "main",
      headBranch: BRANCH,
      runGit: git.runGit,
      repoRoot: clone,
      readTextFile: (path) => Deno.readTextFile(path),
    });
    assertEquals(git.seen(), 2);
    assert(!r.ok);
    assertStringIncludes(
      r.error.message,
      "git diff exited 128: fatal: simulated diff failure",
    );
  });
});

Deno.test("runPrSummaryCi - a git failure while listing the PR's commits is returned as an error", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");
    await commitSummary(clone);

    const git = failNthGitCall("diff-tree", 1);
    const r = await runPrSummaryCi({
      baseBranch: "main",
      headBranch: BRANCH,
      runGit: git.runGit,
      repoRoot: clone,
      readTextFile: (path) => Deno.readTextFile(path),
    });
    assertEquals(git.seen(), 1);
    assert(!r.ok);
    assertStringIncludes(r.error.message, "git diff-tree");
    assertStringIncludes(r.error.message, "simulated diff failure");
  });
});

Deno.test("parseArgs - an empty --base value is a missing value", () => {
  const r = parseArgs(["--base", "", "--head-branch", BRANCH]);
  assert(!r.ok);
  assertStringIncludes(r.error.message, "--base needs a value");
});

Deno.test("parseArgs - a --head-branch value that looks like a flag is a missing value", () => {
  const r = parseArgs(["--base", "main", "--head-branch", "-x"]);
  assert(!r.ok);
  assertStringIncludes(r.error.message, "--head-branch needs a value");
});
