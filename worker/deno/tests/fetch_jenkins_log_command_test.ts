/**
 * Tests for the fetch-jenkins-log command entry point (Issue #1891).
 *
 * Verifies arg parsing and that the command surfaces library errors
 * (e.g. missing environment variables) via CommandResult.
 *
 * Issue #958: the credentials reach the command through the injected
 * `readEnv` seam, so nothing here writes a token-shaped value into the
 * process environment.
 */

import { assert, assertEquals } from "@std/assert";
import {
  createFetchJenkinsLogCommand,
  fetchJenkinsLogCommand,
} from "../commands/fetch_jenkins_log.ts";
import type { EnvReader } from "../lib/jenkins_access_check.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

function envReader(values: Record<string, string>): EnvReader {
  return (name) => values[name];
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
  const command = createFetchJenkinsLogCommand({ readEnv: envReader({}) });
  const result = await command.execute(
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
});

Deno.test("fetch-jenkins-log - the fetched URLs come from the injected lookup (Issue #958)", async () => {
  // A host that exists in no real environment: a command that fell back to
  // `Deno.env.get` could not produce it.
  const token = "fetch-command-test-token-DEF456";
  const requested: string[] = [];
  const command = createFetchJenkinsLogCommand({
    readEnv: envReader({
      JENKINS_URL: "https://only-injected-958.jenkins.invalid",
      JENKINS_USER: "seam-user-958",
      JENKINS_TOKEN: token,
    }),
    fetchFn: (url) => {
      const u = String(url);
      requested.push(u);
      if (u.endsWith("api/json")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ number: 3, result: "FAILURE", url: u }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("console output", { status: 200 }));
    },
  });

  const result = await command.execute(
    { job: "MyJob", build: 3 },
    buildDefaultWorkerConfig(),
  );

  assertEquals(result.success, true);
  assertEquals(requested, [
    "https://only-injected-958.jenkins.invalid/job/MyJob/3/api/json",
    "https://only-injected-958.jenkins.invalid/job/MyJob/3/consoleText",
  ]);
  assert(
    !JSON.stringify(result).includes(token),
    "token leaked in command result",
  );
});
