/**
 * Tests for the fetch-jenkins-log command entry point (Issue #1891).
 *
 * Verifies arg parsing and that the command surfaces library errors
 * (e.g. missing environment variables) via CommandResult.
 *
 * Credentials are handed to the command as an injected {@link EnvLookup}
 * (Issue #944), so nothing here mutates the process environment and the
 * file runs in the parallel pass.
 */

import { assert, assertEquals } from "@std/assert";
import { fetchJenkinsLogCommand } from "../commands/fetch_jenkins_log.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { emptyEnv } from "./support/env_lookup.ts";

Deno.test("fetch-jenkins-log - missing --job returns error", async () => {
  const result = await fetchJenkinsLogCommand.execute(
    {},
    buildDefaultWorkerConfig(),
    emptyEnv,
  );
  assertEquals(result.success, false);
  assert(result.message.includes("--job"));
});

Deno.test("fetch-jenkins-log - missing --build returns error", async () => {
  const result = await fetchJenkinsLogCommand.execute(
    { job: "MyJob" },
    buildDefaultWorkerConfig(),
    emptyEnv,
  );
  assertEquals(result.success, false);
  assert(result.message.includes("--build"));
});

Deno.test("fetch-jenkins-log - missing env vars surfaces library error", async () => {
  const result = await fetchJenkinsLogCommand.execute(
    { job: "MyJob", build: 1 },
    buildDefaultWorkerConfig(),
    emptyEnv,
  );
  assertEquals(result.success, false);
  assert(
    result.message.includes("JENKINS_URL") ||
      result.message.includes("JENKINS_USER") ||
      result.message.includes("JENKINS_TOKEN"),
    `expected env var name in error, got: ${result.message}`,
  );
});
