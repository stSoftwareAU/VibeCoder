/**
 * A run whose branch changes only its own record files — the PR summary and
 * the PR response message — has no deliverable, so change detection treats it
 * as "no changes" instead of raising an empty PR (Issue #5070).
 *
 * Uses a real temporary git repository with a bare origin, so the git
 * behaviour under test is git's own, not a mock's.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import {
  changesOnlyRunRecords,
  readBranchChangedPaths,
} from "../lib/run_record_only.ts";
import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../lib/issue_worker_types.ts";

const ISSUE = 5070;
const BRANCH = "issue-5070-record-only";
const SUMMARY = `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
const OTHER_SUMMARY = `docs/archive/pr-summaries/pr-summary-${ISSUE + 1}.md`;

const GIT_ID = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@example.com",
  "-c",
  "commit.gpgsign=false",
];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: [...GIT_ID, ...args],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder();
  assert(
    out.success,
    `git ${args.join(" ")} failed: ${text.decode(out.stderr)}`,
  );
  return text.decode(out.stdout);
}

async function write(repo: string, path: string, content: string) {
  const full = `${repo}/${path}`;
  await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(full, content);
}

async function commitAll(repo: string, message: string) {
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", message);
}

/** A clone of a bare origin, on the issue branch, level with `main`. */
async function makeRepo(): Promise<{ root: string; repo: string }> {
  const root = await Deno.makeTempDir({ prefix: "issue5070-" });
  const origin = `${root}/origin.git`;
  const repo = `${root}/work`;
  await Deno.mkdir(origin);
  await git(origin, "init", "-q", "--bare", "-b", "main");
  await Deno.mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "remote", "add", "origin", origin);
  await write(repo, "README.md", "readme\n");
  await write(repo, SUMMARY, "first summary\n");
  await commitAll(repo, "initial");
  await git(repo, "push", "-q", "origin", "main");
  await git(repo, "checkout", "-q", "-b", BRANCH);
  return { root, repo };
}

function makeContext(): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: ISSUE,
    issueTitle: "Record only",
    issueBody: "Do it.",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "testbot",
    config: { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 1 },
  };
}

function makeState(repoPath: string): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

const OK_RUN = {
  output: "Rewrote the summary.",
  exitCode: 0,
  rawExitCode: 0,
  timedOut: false,
};

async function runPhase(
  setup: (repo: string) => Promise<void>,
  options: {
    agent?: Record<string, unknown>;
    existingPr?: unknown;
  } = {},
): Promise<PhaseResult> {
  const { root, repo } = await makeRepo();
  try {
    await setup(repo);
    const deps = createMockDeps({
      git: { runGitCommand },
      claude: {
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: options.agent ?? OK_RUN,
          })) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({
            ok: true,
            value: options.existingPr ?? null,
          })) as never,
      },
    });
    const ctx = makeContext();
    return await workOnIssueExecuteClaude(ctx, makeState(repo), deps);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function assertNoChanges(result: PhaseResult) {
  assertEquals(result.status, "early_exit");
  assertEquals((result as { reason?: string }).reason, "no_changes");
}

Deno.test("#5070 a - a branch whose only commit edits its own summary is no_changes", async () => {
  const result = await runPhase(async (repo) => {
    await write(repo, SUMMARY, "second summary\n");
    await commitAll(repo, "rewrite summary");
  });
  assertNoChanges(result);
});

Deno.test("#5070 b - the same commit pushed to origin/<branch> is still no_changes", async () => {
  const result = await runPhase(async (repo) => {
    await write(repo, SUMMARY, "second summary\n");
    await commitAll(repo, "rewrite summary");
    await git(repo, "push", "-q", "origin", BRANCH);
  });
  assertNoChanges(result);
});

Deno.test("#5070 c - own summary plus an untracked .pr_response_message is no_changes", async () => {
  const result = await runPhase(async (repo) => {
    await write(repo, SUMMARY, "second summary\n");
    await commitAll(repo, "rewrite summary");
    await write(repo, ".pr_response_message", "reply\n");
  });
  assertNoChanges(result);
});

Deno.test("#5070 d - a summary plus a real file in the commit continues", async () => {
  const result = await runPhase(async (repo) => {
    await write(repo, SUMMARY, "second summary\n");
    await write(repo, "lib/real.ts", "export const x = 1;\n");
    await commitAll(repo, "real change");
  });
  assertEquals(result.status, "continue");
});

Deno.test("#5070 e - own summary plus an untracked real file continues", async () => {
  const result = await runPhase(async (repo) => {
    await write(repo, SUMMARY, "second summary\n");
    await commitAll(repo, "rewrite summary");
    await write(repo, "src/new.ts", "export const y = 2;\n");
  });
  assertEquals(result.status, "continue");
});

Deno.test("#5070 f - only another issue's summary committed continues", async () => {
  const result = await runPhase(async (repo) => {
    await write(repo, OTHER_SUMMARY, "other\n");
    await commitAll(repo, "other summary");
  });
  assertEquals(result.status, "continue");
});

Deno.test("#5070 g - a record-only branch with an existing PR still continues", async () => {
  const result = await runPhase(async (repo) => {
    await write(repo, SUMMARY, "second summary\n");
    await commitAll(repo, "rewrite summary");
  }, { existingPr: { number: 9, url: "https://example.test/pr/9" } });
  assertEquals(result.status, "continue");
});

Deno.test("#5070 h - a record-only branch with a crashed agent is an interrupted failure", async () => {
  const result = await runPhase(async (repo) => {
    await write(repo, SUMMARY, "second summary\n");
    await commitAll(repo, "rewrite summary");
  }, {
    agent: {
      output: "boom",
      exitCode: 1,
      rawExitCode: 1,
      timedOut: false,
    },
  });
  assertEquals(result.status, "failure");
  assertEquals((result as { category?: string }).category, "interrupted");
  assertStringIncludes(
    (result as { reason?: string }).reason ?? "",
    "beyond its own run record",
  );
});

Deno.test("#5070 i - changesOnlyRunRecords accepts only the run's own record files", () => {
  assertEquals(changesOnlyRunRecords([], ISSUE), false);
  assertEquals(
    changesOnlyRunRecords([SUMMARY, ".pr_response_message"], ISSUE),
    true,
  );
  assertEquals(
    changesOnlyRunRecords(["foo/.pr_response_message"], ISSUE),
    false,
  );
  assertEquals(changesOnlyRunRecords([OTHER_SUMMARY], ISSUE), false);
  assertEquals(changesOnlyRunRecords([SUMMARY, "lib/real.ts"], ISSUE), false);
});

Deno.test("#5070 j - readBranchChangedPaths fails loudly on an unknown base ref", async () => {
  const { root, repo } = await makeRepo();
  try {
    const result = await readBranchChangedPaths(runGitCommand, "origin/nope", {
      cwd: repo,
    });
    assertEquals(result.ok, false);
    if (!result.ok) assertStringIncludes(result.error.message, "git diff");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
