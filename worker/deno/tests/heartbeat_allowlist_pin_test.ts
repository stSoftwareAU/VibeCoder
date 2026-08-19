/**
 * Tests for the heartbeat ↔ write-repo-allowlist pinning contract
 * (Issue #3760).
 *
 * A heartbeat is a long-lived `setInterval` that keeps PATCHing a marker
 * comment on *its* claim's repo. The per-run write allowlist (Issue #3311)
 * is cleared and reseeded on every new claim, so a heartbeat that spans a
 * claim boundary used to have every marker refresh refused
 * (`WRITE_REPO_BLOCKED` … `heartbeat_failure (consecutive: N)`), letting
 * sibling hosts' stuck-detection steal the issue. These tests pin the
 * contract: a heartbeat pins its repo for its lifetime, so a reseed can
 * never block its marker writes; `stopAllHeartbeats` sweeps leaked
 * intervals at the claim boundary.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type HeartbeatOptions,
  isHeartbeatRunning,
  startHeartbeat,
  stopAllHeartbeats,
  stopHeartbeat,
} from "../lib/heartbeat.ts";
import {
  _resetWriteRepoPins,
  isWriteRepoAllowed,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
} from "../lib/write_repo_allowlist.ts";

/** Build minimal heartbeat options with always-succeeding record/clear fns. */
function makeOptions(
  workDir: string,
  repo: string,
  issueNumber: number,
  overrides?: Partial<HeartbeatOptions>,
): HeartbeatOptions {
  return {
    repo,
    issueNumber,
    workDir,
    intervalMs: 60_000,
    recordFn: () => Promise.resolve({ ok: true, value: undefined }),
    clearFn: () => Promise.resolve({ ok: true, value: undefined }),
    ...overrides,
  };
}

/** Restore allowlist module state so tests never leak into siblings. */
function cleanupAllowlist(): void {
  resetWriteRepoAllowlist();
  _resetWriteRepoPins();
}

Deno.test("heartbeat - active heartbeat keeps its repo writable across a reseed (Issue #3760)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "hb-pin-" });
  try {
    const options = makeOptions(workDir, "stSoftwareAU/VibeCoder", 3759);
    const started = await startHeartbeat(options);
    assert(started.ok, "heartbeat must start");

    // The next claim reseeds the allowlist with a different target repo —
    // this is the exact sequence that used to block the marker refresh.
    seedWriteRepoAllowlist("example-org/private-repo-33");
    assert(
      isWriteRepoAllowed("stSoftwareAU/VibeCoder"),
      "an active heartbeat's repo must stay writable after a reseed",
    );

    await stopHeartbeat(started.value);
    assertEquals(
      isWriteRepoAllowed("stSoftwareAU/VibeCoder"),
      false,
      "the pin must be released once the heartbeat stops",
    );
  } finally {
    cleanupAllowlist();
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("heartbeat - failed initial record leaves no pin behind", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "hb-pin-" });
  try {
    const options = makeOptions(workDir, "org/initial-fail", 1, {
      recordFn: () =>
        Promise.resolve({ ok: false, error: new Error("marker post failed") }),
    });
    const started = await startHeartbeat(options);
    assertEquals(started.ok, false, "initial failure must propagate");

    seedWriteRepoAllowlist("other/target");
    assertEquals(
      isWriteRepoAllowed("org/initial-fail"),
      false,
      "a heartbeat that never started must not leave its repo pinned",
    );
  } finally {
    cleanupAllowlist();
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("heartbeat - stop keeps the repo pinned for the final clearFn write", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "hb-pin-" });
  try {
    let allowedDuringClear: boolean | undefined;
    const options = makeOptions(workDir, "org/stale-marker", 7, {
      clearFn: () => {
        // The stale-marker PATCH inside stopHeartbeat is itself a GitHub
        // write to the heartbeat's repo — it must still be allowed.
        allowedDuringClear = isWriteRepoAllowed("org/stale-marker");
        return Promise.resolve({ ok: true, value: undefined });
      },
    });
    const started = await startHeartbeat(options);
    assert(started.ok, "heartbeat must start");
    seedWriteRepoAllowlist("other/target");

    await stopHeartbeat(started.value);
    assertEquals(
      allowedDuringClear,
      true,
      "clearFn's final marker write must run before the pin is released",
    );
    assertEquals(isWriteRepoAllowed("org/stale-marker"), false);
  } finally {
    cleanupAllowlist();
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("heartbeat - idempotent double start holds a single pin", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "hb-pin-" });
  try {
    const options = makeOptions(workDir, "org/idempotent-pin", 9);
    const first = await startHeartbeat(options);
    const second = await startHeartbeat(options);
    assert(first.ok && second.ok, "both starts must succeed");

    seedWriteRepoAllowlist("other/target");
    await stopHeartbeat(first.value);
    assertEquals(
      isWriteRepoAllowed("org/idempotent-pin"),
      false,
      "one stop must fully release the pin held by the idempotent start",
    );
  } finally {
    cleanupAllowlist();
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("heartbeat - stopAllHeartbeats sweeps every leaked interval and reports them", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "hb-pin-" });
  try {
    const clears: string[] = [];
    const makeLeaked = (repo: string, issueNumber: number) =>
      makeOptions(workDir, repo, issueNumber, {
        clearFn: () => {
          clears.push(`${repo}#${issueNumber}`);
          return Promise.resolve({ ok: true, value: undefined });
        },
      });

    const a = await startHeartbeat(makeLeaked("org/leaked-a", 11));
    const b = await startHeartbeat(makeLeaked("org/leaked-b", 22));
    assert(a.ok && b.ok, "both heartbeats must start");

    const swept = await stopAllHeartbeats();
    const sweptKeys = swept.map((h) => `${h.repo}#${h.issueNumber}`).sort();
    assertEquals(sweptKeys, ["org/leaked-a#11", "org/leaked-b#22"]);
    assertEquals(isHeartbeatRunning("org/leaked-a", 11), false);
    assertEquals(isHeartbeatRunning("org/leaked-b", 22), false);
    assertEquals(clears.sort(), ["org/leaked-a#11", "org/leaked-b#22"]);

    // Pins released with the sweep: a later reseed blocks both repos again.
    seedWriteRepoAllowlist("other/target");
    assertEquals(isWriteRepoAllowed("org/leaked-a"), false);
    assertEquals(isWriteRepoAllowed("org/leaked-b"), false);

    // Nothing left to sweep — a second call is a safe no-op.
    assertEquals(await stopAllHeartbeats(), []);
  } finally {
    cleanupAllowlist();
    await Deno.remove(workDir, { recursive: true });
  }
});
