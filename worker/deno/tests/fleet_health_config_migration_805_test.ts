/**
 * Stale `fleet_health_*` keys are a loud migration error (Issue #805,
 * parent #796).
 *
 * The built-in FLEET health reporting was removed from the public worker;
 * private health reporting now belongs in a `callbacks.success` hook
 * (Issue #806). A config still carrying `fleet_health_dir` or
 * `fleet_health_repo` must not be silently ignored — an operator whose
 * health reports stopped without a word would have no way to learn why —
 * so the config load fails with one message naming the removed keys and the
 * replacement.
 *
 * Australian English spelling used throughout (behaviour, recognised).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import {
  REMOVED_CONFIG_KEYS,
  validateConfigFileJson,
} from "../lib/validation.ts";
import { KNOWN_CONFIG_KEYS } from "../lib/config_unknown_keys.ts";

async function withConfig(
  body: (
    path: string,
    write: (json: unknown) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "vibe-fleet-health-migration-",
  });
  const path = `${dir}/.config.json`;
  try {
    await body(
      path,
      (json) => Deno.writeTextFile(path, JSON.stringify(json, null, 2)),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("fleet health migration - fleet_health_dir is refused with an actionable message", () => {
  const result = validateConfigFileJson({
    repos: ["org/repo"],
    fleet_health_dir: "/home/vibe/auto-issue-work/health",
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.field, "fleet_health_dir");
  assert(
    result.error.message.includes("removed"),
    `the message must say the key was removed: ${result.error.message}`,
  );
  assert(
    result.error.message.includes("callbacks"),
    `the message must name the replacement: ${result.error.message}`,
  );
});

Deno.test("fleet health migration - fleet_health_repo is refused with an actionable message", () => {
  const result = validateConfigFileJson({
    fleet_health_repo: "git@github.com:org/health.git",
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.field, "fleet_health_repo");
  assert(result.error.message.includes("callbacks"));
});

Deno.test("fleet health migration - both stale keys produce one error naming both", () => {
  const result = validateConfigFileJson({
    fleet_health_dir: "/tmp/health",
    fleet_health_repo: "git@github.com:org/health.git",
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.field, "fleet_health_dir, fleet_health_repo");
  assert(result.error.message.includes("fleet_health_dir"));
  assert(result.error.message.includes("fleet_health_repo"));
});

Deno.test("fleet health migration - an empty value is still a stale key, not a pass", () => {
  const result = validateConfigFileJson({ fleet_health_repo: "" });
  assertEquals(result.ok, false);
});

Deno.test("fleet health migration - the removed keys are no longer recognised config keys", () => {
  for (const key of ["fleet_health_dir", "fleet_health_repo"]) {
    assertEquals(
      KNOWN_CONFIG_KEYS.has(key),
      false,
      `${key} must not be a recognised config key`,
    );
    assert(
      REMOVED_CONFIG_KEYS.has(key),
      `${key} must carry a migration message`,
    );
  }
});

Deno.test("fleet health migration - loadConfig fails loudly on a stale config", async () => {
  await withConfig(async (path, write) => {
    await write({
      repos: ["org/repo"],
      fleet_health_repo: "git@github.com:org/health.git",
    });
    const error = await assertRejects(() => loadConfig(path), Error);
    assert(
      error.message.includes("fleet_health_repo"),
      `the failure must name the stale key: ${error.message}`,
    );
    assert(
      error.message.includes("callbacks"),
      `the failure must point at callbacks: ${error.message}`,
    );
  });
});

Deno.test("fleet health migration - a config without the removed keys is unchanged", async () => {
  await withConfig(async (path, write) => {
    await write({ repos: ["org/repo"] });
    const config = await loadConfig(path);
    assertEquals(config.repos, ["org/repo"]);
  });
});
