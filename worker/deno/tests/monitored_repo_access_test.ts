/**
 * Unit tests for the monitored-repo access store (Issue #4036).
 *
 * The store is the memory the fleet health gate needs: it folds probe
 * outcomes into a per-repo access verdict with hysteresis, so a single
 * blip cannot flip the fleet and a single success recovers it.
 *
 * Covers the acceptance criteria of #4036:
 *   - below threshold → still accessible (off-by-one guard);
 *   - threshold reached → inaccessible;
 *   - a success after a trip → immediately accessible, counter reset;
 *   - `transient` / `parse_failed` neither escalate nor clear;
 *   - a never-probed repo is `unknown` and never reported;
 *   - `getInaccessibleRepos()` ordering is stable between calls.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  ACCESS_FAILURE_THRESHOLD,
  formatInaccessibleReposReason,
  getInaccessibleRepos,
  getRepoAccessState,
  logRepoAccessOnce,
  maxConsecutiveAccessDenied,
  recordRepoProbe,
  REPO_ACCESS_LOG_PREFIX,
  resetRepoAccessLogState,
  resetRepoAccessState,
} from "../lib/monitored_repo_access.ts";

/** Fixed clock so assertions on `lastOkAt` are deterministic. */
const T0 = 1_700_000_000_000;

function denyTimes(repo: string, times: number, from = T0): void {
  for (let i = 0; i < times; i++) {
    recordRepoProbe(repo, "access_denied", from + i);
  }
}

Deno.test("ACCESS_FAILURE_THRESHOLD is an exported constant >= 2", () => {
  // Hysteresis is meaningless at 1 — a single denial would flip the fleet.
  assertEquals(ACCESS_FAILURE_THRESHOLD >= 2, true);
});

Deno.test("never-probed repo is unknown and not reported inaccessible", () => {
  resetRepoAccessState();
  const state = getRepoAccessState("stSoftwareAU/never-probed");
  assertEquals(state.lastOutcome, "unknown");
  assertEquals(state.consecutiveAccessDenied, 0);
  assertEquals(state.lastOkAt, undefined);
  assertEquals(getInaccessibleRepos(), []);
});

Deno.test("single access_denied below threshold leaves repo accessible", () => {
  resetRepoAccessState();
  denyTimes("stSoftwareAU/repo-a", ACCESS_FAILURE_THRESHOLD - 1);
  assertEquals(getInaccessibleRepos(), []);
  assertEquals(
    getRepoAccessState("stSoftwareAU/repo-a").consecutiveAccessDenied,
    ACCESS_FAILURE_THRESHOLD - 1,
  );
});

Deno.test("threshold consecutive access_denied probes trip the repo", () => {
  resetRepoAccessState();
  denyTimes("stSoftwareAU/repo-a", ACCESS_FAILURE_THRESHOLD);
  assertEquals(getInaccessibleRepos(), ["stSoftwareAU/repo-a"]);
  assertEquals(
    getRepoAccessState("stSoftwareAU/repo-a").lastOutcome,
    "access_denied",
  );
});

Deno.test("a success after a trip recovers the repo immediately", () => {
  resetRepoAccessState();
  denyTimes("stSoftwareAU/repo-a", ACCESS_FAILURE_THRESHOLD + 3);
  assertEquals(getInaccessibleRepos(), ["stSoftwareAU/repo-a"]);

  recordRepoProbe("stSoftwareAU/repo-a", "ok", T0 + 9_000);

  assertEquals(getInaccessibleRepos(), []);
  const state = getRepoAccessState("stSoftwareAU/repo-a");
  // Reset to 0, not merely decremented — a decrementing reset would keep
  // the repo tripped for several ticks after access was restored.
  assertEquals(state.consecutiveAccessDenied, 0);
  assertEquals(state.lastOutcome, "ok");
  assertEquals(state.lastOkAt, T0 + 9_000);
});

Deno.test("transient outcomes never escalate a repo to inaccessible", () => {
  resetRepoAccessState();
  for (let i = 0; i < ACCESS_FAILURE_THRESHOLD * 3; i++) {
    recordRepoProbe("stSoftwareAU/repo-a", "transient", T0 + i);
    recordRepoProbe("stSoftwareAU/repo-b", "parse_failed", T0 + i);
  }
  assertEquals(getInaccessibleRepos(), []);
  assertEquals(
    getRepoAccessState("stSoftwareAU/repo-a").consecutiveAccessDenied,
    0,
  );
  assertEquals(
    getRepoAccessState("stSoftwareAU/repo-b").consecutiveAccessDenied,
    0,
  );
});

Deno.test("transient outcomes never clear an already-tripped repo", () => {
  resetRepoAccessState();
  denyTimes("stSoftwareAU/repo-a", ACCESS_FAILURE_THRESHOLD);
  recordRepoProbe("stSoftwareAU/repo-a", "transient", T0 + 100);
  recordRepoProbe("stSoftwareAU/repo-a", "parse_failed", T0 + 200);

  // Still tripped: only a successful probe may clear the counter.
  assertEquals(getInaccessibleRepos(), ["stSoftwareAU/repo-a"]);
  assertEquals(
    getRepoAccessState("stSoftwareAU/repo-a").consecutiveAccessDenied,
    ACCESS_FAILURE_THRESHOLD,
  );
});

Deno.test("a success between denials restarts the run — counter is consecutive", () => {
  resetRepoAccessState();
  denyTimes("stSoftwareAU/repo-a", ACCESS_FAILURE_THRESHOLD - 1);
  recordRepoProbe("stSoftwareAU/repo-a", "ok", T0 + 50);
  denyTimes("stSoftwareAU/repo-a", ACCESS_FAILURE_THRESHOLD - 1, T0 + 60);
  assertEquals(getInaccessibleRepos(), []);
});

Deno.test("getInaccessibleRepos is stable-ordered across calls and insertion orders", () => {
  resetRepoAccessState();
  for (const repo of ["stSoftwareAU/zulu", "stSoftwareAU/alpha", "b/mike"]) {
    denyTimes(repo, ACCESS_FAILURE_THRESHOLD);
  }
  const first = getInaccessibleRepos();
  const second = getInaccessibleRepos();
  assertEquals(first, second);
  assertEquals(first, ["b/mike", "stSoftwareAU/alpha", "stSoftwareAU/zulu"]);

  // Same set recorded in a different order yields the identical list, so
  // downstream health messages cannot churn between ticks.
  resetRepoAccessState();
  for (const repo of ["b/mike", "stSoftwareAU/zulu", "stSoftwareAU/alpha"]) {
    denyTimes(repo, ACCESS_FAILURE_THRESHOLD);
  }
  assertEquals(getInaccessibleRepos(), first);
});

Deno.test("only tripped repos appear — mixed fleet", () => {
  resetRepoAccessState();
  denyTimes("stSoftwareAU/down", ACCESS_FAILURE_THRESHOLD);
  denyTimes("stSoftwareAU/wobbly", ACCESS_FAILURE_THRESHOLD - 1);
  recordRepoProbe("stSoftwareAU/healthy", "ok", T0);
  recordRepoProbe("stSoftwareAU/blip", "transient", T0);

  assertEquals(getInaccessibleRepos(), ["stSoftwareAU/down"]);
});

Deno.test("resetRepoAccessState clears every repo", () => {
  resetRepoAccessState();
  denyTimes("stSoftwareAU/repo-a", ACCESS_FAILURE_THRESHOLD);
  assertEquals(getInaccessibleRepos().length, 1);

  resetRepoAccessState();

  assertEquals(getInaccessibleRepos(), []);
  assertEquals(
    getRepoAccessState("stSoftwareAU/repo-a").lastOutcome,
    "unknown",
  );
});

Deno.test("repo names are trimmed and blank names are rejected loudly", () => {
  resetRepoAccessState();
  denyTimes("  stSoftwareAU/repo-a  ", ACCESS_FAILURE_THRESHOLD);
  assertEquals(getInaccessibleRepos(), ["stSoftwareAU/repo-a"]);

  assertThrows(
    () => recordRepoProbe("   ", "access_denied", T0),
    TypeError,
  );
  assertThrows(() => getRepoAccessState(""), TypeError);
});

Deno.test("getRepoAccessState returns a copy — callers cannot mutate the store", () => {
  resetRepoAccessState();
  denyTimes("stSoftwareAU/repo-a", ACCESS_FAILURE_THRESHOLD);
  const state = getRepoAccessState("stSoftwareAU/repo-a");
  state.consecutiveAccessDenied = 0;
  assertEquals(getInaccessibleRepos(), ["stSoftwareAU/repo-a"]);
});

// ---------------------------------------------------------------------------
// Operator-facing reason and status line (Issue #4039)
// ---------------------------------------------------------------------------

Deno.test("formatInaccessibleReposReason names every repo, comma-separated", () => {
  resetRepoAccessState();
  denyTimes("TitlePage/foo", ACCESS_FAILURE_THRESHOLD);
  denyTimes("TitlePage/bar", ACCESS_FAILURE_THRESHOLD);

  assertEquals(
    formatInaccessibleReposReason(getInaccessibleRepos()),
    "repos inaccessible: TitlePage/bar, TitlePage/foo",
  );
});

Deno.test("maxConsecutiveAccessDenied reports the worst-affected repo", () => {
  resetRepoAccessState();
  denyTimes("stSoftwareAU/repo-a", ACCESS_FAILURE_THRESHOLD);
  denyTimes("stSoftwareAU/repo-b", ACCESS_FAILURE_THRESHOLD + 3);

  assertEquals(
    maxConsecutiveAccessDenied(getInaccessibleRepos()),
    ACCESS_FAILURE_THRESHOLD + 3,
  );
  // A repo the store has never seen is never guessed at.
  assertEquals(maxConsecutiveAccessDenied(["stSoftwareAU/never-probed"]), 0);
});

Deno.test("logRepoAccessOnce emits one structured line and suppresses repeats", () => {
  resetRepoAccessState();
  denyTimes("stSoftwareAU/repo-a", ACCESS_FAILURE_THRESHOLD);

  const lines: string[] = [];
  const sink = (line: string) => lines.push(line);
  const repos = getInaccessibleRepos();

  assertEquals(logRepoAccessOnce(repos, sink, { hostId: "host-3" }), true);
  assertEquals(logRepoAccessOnce(repos, sink, { hostId: "host-3" }), false);
  assertEquals(lines, [
    `[repo-access] host=host-3 status=inaccessible repos=stSoftwareAU/repo-a consecutive=${ACCESS_FAILURE_THRESHOLD}`,
  ]);

  // The iteration boundary re-arms it.
  resetRepoAccessLogState();
  assertEquals(logRepoAccessOnce(repos, sink, { hostId: "host-3" }), true);
  assertEquals(lines.length, 2);
});

Deno.test("logRepoAccessOnce logs a changed repo set immediately", () => {
  resetRepoAccessState();
  denyTimes("stSoftwareAU/repo-a", ACCESS_FAILURE_THRESHOLD);

  const lines: string[] = [];
  const sink = (line: string) => lines.push(line);

  logRepoAccessOnce(getInaccessibleRepos(), sink, { hostId: "host-3" });
  // A second repo going dark is new information, not spam.
  denyTimes("stSoftwareAU/repo-b", ACCESS_FAILURE_THRESHOLD);
  assertEquals(
    logRepoAccessOnce(getInaccessibleRepos(), sink, { hostId: "host-3" }),
    true,
  );
  assertEquals(lines.length, 2);
  assertStringIncludes(
    lines[1]!,
    "repos=stSoftwareAU/repo-a,stSoftwareAU/repo-b",
  );
});

Deno.test("logRepoAccessOnce is silent for a healthy host and appends the caller's suffix", () => {
  resetRepoAccessState();
  const lines: string[] = [];
  const sink = (line: string) => lines.push(line);

  assertEquals(logRepoAccessOnce([], sink, { hostId: "host-3" }), false);
  assertEquals(lines, []);

  denyTimes("stSoftwareAU/repo-a", ACCESS_FAILURE_THRESHOLD);
  logRepoAccessOnce(getInaccessibleRepos(), sink, {
    hostId: "host-3",
    suffix: "host marked unhealthy",
  });
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, `${REPO_ACCESS_LOG_PREFIX} host=host-3`);
  assertStringIncludes(lines[0]!, "— host marked unhealthy");
});
