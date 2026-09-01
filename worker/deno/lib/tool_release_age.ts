/**
 * Release-age quarantine for host toolchain upgrades (Issue #3655).
 *
 * The bootstrap prelude upgrades four externally-distributed executables —
 * the Claude CLI, the `gh` binary, every installed `gh` extension, and Deno.
 * Every other external ecosystem in this repository is embargoed for at least
 * `VIBE_BUMP_QUARANTINE_HOURS` (default 24h) — `renovate.json`
 * `minimumReleaseAge`, `deno.json` `minimumDependencyAge`, and
 * `npm_package_age.ts` — but the tool-update path adopted whatever upstream
 * published at that instant. A hijacked release was therefore installed as
 * readily as one published months ago, on hosts holding `GH_TOKEN`, a GitHub
 * App private key, and `ANTHROPIC_API_KEY`.
 *
 * This module resolves the *candidate* release for a tool and decides whether
 * it has aged past the quarantine window. It is pure and fully injectable so
 * it can be unit-tested with no network access.
 *
 * **Fail-closed (Issue #3234).** Unlike `npm_package_age.ts` — where an
 * unverifiable age must not break an offline operator setup — an unverifiable
 * tool release *blocks* the upgrade and logs loudly. Deferring an optional
 * upgrade is harmless; adopting an unverifiable binary is not.
 *
 * Australian English used throughout (behaviour, organisation, authorised).
 */

import type { Result } from "../types.ts";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  discardBody,
  readTextBounded,
  withRequestTimeout,
} from "./bounded_fetch.ts";
import { MAX_NPM_RESPONSE_BYTES } from "./npm_package_age.ts";

/** Default quarantine window in hours (mirrors `VIBE_BUMP_QUARANTINE_HOURS`). */
export const DEFAULT_TOOL_QUARANTINE_HOURS = 24;

/** npm package the Claude CLI is distributed through. */
export const CLAUDE_CLI_NPM_PACKAGE = "@anthropic-ai/claude-code";

/** GitHub repository publishing `gh` releases. */
export const GH_CLI_RELEASE_REPO = "cli/cli";

/** GitHub repository publishing Deno releases. */
export const DENO_RELEASE_REPO = "denoland/deno";

/** Base URL of the public npm registry. */
export const NPM_REGISTRY_BASE = "https://registry.npmjs.org";

/** Timeout (seconds) for a single release-metadata lookup. */
export const RELEASE_LOOKUP_TIMEOUT_SECONDS = 30;

/** `owner/repo` shape accepted in a GitHub API path (no traversal, no shell). */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** npm package name shape accepted in a registry URL. */
const NPM_PACKAGE_PATTERN = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;

/** Branch name shape accepted in a GitHub API path (no traversal, no shell). */
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Commit sha shape emitted by the commits API. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * A plain stable release version: `MAJOR.MINOR.PATCH`, no pre-release suffix
 * and no build metadata. Only these are considered when falling back to the
 * newest release past the quarantine window (Issue #726).
 */
const STABLE_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * `GOOS-GOARCH` asset suffix that marks a **binary** `gh` extension.
 *
 * Mirrors `gh`'s own rule (`isBinExtension` in `cli/cli`): an extension is
 * installed from its latest release only when that release carries an asset
 * whose name *ends* in `<goos>-<goarch>` — with `.exe` appended on Windows.
 * Anything else — including a repository that merely tags releases — is a
 * *script* extension, which `gh` installs by cloning the default branch.
 */
const BINARY_ASSET_SUFFIX =
  /(?:(?:aix|android|darwin|dragonfly|freebsd|illumos|ios|js|linux|netbsd|openbsd|plan9|solaris)-(?:386|amd64|arm|arm64|loong64|mips|mips64|mips64le|mipsle|ppc64|ppc64le|riscv64|s390x|wasm)|windows-(?:386|amd64|arm|arm64)\.exe)$/;

/** Upstream channel a tool's releases are published through. */
export type ReleaseChannel =
  | { kind: "npm"; pkg: string }
  | { kind: "github"; repo: string }
  | { kind: "gh-extension"; repo: string };

/** Human-readable label for a channel, used in log lines. */
export function describeChannel(channel: ReleaseChannel): string {
  if (channel.kind === "npm") return `npm:${channel.pkg}`;
  if (channel.kind === "gh-extension") return `gh-extension:${channel.repo}`;
  return `github:${channel.repo}`;
}

/** The newest release a channel offers. */
export interface ReleaseCandidate {
  /** Resolved version with any leading `v` stripped, or null when unknown. */
  version: string | null;
  /** ISO publish timestamp, or null when unknown. */
  publishedAt: string | null;
  /**
   * Exact upstream ref the date belongs to — a release tag verbatim or a
   * commit sha (Issue #3952). Null when the channel installs no pinnable ref.
   */
  ref?: string | null;
}

/** Verdict for one channel's newest release. */
export interface ReleaseAgeVerdict {
  /** Channel label the verdict applies to. */
  source: string;
  /** Resolved candidate version, or null when it could not be determined. */
  version: string | null;
  /**
   * Exact ref the verdict dated, for callers that pin the install to it
   * (Issue #3952). Null when no installable ref could be resolved.
   */
  ref?: string | null;
  /** True when the candidate has aged past the quarantine window. */
  eligible: boolean;
  /** True when the release age could not be determined at all. */
  indeterminate: boolean;
  /** Age in hours since publication, or null when indeterminate. */
  ageHours: number | null;
  /** ISO publish timestamp, or null when indeterminate. */
  publishedAt: string | null;
  /** Human-readable explanation suitable for a log line. */
  reason: string;
}

/** A gate consulted before any toolchain upgrade runs. */
export interface ReleaseAgeGate {
  /** Effective quarantine window in hours. */
  quarantineHours: number;
  /** Verdict for a channel. Never throws — failures become indeterminate. */
  check(channel: ReleaseChannel): Promise<ReleaseAgeVerdict>;
  /**
   * Verdict for the newest release of a channel that has *already* cleared the
   * quarantine window (Issue #726).
   *
   * {@link check} answers "may the newest release be adopted?", which is the
   * question an upgrade asks. A caller that has to name an installable version
   * — the release tool-version manifest — asks this instead: upstream ships
   * several times a day, so the newest release is usually inside the window and
   * the honest answer is the newest one outside it, not a failure.
   *
   * Never throws, and never widens the embargo: a history with nothing past the
   * window is ineligible, exactly as {@link check} would report it.
   */
  checkNewestAged(channel: ReleaseChannel): Promise<ReleaseAgeVerdict>;
}

/** An installed `gh` extension. */
export interface GhExtension {
  /** Short name `gh` refers to the extension by, used in log lines. */
  name: string;
  /** Source repository in `owner/repo` form. */
  repo: string;
}

/** Injectable side-effects for {@link createReleaseAgeGate}. */
export interface ReleaseAgeGateDeps {
  /** Command runner used for `gh api` lookups. */
  runFn: (
    cmd: string[],
    timeoutSeconds: number,
  ) => Promise<Result<{ exitCode: number; output: string }>>;
  /** Quarantine window in hours (default 24, non-positive values rejected). */
  quarantineHours?: number;
  /** Fetch raw npm registry metadata; resolves undefined on any failure. */
  fetchNpmMetadata?: (pkg: string) => Promise<unknown>;
  /** Current wall-clock time. */
  now?: () => Date;
  /** Reports a rejected quarantine window. */
  warn?: (message: string) => void;
}

/**
 * Normalise a configured quarantine window to a usable number of hours.
 *
 * Only a positive whole number of hours is accepted. Anything else — zero, a
 * negative, a fraction, or unparseable text — falls back to the documented
 * default and is reported, so the embargo can never be silently switched off
 * (the Issue #3649 / #3659 failure mode).
 */
export function normaliseQuarantineHours(
  raw: unknown,
  warn?: (message: string) => void,
): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_TOOL_QUARANTINE_HOURS;
  }
  const text = String(raw).trim();
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    warn?.(
      `Ignoring tool quarantine window "${text}" — it must be a positive ` +
        `whole number of hours. Falling back to ` +
        `${DEFAULT_TOOL_QUARANTINE_HOURS}h so the toolchain release embargo ` +
        `is not silently disabled.`,
    );
    return DEFAULT_TOOL_QUARANTINE_HOURS;
  }
  return parsed;
}

/**
 * Pure age evaluator: decide whether a resolved candidate clears the window.
 *
 * An unknown version, a missing publish time, or an unparseable timestamp are
 * all indeterminate — and indeterminate is **not** eligible.
 */
export function evaluateReleaseAge(
  source: string,
  candidate: ReleaseCandidate,
  quarantineHours: number,
  now: Date,
): ReleaseAgeVerdict {
  const floor = normaliseQuarantineHours(quarantineHours);
  const indeterminate = (reason: string): ReleaseAgeVerdict => ({
    source,
    version: candidate.version,
    ref: candidate.ref ?? null,
    eligible: false,
    indeterminate: true,
    ageHours: null,
    publishedAt: candidate.publishedAt,
    reason,
  });

  if (!candidate.version || !candidate.publishedAt) {
    return indeterminate(
      `Could not resolve the newest release of ${source}; the ${floor}h ` +
        `release quarantine cannot be verified, so the upgrade is skipped.`,
    );
  }

  const publishedMs = Date.parse(candidate.publishedAt);
  if (Number.isNaN(publishedMs)) {
    return indeterminate(
      `Unparseable publish timestamp "${candidate.publishedAt}" for ` +
        `${source}@${candidate.version}; the ${floor}h release quarantine ` +
        `cannot be verified, so the upgrade is skipped.`,
    );
  }

  const ageHours = (now.getTime() - publishedMs) / 3_600_000;
  const eligible = ageHours >= floor;
  const ageText = `${ageHours.toFixed(1)}h old`;
  return {
    source,
    version: candidate.version,
    ref: candidate.ref ?? null,
    eligible,
    indeterminate: false,
    ageHours,
    publishedAt: candidate.publishedAt,
    reason: eligible
      ? `${source}@${candidate.version} is ${ageText} (>= ${floor}h quarantine).`
      : `${source}@${candidate.version} is only ${ageText} (< ${floor}h ` +
        `quarantine); deferring the upgrade until it ages past the window.`,
  };
}

/**
 * Parse `gh extension list` output into installed extensions.
 *
 * The column layout has varied across `gh` releases, so the repository is
 * located by shape (`owner/repo`) rather than by column index. Lines with no
 * such token (headers, notices) are ignored. The upgrade name is the repo's
 * name with any `gh-` prefix stripped, matching `gh`'s own convention.
 */
export function parseGhExtensionList(output: string): GhExtension[] {
  const extensions: GhExtension[] = [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const repo = line
      .trim()
      .split(/\s+/)
      .find((token) => REPO_PATTERN.test(token));
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    const name = repo.slice(repo.indexOf("/") + 1).replace(/^gh-/, "");
    if (name) extensions.push({ name, repo });
  }
  return extensions;
}

/**
 * Parse the `<tag> <published_at>` line emitted by the `gh api --jq` lookup.
 *
 * `gh` may also write diagnostics to stderr, so the first line matching the
 * expected shape wins rather than assuming the output is exactly one line.
 */
export function parseGhReleaseLine(output: string): ReleaseCandidate {
  for (const line of output.split("\n")) {
    const match = line.trim().match(
      /^(\S+)\s+(\d{4}-\d{2}-\d{2}T[\d:]+(?:\.\d+)?Z)$/,
    );
    if (match) {
      return {
        version: match[1]!.replace(/^v/, ""),
        publishedAt: match[2]!,
      };
    }
  }
  return { version: null, publishedAt: null };
}

/** Latest release of a `gh` extension repository, as far as it could be read. */
export interface GhExtensionRelease {
  /** Release tag verbatim (a `v` prefix is kept), or null when there is none. */
  tag: string | null;
  /** ISO publish timestamp of that release, or null when unknown. */
  publishedAt: string | null;
  /** Names of the release's uploaded assets. */
  assets: string[];
}

/** ISO-8601 instant as GitHub emits it. */
const ISO_INSTANT = String.raw`\d{4}-\d{2}-\d{2}T[\d:]+(?:\.\d+)?Z`;

/**
 * Parse the `<tag> <published_at>` lines of a whole release listing, newest
 * publish first (Issue #726).
 *
 * The single-release parser above answers "what is newest"; this one keeps the
 * releases behind it, so a caller can fall back to the newest release that has
 * cleared the quarantine window. Only stable `MAJOR.MINOR.PATCH` tags are
 * kept — the same series the pinned installer can install — and lines that do
 * not match the shape (diagnostics on stderr) are ignored.
 */
export function parseGhReleaseListing(output: string): ReleaseCandidate[] {
  const releaseLine = new RegExp(`^(\\S+)\\s+(${ISO_INSTANT})$`);
  const seen = new Set<string>();
  const dated: { candidate: ReleaseCandidate; publishedMs: number }[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(releaseLine);
    if (!match) continue;
    const tag = match[1]!;
    const version = tag.replace(/^v/, "");
    if (!STABLE_SEMVER_PATTERN.test(version) || seen.has(version)) continue;
    const publishedMs = Date.parse(match[2]!);
    if (Number.isNaN(publishedMs)) continue;
    seen.add(version);
    dated.push({
      candidate: { version, publishedAt: match[2]!, ref: tag },
      publishedMs,
    });
  }
  return dated
    .sort((a, b) => b.publishedMs - a.publishedMs)
    .map((entry) => entry.candidate);
}

/**
 * Pick the newest release in a history that has cleared the quarantine window
 * (Issue #726).
 *
 * The history is evaluated newest first with the same {@link evaluateReleaseAge}
 * every upgrade uses, so the window is applied identically — this only chooses
 * *which* release the verdict describes. Nothing here widens the embargo: an
 * empty history is indeterminate, and a history in which every release is still
 * inside the window returns the newest release's own ineligible verdict, so the
 * caller fails exactly as loudly as before.
 */
export function selectNewestAged(
  source: string,
  history: readonly ReleaseCandidate[],
  quarantineHours: number,
  now: Date,
): ReleaseAgeVerdict {
  const floor = normaliseQuarantineHours(quarantineHours);
  const unknown: ReleaseCandidate = { version: null, publishedAt: null };
  if (history.length === 0) {
    return evaluateReleaseAge(source, unknown, floor, now);
  }

  const verdicts = history.map((candidate) =>
    evaluateReleaseAge(source, candidate, floor, now)
  );
  const newest = verdicts[0]!;
  const cleared = verdicts.find((verdict) => verdict.eligible);
  if (!cleared) return newest;
  if (cleared === newest) return cleared;
  return {
    ...cleared,
    reason: `${cleared.reason} It is the newest release past the window — ` +
      `${newest.version} is still inside it.`,
  };
}

/**
 * True when an asset name marks the release as a **binary** `gh` extension
 * (Issue #3952) — see {@link BINARY_ASSET_SUFFIX}.
 */
export function isBinaryExtensionAsset(name: string): boolean {
  return BINARY_ASSET_SUFFIX.test(name.trim());
}

/**
 * Parse the prefixed lines emitted by the extension release lookup
 * (Issue #3952).
 *
 * The `--jq` filter emits one `release <tag> <published_at>` line followed by
 * an `asset <name>` line per uploaded asset. Prefixes keep the projection
 * unambiguous when `gh` interleaves diagnostics on stderr; a repository with
 * no release at all exits non-zero and never reaches this parser.
 */
export function parseGhExtensionRelease(output: string): GhExtensionRelease {
  const release: GhExtensionRelease = {
    tag: null,
    publishedAt: null,
    assets: [],
  };
  const releaseLine = new RegExp(`^release\\s+(\\S+)\\s+(${ISO_INSTANT})$`);
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(releaseLine);
    if (match && !release.tag) {
      release.tag = match[1]!;
      release.publishedAt = match[2]!;
      continue;
    }
    if (trimmed.startsWith("asset ")) {
      const name = trimmed.slice("asset ".length).trim();
      if (name) release.assets.push(name);
    }
  }
  return release;
}

/**
 * Parse the `<sha> <commit date>` line emitted by the commits lookup
 * (Issue #3952).
 *
 * Only a full 40-character sha is accepted, so a stray diagnostic line cannot
 * be mistaken for a ref that would then be installed.
 */
export function parseGhCommitLine(
  output: string,
): { sha: string | null; committedAt: string | null } {
  const commitLine = new RegExp(`^(\\S+)\\s+(${ISO_INSTANT})$`);
  for (const line of output.split("\n")) {
    const match = line.trim().match(commitLine);
    if (match && SHA_PATTERN.test(match[1]!)) {
      return { sha: match[1]!, committedAt: match[2]! };
    }
  }
  return { sha: null, committedAt: null };
}

/**
 * Parse the default branch name emitted by the repository lookup
 * (Issue #3952).
 *
 * The name is interpolated into an API path, so only a branch-shaped token is
 * accepted — a traversal-shaped value yields null and the lookup is abandoned.
 */
export function parseGhDefaultBranch(output: string): string | null {
  for (const line of output.split("\n")) {
    const branch = line.trim();
    if (!branch || branch.includes("..")) continue;
    if (BRANCH_PATTERN.test(branch)) return branch;
  }
  return null;
}

/**
 * Extract the newest published version from npm registry metadata.
 *
 * Reads `dist-tags.latest` and its entry in the `time` map, which is what
 * `claude update` would install.
 */
export function parseNpmLatest(body: unknown): ReleaseCandidate {
  if (!body || typeof body !== "object") {
    return { version: null, publishedAt: null };
  }
  const record = body as {
    "dist-tags"?: Record<string, unknown>;
    time?: Record<string, unknown>;
  };
  const latest = record["dist-tags"]?.["latest"];
  if (typeof latest !== "string" || !latest) {
    return { version: null, publishedAt: null };
  }
  const published = record.time?.[latest];
  return {
    version: latest,
    publishedAt: typeof published === "string" ? published : null,
  };
}

/**
 * Every installable stable release the npm packument names, newest publish
 * first (Issue #726).
 *
 * `dist-tags.latest` alone answers what an upgrade would adopt, but a caller
 * that must name an *installable* version needs the releases behind it too, so
 * the whole `time` map is read. A version is a candidate only when it is
 * still published (present in `versions`), carries a plain `MAJOR.MINOR.PATCH`
 * with no pre-release suffix, and was published no later than `latest` — a
 * pre-release, an unpublished version, or one carrying a different dist-tag is
 * not something `latest` ever offered, so it is never a fallback.
 */
export function parseNpmVersionHistory(body: unknown): ReleaseCandidate[] {
  if (!body || typeof body !== "object") return [];
  const record = body as {
    "dist-tags"?: Record<string, unknown>;
    time?: Record<string, unknown>;
    versions?: Record<string, unknown>;
  };
  const latest = record["dist-tags"]?.["latest"];
  const time = record.time;
  if (typeof latest !== "string" || !latest || !time) return [];

  const latestPublished = Date.parse(String(time[latest] ?? ""));
  if (Number.isNaN(latestPublished)) return [];

  const dated: { candidate: ReleaseCandidate; publishedMs: number }[] = [];
  for (const [version, publishedAt] of Object.entries(time)) {
    if (typeof publishedAt !== "string") continue;
    if (!STABLE_SEMVER_PATTERN.test(version)) continue;
    // `time` keeps entries for unpublished versions; `versions` does not.
    if (record.versions && !(version in record.versions)) continue;
    const publishedMs = Date.parse(publishedAt);
    if (Number.isNaN(publishedMs) || publishedMs > latestPublished) continue;
    dated.push({ candidate: { version, publishedAt }, publishedMs });
  }
  return dated
    .sort((a, b) => b.publishedMs - a.publishedMs)
    .map((entry) => entry.candidate);
}

/** Build the npm registry metadata URL for a package name. */
export function npmRegistryUrl(pkg: string, base = NPM_REGISTRY_BASE): string {
  return `${base}/${pkg.replaceAll("/", "%2F")}`;
}

/**
 * Default npm metadata fetcher. Never throws — a network, permission, or
 * parse failure yields `undefined`, which the gate treats as indeterminate.
 */
export async function fetchNpmMetadata(pkg: string): Promise<unknown> {
  try {
    // Issue #3710: bounded in time and in memory so a hung or hostile
    // registry cannot wedge the worker.
    const resp = await fetch(
      npmRegistryUrl(pkg),
      withRequestTimeout({ method: "GET" }, DEFAULT_FETCH_TIMEOUT_MS),
    );
    if (!resp.ok) {
      await discardBody(resp);
      return undefined;
    }
    const bodyResult = await readTextBounded(resp, MAX_NPM_RESPONSE_BYTES);
    if (!bodyResult.ok) return undefined;
    return JSON.parse(bodyResult.value);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the newest GitHub release for `owner/repo` via `gh api`.
 *
 * The repository name is validated against {@link REPO_PATTERN} before it is
 * interpolated into the API path, so a malformed value cannot reach an
 * unintended endpoint. Any failure resolves to an unknown candidate.
 */
async function resolveGitHubLatestRelease(
  repo: string,
  runFn: ReleaseAgeGateDeps["runFn"],
): Promise<ReleaseCandidate> {
  if (!REPO_PATTERN.test(repo)) return { version: null, publishedAt: null };
  const result = await runFn([
    "gh",
    "api",
    `repos/${repo}/releases/latest`,
    "--jq",
    '.tag_name + " " + .published_at',
  ], RELEASE_LOOKUP_TIMEOUT_SECONDS);
  if (!result.ok || result.value.exitCode !== 0) {
    return { version: null, publishedAt: null };
  }
  return parseGhReleaseLine(result.value.output);
}

/**
 * Resolve the published release history of `owner/repo` via `gh api`
 * (Issue #726).
 *
 * Same validation as the single-release lookup — a malformed repository never
 * reaches the API — and the same fail-closed contract: any failure yields an
 * empty history, which is indeterminate rather than eligible. Drafts and
 * pre-releases are filtered out by the projection, so the history holds only
 * the releases the series actually publishes.
 */
async function resolveGitHubReleaseHistory(
  repo: string,
  runFn: ReleaseAgeGateDeps["runFn"],
): Promise<ReleaseCandidate[]> {
  if (!REPO_PATTERN.test(repo)) return [];
  const result = await runFn([
    "gh",
    "api",
    `repos/${repo}/releases`,
    "--jq",
    ".[] | select(.draft | not) | select(.prerelease | not) | " +
    '.tag_name + " " + .published_at',
  ], RELEASE_LOOKUP_TIMEOUT_SECONDS);
  if (!result.ok || result.value.exitCode !== 0) return [];
  return parseGhReleaseListing(result.value.output);
}

/**
 * Resolve the ref a `gh` extension upgrade would actually install
 * (Issue #3952).
 *
 * `gh` installs a **binary** extension from its latest release, but a
 * **script** extension by cloning the default branch — so dating every
 * extension by its latest release let a repository with a stale tag and an
 * active `main` clear the quarantine while installing a ten-minute-old commit.
 * The candidate returned here is whichever `gh` would install: the release tag
 * and its publish time when the latest release carries platform binaries,
 * otherwise the default branch's HEAD sha and its commit date. Every failure
 * path yields an unknown candidate, which blocks the upgrade.
 *
 * Caveat stated plainly: a commit date is supplied by whoever pushed it, while
 * a release `published_at` is stamped by GitHub. Dating a script extension by
 * its HEAD is therefore weaker than dating a release — but it is the date of
 * the artefact actually installed, which the release date was not.
 */
async function resolveGhExtensionRef(
  repo: string,
  runFn: ReleaseAgeGateDeps["runFn"],
): Promise<ReleaseCandidate> {
  const unknown: ReleaseCandidate = {
    version: null,
    publishedAt: null,
    ref: null,
  };
  if (!REPO_PATTERN.test(repo)) return unknown;

  const released = await runFn([
    "gh",
    "api",
    `repos/${repo}/releases/latest`,
    "--jq",
    '"release " + .tag_name + " " + .published_at, ' +
    '(.assets[].name | "asset " + .)',
  ], RELEASE_LOOKUP_TIMEOUT_SECONDS);
  if (released.ok && released.value.exitCode === 0) {
    const release = parseGhExtensionRelease(released.value.output);
    if (
      release.tag && release.publishedAt &&
      release.assets.some(isBinaryExtensionAsset)
    ) {
      return {
        version: release.tag.replace(/^v/, ""),
        publishedAt: release.publishedAt,
        ref: release.tag,
      };
    }
  }

  // No platform binaries: `gh` clones the default branch, so date its HEAD.
  const repoMeta = await runFn([
    "gh",
    "api",
    `repos/${repo}`,
    "--jq",
    ".default_branch",
  ], RELEASE_LOOKUP_TIMEOUT_SECONDS);
  if (!repoMeta.ok || repoMeta.value.exitCode !== 0) return unknown;
  const branch = parseGhDefaultBranch(repoMeta.value.output);
  if (!branch) return unknown;

  const head = await runFn([
    "gh",
    "api",
    `repos/${repo}/commits/${branch}`,
    "--jq",
    '.sha + " " + .commit.committer.date',
  ], RELEASE_LOOKUP_TIMEOUT_SECONDS);
  if (!head.ok || head.value.exitCode !== 0) return unknown;
  const { sha, committedAt } = parseGhCommitLine(head.value.output);
  if (!sha || !committedAt) return unknown;
  return { version: sha.slice(0, 12), publishedAt: committedAt, ref: sha };
}

/**
 * Build the release-age gate used before every toolchain upgrade.
 *
 * GitHub releases are resolved through `gh api` (authenticated, and the
 * repository's preferred GitHub client); npm releases through the public
 * registry. Every failure path funnels into an indeterminate verdict, which
 * blocks the upgrade rather than silently permitting it.
 */
export function createReleaseAgeGate(
  deps: ReleaseAgeGateDeps,
): ReleaseAgeGate {
  const quarantineHours = normaliseQuarantineHours(
    deps.quarantineHours,
    deps.warn,
  );
  const now = deps.now ?? (() => new Date());
  const fetchMetadata = deps.fetchNpmMetadata ?? fetchNpmMetadata;

  const check = async (channel: ReleaseChannel): Promise<ReleaseAgeVerdict> => {
    const source = describeChannel(channel);
    let candidate: ReleaseCandidate = { version: null, publishedAt: null };
    try {
      if (channel.kind === "npm") {
        candidate = NPM_PACKAGE_PATTERN.test(channel.pkg)
          ? parseNpmLatest(await fetchMetadata(channel.pkg))
          : candidate;
      } else if (channel.kind === "gh-extension") {
        candidate = await resolveGhExtensionRef(channel.repo, deps.runFn);
      } else {
        candidate = await resolveGitHubLatestRelease(channel.repo, deps.runFn);
      }
    } catch {
      // Any unexpected failure stays indeterminate — never eligible.
      candidate = { version: null, publishedAt: null };
    }
    return evaluateReleaseAge(source, candidate, quarantineHours, now());
  };

  const checkNewestAged = async (
    channel: ReleaseChannel,
  ): Promise<ReleaseAgeVerdict> => {
    // A `gh` extension is installed from exactly one ref — the latest release
    // or branch HEAD — so there is no older release to fall back to: the
    // single-candidate verdict is already the whole answer.
    if (channel.kind === "gh-extension") return await check(channel);

    let history: ReleaseCandidate[] = [];
    try {
      history = channel.kind === "npm"
        ? (NPM_PACKAGE_PATTERN.test(channel.pkg)
          ? parseNpmVersionHistory(await fetchMetadata(channel.pkg))
          : [])
        : await resolveGitHubReleaseHistory(channel.repo, deps.runFn);
    } catch {
      // Same fail-closed contract as `check`: unreadable is not eligible.
      history = [];
    }
    return selectNewestAged(
      describeChannel(channel),
      history,
      quarantineHours,
      now(),
    );
  };

  return { quarantineHours, check, checkNewestAged };
}
