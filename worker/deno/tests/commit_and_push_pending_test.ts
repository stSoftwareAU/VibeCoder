/**
 * Tests for commitAndPushPending — final-mile push guard (Issue #1643).
 *
 * Verifies that the helper commits any uncommitted changes, pushes any
 * unpushed commits, and reports the final state honestly so callers can
 * detect "we forgot to push" scenarios.
 *
 * Every call supplies the run id explicitly (Issue #963). It used to come
 * from `VIBE_RUN_ID` on the process, which `lib/run_id.ts` *writes* when the
 * variable is unset — so even the tests that never mentioned a run id mutated
 * the process environment through the code under test, racing every other
 * test in the run (Issue #880). {@link TEST_RUN_ID} exists in no real
 * environment, so the trailer assertion below cannot pass on an ambient
 * value.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { commitAndPushPending } from "../lib/git_push.ts";
import { RUN_ID_TRAILER_KEY } from "../lib/run_id.ts";

/**
 * Run id stamped on every commit these tests make (Issue #963).
 *
 * A sentinel, not a plausible id: if the parameter were ignored and the
 * fallback to `VIBE_RUN_ID` ran instead, the trailer would carry something
 * else and the assertion would fail rather than pass on the ambient run id.
 */
const TEST_RUN_ID = "vibe-963-commit-push-sentinel";

/**
 * Call the production chokepoint with the run id supplied as a parameter.
 *
 * Only the trailing arguments are fixed — the branch, message and cwd are the
 * test's, and `allowDefaultBranch`/`preFlight` keep their production defaults.
 */
function commitAndPush(
  branchName: string,
  commitMessage: string,
  cwd: string,
  runId: string = TEST_RUN_ID,
) {
  return commitAndPushPending(
    branchName,
    commitMessage,
    { cwd },
    false,
    undefined,
    runId,
  );
}

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

async function makeUpstreamAndDownstream(
  prefix: string,
  branchName: string,
): Promise<{ tmp: string; upstream: string; downstream: string }> {
  const tmp = await Deno.makeTempDir({ prefix });
  const upstream = `${tmp}/upstream.git`;
  const downstream = `${tmp}/downstream`;

  await runGit(["init", "--bare", "-b", "main", upstream], tmp);

  const seed = `${tmp}/seed`;
  await runGit(["clone", upstream, seed], tmp);
  await runGit(["config", "user.email", "t@t"], seed);
  await runGit(["config", "user.name", "t"], seed);
  await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
  await runGit(["add", "."], seed);
  await runGit(["commit", "-m", "seed"], seed);
  await runGit(["push", "origin", "main"], seed);

  await runGit(["clone", upstream, downstream], tmp);
  await runGit(["config", "user.email", "t@t"], downstream);
  await runGit(["config", "user.name", "t"], downstream);
  await runGit(["checkout", "-b", branchName], downstream);
  await runGit(["push", "-u", "origin", branchName], downstream);

  return { tmp, upstream, downstream };
}

Deno.test("commitAndPushPending - commits and pushes uncommitted changes", async () => {
  const branch = "issue-1643-test";
  const { tmp, downstream } = await makeUpstreamAndDownstream(
    "commit_push_pending_dirty_",
    branch,
  );
  try {
    // Simulate Claude leaving uncommitted changes.
    await Deno.writeTextFile(`${downstream}/feature.txt`, "feature work\n");

    const result = await commitAndPush(
      branch,
      "Auto-commit pending changes (Issue #1643)",
      downstream,
    );

    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );
    if (result.ok) {
      assertEquals(result.value.committedNewChanges, true);
      assertEquals(result.value.commitsPushed, 1);
      assertEquals(result.value.finalUnpushedCount, 0);
    }

    // Verify origin really has the commit.
    const remoteHead = await runGit(
      ["rev-parse", `refs/remotes/origin/${branch}`],
      downstream,
    );
    const localHead = await runGit(["rev-parse", "HEAD"], downstream);
    assertEquals(remoteHead.stdout.trim(), localHead.stdout.trim());
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - pushes existing local commits with no uncommitted changes", async () => {
  const branch = "issue-1643-existing";
  const { tmp, downstream } = await makeUpstreamAndDownstream(
    "commit_push_pending_existing_",
    branch,
  );
  try {
    // Simulate Claude having committed but not pushed.
    await Deno.writeTextFile(`${downstream}/feature.txt`, "feature work\n");
    await runGit(["add", "."], downstream);
    await runGit(["commit", "-m", "implement feature"], downstream);

    const result = await commitAndPush(
      branch,
      "Auto-commit pending changes",
      downstream,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.committedNewChanges, false);
      assertEquals(result.value.commitsPushed, 1);
      assertEquals(result.value.finalUnpushedCount, 0);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - reports nothing to push when in sync", async () => {
  const branch = "issue-1643-sync";
  const { tmp, downstream } = await makeUpstreamAndDownstream(
    "commit_push_pending_sync_",
    branch,
  );
  try {
    const result = await commitAndPush(
      branch,
      "Auto-commit pending changes",
      downstream,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.committedNewChanges, false);
      assertEquals(result.value.commitsPushed, 0);
      assertEquals(result.value.finalUnpushedCount, 0);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - commits uncommitted changes on top of existing local commits", async () => {
  const branch = "issue-1643-mixed";
  const { tmp, downstream } = await makeUpstreamAndDownstream(
    "commit_push_pending_mixed_",
    branch,
  );
  try {
    // Existing local commit (Claude already committed once).
    await Deno.writeTextFile(`${downstream}/a.txt`, "first\n");
    await runGit(["add", "."], downstream);
    await runGit(["commit", "-m", "first commit"], downstream);

    // Plus uncommitted changes (Claude forgot to commit them).
    await Deno.writeTextFile(`${downstream}/b.txt`, "second\n");

    const result = await commitAndPush(
      branch,
      "Auto-commit pending changes (Issue #1643)",
      downstream,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.committedNewChanges, true);
      assertEquals(result.value.commitsPushed, 2);
      assertEquals(result.value.finalUnpushedCount, 0);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - refuses to push when a secret file is staged (Issue #1758)", async () => {
  const branch = "issue-1758-secret-blocked";
  const { tmp, downstream } = await makeUpstreamAndDownstream(
    "commit_push_pending_secret_",
    branch,
  );
  try {
    // Plant a .env alongside an otherwise-legitimate change. The pre-commit
    // safety gate must refuse and the .env must not reach origin.
    await Deno.writeTextFile(`${downstream}/feature.txt`, "feature work\n");
    await Deno.writeTextFile(`${downstream}/.env`, "API_KEY=leak\n");

    const result = await commitAndPush(
      branch,
      "Auto-commit pending changes",
      downstream,
    );

    assert(!result.ok, "expected pre-commit safety gate to reject the commit");
    if (!result.ok) {
      assert(
        result.error.message.includes(".env"),
        `expected .env in error, got: ${result.error.message}`,
      );
    }

    // Verify the index was reset — nothing staged.
    const stagedAfter = await runGit(
      ["diff", "--cached", "--name-only"],
      downstream,
    );
    assertEquals(stagedAfter.stdout.trim(), "");

    // Verify origin did NOT receive any new commit.
    const remoteLog = await runGit(
      ["log", "--format=%s", `origin/${branch}`],
      downstream,
    );
    // Only the seed commits should be present; no "Auto-commit" message.
    assert(
      !remoteLog.stdout.includes("Auto-commit pending changes"),
      `secret-bearing commit must not have been pushed, got log:\n${remoteLog.stdout}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - stamps the commit with the run-id trailer (Issue #2381)", async () => {
  const branch = "issue-2381-trailer";
  const { tmp, downstream } = await makeUpstreamAndDownstream(
    "commit_push_pending_trailer_",
    branch,
  );
  try {
    await Deno.writeTextFile(`${downstream}/feature.txt`, "feature work\n");

    const result = await commitAndPush(
      branch,
      "Implement feature (Issue #2381)",
      downstream,
    );
    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );

    // The committed message must carry the run-id trailer so the push is
    // traceable back to its originating worker run. Asserted on the trailer's
    // exact shape — a whole line, key, one space, the id supplied as a
    // parameter — because that line is the join key between the GitHub
    // timeline and the worker logs, and `git log --format=` reads it as a
    // trailer or not at all.
    const log = await runGit(["log", "-1", "--format=%B"], downstream);
    const trailerLine = `${RUN_ID_TRAILER_KEY}: ${TEST_RUN_ID}`;
    assert(
      log.stdout.split("\n").includes(trailerLine),
      `expected the line "${trailerLine}" in the commit message, got:\n${log.stdout}`,
    );

    // And git itself must read it as a trailer, not merely as text that
    // happens to be in the body.
    const trailer = await runGit(
      ["log", "-1", `--format=%(trailers:key=${RUN_ID_TRAILER_KEY},valueonly)`],
      downstream,
    );
    assertEquals(trailer.stdout.trim(), TEST_RUN_ID);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

/**
 * Build the fleet's clone shape: `--single-branch --branch main`, with the
 * feature branch checked out from `FETCH_HEAD`. Such a clone has NO
 * `refs/remotes/origin/<feature>` ref (Issue #211).
 */
async function makeSingleBranchClone(
  prefix: string,
  branchName: string,
): Promise<{ tmp: string; downstream: string }> {
  const tmp = await Deno.makeTempDir({ prefix });
  const upstream = `${tmp}/upstream.git`;
  const seed = `${tmp}/seed`;
  const downstream = `${tmp}/downstream`;

  await runGit(["init", "--bare", "-b", "main", upstream], tmp);
  await runGit(["clone", upstream, seed], tmp);
  await runGit(["config", "user.email", "t@t"], seed);
  await runGit(["config", "user.name", "t"], seed);
  await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
  await runGit(["add", "."], seed);
  await runGit(["commit", "-m", "seed"], seed);
  await runGit(["push", "origin", "main"], seed);

  await runGit(["checkout", "-b", branchName], seed);
  await Deno.writeTextFile(`${seed}/feature.txt`, "existing feature work\n");
  await runGit(["add", "."], seed);
  await runGit(["commit", "-m", "existing feature work"], seed);
  await runGit(["push", "-u", "origin", branchName], seed);

  await runGit(
    ["clone", "--single-branch", "--branch", "main", upstream, downstream],
    tmp,
  );
  await runGit(["config", "user.email", "t@t"], downstream);
  await runGit(["config", "user.name", "t"], downstream);
  await runGit(["fetch", "origin", branchName], downstream);
  await runGit(["checkout", "-b", branchName, "FETCH_HEAD"], downstream);

  return { tmp, downstream };
}

Deno.test("commitAndPushPending - single-branch clone reports an honest 0 after a good push (Issue #211)", async () => {
  const branch = "issue-211-single-branch";
  const { tmp, downstream } = await makeSingleBranchClone(
    "commit_push_pending_single_",
    branch,
  );
  try {
    await Deno.writeTextFile(`${downstream}/fix.txt`, "ci fix\n");

    const result = await commitAndPush(
      branch,
      "Fix CI failure: Quality Checks",
      downstream,
    );

    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );
    if (result.ok) {
      assertEquals(result.value.committedNewChanges, true);
      assertEquals(
        result.value.commitsPushed,
        1,
        "only the new commit was pushed — the branch's pre-existing commit was already on origin",
      );
      assertEquals(
        result.value.finalUnpushedCount,
        0,
        "a successful push must not report commits-ahead-of-the-default-branch as unpushed",
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - single-branch clone with nothing to do reports 0 pushed and 0 unpushed (Issue #211)", async () => {
  const branch = "issue-211-single-branch-sync";
  const { tmp, downstream } = await makeSingleBranchClone(
    "commit_push_pending_single_sync_",
    branch,
  );
  try {
    const result = await commitAndPush(
      branch,
      "Fix CI failure: Quality Checks",
      downstream,
    );

    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );
    if (result.ok) {
      assertEquals(result.value.committedNewChanges, false);
      assertEquals(result.value.commitsPushed, 0);
      assertEquals(result.value.finalUnpushedCount, 0);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - reports finalUnpushedCount=0 after successful push", async () => {
  // Sanity check: after the helper returns ok, callers can rely on
  // finalUnpushedCount===0 to know nothing remains unpushed.
  const branch = "issue-1643-honest";
  const { tmp, downstream } = await makeUpstreamAndDownstream(
    "commit_push_pending_honest_",
    branch,
  );
  try {
    await Deno.writeTextFile(`${downstream}/x.txt`, "x\n");

    const result = await commitAndPush(
      branch,
      "Auto-commit pending changes",
      downstream,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.finalUnpushedCount, 0);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

/**
 * The three worker-owned state files the worker itself can drop into a clone
 * (Issue #1661). Each is untracked and unignored in these temp repos, so
 * `git add -A` stages all three unless the chokepoint unstages them.
 */
const WORKER_STATE_FILES = [
  ".heartbeat_stSoftwareAU_VibeCoder_1661",
  ".heartbeat-marker_stSoftwareAU_VibeCoder_1661",
  ".vibe_default_branch",
];

/** Drop all three worker state files into a clone. */
async function plantWorkerStateFiles(dir: string): Promise<void> {
  for (const name of WORKER_STATE_FILES) {
    await Deno.writeTextFile(`${dir}/${name}`, "worker state\n");
  }
}

/** Run `body` with `console.warn` captured rather than printed. */
async function withCapturedWarnings(
  body: () => Promise<void>,
): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await body();
  } finally {
    console.warn = original;
  }
  return warnings;
}

Deno.test("commitAndPushPending - unstages worker state files and still commits the real change (Issue #1661)", async () => {
  const branch = "issue-1661-worker-state";
  const { tmp, downstream } = await makeUpstreamAndDownstream(
    "commit_push_pending_worker_state_",
    branch,
  );
  try {
    await plantWorkerStateFiles(downstream);
    await Deno.writeTextFile(`${downstream}/feature.txt`, "feature work\n");

    let result: Awaited<ReturnType<typeof commitAndPush>> | undefined;
    const warnings = await withCapturedWarnings(async () => {
      result = await commitAndPush(
        branch,
        "Auto-commit pending changes (Issue #1661)",
        downstream,
      );
    });

    assert(result, "expected the chokepoint to return a result");
    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );
    if (result.ok) {
      assertEquals(result.value.committedNewChanges, true);
      assertEquals(result.value.commitsPushed, 1);
      assertEquals(result.value.finalUnpushedCount, 0);
    }

    // The commit carries the real change and none of the worker state.
    const committed = await runGit(
      ["show", "--name-only", "--format=", "HEAD"],
      downstream,
    );
    assert(
      committed.stdout.includes("feature.txt"),
      `expected feature.txt in the commit, got:\n${committed.stdout}`,
    );
    for (const name of WORKER_STATE_FILES) {
      assert(
        !committed.stdout.includes(name),
        `${name} must not be in the commit, got:\n${committed.stdout}`,
      );
    }

    // Unstaged, not deleted — all three are still on disk, still untracked.
    for (const name of WORKER_STATE_FILES) {
      const stat = await Deno.stat(`${downstream}/${name}`);
      assert(stat.isFile, `${name} must still exist on disk`);
    }

    // Each unstaged path is named in a warning — the file being in the tree
    // is itself a bug worth seeing.
    const warned = warnings.join("\n");
    for (const name of WORKER_STATE_FILES) {
      assert(
        warned.includes(name),
        `expected a warning naming ${name}, got:\n${warned}`,
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - still refuses a staged secret when worker state is present (Issue #1661)", async () => {
  const branch = "issue-1661-secret-still-refused";
  const { tmp, downstream } = await makeUpstreamAndDownstream(
    "commit_push_pending_worker_state_secret_",
    branch,
  );
  try {
    await plantWorkerStateFiles(downstream);
    await Deno.writeTextFile(`${downstream}/feature.txt`, "feature work\n");
    await Deno.writeTextFile(`${downstream}/.env`, "API_KEY=leak\n");

    let result: Awaited<ReturnType<typeof commitAndPush>> | undefined;
    await withCapturedWarnings(async () => {
      result = await commitAndPush(
        branch,
        "Auto-commit pending changes",
        downstream,
      );
    });

    assert(result, "expected the chokepoint to return a result");
    assert(!result.ok, "expected the #1758 safety gate to refuse the commit");
    if (!result.ok) {
      const message = result.error.message;
      assert(
        message.includes("Issue #1758") && message.includes(".env"),
        `expected the unchanged #1758 refusal naming .env, got: ${message}`,
      );
      for (const name of WORKER_STATE_FILES) {
        assert(
          !message.includes(name),
          `${name} must not be named by the refusal, got: ${message}`,
        );
      }
    }

    const remoteLog = await runGit(
      ["log", "--format=%s", `origin/${branch}`],
      downstream,
    );
    assert(
      !remoteLog.stdout.includes("Auto-commit pending changes"),
      `secret-bearing commit must not have been pushed, got log:\n${remoteLog.stdout}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - makes no commit when only worker state is pending (Issue #1661)", async () => {
  const branch = "issue-1661-worker-state-only";
  const { tmp, downstream } = await makeUpstreamAndDownstream(
    "commit_push_pending_worker_state_only_",
    branch,
  );
  try {
    await plantWorkerStateFiles(downstream);
    const headBefore = await runGit(["rev-parse", "HEAD"], downstream);

    let result: Awaited<ReturnType<typeof commitAndPush>> | undefined;
    await withCapturedWarnings(async () => {
      result = await commitAndPush(
        branch,
        "Auto-commit pending changes",
        downstream,
      );
    });

    assert(result, "expected the chokepoint to return a result");
    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );
    if (result.ok) {
      assertEquals(result.value.committedNewChanges, false);
      assertEquals(result.value.commitsPushed, 0);
      assertEquals(result.value.finalUnpushedCount, 0);
    }

    // No commit was made — HEAD is exactly where it was.
    const headAfter = await runGit(["rev-parse", "HEAD"], downstream);
    assertEquals(headAfter.stdout.trim(), headBefore.stdout.trim());

    // Nothing left staged, and the files are still on disk.
    const stagedAfter = await runGit(
      ["diff", "--cached", "--name-only"],
      downstream,
    );
    assertEquals(stagedAfter.stdout.trim(), "");
    for (const name of WORKER_STATE_FILES) {
      const stat = await Deno.stat(`${downstream}/${name}`);
      assert(stat.isFile, `${name} must still exist on disk`);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
