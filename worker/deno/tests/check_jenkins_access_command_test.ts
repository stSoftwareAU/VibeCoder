/**
 * Tests for the check-jenkins-access command entry point (Issue #3583).
 *
 * Verifies arg validation, that a missing-credentials preflight fails
 * loud with the variable names, and that a 403 comes back as an
 * actionable diagnosis rather than a bare status code.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkJenkinsAccessCommand } from "../commands/check_jenkins_access.ts";
import type { JenkinsAccessDiagnosis } from "../lib/jenkins_access_check.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const ENV_KEYS = ["JENKINS_URL", "JENKINS_USER", "JENKINS_TOKEN"] as const;
const TEST_TOKEN = "command-test-token-ABC789";

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

Deno.test("check-jenkins-access - missing --job returns error", async () => {
  const result = await checkJenkinsAccessCommand.execute(
    {},
    buildDefaultWorkerConfig(),
  );
  assertEquals(result.success, false);
  assert(result.message.includes("--job"));
});

Deno.test("check-jenkins-access - missing env vars are named in the message", async () => {
  const snapshot = snapshotEnv();
  clearEnv();
  try {
    const result = await checkJenkinsAccessCommand.execute(
      { job: "MyJob" },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "JENKINS_URL");
    assertStringIncludes(result.message, "JENKINS_USER");
    assertStringIncludes(result.message, "JENKINS_TOKEN");
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("check-jenkins-access - 403 reports the permission remediation without the token", async () => {
  const snapshot = snapshotEnv();
  Deno.env.set("JENKINS_URL", "https://jenkins.example.com");
  Deno.env.set("JENKINS_USER", "ci-bot");
  Deno.env.set("JENKINS_TOKEN", TEST_TOKEN);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("Forbidden", { status: 403 }));

  try {
    const result = await checkJenkinsAccessCommand.execute(
      { job: "MyJob", build: 42 },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false);
    const diagnosis = result.data as JenkinsAccessDiagnosis;
    assertEquals(diagnosis.status, "forbidden");
    assertEquals(diagnosis.httpStatus, 403);
    assertStringIncludes(result.message, "Job/Read");
    assert(
      !JSON.stringify(result).includes(TEST_TOKEN),
      "token leaked in command result",
    );
  } finally {
    globalThis.fetch = realFetch;
    restoreEnv(snapshot);
  }
});

Deno.test("check-jenkins-access - a healthy probe succeeds", async () => {
  const snapshot = snapshotEnv();
  Deno.env.set("JENKINS_URL", "https://jenkins.example.com");
  Deno.env.set("JENKINS_USER", "ci-bot");
  Deno.env.set("JENKINS_TOKEN", TEST_TOKEN);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("{}", { status: 200 }));

  try {
    const result = await checkJenkinsAccessCommand.execute(
      { job: "MyJob" },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, true);
    assertEquals((result.data as JenkinsAccessDiagnosis).status, "ok");
  } finally {
    globalThis.fetch = realFetch;
    restoreEnv(snapshot);
  }
});
