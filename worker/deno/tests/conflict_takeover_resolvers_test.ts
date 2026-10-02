/**
 * Tests for the conflict takeover's production resolver bindings
 * (Issue #3001).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { bindConflictTakeoverResolvers } from "../lib/conflict_takeover_resolvers.ts";
import type { ConflictTakeoverPr } from "../lib/conflict_takeover.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import type { Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers — real git repos, mirroring worker/deno/tests/git_pull_conflict_test.ts
// ---------------------------------------------------------------------------

async function createTempDir(): Promise<string> {
  return await Deno.makeTempDir({
    prefix: "conflict_takeover_resolvers_test_",
  });
}

async function setupTestRepos(
  tmpDir: string,
): Promise<{ remotePath: string; localPath: string }> {
  const remotePath = `${tmpDir}/remote.git`;
  const localPath = `${tmpDir}/local`;

  await Deno.mkdir(remotePath, { recursive: true });
  await runGitCommand(["init", "--bare"], { cwd: remotePath });
  await runGitCommand(
    ["symbolic-ref", "HEAD", "refs/heads/main"],
    { cwd: remotePath },
  );
  await runGitCommand(["clone", remotePath, localPath], { cwd: tmpDir });
  await runGitCommand(
    ["config", "user.email", "test@example.com"],
    { cwd: localPath },
  );
  await runGitCommand(["config", "user.name", "Test User"], {
    cwd: localPath,
  });
  await Deno.writeTextFile(`${localPath}/README.md`, "# Test Repo\n");
  await runGitCommand(["add", "README.md"], { cwd: localPath });
  await runGitCommand(["commit", "-m", "Initial commit"], { cwd: localPath });
  await runGitCommand(["push", "origin", "main"], { cwd: localPath });

  return { remotePath, localPath };
}

async function cleanup(tmpDir: string): Promise<void> {
  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch {
    // Best-effort cleanup
  }
}

async function headSha(cwd: string, ref: string): Promise<string> {
  const result = await runGitCommand(["rev-parse", ref], { cwd });
  return result.ok ? result.value.stdout.trim() : "";
}

function makePr(overrides: Partial<ConflictTakeoverPr>): ConflictTakeoverPr {
  return {
    repo: "acme/widgets",
    number: 42,
    headRefName: "milestone/x",
    baseRefName: "main",
    headSha: "0".repeat(40),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveOnFixBranch — clean merge
// ---------------------------------------------------------------------------

Deno.test("resolveOnFixBranch - a clean merge lands on the fix branch and never touches the PR head", async () => {
  const tmpDir = await createTempDir();
  try {
    const { remotePath, localPath } = await setupTestRepos(tmpDir);

    // Gated head branch, diverging from main with its own commit.
    await runGitCommand(["checkout", "-b", "milestone/x"], { cwd: localPath });
    await Deno.writeTextFile(`${localPath}/head.ts`, "export const h = 1;\n");
    await runGitCommand(["add", "head.ts"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Head change"], { cwd: localPath });
    await runGitCommand(["push", "origin", "milestone/x"], { cwd: localPath });
    const headCommit = await headSha(localPath, "milestone/x");

    // Main advances with a non-conflicting change.
    await runGitCommand(["checkout", "main"], { cwd: localPath });
    await Deno.writeTextFile(`${localPath}/main.ts`, "export const m = 1;\n");
    await runGitCommand(["add", "main.ts"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Main change"], { cwd: localPath });
    await runGitCommand(["push", "origin", "main"], { cwd: localPath });

    const resolvers = bindConflictTakeoverResolvers({
      checkout: () => Promise.resolve(localPath),
    });

    const pr = makePr({ headSha: headCommit });
    const outcome = await resolvers.resolveOnFixBranch(pr, "milestone-fix/x-1");

    assertEquals(outcome.resolved, true, outcome.detail);

    // The fix branch exists on origin and carries both histories.
    const fixOnOrigin = await runGitCommand(
      ["show", "origin/milestone-fix/x-1:head.ts"],
      { cwd: localPath },
    );
    assertEquals(fixOnOrigin.ok && fixOnOrigin.value.code, 0);
    const fixMain = await runGitCommand(
      ["show", "origin/milestone-fix/x-1:main.ts"],
      { cwd: localPath },
    );
    assertEquals(fixMain.ok && fixMain.value.code, 0);

    // The PR's own head branch on origin is untouched.
    const remoteHead = await runGitCommand(
      ["rev-parse", "refs/heads/milestone/x"],
      { cwd: remotePath },
    );
    assertEquals(remoteHead.ok && remoteHead.value.stdout.trim(), headCommit);
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// resolveOnFixBranch — genuine conflict
// ---------------------------------------------------------------------------

Deno.test("resolveOnFixBranch - a genuine conflict is left unresolved, aborted, and nothing is pushed", async () => {
  const tmpDir = await createTempDir();
  try {
    const { remotePath, localPath } = await setupTestRepos(tmpDir);

    await Deno.writeTextFile(`${localPath}/shared.ts`, "base\n");
    await runGitCommand(["add", "shared.ts"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Add shared"], { cwd: localPath });
    await runGitCommand(["push", "origin", "main"], { cwd: localPath });

    await runGitCommand(["checkout", "-b", "milestone/x"], { cwd: localPath });
    await Deno.writeTextFile(`${localPath}/shared.ts`, "head version\n");
    await runGitCommand(["add", "shared.ts"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Head change"], { cwd: localPath });
    await runGitCommand(["push", "origin", "milestone/x"], { cwd: localPath });
    const headCommit = await headSha(localPath, "milestone/x");

    await runGitCommand(["checkout", "main"], { cwd: localPath });
    await Deno.writeTextFile(`${localPath}/shared.ts`, "main version\n");
    await runGitCommand(["add", "shared.ts"], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Main change"], { cwd: localPath });
    await runGitCommand(["push", "origin", "main"], { cwd: localPath });

    const resolvers = bindConflictTakeoverResolvers({
      checkout: () => Promise.resolve(localPath),
    });

    const pr = makePr({ headSha: headCommit });
    const outcome = await resolvers.resolveOnFixBranch(pr, "milestone-fix/x-2");

    assertEquals(outcome.resolved, false);
    assertStringIncludes(outcome.detail, "conflicted");

    // No merge left in progress.
    const merging = await runGitCommand(
      ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
      { cwd: localPath },
    );
    assertEquals(merging.ok && merging.value.code !== 0, true, "merge aborted");

    // The fix branch was never pushed.
    const fixOnOrigin = await runGitCommand(
      [
        "rev-parse",
        "--verify",
        "--quiet",
        "refs/remotes/origin/milestone-fix/x-2",
      ],
      { cwd: localPath },
    );
    assertEquals(fixOnOrigin.ok && fixOnOrigin.value.code !== 0, true);

    // The PR's own head branch on origin is untouched.
    const remoteHead = await runGitCommand(
      ["rev-parse", "refs/heads/milestone/x"],
      { cwd: remotePath },
    );
    assertEquals(remoteHead.ok && remoteHead.value.stdout.trim(), headCommit);
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// resolveViaLadder — delegates to the injected updateBranch
// ---------------------------------------------------------------------------

Deno.test("resolveViaLadder - delegates to updateBranch with (head, base, {cwd}, 'conflicting') and maps ok to resolved", async () => {
  const calls: unknown[] = [];
  const resolvers = bindConflictTakeoverResolvers({
    checkout: () => Promise.resolve("/work/widgets"),
    updateBranch: (branchName, baseBranch, options, reason) => {
      calls.push([branchName, baseBranch, options, reason]);
      return Promise.resolve({ ok: true, value: "merged and pushed" });
    },
  });

  const pr = makePr({});
  const outcome = await resolvers.resolveViaLadder(pr);

  assertEquals(outcome, { resolved: true, detail: "merged and pushed" });
  assertEquals(calls, [
    ["milestone/x", "main", { cwd: "/work/widgets" }, "conflicting"],
  ]);
});

Deno.test("resolveViaLadder - maps an err result to resolved:false with the error's message as detail", async () => {
  const resolvers = bindConflictTakeoverResolvers({
    checkout: () => Promise.resolve("/work/widgets"),
    updateBranch: (): Promise<Result<string>> =>
      Promise.resolve({
        ok: false,
        error: new Error("the merge conflicted"),
      }),
  });

  const outcome = await resolvers.resolveViaLadder(makePr({}));
  assertEquals(outcome, { resolved: false, detail: "the merge conflicted" });
});

// ---------------------------------------------------------------------------
// Invalid refs / shas are refused before any git runs
// ---------------------------------------------------------------------------

Deno.test("resolveOnFixBranch - an invalid fix branch name rejects without running git", async () => {
  let gitCalls = 0;
  const resolvers = bindConflictTakeoverResolvers({
    checkout: () => Promise.resolve("/work/widgets"),
    runGit: (): Promise<
      Result<{ code: number; stdout: string; stderr: string }>
    > => {
      gitCalls++;
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: "", stderr: "" },
      });
    },
  });

  await assertRejects(
    () => resolvers.resolveOnFixBranch(makePr({}), "-not-a-safe-branch"),
    Error,
  );
  assertEquals(gitCalls, 0, "no git command ran before the ref was validated");
});

Deno.test("resolveOnFixBranch - an invalid head sha rejects without running git", async () => {
  let gitCalls = 0;
  const resolvers = bindConflictTakeoverResolvers({
    checkout: () => Promise.resolve("/work/widgets"),
    runGit: (): Promise<
      Result<{ code: number; stdout: string; stderr: string }>
    > => {
      gitCalls++;
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: "", stderr: "" },
      });
    },
  });

  await assertRejects(
    () =>
      resolvers.resolveOnFixBranch(
        makePr({ headSha: "not-a-sha" }),
        "milestone-fix/x-3",
      ),
    Error,
  );
  assertEquals(gitCalls, 0, "no git command ran before the sha was validated");
});
