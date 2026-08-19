/**
 * Tests for `seed_idle_tasks_request.ts` — parsing and operator-config
 * validation for worker-side idle-task seeding requests (Issue #3860).
 *
 * The safety property under test is that the repo the worker ends up writing
 * to is always a `.config.json` `repos` entry: the issue title only *selects*
 * one, and an unmatched slug resolves to `null` (refusal).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  isSeedIdleTasksTitle,
  parseSeedIdleTasksTitle,
  resolveMonitoredRepo,
  SEED_IDLE_TASKS_PREFIX,
} from "../lib/seed_idle_tasks_request.ts";

Deno.test("isSeedIdleTasksTitle - case-insensitive, whitespace tolerant", () => {
  assert(isSeedIdleTasksTitle("seed-idle-tasks: owner/repo"));
  assert(isSeedIdleTasksTitle("SEED-IDLE-TASKS: owner/repo"));
  assert(isSeedIdleTasksTitle("  seed-idle-tasks: owner/repo  "));
  assert(!isSeedIdleTasksTitle("Fix the date parser"));
  assert(!isSeedIdleTasksTitle("please seed-idle-tasks: owner/repo"));
  assert(!isSeedIdleTasksTitle(""));
});

Deno.test("parseSeedIdleTasksTitle - extracts a valid slug", () => {
  assertEquals(
    parseSeedIdleTasksTitle("seed-idle-tasks: example-org/private-repo-29"),
    { repo: "example-org/private-repo-29" },
  );
  assertEquals(
    parseSeedIdleTasksTitle("  SEED-IDLE-TASKS:   owner/repo.js  "),
    { repo: "owner/repo.js" },
  );
});

Deno.test("parseSeedIdleTasksTitle - rejects malformed input", () => {
  for (
    const title of [
      "",
      "Fix the date parser",
      SEED_IDLE_TASKS_PREFIX, // prefix with no slug
      "seed-idle-tasks:    ",
      "seed-idle-tasks: not-a-slug",
      "seed-idle-tasks: owner/repo; rm -rf /",
      "seed-idle-tasks: ../../etc/passwd",
      "seed-idle-tasks: owner/repo extra",
    ]
  ) {
    assertEquals(
      parseSeedIdleTasksTitle(title),
      null,
      `expected null for ${JSON.stringify(title)}`,
    );
  }
});

Deno.test("resolveMonitoredRepo - returns the config entry, not the request text", () => {
  const repos = ["stSoftwareAU/VibeCoder", "example-org/private-repo-29"];
  // Requested in a different case — the CONFIG casing must win, because that
  // is the operator-controlled value.
  assertEquals(
    resolveMonitoredRepo("example-org/private-repo-29", repos),
    "example-org/private-repo-29",
  );
  assertEquals(
    resolveMonitoredRepo("  stSoftwareAU/VibeCoder  ", repos),
    "stSoftwareAU/VibeCoder",
  );
});

Deno.test("resolveMonitoredRepo - refuses an off-config repo", () => {
  const repos = ["stSoftwareAU/VibeCoder", "example-org/private-repo-29"];
  assertEquals(resolveMonitoredRepo("attacker/evil", repos), null);
  assertEquals(resolveMonitoredRepo("", repos), null);
  assertEquals(resolveMonitoredRepo("example-org/private-repo-29", []), null);
  // A near-miss must not match (no prefix/substring leniency).
  assertEquals(
    resolveMonitoredRepo("example-org/private-repo-28", repos),
    null,
  );
  assertEquals(
    resolveMonitoredRepo("example-org/private-repo-35", repos),
    null,
  );
});
