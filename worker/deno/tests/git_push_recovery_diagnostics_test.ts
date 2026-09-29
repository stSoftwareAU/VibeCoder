/**
 * Push-recovery diagnostics (Issue #211, #2808).
 *
 * A rejected push used to end with a bare "Push failed after recovery
 * attempt" line: which recovery step gave up and what git actually said were
 * both discarded, so an operator reading the log had nothing to act on.
 * Recovery failures must name the step — `fetch`, `merge`, `retry-push` or
 * `confirm-push` — and carry git's own stderr. No failure path may force or
 * rebase.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { recoverFromPushRejection } from "../lib/git_push_recovery.ts";
import {
  commitFile,
  git,
  setupDivergedRepos,
} from "./support/push_recovery_repos.ts";
import {
  type GitTraceRecorder,
  isForcedPush,
  recordedPushes,
  recordedRebase,
  startGitTrace,
} from "./support/git_trace.ts";

/** No recorded push forced and no command rebased (Issue #2808). */
async function assertNeverForcedOrRebased(
  trace: GitTraceRecorder,
): Promise<void> {
  const pushes = await recordedPushes(trace);
  assert(!pushes.some(isForcedPush), `forced push: ${JSON.stringify(pushes)}`);
  assertEquals(await recordedRebase(trace), false, "recovery must not rebase");
  const pulls = (await trace.commands()).filter((argv) => argv[0] === "pull");
  assertEquals(pulls, [], "recovery must not pull (or pull --rebase)");
}

Deno.test("recoverFromPushRejection - a merge blocked by an untracked clash names the merge step and git's stderr (Issue #211)", async () => {
  const repos = await setupDivergedRepos("other.txt", "other author work\n");
  const trace = await startGitTrace();
  try {
    // Local commit plus an untracked file that the sibling's commit also adds:
    // the merge refuses to overwrite it, and nothing may be pushed past it.
    await commitFile(repos.workerPath, "worker.txt", "worker work\n");
    await Deno.writeTextFile(
      `${repos.workerPath}/other.txt`,
      "untracked clash\n",
    );

    const result = await recoverFromPushRejection(repos.branch, {
      cwd: repos.workerPath,
      env: trace.env,
    });

    assertEquals(result.ok, false, "the recovery attempt must fail");
    if (!result.ok) {
      const message = result.error.message;
      assert(
        message.includes("Push recovery step 'merge' failed"),
        `error must name the recovery step that failed, got: ${message}`,
      );
      assert(
        /untracked working tree files would be overwritten/i.test(message),
        `error must carry git's own stderr, got: ${message}`,
      );
    }
    assertEquals(
      await git(["rev-parse", `refs/heads/${repos.branch}`], repos.remotePath),
      repos.otherSha,
    );
    assertEquals((await recordedPushes(trace)).length, 0);
    await assertNeverForcedOrRebased(trace);
  } finally {
    await trace.dispose();
    await Deno.remove(repos.tmpDir, { recursive: true });
  }
});

Deno.test("recoverFromPushRejection - a rejected retry names the retry-push step and git's stderr (Issue #2808)", async () => {
  const repos = await setupDivergedRepos("other.txt", "other work\n");
  const trace = await startGitTrace();
  try {
    await commitFile(repos.workerPath, "worker.txt", "worker work\n");
    // The remote refuses every further push, so the plain retry is rejected.
    const hook = `${repos.remotePath}/hooks/pre-receive`;
    await Deno.writeTextFile(
      hook,
      "#!/bin/sh\necho 'branch is frozen for review' >&2\nexit 1\n",
    );
    await Deno.chmod(hook, 0o755);

    const result = await recoverFromPushRejection(repos.branch, {
      cwd: repos.workerPath,
      env: trace.env,
    });

    assertEquals(result.ok, false, "an unconfirmed push is not a success");
    if (!result.ok) {
      const message = result.error.message;
      assert(
        message.includes("Push recovery step 'retry-push' failed"),
        `error must name the recovery step that failed, got: ${message}`,
      );
      assert(
        message.includes("branch is frozen for review"),
        `error must carry git's own stderr, got: ${message}`,
      );
    }
    assertEquals(
      await git(["rev-parse", `refs/heads/${repos.branch}`], repos.remotePath),
      repos.otherSha,
    );
    assertEquals((await recordedPushes(trace)).length, 1, "one plain retry");
    await assertNeverForcedOrRebased(trace);
  } finally {
    await trace.dispose();
    await Deno.remove(repos.tmpDir, { recursive: true });
  }
});

Deno.test("recoverFromPushRejection - a push the remote does not keep fails the confirm-push step (Issue #2808)", async () => {
  const repos = await setupDivergedRepos("other.txt", "other work\n");
  const trace = await startGitTrace();
  try {
    await commitFile(repos.workerPath, "worker.txt", "worker work\n");
    // The push is accepted, then the branch is moved straight back: git
    // reports success, but the work is not on the remote.
    const hook = `${repos.remotePath}/hooks/post-receive`;
    await Deno.writeTextFile(
      hook,
      `#!/bin/sh\ngit update-ref refs/heads/${repos.branch} ${repos.otherSha}\n`,
    );
    await Deno.chmod(hook, 0o755);

    const result = await recoverFromPushRejection(repos.branch, {
      cwd: repos.workerPath,
      env: trace.env,
    });

    assertEquals(result.ok, false, "an unconfirmed push is not a success");
    if (!result.ok) {
      assert(
        result.error.message.includes(
          "Push recovery step 'confirm-push' failed",
        ),
        `error must name the recovery step that failed, got: ${result.error.message}`,
      );
    }
    assertEquals((await recordedPushes(trace)).length, 1, "one plain retry");
    await assertNeverForcedOrRebased(trace);
  } finally {
    await trace.dispose();
    await Deno.remove(repos.tmpDir, { recursive: true });
  }
});

Deno.test("recoverFromPushRejection - an unreachable remote names the fetch step (Issue #211)", async () => {
  const repos = await setupDivergedRepos("other.txt", "other work\n");
  const trace = await startGitTrace();
  try {
    await commitFile(repos.workerPath, "local.txt", "local\n");
    await git(
      ["remote", "set-url", "origin", `${repos.tmpDir}/missing.git`],
      repos.workerPath,
    );

    const result = await recoverFromPushRejection(repos.branch, {
      cwd: repos.workerPath,
      env: trace.env,
    });

    assertEquals(result.ok, false);
    if (!result.ok) {
      assert(
        result.error.message.includes("Push recovery step 'fetch' failed"),
        `error must name the step it failed at, got: ${result.error.message}`,
      );
      assert(
        result.error.message.includes("missing.git"),
        `error must carry git's own stderr, got: ${result.error.message}`,
      );
    }
    assertEquals((await recordedPushes(trace)).length, 0);
    await assertNeverForcedOrRebased(trace);
  } finally {
    await trace.dispose();
    await Deno.remove(repos.tmpDir, { recursive: true });
  }
});
