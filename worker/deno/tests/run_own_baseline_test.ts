/**
 * Tests for `collectRunOwnBaseline`, the baseline for a review-fix run's own
 * changes (Issue #3750; moved from `pr_feedback_mutation_check_3750_test.ts`
 * with the mutation check's retirement, Issue #5095).
 *
 * Real temporary git repos throughout: the scope rule is about what git's
 * merge machinery reports (merge bases, merge-tree), so a fake git seam would
 * not exercise the thing that matters.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { collectRunOwnBaseline } from "../lib/run_own_baseline.ts";
import type { Result } from "../types.ts";

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
  const dir = await Deno.makeTempDir({ prefix: "run_own_baseline_" });
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

/** A `runGit` that shells out to real git in `dir`. */
function runGitIn(dir: string) {
  return (args: string[]) => git(dir, args);
}

function okValue(result: Result<string>): string {
  if (!result.ok) {
    throw new Error(`expected an ok result, got: ${result.error.message}`);
  }
  return result.value;
}

function errorMessage(result: Result<string>): string {
  if (result.ok) {
    throw new Error(`expected an error result, got: ${result.value}`);
  }
  return result.error.message;
}

// ---------------------------------------------------------------------------
// collectRunOwnBaseline
// ---------------------------------------------------------------------------

Deno.test("collectRunOwnBaseline - no merges: the baseline is the run's start, whatever it committed or edited", async () => {
  await withRepo(async (dir) => {
    await writeFile(dir, "lib/a.ts", lines("a1", "a2", "a3"));
    await commitAll(dir, "base");
    const beforeSha = await gitOk(dir, ["rev-parse", "HEAD"]);

    // The run commits a line, then edits it and adds an untracked file.
    await writeFile(dir, "lib/a.ts", lines("a1", "a2", "a3", "a4"));
    await commitAll(dir, "run commit");
    await writeFile(dir, "lib/a.ts", lines("a1-edit", "a2", "a3", "a4"));
    await writeFile(dir, "lib/new.ts", lines("n1", "n2"));

    assertEquals(
      okValue(await collectRunOwnBaseline(runGitIn(dir), beforeSha)),
      beforeSha,
    );
  });
});

Deno.test("collectRunOwnBaseline - lines a merge brought in are in the baseline, the run's own lines are not", async () => {
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

    const baseline = okValue(
      await collectRunOwnBaseline(runGitIn(dir), beforeSha),
    );
    // The baseline is a tree: the branch as it would have been had it merged
    // main before the run. main's lines are in it; the run's own are not.
    assertEquals(await gitOk(dir, ["cat-file", "-t", baseline]), "tree");
    const a = await gitOk(dir, ["show", `${baseline}:lib/a.ts`]);
    assertStringIncludes(a, "a-main-new");
    assertEquals(a.includes("a-run-new"), false);
    const b = await gitOk(dir, ["show", `${baseline}:lib/b.ts`]);
    assertStringIncludes(b, "b-main-new");
    assertEquals(b.includes("b2-run"), false);
  });
});

Deno.test("collectRunOwnBaseline - negative control: a run whose only action is merging main has no own lines", async () => {
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

    // Nothing the run did is outside the baseline, so the baseline is the
    // tree the run ended with.
    assertEquals(
      okValue(await collectRunOwnBaseline(runGitIn(dir), beforeSha)),
      await gitOk(dir, ["rev-parse", "HEAD^{tree}"]),
    );
  });
});

/**
 * Merge a history that shares nothing with the checkout, as a run that merged
 * an unrelated branch would. Leaves the checkout on `pr`.
 */
async function mergeUnrelatedHistory(dir: string, name: string) {
  await gitOk(dir, ["checkout", "--orphan", name]);
  await gitOk(dir, ["rm", "-r", "-q", "-f", "."]);
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

Deno.test("collectRunOwnBaseline - two unrelated merges are refused", async () => {
  await withRepo(async (dir) => {
    await writeFile(dir, "lib/a.ts", lines("a1"));
    await commitAll(dir, "base");
    await gitOk(dir, ["checkout", "-b", "pr"]);
    const beforeSha = await gitOk(dir, ["rev-parse", "HEAD"]);

    await mergeUnrelatedHistory(dir, "x1");
    await mergeUnrelatedHistory(dir, "x2");

    const message = errorMessage(
      await collectRunOwnBaseline(runGitIn(dir), beforeSha),
    );
    assertStringIncludes(
      message,
      "this run merged more than one unrelated history",
    );
  });
});

Deno.test("collectRunOwnBaseline - an unrelated merge followed by a merge of main is refused", async () => {
  await withRepo(async (dir) => {
    await writeFile(dir, "lib/a.ts", lines("a1"));
    await commitAll(dir, "base");
    await gitOk(dir, ["checkout", "-b", "pr"]);
    const beforeSha = await gitOk(dir, ["rev-parse", "HEAD"]);

    // main advances, so merging it is related history that git can merge
    // with the run's base. Only the containment check refuses x1 here.
    await mergeUnrelatedHistory(dir, "x1");
    await gitOk(dir, ["checkout", "main"]);
    await writeFile(dir, "lib/a.ts", lines("a1", "a-main-new"));
    await commitAll(dir, "main advances");
    await gitOk(dir, ["checkout", "pr"]);
    await gitOk(dir, ["merge", "--no-ff", "--no-edit", "main"]);

    const message = errorMessage(
      await collectRunOwnBaseline(runGitIn(dir), beforeSha),
    );
    assertStringIncludes(
      message,
      "this run merged more than one unrelated history",
    );
  });
});

Deno.test("collectRunOwnBaseline - an invalid beforeSha is refused with git's cause", async () => {
  await withRepo(async (dir) => {
    await writeFile(dir, "lib/a.ts", lines("a1"));
    await commitAll(dir, "base");
    const message = errorMessage(
      await collectRunOwnBaseline(runGitIn(dir), "f".repeat(40)),
    );
    assertStringIncludes(message, "fatal:");
  });
});
