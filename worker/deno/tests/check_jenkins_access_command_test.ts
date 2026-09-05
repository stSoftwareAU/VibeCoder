/**
 * Tests for the check-jenkins-access command entry point (Issue #3583).
 *
 * Verifies arg validation, that a missing-credentials preflight fails
 * loud with the variable names, and that a 403 comes back as an
 * actionable diagnosis rather than a bare status code.
 *
 * Credentials are handed to the command as an injected {@link EnvLookup}
 * (Issue #944), so nothing here mutates the process environment and the
 * file runs in the parallel pass.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkJenkinsAccessCommand } from "../commands/check_jenkins_access.ts";
import type { JenkinsAccessDiagnosis } from "../lib/jenkins_access_check.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

const TEST_TOKEN = "command-test-token-ABC789";

/** A fully configured Jenkins environment, seen only by the command. */
const configuredEnv = envFrom({
  JENKINS_URL: "https://jenkins.example.com",
  JENKINS_USER: "ci-bot",
  JENKINS_TOKEN: TEST_TOKEN,
});

Deno.test("check-jenkins-access - missing --job returns error", async () => {
  const result = await checkJenkinsAccessCommand.execute(
    {},
    buildDefaultWorkerConfig(),
    configuredEnv,
  );
  assertEquals(result.success, false);
  assert(result.message.includes("--job"));
});

Deno.test("check-jenkins-access - missing env vars are named in the message", async () => {
  const result = await checkJenkinsAccessCommand.execute(
    { job: "MyJob" },
    buildDefaultWorkerConfig(),
    emptyEnv,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "JENKINS_URL");
  assertStringIncludes(result.message, "JENKINS_USER");
  assertStringIncludes(result.message, "JENKINS_TOKEN");
});

Deno.test("check-jenkins-access - 403 reports the permission remediation without the token", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("Forbidden", { status: 403 }));

  try {
    const result = await checkJenkinsAccessCommand.execute(
      { job: "MyJob", build: 42 },
      buildDefaultWorkerConfig(),
      configuredEnv,
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
  }
});

Deno.test("check-jenkins-access - a healthy probe succeeds", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("{}", { status: 200 }));

  try {
    const result = await checkJenkinsAccessCommand.execute(
      { job: "MyJob" },
      buildDefaultWorkerConfig(),
      configuredEnv,
    );
    assertEquals(result.success, true);
    assertEquals((result.data as JenkinsAccessDiagnosis).status, "ok");
  } finally {
    globalThis.fetch = realFetch;
  }
});
