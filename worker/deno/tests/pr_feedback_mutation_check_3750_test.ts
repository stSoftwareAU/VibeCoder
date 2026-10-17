/**
 * Tests for the review-fix run's own-lines diff and mutation check (Issue
 * #3750).
 *
 * Real temporary git repos throughout: the scope rule is about what git's
 * merge machinery reports (merge bases, merge-tree, untracked files), so a
 * fake git seam would not exercise the thing that matters.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  collectRunOwnDiff,
  type ReviewFixMutationDeps,
  runReviewFixMutationCheck,
} from "../lib/pr_feedback_mutation_check.ts";
import {
  DEFAULT_MUTATION_BUDGET_SECONDS,
  type MutationCheckResult,
  parseAddedLines,
} from "../lib/mutation_gate.ts";
import type { MutationRunInput } from "../lib/mutation_runner.ts";
import type { Logger, Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Test-repo scaffolding: a real git checkout per test.
// ---------------------------------------------------------------------------

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(dir: string, args: string[]): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: dir,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function gitOk(dir: string, args: string[]): Promise<string> {
  const result = await git(dir, args);
  assertEquals(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function writeFile(dir: string, path: string, content: string) {
  const full = `${dir}/${path}`;
  await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(full, content);
}

async function commitAll(dir: string, message: string) {
  await gitOk(dir, ["add", "."]);
  await gitOk(dir, ["commit", "-m", message]);
}

async function initRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "pr_feedback_mutation_3750_" });
  await gitOk(dir, ["init", "-b", "main"]);
  await gitOk(dir, ["config", "user.name", "test"]);
  await gitOk(dir, ["config", "user.email", "test@example.com"]);
  await gitOk(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

async function withRepo(fn: (dir: string) => Promise<void>) {
  const dir = await initRepo();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** A file body made of the given lines, each newline-terminated. */
function lines(...names: string[]): string {
  return names.map((name) => `${name}\n`).join("");
}

/** Fake `runGit` that shells out to real git in `dir`, counting its calls. */
function countingRunGit(dir: string): {
  runGit: ReviewFixMutationDeps["runGit"];
  counter: { calls: number };
} {
  const counter = { calls: 0 };
  const runGit: ReviewFixMutationDeps["runGit"] = async (args) => {
    counter.calls++;
    return await git(dir, args);
  };
  return { runGit, counter };
}

function okValue(result: Result<string>): string {
  if (!result.ok) {
    throw new Error(`expected an ok result, got: ${result.error.message}`);
  }
  return result.value;
}

function errorMessage(result: Result<string>): string {
  if (result.ok) {
    throw new Error(
      `expected an error result, got a diff of ${result.value.length} chars`,
    );
  }
  return result.error.message;
}

// ---------------------------------------------------------------------------
// collectRunOwnDiff
// ---------------------------------------------------------------------------

Deno.test("collectRunOwnDiff - no merges: committed, uncommitted and untracked lines count", async () => {
  await withRepo(async (dir) => {
    await writeFile(dir, "lib/a.ts", lines("a1", "a2", "a3"));
    await commitAll(dir, "base");
    const beforeSha = await gitOk(dir, ["rev-parse", "HEAD"]);

    // The run commits a line at the end of a.ts (new line 4).
    await writeFile(dir, "lib/a.ts", lines("a1", "a2", "a3", "a4"));
    await commitAll(dir, "run commit");
    // Then an uncommitted edit to line 1, and a new untracked file.
    await writeFile(dir, "lib/a.ts", lines("a1-edit", "a2", "a3", "a4"));
    await writeFile(dir, "lib/new.ts", lines("n1", "n2"));

    const diff = okValue(
      await collectRunOwnDiff(
        countingRunGit(dir).runGit,
        beforeSha,
      ),
    );
    const added = parseAddedLines(diff);
    // Only the run's lines: a1-edit (line 1), a4 (line 4), and both lines of
    // the untracked file. The unchanged a2 and a3 are absent.
    assertEquals(added.get("lib/a.ts"), [1, 4]);
    assertEquals(added.get("lib/new.ts"), [1, 2]);
    assertEquals(added.size, 2);
  });
});

Deno.test("collectRunOwnDiff - lines a merge brought in are excluded, the run's own are kept", async () => {
  await withRepo(async (dir) => {
    await writeFile(
      dir,
      "lib/a.ts",
      lines("a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"),
    );
    await writeFile(dir, "lib/b.ts", lines("b1", "b2"));
    await commitAll(dir, "base");
    await gitOk(dir, ["checkout", "-b", "pr"]);
    const beforeSha = await gitOk(dir, ["rev-parse", "HEAD"]);

    // main advances: a new line at the bottom of a.ts, and one in b.ts.
    await gitOk(dir, ["checkout", "main"]);
    await writeFile(
      dir,
      "lib/a.ts",
      lines(
        "a1",
        "a2",
        "a3",
        "a4",
        "a5",
        "a6",
        "a7",
        "a8",
        "a9",
        "a10",
        "a-main-new",
      ),
    );
    await writeFile(dir, "lib/b.ts", lines("b1", "b2", "b-main-new"));
    await commitAll(dir, "main advances");

    // The run commits a line near the top of a.ts, merges main (no
    // conflict), then makes an uncommitted edit to b.ts.
    await gitOk(dir, ["checkout", "pr"]);
    await writeFile(
      dir,
      "lib/a.ts",
      lines(
        "a1",
        "a-run-new",
        "a2",
        "a3",
        "a4",
        "a5",
        "a6",
        "a7",
        "a8",
        "a9",
        "a10",
      ),
    );
    await commitAll(dir, "run commit");
    await gitOk(dir, ["merge", "--no-ff", "--no-edit", "main"]);
    await writeFile(dir, "lib/b.ts", lines("b1", "b2-run", "b-main-new"));

    const diff = okValue(
      await collectRunOwnDiff(
        countingRunGit(dir).runGit,
        beforeSha,
      ),
    );
    const added = parseAddedLines(diff);
    // Line numbers are those of HEAD and the working tree: the run's a1-line
    // is line 2 and its b2-edit is line 2. main's a-main-new (line 11) and
    // b-main-new (line 3) were brought in by the merge and are absent.
    assertEquals(added.get("lib/a.ts"), [2]);
    assertEquals(added.get("lib/b.ts"), [2]);
    assertEquals(added.size, 2);
  });
});

Deno.test("collectRunOwnDiff - negative control: a run whose only action is merging main has no own lines", async () => {
  await withRepo(async (dir) => {
    await writeFile(dir, "lib/a.ts", lines("a1", "a2", "a3"));
    await commitAll(dir, "base");
    await gitOk(dir, ["checkout", "-b", "pr"]);
    // A commit the PR already had before the run began, so the merge below
    // is a real merge commit and not a fast-forward.
    await writeFile(dir, "lib/a.ts", lines("a1", "a2", "a3", "pr-own"));
    await commitAll(dir, "pr own commit");
    const beforeSha = await gitOk(dir, ["rev-parse", "HEAD"]);

    await gitOk(dir, ["checkout", "main"]);
    await writeFile(dir, "lib/b.ts", lines("b-main-new"));
    await commitAll(dir, "main advances");
    await gitOk(dir, ["checkout", "pr"]);

    // The run's only action: merge main.
    await gitOk(dir, ["merge", "--no-ff", "--no-edit", "main"]);

    const diff = okValue(
      await collectRunOwnDiff(
        countingRunGit(dir).runGit,
        beforeSha,
      ),
    );
    assertEquals(parseAddedLines(diff).size, 0);
  });
});

Deno.test("collectRunOwnDiff - two unrelated merges are refused", async () => {
  await withRepo(async (dir) => {
    await writeFile(dir, "lib/a.ts", lines("a1"));
    await commitAll(dir, "base");
    await gitOk(dir, ["checkout", "-b", "pr"]);
    const beforeSha = await gitOk(dir, ["rev-parse", "HEAD"]);

    // Two histories that share nothing with the PR or with each other.
    for (const name of ["x1", "x2"]) {
      await gitOk(dir, ["checkout", "--orphan", name]);
      await gitOk(dir, ["rm", "-r", "-q", "--cached", "."]);
      await Deno.remove(`${dir}/lib/a.ts`);
      await writeFile(dir, `${name}.ts`, lines(`${name}-line`));
      await commitAll(dir, `${name} history`);
      await gitOk(dir, ["checkout", "pr"]);
      await gitOk(dir, [
        "merge",
        "--no-ff",
        "--no-edit",
        "--allow-unrelated-histories",
        name,
      ]);
    }

    const message = errorMessage(
      await collectRunOwnDiff(
        countingRunGit(dir).runGit,
        beforeSha,
      ),
    );
    assertStringIncludes(message, "unrelated");
  });
});

Deno.test("collectRunOwnDiff - an invalid beforeSha is refused with git's cause", async () => {
  await withRepo(async (dir) => {
    await writeFile(dir, "lib/a.ts", lines("a1"));
    await commitAll(dir, "base");
    const message = errorMessage(
      await collectRunOwnDiff(
        countingRunGit(dir).runGit,
        "f".repeat(40),
      ),
    );
    assertStringIncludes(message, "fatal:");
  });
});

// ---------------------------------------------------------------------------
// runReviewFixMutationCheck (the shared invocation, Issue #3393)
// ---------------------------------------------------------------------------

const REPO = "o/r";

/** A repo whose run has one uncommitted edit to a.ts (new line 2). */
async function editedRepo(dir: string): Promise<string> {
  await writeFile(dir, "lib/a.ts", lines("a1", "a2", "a3"));
  await commitAll(dir, "base");
  const beforeSha = await gitOk(dir, ["rev-parse", "HEAD"]);
  await writeFile(dir, "lib/a.ts", lines("a1", "a2-run", "a3"));
  return beforeSha;
}

function recordingLogger(): {
  logger: Pick<Logger, "info" | "warn">;
  entries: string[];
} {
  const entries: string[] = [];
  return {
    logger: {
      info: (message: string) => {
        entries.push(`info: ${message}`);
      },
      warn: (message: string) => {
        entries.push(`warn: ${message}`);
      },
    },
    entries,
  };
}

Deno.test("runReviewFixMutationCheck - skip_mutation_check: not applicable, nothing collected or run", async () => {
  await withRepo(async (dir) => {
    const beforeSha = await editedRepo(dir);
    const { runGit, counter } = countingRunGit(dir);
    const { logger } = recordingLogger();
    let runnerCalls = 0;
    const result = await runReviewFixMutationCheck(
      {
        repo: REPO,
        repoPath: dir,
        beforeSha,
        repoConfigs: { [REPO]: { skipMutationCheck: true } },
      },
      {
        runGit,
        runner: async () => {
          runnerCalls++;
          return { kind: "not_applicable", reason: "unused" };
        },
        logger,
      },
    );
    assertEquals(result, {
      kind: "not_applicable",
      reason: "skipped by skip_mutation_check",
    });
    assertEquals(runnerCalls, 0);
    assertEquals(counter.calls, 0);
  });
});

Deno.test("runReviewFixMutationCheck - an unwired runner is not applicable", async () => {
  await withRepo(async (dir) => {
    const beforeSha = await editedRepo(dir);
    const { logger, entries } = recordingLogger();
    const result = await runReviewFixMutationCheck(
      { repo: REPO, repoPath: dir, beforeSha, repoConfigs: undefined },
      { runGit: countingRunGit(dir).runGit, runner: undefined, logger },
    );
    assertEquals(result, {
      kind: "not_applicable",
      reason: "mutation runner not wired",
    });
    assertEquals(entries, [
      "warn: Mutation runner not wired — mutation check not applicable",
    ]);
  });
});

Deno.test("runReviewFixMutationCheck - the budget comes from mutation_check_budget_seconds, default when unset", async () => {
  await withRepo(async (dir) => {
    const beforeSha = await editedRepo(dir);
    const budgets: number[] = [];
    const runner = async (
      input: MutationRunInput,
    ): Promise<MutationCheckResult> => {
      budgets.push(input.budgetSeconds);
      return { kind: "not_applicable", reason: "budget probe" };
    };
    const { logger } = recordingLogger();
    const deps = { runGit: countingRunGit(dir).runGit, runner, logger };
    await runReviewFixMutationCheck(
      {
        repo: REPO,
        repoPath: dir,
        beforeSha,
        repoConfigs: { [REPO]: { mutationCheckBudgetSeconds: 120 } },
      },
      deps,
    );
    await runReviewFixMutationCheck(
      { repo: REPO, repoPath: dir, beforeSha, repoConfigs: undefined },
      deps,
    );
    assertEquals(budgets, [120, DEFAULT_MUTATION_BUDGET_SECONDS]);
  });
});

Deno.test("runReviewFixMutationCheck - a diff that cannot be collected is an error and the runner is not called", async () => {
  await withRepo(async (dir) => {
    await editedRepo(dir);
    const { runGit } = countingRunGit(dir);
    const { logger } = recordingLogger();
    let runnerCalls = 0;
    const result = await runReviewFixMutationCheck(
      {
        repo: REPO,
        repoPath: dir,
        beforeSha: "f".repeat(40),
        repoConfigs: undefined,
      },
      {
        runGit,
        runner: async () => {
          runnerCalls++;
          return { kind: "not_applicable", reason: "unused" };
        },
        logger,
      },
    );
    assertEquals(result.kind, "error");
    if (result.kind !== "error") throw new Error("unreachable");
    assertStringIncludes(result.reason, "fatal:");
    assertEquals(runnerCalls, 0);
  });
});

Deno.test("runReviewFixMutationCheck - a runner that throws is an error naming the failure", async () => {
  await withRepo(async (dir) => {
    const beforeSha = await editedRepo(dir);
    const { logger } = recordingLogger();
    const result = await runReviewFixMutationCheck(
      { repo: REPO, repoPath: dir, beforeSha, repoConfigs: undefined },
      {
        runGit: countingRunGit(dir).runGit,
        runner: async () => {
          throw new Error("boom");
        },
        logger,
      },
    );
    assertEquals(result, {
      kind: "error",
      reason: "mutation runner failed: boom",
    });
  });
});

Deno.test("runReviewFixMutationCheck - the runner receives the diff of the lines this run added", async () => {
  await withRepo(async (dir) => {
    const beforeSha = await editedRepo(dir);
    const { logger } = recordingLogger();
    let received: MutationRunInput | null = null;
    const verdict: MutationCheckResult = {
      kind: "completed",
      language: "deno",
      survivors: [],
      killed: 0,
      total: 0,
    };
    const result = await runReviewFixMutationCheck(
      { repo: REPO, repoPath: dir, beforeSha, repoConfigs: undefined },
      {
        runGit: countingRunGit(dir).runGit,
        runner: async (input) => {
          received = input;
          return verdict;
        },
        logger,
      },
    );
    assertEquals(result, verdict);
    if (received === null) throw new Error("the runner was not called");
    const input: MutationRunInput = received;
    assertEquals(input.repoPath, dir);
    assertEquals(parseAddedLines(input.diff).get("lib/a.ts"), [2]);
  });
});
