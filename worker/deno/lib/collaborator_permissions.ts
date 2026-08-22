/**
 * Fetch write/maintain/admin collaborators for one repository (Issue #250).
 *
 * GitHub is the source of truth for authorised authors. This module is the
 * fetch half of that contract: one paginated `gh api` call per repo, reading
 * each collaborator's `permissions` object (not the deprecated `permission`
 * string) and returning only logins that hold `admin`, `maintain`, or `push`
 * (`push` is GitHub's API name for the write role).
 *
 * Fail-loud: every failure mode is an explicit `{ ok: false, reason }` —
 * never an empty or partial success, and never a last-known-good cache.
 * A legitimate empty collaborator list is still an error; the caller cannot
 * make a trust decision from "nobody".
 *
 * This module knows nothing about exclusions, caching, or config. Spawn `gh`
 * only through {@link spawnGh} so the call is counted by `gh_call_metrics.ts`.
 *
 * Australian English throughout (authorised, behaviour, normalise).
 */

import { REPO_SLUG_PATTERN } from "./config.ts";
import { spawnGh } from "./gh_spawn.ts";
import { normaliseLogin } from "./identity_guard.ts";

/**
 * GitHub's collaborators API names the write role `push`. The mapping is
 * pinned so a future API rename cannot silently narrow or widen trust.
 */
export const GITHUB_PUSH_MEANS_WRITE = "write" as const;

/** Authorised collaborator roles returned to callers. */
export type CollaboratorPermission =
  | "admin"
  | "maintain"
  | typeof GITHUB_PUSH_MEANS_WRITE;

/** One authorised collaborator after normalisation and role mapping. */
export interface Collaborator {
  /** Normalised GitHub login (trimmed, lowercased). */
  login: string;
  /** Highest authorised role implied by the `permissions` object. */
  permission: CollaboratorPermission;
}

/** Successful fetch payload — only write/maintain/admin logins. */
export interface CollaboratorSet {
  /** The `owner/repo` slug that was queried. */
  repo: string;
  /** Authorised collaborators, in API order. */
  collaborators: Collaborator[];
}

/** Why a collaborator fetch failed. Callers must handle each reason. */
export type CollaboratorFetchReason =
  | "invalid-repo-slug"
  | "invalid-login"
  | "empty-list"
  | "http-403"
  | "http-404"
  | "gh-failed"
  | "malformed-json";

/** Discriminated outcome of {@link fetchRepoCollaborators}. */
export type CollaboratorFetchResult =
  | { ok: true; value: CollaboratorSet }
  | { ok: false; reason: CollaboratorFetchReason; detail: string };

/**
 * Reserved for callers. This module does not cache, exclude, or consult
 * config — those belong to separate sub-issues of #234.
 */
export type CollaboratorPermissionsDeps = Record<string, never>;

/** Same username pattern `config.ts` applies to `allowed_authors`. */
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*(\[bot\])?$/;

/** Fail a fetch with an explicit reason the caller must handle. */
function fail(
  reason: CollaboratorFetchReason,
  detail: string,
): CollaboratorFetchResult {
  return { ok: false, reason, detail };
}

/**
 * Map GitHub's `permissions` object to the authorised role, or `null` when
 * the entry is triage/pull only.
 *
 * Reads `admin` / `maintain` / `push` only — never the deprecated
 * `permission` string. `push` maps to {@link GITHUB_PUSH_MEANS_WRITE}.
 */
export function roleFromPermissions(
  permissions: Record<string, unknown>,
): CollaboratorPermission | null {
  if (permissions.admin === true) return "admin";
  if (permissions.maintain === true) return "maintain";
  if (permissions.push === true) return GITHUB_PUSH_MEANS_WRITE;
  return null;
}

/**
 * Extract an HTTP status from `gh` stderr/stdout, if present.
 *
 * Accepts both `HTTP 403: …` and `gh: Not Found (HTTP 404)` shapes.
 */
export function parseCollaboratorHttpStatus(text: string): number | null {
  if (!text) return null;
  const paren = /\(HTTP (\d{3})\)/.exec(text);
  if (paren) return Number(paren[1]);
  const bare = /\bHTTP (\d{3})\b/.exec(text);
  if (bare) return Number(bare[1]);
  return null;
}

/**
 * Parse a `gh api --paginate` JSON-array payload.
 *
 * `gh` may emit one merged array or concatenate pages as separate arrays
 * (`][`). Both shapes are accepted. Throws on unreadable input so a
 * malformed response is never reported as "no collaborators".
 */
function parseCollaboratorPages(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Expected a JSON array of collaborators, got ${
          parsed === null ? "null" : typeof parsed
        }`,
      );
    }
    return parsed;
  } catch (first) {
    // Concatenated pages: `[{...}]\n[{...}]` is not valid JSON as a whole.
    if (!/\]\s*\[/.test(trimmed)) {
      throw first instanceof Error ? first : new Error(String(first));
    }
    const out: unknown[] = [];
    for (const chunk of trimmed.split(/\]\s*\[/)) {
      const text = chunk.startsWith("[") ? chunk : `[${chunk}`;
      const json = text.endsWith("]") ? text : `${text}]`;
      const parsed: unknown = JSON.parse(json);
      if (!Array.isArray(parsed)) {
        throw new Error("Expected a JSON array page of collaborators");
      }
      out.push(...parsed);
    }
    return out;
  }
}

/** Narrow an unknown value to a plain object, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return (typeof value === "object" && value !== null && !Array.isArray(value))
    ? value as Record<string, unknown>
    : null;
}

/**
 * Build the `gh api --paginate` argument list for one repo's collaborators.
 *
 * The slug is interpolated only after {@link REPO_SLUG_PATTERN} has accepted
 * it, so an untrusted path cannot reach the API.
 */
export function buildCollaboratorsArgs(repo: string): string[] {
  return [
    "api",
    "--paginate",
    `repos/${repo}/collaborators?affiliation=all&per_page=100`,
  ];
}

/**
 * Fetch write/maintain/admin collaborators for `repo`.
 *
 * Exactly one paginated call chain. Callers handle the discriminated result
 * explicitly — there is no empty-list-on-error path.
 *
 * @param repo - `owner/repo` slug. Rejected up front if it fails
 *   {@link REPO_SLUG_PATTERN}.
 * @param _deps - Reserved. Unused; this module does not cache or exclude.
 */
export async function fetchRepoCollaborators(
  repo: string,
  _deps: CollaboratorPermissionsDeps = {},
): Promise<CollaboratorFetchResult> {
  const slug = (repo ?? "").trim();
  if (!REPO_SLUG_PATTERN.test(slug)) {
    return fail("invalid-repo-slug", `Invalid repository slug "${repo}"`);
  }

  const result = await spawnGh(buildCollaboratorsArgs(slug));
  if (!result.success) {
    const text = `${result.stderr}\n${result.stdout}`;
    const status = parseCollaboratorHttpStatus(text);
    if (status === 403) {
      return fail("http-403", text.trim() || "HTTP 403");
    }
    if (status === 404) {
      return fail("http-404", text.trim() || "HTTP 404");
    }
    return fail(
      "gh-failed",
      `gh command failed (exit ${result.code}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }

  let entries: unknown[];
  try {
    entries = parseCollaboratorPages(result.stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("malformed-json", message);
  }

  const collaborators: Collaborator[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) {
      return fail("malformed-json", "Collaborator entry is not an object");
    }

    const rawLogin = record.login;
    if (typeof rawLogin !== "string") {
      return fail("invalid-login", "Collaborator entry is missing a login");
    }
    const login = normaliseLogin(rawLogin);
    if (!USERNAME_PATTERN.test(login)) {
      return fail("invalid-login", `Invalid collaborator login "${rawLogin}"`);
    }

    const permissions = asRecord(record.permissions);
    if (!permissions) {
      return fail(
        "malformed-json",
        `Collaborator "${rawLogin}" is missing a permissions object`,
      );
    }

    const permission = roleFromPermissions(permissions);
    if (permission === null) continue;
    collaborators.push({ login, permission });
  }

  if (collaborators.length === 0) {
    return fail(
      "empty-list",
      `Repository ${slug} has no write/maintain/admin collaborators`,
    );
  }

  return { ok: true, value: { repo: slug, collaborators } };
}
