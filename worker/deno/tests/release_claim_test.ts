/**
 * Tests for releaseClaim — the single claim-release helper that unassigns the
 * worker AND clears the heartbeat/marker (Issue #2670).
 *
 * Regression cover for incident stSoftwareAU/VibeCoder#2648: a released claim
 * must never leave the worker assigned. Both steps are best-effort and
 * independent — a failure in one must not abort the other.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  heartbeatFilePath,
  recordHeartbeat,
  releaseClaim,
} from "../lib/heartbeat_storage.ts";

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "release-claim-test-" });
}

Deno.test("releaseClaim - unassigns the worker and clears the heartbeat", async () => {
  const dir = await makeTempDir();
  try {
    await recordHeartbeat(dir, "org/repo", 42);

    const ghCalls: string[][] = [];
    const ghFn = (args: string[]): Promise<string> => {
      ghCalls.push(args);
      return Promise.resolve("");
    };

    const result = await releaseClaim(dir, "org/repo", 42, {
      githubUser: "vibe-bot",
      ghFn,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.unassigned, true);
      assertEquals(result.value.heartbeatCleared, true);
    }

    // The gh unassign call removes only the worker's own assignment.
    assertEquals(ghCalls.length, 1);
    assertEquals(ghCalls[0], [
      "issue",
      "edit",
      "42",
      "--repo",
      "org/repo",
      "--remove-assignee",
      "vibe-bot",
    ]);

    // Heartbeat file is gone.
    let stillExists = true;
    try {
      await Deno.stat(heartbeatFilePath(dir, "org/repo", 42));
    } catch {
      stillExists = false;
    }
    assertEquals(stillExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("releaseClaim - unassign failure still clears the heartbeat", async () => {
  const dir = await makeTempDir();
  try {
    await recordHeartbeat(dir, "org/repo", 7);

    const ghFn = (_args: string[]): Promise<string> => {
      throw new Error("gh exploded");
    };

    const result = await releaseClaim(dir, "org/repo", 7, {
      githubUser: "vibe-bot",
      ghFn,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      // Unassign failed but cleanup still ran.
      assertEquals(result.value.unassigned, false);
      assertEquals(result.value.heartbeatCleared, true);
    }

    let stillExists = true;
    try {
      await Deno.stat(heartbeatFilePath(dir, "org/repo", 7));
    } catch {
      stillExists = false;
    }
    assertEquals(
      stillExists,
      false,
      "heartbeat cleared despite unassign failure",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("releaseClaim - unassign still runs when there is no heartbeat file", async () => {
  const dir = await makeTempDir();
  try {
    const ghCalls: string[][] = [];
    const ghFn = (args: string[]): Promise<string> => {
      ghCalls.push(args);
      return Promise.resolve("");
    };

    // No recordHeartbeat — nothing to clear, but the unassign must still fire
    // so a released claim is never left assigned.
    const result = await releaseClaim(dir, "org/repo", 99, {
      githubUser: "vibe-bot",
      ghFn,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.unassigned, true);
      assertEquals(result.value.heartbeatCleared, true);
    }
    assertEquals(ghCalls.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("releaseClaim - skips unassign when githubUser is empty", async () => {
  const dir = await makeTempDir();
  try {
    let ghCalled = false;
    const ghFn = (_args: string[]): Promise<string> => {
      ghCalled = true;
      return Promise.resolve("");
    };

    const result = await releaseClaim(dir, "org/repo", 5, {
      githubUser: "",
      ghFn,
    });

    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.unassigned, false);
    assert(!ghCalled, "no unassign attempted without a githubUser");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("releaseClaim - double release is harmless (idempotent)", async () => {
  const dir = await makeTempDir();
  try {
    await recordHeartbeat(dir, "org/repo", 11);

    const ghCalls: string[][] = [];
    const ghFn = (args: string[]): Promise<string> => {
      ghCalls.push(args);
      return Promise.resolve("");
    };

    const first = await releaseClaim(dir, "org/repo", 11, {
      githubUser: "vibe-bot",
      ghFn,
    });
    const second = await releaseClaim(dir, "org/repo", 11, {
      githubUser: "vibe-bot",
      ghFn,
    });

    assertEquals(first.ok, true);
    assertEquals(second.ok, true);
    // Both releases issued the (idempotent) unassign call.
    assertEquals(ghCalls.length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
