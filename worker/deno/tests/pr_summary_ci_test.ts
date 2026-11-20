/**
 * Tests for the PR-summary CI gate (Issue #3768). Issue #5227 retired the
 * commit-order freshness check.
 *
 * The pure cases exercise summary selection, argument parsing, the CI verdict
 * and the report directly. The integration cases build a real remote and clone
 * with the git fixture and drive the CLI entry with the real git runner.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { GitRunner } from "../lib/git_base_ref.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import {
  ciFailed,
  formatCiReport,
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

// --- Pure: classification ---------------------------------------------------

Deno.test("summaryIssueOf - reads the issue from the summary name only", () => {
  assertEquals(summaryIssueOf(SUMMARY_PATH), 42);
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

Deno.test("ciFailed - missing and blocked fail; clean, no-summary and not-checked do not", () => {
  const checked = (
    overrides: Partial<Extract<PrSummaryCiResult, { kind: "checked" }>>,
  ): PrSummaryCiResult => ({
    kind: "checked",
    issueNumber: 42,
    summaryPath: SUMMARY_PATH,
    gates: [],
    ...overrides,
  });
  const blocked = {
    gate: "Docs sweep",
    issueRef: "#3073",
    status: "blocked" as const,
    problems: ["no Docs sweep line"],
  };

  assert(ciFailed({
    kind: "summary_missing",
    issueNumber: 42,
    summaryPath: SUMMARY_PATH,
  }));
  assert(ciFailed(checked({ gates: [blocked] })));
  assert(!ciFailed(checked({})));
  assert(!ciFailed({ kind: "no_summary" }));
  assert(!ciFailed({ kind: "not_checked", reason: "not an issue branch" }));
});

Deno.test("formatCiReport - control characters in a not-checked reason are escaped, not printed raw", () => {
  const s = selectSummary([SUMMARY_PATH], "milestone/a\n::error::x\u007fb");
  assert(s.kind === "not_checked");
  const text = formatCiReport(s);
  assert(!text.includes("\n::error"));
  assert(!text.includes("\u007f"));
  assertStringIncludes(text, "\\u000a::error::x");
  assertStringIncludes(text, "\\u007fb");
  assertStringIncludes(text, "[NOT CHECKED] PR summary (#3768)");
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

Deno.test("pr-summary-ci - a summary commit newer than the code passes and runs the gates", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");
    await commitSummary(clone);

    const r = await runCi(clone, BRANCH);
    assertEquals(r.code, 0);
    assertStringIncludes(r.stdout, "[NOT_CHECKED] Acceptance-criteria closure");
    assert(!r.stdout.includes("[PASSED] Acceptance-criteria closure"));
  });
});

Deno.test("pr-summary-ci - a code commit after the summary no longer blocks on commit order (Issue #5227)", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");
    await commitSummary(clone);
    await commitCode(clone, "export const a = 2;\n");

    const r = await runCi(clone, BRANCH);
    assertEquals(r.code, 0);
    assert(!r.stdout.includes("Summary freshness"));
    assertStringIncludes(r.stdout, "[NOT_CHECKED] Acceptance-criteria closure");
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

Deno.test("pr-summary-ci - a blocked gate still fails CI end to end", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");
    await commitSummary(
      clone,
      `${GOOD_SUMMARY}\nQuality: QUALITY_RESULT_PLACEHOLDER\n`,
    );

    const r = await runCi(clone, BRANCH);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stdout, "[BLOCKED] Result placeholders");
    assertStringIncludes(r.stdout, "QUALITY_RESULT_PLACEHOLDER");
  });
});

Deno.test("runPrSummaryCi - every git call, base resolution included, runs in the repository root", async () => {
  const calls: { args: string[]; cwd: string | undefined }[] = [];
  const runGit: GitRunner = (args, options) => {
    calls.push({ args, cwd: options?.cwd });
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  };
  const r = await runPrSummaryCi({
    baseBranch: "main",
    headBranch: BRANCH,
    runGit,
    repoRoot: "/repo-root",
    readTextFile: () => Promise.reject(new Error("must not read")),
  });
  assertEquals(r, { ok: true, value: { kind: "no_summary" } });
  assertEquals(calls.map((c) => c.args[0]), ["rev-parse", "diff"]);
  for (const call of calls) assertEquals(call.cwd, "/repo-root");
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

Deno.test("runPrSummaryCi - a selected summary missing from the checkout is summary_missing", async () => {
  await withRepo(async (clone) => {
    await startBranch(clone, BRANCH);
    await commitCode(clone, "export const a = 1;\n");
    await commitSummary(clone);

    const r = await runPrSummaryCi({
      baseBranch: "main",
      headBranch: BRANCH,
      runGit: runGitCommand,
      repoRoot: clone,
      readTextFile: () => Promise.reject(new Deno.errors.NotFound("gone")),
    });
    assert(r.ok);
    assertEquals(r.value, {
      kind: "summary_missing",
      issueNumber: 42,
      summaryPath: SUMMARY_PATH,
    });
    assert(ciFailed(r.value));
    const report = formatCiReport(r.value);
    assertStringIncludes(report, "[BLOCKED] PR summary (#3768)");
    assertStringIncludes(report, "is not in the checkout");
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

Deno.test("parseArgs - an unknown flag is named in the error", () => {
  const r = parseArgs(["--base", "main", "--head-branch", BRANCH, "--foo"]);
  assert(!r.ok);
  assertStringIncludes(r.error.message, "unknown flag --foo");
});
