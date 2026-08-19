/**
 * WHAT-tests for `recoverStuckIssue` (Issue #3039).
 *
 * `recoverStuckIssue` is the load-bearing step of the self-healing recovery
 * path (Issue #471): it performs three observable, irreversible side effects —
 * unassign the worker, post the "Automatic recovery" comment, and clear the
 * heartbeat file. These tests assert the observable outcome (which assignee is
 * removed, the comment body, and that the heartbeat is gone) via an injected
 * `gh` runner and a temp work directory, so they survive a reimplementation of
 * the gh plumbing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  detectAndRecoverStuckHeartbeats,
  recoverStuckIssue,
} from "../lib/stuck_recovery.ts";
import { heartbeatFilePath } from "../lib/heartbeat_storage.ts";

Deno.test("recoverStuckIssue - unassigns the worker first", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const calls: string[][] = [];
    const fakeGh = (args: string[]): Promise<string> => {
      calls.push(args);
      return Promise.resolve("");
    };

    await recoverStuckIssue(
      workDir,
      "org/repo",
      42,
      "worker-bot",
      1800,
      fakeGh,
    );

    assertEquals(calls[0], [
      "issue",
      "edit",
      "42",
      "--repo",
      "org/repo",
      "--remove-assignee",
      "worker-bot",
    ]);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverStuckIssue - posts the recovery comment with the right body", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const calls: string[][] = [];
    const fakeGh = (args: string[]): Promise<string> => {
      calls.push(args);
      return Promise.resolve("");
    };

    await recoverStuckIssue(
      workDir,
      "org/repo",
      42,
      "worker-bot",
      1800,
      fakeGh,
    );

    // Second call is the comment.
    assertEquals(calls[1]!.slice(0, 5), [
      "issue",
      "comment",
      "42",
      "--repo",
      "org/repo",
    ]);
    const body = calls[1]!.at(-1)!;
    assertStringIncludes(body, "Automatic recovery");
    // 1800s / 60 = 30 minutes.
    assertStringIncludes(body, "30 minutes");
    assertStringIncludes(body, "worker-bot");
    assertStringIncludes(body, "Self-healing recovery (Issue #471)");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverStuckIssue - clears the heartbeat file", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const path = heartbeatFilePath(workDir, "org/repo", 42);
    await Deno.writeTextFile(path, "heartbeat");
    // Sanity: the file exists before recovery.
    assertEquals((await Deno.stat(path)).isFile, true);

    const fakeGh = (_args: string[]): Promise<string> => Promise.resolve("");
    const result = await recoverStuckIssue(
      workDir,
      "org/repo",
      42,
      "worker-bot",
      1800,
      fakeGh,
    );

    assertEquals(result.ok, true);

    // The heartbeat file is gone after recovery.
    let exists = true;
    try {
      await Deno.stat(path);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverStuckIssue - computes minutes via floor division", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const calls: string[][] = [];
    const fakeGh = (args: string[]): Promise<string> => {
      calls.push(args);
      return Promise.resolve("");
    };

    // 1799s / 60 floors to 29 minutes.
    await recoverStuckIssue(workDir, "org/repo", 7, "bot", 1799, fakeGh);

    const body = calls[1]!.at(-1)!;
    assertStringIncludes(body, "29 minutes");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverStuckIssue - performs the three steps in order", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const path = heartbeatFilePath(workDir, "org/repo", 99);
    await Deno.writeTextFile(path, "heartbeat");

    const order: string[] = [];
    const fakeGh = (args: string[]): Promise<string> => {
      // First two gh calls: unassign, then comment.
      order.push(args[1] ?? ""); // "edit" or "comment"
      return Promise.resolve("");
    };

    await recoverStuckIssue(workDir, "org/repo", 99, "bot", 600, fakeGh);

    // Unassign before comment.
    assertEquals(order, ["edit", "comment"]);
    // Heartbeat cleared last.
    let exists = true;
    try {
      await Deno.stat(path);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Container-mode start-up sweep (Issue #4241)
// ---------------------------------------------------------------------------

Deno.test("detectAndRecoverStuckHeartbeats - sweepAllHeartbeats recovers a young heartbeat (Issue #4241)", async () => {
  // On the durable volume a dead container's heartbeat no longer dies with
  // its writer, and the age gate left #4207 wedged for hours under
  // `skipped:has_local_heartbeat`. One worker per container is structural,
  // so at container start every heartbeat is a dead run's — swept.
  const workDir = await Deno.makeTempDir();
  try {
    const nowEpoch = 1_786_000_000;
    await Deno.writeTextFile(
      `${workDir}/.heartbeat_org_repo_42`,
      `${nowEpoch - 30}`, // 30 seconds old — far inside the stuck timeout
    );
    const calls: string[][] = [];
    const recovered = await detectAndRecoverStuckHeartbeats(
      {
        workDir,
        stuckIssueTimeout: 7200,
        assignedNoHeartbeatTimeout: 1800,
        staleAssignmentTimeout: 14400,
        repos: ["org/repo"],
      },
      "worker-bot",
      () => nowEpoch,
      {
        sweepAllHeartbeats: true,
        ghCommandFn: (args) => {
          calls.push(args);
          return Promise.resolve("");
        },
      },
    );
    assertEquals(recovered, 1);
    assertEquals(calls[0]?.slice(0, 2), ["issue", "edit"]);
    // The heartbeat file itself is gone — nothing left to suppress recovery.
    let gone = false;
    try {
      await Deno.stat(`${workDir}/.heartbeat_org_repo_42`);
    } catch {
      gone = true;
    }
    assertEquals(gone, true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("detectAndRecoverStuckHeartbeats - without the sweep a young heartbeat is honoured (Issue #4241)", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const nowEpoch = 1_786_000_000;
    await Deno.writeTextFile(
      `${workDir}/.heartbeat_org_repo_42`,
      `${nowEpoch - 30}`,
    );
    const calls: string[][] = [];
    const recovered = await detectAndRecoverStuckHeartbeats(
      {
        workDir,
        stuckIssueTimeout: 7200,
        assignedNoHeartbeatTimeout: 1800,
        staleAssignmentTimeout: 14400,
        repos: ["org/repo"],
      },
      "worker-bot",
      () => nowEpoch,
      {
        ghCommandFn: (args) => {
          calls.push(args);
          return Promise.resolve("");
        },
      },
    );
    // Native-mode semantics unchanged: a young heartbeat is a live claim.
    assertEquals(recovered, 0);
    assertEquals(calls, []);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
