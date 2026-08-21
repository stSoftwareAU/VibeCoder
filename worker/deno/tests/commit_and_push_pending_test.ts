/**
 * Tests for commitAndPushPending — final-mile push guard (Issue #1643).
 *
 * Verifies that the helper commits any uncommitted changes, pushes any
 * unpushed commits, and reports the final state honestly so callers can
 * detect "we forgot to push" scenarios.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { commitAndPushPending } from "../lib/git_push.ts";

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

    const result = await commitAndPushPending(
      branch,
      "Auto-commit pending changes (Issue #1643)",
      { cwd: downstream },
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

    const result = await commitAndPushPending(
      branch,
      "Auto-commit pending changes",
      { cwd: downstream },
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
    const result = await commitAndPushPending(
      branch,
      "Auto-commit pending changes",
      { cwd: downstream },
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

    const result = await commitAndPushPending(
      branch,
      "Auto-commit pending changes (Issue #1643)",
      { cwd: downstream },
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

    const result = await commitAndPushPending(
      branch,
      "Auto-commit pending changes",
      { cwd: downstream },
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
  const originalRunId = Deno.env.get("VIBE_RUN_ID");
  try {
    Deno.env.set("VIBE_RUN_ID", "vibe-test-trailer-abc123");
    await Deno.writeTextFile(`${downstream}/feature.txt`, "feature work\n");

    const result = await commitAndPushPending(
      branch,
      "Implement feature (Issue #2381)",
      { cwd: downstream },
    );
    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );

    // The committed message must carry the run-id trailer so the push is
    // traceable back to its originating worker run.
    const log = await runGit(["log", "-1", "--format=%B"], downstream);
    assert(
      log.stdout.includes("Vibe-Coder-Run-Id: vibe-test-trailer-abc123"),
      `expected run-id trailer in commit message, got:\n${log.stdout}`,
    );
  } finally {
    if (originalRunId === undefined) Deno.env.delete("VIBE_RUN_ID");
    else Deno.env.set("VIBE_RUN_ID", originalRunId);
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

    const result = await commitAndPushPending(
      branch,
      "Auto-commit pending changes",
      { cwd: downstream },
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.finalUnpushedCount, 0);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("commitAndPushPending - never reports commits as pushed while they remain unpushed (Issue #211)", async () => {
  // The incident shape from NEAT-AI-core#557: `commitsPushed=4` logged beside
  // `finalUnpushedCount=4`. It happens when HEAD carries commits the branch ref
  // does not (an interrupted rebase leaves HEAD detached), so `git push` reports
  // "Everything up-to-date" while the work is still local.
  const branch = "issue-211-honest-count";
  const { tmp, downstream } = await makeUpstreamAndDownstream(
    "commit_push_pending_honest_count_",
    branch,
  );
  try {
    await runGit(["checkout", "--detach"], downstream);
    await Deno.writeTextFile(`${downstream}/detached-1.txt`, "one\n");
    await runGit(["add", "-A"], downstream);
    await runGit(["commit", "-m", "detached one"], downstream);
    await Deno.writeTextFile(`${downstream}/detached-2.txt`, "two\n");
    await runGit(["add", "-A"], downstream);
    await runGit(["commit", "-m", "detached two"], downstream);

    const result = await commitAndPushPending(
      branch,
      "Auto-commit pending changes",
      { cwd: downstream },
    );

    assert(result.ok);
    if (result.ok) {
      const { commitsPushed, finalUnpushedCount } = result.value;
      assertEquals(finalUnpushedCount, 2, "the work is still local");
      assertEquals(
        commitsPushed,
        0,
        "no commit landed, so none may be reported as pushed",
      );
      assert(
        commitsPushed + finalUnpushedCount <= 2,
        "the counts must not double-count the same commits",
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
