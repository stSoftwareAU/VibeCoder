/**
 * Tests for setup writing `service_accounts` (Issue #4030).
 *
 * The #3528 worker identity guard shipped INACTIVE on every host because
 * nothing in the setup path ever wrote `service_accounts`. Setup must now
 * write it — from `VIBE_SERVICE_ACCOUNTS` when supplied, otherwise defaulting
 * to the login setup just authenticated as, so the guard enforces from the
 * first run instead of warning forever.
 *
 * Australian English throughout (behaviour, authorised).
 */

import { assertEquals } from "@std/assert";
import {
  applyServiceAccountDefault,
  mergeNonInteractive,
} from "../setup/config_setup.ts";
import type { SetupConfig } from "../setup/config_setup.ts";
import { runConfigSetup } from "../setup/config_writer.ts";

/** Build an env getter from a plain record. */
function envOf(
  vars: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => vars[name];
}

// =============================================================================
// mergeNonInteractive — VIBE_SERVICE_ACCOUNTS
// =============================================================================

Deno.test("mergeNonInteractive - VIBE_SERVICE_ACCOUNTS is parsed as CSV", () => {
  const result = mergeNonInteractive(
    {},
    envOf({ VIBE_SERVICE_ACCOUNTS: "stsvcbot, Vibecoderbot" }),
  );

  assertEquals(result.service_accounts, ["stsvcbot", "Vibecoderbot"]);
});

Deno.test("mergeNonInteractive - VIBE_SERVICE_ACCOUNTS replaces the existing list", () => {
  const result = mergeNonInteractive(
    { service_accounts: ["old-account"] },
    envOf({ VIBE_SERVICE_ACCOUNTS: "stsvcbot" }),
  );

  assertEquals(result.service_accounts, ["stsvcbot"]);
});

Deno.test("mergeNonInteractive - existing service_accounts survive when the env var is absent", () => {
  const result = mergeNonInteractive(
    { service_accounts: ["stsvcbot", "Vibecoderbot"] },
    envOf({}),
  );

  assertEquals(result.service_accounts, ["stsvcbot", "Vibecoderbot"]);
});

// =============================================================================
// applyServiceAccountDefault — pure fallback to the resolved worker login
// =============================================================================

Deno.test("applyServiceAccountDefault - defaults an absent list to the worker login", () => {
  const { config, defaulted } = applyServiceAccountDefault({}, "Vibecoderbot");

  assertEquals(config.service_accounts, ["Vibecoderbot"]);
  assertEquals(defaulted, true);
});

Deno.test("applyServiceAccountDefault - defaults a blank-only list to the worker login", () => {
  const { config, defaulted } = applyServiceAccountDefault(
    { service_accounts: ["  ", ""] },
    "stsvcbot",
  );

  assertEquals(config.service_accounts, ["stsvcbot"]);
  assertEquals(defaulted, true);
});

Deno.test("applyServiceAccountDefault - never overrides a configured allowlist", () => {
  const { config, defaulted } = applyServiceAccountDefault(
    { service_accounts: ["stsvcbot", "Vibecoderbot"] },
    "someone-else",
  );

  assertEquals(config.service_accounts, ["stsvcbot", "Vibecoderbot"]);
  assertEquals(defaulted, false);
});

Deno.test("applyServiceAccountDefault - leaves the list empty when no login resolves", () => {
  const { config, defaulted } = applyServiceAccountDefault({}, undefined);

  assertEquals(config.service_accounts, undefined);
  assertEquals(defaulted, false);
});

Deno.test("applyServiceAccountDefault - does not mutate the input config", () => {
  const input: SetupConfig = {};
  applyServiceAccountDefault(input, "Vibecoderbot");

  assertEquals(input.service_accounts, undefined);
});

// =============================================================================
// runConfigSetup — end-to-end write of service_accounts
// =============================================================================

Deno.test("runConfigSetup - writes both accounts from VIBE_SERVICE_ACCOUNTS", async () => {
  const tmpDir = await Deno.makeTempDir();
  const configPath = `${tmpDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify({ repos: ["org/repo"] }));

  const result = await runConfigSetup(
    configPath,
    envOf({ VIBE_SERVICE_ACCOUNTS: "stsvcbot,Vibecoderbot" }),
    { resolveWorkerLogin: () => Promise.resolve("should-not-be-used") },
  );
  assertEquals(result.ok, true);

  const written = JSON.parse(await Deno.readTextFile(configPath));
  assertEquals(written.service_accounts, ["stsvcbot", "Vibecoderbot"]);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("runConfigSetup - falls back to the resolved worker login", async () => {
  const tmpDir = await Deno.makeTempDir();
  const configPath = `${tmpDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify({ repos: ["org/repo"] }));

  const result = await runConfigSetup(configPath, envOf({}), {
    resolveWorkerLogin: () => Promise.resolve("Vibecoderbot"),
  });
  assertEquals(result.ok, true);
  // The default must be reported, never applied silently.
  assertEquals(
    (result.warnings ?? []).some((w) => w.includes("Vibecoderbot")),
    true,
  );

  const written = JSON.parse(await Deno.readTextFile(configPath));
  assertEquals(written.service_accounts, ["Vibecoderbot"]);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("runConfigSetup - passes gh_config_dir to the login resolver", async () => {
  const tmpDir = await Deno.makeTempDir();
  const configPath = `${tmpDir}/.config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({ gh_config_dir: "~/.config/gh-vibe" }),
  );

  const seen: (string | undefined)[] = [];
  await runConfigSetup(configPath, envOf({}), {
    resolveWorkerLogin: (dir) => {
      seen.push(dir);
      return Promise.resolve("stsvcbot");
    },
  });

  assertEquals(seen.length, 1);
  // `~` is expanded so `gh` reads the service-account config dir.
  assertEquals(seen[0]?.startsWith("~"), false);
  assertEquals(seen[0]?.endsWith("/.config/gh-vibe"), true);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("runConfigSetup - does not resolve a login when the allowlist is configured", async () => {
  const tmpDir = await Deno.makeTempDir();
  const configPath = `${tmpDir}/.config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({ service_accounts: ["stsvcbot"] }),
  );

  let calls = 0;
  const result = await runConfigSetup(configPath, envOf({}), {
    resolveWorkerLogin: () => {
      calls++;
      return Promise.resolve("someone-else");
    },
  });

  assertEquals(calls, 0);
  assertEquals(result.warnings ?? [], []);
  const written = JSON.parse(await Deno.readTextFile(configPath));
  assertEquals(written.service_accounts, ["stsvcbot"]);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("runConfigSetup - warns loudly when no login resolves and the guard stays inactive", async () => {
  const tmpDir = await Deno.makeTempDir();
  const configPath = `${tmpDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify({ repos: ["org/repo"] }));

  const result = await runConfigSetup(configPath, envOf({}), {
    resolveWorkerLogin: () => Promise.resolve(undefined),
  });
  assertEquals(result.ok, true);

  const warnings = (result.warnings ?? []).join("\n");
  assertEquals(warnings.includes("[SECURITY]"), true);
  assertEquals(warnings.includes("service_accounts"), true);

  const written = JSON.parse(await Deno.readTextFile(configPath));
  assertEquals(written.service_accounts, undefined);

  await Deno.remove(tmpDir, { recursive: true });
});
