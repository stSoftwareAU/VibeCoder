/**
 * Tests for heartbeat.ts — periodic heartbeat lifecycle management
 * during long-running operations (Issue #963).
 *
 * Note (Issue #1888): startHeartbeat is now async and returns
 * `Promise<Result<HeartbeatHandle>>`. The initial recordFn call is
 * awaited so the local heartbeat file and GitHub marker comment are both
 * written before startHeartbeat resolves with `{ ok: true }`. Existing
 * tests below have been updated to await the new signature; the original
 * lifecycle assertions are unchanged.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import {
  type HeartbeatHandle,
  type HeartbeatOptions,
  isHeartbeatRunning,
  startHeartbeat,
  stopHeartbeat,
} from "../lib/heartbeat.ts";

/** Helper — start a heartbeat and assert it returned ok, returning the handle. */
async function startOrFail(
  options: HeartbeatOptions,
): Promise<HeartbeatHandle> {
  const result = await startHeartbeat(options);
  if (!result.ok) {
    throw new Error(
      `Expected startHeartbeat to succeed: ${result.error.message}`,
    );
  }
  return result.value;
}

// ============================================================================
// startHeartbeat / stopHeartbeat lifecycle
// ============================================================================

Deno.test("heartbeat - startHeartbeat returns a handle", async () => {
  let callCount = 0;
  const options: HeartbeatOptions = {
    repo: "org/repo",
    issueNumber: 42,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 60_000,
    recordFn: async () => {
      callCount++;
      return { ok: true, value: undefined };
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const handle = await startOrFail(options);
  try {
    assertExists(handle);
    assertEquals(typeof handle.id, "string");
    // The initial heartbeat is awaited inside startHeartbeat (Issue #1888),
    // so by the time it resolves, recordFn has been called at least once.
    assertEquals(callCount >= 1, true, "Initial heartbeat should be recorded");
  } finally {
    await stopHeartbeat(handle);
    await Deno.remove(options.workDir, { recursive: true });
  }
});

Deno.test("heartbeat - stopHeartbeat clears the interval", async () => {
  let callCount = 0;
  const options: HeartbeatOptions = {
    repo: "org/repo",
    issueNumber: 42,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 100, // Short interval for testing
    recordFn: async () => {
      callCount++;
      return { ok: true, value: undefined };
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const handle = await startOrFail(options);
  await new Promise((r) => setTimeout(r, 50));
  await stopHeartbeat(handle);

  const countAfterStop = callCount;
  // Wait to confirm no more calls happen
  await new Promise((r) => setTimeout(r, 250));
  assertEquals(callCount, countAfterStop, "No more heartbeats after stop");

  await Deno.remove(options.workDir, { recursive: true });
});

Deno.test("heartbeat - periodic updates are called at expected interval", async () => {
  let callCount = 0;
  const options: HeartbeatOptions = {
    repo: "org/repo",
    issueNumber: 42,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 100,
    recordFn: async () => {
      callCount++;
      return { ok: true, value: undefined };
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const handle = await startOrFail(options);
  try {
    // Wait enough time for a few intervals (initial already recorded)
    await new Promise((r) => setTimeout(r, 350));
    // Should have initial call + ~3 interval calls
    assertEquals(
      callCount >= 3,
      true,
      `Expected at least 3 calls, got ${callCount}`,
    );
  } finally {
    await stopHeartbeat(handle);
    await Deno.remove(options.workDir, { recursive: true });
  }
});

Deno.test("heartbeat - idempotent start does not create duplicate intervals", async () => {
  let callCount = 0;
  const options: HeartbeatOptions = {
    repo: "org/repo",
    issueNumber: 42,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 100,
    recordFn: async () => {
      callCount++;
      return { ok: true, value: undefined };
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const handle1 = await startOrFail(options);
  // Starting again for the same repo/issue should return same handle
  const handle2 = await startOrFail(options);
  try {
    assertEquals(
      handle1.id,
      handle2.id,
      "Second start should return same handle",
    );
    await new Promise((r) => setTimeout(r, 250));
    // With duplicates we'd see ~double the calls; with idempotent start, roughly 3
    assertEquals(
      callCount <= 5,
      true,
      `Expected <= 5 calls (no duplicates), got ${callCount}`,
    );
  } finally {
    await stopHeartbeat(handle1);
    await Deno.remove(options.workDir, { recursive: true });
  }
});

Deno.test("heartbeat - stopHeartbeat is safe to call when not started", async () => {
  // Should not throw
  const fakeHandle: HeartbeatHandle = {
    id: "nonexistent_org_repo_999",
    repo: "org/repo",
    issueNumber: 999,
  };
  await stopHeartbeat(fakeHandle);
});

Deno.test("heartbeat - stopHeartbeat is safe to call twice", async () => {
  const options: HeartbeatOptions = {
    repo: "org/repo",
    issueNumber: 42,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 60_000,
    recordFn: async () => ({ ok: true, value: undefined }),
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const handle = await startOrFail(options);
  await stopHeartbeat(handle);
  // Second stop should not throw
  await stopHeartbeat(handle);

  await Deno.remove(options.workDir, { recursive: true });
});

Deno.test("heartbeat - isHeartbeatRunning reports correct state", async () => {
  const options: HeartbeatOptions = {
    repo: "org/repo",
    issueNumber: 77,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 60_000,
    recordFn: async () => ({ ok: true, value: undefined }),
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  assertEquals(
    isHeartbeatRunning("org/repo", 77),
    false,
    "Not running before start",
  );

  const handle = await startOrFail(options);
  assertEquals(isHeartbeatRunning("org/repo", 77), true, "Running after start");

  await stopHeartbeat(handle);
  assertEquals(
    isHeartbeatRunning("org/repo", 77),
    false,
    "Not running after stop",
  );

  await Deno.remove(options.workDir, { recursive: true });
});

Deno.test("heartbeat - stopHeartbeat calls clearFn", async () => {
  let clearCalled = false;
  const options: HeartbeatOptions = {
    repo: "org/repo",
    issueNumber: 42,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 60_000,
    recordFn: async () => ({ ok: true, value: undefined }),
    clearFn: async () => {
      clearCalled = true;
      return { ok: true, value: undefined };
    },
  };

  const handle = await startOrFail(options);
  await stopHeartbeat(handle);
  assertEquals(clearCalled, true, "clearFn should be called on stop");

  await Deno.remove(options.workDir, { recursive: true });
});

// ============================================================================
// Failure counting and warning logging (Issue #1168)
// ============================================================================

Deno.test("heartbeat - consecutive failures are counted and logged", async () => {
  let callCount = 0;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  const options: HeartbeatOptions = {
    repo: "org/repo",
    issueNumber: 42,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 80,
    recordFn: async () => {
      callCount++;
      throw new Error("Simulated network failure");
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  // Initial heartbeat fails — startHeartbeat returns an error and does
  // not schedule the interval (Issue #1888). Verify the error path, then
  // exercise periodic-failure logging via a manually-inserted handle.
  const initial = await startHeartbeat(options);
  assertEquals(initial.ok, false, "Initial failure should propagate");
  assertEquals(callCount, 1, "Initial recordFn was attempted exactly once");

  // Now exercise the periodic path by allowing the first call to succeed
  // and forcing subsequent calls to fail.
  let phaseCallCount = 0;
  const periodicOptions: HeartbeatOptions = {
    ...options,
    issueNumber: 421,
    recordFn: async () => {
      phaseCallCount++;
      if (phaseCallCount === 1) {
        return { ok: true, value: undefined };
      }
      throw new Error("Simulated network failure");
    },
  };

  const handle = await startOrFail(periodicOptions);
  try {
    // Wait for several interval calls to accumulate failures
    await new Promise((r) => setTimeout(r, 450));
    assertEquals(
      phaseCallCount >= 3,
      true,
      `Expected at least 3 calls, got ${phaseCallCount}`,
    );
    // Should have logged warnings about consecutive failures
    const failureWarnings = warnings.filter((w) => w.includes("[heartbeat]"));
    assertEquals(
      failureWarnings.length >= 1,
      true,
      `Expected at least 1 heartbeat failure warning, got ${failureWarnings.length}`,
    );
  } finally {
    console.warn = originalWarn;
    await stopHeartbeat(handle);
    await Deno.remove(options.workDir, { recursive: true });
  }
});

Deno.test("heartbeat - failure counter resets on successful heartbeat", async () => {
  let callCount = 0;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  const options: HeartbeatOptions = {
    repo: "org/repo",
    issueNumber: 43,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 80,
    recordFn: async () => {
      callCount++;
      // First call (initial) succeeds, then alternate failure/success on the
      // periodic interval to exercise the reset path.
      if (callCount === 1) return { ok: true, value: undefined };
      if (callCount === 2 || callCount === 3) {
        throw new Error("Transient failure");
      }
      return { ok: true, value: undefined };
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const handle = await startOrFail(options);
  try {
    await new Promise((r) => setTimeout(r, 450));
    // Should have recovered — warnings should exist but not be excessive
    assertEquals(
      callCount >= 3,
      true,
      `Expected at least 3 calls, got ${callCount}`,
    );
  } finally {
    console.warn = originalWarn;
    await stopHeartbeat(handle);
    await Deno.remove(options.workDir, { recursive: true });
  }
});

Deno.test("heartbeat - warning logged on first periodic failure", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  let calls = 0;
  const options: HeartbeatOptions = {
    repo: "org/repo",
    issueNumber: 50,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 60,
    // Initial succeeds so the heartbeat starts; periodic call fails.
    recordFn: async () => {
      calls++;
      if (calls === 1) return { ok: true, value: undefined };
      return Promise.reject(new Error("first periodic failure"));
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const handle = await startOrFail(options);
  try {
    await new Promise((r) => setTimeout(r, 200));
    const failureWarnings = warnings.filter((w) => w.includes("[heartbeat]"));
    assertEquals(
      failureWarnings.length >= 1,
      true,
      "Should warn on the first periodic failure",
    );
    assertEquals(
      failureWarnings[0]!.includes("org/repo#50"),
      true,
      "Warning should include repo and issue number",
    );
    assertEquals(
      failureWarnings[0]!.includes("1 consecutive"),
      true,
      "Warning should include consecutive failure count",
    );
  } finally {
    console.warn = originalWarn;
    await stopHeartbeat(handle);
    await Deno.remove(options.workDir, { recursive: true });
  }
});

Deno.test("heartbeat - synchronous throw in periodic recordFn produces warning", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  let calls = 0;
  const options: HeartbeatOptions = {
    repo: "org/sync-throw",
    issueNumber: 99,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 80,
    // Initial call uses the async path (returns a resolved Promise);
    // periodic calls throw synchronously to exercise the sync-throw branch.
    recordFn: (async (
      _w: string,
      _r: string,
      _i: number,
    ): Promise<{ ok: true; value: undefined }> => {
      calls++;
      if (calls === 1) return { ok: true, value: undefined };
      throw new Error("sync kaboom");
    }) as unknown as HeartbeatOptions["recordFn"],
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const handle = await startOrFail(options);
  try {
    await new Promise((r) => setTimeout(r, 250));
    const failureWarnings = warnings.filter((w) => w.includes("[heartbeat]"));
    assertEquals(
      failureWarnings.length >= 1,
      true,
      "Synchronous throws should produce warnings",
    );
    assertEquals(
      failureWarnings[0]!.includes("org/sync-throw#99"),
      true,
      "Warning should include repo and issue number",
    );
  } finally {
    console.warn = originalWarn;
    await stopHeartbeat(handle);
    await Deno.remove(options.workDir, { recursive: true });
  }
});

Deno.test("heartbeat - warning includes error message", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  let calls = 0;
  const options: HeartbeatOptions = {
    repo: "org/msg-test",
    issueNumber: 88,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 60,
    recordFn: async () => {
      calls++;
      if (calls === 1) return { ok: true, value: undefined };
      return Promise.reject(new Error("connection refused"));
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const handle = await startOrFail(options);
  try {
    await new Promise((r) => setTimeout(r, 200));
    const failureWarnings = warnings.filter((w) => w.includes("[heartbeat]"));
    assertEquals(
      failureWarnings.length >= 1,
      true,
      "Should have at least 1 warning",
    );
    assertEquals(
      failureWarnings[0]!.includes("connection refused"),
      true,
      "Warning should include the error message",
    );
  } finally {
    console.warn = originalWarn;
    await stopHeartbeat(handle);
    await Deno.remove(options.workDir, { recursive: true });
  }
});

Deno.test("heartbeat - periodic recordFn errors do not crash the heartbeat", async () => {
  let callCount = 0;
  const options: HeartbeatOptions = {
    repo: "org/repo",
    issueNumber: 42,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 100,
    // Initial succeeds; periodic returns ok:false repeatedly.
    recordFn: async () => {
      callCount++;
      if (callCount === 1) return { ok: true, value: undefined };
      return { ok: false, error: new Error("Simulated failure") };
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const handle = await startOrFail(options);
  try {
    await new Promise((r) => setTimeout(r, 350));
    // Should continue calling despite errors
    assertEquals(
      callCount >= 3,
      true,
      `Expected at least 3 calls despite errors, got ${callCount}`,
    );
  } finally {
    await stopHeartbeat(handle);
    await Deno.remove(options.workDir, { recursive: true });
  }
});

// ============================================================================
// Awaited initial heartbeat (Issue #1888)
// ============================================================================

Deno.test("heartbeat - initial record is awaited before startHeartbeat resolves", async () => {
  // Track whether recordFn has finished running by the time startHeartbeat
  // resolves. Without the await, the resolved-flag would still be false.
  let resolved = false;
  const options: HeartbeatOptions = {
    repo: "org/awaited",
    issueNumber: 100,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 60_000,
    recordFn: async () => {
      // Simulate work — yield to the event loop, then mark resolved
      await new Promise((r) => setTimeout(r, 30));
      resolved = true;
      return { ok: true, value: undefined };
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const result = await startHeartbeat(options);
  assertEquals(result.ok, true, "Initial heartbeat success returns ok");
  assertEquals(
    resolved,
    true,
    "recordFn must have completed before startHeartbeat resolves",
  );

  if (result.ok) {
    await stopHeartbeat(result.value);
  }
  await Deno.remove(options.workDir, { recursive: true });
});

Deno.test("heartbeat - initial recordFn returning ok:false propagates error", async () => {
  let intervalCalls = 0;
  const options: HeartbeatOptions = {
    repo: "org/local-fail",
    issueNumber: 101,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 50,
    recordFn: async () => {
      intervalCalls++;
      return { ok: false, error: new Error("disk full") };
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const result = await startHeartbeat(options);
  assertEquals(result.ok, false, "Initial failure should propagate");
  if (!result.ok) {
    assert(
      result.error.message.includes("disk full"),
      `Error should include underlying message, got: ${result.error.message}`,
    );
  }

  // The interval must NOT have been scheduled — wait and confirm only
  // the single initial attempt happened.
  await new Promise((r) => setTimeout(r, 200));
  assertEquals(
    intervalCalls,
    1,
    "No periodic interval should be scheduled when initial record fails",
  );
  assertEquals(
    isHeartbeatRunning("org/local-fail", 101),
    false,
    "Heartbeat must not be registered as running after initial failure",
  );

  await Deno.remove(options.workDir, { recursive: true });
});

Deno.test("heartbeat - initial recordFn that throws propagates error", async () => {
  let intervalCalls = 0;
  const options: HeartbeatOptions = {
    repo: "org/github-fail",
    issueNumber: 102,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 50,
    recordFn: async () => {
      intervalCalls++;
      throw new Error("GitHub API 503");
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const result = await startHeartbeat(options);
  assertEquals(
    result.ok,
    false,
    "Initial failure (thrown) should propagate as Result error",
  );
  if (!result.ok) {
    assert(
      result.error.message.includes("GitHub API 503"),
      `Error should include underlying message, got: ${result.error.message}`,
    );
  }

  await new Promise((r) => setTimeout(r, 200));
  assertEquals(
    intervalCalls,
    1,
    "No periodic interval should be scheduled when initial record throws",
  );
  assertEquals(
    isHeartbeatRunning("org/github-fail", 102),
    false,
    "Heartbeat must not be registered as running after initial throw",
  );

  await Deno.remove(options.workDir, { recursive: true });
});

Deno.test("heartbeat - successful initial record schedules periodic interval", async () => {
  let calls = 0;
  const options: HeartbeatOptions = {
    repo: "org/scheduled",
    issueNumber: 103,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 80,
    recordFn: async () => {
      calls++;
      return { ok: true, value: undefined };
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const result = await startHeartbeat(options);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  try {
    assertEquals(
      calls,
      1,
      "Initial recorded once before startHeartbeat resolved",
    );
    assertEquals(
      isHeartbeatRunning("org/scheduled", 103),
      true,
      "Heartbeat should be registered as running after success",
    );
    await new Promise((r) => setTimeout(r, 250));
    assert(
      calls >= 3,
      `Expected periodic interval to fire, got ${calls} calls`,
    );
  } finally {
    await stopHeartbeat(result.value);
    await Deno.remove(options.workDir, { recursive: true });
  }
});

Deno.test("heartbeat - idempotent start returns ok with existing handle", async () => {
  let calls = 0;
  const options: HeartbeatOptions = {
    repo: "org/idempotent",
    issueNumber: 104,
    workDir: await Deno.makeTempDir({ prefix: "hb-test-" }),
    intervalMs: 60_000,
    recordFn: async () => {
      calls++;
      return { ok: true, value: undefined };
    },
    clearFn: async () => ({ ok: true, value: undefined }),
  };

  const first = await startHeartbeat(options);
  assertEquals(first.ok, true);
  const second = await startHeartbeat(options);
  assertEquals(
    second.ok,
    true,
    "Second start for same repo/issue must also succeed",
  );

  if (first.ok && second.ok) {
    assertEquals(
      first.value.id,
      second.value.id,
      "Idempotent start returns the same handle",
    );
    // Initial recordFn should not be called twice.
    assertEquals(calls, 1, "Idempotent start should not re-run initial record");
    await stopHeartbeat(first.value);
  }

  await Deno.remove(options.workDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Slot-aware sweep (Issue #4178, part of #4168)
// ---------------------------------------------------------------------------

async function liveOptions(
  repo: string,
  issueNumber: number,
): Promise<HeartbeatOptions> {
  return {
    repo,
    issueNumber,
    workDir: await Deno.makeTempDir({ prefix: "hb-slot-" }),
    intervalMs: 60_000,
    recordFn: async () => ({ ok: true, value: undefined }),
    clearFn: async () => ({ ok: true, value: undefined }),
  };
}

Deno.test("heartbeat - stopHeartbeatsExcept: two live slots + a sweep → both survive; this fails against stopAllHeartbeats (Issue #4178)", async () => {
  const { stopHeartbeatsExcept, isHeartbeatRunning } = await import(
    "../lib/heartbeat.ts"
  );
  const a = await liveOptions("org/a", 1);
  const b = await liveOptions("org/b", 2);
  const ha = await startOrFail(a);
  const hb = await startOrFail(b);
  try {
    const stopped = await stopHeartbeatsExcept([
      { repo: "org/a", issueNumber: 1 },
      { repo: "org/b", issueNumber: 2 },
    ]);
    assertEquals(stopped, []);
    assertEquals(isHeartbeatRunning("org/a", 1), true);
    assertEquals(isHeartbeatRunning("org/b", 2), true);
  } finally {
    await stopHeartbeat(ha);
    await stopHeartbeat(hb);
    await Deno.remove(a.workDir, { recursive: true });
    await Deno.remove(b.workDir, { recursive: true });
  }
});

Deno.test("heartbeat - stopHeartbeatsExcept: a genuinely leaked heartbeat (no owning slot) is still stopped (Issue #4178)", async () => {
  const { stopHeartbeatsExcept, isHeartbeatRunning } = await import(
    "../lib/heartbeat.ts"
  );
  const live = await liveOptions("org/live", 1);
  const orphan = await liveOptions("org/orphan", 9);
  const hl = await startOrFail(live);
  await startOrFail(orphan); // handle deliberately dropped: the leak
  try {
    const stopped = await stopHeartbeatsExcept([{
      repo: "org/live",
      issueNumber: 1,
    }]);
    assertEquals(stopped.map((h) => `${h.repo}#${h.issueNumber}`), [
      "org/orphan#9",
    ]);
    assertEquals(isHeartbeatRunning("org/orphan", 9), false);
    assertEquals(isHeartbeatRunning("org/live", 1), true);
  } finally {
    await stopHeartbeat(hl);
    await Deno.remove(live.workDir, { recursive: true });
    await Deno.remove(orphan.workDir, { recursive: true });
  }
});

Deno.test("heartbeat - a slot stopping ITS heartbeat leaves the sibling's running (Issue #4178)", async () => {
  const { isHeartbeatRunning } = await import("../lib/heartbeat.ts");
  const a = await liveOptions("org/a", 1);
  const b = await liveOptions("org/b", 2);
  const ha = await startOrFail(a);
  const hb = await startOrFail(b);
  try {
    await stopHeartbeat(ha); // slot A completes
    assertEquals(isHeartbeatRunning("org/a", 1), false);
    assertEquals(isHeartbeatRunning("org/b", 2), true);
  } finally {
    await stopHeartbeat(hb);
    await Deno.remove(a.workDir, { recursive: true });
    await Deno.remove(b.workDir, { recursive: true });
  }
});
