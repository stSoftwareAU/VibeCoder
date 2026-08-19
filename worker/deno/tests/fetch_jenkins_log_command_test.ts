/**
 * Tests for the fetch-jenkins-log command entry point (Issue #1891).
 *
 * Verifies arg parsing and that the command surfaces library errors
 * (e.g. missing environment variables) via CommandResult.
 */

import { assert, assertEquals } from "@std/assert";
import { fetchJenkinsLogCommand } from "../commands/fetch_jenkins_log.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const ENV_KEYS = ["JENKINS_URL", "JENKINS_USER", "JENKINS_TOKEN"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = Deno.env.get(key);
  }
  return snapshot;
}

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    Deno.env.delete(key);
  }
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
}

Deno.test("fetch-jenkins-log - missing --job returns error", async () => {
  const result = await fetchJenkinsLogCommand.execute(
    {},
    buildDefaultWorkerConfig(),
  );
  assertEquals(result.success, false);
  assert(result.message.includes("--job"));
});

Deno.test("fetch-jenkins-log - missing --build returns error", async () => {
  const result = await fetchJenkinsLogCommand.execute(
    { job: "MyJob" },
    buildDefaultWorkerConfig(),
  );
  assertEquals(result.success, false);
  assert(result.message.includes("--build"));
});

Deno.test("fetch-jenkins-log - missing env vars surfaces library error", async () => {
  const snapshot = snapshotEnv();
  clearEnv();
  try {
    const result = await fetchJenkinsLogCommand.execute(
      { job: "MyJob", build: 1 },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false);
    assert(
      result.message.includes("JENKINS_URL") ||
        result.message.includes("JENKINS_USER") ||
        result.message.includes("JENKINS_TOKEN"),
      `expected env var name in error, got: ${result.message}`,
    );
  } finally {
    restoreEnv(snapshot);
  }
});
