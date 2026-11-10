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
 */ import { DEFAULT_FETCH_TIMEOUT_MS, discardBody, readTextBounded, withRequestTimeout } from "./bounded_fetch.ts";
import { MAX_NPM_RESPONSE_BYTES } from "./npm_package_age.ts";
/** Default quarantine window in hours (mirrors `VIBE_BUMP_QUARANTINE_HOURS`). */ export const DEFAULT_TOOL_QUARANTINE_HOURS = 24;
/** npm package the Claude CLI is distributed through. */ export const CLAUDE_CLI_NPM_PACKAGE = "@anthropic-ai/claude-code";
/** GitHub repository publishing `gh` releases. */ export const GH_CLI_RELEASE_REPO = "cli/cli";
/** GitHub repository publishing Deno releases. */ export const DENO_RELEASE_REPO = "denoland/deno";
/** Base URL of the public npm registry. */ export const NPM_REGISTRY_BASE = "https://registry.npmjs.org";
/** Timeout (seconds) for a single release-metadata lookup. */ export const RELEASE_LOOKUP_TIMEOUT_SECONDS = 30;
/** `owner/repo` shape accepted in a GitHub API path (no traversal, no shell). */ const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** npm package name shape accepted in a registry URL. */ const NPM_PACKAGE_PATTERN = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
/** Branch name shape accepted in a GitHub API path (no traversal, no shell). */ const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** Commit sha shape emitted by the commits API. */ const SHA_PATTERN = /^[0-9a-f]{40}$/;
/**
 * A plain stable release version: `MAJOR.MINOR.PATCH`, no pre-release suffix
 * and no build metadata. Only these are considered when falling back to the
 * newest release past the quarantine window (Issue #726).
 */ const STABLE_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
/**
 * `GOOS-GOARCH` asset suffix that marks a **binary** `gh` extension.
 *
 * Mirrors `gh`'s own rule (`isBinExtension` in `cli/cli`): an extension is
 * installed from its latest release only when that release carries an asset
 * whose name *ends* in `<goos>-<goarch>` — with `.exe` appended on Windows.
 * Anything else — including a repository that merely tags releases — is a
 * *script* extension, which `gh` installs by cloning the default branch.
 */ const BINARY_ASSET_SUFFIX = /(?:(?:aix|android|darwin|dragonfly|freebsd|illumos|ios|js|linux|netbsd|openbsd|plan9|solaris)-(?:386|amd64|arm|arm64|loong64|mips|mips64|mips64le|mipsle|ppc64|ppc64le|riscv64|s390x|wasm)|windows-(?:386|amd64|arm|arm64)\.exe)$/;
/** Human-readable label for a channel, used in log lines. */ export function describeChannel(channel) {
  if (channel.kind === "npm") return `npm:${channel.pkg}`;
  if (channel.kind === "gh-extension") return `gh-extension:${channel.repo}`;
  return `github:${channel.repo}`;
}
/**
 * Normalise a configured quarantine window to a usable number of hours.
 *
 * Only a positive whole number of hours is accepted. Anything else — zero, a
 * negative, a fraction, or unparseable text — falls back to the documented
 * default and is reported, so the embargo can never be silently switched off
 * (the Issue #3649 / #3659 failure mode).
 */ export function normaliseQuarantineHours(raw, warn) {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_TOOL_QUARANTINE_HOURS;
  }
  const text = String(raw).trim();
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    warn?.(`Ignoring tool quarantine window "${text}" — it must be a positive ` + `whole number of hours. Falling back to ` + `${DEFAULT_TOOL_QUARANTINE_HOURS}h so the toolchain release embargo ` + `is not silently disabled.`);
    return DEFAULT_TOOL_QUARANTINE_HOURS;
  }
  return parsed;
}
/**
 * Pure age evaluator: decide whether a resolved candidate clears the window.
 *
 * An unknown version, a missing publish time, or an unparseable timestamp are
 * all indeterminate — and indeterminate is **not** eligible.
 */ export function evaluateReleaseAge(source, candidate, quarantineHours, now) {
  const floor = normaliseQuarantineHours(quarantineHours);
  const indeterminate = (reason)=>({
      source,
      version: candidate.version,
      ref: candidate.ref ?? null,
      eligible: false,
      indeterminate: true,
      ageHours: null,
      publishedAt: candidate.publishedAt,
      reason
    });
  if (!candidate.version || !candidate.publishedAt) {
    return indeterminate(`Could not resolve the newest release of ${source}; the ${floor}h ` + `release quarantine cannot be verified, so the upgrade is skipped.`);
  }
  const publishedMs = Date.parse(candidate.publishedAt);
  if (Number.isNaN(publishedMs)) {
    return indeterminate(`Unparseable publish timestamp "${candidate.publishedAt}" for ` + `${source}@${candidate.version}; the ${floor}h release quarantine ` + `cannot be verified, so the upgrade is skipped.`);
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
    reason: eligible ? `${source}@${candidate.version} is ${ageText} (>= ${floor}h quarantine).` : `${source}@${candidate.version} is only ${ageText} (< ${floor}h ` + `quarantine); deferring the upgrade until it ages past the window.`
  };
}
/**
 * Parse `gh extension list` output into installed extensions.
 *
 * The column layout has varied across `gh` releases, so the repository is
 * located by shape (`owner/repo`) rather than by column index. Lines with no
 * such token (headers, notices) are ignored. The upgrade name is the repo's
 * name with any `gh-` prefix stripped, matching `gh`'s own convention.
 */ export function parseGhExtensionList(output) {
  const extensions = [];
  const seen = new Set();
  for (const line of output.split("\n")){
    const repo = line.trim().split(/\s+/).find((token)=>REPO_PATTERN.test(token));
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    const name = repo.slice(repo.indexOf("/") + 1).replace(/^gh-/, "");
    if (name) extensions.push({
      name,
      repo
    });
  }
  return extensions;
}
/**
 * Parse the `<tag> <published_at>` line emitted by the `gh api --jq` lookup.
 *
 * `gh` may also write diagnostics to stderr, so the first line matching the
 * expected shape wins rather than assuming the output is exactly one line.
 */ export function parseGhReleaseLine(output) {
  for (const line of output.split("\n")){
    const match = line.trim().match(/^(\S+)\s+(\d{4}-\d{2}-\d{2}T[\d:]+(?:\.\d+)?Z)$/);
    if (match) {
      return {
        version: match[1].replace(/^v/, ""),
        publishedAt: match[2]
      };
    }
  }
  return {
    version: null,
    publishedAt: null
  };
}
/** ISO-8601 instant as GitHub emits it. */ const ISO_INSTANT = String.raw`\d{4}-\d{2}-\d{2}T[\d:]+(?:\.\d+)?Z`;
/**
 * Parse the `<tag> <published_at>` lines of a whole release listing, newest
 * publish first (Issue #726).
 *
 * The single-release parser above answers "what is newest"; this one keeps the
 * releases behind it, so a caller can fall back to the newest release that has
 * cleared the quarantine window. Only stable `MAJOR.MINOR.PATCH` tags are
 * kept — the same series the pinned installer can install — and lines that do
 * not match the shape (diagnostics on stderr) are ignored.
 */ export function parseGhReleaseListing(output) {
  const releaseLine = new RegExp(`^(\\S+)\\s+(${ISO_INSTANT})$`);
  const seen = new Set();
  const dated = [];
  for (const line of output.split("\n")){
    const match = line.trim().match(releaseLine);
    if (!match) continue;
    const tag = match[1];
    const version = tag.replace(/^v/, "");
    if (!STABLE_SEMVER_PATTERN.test(version) || seen.has(version)) continue;
    const publishedMs = Date.parse(match[2]);
    if (Number.isNaN(publishedMs)) continue;
    seen.add(version);
    dated.push({
      candidate: {
        version,
        publishedAt: match[2],
        ref: tag
      },
      publishedMs
    });
  }
  return dated.sort((a, b)=>b.publishedMs - a.publishedMs).map((entry)=>entry.candidate);
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
 */ export function selectNewestAged(source, history, quarantineHours, now) {
  const floor = normaliseQuarantineHours(quarantineHours);
  const unknown = {
    version: null,
    publishedAt: null
  };
  if (history.length === 0) {
    return evaluateReleaseAge(source, unknown, floor, now);
  }
  const verdicts = history.map((candidate)=>evaluateReleaseAge(source, candidate, floor, now));
  const newest = verdicts[0];
  const cleared = verdicts.find((verdict)=>verdict.eligible);
  if (!cleared) return newest;
  if (cleared === newest) return cleared;
  return {
    ...cleared,
    reason: `${cleared.reason} It is the newest release past the window — ` + `${newest.version} is still inside it.`
  };
}
/**
 * True when an asset name marks the release as a **binary** `gh` extension
 * (Issue #3952) — see {@link BINARY_ASSET_SUFFIX}.
 */ export function isBinaryExtensionAsset(name) {
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
 */ export function parseGhExtensionRelease(output) {
  const release = {
    tag: null,
    publishedAt: null,
    assets: []
  };
  const releaseLine = new RegExp(`^release\\s+(\\S+)\\s+(${ISO_INSTANT})$`);
  for (const line of output.split("\n")){
    const trimmed = line.trim();
    const match = trimmed.match(releaseLine);
    if (match && !release.tag) {
      release.tag = match[1];
      release.publishedAt = match[2];
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
 */ export function parseGhCommitLine(output) {
  const commitLine = new RegExp(`^(\\S+)\\s+(${ISO_INSTANT})$`);
  for (const line of output.split("\n")){
    const match = line.trim().match(commitLine);
    if (match && SHA_PATTERN.test(match[1])) {
      return {
        sha: match[1],
        committedAt: match[2]
      };
    }
  }
  return {
    sha: null,
    committedAt: null
  };
}
/**
 * Parse the default branch name emitted by the repository lookup
 * (Issue #3952).
 *
 * The name is interpolated into an API path, so only a branch-shaped token is
 * accepted — a traversal-shaped value yields null and the lookup is abandoned.
 */ export function parseGhDefaultBranch(output) {
  for (const line of output.split("\n")){
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
 */ export function parseNpmLatest(body) {
  if (!body || typeof body !== "object") {
    return {
      version: null,
      publishedAt: null
    };
  }
  const record = body;
  const latest = record["dist-tags"]?.["latest"];
  if (typeof latest !== "string" || !latest) {
    return {
      version: null,
      publishedAt: null
    };
  }
  const published = record.time?.[latest];
  return {
    version: latest,
    publishedAt: typeof published === "string" ? published : null
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
 */ export function parseNpmVersionHistory(body) {
  if (!body || typeof body !== "object") return [];
  const record = body;
  const latest = record["dist-tags"]?.["latest"];
  const time = record.time;
  if (typeof latest !== "string" || !latest || !time) return [];
  const latestPublished = Date.parse(String(time[latest] ?? ""));
  if (Number.isNaN(latestPublished)) return [];
  const dated = [];
  for (const [version, publishedAt] of Object.entries(time)){
    if (typeof publishedAt !== "string") continue;
    if (!STABLE_SEMVER_PATTERN.test(version)) continue;
    // `time` keeps entries for unpublished versions; `versions` does not.
    if (record.versions && !(version in record.versions)) continue;
    const publishedMs = Date.parse(publishedAt);
    if (Number.isNaN(publishedMs) || publishedMs > latestPublished) continue;
    dated.push({
      candidate: {
        version,
        publishedAt
      },
      publishedMs
    });
  }
  return dated.sort((a, b)=>b.publishedMs - a.publishedMs).map((entry)=>entry.candidate);
}
/** Build the npm registry metadata URL for a package name. */ export function npmRegistryUrl(pkg, base = NPM_REGISTRY_BASE) {
  return `${base}/${pkg.replaceAll("/", "%2F")}`;
}
/**
 * Default npm metadata fetcher. Never throws — a network, permission, or
 * parse failure yields `undefined`, which the gate treats as indeterminate.
 */ export async function fetchNpmMetadata(pkg) {
  try {
    // Issue #3710: bounded in time and in memory so a hung or hostile
    // registry cannot wedge the worker.
    const resp = await fetch(npmRegistryUrl(pkg), withRequestTimeout({
      method: "GET"
    }, DEFAULT_FETCH_TIMEOUT_MS));
    if (!resp.ok) {
      await discardBody(resp);
      return undefined;
    }
    const bodyResult = await readTextBounded(resp, MAX_NPM_RESPONSE_BYTES);
    if (!bodyResult.ok) return undefined;
    return JSON.parse(bodyResult.value);
  } catch  {
    return undefined;
  }
}
/**
 * Resolve the newest GitHub release for `owner/repo` via `gh api`.
 *
 * The repository name is validated against {@link REPO_PATTERN} before it is
 * interpolated into the API path, so a malformed value cannot reach an
 * unintended endpoint. Any failure resolves to an unknown candidate.
 */ async function resolveGitHubLatestRelease(repo, runFn) {
  if (!REPO_PATTERN.test(repo)) return {
    version: null,
    publishedAt: null
  };
  const result = await runFn([
    "gh",
    "api",
    `repos/${repo}/releases/latest`,
    "--jq",
    '.tag_name + " " + .published_at'
  ], RELEASE_LOOKUP_TIMEOUT_SECONDS);
  if (!result.ok || result.value.exitCode !== 0) {
    return {
      version: null,
      publishedAt: null
    };
  }
  return parseGhReleaseLine(result.value.output);
}
/**
 * Resolve the published release history of `owner/repo` via `gh api`
 * (Issue #726).
 *
 * Same validation as the single-release lookup — a malformed repository never
 * reaches the API. Drafts and pre-releases are filtered out by the projection,
 * so the history holds only the releases the series actually publishes.
 *
 * A lookup failure is returned as an error rather than an empty history
 * (Issue #1823): the quarantine gate treats both as indeterminate, but the
 * action-pin resolver has to say *why* it fell back to the catalogue, and
 * "upstream publishes no stable release" is a different fault from "the
 * lookup did not run". An empty `ok` history means upstream genuinely
 * published nothing this parser recognises.
 */ export async function resolveGitHubReleaseHistory(repo, runFn) {
  if (!REPO_PATTERN.test(repo)) {
    return {
      ok: false,
      error: new Error(`"${repo}" is not an owner/repo coordinate`)
    };
  }
  const result = await runFn([
    "gh",
    "api",
    `repos/${repo}/releases`,
    "--jq",
    ".[] | select(.draft | not) | select(.prerelease | not) | " + '.tag_name + " " + .published_at'
  ], RELEASE_LOOKUP_TIMEOUT_SECONDS);
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return {
      ok: false,
      error: new Error(`gh api repos/${repo}/releases exited ${result.value.exitCode}`)
    };
  }
  return {
    ok: true,
    value: parseGhReleaseListing(result.value.output)
  };
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
 */ async function resolveGhExtensionRef(repo, runFn) {
  const unknown = {
    version: null,
    publishedAt: null,
    ref: null
  };
  if (!REPO_PATTERN.test(repo)) return unknown;
  const released = await runFn([
    "gh",
    "api",
    `repos/${repo}/releases/latest`,
    "--jq",
    '"release " + .tag_name + " " + .published_at, ' + '(.assets[].name | "asset " + .)'
  ], RELEASE_LOOKUP_TIMEOUT_SECONDS);
  if (released.ok && released.value.exitCode === 0) {
    const release = parseGhExtensionRelease(released.value.output);
    if (release.tag && release.publishedAt && release.assets.some(isBinaryExtensionAsset)) {
      return {
        version: release.tag.replace(/^v/, ""),
        publishedAt: release.publishedAt,
        ref: release.tag
      };
    }
  }
  // No platform binaries: `gh` clones the default branch, so date its HEAD.
  const repoMeta = await runFn([
    "gh",
    "api",
    `repos/${repo}`,
    "--jq",
    ".default_branch"
  ], RELEASE_LOOKUP_TIMEOUT_SECONDS);
  if (!repoMeta.ok || repoMeta.value.exitCode !== 0) return unknown;
  const branch = parseGhDefaultBranch(repoMeta.value.output);
  if (!branch) return unknown;
  const head = await runFn([
    "gh",
    "api",
    `repos/${repo}/commits/${branch}`,
    "--jq",
    '.sha + " " + .commit.committer.date'
  ], RELEASE_LOOKUP_TIMEOUT_SECONDS);
  if (!head.ok || head.value.exitCode !== 0) return unknown;
  const { sha, committedAt } = parseGhCommitLine(head.value.output);
  if (!sha || !committedAt) return unknown;
  return {
    version: sha.slice(0, 12),
    publishedAt: committedAt,
    ref: sha
  };
}
/**
 * Build the release-age gate used before every toolchain upgrade.
 *
 * GitHub releases are resolved through `gh api` (authenticated, and the
 * repository's preferred GitHub client); npm releases through the public
 * registry. Every failure path funnels into an indeterminate verdict, which
 * blocks the upgrade rather than silently permitting it.
 */ export function createReleaseAgeGate(deps) {
  const quarantineHours = normaliseQuarantineHours(deps.quarantineHours, deps.warn);
  const now = deps.now ?? (()=>new Date());
  const fetchMetadata = deps.fetchNpmMetadata ?? fetchNpmMetadata;
  const check = async (channel)=>{
    const source = describeChannel(channel);
    let candidate = {
      version: null,
      publishedAt: null
    };
    try {
      if (channel.kind === "npm") {
        candidate = NPM_PACKAGE_PATTERN.test(channel.pkg) ? parseNpmLatest(await fetchMetadata(channel.pkg)) : candidate;
      } else if (channel.kind === "gh-extension") {
        candidate = await resolveGhExtensionRef(channel.repo, deps.runFn);
      } else {
        candidate = await resolveGitHubLatestRelease(channel.repo, deps.runFn);
      }
    } catch  {
      // Any unexpected failure stays indeterminate — never eligible.
      candidate = {
        version: null,
        publishedAt: null
      };
    }
    return evaluateReleaseAge(source, candidate, quarantineHours, now());
  };
  const checkNewestAged = async (channel)=>{
    // A `gh` extension is installed from exactly one ref — the latest release
    // or branch HEAD — so there is no older release to fall back to: the
    // single-candidate verdict is already the whole answer.
    if (channel.kind === "gh-extension") return await check(channel);
    let history = [];
    try {
      if (channel.kind === "npm") {
        history = NPM_PACKAGE_PATTERN.test(channel.pkg) ? parseNpmVersionHistory(await fetchMetadata(channel.pkg)) : [];
      } else {
        const listing = await resolveGitHubReleaseHistory(channel.repo, deps.runFn);
        // Fail-closed: an unreadable history is indeterminate, never eligible.
        history = listing.ok ? listing.value : [];
      }
    } catch  {
      // Same fail-closed contract as `check`: unreadable is not eligible.
      history = [];
    }
    return selectNewestAged(describeChannel(channel), history, quarantineHours, now());
  };
  return {
    quarantineHours,
    check,
    checkNewestAged
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi90b29sX3JlbGVhc2VfYWdlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUmVsZWFzZS1hZ2UgcXVhcmFudGluZSBmb3IgaG9zdCB0b29sY2hhaW4gdXBncmFkZXMgKElzc3VlICMzNjU1KS5cbiAqXG4gKiBUaGUgYm9vdHN0cmFwIHByZWx1ZGUgdXBncmFkZXMgZm91ciBleHRlcm5hbGx5LWRpc3RyaWJ1dGVkIGV4ZWN1dGFibGVzIOKAlFxuICogdGhlIENsYXVkZSBDTEksIHRoZSBgZ2hgIGJpbmFyeSwgZXZlcnkgaW5zdGFsbGVkIGBnaGAgZXh0ZW5zaW9uLCBhbmQgRGVuby5cbiAqIEV2ZXJ5IG90aGVyIGV4dGVybmFsIGVjb3N5c3RlbSBpbiB0aGlzIHJlcG9zaXRvcnkgaXMgZW1iYXJnb2VkIGZvciBhdCBsZWFzdFxuICogYFZJQkVfQlVNUF9RVUFSQU5USU5FX0hPVVJTYCAoZGVmYXVsdCAyNGgpIOKAlCBgcmVub3ZhdGUuanNvbmBcbiAqIGBtaW5pbXVtUmVsZWFzZUFnZWAsIGBkZW5vLmpzb25gIGBtaW5pbXVtRGVwZW5kZW5jeUFnZWAsIGFuZFxuICogYG5wbV9wYWNrYWdlX2FnZS50c2Ag4oCUIGJ1dCB0aGUgdG9vbC11cGRhdGUgcGF0aCBhZG9wdGVkIHdoYXRldmVyIHVwc3RyZWFtXG4gKiBwdWJsaXNoZWQgYXQgdGhhdCBpbnN0YW50LiBBIGhpamFja2VkIHJlbGVhc2Ugd2FzIHRoZXJlZm9yZSBpbnN0YWxsZWQgYXNcbiAqIHJlYWRpbHkgYXMgb25lIHB1Ymxpc2hlZCBtb250aHMgYWdvLCBvbiBob3N0cyBob2xkaW5nIGBHSF9UT0tFTmAsIGEgR2l0SHViXG4gKiBBcHAgcHJpdmF0ZSBrZXksIGFuZCBgQU5USFJPUElDX0FQSV9LRVlgLlxuICpcbiAqIFRoaXMgbW9kdWxlIHJlc29sdmVzIHRoZSAqY2FuZGlkYXRlKiByZWxlYXNlIGZvciBhIHRvb2wgYW5kIGRlY2lkZXMgd2hldGhlclxuICogaXQgaGFzIGFnZWQgcGFzdCB0aGUgcXVhcmFudGluZSB3aW5kb3cuIEl0IGlzIHB1cmUgYW5kIGZ1bGx5IGluamVjdGFibGUgc29cbiAqIGl0IGNhbiBiZSB1bml0LXRlc3RlZCB3aXRoIG5vIG5ldHdvcmsgYWNjZXNzLlxuICpcbiAqICoqRmFpbC1jbG9zZWQgKElzc3VlICMzMjM0KS4qKiBVbmxpa2UgYG5wbV9wYWNrYWdlX2FnZS50c2Ag4oCUIHdoZXJlIGFuXG4gKiB1bnZlcmlmaWFibGUgYWdlIG11c3Qgbm90IGJyZWFrIGFuIG9mZmxpbmUgb3BlcmF0b3Igc2V0dXAg4oCUIGFuIHVudmVyaWZpYWJsZVxuICogdG9vbCByZWxlYXNlICpibG9ja3MqIHRoZSB1cGdyYWRlIGFuZCBsb2dzIGxvdWRseS4gRGVmZXJyaW5nIGFuIG9wdGlvbmFsXG4gKiB1cGdyYWRlIGlzIGhhcm1sZXNzOyBhZG9wdGluZyBhbiB1bnZlcmlmaWFibGUgYmluYXJ5IGlzIG5vdC5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggdXNlZCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbiwgYXV0aG9yaXNlZCkuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7XG4gIERFRkFVTFRfRkVUQ0hfVElNRU9VVF9NUyxcbiAgZGlzY2FyZEJvZHksXG4gIHJlYWRUZXh0Qm91bmRlZCxcbiAgd2l0aFJlcXVlc3RUaW1lb3V0LFxufSBmcm9tIFwiLi9ib3VuZGVkX2ZldGNoLnRzXCI7XG5pbXBvcnQgeyBNQVhfTlBNX1JFU1BPTlNFX0JZVEVTIH0gZnJvbSBcIi4vbnBtX3BhY2thZ2VfYWdlLnRzXCI7XG5cbi8qKiBEZWZhdWx0IHF1YXJhbnRpbmUgd2luZG93IGluIGhvdXJzIChtaXJyb3JzIGBWSUJFX0JVTVBfUVVBUkFOVElORV9IT1VSU2ApLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfVE9PTF9RVUFSQU5USU5FX0hPVVJTID0gMjQ7XG5cbi8qKiBucG0gcGFja2FnZSB0aGUgQ2xhdWRlIENMSSBpcyBkaXN0cmlidXRlZCB0aHJvdWdoLiAqL1xuZXhwb3J0IGNvbnN0IENMQVVERV9DTElfTlBNX1BBQ0tBR0UgPSBcIkBhbnRocm9waWMtYWkvY2xhdWRlLWNvZGVcIjtcblxuLyoqIEdpdEh1YiByZXBvc2l0b3J5IHB1Ymxpc2hpbmcgYGdoYCByZWxlYXNlcy4gKi9cbmV4cG9ydCBjb25zdCBHSF9DTElfUkVMRUFTRV9SRVBPID0gXCJjbGkvY2xpXCI7XG5cbi8qKiBHaXRIdWIgcmVwb3NpdG9yeSBwdWJsaXNoaW5nIERlbm8gcmVsZWFzZXMuICovXG5leHBvcnQgY29uc3QgREVOT19SRUxFQVNFX1JFUE8gPSBcImRlbm9sYW5kL2Rlbm9cIjtcblxuLyoqIEJhc2UgVVJMIG9mIHRoZSBwdWJsaWMgbnBtIHJlZ2lzdHJ5LiAqL1xuZXhwb3J0IGNvbnN0IE5QTV9SRUdJU1RSWV9CQVNFID0gXCJodHRwczovL3JlZ2lzdHJ5Lm5wbWpzLm9yZ1wiO1xuXG4vKiogVGltZW91dCAoc2Vjb25kcykgZm9yIGEgc2luZ2xlIHJlbGVhc2UtbWV0YWRhdGEgbG9va3VwLiAqL1xuZXhwb3J0IGNvbnN0IFJFTEVBU0VfTE9PS1VQX1RJTUVPVVRfU0VDT05EUyA9IDMwO1xuXG4vKiogYG93bmVyL3JlcG9gIHNoYXBlIGFjY2VwdGVkIGluIGEgR2l0SHViIEFQSSBwYXRoIChubyB0cmF2ZXJzYWwsIG5vIHNoZWxsKS4gKi9cbmNvbnN0IFJFUE9fUEFUVEVSTiA9IC9eW0EtWmEtejAtOS5fLV0rXFwvW0EtWmEtejAtOS5fLV0rJC87XG5cbi8qKiBucG0gcGFja2FnZSBuYW1lIHNoYXBlIGFjY2VwdGVkIGluIGEgcmVnaXN0cnkgVVJMLiAqL1xuY29uc3QgTlBNX1BBQ0tBR0VfUEFUVEVSTiA9IC9eKEBbQS1aYS16MC05Ll8tXStcXC8pP1tBLVphLXowLTkuXy1dKyQvO1xuXG4vKiogQnJhbmNoIG5hbWUgc2hhcGUgYWNjZXB0ZWQgaW4gYSBHaXRIdWIgQVBJIHBhdGggKG5vIHRyYXZlcnNhbCwgbm8gc2hlbGwpLiAqL1xuY29uc3QgQlJBTkNIX1BBVFRFUk4gPSAvXltBLVphLXowLTldW0EtWmEtejAtOS5fLy1dKiQvO1xuXG4vKiogQ29tbWl0IHNoYSBzaGFwZSBlbWl0dGVkIGJ5IHRoZSBjb21taXRzIEFQSS4gKi9cbmNvbnN0IFNIQV9QQVRURVJOID0gL15bMC05YS1mXXs0MH0kLztcblxuLyoqXG4gKiBBIHBsYWluIHN0YWJsZSByZWxlYXNlIHZlcnNpb246IGBNQUpPUi5NSU5PUi5QQVRDSGAsIG5vIHByZS1yZWxlYXNlIHN1ZmZpeFxuICogYW5kIG5vIGJ1aWxkIG1ldGFkYXRhLiBPbmx5IHRoZXNlIGFyZSBjb25zaWRlcmVkIHdoZW4gZmFsbGluZyBiYWNrIHRvIHRoZVxuICogbmV3ZXN0IHJlbGVhc2UgcGFzdCB0aGUgcXVhcmFudGluZSB3aW5kb3cgKElzc3VlICM3MjYpLlxuICovXG5jb25zdCBTVEFCTEVfU0VNVkVSX1BBVFRFUk4gPSAvXlxcZCtcXC5cXGQrXFwuXFxkKyQvO1xuXG4vKipcbiAqIGBHT09TLUdPQVJDSGAgYXNzZXQgc3VmZml4IHRoYXQgbWFya3MgYSAqKmJpbmFyeSoqIGBnaGAgZXh0ZW5zaW9uLlxuICpcbiAqIE1pcnJvcnMgYGdoYCdzIG93biBydWxlIChgaXNCaW5FeHRlbnNpb25gIGluIGBjbGkvY2xpYCk6IGFuIGV4dGVuc2lvbiBpc1xuICogaW5zdGFsbGVkIGZyb20gaXRzIGxhdGVzdCByZWxlYXNlIG9ubHkgd2hlbiB0aGF0IHJlbGVhc2UgY2FycmllcyBhbiBhc3NldFxuICogd2hvc2UgbmFtZSAqZW5kcyogaW4gYDxnb29zPi08Z29hcmNoPmAg4oCUIHdpdGggYC5leGVgIGFwcGVuZGVkIG9uIFdpbmRvd3MuXG4gKiBBbnl0aGluZyBlbHNlIOKAlCBpbmNsdWRpbmcgYSByZXBvc2l0b3J5IHRoYXQgbWVyZWx5IHRhZ3MgcmVsZWFzZXMg4oCUIGlzIGFcbiAqICpzY3JpcHQqIGV4dGVuc2lvbiwgd2hpY2ggYGdoYCBpbnN0YWxscyBieSBjbG9uaW5nIHRoZSBkZWZhdWx0IGJyYW5jaC5cbiAqL1xuY29uc3QgQklOQVJZX0FTU0VUX1NVRkZJWCA9XG4gIC8oPzooPzphaXh8YW5kcm9pZHxkYXJ3aW58ZHJhZ29uZmx5fGZyZWVic2R8aWxsdW1vc3xpb3N8anN8bGludXh8bmV0YnNkfG9wZW5ic2R8cGxhbjl8c29sYXJpcyktKD86Mzg2fGFtZDY0fGFybXxhcm02NHxsb29uZzY0fG1pcHN8bWlwczY0fG1pcHM2NGxlfG1pcHNsZXxwcGM2NHxwcGM2NGxlfHJpc2N2NjR8czM5MHh8d2FzbSl8d2luZG93cy0oPzozODZ8YW1kNjR8YXJtfGFybTY0KVxcLmV4ZSkkLztcblxuLyoqIFVwc3RyZWFtIGNoYW5uZWwgYSB0b29sJ3MgcmVsZWFzZXMgYXJlIHB1Ymxpc2hlZCB0aHJvdWdoLiAqL1xuZXhwb3J0IHR5cGUgUmVsZWFzZUNoYW5uZWwgPVxuICB8IHsga2luZDogXCJucG1cIjsgcGtnOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJnaXRodWJcIjsgcmVwbzogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwiZ2gtZXh0ZW5zaW9uXCI7IHJlcG86IHN0cmluZyB9O1xuXG4vKiogSHVtYW4tcmVhZGFibGUgbGFiZWwgZm9yIGEgY2hhbm5lbCwgdXNlZCBpbiBsb2cgbGluZXMuICovXG5leHBvcnQgZnVuY3Rpb24gZGVzY3JpYmVDaGFubmVsKGNoYW5uZWw6IFJlbGVhc2VDaGFubmVsKTogc3RyaW5nIHtcbiAgaWYgKGNoYW5uZWwua2luZCA9PT0gXCJucG1cIikgcmV0dXJuIGBucG06JHtjaGFubmVsLnBrZ31gO1xuICBpZiAoY2hhbm5lbC5raW5kID09PSBcImdoLWV4dGVuc2lvblwiKSByZXR1cm4gYGdoLWV4dGVuc2lvbjoke2NoYW5uZWwucmVwb31gO1xuICByZXR1cm4gYGdpdGh1Yjoke2NoYW5uZWwucmVwb31gO1xufVxuXG4vKiogVGhlIG5ld2VzdCByZWxlYXNlIGEgY2hhbm5lbCBvZmZlcnMuICovXG5leHBvcnQgaW50ZXJmYWNlIFJlbGVhc2VDYW5kaWRhdGUge1xuICAvKiogUmVzb2x2ZWQgdmVyc2lvbiB3aXRoIGFueSBsZWFkaW5nIGB2YCBzdHJpcHBlZCwgb3IgbnVsbCB3aGVuIHVua25vd24uICovXG4gIHZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIC8qKiBJU08gcHVibGlzaCB0aW1lc3RhbXAsIG9yIG51bGwgd2hlbiB1bmtub3duLiAqL1xuICBwdWJsaXNoZWRBdDogc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEV4YWN0IHVwc3RyZWFtIHJlZiB0aGUgZGF0ZSBiZWxvbmdzIHRvIOKAlCBhIHJlbGVhc2UgdGFnIHZlcmJhdGltIG9yIGFcbiAgICogY29tbWl0IHNoYSAoSXNzdWUgIzM5NTIpLiBOdWxsIHdoZW4gdGhlIGNoYW5uZWwgaW5zdGFsbHMgbm8gcGlubmFibGUgcmVmLlxuICAgKi9cbiAgcmVmPzogc3RyaW5nIHwgbnVsbDtcbn1cblxuLyoqIFZlcmRpY3QgZm9yIG9uZSBjaGFubmVsJ3MgbmV3ZXN0IHJlbGVhc2UuICovXG5leHBvcnQgaW50ZXJmYWNlIFJlbGVhc2VBZ2VWZXJkaWN0IHtcbiAgLyoqIENoYW5uZWwgbGFiZWwgdGhlIHZlcmRpY3QgYXBwbGllcyB0by4gKi9cbiAgc291cmNlOiBzdHJpbmc7XG4gIC8qKiBSZXNvbHZlZCBjYW5kaWRhdGUgdmVyc2lvbiwgb3IgbnVsbCB3aGVuIGl0IGNvdWxkIG5vdCBiZSBkZXRlcm1pbmVkLiAqL1xuICB2ZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogRXhhY3QgcmVmIHRoZSB2ZXJkaWN0IGRhdGVkLCBmb3IgY2FsbGVycyB0aGF0IHBpbiB0aGUgaW5zdGFsbCB0byBpdFxuICAgKiAoSXNzdWUgIzM5NTIpLiBOdWxsIHdoZW4gbm8gaW5zdGFsbGFibGUgcmVmIGNvdWxkIGJlIHJlc29sdmVkLlxuICAgKi9cbiAgcmVmPzogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIFRydWUgd2hlbiB0aGUgY2FuZGlkYXRlIGhhcyBhZ2VkIHBhc3QgdGhlIHF1YXJhbnRpbmUgd2luZG93LiAqL1xuICBlbGlnaWJsZTogYm9vbGVhbjtcbiAgLyoqIFRydWUgd2hlbiB0aGUgcmVsZWFzZSBhZ2UgY291bGQgbm90IGJlIGRldGVybWluZWQgYXQgYWxsLiAqL1xuICBpbmRldGVybWluYXRlOiBib29sZWFuO1xuICAvKiogQWdlIGluIGhvdXJzIHNpbmNlIHB1YmxpY2F0aW9uLCBvciBudWxsIHdoZW4gaW5kZXRlcm1pbmF0ZS4gKi9cbiAgYWdlSG91cnM6IG51bWJlciB8IG51bGw7XG4gIC8qKiBJU08gcHVibGlzaCB0aW1lc3RhbXAsIG9yIG51bGwgd2hlbiBpbmRldGVybWluYXRlLiAqL1xuICBwdWJsaXNoZWRBdDogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIEh1bWFuLXJlYWRhYmxlIGV4cGxhbmF0aW9uIHN1aXRhYmxlIGZvciBhIGxvZyBsaW5lLiAqL1xuICByZWFzb246IHN0cmluZztcbn1cblxuLyoqIEEgZ2F0ZSBjb25zdWx0ZWQgYmVmb3JlIGFueSB0b29sY2hhaW4gdXBncmFkZSBydW5zLiAqL1xuZXhwb3J0IGludGVyZmFjZSBSZWxlYXNlQWdlR2F0ZSB7XG4gIC8qKiBFZmZlY3RpdmUgcXVhcmFudGluZSB3aW5kb3cgaW4gaG91cnMuICovXG4gIHF1YXJhbnRpbmVIb3VyczogbnVtYmVyO1xuICAvKiogVmVyZGljdCBmb3IgYSBjaGFubmVsLiBOZXZlciB0aHJvd3Mg4oCUIGZhaWx1cmVzIGJlY29tZSBpbmRldGVybWluYXRlLiAqL1xuICBjaGVjayhjaGFubmVsOiBSZWxlYXNlQ2hhbm5lbCk6IFByb21pc2U8UmVsZWFzZUFnZVZlcmRpY3Q+O1xuICAvKipcbiAgICogVmVyZGljdCBmb3IgdGhlIG5ld2VzdCByZWxlYXNlIG9mIGEgY2hhbm5lbCB0aGF0IGhhcyAqYWxyZWFkeSogY2xlYXJlZCB0aGVcbiAgICogcXVhcmFudGluZSB3aW5kb3cgKElzc3VlICM3MjYpLlxuICAgKlxuICAgKiB7QGxpbmsgY2hlY2t9IGFuc3dlcnMgXCJtYXkgdGhlIG5ld2VzdCByZWxlYXNlIGJlIGFkb3B0ZWQ/XCIsIHdoaWNoIGlzIHRoZVxuICAgKiBxdWVzdGlvbiBhbiB1cGdyYWRlIGFza3MuIEEgY2FsbGVyIHRoYXQgaGFzIHRvIG5hbWUgYW4gaW5zdGFsbGFibGUgdmVyc2lvblxuICAgKiDigJQgdGhlIHJlbGVhc2UgdG9vbC12ZXJzaW9uIG1hbmlmZXN0IOKAlCBhc2tzIHRoaXMgaW5zdGVhZDogdXBzdHJlYW0gc2hpcHNcbiAgICogc2V2ZXJhbCB0aW1lcyBhIGRheSwgc28gdGhlIG5ld2VzdCByZWxlYXNlIGlzIHVzdWFsbHkgaW5zaWRlIHRoZSB3aW5kb3cgYW5kXG4gICAqIHRoZSBob25lc3QgYW5zd2VyIGlzIHRoZSBuZXdlc3Qgb25lIG91dHNpZGUgaXQsIG5vdCBhIGZhaWx1cmUuXG4gICAqXG4gICAqIE5ldmVyIHRocm93cywgYW5kIG5ldmVyIHdpZGVucyB0aGUgZW1iYXJnbzogYSBoaXN0b3J5IHdpdGggbm90aGluZyBwYXN0IHRoZVxuICAgKiB3aW5kb3cgaXMgaW5lbGlnaWJsZSwgZXhhY3RseSBhcyB7QGxpbmsgY2hlY2t9IHdvdWxkIHJlcG9ydCBpdC5cbiAgICovXG4gIGNoZWNrTmV3ZXN0QWdlZChjaGFubmVsOiBSZWxlYXNlQ2hhbm5lbCk6IFByb21pc2U8UmVsZWFzZUFnZVZlcmRpY3Q+O1xufVxuXG4vKiogQW4gaW5zdGFsbGVkIGBnaGAgZXh0ZW5zaW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBHaEV4dGVuc2lvbiB7XG4gIC8qKiBTaG9ydCBuYW1lIGBnaGAgcmVmZXJzIHRvIHRoZSBleHRlbnNpb24gYnksIHVzZWQgaW4gbG9nIGxpbmVzLiAqL1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBTb3VyY2UgcmVwb3NpdG9yeSBpbiBgb3duZXIvcmVwb2AgZm9ybS4gKi9cbiAgcmVwbzogc3RyaW5nO1xufVxuXG4vKiogSW5qZWN0YWJsZSBzaWRlLWVmZmVjdHMgZm9yIHtAbGluayBjcmVhdGVSZWxlYXNlQWdlR2F0ZX0uICovXG5leHBvcnQgaW50ZXJmYWNlIFJlbGVhc2VBZ2VHYXRlRGVwcyB7XG4gIC8qKiBDb21tYW5kIHJ1bm5lciB1c2VkIGZvciBgZ2ggYXBpYCBsb29rdXBzLiAqL1xuICBydW5GbjogKFxuICAgIGNtZDogc3RyaW5nW10sXG4gICAgdGltZW91dFNlY29uZHM6IG51bWJlcixcbiAgKSA9PiBQcm9taXNlPFJlc3VsdDx7IGV4aXRDb2RlOiBudW1iZXI7IG91dHB1dDogc3RyaW5nIH0+PjtcbiAgLyoqIFF1YXJhbnRpbmUgd2luZG93IGluIGhvdXJzIChkZWZhdWx0IDI0LCBub24tcG9zaXRpdmUgdmFsdWVzIHJlamVjdGVkKS4gKi9cbiAgcXVhcmFudGluZUhvdXJzPzogbnVtYmVyO1xuICAvKiogRmV0Y2ggcmF3IG5wbSByZWdpc3RyeSBtZXRhZGF0YTsgcmVzb2x2ZXMgdW5kZWZpbmVkIG9uIGFueSBmYWlsdXJlLiAqL1xuICBmZXRjaE5wbU1ldGFkYXRhPzogKHBrZzogc3RyaW5nKSA9PiBQcm9taXNlPHVua25vd24+O1xuICAvKiogQ3VycmVudCB3YWxsLWNsb2NrIHRpbWUuICovXG4gIG5vdz86ICgpID0+IERhdGU7XG4gIC8qKiBSZXBvcnRzIGEgcmVqZWN0ZWQgcXVhcmFudGluZSB3aW5kb3cuICovXG4gIHdhcm4/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG4vKipcbiAqIE5vcm1hbGlzZSBhIGNvbmZpZ3VyZWQgcXVhcmFudGluZSB3aW5kb3cgdG8gYSB1c2FibGUgbnVtYmVyIG9mIGhvdXJzLlxuICpcbiAqIE9ubHkgYSBwb3NpdGl2ZSB3aG9sZSBudW1iZXIgb2YgaG91cnMgaXMgYWNjZXB0ZWQuIEFueXRoaW5nIGVsc2Ug4oCUIHplcm8sIGFcbiAqIG5lZ2F0aXZlLCBhIGZyYWN0aW9uLCBvciB1bnBhcnNlYWJsZSB0ZXh0IOKAlCBmYWxscyBiYWNrIHRvIHRoZSBkb2N1bWVudGVkXG4gKiBkZWZhdWx0IGFuZCBpcyByZXBvcnRlZCwgc28gdGhlIGVtYmFyZ28gY2FuIG5ldmVyIGJlIHNpbGVudGx5IHN3aXRjaGVkIG9mZlxuICogKHRoZSBJc3N1ZSAjMzY0OSAvICMzNjU5IGZhaWx1cmUgbW9kZSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpc2VRdWFyYW50aW5lSG91cnMoXG4gIHJhdzogdW5rbm93bixcbiAgd2Fybj86IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQsXG4pOiBudW1iZXIge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3ID09PSBudWxsIHx8IHJhdyA9PT0gXCJcIikge1xuICAgIHJldHVybiBERUZBVUxUX1RPT0xfUVVBUkFOVElORV9IT1VSUztcbiAgfVxuICBjb25zdCB0ZXh0ID0gU3RyaW5nKHJhdykudHJpbSgpO1xuICBjb25zdCBwYXJzZWQgPSAvXlxcZCskLy50ZXN0KHRleHQpID8gTnVtYmVyKHRleHQpIDogTnVtYmVyLk5hTjtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSB8fCBwYXJzZWQgPCAxKSB7XG4gICAgd2Fybj8uKFxuICAgICAgYElnbm9yaW5nIHRvb2wgcXVhcmFudGluZSB3aW5kb3cgXCIke3RleHR9XCIg4oCUIGl0IG11c3QgYmUgYSBwb3NpdGl2ZSBgICtcbiAgICAgICAgYHdob2xlIG51bWJlciBvZiBob3Vycy4gRmFsbGluZyBiYWNrIHRvIGAgK1xuICAgICAgICBgJHtERUZBVUxUX1RPT0xfUVVBUkFOVElORV9IT1VSU31oIHNvIHRoZSB0b29sY2hhaW4gcmVsZWFzZSBlbWJhcmdvIGAgK1xuICAgICAgICBgaXMgbm90IHNpbGVudGx5IGRpc2FibGVkLmAsXG4gICAgKTtcbiAgICByZXR1cm4gREVGQVVMVF9UT09MX1FVQVJBTlRJTkVfSE9VUlM7XG4gIH1cbiAgcmV0dXJuIHBhcnNlZDtcbn1cblxuLyoqXG4gKiBQdXJlIGFnZSBldmFsdWF0b3I6IGRlY2lkZSB3aGV0aGVyIGEgcmVzb2x2ZWQgY2FuZGlkYXRlIGNsZWFycyB0aGUgd2luZG93LlxuICpcbiAqIEFuIHVua25vd24gdmVyc2lvbiwgYSBtaXNzaW5nIHB1Ymxpc2ggdGltZSwgb3IgYW4gdW5wYXJzZWFibGUgdGltZXN0YW1wIGFyZVxuICogYWxsIGluZGV0ZXJtaW5hdGUg4oCUIGFuZCBpbmRldGVybWluYXRlIGlzICoqbm90KiogZWxpZ2libGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBldmFsdWF0ZVJlbGVhc2VBZ2UoXG4gIHNvdXJjZTogc3RyaW5nLFxuICBjYW5kaWRhdGU6IFJlbGVhc2VDYW5kaWRhdGUsXG4gIHF1YXJhbnRpbmVIb3VyczogbnVtYmVyLFxuICBub3c6IERhdGUsXG4pOiBSZWxlYXNlQWdlVmVyZGljdCB7XG4gIGNvbnN0IGZsb29yID0gbm9ybWFsaXNlUXVhcmFudGluZUhvdXJzKHF1YXJhbnRpbmVIb3Vycyk7XG4gIGNvbnN0IGluZGV0ZXJtaW5hdGUgPSAocmVhc29uOiBzdHJpbmcpOiBSZWxlYXNlQWdlVmVyZGljdCA9PiAoe1xuICAgIHNvdXJjZSxcbiAgICB2ZXJzaW9uOiBjYW5kaWRhdGUudmVyc2lvbixcbiAgICByZWY6IGNhbmRpZGF0ZS5yZWYgPz8gbnVsbCxcbiAgICBlbGlnaWJsZTogZmFsc2UsXG4gICAgaW5kZXRlcm1pbmF0ZTogdHJ1ZSxcbiAgICBhZ2VIb3VyczogbnVsbCxcbiAgICBwdWJsaXNoZWRBdDogY2FuZGlkYXRlLnB1Ymxpc2hlZEF0LFxuICAgIHJlYXNvbixcbiAgfSk7XG5cbiAgaWYgKCFjYW5kaWRhdGUudmVyc2lvbiB8fCAhY2FuZGlkYXRlLnB1Ymxpc2hlZEF0KSB7XG4gICAgcmV0dXJuIGluZGV0ZXJtaW5hdGUoXG4gICAgICBgQ291bGQgbm90IHJlc29sdmUgdGhlIG5ld2VzdCByZWxlYXNlIG9mICR7c291cmNlfTsgdGhlICR7Zmxvb3J9aCBgICtcbiAgICAgICAgYHJlbGVhc2UgcXVhcmFudGluZSBjYW5ub3QgYmUgdmVyaWZpZWQsIHNvIHRoZSB1cGdyYWRlIGlzIHNraXBwZWQuYCxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgcHVibGlzaGVkTXMgPSBEYXRlLnBhcnNlKGNhbmRpZGF0ZS5wdWJsaXNoZWRBdCk7XG4gIGlmIChOdW1iZXIuaXNOYU4ocHVibGlzaGVkTXMpKSB7XG4gICAgcmV0dXJuIGluZGV0ZXJtaW5hdGUoXG4gICAgICBgVW5wYXJzZWFibGUgcHVibGlzaCB0aW1lc3RhbXAgXCIke2NhbmRpZGF0ZS5wdWJsaXNoZWRBdH1cIiBmb3IgYCArXG4gICAgICAgIGAke3NvdXJjZX1AJHtjYW5kaWRhdGUudmVyc2lvbn07IHRoZSAke2Zsb29yfWggcmVsZWFzZSBxdWFyYW50aW5lIGAgK1xuICAgICAgICBgY2Fubm90IGJlIHZlcmlmaWVkLCBzbyB0aGUgdXBncmFkZSBpcyBza2lwcGVkLmAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGFnZUhvdXJzID0gKG5vdy5nZXRUaW1lKCkgLSBwdWJsaXNoZWRNcykgLyAzXzYwMF8wMDA7XG4gIGNvbnN0IGVsaWdpYmxlID0gYWdlSG91cnMgPj0gZmxvb3I7XG4gIGNvbnN0IGFnZVRleHQgPSBgJHthZ2VIb3Vycy50b0ZpeGVkKDEpfWggb2xkYDtcbiAgcmV0dXJuIHtcbiAgICBzb3VyY2UsXG4gICAgdmVyc2lvbjogY2FuZGlkYXRlLnZlcnNpb24sXG4gICAgcmVmOiBjYW5kaWRhdGUucmVmID8/IG51bGwsXG4gICAgZWxpZ2libGUsXG4gICAgaW5kZXRlcm1pbmF0ZTogZmFsc2UsXG4gICAgYWdlSG91cnMsXG4gICAgcHVibGlzaGVkQXQ6IGNhbmRpZGF0ZS5wdWJsaXNoZWRBdCxcbiAgICByZWFzb246IGVsaWdpYmxlXG4gICAgICA/IGAke3NvdXJjZX1AJHtjYW5kaWRhdGUudmVyc2lvbn0gaXMgJHthZ2VUZXh0fSAoPj0gJHtmbG9vcn1oIHF1YXJhbnRpbmUpLmBcbiAgICAgIDogYCR7c291cmNlfUAke2NhbmRpZGF0ZS52ZXJzaW9ufSBpcyBvbmx5ICR7YWdlVGV4dH0gKDwgJHtmbG9vcn1oIGAgK1xuICAgICAgICBgcXVhcmFudGluZSk7IGRlZmVycmluZyB0aGUgdXBncmFkZSB1bnRpbCBpdCBhZ2VzIHBhc3QgdGhlIHdpbmRvdy5gLFxuICB9O1xufVxuXG4vKipcbiAqIFBhcnNlIGBnaCBleHRlbnNpb24gbGlzdGAgb3V0cHV0IGludG8gaW5zdGFsbGVkIGV4dGVuc2lvbnMuXG4gKlxuICogVGhlIGNvbHVtbiBsYXlvdXQgaGFzIHZhcmllZCBhY3Jvc3MgYGdoYCByZWxlYXNlcywgc28gdGhlIHJlcG9zaXRvcnkgaXNcbiAqIGxvY2F0ZWQgYnkgc2hhcGUgKGBvd25lci9yZXBvYCkgcmF0aGVyIHRoYW4gYnkgY29sdW1uIGluZGV4LiBMaW5lcyB3aXRoIG5vXG4gKiBzdWNoIHRva2VuIChoZWFkZXJzLCBub3RpY2VzKSBhcmUgaWdub3JlZC4gVGhlIHVwZ3JhZGUgbmFtZSBpcyB0aGUgcmVwbydzXG4gKiBuYW1lIHdpdGggYW55IGBnaC1gIHByZWZpeCBzdHJpcHBlZCwgbWF0Y2hpbmcgYGdoYCdzIG93biBjb252ZW50aW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VHaEV4dGVuc2lvbkxpc3Qob3V0cHV0OiBzdHJpbmcpOiBHaEV4dGVuc2lvbltdIHtcbiAgY29uc3QgZXh0ZW5zaW9uczogR2hFeHRlbnNpb25bXSA9IFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgbGluZSBvZiBvdXRwdXQuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCByZXBvID0gbGluZVxuICAgICAgLnRyaW0oKVxuICAgICAgLnNwbGl0KC9cXHMrLylcbiAgICAgIC5maW5kKCh0b2tlbikgPT4gUkVQT19QQVRURVJOLnRlc3QodG9rZW4pKTtcbiAgICBpZiAoIXJlcG8gfHwgc2Vlbi5oYXMocmVwbykpIGNvbnRpbnVlO1xuICAgIHNlZW4uYWRkKHJlcG8pO1xuICAgIGNvbnN0IG5hbWUgPSByZXBvLnNsaWNlKHJlcG8uaW5kZXhPZihcIi9cIikgKyAxKS5yZXBsYWNlKC9eZ2gtLywgXCJcIik7XG4gICAgaWYgKG5hbWUpIGV4dGVuc2lvbnMucHVzaCh7IG5hbWUsIHJlcG8gfSk7XG4gIH1cbiAgcmV0dXJuIGV4dGVuc2lvbnM7XG59XG5cbi8qKlxuICogUGFyc2UgdGhlIGA8dGFnPiA8cHVibGlzaGVkX2F0PmAgbGluZSBlbWl0dGVkIGJ5IHRoZSBgZ2ggYXBpIC0tanFgIGxvb2t1cC5cbiAqXG4gKiBgZ2hgIG1heSBhbHNvIHdyaXRlIGRpYWdub3N0aWNzIHRvIHN0ZGVyciwgc28gdGhlIGZpcnN0IGxpbmUgbWF0Y2hpbmcgdGhlXG4gKiBleHBlY3RlZCBzaGFwZSB3aW5zIHJhdGhlciB0aGFuIGFzc3VtaW5nIHRoZSBvdXRwdXQgaXMgZXhhY3RseSBvbmUgbGluZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlR2hSZWxlYXNlTGluZShvdXRwdXQ6IHN0cmluZyk6IFJlbGVhc2VDYW5kaWRhdGUge1xuICBmb3IgKGNvbnN0IGxpbmUgb2Ygb3V0cHV0LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3QgbWF0Y2ggPSBsaW5lLnRyaW0oKS5tYXRjaChcbiAgICAgIC9eKFxcUyspXFxzKyhcXGR7NH0tXFxkezJ9LVxcZHsyfVRbXFxkOl0rKD86XFwuXFxkKyk/WikkLyxcbiAgICApO1xuICAgIGlmIChtYXRjaCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdmVyc2lvbjogbWF0Y2hbMV0hLnJlcGxhY2UoL152LywgXCJcIiksXG4gICAgICAgIHB1Ymxpc2hlZEF0OiBtYXRjaFsyXSEsXG4gICAgICB9O1xuICAgIH1cbiAgfVxuICByZXR1cm4geyB2ZXJzaW9uOiBudWxsLCBwdWJsaXNoZWRBdDogbnVsbCB9O1xufVxuXG4vKiogTGF0ZXN0IHJlbGVhc2Ugb2YgYSBgZ2hgIGV4dGVuc2lvbiByZXBvc2l0b3J5LCBhcyBmYXIgYXMgaXQgY291bGQgYmUgcmVhZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgR2hFeHRlbnNpb25SZWxlYXNlIHtcbiAgLyoqIFJlbGVhc2UgdGFnIHZlcmJhdGltIChhIGB2YCBwcmVmaXggaXMga2VwdCksIG9yIG51bGwgd2hlbiB0aGVyZSBpcyBub25lLiAqL1xuICB0YWc6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBJU08gcHVibGlzaCB0aW1lc3RhbXAgb2YgdGhhdCByZWxlYXNlLCBvciBudWxsIHdoZW4gdW5rbm93bi4gKi9cbiAgcHVibGlzaGVkQXQ6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBOYW1lcyBvZiB0aGUgcmVsZWFzZSdzIHVwbG9hZGVkIGFzc2V0cy4gKi9cbiAgYXNzZXRzOiBzdHJpbmdbXTtcbn1cblxuLyoqIElTTy04NjAxIGluc3RhbnQgYXMgR2l0SHViIGVtaXRzIGl0LiAqL1xuY29uc3QgSVNPX0lOU1RBTlQgPSBTdHJpbmcucmF3YFxcZHs0fS1cXGR7Mn0tXFxkezJ9VFtcXGQ6XSsoPzpcXC5cXGQrKT9aYDtcblxuLyoqXG4gKiBQYXJzZSB0aGUgYDx0YWc+IDxwdWJsaXNoZWRfYXQ+YCBsaW5lcyBvZiBhIHdob2xlIHJlbGVhc2UgbGlzdGluZywgbmV3ZXN0XG4gKiBwdWJsaXNoIGZpcnN0IChJc3N1ZSAjNzI2KS5cbiAqXG4gKiBUaGUgc2luZ2xlLXJlbGVhc2UgcGFyc2VyIGFib3ZlIGFuc3dlcnMgXCJ3aGF0IGlzIG5ld2VzdFwiOyB0aGlzIG9uZSBrZWVwcyB0aGVcbiAqIHJlbGVhc2VzIGJlaGluZCBpdCwgc28gYSBjYWxsZXIgY2FuIGZhbGwgYmFjayB0byB0aGUgbmV3ZXN0IHJlbGVhc2UgdGhhdCBoYXNcbiAqIGNsZWFyZWQgdGhlIHF1YXJhbnRpbmUgd2luZG93LiBPbmx5IHN0YWJsZSBgTUFKT1IuTUlOT1IuUEFUQ0hgIHRhZ3MgYXJlXG4gKiBrZXB0IOKAlCB0aGUgc2FtZSBzZXJpZXMgdGhlIHBpbm5lZCBpbnN0YWxsZXIgY2FuIGluc3RhbGwg4oCUIGFuZCBsaW5lcyB0aGF0IGRvXG4gKiBub3QgbWF0Y2ggdGhlIHNoYXBlIChkaWFnbm9zdGljcyBvbiBzdGRlcnIpIGFyZSBpZ25vcmVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VHaFJlbGVhc2VMaXN0aW5nKG91dHB1dDogc3RyaW5nKTogUmVsZWFzZUNhbmRpZGF0ZVtdIHtcbiAgY29uc3QgcmVsZWFzZUxpbmUgPSBuZXcgUmVnRXhwKGBeKFxcXFxTKylcXFxccysoJHtJU09fSU5TVEFOVH0pJGApO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGRhdGVkOiB7IGNhbmRpZGF0ZTogUmVsZWFzZUNhbmRpZGF0ZTsgcHVibGlzaGVkTXM6IG51bWJlciB9W10gPSBbXTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIG91dHB1dC5zcGxpdChcIlxcblwiKSkge1xuICAgIGNvbnN0IG1hdGNoID0gbGluZS50cmltKCkubWF0Y2gocmVsZWFzZUxpbmUpO1xuICAgIGlmICghbWF0Y2gpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHRhZyA9IG1hdGNoWzFdITtcbiAgICBjb25zdCB2ZXJzaW9uID0gdGFnLnJlcGxhY2UoL152LywgXCJcIik7XG4gICAgaWYgKCFTVEFCTEVfU0VNVkVSX1BBVFRFUk4udGVzdCh2ZXJzaW9uKSB8fCBzZWVuLmhhcyh2ZXJzaW9uKSkgY29udGludWU7XG4gICAgY29uc3QgcHVibGlzaGVkTXMgPSBEYXRlLnBhcnNlKG1hdGNoWzJdISk7XG4gICAgaWYgKE51bWJlci5pc05hTihwdWJsaXNoZWRNcykpIGNvbnRpbnVlO1xuICAgIHNlZW4uYWRkKHZlcnNpb24pO1xuICAgIGRhdGVkLnB1c2goe1xuICAgICAgY2FuZGlkYXRlOiB7IHZlcnNpb24sIHB1Ymxpc2hlZEF0OiBtYXRjaFsyXSEsIHJlZjogdGFnIH0sXG4gICAgICBwdWJsaXNoZWRNcyxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gZGF0ZWRcbiAgICAuc29ydCgoYSwgYikgPT4gYi5wdWJsaXNoZWRNcyAtIGEucHVibGlzaGVkTXMpXG4gICAgLm1hcCgoZW50cnkpID0+IGVudHJ5LmNhbmRpZGF0ZSk7XG59XG5cbi8qKlxuICogUGljayB0aGUgbmV3ZXN0IHJlbGVhc2UgaW4gYSBoaXN0b3J5IHRoYXQgaGFzIGNsZWFyZWQgdGhlIHF1YXJhbnRpbmUgd2luZG93XG4gKiAoSXNzdWUgIzcyNikuXG4gKlxuICogVGhlIGhpc3RvcnkgaXMgZXZhbHVhdGVkIG5ld2VzdCBmaXJzdCB3aXRoIHRoZSBzYW1lIHtAbGluayBldmFsdWF0ZVJlbGVhc2VBZ2V9XG4gKiBldmVyeSB1cGdyYWRlIHVzZXMsIHNvIHRoZSB3aW5kb3cgaXMgYXBwbGllZCBpZGVudGljYWxseSDigJQgdGhpcyBvbmx5IGNob29zZXNcbiAqICp3aGljaCogcmVsZWFzZSB0aGUgdmVyZGljdCBkZXNjcmliZXMuIE5vdGhpbmcgaGVyZSB3aWRlbnMgdGhlIGVtYmFyZ286IGFuXG4gKiBlbXB0eSBoaXN0b3J5IGlzIGluZGV0ZXJtaW5hdGUsIGFuZCBhIGhpc3RvcnkgaW4gd2hpY2ggZXZlcnkgcmVsZWFzZSBpcyBzdGlsbFxuICogaW5zaWRlIHRoZSB3aW5kb3cgcmV0dXJucyB0aGUgbmV3ZXN0IHJlbGVhc2UncyBvd24gaW5lbGlnaWJsZSB2ZXJkaWN0LCBzbyB0aGVcbiAqIGNhbGxlciBmYWlscyBleGFjdGx5IGFzIGxvdWRseSBhcyBiZWZvcmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWxlY3ROZXdlc3RBZ2VkKFxuICBzb3VyY2U6IHN0cmluZyxcbiAgaGlzdG9yeTogcmVhZG9ubHkgUmVsZWFzZUNhbmRpZGF0ZVtdLFxuICBxdWFyYW50aW5lSG91cnM6IG51bWJlcixcbiAgbm93OiBEYXRlLFxuKTogUmVsZWFzZUFnZVZlcmRpY3Qge1xuICBjb25zdCBmbG9vciA9IG5vcm1hbGlzZVF1YXJhbnRpbmVIb3VycyhxdWFyYW50aW5lSG91cnMpO1xuICBjb25zdCB1bmtub3duOiBSZWxlYXNlQ2FuZGlkYXRlID0geyB2ZXJzaW9uOiBudWxsLCBwdWJsaXNoZWRBdDogbnVsbCB9O1xuICBpZiAoaGlzdG9yeS5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gZXZhbHVhdGVSZWxlYXNlQWdlKHNvdXJjZSwgdW5rbm93biwgZmxvb3IsIG5vdyk7XG4gIH1cblxuICBjb25zdCB2ZXJkaWN0cyA9IGhpc3RvcnkubWFwKChjYW5kaWRhdGUpID0+XG4gICAgZXZhbHVhdGVSZWxlYXNlQWdlKHNvdXJjZSwgY2FuZGlkYXRlLCBmbG9vciwgbm93KVxuICApO1xuICBjb25zdCBuZXdlc3QgPSB2ZXJkaWN0c1swXSE7XG4gIGNvbnN0IGNsZWFyZWQgPSB2ZXJkaWN0cy5maW5kKCh2ZXJkaWN0KSA9PiB2ZXJkaWN0LmVsaWdpYmxlKTtcbiAgaWYgKCFjbGVhcmVkKSByZXR1cm4gbmV3ZXN0O1xuICBpZiAoY2xlYXJlZCA9PT0gbmV3ZXN0KSByZXR1cm4gY2xlYXJlZDtcbiAgcmV0dXJuIHtcbiAgICAuLi5jbGVhcmVkLFxuICAgIHJlYXNvbjogYCR7Y2xlYXJlZC5yZWFzb259IEl0IGlzIHRoZSBuZXdlc3QgcmVsZWFzZSBwYXN0IHRoZSB3aW5kb3cg4oCUIGAgK1xuICAgICAgYCR7bmV3ZXN0LnZlcnNpb259IGlzIHN0aWxsIGluc2lkZSBpdC5gLFxuICB9O1xufVxuXG4vKipcbiAqIFRydWUgd2hlbiBhbiBhc3NldCBuYW1lIG1hcmtzIHRoZSByZWxlYXNlIGFzIGEgKipiaW5hcnkqKiBgZ2hgIGV4dGVuc2lvblxuICogKElzc3VlICMzOTUyKSDigJQgc2VlIHtAbGluayBCSU5BUllfQVNTRVRfU1VGRklYfS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQmluYXJ5RXh0ZW5zaW9uQXNzZXQobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBCSU5BUllfQVNTRVRfU1VGRklYLnRlc3QobmFtZS50cmltKCkpO1xufVxuXG4vKipcbiAqIFBhcnNlIHRoZSBwcmVmaXhlZCBsaW5lcyBlbWl0dGVkIGJ5IHRoZSBleHRlbnNpb24gcmVsZWFzZSBsb29rdXBcbiAqIChJc3N1ZSAjMzk1MikuXG4gKlxuICogVGhlIGAtLWpxYCBmaWx0ZXIgZW1pdHMgb25lIGByZWxlYXNlIDx0YWc+IDxwdWJsaXNoZWRfYXQ+YCBsaW5lIGZvbGxvd2VkIGJ5XG4gKiBhbiBgYXNzZXQgPG5hbWU+YCBsaW5lIHBlciB1cGxvYWRlZCBhc3NldC4gUHJlZml4ZXMga2VlcCB0aGUgcHJvamVjdGlvblxuICogdW5hbWJpZ3VvdXMgd2hlbiBgZ2hgIGludGVybGVhdmVzIGRpYWdub3N0aWNzIG9uIHN0ZGVycjsgYSByZXBvc2l0b3J5IHdpdGhcbiAqIG5vIHJlbGVhc2UgYXQgYWxsIGV4aXRzIG5vbi16ZXJvIGFuZCBuZXZlciByZWFjaGVzIHRoaXMgcGFyc2VyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VHaEV4dGVuc2lvblJlbGVhc2Uob3V0cHV0OiBzdHJpbmcpOiBHaEV4dGVuc2lvblJlbGVhc2Uge1xuICBjb25zdCByZWxlYXNlOiBHaEV4dGVuc2lvblJlbGVhc2UgPSB7XG4gICAgdGFnOiBudWxsLFxuICAgIHB1Ymxpc2hlZEF0OiBudWxsLFxuICAgIGFzc2V0czogW10sXG4gIH07XG4gIGNvbnN0IHJlbGVhc2VMaW5lID0gbmV3IFJlZ0V4cChgXnJlbGVhc2VcXFxccysoXFxcXFMrKVxcXFxzKygke0lTT19JTlNUQU5UfSkkYCk7XG4gIGZvciAoY29uc3QgbGluZSBvZiBvdXRwdXQuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCB0cmltbWVkID0gbGluZS50cmltKCk7XG4gICAgY29uc3QgbWF0Y2ggPSB0cmltbWVkLm1hdGNoKHJlbGVhc2VMaW5lKTtcbiAgICBpZiAobWF0Y2ggJiYgIXJlbGVhc2UudGFnKSB7XG4gICAgICByZWxlYXNlLnRhZyA9IG1hdGNoWzFdITtcbiAgICAgIHJlbGVhc2UucHVibGlzaGVkQXQgPSBtYXRjaFsyXSE7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHRyaW1tZWQuc3RhcnRzV2l0aChcImFzc2V0IFwiKSkge1xuICAgICAgY29uc3QgbmFtZSA9IHRyaW1tZWQuc2xpY2UoXCJhc3NldCBcIi5sZW5ndGgpLnRyaW0oKTtcbiAgICAgIGlmIChuYW1lKSByZWxlYXNlLmFzc2V0cy5wdXNoKG5hbWUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVsZWFzZTtcbn1cblxuLyoqXG4gKiBQYXJzZSB0aGUgYDxzaGE+IDxjb21taXQgZGF0ZT5gIGxpbmUgZW1pdHRlZCBieSB0aGUgY29tbWl0cyBsb29rdXBcbiAqIChJc3N1ZSAjMzk1MikuXG4gKlxuICogT25seSBhIGZ1bGwgNDAtY2hhcmFjdGVyIHNoYSBpcyBhY2NlcHRlZCwgc28gYSBzdHJheSBkaWFnbm9zdGljIGxpbmUgY2Fubm90XG4gKiBiZSBtaXN0YWtlbiBmb3IgYSByZWYgdGhhdCB3b3VsZCB0aGVuIGJlIGluc3RhbGxlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlR2hDb21taXRMaW5lKFxuICBvdXRwdXQ6IHN0cmluZyxcbik6IHsgc2hhOiBzdHJpbmcgfCBudWxsOyBjb21taXR0ZWRBdDogc3RyaW5nIHwgbnVsbCB9IHtcbiAgY29uc3QgY29tbWl0TGluZSA9IG5ldyBSZWdFeHAoYF4oXFxcXFMrKVxcXFxzKygke0lTT19JTlNUQU5UfSkkYCk7XG4gIGZvciAoY29uc3QgbGluZSBvZiBvdXRwdXQuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBtYXRjaCA9IGxpbmUudHJpbSgpLm1hdGNoKGNvbW1pdExpbmUpO1xuICAgIGlmIChtYXRjaCAmJiBTSEFfUEFUVEVSTi50ZXN0KG1hdGNoWzFdISkpIHtcbiAgICAgIHJldHVybiB7IHNoYTogbWF0Y2hbMV0hLCBjb21taXR0ZWRBdDogbWF0Y2hbMl0hIH07XG4gICAgfVxuICB9XG4gIHJldHVybiB7IHNoYTogbnVsbCwgY29tbWl0dGVkQXQ6IG51bGwgfTtcbn1cblxuLyoqXG4gKiBQYXJzZSB0aGUgZGVmYXVsdCBicmFuY2ggbmFtZSBlbWl0dGVkIGJ5IHRoZSByZXBvc2l0b3J5IGxvb2t1cFxuICogKElzc3VlICMzOTUyKS5cbiAqXG4gKiBUaGUgbmFtZSBpcyBpbnRlcnBvbGF0ZWQgaW50byBhbiBBUEkgcGF0aCwgc28gb25seSBhIGJyYW5jaC1zaGFwZWQgdG9rZW4gaXNcbiAqIGFjY2VwdGVkIOKAlCBhIHRyYXZlcnNhbC1zaGFwZWQgdmFsdWUgeWllbGRzIG51bGwgYW5kIHRoZSBsb29rdXAgaXMgYWJhbmRvbmVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VHaERlZmF1bHRCcmFuY2gob3V0cHV0OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgZm9yIChjb25zdCBsaW5lIG9mIG91dHB1dC5zcGxpdChcIlxcblwiKSkge1xuICAgIGNvbnN0IGJyYW5jaCA9IGxpbmUudHJpbSgpO1xuICAgIGlmICghYnJhbmNoIHx8IGJyYW5jaC5pbmNsdWRlcyhcIi4uXCIpKSBjb250aW51ZTtcbiAgICBpZiAoQlJBTkNIX1BBVFRFUk4udGVzdChicmFuY2gpKSByZXR1cm4gYnJhbmNoO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIEV4dHJhY3QgdGhlIG5ld2VzdCBwdWJsaXNoZWQgdmVyc2lvbiBmcm9tIG5wbSByZWdpc3RyeSBtZXRhZGF0YS5cbiAqXG4gKiBSZWFkcyBgZGlzdC10YWdzLmxhdGVzdGAgYW5kIGl0cyBlbnRyeSBpbiB0aGUgYHRpbWVgIG1hcCwgd2hpY2ggaXMgd2hhdFxuICogYGNsYXVkZSB1cGRhdGVgIHdvdWxkIGluc3RhbGwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZU5wbUxhdGVzdChib2R5OiB1bmtub3duKTogUmVsZWFzZUNhbmRpZGF0ZSB7XG4gIGlmICghYm9keSB8fCB0eXBlb2YgYm9keSAhPT0gXCJvYmplY3RcIikge1xuICAgIHJldHVybiB7IHZlcnNpb246IG51bGwsIHB1Ymxpc2hlZEF0OiBudWxsIH07XG4gIH1cbiAgY29uc3QgcmVjb3JkID0gYm9keSBhcyB7XG4gICAgXCJkaXN0LXRhZ3NcIj86IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRpbWU/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgfTtcbiAgY29uc3QgbGF0ZXN0ID0gcmVjb3JkW1wiZGlzdC10YWdzXCJdPy5bXCJsYXRlc3RcIl07XG4gIGlmICh0eXBlb2YgbGF0ZXN0ICE9PSBcInN0cmluZ1wiIHx8ICFsYXRlc3QpIHtcbiAgICByZXR1cm4geyB2ZXJzaW9uOiBudWxsLCBwdWJsaXNoZWRBdDogbnVsbCB9O1xuICB9XG4gIGNvbnN0IHB1Ymxpc2hlZCA9IHJlY29yZC50aW1lPy5bbGF0ZXN0XTtcbiAgcmV0dXJuIHtcbiAgICB2ZXJzaW9uOiBsYXRlc3QsXG4gICAgcHVibGlzaGVkQXQ6IHR5cGVvZiBwdWJsaXNoZWQgPT09IFwic3RyaW5nXCIgPyBwdWJsaXNoZWQgOiBudWxsLFxuICB9O1xufVxuXG4vKipcbiAqIEV2ZXJ5IGluc3RhbGxhYmxlIHN0YWJsZSByZWxlYXNlIHRoZSBucG0gcGFja3VtZW50IG5hbWVzLCBuZXdlc3QgcHVibGlzaFxuICogZmlyc3QgKElzc3VlICM3MjYpLlxuICpcbiAqIGBkaXN0LXRhZ3MubGF0ZXN0YCBhbG9uZSBhbnN3ZXJzIHdoYXQgYW4gdXBncmFkZSB3b3VsZCBhZG9wdCwgYnV0IGEgY2FsbGVyXG4gKiB0aGF0IG11c3QgbmFtZSBhbiAqaW5zdGFsbGFibGUqIHZlcnNpb24gbmVlZHMgdGhlIHJlbGVhc2VzIGJlaGluZCBpdCB0b28sIHNvXG4gKiB0aGUgd2hvbGUgYHRpbWVgIG1hcCBpcyByZWFkLiBBIHZlcnNpb24gaXMgYSBjYW5kaWRhdGUgb25seSB3aGVuIGl0IGlzXG4gKiBzdGlsbCBwdWJsaXNoZWQgKHByZXNlbnQgaW4gYHZlcnNpb25zYCksIGNhcnJpZXMgYSBwbGFpbiBgTUFKT1IuTUlOT1IuUEFUQ0hgXG4gKiB3aXRoIG5vIHByZS1yZWxlYXNlIHN1ZmZpeCwgYW5kIHdhcyBwdWJsaXNoZWQgbm8gbGF0ZXIgdGhhbiBgbGF0ZXN0YCDigJQgYVxuICogcHJlLXJlbGVhc2UsIGFuIHVucHVibGlzaGVkIHZlcnNpb24sIG9yIG9uZSBjYXJyeWluZyBhIGRpZmZlcmVudCBkaXN0LXRhZyBpc1xuICogbm90IHNvbWV0aGluZyBgbGF0ZXN0YCBldmVyIG9mZmVyZWQsIHNvIGl0IGlzIG5ldmVyIGEgZmFsbGJhY2suXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZU5wbVZlcnNpb25IaXN0b3J5KGJvZHk6IHVua25vd24pOiBSZWxlYXNlQ2FuZGlkYXRlW10ge1xuICBpZiAoIWJvZHkgfHwgdHlwZW9mIGJvZHkgIT09IFwib2JqZWN0XCIpIHJldHVybiBbXTtcbiAgY29uc3QgcmVjb3JkID0gYm9keSBhcyB7XG4gICAgXCJkaXN0LXRhZ3NcIj86IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRpbWU/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB2ZXJzaW9ucz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICB9O1xuICBjb25zdCBsYXRlc3QgPSByZWNvcmRbXCJkaXN0LXRhZ3NcIl0/LltcImxhdGVzdFwiXTtcbiAgY29uc3QgdGltZSA9IHJlY29yZC50aW1lO1xuICBpZiAodHlwZW9mIGxhdGVzdCAhPT0gXCJzdHJpbmdcIiB8fCAhbGF0ZXN0IHx8ICF0aW1lKSByZXR1cm4gW107XG5cbiAgY29uc3QgbGF0ZXN0UHVibGlzaGVkID0gRGF0ZS5wYXJzZShTdHJpbmcodGltZVtsYXRlc3RdID8/IFwiXCIpKTtcbiAgaWYgKE51bWJlci5pc05hTihsYXRlc3RQdWJsaXNoZWQpKSByZXR1cm4gW107XG5cbiAgY29uc3QgZGF0ZWQ6IHsgY2FuZGlkYXRlOiBSZWxlYXNlQ2FuZGlkYXRlOyBwdWJsaXNoZWRNczogbnVtYmVyIH1bXSA9IFtdO1xuICBmb3IgKGNvbnN0IFt2ZXJzaW9uLCBwdWJsaXNoZWRBdF0gb2YgT2JqZWN0LmVudHJpZXModGltZSkpIHtcbiAgICBpZiAodHlwZW9mIHB1Ymxpc2hlZEF0ICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcbiAgICBpZiAoIVNUQUJMRV9TRU1WRVJfUEFUVEVSTi50ZXN0KHZlcnNpb24pKSBjb250aW51ZTtcbiAgICAvLyBgdGltZWAga2VlcHMgZW50cmllcyBmb3IgdW5wdWJsaXNoZWQgdmVyc2lvbnM7IGB2ZXJzaW9uc2AgZG9lcyBub3QuXG4gICAgaWYgKHJlY29yZC52ZXJzaW9ucyAmJiAhKHZlcnNpb24gaW4gcmVjb3JkLnZlcnNpb25zKSkgY29udGludWU7XG4gICAgY29uc3QgcHVibGlzaGVkTXMgPSBEYXRlLnBhcnNlKHB1Ymxpc2hlZEF0KTtcbiAgICBpZiAoTnVtYmVyLmlzTmFOKHB1Ymxpc2hlZE1zKSB8fCBwdWJsaXNoZWRNcyA+IGxhdGVzdFB1Ymxpc2hlZCkgY29udGludWU7XG4gICAgZGF0ZWQucHVzaCh7IGNhbmRpZGF0ZTogeyB2ZXJzaW9uLCBwdWJsaXNoZWRBdCB9LCBwdWJsaXNoZWRNcyB9KTtcbiAgfVxuICByZXR1cm4gZGF0ZWRcbiAgICAuc29ydCgoYSwgYikgPT4gYi5wdWJsaXNoZWRNcyAtIGEucHVibGlzaGVkTXMpXG4gICAgLm1hcCgoZW50cnkpID0+IGVudHJ5LmNhbmRpZGF0ZSk7XG59XG5cbi8qKiBCdWlsZCB0aGUgbnBtIHJlZ2lzdHJ5IG1ldGFkYXRhIFVSTCBmb3IgYSBwYWNrYWdlIG5hbWUuICovXG5leHBvcnQgZnVuY3Rpb24gbnBtUmVnaXN0cnlVcmwocGtnOiBzdHJpbmcsIGJhc2UgPSBOUE1fUkVHSVNUUllfQkFTRSk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtiYXNlfS8ke3BrZy5yZXBsYWNlQWxsKFwiL1wiLCBcIiUyRlwiKX1gO1xufVxuXG4vKipcbiAqIERlZmF1bHQgbnBtIG1ldGFkYXRhIGZldGNoZXIuIE5ldmVyIHRocm93cyDigJQgYSBuZXR3b3JrLCBwZXJtaXNzaW9uLCBvclxuICogcGFyc2UgZmFpbHVyZSB5aWVsZHMgYHVuZGVmaW5lZGAsIHdoaWNoIHRoZSBnYXRlIHRyZWF0cyBhcyBpbmRldGVybWluYXRlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hOcG1NZXRhZGF0YShwa2c6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4ge1xuICB0cnkge1xuICAgIC8vIElzc3VlICMzNzEwOiBib3VuZGVkIGluIHRpbWUgYW5kIGluIG1lbW9yeSBzbyBhIGh1bmcgb3IgaG9zdGlsZVxuICAgIC8vIHJlZ2lzdHJ5IGNhbm5vdCB3ZWRnZSB0aGUgd29ya2VyLlxuICAgIGNvbnN0IHJlc3AgPSBhd2FpdCBmZXRjaChcbiAgICAgIG5wbVJlZ2lzdHJ5VXJsKHBrZyksXG4gICAgICB3aXRoUmVxdWVzdFRpbWVvdXQoeyBtZXRob2Q6IFwiR0VUXCIgfSwgREVGQVVMVF9GRVRDSF9USU1FT1VUX01TKSxcbiAgICApO1xuICAgIGlmICghcmVzcC5vaykge1xuICAgICAgYXdhaXQgZGlzY2FyZEJvZHkocmVzcCk7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICBjb25zdCBib2R5UmVzdWx0ID0gYXdhaXQgcmVhZFRleHRCb3VuZGVkKHJlc3AsIE1BWF9OUE1fUkVTUE9OU0VfQllURVMpO1xuICAgIGlmICghYm9keVJlc3VsdC5vaykgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShib2R5UmVzdWx0LnZhbHVlKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIG5ld2VzdCBHaXRIdWIgcmVsZWFzZSBmb3IgYG93bmVyL3JlcG9gIHZpYSBgZ2ggYXBpYC5cbiAqXG4gKiBUaGUgcmVwb3NpdG9yeSBuYW1lIGlzIHZhbGlkYXRlZCBhZ2FpbnN0IHtAbGluayBSRVBPX1BBVFRFUk59IGJlZm9yZSBpdCBpc1xuICogaW50ZXJwb2xhdGVkIGludG8gdGhlIEFQSSBwYXRoLCBzbyBhIG1hbGZvcm1lZCB2YWx1ZSBjYW5ub3QgcmVhY2ggYW5cbiAqIHVuaW50ZW5kZWQgZW5kcG9pbnQuIEFueSBmYWlsdXJlIHJlc29sdmVzIHRvIGFuIHVua25vd24gY2FuZGlkYXRlLlxuICovXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlR2l0SHViTGF0ZXN0UmVsZWFzZShcbiAgcmVwbzogc3RyaW5nLFxuICBydW5GbjogUmVsZWFzZUFnZUdhdGVEZXBzW1wicnVuRm5cIl0sXG4pOiBQcm9taXNlPFJlbGVhc2VDYW5kaWRhdGU+IHtcbiAgaWYgKCFSRVBPX1BBVFRFUk4udGVzdChyZXBvKSkgcmV0dXJuIHsgdmVyc2lvbjogbnVsbCwgcHVibGlzaGVkQXQ6IG51bGwgfTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuRm4oW1xuICAgIFwiZ2hcIixcbiAgICBcImFwaVwiLFxuICAgIGByZXBvcy8ke3JlcG99L3JlbGVhc2VzL2xhdGVzdGAsXG4gICAgXCItLWpxXCIsXG4gICAgJy50YWdfbmFtZSArIFwiIFwiICsgLnB1Ymxpc2hlZF9hdCcsXG4gIF0sIFJFTEVBU0VfTE9PS1VQX1RJTUVPVVRfU0VDT05EUyk7XG4gIGlmICghcmVzdWx0Lm9rIHx8IHJlc3VsdC52YWx1ZS5leGl0Q29kZSAhPT0gMCkge1xuICAgIHJldHVybiB7IHZlcnNpb246IG51bGwsIHB1Ymxpc2hlZEF0OiBudWxsIH07XG4gIH1cbiAgcmV0dXJuIHBhcnNlR2hSZWxlYXNlTGluZShyZXN1bHQudmFsdWUub3V0cHV0KTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBwdWJsaXNoZWQgcmVsZWFzZSBoaXN0b3J5IG9mIGBvd25lci9yZXBvYCB2aWEgYGdoIGFwaWBcbiAqIChJc3N1ZSAjNzI2KS5cbiAqXG4gKiBTYW1lIHZhbGlkYXRpb24gYXMgdGhlIHNpbmdsZS1yZWxlYXNlIGxvb2t1cCDigJQgYSBtYWxmb3JtZWQgcmVwb3NpdG9yeSBuZXZlclxuICogcmVhY2hlcyB0aGUgQVBJLiBEcmFmdHMgYW5kIHByZS1yZWxlYXNlcyBhcmUgZmlsdGVyZWQgb3V0IGJ5IHRoZSBwcm9qZWN0aW9uLFxuICogc28gdGhlIGhpc3RvcnkgaG9sZHMgb25seSB0aGUgcmVsZWFzZXMgdGhlIHNlcmllcyBhY3R1YWxseSBwdWJsaXNoZXMuXG4gKlxuICogQSBsb29rdXAgZmFpbHVyZSBpcyByZXR1cm5lZCBhcyBhbiBlcnJvciByYXRoZXIgdGhhbiBhbiBlbXB0eSBoaXN0b3J5XG4gKiAoSXNzdWUgIzE4MjMpOiB0aGUgcXVhcmFudGluZSBnYXRlIHRyZWF0cyBib3RoIGFzIGluZGV0ZXJtaW5hdGUsIGJ1dCB0aGVcbiAqIGFjdGlvbi1waW4gcmVzb2x2ZXIgaGFzIHRvIHNheSAqd2h5KiBpdCBmZWxsIGJhY2sgdG8gdGhlIGNhdGFsb2d1ZSwgYW5kXG4gKiBcInVwc3RyZWFtIHB1Ymxpc2hlcyBubyBzdGFibGUgcmVsZWFzZVwiIGlzIGEgZGlmZmVyZW50IGZhdWx0IGZyb20gXCJ0aGVcbiAqIGxvb2t1cCBkaWQgbm90IHJ1blwiLiBBbiBlbXB0eSBgb2tgIGhpc3RvcnkgbWVhbnMgdXBzdHJlYW0gZ2VudWluZWx5XG4gKiBwdWJsaXNoZWQgbm90aGluZyB0aGlzIHBhcnNlciByZWNvZ25pc2VzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUdpdEh1YlJlbGVhc2VIaXN0b3J5KFxuICByZXBvOiBzdHJpbmcsXG4gIHJ1bkZuOiBSZWxlYXNlQWdlR2F0ZURlcHNbXCJydW5GblwiXSxcbik6IFByb21pc2U8UmVzdWx0PFJlbGVhc2VDYW5kaWRhdGVbXT4+IHtcbiAgaWYgKCFSRVBPX1BBVFRFUk4udGVzdChyZXBvKSkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKGBcIiR7cmVwb31cIiBpcyBub3QgYW4gb3duZXIvcmVwbyBjb29yZGluYXRlYCksXG4gICAgfTtcbiAgfVxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5GbihbXG4gICAgXCJnaFwiLFxuICAgIFwiYXBpXCIsXG4gICAgYHJlcG9zLyR7cmVwb30vcmVsZWFzZXNgLFxuICAgIFwiLS1qcVwiLFxuICAgIFwiLltdIHwgc2VsZWN0KC5kcmFmdCB8IG5vdCkgfCBzZWxlY3QoLnByZXJlbGVhc2UgfCBub3QpIHwgXCIgK1xuICAgICcudGFnX25hbWUgKyBcIiBcIiArIC5wdWJsaXNoZWRfYXQnLFxuICBdLCBSRUxFQVNFX0xPT0tVUF9USU1FT1VUX1NFQ09ORFMpO1xuICBpZiAoIXJlc3VsdC5vaykgcmV0dXJuIHJlc3VsdDtcbiAgaWYgKHJlc3VsdC52YWx1ZS5leGl0Q29kZSAhPT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgZ2ggYXBpIHJlcG9zLyR7cmVwb30vcmVsZWFzZXMgZXhpdGVkICR7cmVzdWx0LnZhbHVlLmV4aXRDb2RlfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBwYXJzZUdoUmVsZWFzZUxpc3RpbmcocmVzdWx0LnZhbHVlLm91dHB1dCkgfTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSByZWYgYSBgZ2hgIGV4dGVuc2lvbiB1cGdyYWRlIHdvdWxkIGFjdHVhbGx5IGluc3RhbGxcbiAqIChJc3N1ZSAjMzk1MikuXG4gKlxuICogYGdoYCBpbnN0YWxscyBhICoqYmluYXJ5KiogZXh0ZW5zaW9uIGZyb20gaXRzIGxhdGVzdCByZWxlYXNlLCBidXQgYVxuICogKipzY3JpcHQqKiBleHRlbnNpb24gYnkgY2xvbmluZyB0aGUgZGVmYXVsdCBicmFuY2gg4oCUIHNvIGRhdGluZyBldmVyeVxuICogZXh0ZW5zaW9uIGJ5IGl0cyBsYXRlc3QgcmVsZWFzZSBsZXQgYSByZXBvc2l0b3J5IHdpdGggYSBzdGFsZSB0YWcgYW5kIGFuXG4gKiBhY3RpdmUgYG1haW5gIGNsZWFyIHRoZSBxdWFyYW50aW5lIHdoaWxlIGluc3RhbGxpbmcgYSB0ZW4tbWludXRlLW9sZCBjb21taXQuXG4gKiBUaGUgY2FuZGlkYXRlIHJldHVybmVkIGhlcmUgaXMgd2hpY2hldmVyIGBnaGAgd291bGQgaW5zdGFsbDogdGhlIHJlbGVhc2UgdGFnXG4gKiBhbmQgaXRzIHB1Ymxpc2ggdGltZSB3aGVuIHRoZSBsYXRlc3QgcmVsZWFzZSBjYXJyaWVzIHBsYXRmb3JtIGJpbmFyaWVzLFxuICogb3RoZXJ3aXNlIHRoZSBkZWZhdWx0IGJyYW5jaCdzIEhFQUQgc2hhIGFuZCBpdHMgY29tbWl0IGRhdGUuIEV2ZXJ5IGZhaWx1cmVcbiAqIHBhdGggeWllbGRzIGFuIHVua25vd24gY2FuZGlkYXRlLCB3aGljaCBibG9ja3MgdGhlIHVwZ3JhZGUuXG4gKlxuICogQ2F2ZWF0IHN0YXRlZCBwbGFpbmx5OiBhIGNvbW1pdCBkYXRlIGlzIHN1cHBsaWVkIGJ5IHdob2V2ZXIgcHVzaGVkIGl0LCB3aGlsZVxuICogYSByZWxlYXNlIGBwdWJsaXNoZWRfYXRgIGlzIHN0YW1wZWQgYnkgR2l0SHViLiBEYXRpbmcgYSBzY3JpcHQgZXh0ZW5zaW9uIGJ5XG4gKiBpdHMgSEVBRCBpcyB0aGVyZWZvcmUgd2Vha2VyIHRoYW4gZGF0aW5nIGEgcmVsZWFzZSDigJQgYnV0IGl0IGlzIHRoZSBkYXRlIG9mXG4gKiB0aGUgYXJ0ZWZhY3QgYWN0dWFsbHkgaW5zdGFsbGVkLCB3aGljaCB0aGUgcmVsZWFzZSBkYXRlIHdhcyBub3QuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVHaEV4dGVuc2lvblJlZihcbiAgcmVwbzogc3RyaW5nLFxuICBydW5GbjogUmVsZWFzZUFnZUdhdGVEZXBzW1wicnVuRm5cIl0sXG4pOiBQcm9taXNlPFJlbGVhc2VDYW5kaWRhdGU+IHtcbiAgY29uc3QgdW5rbm93bjogUmVsZWFzZUNhbmRpZGF0ZSA9IHtcbiAgICB2ZXJzaW9uOiBudWxsLFxuICAgIHB1Ymxpc2hlZEF0OiBudWxsLFxuICAgIHJlZjogbnVsbCxcbiAgfTtcbiAgaWYgKCFSRVBPX1BBVFRFUk4udGVzdChyZXBvKSkgcmV0dXJuIHVua25vd247XG5cbiAgY29uc3QgcmVsZWFzZWQgPSBhd2FpdCBydW5GbihbXG4gICAgXCJnaFwiLFxuICAgIFwiYXBpXCIsXG4gICAgYHJlcG9zLyR7cmVwb30vcmVsZWFzZXMvbGF0ZXN0YCxcbiAgICBcIi0tanFcIixcbiAgICAnXCJyZWxlYXNlIFwiICsgLnRhZ19uYW1lICsgXCIgXCIgKyAucHVibGlzaGVkX2F0LCAnICtcbiAgICAnKC5hc3NldHNbXS5uYW1lIHwgXCJhc3NldCBcIiArIC4pJyxcbiAgXSwgUkVMRUFTRV9MT09LVVBfVElNRU9VVF9TRUNPTkRTKTtcbiAgaWYgKHJlbGVhc2VkLm9rICYmIHJlbGVhc2VkLnZhbHVlLmV4aXRDb2RlID09PSAwKSB7XG4gICAgY29uc3QgcmVsZWFzZSA9IHBhcnNlR2hFeHRlbnNpb25SZWxlYXNlKHJlbGVhc2VkLnZhbHVlLm91dHB1dCk7XG4gICAgaWYgKFxuICAgICAgcmVsZWFzZS50YWcgJiYgcmVsZWFzZS5wdWJsaXNoZWRBdCAmJlxuICAgICAgcmVsZWFzZS5hc3NldHMuc29tZShpc0JpbmFyeUV4dGVuc2lvbkFzc2V0KVxuICAgICkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdmVyc2lvbjogcmVsZWFzZS50YWcucmVwbGFjZSgvXnYvLCBcIlwiKSxcbiAgICAgICAgcHVibGlzaGVkQXQ6IHJlbGVhc2UucHVibGlzaGVkQXQsXG4gICAgICAgIHJlZjogcmVsZWFzZS50YWcsXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIE5vIHBsYXRmb3JtIGJpbmFyaWVzOiBgZ2hgIGNsb25lcyB0aGUgZGVmYXVsdCBicmFuY2gsIHNvIGRhdGUgaXRzIEhFQUQuXG4gIGNvbnN0IHJlcG9NZXRhID0gYXdhaXQgcnVuRm4oW1xuICAgIFwiZ2hcIixcbiAgICBcImFwaVwiLFxuICAgIGByZXBvcy8ke3JlcG99YCxcbiAgICBcIi0tanFcIixcbiAgICBcIi5kZWZhdWx0X2JyYW5jaFwiLFxuICBdLCBSRUxFQVNFX0xPT0tVUF9USU1FT1VUX1NFQ09ORFMpO1xuICBpZiAoIXJlcG9NZXRhLm9rIHx8IHJlcG9NZXRhLnZhbHVlLmV4aXRDb2RlICE9PSAwKSByZXR1cm4gdW5rbm93bjtcbiAgY29uc3QgYnJhbmNoID0gcGFyc2VHaERlZmF1bHRCcmFuY2gocmVwb01ldGEudmFsdWUub3V0cHV0KTtcbiAgaWYgKCFicmFuY2gpIHJldHVybiB1bmtub3duO1xuXG4gIGNvbnN0IGhlYWQgPSBhd2FpdCBydW5GbihbXG4gICAgXCJnaFwiLFxuICAgIFwiYXBpXCIsXG4gICAgYHJlcG9zLyR7cmVwb30vY29tbWl0cy8ke2JyYW5jaH1gLFxuICAgIFwiLS1qcVwiLFxuICAgICcuc2hhICsgXCIgXCIgKyAuY29tbWl0LmNvbW1pdHRlci5kYXRlJyxcbiAgXSwgUkVMRUFTRV9MT09LVVBfVElNRU9VVF9TRUNPTkRTKTtcbiAgaWYgKCFoZWFkLm9rIHx8IGhlYWQudmFsdWUuZXhpdENvZGUgIT09IDApIHJldHVybiB1bmtub3duO1xuICBjb25zdCB7IHNoYSwgY29tbWl0dGVkQXQgfSA9IHBhcnNlR2hDb21taXRMaW5lKGhlYWQudmFsdWUub3V0cHV0KTtcbiAgaWYgKCFzaGEgfHwgIWNvbW1pdHRlZEF0KSByZXR1cm4gdW5rbm93bjtcbiAgcmV0dXJuIHsgdmVyc2lvbjogc2hhLnNsaWNlKDAsIDEyKSwgcHVibGlzaGVkQXQ6IGNvbW1pdHRlZEF0LCByZWY6IHNoYSB9O1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSByZWxlYXNlLWFnZSBnYXRlIHVzZWQgYmVmb3JlIGV2ZXJ5IHRvb2xjaGFpbiB1cGdyYWRlLlxuICpcbiAqIEdpdEh1YiByZWxlYXNlcyBhcmUgcmVzb2x2ZWQgdGhyb3VnaCBgZ2ggYXBpYCAoYXV0aGVudGljYXRlZCwgYW5kIHRoZVxuICogcmVwb3NpdG9yeSdzIHByZWZlcnJlZCBHaXRIdWIgY2xpZW50KTsgbnBtIHJlbGVhc2VzIHRocm91Z2ggdGhlIHB1YmxpY1xuICogcmVnaXN0cnkuIEV2ZXJ5IGZhaWx1cmUgcGF0aCBmdW5uZWxzIGludG8gYW4gaW5kZXRlcm1pbmF0ZSB2ZXJkaWN0LCB3aGljaFxuICogYmxvY2tzIHRoZSB1cGdyYWRlIHJhdGhlciB0aGFuIHNpbGVudGx5IHBlcm1pdHRpbmcgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVSZWxlYXNlQWdlR2F0ZShcbiAgZGVwczogUmVsZWFzZUFnZUdhdGVEZXBzLFxuKTogUmVsZWFzZUFnZUdhdGUge1xuICBjb25zdCBxdWFyYW50aW5lSG91cnMgPSBub3JtYWxpc2VRdWFyYW50aW5lSG91cnMoXG4gICAgZGVwcy5xdWFyYW50aW5lSG91cnMsXG4gICAgZGVwcy53YXJuLFxuICApO1xuICBjb25zdCBub3cgPSBkZXBzLm5vdyA/PyAoKCkgPT4gbmV3IERhdGUoKSk7XG4gIGNvbnN0IGZldGNoTWV0YWRhdGEgPSBkZXBzLmZldGNoTnBtTWV0YWRhdGEgPz8gZmV0Y2hOcG1NZXRhZGF0YTtcblxuICBjb25zdCBjaGVjayA9IGFzeW5jIChjaGFubmVsOiBSZWxlYXNlQ2hhbm5lbCk6IFByb21pc2U8UmVsZWFzZUFnZVZlcmRpY3Q+ID0+IHtcbiAgICBjb25zdCBzb3VyY2UgPSBkZXNjcmliZUNoYW5uZWwoY2hhbm5lbCk7XG4gICAgbGV0IGNhbmRpZGF0ZTogUmVsZWFzZUNhbmRpZGF0ZSA9IHsgdmVyc2lvbjogbnVsbCwgcHVibGlzaGVkQXQ6IG51bGwgfTtcbiAgICB0cnkge1xuICAgICAgaWYgKGNoYW5uZWwua2luZCA9PT0gXCJucG1cIikge1xuICAgICAgICBjYW5kaWRhdGUgPSBOUE1fUEFDS0FHRV9QQVRURVJOLnRlc3QoY2hhbm5lbC5wa2cpXG4gICAgICAgICAgPyBwYXJzZU5wbUxhdGVzdChhd2FpdCBmZXRjaE1ldGFkYXRhKGNoYW5uZWwucGtnKSlcbiAgICAgICAgICA6IGNhbmRpZGF0ZTtcbiAgICAgIH0gZWxzZSBpZiAoY2hhbm5lbC5raW5kID09PSBcImdoLWV4dGVuc2lvblwiKSB7XG4gICAgICAgIGNhbmRpZGF0ZSA9IGF3YWl0IHJlc29sdmVHaEV4dGVuc2lvblJlZihjaGFubmVsLnJlcG8sIGRlcHMucnVuRm4pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY2FuZGlkYXRlID0gYXdhaXQgcmVzb2x2ZUdpdEh1YkxhdGVzdFJlbGVhc2UoY2hhbm5lbC5yZXBvLCBkZXBzLnJ1bkZuKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIEFueSB1bmV4cGVjdGVkIGZhaWx1cmUgc3RheXMgaW5kZXRlcm1pbmF0ZSDigJQgbmV2ZXIgZWxpZ2libGUuXG4gICAgICBjYW5kaWRhdGUgPSB7IHZlcnNpb246IG51bGwsIHB1Ymxpc2hlZEF0OiBudWxsIH07XG4gICAgfVxuICAgIHJldHVybiBldmFsdWF0ZVJlbGVhc2VBZ2Uoc291cmNlLCBjYW5kaWRhdGUsIHF1YXJhbnRpbmVIb3Vycywgbm93KCkpO1xuICB9O1xuXG4gIGNvbnN0IGNoZWNrTmV3ZXN0QWdlZCA9IGFzeW5jIChcbiAgICBjaGFubmVsOiBSZWxlYXNlQ2hhbm5lbCxcbiAgKTogUHJvbWlzZTxSZWxlYXNlQWdlVmVyZGljdD4gPT4ge1xuICAgIC8vIEEgYGdoYCBleHRlbnNpb24gaXMgaW5zdGFsbGVkIGZyb20gZXhhY3RseSBvbmUgcmVmIOKAlCB0aGUgbGF0ZXN0IHJlbGVhc2VcbiAgICAvLyBvciBicmFuY2ggSEVBRCDigJQgc28gdGhlcmUgaXMgbm8gb2xkZXIgcmVsZWFzZSB0byBmYWxsIGJhY2sgdG86IHRoZVxuICAgIC8vIHNpbmdsZS1jYW5kaWRhdGUgdmVyZGljdCBpcyBhbHJlYWR5IHRoZSB3aG9sZSBhbnN3ZXIuXG4gICAgaWYgKGNoYW5uZWwua2luZCA9PT0gXCJnaC1leHRlbnNpb25cIikgcmV0dXJuIGF3YWl0IGNoZWNrKGNoYW5uZWwpO1xuXG4gICAgbGV0IGhpc3Rvcnk6IFJlbGVhc2VDYW5kaWRhdGVbXSA9IFtdO1xuICAgIHRyeSB7XG4gICAgICBpZiAoY2hhbm5lbC5raW5kID09PSBcIm5wbVwiKSB7XG4gICAgICAgIGhpc3RvcnkgPSBOUE1fUEFDS0FHRV9QQVRURVJOLnRlc3QoY2hhbm5lbC5wa2cpXG4gICAgICAgICAgPyBwYXJzZU5wbVZlcnNpb25IaXN0b3J5KGF3YWl0IGZldGNoTWV0YWRhdGEoY2hhbm5lbC5wa2cpKVxuICAgICAgICAgIDogW107XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBsaXN0aW5nID0gYXdhaXQgcmVzb2x2ZUdpdEh1YlJlbGVhc2VIaXN0b3J5KFxuICAgICAgICAgIGNoYW5uZWwucmVwbyxcbiAgICAgICAgICBkZXBzLnJ1bkZuLFxuICAgICAgICApO1xuICAgICAgICAvLyBGYWlsLWNsb3NlZDogYW4gdW5yZWFkYWJsZSBoaXN0b3J5IGlzIGluZGV0ZXJtaW5hdGUsIG5ldmVyIGVsaWdpYmxlLlxuICAgICAgICBoaXN0b3J5ID0gbGlzdGluZy5vayA/IGxpc3RpbmcudmFsdWUgOiBbXTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFNhbWUgZmFpbC1jbG9zZWQgY29udHJhY3QgYXMgYGNoZWNrYDogdW5yZWFkYWJsZSBpcyBub3QgZWxpZ2libGUuXG4gICAgICBoaXN0b3J5ID0gW107XG4gICAgfVxuICAgIHJldHVybiBzZWxlY3ROZXdlc3RBZ2VkKFxuICAgICAgZGVzY3JpYmVDaGFubmVsKGNoYW5uZWwpLFxuICAgICAgaGlzdG9yeSxcbiAgICAgIHF1YXJhbnRpbmVIb3VycyxcbiAgICAgIG5vdygpLFxuICAgICk7XG4gIH07XG5cbiAgcmV0dXJuIHsgcXVhcmFudGluZUhvdXJzLCBjaGVjaywgY2hlY2tOZXdlc3RBZ2VkIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBdUJDLEdBR0QsU0FDRSx3QkFBd0IsRUFDeEIsV0FBVyxFQUNYLGVBQWUsRUFDZixrQkFBa0IsUUFDYixxQkFBcUI7QUFDNUIsU0FBUyxzQkFBc0IsUUFBUSx1QkFBdUI7QUFFOUQsK0VBQStFLEdBQy9FLE9BQU8sTUFBTSxnQ0FBZ0MsR0FBRztBQUVoRCx1REFBdUQsR0FDdkQsT0FBTyxNQUFNLHlCQUF5Qiw0QkFBNEI7QUFFbEUsZ0RBQWdELEdBQ2hELE9BQU8sTUFBTSxzQkFBc0IsVUFBVTtBQUU3QyxnREFBZ0QsR0FDaEQsT0FBTyxNQUFNLG9CQUFvQixnQkFBZ0I7QUFFakQseUNBQXlDLEdBQ3pDLE9B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
// denoCacheMetadata=11093958330036543193,11249677456505245842