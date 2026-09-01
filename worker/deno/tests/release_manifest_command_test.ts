/**
 * Tests for the `release-manifest` command (Issue #688, part of #674).
 *
 * The command is what the release workflow runs to mint `tool-versions.json`,
 * so stdout has to be exactly the manifest and nothing else, and an
 * unresolvable tool has to fail loudly rather than print a manifest missing a
 * version.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createReleaseManifestCommand } from "../commands/release_manifest.ts";
import { parseReleaseManifest } from "../lib/release_manifest.ts";
import {
  type DynamicVersionCandidate,
  resolveQuarantineClearedVersions,
} from "../lib/software_updates.ts";
import { createReleaseAgeGate } from "../lib/tool_release_age.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { Logger, Result, WorkerConfig } from "../types.ts";

const CONFIG: WorkerConfig = buildDefaultWorkerConfig();

/** Logger that captures gate commentary — stdout is the asset under test. */
function quietLogger(): { logger: Logger; messages: string[] } {
  const messages: string[] = [];
  return {
    logger: createLogger({ write: (message) => messages.push(message) }),
    messages,
  };
}

/** Candidates as the release-age gate reports them when all three are usable. */
const ELIGIBLE: DynamicVersionCandidate[] = [
  { tool: "claude", version: "2.0.76", eligible: true, reason: "old enough" },
  { tool: "gh", version: "2.62.0", eligible: true, reason: "old enough" },
  { tool: "deno", version: "2.5.4", eligible: true, reason: "old enough" },
];

/** Build the command over a fixed set of candidates. */
function commandOver(candidates: DynamicVersionCandidate[]) {
  return createReleaseManifestCommand({
    toolVersions: () => Promise.resolve(candidates),
  });
}

Deno.test("release-manifest - prints the manifest for the release on stdout", async () => {
  const result = await commandOver(ELIGIBLE).execute(
    { release: "1.0.8" },
    CONFIG,
  );
  assertEquals(result.success, true);

  // The message IS the asset: the workflow redirects stdout into the file.
  const parsed = parseReleaseManifest(result.message);
  assert(parsed.ok, parsed.ok ? "" : parsed.error.message);
  assertEquals(parsed.value, {
    release: "1.0.8",
    tools: { claude: "2.0.76", gh: "2.62.0", deno: "2.5.4" },
  });
  assertEquals(result.data, parsed.value);
});

Deno.test("release-manifest - resolves the versions rather than inventing them", async () => {
  let calls = 0;
  const command = createReleaseManifestCommand({
    toolVersions: () => {
      calls++;
      return Promise.resolve([
        { tool: "claude", version: "9.9.9", eligible: true, reason: "r" },
        { tool: "gh", version: "8.8.8", eligible: true, reason: "r" },
        { tool: "deno", version: "7.7.7", eligible: true, reason: "r" },
      ]);
    },
  });
  const result = await command.execute({ release: "2.3.4" }, CONFIG);
  assertEquals(calls, 1);
  assertEquals(result.data, {
    release: "2.3.4",
    tools: { claude: "9.9.9", gh: "8.8.8", deno: "7.7.7" },
  });
});

Deno.test("release-manifest - an unresolved tool fails the command, naming it", async () => {
  const command = commandOver([
    ELIGIBLE[0]!,
    ELIGIBLE[1]!,
    {
      tool: "deno",
      version: null,
      eligible: false,
      reason: "Deno 2.5.5 was published 40 minutes ago",
    },
  ]);
  const error = await assertRejects(
    () => command.execute({ release: "1.0.8" }, CONFIG),
    Error,
  );
  assertStringIncludes(error.message, "deno");
  assertStringIncludes(error.message, "published 40 minutes ago");
});

Deno.test("release-manifest - a missing or unusable --release fails loudly", async () => {
  for (
    const args of [{}, { release: true }, { release: 1 }, { release: "latest" }]
  ) {
    const error = await assertRejects(
      () => commandOver(ELIGIBLE).execute(args, CONFIG),
      Error,
    );
    assertStringIncludes(error.message, "--release");
  }
});

Deno.test("release-manifest - a gate that throws is not swallowed", async () => {
  const command = createReleaseManifestCommand({
    toolVersions: () => Promise.reject(new Error("npm registry unreachable")),
  });
  const error = await assertRejects(
    () => command.execute({ release: "1.0.8" }, CONFIG),
    Error,
  );
  assertStringIncludes(error.message, "npm registry unreachable");
});

// ---------- The quarantined-latest regression (Issue #726) ----------

/**
 * The whole chain over a stubbed upstream, in the shape that broke the
 * release-tag workflow: the newest Claude CLI release is hours old, so the
 * quarantine window defers it, and every merge to `main` published no manifest
 * at all. The manifest now records the newest release the embargo has already
 * let through, so the publish succeeds without weakening the window.
 */
Deno.test("release-manifest - a quarantined latest release still yields a manifest", async () => {
  const now = new Date("2026-09-01T14:47:00Z");
  const gate = createReleaseAgeGate({
    now: () => now,
    fetchNpmMetadata: () =>
      Promise.resolve({
        "dist-tags": { latest: "2.1.252" },
        versions: { "2.1.251": {}, "2.1.252": {} },
        time: {
          // Published 21.7h before `now` — inside the 24h window.
          "2.1.252": "2026-08-31T17:05:00Z",
          "2.1.251": "2026-08-30T09:00:00Z",
        },
      }),
    runFn: (cmd: string[]) => {
      const path = cmd.join(" ");
      const output = path.includes("cli/cli")
        ? "v2.83.0 2026-08-25T10:00:00Z"
        : "v2.5.9 2026-08-20T10:00:00Z";
      return Promise.resolve({
        ok: true,
        value: { exitCode: 0, output },
      } as Result<{ exitCode: number; output: string }>);
    },
  });

  const { logger } = quietLogger();
  const command = createReleaseManifestCommand({
    toolVersions: () =>
      resolveQuarantineClearedVersions(logger, { ageGate: gate }),
  });

  const result = await command.execute({ release: "1.0.21" }, CONFIG);
  const parsed = parseReleaseManifest(result.message);
  assert(parsed.ok, parsed.ok ? "" : parsed.error.message);
  assertEquals(parsed.value, {
    release: "1.0.21",
    tools: { claude: "2.1.251", gh: "2.83.0", deno: "2.5.9" },
  });
});

Deno.test("release-manifest - a tool with nothing past the window still fails loud", async () => {
  const now = new Date("2026-09-01T14:47:00Z");
  const gate = createReleaseAgeGate({
    now: () => now,
    fetchNpmMetadata: () =>
      Promise.resolve({
        "dist-tags": { latest: "2.1.252" },
        versions: { "2.1.252": {} },
        time: { "2.1.252": "2026-09-01T13:00:00Z" },
      }),
    runFn: () =>
      Promise.resolve({
        ok: true,
        value: { exitCode: 0, output: "v2.5.9 2026-08-20T10:00:00Z" },
      } as Result<{ exitCode: number; output: string }>),
  });

  const { logger } = quietLogger();
  const command = createReleaseManifestCommand({
    toolVersions: () =>
      resolveQuarantineClearedVersions(logger, { ageGate: gate }),
  });

  const error = await assertRejects(
    () => command.execute({ release: "1.0.21" }, CONFIG),
    Error,
  );
  assertStringIncludes(error.message, "claude");
});
