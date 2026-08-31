/**
 * Release check library (Issue #689, part of #674).
 *
 * Three answers every release-aware caller needs, built once here rather than
 * re-derived per caller:
 *
 * 1. {@link latestRelease} — the newest release of the repository this
 *    checkout was cloned from.
 * 2. {@link compareToPin} — whether this host's `pinned_ref` is behind it.
 * 3. {@link releaseToolVersions} — the tool versions that release recorded in
 *    its `tool-versions.json` asset (Issue #688).
 *
 * A release is defined exactly as `.github/scripts/next-release-tag.sh`
 * defines one: a bare `MAJOR.MINOR.PATCH` triple, optionally `v`-prefixed.
 * Pre-releases (`1.0.0-rc1`), build metadata and moving names such as `latest`
 * are not part of the series and are ignored, and ordering is by numeric
 * segment so `1.0.10` beats `1.0.9`.
 *
 * **Nothing throws.** These checks run on the launch path, where a failed
 * check must degrade to a warning rather than an exception, so every function
 * returns a `Result` and every side effect arrives through
 * {@link ReleaseCheckDeps} — which makes the module unit-testable with no
 * `gh`, no git and no network. Every subprocess call is bounded by the shared
 * timeout helper, so an unreachable GitHub cannot hang a launch.
 *
 * **No caching.** One check per call; callers decide the cadence.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { parseOriginRepo } from "./host_escalation.ts";
import {
  parseReleaseManifest,
  RELEASE_MANIFEST_ASSET,
  RELEASE_VERSION_PATTERN,
  type ReleaseToolVersions,
} from "./release_manifest.ts";
import { compareSemver, parseSemver } from "./software_updates.ts";
import {
  EXTENDED_SUBPROCESS_TIMEOUT_MS,
  runWithTimeout,
  type SubprocessResult,
} from "./subprocess_timeout.ts";

/** Timeout for one `gh`/`git` call made by this module. */
export const RELEASE_CHECK_TIMEOUT_MS = EXTENDED_SUBPROCESS_TIMEOUT_MS;

/** How many releases are listed when looking for the newest one. */
export const RELEASE_LIST_LIMIT = 100;

/** A `pinned_ref` that names a commit rather than a tag. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/** Every side effect this module performs, injected so it can be faked. */
export interface ReleaseCheckDeps {
  /** `owner/repo` the worker checkout was cloned from. */
  resolveRepo(): Promise<Result<string>>;
  /** Run `gh` with the arguments given, bounded by a timeout. */
  runGh(args: readonly string[]): Promise<Result<SubprocessResult>>;
}

/** One release of the series, with its tag parsed for ordering. */
export interface ReleaseRef {
  /** The tag exactly as GitHub carries it, e.g. `1.0.10` or `v1.0.10`. */
  tag: string;
  /** The tag's numeric segments, for ordering. */
  version: readonly [number, number, number];
}

/**
 * How a host's `pinned_ref` relates to the newest release.
 *
 * The incomparable arm carries no `newer` at all: a commit SHA cannot be
 * ordered against a tag, and a guessed answer is worse than none.
 */
export type PinComparison =
  | {
    comparable: true;
    /** The `pinned_ref` as configured. */
    current: string;
    /** The newest release tag. */
    latest: string;
    /** Whether the newest release is strictly greater than the pin. */
    newer: boolean;
  }
  | {
    comparable: false;
    current: string;
    latest: string;
    newer?: undefined;
    /** Why the two cannot be ordered. */
    reason: string;
  };

/** What a release records about the tools it ships with. */
export type ReleaseManifestLookup =
  | { kind: "manifest"; tag: string; tools: ReleaseToolVersions }
  | { kind: "no-manifest"; tag: string; reason: string };

/** The fail-loud error shape every rejection in this module returns. */
function refuse(reason: string): Result<never> {
  return { ok: false, error: new Error(reason) };
}

/** Run `gh` through the injected dep, converting every fault to a Result. */
async function gh(
  deps: ReleaseCheckDeps,
  args: readonly string[],
  what: string,
): Promise<Result<string>> {
  let outcome: Result<SubprocessResult>;
  try {
    outcome = await deps.runGh(args);
  } catch (error) {
    return refuse(`${what} failed: ${(error as Error).message}`);
  }
  if (!outcome.ok) return refuse(`${what} failed: ${outcome.error.message}`);
  if (outcome.value.timedOut) {
    return refuse(
      `${what} timed out after ${RELEASE_CHECK_TIMEOUT_MS}ms — GitHub was ` +
        `not reachable in time.`,
    );
  }
  if (outcome.value.code !== 0) {
    const detail = outcome.value.stderr.trim() || outcome.value.stdout.trim() ||
      "no output";
    return refuse(
      `${what} failed with exit code ${outcome.value.code}: ${detail}`,
    );
  }
  return { ok: true, value: outcome.value.stdout };
}

/** Resolve the checkout's repository, converting every fault to a Result. */
async function repository(deps: ReleaseCheckDeps): Promise<Result<string>> {
  try {
    const repo = await deps.resolveRepo();
    if (!repo.ok) {
      return refuse(
        `cannot resolve the repository this checkout was cloned from: ` +
          `${repo.error.message}`,
      );
    }
    return repo;
  } catch (error) {
    return refuse(
      `cannot resolve the repository this checkout was cloned from: ` +
        `${(error as Error).message}`,
    );
  }
}

/** Parse `gh --json` output, naming the command when it is unreadable. */
function parseJson(text: string, what: string): Result<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return refuse(
      `${what} returned unreadable JSON: ${(error as Error).message}`,
    );
  }
}

/**
 * Whether a tag belongs to the release series.
 *
 * The same definition `.github/scripts/next-release-tag.sh` applies, so a
 * pre-release, a build-metadata tag or a moving name such as `latest` is not
 * a release here either.
 */
export function isReleaseTag(tag: string): boolean {
  return RELEASE_VERSION_PATTERN.test(tag);
}

/** The numeric segments of a release tag, or null when it is not one. */
function releaseVersion(tag: string): [number, number, number] | null {
  return isReleaseTag(tag) ? parseSemver(tag) : null;
}

/**
 * The newest release of the repository this checkout was cloned from.
 *
 * Drafts and releases GitHub marks as pre-releases are skipped, as is any tag
 * outside the series. Ordering is numeric per segment, so `1.0.10` beats
 * `1.0.9`.
 *
 * @param deps - Injected `gh` and repository resolution.
 * @returns The newest release, or `null` when the repository has none yet —
 *   an empty series is a clean outcome, not a failure.
 */
export async function latestRelease(
  deps: ReleaseCheckDeps,
): Promise<Result<ReleaseRef | null>> {
  const repo = await repository(deps);
  if (!repo.ok) return repo;

  const what = "gh release list";
  const output = await gh(deps, [
    "release",
    "list",
    "--repo",
    repo.value,
    "--limit",
    String(RELEASE_LIST_LIMIT),
    "--json",
    "tagName,isDraft,isPrerelease",
  ], what);
  if (!output.ok) return output;

  const parsed = parseJson(output.value, what);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) {
    return refuse(`${what} did not return a JSON array of releases.`);
  }

  let newest: ReleaseRef | null = null;
  for (const entry of parsed.value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record["isDraft"] === true || record["isPrerelease"] === true) continue;
    const tag = record["tagName"];
    if (typeof tag !== "string") continue;
    const version = releaseVersion(tag);
    if (!version) continue;
    if (!newest || compareSemver(version, newest.version) > 0) {
      newest = { tag, version };
    }
  }
  return { ok: true, value: newest };
}

/**
 * Compare a host's `pinned_ref` against the newest release.
 *
 * A `pinned_ref` that is a release tag compares numerically. The other pin
 * shape `docs/CONFIGURATION.md` accepts — a commit SHA — is not orderable
 * against a tag, and neither is any other ref: both report
 * `comparable: false` with a reason and no `newer` at all. Callers decide what
 * to do with that.
 *
 * @param pinnedRef - The configured `pinned_ref`.
 * @param latest - The newest release tag, as {@link latestRelease} reports it.
 */
export function compareToPin(
  pinnedRef: string,
  latest: string,
): Result<PinComparison> {
  const current = pinnedRef.trim();
  const newest = latest.trim();
  if (current === "") {
    return refuse("cannot compare an empty pinned_ref against a release.");
  }
  const latestVersion = releaseVersion(newest);
  if (!latestVersion) {
    return refuse(
      `${JSON.stringify(latest)} is not a MAJOR.MINOR.PATCH release tag, so ` +
        `there is nothing to compare pinned_ref against.`,
    );
  }

  const pinnedVersion = releaseVersion(current);
  if (pinnedVersion) {
    return {
      ok: true,
      value: {
        comparable: true,
        current,
        latest: newest,
        newer: compareSemver(latestVersion, pinnedVersion) > 0,
      },
    };
  }

  const reason = COMMIT_SHA_PATTERN.test(current)
    ? `pinned_ref ${current} is a commit SHA, which cannot be ordered ` +
      `against release tag ${newest} — only a release tag compares.`
    : `pinned_ref ${JSON.stringify(current)} is not a release tag, so it ` +
      `cannot be ordered against ${newest}.`;
  return {
    ok: true,
    value: { comparable: false, current, latest: newest, reason },
  };
}

/**
 * The tool versions a release recorded in its `tool-versions.json` asset.
 *
 * A release minted before Issue #688 carries no asset. That is reported as a
 * `no-manifest` outcome naming the tag — deliberately distinguishable from a
 * failed `Result`, because "this release predates the manifest" and "GitHub
 * could not be reached" need different handling upstream.
 *
 * A manifest that is present but malformed or partial is a failed `Result`
 * naming the offending field: a half-read version set would let a host drift
 * on whichever tool it left out.
 *
 * @param tag - Release tag to read, e.g. `1.0.8`.
 * @param deps - Injected `gh` and repository resolution.
 */
export async function releaseToolVersions(
  tag: string,
  deps: ReleaseCheckDeps,
): Promise<Result<ReleaseManifestLookup>> {
  const release = tag.trim();
  if (!isReleaseTag(release)) {
    return refuse(
      `${JSON.stringify(tag)} is not a MAJOR.MINOR.PATCH release tag, so no ` +
        `${RELEASE_MANIFEST_ASSET} was looked up.`,
    );
  }

  const repo = await repository(deps);
  if (!repo.ok) return repo;

  const viewing = `gh release view ${release}`;
  const view = await gh(deps, [
    "release",
    "view",
    release,
    "--repo",
    repo.value,
    "--json",
    "assets",
  ], viewing);
  if (!view.ok) return view;

  const parsed = parseJson(view.value, viewing);
  if (!parsed.ok) return parsed;
  const assets = (parsed.value as { assets?: unknown } | null)?.assets;
  if (!Array.isArray(assets)) {
    return refuse(`${viewing} did not report the release's assets.`);
  }

  const carriesManifest = assets.some((asset) =>
    typeof asset === "object" && asset !== null &&
    (asset as Record<string, unknown>)["name"] === RELEASE_MANIFEST_ASSET
  );
  if (!carriesManifest) {
    return {
      ok: true,
      value: {
        kind: "no-manifest",
        tag: release,
        reason: `Release ${release} carries no ${RELEASE_MANIFEST_ASSET} ` +
          `asset — it was minted before releases recorded the tool versions ` +
          `they ship with.`,
      },
    };
  }

  const download = await gh(deps, [
    "release",
    "download",
    release,
    "--repo",
    repo.value,
    "--pattern",
    RELEASE_MANIFEST_ASSET,
    "--output",
    "-",
  ], `gh release download ${release} ${RELEASE_MANIFEST_ASSET}`);
  if (!download.ok) return download;

  const manifest = parseReleaseManifest(download.value);
  if (!manifest.ok) {
    return refuse(
      `Release ${release}: ${manifest.error.message}`,
    );
  }
  return {
    ok: true,
    value: { kind: "manifest", tag: release, tools: manifest.value.tools },
  };
}

/**
 * The real deps: `gh` and `git` bounded by the shared timeout helper.
 *
 * @param repoDir - The worker checkout whose `origin` names the repository.
 * @param timeoutMs - Per-call timeout; the shared default otherwise.
 */
export function createDefaultReleaseCheckDeps(
  repoDir: string,
  timeoutMs: number = RELEASE_CHECK_TIMEOUT_MS,
): ReleaseCheckDeps {
  return {
    resolveRepo: async () => {
      const origin = await runWithTimeout(
        "git",
        ["remote", "get-url", "origin"],
        { cwd: repoDir, timeoutMs },
      );
      if (!origin.ok) return origin;
      if (origin.value.timedOut) {
        return refuse(`git remote get-url origin timed out in ${repoDir}.`);
      }
      if (origin.value.code !== 0) {
        return refuse(
          `git remote get-url origin failed in ${repoDir}: ` +
            `${origin.value.stderr.trim() || "no output"}`,
        );
      }
      const repo = parseOriginRepo(origin.value.stdout);
      if (!repo) {
        return refuse(
          `origin is not a GitHub repository: ${origin.value.stdout.trim()}`,
        );
      }
      return { ok: true, value: repo };
    },
    runGh: (args) => runWithTimeout("gh", [...args], { timeoutMs }),
  };
}
