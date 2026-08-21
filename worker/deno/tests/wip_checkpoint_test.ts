/**
 * Tests for periodic WIP checkpoint commits (Issue #4170).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  preserveTimedOutWip,
  startWipCheckpoints,
  WIP_CHECKPOINT_COMMIT_MESSAGE,
  type WipCheckpointOutcome,
} from "../lib/wip_checkpoint.ts";
import type { Result } from "../types.ts";
import type { CommitAndPushPendingResult } from "../lib/git_push.ts";

function okPush(
  committed: boolean,
  pushed: number,
): Result<CommitAndPushPendingResult> {
  return {
    ok: true,
    value: {
      committedNewChanges: committed,
      commitsPushed: pushed,
      finalUnpushedCount: 0,
      finalUnpushedSource: "remote-head",
    },
  };
}

Deno.test("wip_checkpoint - runNow commits and pushes dirty work, then notifies", async () => {
  const calls: Array<{ branch: string; message: string }> = [];
  let notified = 0;
  const handle = startWipCheckpoints({
    repoPath: "/repo",
    branchName: "issue-4170-x",
    onCheckpoint: () => {
      notified++;
    },
    deps: {
      currentBranch: () => Promise.resolve("issue-4170-x"),
      commitAndPush: (branch, message) => {
        calls.push({ branch, message });
        return Promise.resolve(okPush(true, 1));
      },
    },
  });
  try {
    const outcome = await handle.runNow();
    assertEquals(outcome.kind, "pushed");
    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.branch, "issue-4170-x");
    assertEquals(calls[0]!.message, WIP_CHECKPOINT_COMMIT_MESSAGE);
    assertEquals(notified, 1);
  } finally {
    handle.stop();
  }
});

Deno.test("wip_checkpoint - a clean tree still refreshes the checkpoint marker", async () => {
  let notified = 0;
  const handle = startWipCheckpoints({
    repoPath: "/repo",
    branchName: "issue-4170-x",
    onCheckpoint: () => {
      notified++;
    },
    deps: {
      currentBranch: () => Promise.resolve("issue-4170-x"),
      commitAndPush: () => Promise.resolve(okPush(false, 0)),
    },
  });
  try {
    const outcome = await handle.runNow();
    assertEquals(outcome.kind, "clean");
    assertEquals(notified, 1);
  } finally {
    handle.stop();
  }
});

Deno.test("wip_checkpoint - skips when HEAD is not the issue branch", async () => {
  let pushes = 0;
  const handle = startWipCheckpoints({
    repoPath: "/repo",
    branchName: "issue-4170-x",
    deps: {
      currentBranch: () => Promise.resolve("some-detached-state"),
      commitAndPush: () => {
        pushes++;
        return Promise.resolve(okPush(true, 1));
      },
    },
  });
  try {
    const outcome = await handle.runNow();
    assertEquals(outcome.kind, "skipped");
    assertEquals(pushes, 0);
  } finally {
    handle.stop();
  }
});

Deno.test("wip_checkpoint - refuses to checkpoint a protected branch", async () => {
  let pushes = 0;
  const handle = startWipCheckpoints({
    repoPath: "/repo",
    branchName: "main",
    deps: {
      currentBranch: () => Promise.resolve("main"),
      commitAndPush: () => {
        pushes++;
        return Promise.resolve(okPush(true, 1));
      },
    },
  });
  try {
    const outcome = await handle.runNow();
    assertEquals(outcome.kind, "skipped");
    assert(outcome.kind === "skipped");
    assertStringIncludes(outcome.reason, "protected");
    assertEquals(pushes, 0);
  } finally {
    handle.stop();
  }
});

Deno.test("wip_checkpoint - a git failure is reported, warned, and never thrown", async () => {
  const warnings: string[] = [];
  const handle = startWipCheckpoints({
    repoPath: "/repo",
    branchName: "issue-4170-x",
    logger: {
      info: () => undefined,
      warn: (m: string) => warnings.push(m),
    },
    deps: {
      currentBranch: () => Promise.resolve("issue-4170-x"),
      commitAndPush: () =>
        Promise.resolve({
          ok: false as const,
          error: new Error("index.lock held by the agent"),
        }),
    },
  });
  try {
    const outcome = await handle.runNow();
    assertEquals(outcome.kind, "failed");
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "index.lock");
  } finally {
    handle.stop();
  }
});

Deno.test("wip_checkpoint - the interval timer fires checkpoints until stopped", async () => {
  let ticks = 0;
  const handle = startWipCheckpoints({
    repoPath: "/repo",
    branchName: "issue-4170-x",
    intervalMs: 20,
    deps: {
      currentBranch: () => Promise.resolve("issue-4170-x"),
      commitAndPush: () => {
        ticks++;
        return Promise.resolve(okPush(false, 0));
      },
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert(ticks >= 2, `expected at least 2 interval ticks, got ${ticks}`);
  } finally {
    handle.stop();
  }
  const after = ticks;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(ticks, after, "checkpoints must stop after stop()");
});

Deno.test("wip_checkpoint - overlapping runs are collapsed, not queued", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const handle = startWipCheckpoints({
    repoPath: "/repo",
    branchName: "issue-4170-x",
    deps: {
      currentBranch: () => Promise.resolve("issue-4170-x"),
      commitAndPush: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight--;
        return okPush(false, 0);
      },
    },
  });
  try {
    const outcomes: WipCheckpointOutcome[] = await Promise.all([
      handle.runNow(),
      handle.runNow(),
    ]);
    assertEquals(maxInFlight, 1);
    assert(outcomes.some((o) => o.kind === "skipped"));
  } finally {
    handle.stop();
  }
});

// ---------------------------------------------------------------------------
// Pre-OOM checkpoint on guest memory pressure (Issue #4301)
// ---------------------------------------------------------------------------

Deno.test("wip_checkpoint - high memory pressure triggers one early checkpoint per episode (Issue #4301)", async () => {
  let pushes = 0;
  const warnings: string[] = [];
  let level: "ok" | "high" = "high";
  const handle = startWipCheckpoints({
    repoPath: "/repo",
    branchName: "issue-4301-x",
    intervalMs: 10_000, // regular tick never fires in this test
    pressureProbeIntervalMs: 15,
    probeMemory: () =>
      Promise.resolve({
        level,
        totalBytes: 1000,
        availableBytes: level === "high" ? 50 : 500,
      }),
    logger: {
      info: () => undefined,
      warn: (m: string) => warnings.push(m),
    },
    deps: {
      currentBranch: () => Promise.resolve("issue-4301-x"),
      commitAndPush: () => {
        pushes++;
        return Promise.resolve(okPush(true, 1));
      },
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Sustained pressure: exactly one early checkpoint, not one per probe.
    assertEquals(pushes, 1);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "memory pressure high");
    // Pressure clears, then returns: a new episode, one more checkpoint.
    level = "ok";
    await new Promise((resolve) => setTimeout(resolve, 40));
    level = "high";
    await new Promise((resolve) => setTimeout(resolve, 60));
    assertEquals(pushes, 2);
  } finally {
    handle.stop();
  }
});

Deno.test("wip_checkpoint - an unknown pressure reading (non-Linux) never checkpoints (Issue #4301)", async () => {
  let pushes = 0;
  const handle = startWipCheckpoints({
    repoPath: "/repo",
    branchName: "issue-4301-x",
    intervalMs: 10_000,
    pressureProbeIntervalMs: 10,
    probeMemory: () => Promise.resolve({ level: "unknown" }),
    deps: {
      currentBranch: () => Promise.resolve("issue-4301-x"),
      commitAndPush: () => {
        pushes++;
        return Promise.resolve(okPush(true, 1));
      },
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assertEquals(pushes, 0);
  } finally {
    handle.stop();
  }
});

// ---------------------------------------------------------------------------
// One-shot preservation for a timed-out execute (Issue #47)
// ---------------------------------------------------------------------------

Deno.test("preserveTimedOutWip #47 - pushes the dirty tree with the caller's message", async () => {
  const calls: Array<{ branch: string; message: string }> = [];
  const outcome = await preserveTimedOutWip({
    repoPath: "/repo",
    branchName: "issue-47-x",
    message:
      "wip: execute timed out after 2012s at the cycle deadline (Issue #47)",
    deps: {
      currentBranch: () => Promise.resolve("issue-47-x"),
      commitAndPush: (branch, message) => {
        calls.push({ branch, message });
        return Promise.resolve(okPush(true, 1));
      },
    },
  });
  assertEquals(outcome.kind, "pushed");
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.branch, "issue-47-x");
  assertStringIncludes(calls[0]?.message ?? "", "timed out after 2012s");
});

Deno.test("preserveTimedOutWip #47 - refuses when HEAD is not the issue branch", async () => {
  let pushed = 0;
  const outcome = await preserveTimedOutWip({
    repoPath: "/repo",
    branchName: "issue-47-x",
    message: "wip: timed out",
    deps: {
      currentBranch: () => Promise.resolve("main"),
      commitAndPush: () => {
        pushed++;
        return Promise.resolve(okPush(true, 1));
      },
    },
  });
  assertEquals(outcome.kind, "skipped");
  assertEquals(
    pushed,
    0,
    "a checkpoint must never commit another branch's state",
  );
});

Deno.test("preserveTimedOutWip #47 - refuses a protected branch outright", async () => {
  let pushed = 0;
  const outcome = await preserveTimedOutWip({
    repoPath: "/repo",
    branchName: "main",
    message: "wip: timed out",
    deps: {
      currentBranch: () => Promise.resolve("main"),
      commitAndPush: () => {
        pushed++;
        return Promise.resolve(okPush(true, 1));
      },
    },
  });
  assertEquals(outcome.kind, "skipped");
  assertEquals(pushed, 0);
});

Deno.test("preserveTimedOutWip #47 - a failed push is reported, not thrown", async () => {
  const outcome = await preserveTimedOutWip({
    repoPath: "/repo",
    branchName: "issue-47-x",
    message: "wip: timed out",
    deps: {
      currentBranch: () => Promise.resolve("issue-47-x"),
      commitAndPush: () =>
        Promise.resolve({ ok: false, error: new Error("remote hung up") }),
    },
  });
  assertEquals(outcome.kind, "failed");
  assert(
    outcome.kind === "failed" && outcome.reason.includes("remote hung up"),
  );
});
