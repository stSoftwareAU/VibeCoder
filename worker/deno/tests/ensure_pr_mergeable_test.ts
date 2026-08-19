/**
 * Behaviour tests for `ensurePrMergeable` (worker/deno/lib/git_pull.ts) and its
 * `ensure-pr-mergeable` git-operations subcommand (Issue #3091).
 *
 * `ensurePrMergeable` is load-bearing PR-merge-readiness logic: it fetches the
 * base branch, moves the local base ref, checks out the feature branch, deepens
 * shallow history, computes how far behind the base the branch is, and rebases
 * + force-pushes when behind. None of that observable behaviour had a test, so
 * a refactor could silently regress it with CI staying green.
 *
 * These tests exercise the function against real local fixture repos and assert
 * on outcomes — the return value and the resulting branch/HEAD state — never on
 * the sequence of internal git invocations.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ensurePrMergeable } from "../lib/git_pull.ts";
import { gitOperationsCommand } from "../commands/git_operations.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const config = buildDefaultWorkerConfig();

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
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

async function currentBranch(cwd: string): Promise<string> {
  return (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).stdout
    .trim();
}

/** Initialise an upstream fixture repo on `main` with a single commit. */
async function initUpstream(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  assertEquals((await runGit(["init", "-b", "main"], dir)).code, 0);
  await runGit(["config", "user.email", "t@t"], dir);
  await runGit(["config", "user.name", "t"], dir);
  // A push to a non-checked-out branch is fine, but be defensive for main.
  await runGit(["config", "receive.denyCurrentBranch", "ignore"], dir);
  await Deno.writeTextFile(`${dir}/base.txt`, "base 1\n");
  await runGit(["add", "base.txt"], dir);
  await runGit(["commit", "-m", "base commit 1"], dir);
}

/** Clone `upstream` into `downstream` and configure a commit identity. */
async function cloneDown(
  tmp: string,
  upstream: string,
  downstream: string,
): Promise<void> {
  const clone = await runGit(
    ["clone", `file://${upstream}`, downstream],
    tmp,
  );
  assertEquals(clone.code, 0, `clone failed: ${clone.stderr}`);
  await runGit(["config", "user.email", "t@t"], downstream);
  await runGit(["config", "user.name", "t"], downstream);
}

// ---------------------------------------------------------------------------
// Soft-success path — base branch cannot be fetched (no origin remote).
// ---------------------------------------------------------------------------

Deno.test("ensurePrMergeable - soft-success when base branch cannot be fetched", async () => {
  const dir = await Deno.makeTempDir({ prefix: "epm-nofetch-" });
  try {
    // A repo with NO origin remote — `git fetch origin main` must fail, which
    // drives the soft-success branch.
    assertEquals((await runGit(["init", "-b", "main"], dir)).code, 0);
    await runGit(["config", "user.email", "t@t"], dir);
    await runGit(["config", "user.name", "t"], dir);
    await Deno.writeTextFile(`${dir}/a.txt`, "a\n");
    await runGit(["add", "a.txt"], dir);
    await runGit(["commit", "-m", "init"], dir);

    const result = await ensurePrMergeable("o/r", 7, "main", "main", {
      cwd: dir,
    });

    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) {
      assertStringIncludes(result.value, "skipping mergeability check");
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Up-to-date path — branch not behind base; reports "no conflicts".
// Driven through the `ensure-pr-mergeable` subcommand to cover the wiring.
// ---------------------------------------------------------------------------

Deno.test("ensure-pr-mergeable command - reports up to date when not behind base", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "epm-uptodate-" });
  const upstream = `${tmp}/upstream`;
  const downstream = `${tmp}/downstream`;
  try {
    await initUpstream(upstream);
    await cloneDown(tmp, upstream, downstream);

    // Create a feature branch off main with no divergence — it is level with
    // the base, so behindCount === 0.
    assertEquals(
      (await runGit(["checkout", "-b", "issue-1-feature"], downstream)).code,
      0,
    );

    const result = await gitOperationsCommand.execute(
      {
        operation: "ensure-pr-mergeable",
        repo: "o/r",
        "pr-number": 1,
        "branch-name": "issue-1-feature",
        "base-branch": "main",
        cwd: downstream,
      },
      config,
    );

    assertEquals(result.success, true);
    assertStringIncludes(result.message, "up to date");
    // The feature branch must end up checked out.
    assertEquals(await currentBranch(downstream), "issue-1-feature");
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Behind path — branch behind base rebases cleanly and force-pushes.
// ---------------------------------------------------------------------------

Deno.test("ensurePrMergeable - rebases and pushes when behind the base branch", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "epm-behind-" });
  const upstream = `${tmp}/upstream`;
  const downstream = `${tmp}/downstream`;
  try {
    await initUpstream(upstream);
    await cloneDown(tmp, upstream, downstream);

    // Feature branch with its own commit on a distinct file.
    assertEquals(
      (await runGit(["checkout", "-b", "issue-2-feature"], downstream)).code,
      0,
    );
    await Deno.writeTextFile(`${downstream}/feature.txt`, "feature work\n");
    await runGit(["add", "feature.txt"], downstream);
    assertEquals(
      (await runGit(["commit", "-m", "feature commit"], downstream)).code,
      0,
    );

    // Advance upstream main so the feature branch is now one commit behind.
    await Deno.writeTextFile(`${upstream}/base.txt`, "base 2\n");
    await runGit(["add", "base.txt"], upstream);
    assertEquals(
      (await runGit(["commit", "-m", "base commit 2"], upstream)).code,
      0,
    );

    const result = await ensurePrMergeable(
      "o/r",
      2,
      "issue-2-feature",
      "main",
      { cwd: downstream },
    );

    assert(result.ok, result.ok ? "" : result.error.message);
    if (result.ok) {
      assertStringIncludes(result.value, "Successfully pushed");
    }
    // Still on the feature branch, and the upstream commit is now an ancestor
    // (the rebase replayed the feature commit on top of the new base).
    assertEquals(await currentBranch(downstream), "issue-2-feature");
    const merged = await runGit(
      ["merge-base", "--is-ancestor", "main", "HEAD"],
      downstream,
    );
    assertEquals(merged.code, 0, "base branch is not an ancestor after rebase");
    // The pushed feature branch now exists on the upstream remote.
    const upstreamRefs = await runGit(
      ["branch", "--list", "issue-2-feature"],
      upstream,
    );
    assertStringIncludes(upstreamRefs.stdout, "issue-2-feature");
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Checkout-failure path — non-existent feature branch returns ok: false.
// ---------------------------------------------------------------------------

Deno.test("ensurePrMergeable - returns error when feature branch cannot be checked out", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "epm-nobranch-" });
  const upstream = `${tmp}/upstream`;
  const downstream = `${tmp}/downstream`;
  try {
    await initUpstream(upstream);
    await cloneDown(tmp, upstream, downstream);
    // On main; the requested feature branch does not exist locally.

    const result = await ensurePrMergeable(
      "o/r",
      3,
      "does-not-exist",
      "main",
      { cwd: downstream },
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "Failed to checkout branch");
    }
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Command wiring — missing arguments is rejected before any git runs.
// ---------------------------------------------------------------------------

Deno.test("ensure-pr-mergeable command - rejects missing required arguments", async () => {
  const result = await gitOperationsCommand.execute(
    { operation: "ensure-pr-mergeable", repo: "o/r" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required arguments");
});
