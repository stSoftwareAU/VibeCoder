/**
 * release-manifest command (Issue #688, part of #674).
 *
 * Prints the release tool-version manifest — the Claude CLI, `gh` and Deno
 * versions a release ships with — as JSON on stdout, so
 * `.github/workflows/release-tag.yml` can redirect it straight into the
 * `tool-versions.json` asset it publishes for the tag.
 *
 * Usage:
 *   deno run --allow-net --allow-run --allow-env --allow-read \
 *     mod.ts release-manifest --release 1.0.8
 *
 * The versions come from `resolveQuarantineClearedVersions()` (Issue #726) —
 * the newest release of each tool that the release-age gate has already let
 * through, so a release records versions a host may install today. Upstream
 * ships several times a day, so gating the manifest on upstream's *newest*
 * release instead left it inside the 24h quarantine window on nearly every
 * merge and published nothing at all.
 *
 * Stdout carries exactly the manifest and nothing else. A tool whose version
 * cannot be resolved — or that the gate reports ineligible — throws, which
 * `mod.ts` reports on stderr and exits non-zero for: stdout stays empty and
 * the workflow publishes nothing, rather than a manifest silently missing a
 * tool (Issue #622).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Command, CommandResult } from "../types.ts";
import { defaultLogger } from "../lib/logger.ts";
import {
  buildReleaseManifest,
  formatReleaseManifest,
  RELEASE_VERSION_PATTERN,
  type ReleaseManifest,
} from "../lib/release_manifest.ts";
import {
  type DynamicVersionCandidate,
  resolveQuarantineClearedVersions,
} from "../lib/software_updates.ts";

/** Injectable side effects, so the command is testable without the network. */
export interface ReleaseManifestDeps {
  /** Newest quarantine-cleared version per tool (Issue #726). */
  toolVersions(): Promise<DynamicVersionCandidate[]>;
}

/** The real resolution: the release-age gate against npm and GitHub. */
export function createDefaultReleaseManifestDeps(): ReleaseManifestDeps {
  // `defaultLogger` writes to stderr, so gate commentary never reaches the
  // manifest on stdout.
  return {
    toolVersions: () => resolveQuarantineClearedVersions(defaultLogger),
  };
}

/** Read the required `--release` argument, failing loud on anything else. */
function readRelease(args: Record<string, unknown>): string {
  const release = args["release"];
  if (typeof release !== "string" || !RELEASE_VERSION_PATTERN.test(release)) {
    throw new Error(
      "release-manifest needs --release <MAJOR.MINOR.PATCH> — the release " +
        `tag the manifest describes; got ${JSON.stringify(release ?? null)}.`,
    );
  }
  return release;
}

/** Build the command with injectable deps (tests) or the real gate. */
export function createReleaseManifestCommand(
  deps: ReleaseManifestDeps = createDefaultReleaseManifestDeps(),
): Command {
  return {
    name: "release-manifest",
    description:
      "Print the tool-version manifest a release ships with — Claude CLI, gh " +
      "and Deno — as JSON (Issue #688)",

    async execute(
      args: Record<string, unknown>,
    ): Promise<CommandResult<ReleaseManifest>> {
      const release = readRelease(args);
      const candidates = await deps.toolVersions();
      const manifest = buildReleaseManifest(release, candidates);
      if (!manifest.ok) {
        // Thrown, not returned: a failed result still prints its message on
        // stdout, which would land in the asset the workflow redirects into.
        throw manifest.error;
      }

      return {
        success: true,
        // `mod.ts` prints the message verbatim — this IS the asset body.
        message: formatReleaseManifest(manifest.value).trimEnd(),
        data: manifest.value,
      };
    },
  };
}

/** The registered command, wired to the real release-age gate. */
export const releaseManifestCommand: Command = createReleaseManifestCommand();
