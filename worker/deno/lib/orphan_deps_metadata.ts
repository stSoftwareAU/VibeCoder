/**
 * Sanctioned, allow-listed metadata access for the orphan-deps scan
 * (Issue #2906, parent #2902).
 *
 * Every other scan template is **static-evidence-only** — they never
 * contact a registry or the network. The orphan-deps scan is the single
 * deliberate exception: deciding whether a dependency is genuinely
 * orphaned ("last published 4 years ago", "marked deprecated", "source
 * repo archived") needs facts that live in registry / source-host
 * metadata, not in committed files.
 *
 * This module is the **narrow gate** through which that exception is
 * granted. It does three things and nothing else:
 *
 *   1. Enumerates the permitted **read-only metadata** hosts and the
 *      forbidden operations (no install, no lifecycle scripts, no repo
 *      code execution) as documented constants.
 *   2. Enforces an **allow-list** so a lookup can never reach an
 *      arbitrary host. A registry / source-repo URL taken verbatim from
 *      an **untrusted manifest** is validated against the allow-list
 *      before it is ever dereferenced (SSRF / prompt-steering guard —
 *      manifests are untrusted input).
 *   3. Performs the lookups behind a single GET-only `fetch` primitive,
 *      with the `fetch` implementation injectable so the whole module is
 *      unit-tested with a stub and never touches the real network.
 *
 * The sanction is **scoped to this module**: the sibling templates
 * (`security_scan`, `supply_chain_readiness`, `supply_chain_detection`,
 * `best_practices`, `github_actions_audit`) keep their static-evidence-only
 * rule unchanged — nothing here is imported by them.
 *
 * Pure and side-effect-free apart from the injected `fetch`. Australian
 * English spelling used throughout (behaviour, organisation, authorised).
 */

import type { Result } from "../types.ts";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  discardBody,
  readTextBounded,
  withRequestTimeout,
} from "./bounded_fetch.ts";

// ---------------------------------------------------------------------------
// The allow-list — the complete, enumerated set of sanctioned operations
// ---------------------------------------------------------------------------

/**
 * Permitted **metadata HTTP hosts**. A read-only HTTPS GET of a JSON
 * metadata document on one of these hosts is the *only* network access
 * the orphan-deps scan may make. Anything outside this list is rejected.
 *
 * - `registry.npmjs.org` — npm package metadata: the `deprecated` flag,
 *   `time` (publish dates), `dist-tags`, and the declared `repository`.
 * - `jsr.io` — JSR package metadata: yanked / archived status and
 *   last-publish time.
 * - `crates.io` — crate metadata (where a `Cargo.toml` is present):
 *   `yanked`, last-version date, and the source repository.
 * - `api.osv.dev` — OSV advisory lookups for declared EOL / withdrawn
 *   packages.
 * - `endoflife.date` — published end-of-life / end-of-support lifecycle
 *   facts for a runtime or framework dependency.
 *
 * GitHub *repository* metadata (`archived`, `pushed_at`) is read through
 * the authenticated `gh api` CLI, **not** a raw fetch — see
 * {@link githubRepoApiArgs} — so `api.github.com` is deliberately absent
 * from this fetch allow-list.
 */
export const ORPHAN_DEPS_METADATA_HOSTS = [
  "registry.npmjs.org",
  "jsr.io",
  "crates.io",
  "api.osv.dev",
  "endoflife.date",
] as const;

/**
 * Permitted **source-repository hosts**. A `repository` URL declared in
 * an (untrusted) manifest is only dereferenced — and then only via the
 * authenticated `gh api` path — when it points at one of these hosts.
 */
export const ORPHAN_DEPS_SOURCE_REPO_HOSTS = ["github.com"] as const;

/**
 * The forbidden-operation catalogue, documented so the prohibition is a
 * single source of truth shared by the helper, the prompt, and any
 * future native detector. Metadata reads only — never any of these.
 */
export const ORPHAN_DEPS_FORBIDDEN_OPERATIONS = [
  "npm install",
  "npm ci",
  "pnpm install",
  "yarn",
  "yarn install",
  "deno cache",
  "cargo build",
  "cargo fetch",
  "cargo install",
  "pip install",
  "go get",
  "go install",
  "mvn",
  "gradle",
  "bundle install",
  // Lifecycle scripts shipped by a dependency:
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "build.rs",
  "setup.py",
] as const;

/** The only HTTP method the metadata gate permits. */
export const ORPHAN_DEPS_ALLOWED_METHOD = "GET" as const;

// ---------------------------------------------------------------------------
// Allow-list enforcement (SSRF / prompt-steering guard)
// ---------------------------------------------------------------------------

/** True when `host` is exactly one of the sanctioned metadata hosts. */
export function isAllowedMetadataHost(host: string): boolean {
  return (ORPHAN_DEPS_METADATA_HOSTS as readonly string[]).includes(
    host.toLowerCase(),
  );
}

/**
 * Validate a candidate metadata URL against the allow-list.
 *
 * A URL is accepted only when it parses, uses the `https:` scheme, and
 * its host is an exact member of {@link ORPHAN_DEPS_METADATA_HOSTS}.
 * Userinfo (`user:pass@`) and non-default ports are rejected outright —
 * both are classic SSRF / credential-smuggling vectors and no sanctioned
 * registry needs them.
 *
 * Returns the parsed {@link URL} on success so the caller does not
 * re-parse.
 */
export function assertAllowedMetadataUrl(
  rawUrl: string,
): Result<URL, Error> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      error: new Error(`orphan-deps metadata: unparseable URL ${rawUrl}`),
    };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: refusing non-HTTPS URL ${rawUrl} ` +
          `(scheme ${url.protocol})`,
      ),
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: refusing URL with embedded credentials`,
      ),
    };
  }
  if (url.port !== "") {
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: refusing URL with explicit port ${url.port}`,
      ),
    };
  }
  if (!isAllowedMetadataHost(url.hostname)) {
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: host ${url.hostname} is not on the ` +
          `allow-list (${ORPHAN_DEPS_METADATA_HOSTS.join(", ")})`,
      ),
    };
  }
  return { ok: true, value: url };
}

/** Convenience boolean form of {@link assertAllowedMetadataUrl}. */
export function isAllowedMetadataUrl(rawUrl: string): boolean {
  return assertAllowedMetadataUrl(rawUrl).ok;
}

/** Strict `owner` / `repo` path-segment shape for a GitHub slug. */
const GITHUB_SLUG_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parse and validate a source-repository URL taken **verbatim from an
 * untrusted manifest** before it is dereferenced.
 *
 * Manifests are untrusted input, so a `repository` field could carry an
 * attacker-controlled URL (SSRF) or a path crafted to escape into a
 * different `gh api` route. This guard accepts the URL only when it
 * points at a {@link ORPHAN_DEPS_SOURCE_REPO_HOSTS} host and yields a
 * clean `owner/repo` pair (each a single, well-formed path segment), with
 * any `.git` suffix and trailing slash stripped. Everything else is
 * rejected.
 */
export function validateSourceRepoUrl(
  rawUrl: string,
): Result<{ owner: string; repo: string }, Error> {
  let url: URL;
  try {
    // Normalise common `git+https://`, `git://`, and `git@` forms to a
    // plain https URL so the host/path checks below see a single shape.
    url = new URL(normaliseGitUrl(rawUrl));
  } catch {
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: unparseable source-repo URL ${rawUrl}`,
      ),
    };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: refusing non-HTTPS source-repo URL ${rawUrl}`,
      ),
    };
  }
  if (
    !(ORPHAN_DEPS_SOURCE_REPO_HOSTS as readonly string[]).includes(
      url.hostname.toLowerCase(),
    )
  ) {
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: source-repo host ${url.hostname} is not on ` +
          `the allow-list (${ORPHAN_DEPS_SOURCE_REPO_HOSTS.join(", ")})`,
      ),
    };
  }
  const segments = url.pathname.replace(/\.git$/, "").split("/").filter(
    (s) => s.length > 0,
  );
  if (segments.length !== 2) {
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: source-repo URL ${rawUrl} is not a clean ` +
          `owner/repo path`,
      ),
    };
  }
  const owner = segments[0] ?? "";
  const repo = segments[1] ?? "";
  if (!GITHUB_SLUG_SEGMENT.test(owner) || !GITHUB_SLUG_SEGMENT.test(repo)) {
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: source-repo owner/repo "${owner}/${repo}" ` +
          `contains invalid characters`,
      ),
    };
  }
  return { ok: true, value: { owner, repo } };
}

/** Strip `git+`, `git://`, and scp-style `git@host:owner/repo` wrappers. */
function normaliseGitUrl(rawUrl: string): string {
  let u = rawUrl.trim();
  if (u.startsWith("git+")) u = u.slice("git+".length);
  // scp-style `git@github.com:owner/repo.git` → `https://github.com/owner/repo.git`
  const scp = u.match(/^git@([^:]+):(.+)$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  if (u.startsWith("git://")) u = `https://${u.slice("git://".length)}`;
  if (u.startsWith("ssh://git@")) u = `https://${u.slice("ssh://git@".length)}`;
  return u;
}

// ---------------------------------------------------------------------------
// URL builders for the sanctioned metadata documents
// ---------------------------------------------------------------------------

/**
 * npm registry metadata URL. Scoped names (`@scope/name`) keep the
 * `@scope/name` path form; only the embedded slash is percent-encoded
 * (mirrors {@link ../npm_package_age.ts}).
 */
export function npmMetadataUrl(pkg: string): string {
  return `https://registry.npmjs.org/${pkg.replaceAll("/", "%2F")}`;
}

/** JSR metadata document URL for `@scope/name`. */
export function jsrMetadataUrl(scope: string, name: string): string {
  const s = scope.startsWith("@") ? scope.slice(1) : scope;
  return `https://jsr.io/@${encodeURIComponent(s)}/${
    encodeURIComponent(name)
  }/meta.json`;
}

/** crates.io metadata document URL for a crate. */
export function cratesMetadataUrl(crate: string): string {
  return `https://crates.io/api/v1/crates/${encodeURIComponent(crate)}`;
}

/** endoflife.date lifecycle document URL for a product. */
export function endoflifeUrl(product: string): string {
  return `https://endoflife.date/api/${encodeURIComponent(product)}.json`;
}

/**
 * Build the argument vector for an authenticated `gh api` read of a
 * GitHub repository's metadata. The `owner`/`repo` pair MUST already
 * have been validated (e.g. via {@link validateSourceRepoUrl}); this
 * re-checks defensively and refuses to build a path from anything that
 * is not a clean slug segment, so a crafted manifest value can never
 * smuggle extra path or query into the `gh api` route.
 */
export function githubRepoApiArgs(
  owner: string,
  repo: string,
): Result<string[], Error> {
  if (!GITHUB_SLUG_SEGMENT.test(owner) || !GITHUB_SLUG_SEGMENT.test(repo)) {
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: invalid gh api repo slug "${owner}/${repo}"`,
      ),
    };
  }
  return {
    ok: true,
    value: [
      "api",
      `repos/${owner}/${repo}`,
      "--jq",
      "{archived: .archived, pushed_at: .pushed_at, html_url: .html_url}",
    ],
  };
}

// ---------------------------------------------------------------------------
// The single GET-only network primitive
// ---------------------------------------------------------------------------

/** Injectable side-effects for {@link fetchAllowedMetadata}. */
export interface MetadataFetchDeps {
  /**
   * `fetch` implementation. Defaults to the global `fetch`. Tests inject
   * a stub so no real network request is made.
   */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Fetch a sanctioned metadata document.
 *
 * Enforces, in order: the URL is on the allow-list (rejecting any host
 * outside {@link ORPHAN_DEPS_METADATA_HOSTS} — the SSRF guard), and the
 * request is a read-only `GET` (the gate never issues a method that
 * could install, publish, or mutate). The response body is parsed as
 * JSON. Never throws — a disallowed URL, a network/permission failure, a
 * non-2xx status, or unparseable JSON all surface as `ok: false`.
 *
 * This is the *only* side-effecting primitive in the module. There is no
 * subprocess / package-manager invocation anywhere here, which is how the
 * "no install, ever; no lifecycle scripts" guarantee holds: the helper
 * physically cannot run a command.
 */
export async function fetchAllowedMetadata(
  rawUrl: string,
  deps: MetadataFetchDeps = {},
): Promise<Result<unknown, Error>> {
  const allowed = assertAllowedMetadataUrl(rawUrl);
  if (!allowed.ok) return allowed;

  const fetchFn = deps.fetchFn ??
    ((url, init) => fetch(url, init));

  let resp: Response;
  try {
    // Issue #3710: bounded in time so a hung metadata host cannot wedge
    // the scan.
    resp = await fetchFn(
      allowed.value.toString(),
      withRequestTimeout({
        method: ORPHAN_DEPS_ALLOWED_METHOD,
        redirect: "error",
        headers: { "accept": "application/json" },
      }, DEFAULT_FETCH_TIMEOUT_MS),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: fetch of ${rawUrl} failed — ${message}`,
      ),
    };
  }
  if (!resp.ok) {
    await discardBody(resp);
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: ${rawUrl} returned HTTP ${resp.status}`,
      ),
    };
  }
  // Issue #3710: bounded in memory — an oversized document fails loud.
  const bodyResult = await readTextBounded(resp);
  if (!bodyResult.ok) {
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: ${rawUrl} body read failed — ${bodyResult.error}`,
      ),
    };
  }
  try {
    return { ok: true, value: JSON.parse(bodyResult.value) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `orphan-deps metadata: ${rawUrl} body is not JSON — ${message}`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// Forbidden-operation guard (defence-in-depth for callers)
// ---------------------------------------------------------------------------

/**
 * Classify a candidate shell command / argv as a forbidden scan
 * operation (a package install, lifecycle script, or any repo-code
 * execution that ships a dependency's own code). Returns true when the
 * command must NOT be run as part of an orphan-deps scan.
 *
 * The metadata gate already makes installs unreachable through this
 * module; this guard is defence-in-depth so a future native detector can
 * reject such a command explicitly rather than relying on absence.
 */
export function isForbiddenScanOperation(command: string | string[]): boolean {
  const text = (Array.isArray(command) ? command.join(" ") : command)
    .toLowerCase();
  return ORPHAN_DEPS_FORBIDDEN_OPERATIONS.some((op) => text.includes(op));
}
