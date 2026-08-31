/**
 * The release tool-version manifest (Issue #688, part of #674).
 *
 * Every release records the exact Claude CLI, `gh` and Deno versions it was
 * cut against, published as a `tool-versions.json` asset on the GitHub Release
 * for the tag. A host that pins to a release can then pin to the same tools
 * the release was minted with, instead of drifting onto whatever is newest.
 *
 * The shape is one object, every field required:
 *
 * ```json
 * {
 *   "release": "1.0.8",
 *   "tools": { "claude": "2.0.76", "gh": "2.62.0", "deno": "2.5.4" }
 * }
 * ```
 *
 * Both halves live here so the generator and every reader share one
 * definition rather than each re-parsing the JSON by hand.
 *
 * **All-or-nothing (Issue #622).** A manifest naming two tools out of three
 * would silently let a host drift on the third, so a tool whose version cannot
 * be resolved — or that the release-age gate reports ineligible — produces no
 * manifest at all and an error naming that tool. The parser is equally strict:
 * a partial or malformed manifest is an error, never a half-read object.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { PINNED_TOOLS } from "./config_defaults.ts";
import {
  type DynamicVersionCandidate,
  PINNED_VERSION_PATTERN,
  type PinnedTool,
} from "./software_updates.ts";
import type { Result } from "../types.ts";

/** Name of the release asset carrying the manifest. */
export const RELEASE_MANIFEST_ASSET = "tool-versions.json";

/**
 * Release names the manifest may carry.
 *
 * The same bare `MAJOR.MINOR.PATCH` triple (optionally `v`-prefixed) that
 * `.github/scripts/next-release-tag.sh` mints, so the manifest can never name
 * a release the tagging series would not produce.
 */
export const RELEASE_VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/;

/** Exact tool versions one release ships with. */
export interface ReleaseToolVersions {
  /** Claude Code CLI version, e.g. `2.0.76`. */
  claude: string;
  /** GitHub CLI version, e.g. `2.62.0`. */
  gh: string;
  /** Deno version, e.g. `2.5.4`. */
  deno: string;
}

/** One release and the tool versions it ships with. */
export interface ReleaseManifest {
  /** The release tag the manifest describes, e.g. `1.0.8`. */
  release: string;
  /** Exact version per tool — all three, always. */
  tools: ReleaseToolVersions;
}

/** The fail-loud error shape every rejection in this module returns. */
function refuse(reason: string): Result<never> {
  return { ok: false, error: new Error(reason) };
}

/** Reject a release name that is not a tag the series mints. */
function releaseNameError(release: unknown): string | null {
  if (typeof release !== "string") {
    return `"release" must be a MAJOR.MINOR.PATCH string, not ${typeof release}`;
  }
  if (!RELEASE_VERSION_PATTERN.test(release)) {
    return `"release" ${
      JSON.stringify(release)
    } is not a MAJOR.MINOR.PATCH release tag`;
  }
  return null;
}

/**
 * Build the manifest for a release from what dynamic mode would install now.
 *
 * The candidates come from `resolveDynamicVersions()` (Issue #623), so what a
 * release records is exactly what an unpinned install would have adopted when
 * the release was minted — the release-age gate included.
 *
 * @param release - Release tag the manifest describes.
 * @param candidates - One candidate per tool, in any order.
 * @returns The manifest, or an error naming every tool that could not be
 *   recorded. Never a partially populated manifest.
 */
export function buildReleaseManifest(
  release: string,
  candidates: readonly DynamicVersionCandidate[],
): Result<ReleaseManifest> {
  const nameError = releaseNameError(release);
  if (nameError) {
    return refuse(`Cannot build ${RELEASE_MANIFEST_ASSET}: ${nameError}.`);
  }

  const byTool = new Map<PinnedTool, DynamicVersionCandidate>(
    candidates.map((candidate) => [candidate.tool, candidate]),
  );
  const versions: Partial<ReleaseToolVersions> = {};
  const failures: string[] = [];

  for (const tool of PINNED_TOOLS) {
    const candidate = byTool.get(tool);
    if (!candidate) {
      failures.push(`${tool}: the release-age gate reported no candidate.`);
      continue;
    }
    if (!candidate.eligible || candidate.version === null) {
      failures.push(`${tool}: ${candidate.reason}`);
      continue;
    }
    if (!PINNED_VERSION_PATTERN.test(candidate.version)) {
      failures.push(
        `${tool}: resolved version ${
          JSON.stringify(candidate.version)
        } is not a plain semver, so no host could install it.`,
      );
      continue;
    }
    versions[tool] = candidate.version;
  }

  if (failures.length > 0) {
    return refuse(
      `Cannot build ${RELEASE_MANIFEST_ASSET} for ${release} — a manifest ` +
        `naming only some tools would let a host drift on the rest, so none ` +
        `was produced:\n  - ${failures.join("\n  - ")}`,
    );
  }

  return {
    ok: true,
    value: {
      release,
      tools: {
        claude: versions.claude!,
        gh: versions.gh!,
        deno: versions.deno!,
      },
    },
  };
}

/**
 * Render a manifest as the exact bytes of the release asset.
 *
 * Keys are emitted in the documented order and the text ends with a newline,
 * so the published asset is byte-stable for a given set of versions.
 */
export function formatReleaseManifest(manifest: ReleaseManifest): string {
  return `${
    JSON.stringify(
      {
        release: manifest.release,
        tools: {
          claude: manifest.tools.claude,
          gh: manifest.tools.gh,
          deno: manifest.tools.deno,
        },
      },
      null,
      2,
    )
  }\n`;
}

/**
 * Parse and validate a `tool-versions.json` asset.
 *
 * Strict by design: unknown keys, missing tools, non-string versions and
 * versions no installer would accept are all errors. A reader deciding what to
 * install must never act on half a manifest.
 *
 * @param text - Raw asset contents.
 * @returns The validated manifest, or an error naming what is wrong.
 */
export function parseReleaseManifest(text: string): Result<ReleaseManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return refuse(
      `${RELEASE_MANIFEST_ASSET} is not readable JSON: ${
        (error as Error).message
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse(`${RELEASE_MANIFEST_ASSET} does not hold a JSON object.`);
  }

  const record = parsed as Record<string, unknown>;
  const nameError = releaseNameError(record["release"]);
  if (nameError) return refuse(`${RELEASE_MANIFEST_ASSET}: ${nameError}.`);

  const tools = record["tools"];
  if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
    return refuse(
      `${RELEASE_MANIFEST_ASSET}: "tools" must be an object naming ` +
        `${PINNED_TOOLS.join(", ")}.`,
    );
  }

  const toolRecord = tools as Record<string, unknown>;
  const problems: string[] = [];
  const versions: Partial<ReleaseToolVersions> = {};

  for (const key of Object.keys(toolRecord)) {
    if (!(PINNED_TOOLS as readonly string[]).includes(key)) {
      problems.push(
        `"tools" names ${JSON.stringify(key)}, which is not a pinned tool`,
      );
    }
  }

  for (const tool of PINNED_TOOLS) {
    const version = toolRecord[tool];
    if (version === undefined) {
      problems.push(`"tools.${tool}" is missing`);
      continue;
    }
    if (typeof version !== "string") {
      problems.push(`"tools.${tool}" must be a version string`);
      continue;
    }
    if (!PINNED_VERSION_PATTERN.test(version)) {
      problems.push(
        `"tools.${tool}" ${JSON.stringify(version)} is not a plain semver`,
      );
      continue;
    }
    versions[tool] = version;
  }

  if (problems.length > 0) {
    return refuse(
      `${RELEASE_MANIFEST_ASSET} is not a complete manifest: ${
        problems.join("; ")
      }.`,
    );
  }

  return {
    ok: true,
    value: {
      release: record["release"] as string,
      tools: {
        claude: versions.claude!,
        gh: versions.gh!,
        deno: versions.deno!,
      },
    },
  };
}
