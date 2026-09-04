/**
 * Tests for the check-jenkins-access command entry point (Issue #3583).
 *
 * Verifies arg validation, that a missing-credentials preflight fails
 * loud with the variable names, and that a 403 comes back as an
 * actionable diagnosis rather than a bare status code.
 *
 * Issue #958: the credentials reach the command through the injected
 * `readEnv` seam, so a token-shaped value is never written into the
 * process environment — `lib/agent_env.ts` lists `JENKINS_TOKEN` as a
 * worker-only secret precisely because it must not reach a child process.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkJenkinsAccessCommand,
  createCheckJenkinsAccessCommand,
} from "../commands/check_jenkins_access.ts";
import type {
  EnvReader,
  JenkinsAccessDiagnosis,
} from "../lib/jenkins_access_check.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const TEST_TOKEN = "command-test-token-ABC789";

/** Credentials that exist only in this object, never in the process. */
const jenkinsEnv: Record<string, string> = {
  JENKINS_URL: "https://jenkins.example.com",
  JENKINS_USER: "ci-bot",
  JENKINS_TOKEN: TEST_TOKEN,
};

function envReader(values: Record<string, string>): EnvReader {
  return (name) => values[name];
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
  const command = createCheckJenkinsAccessCommand({
    readEnv: envReader({}),
  });
  const result = await command.execute(
    { job: "MyJob" },
    buildDefaultWorkerConfig(),
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "JENKINS_URL");
  assertStringIncludes(result.message, "JENKINS_USER");
  assertStringIncludes(result.message, "JENKINS_TOKEN");
});

Deno.test("check-jenkins-access - 403 reports the permission remediation without the token", async () => {
  const command = createCheckJenkinsAccessCommand({
    readEnv: envReader(jenkinsEnv),
    fetchFn: () => Promise.resolve(new Response("Forbidden", { status: 403 })),
  });

  const result = await command.execute(
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
});

Deno.test("check-jenkins-access - a healthy probe succeeds", async () => {
  const command = createCheckJenkinsAccessCommand({
    readEnv: envReader(jenkinsEnv),
    fetchFn: () => Promise.resolve(new Response("{}", { status: 200 })),
  });

  const result = await command.execute(
    { job: "MyJob" },
    buildDefaultWorkerConfig(),
  );
  assertEquals(result.success, true);
  assertEquals((result.data as JenkinsAccessDiagnosis).status, "ok");
});

Deno.test("check-jenkins-access - the probe URL and auth come from the injected lookup (Issue #958)", async () => {
  // A host and user that exist in no real environment: a command that fell
  // back to `Deno.env.get` could not produce either.
  const injected = {
    JENKINS_URL: "https://only-injected-958.jenkins.invalid",
    JENKINS_USER: "seam-user-958",
    JENKINS_TOKEN: TEST_TOKEN,
  };
  let capturedUrl = "";
  let capturedAuth = "";

  const command = createCheckJenkinsAccessCommand({
    readEnv: envReader(injected),
    fetchFn: (url, init) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string> | undefined)
        ?.["Authorization"] ?? "";
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  });

  const result = await command.execute(
    { job: "MyJob", build: 7 },
    buildDefaultWorkerConfig(),
  );

  assertEquals(result.success, true);
  assertEquals(
    capturedUrl,
    "https://only-injected-958.jenkins.invalid/job/MyJob/7/api/json",
  );
  assertEquals(
    capturedAuth,
    `Basic ${btoa(`${injected.JENKINS_USER}:${TEST_TOKEN}`)}`,
  );
  assert(
    !JSON.stringify(result).includes(TEST_TOKEN),
    "token leaked in command result",
  );
});
