/**
 * Trust exclusion sources (Issue #251, parent #234).
 *
 * The derived allowlist excludes the worker's own accounts and, optionally,
 * the members of a named GitHub org team. A failed exclusion fetch is a
 * hard error — never an empty set — so a missing `read:org` scope cannot
 * silently widen trust.
 *
 * Australian English throughout (behaviour, organised, normalised).
 */

import { spawnGh } from "./gh_spawn.ts";
import { normaliseLogin } from "./identity_guard.ts";

/**
 * Known bot-account patterns. Single source of truth for `[bot]` detection
 * (Issue #251). Previously forked across `security.ts` (`BOT_PATTERNS`) and
 * `config_validator.ts` (`KNOWN_NON_SUFFIX_BOTS`).
 */
const BOT_PATTERNS: readonly RegExp[] = [
  /\[bot\]$/,
  /^github-copilot/,
  /^copilot/,
  /^cursor/,
  /^dependabot/,
  /^renovate/,
  /^snyk/,
  /^codecov/,
];

/**
 * Known bot-shaped names that do not carry the `[bot]` suffix.
 * Accepted by `trusted_review_bots` without warning (Issue #1856) and
 * treated as bots by {@link isBotLogin}.
 */
const KNOWN_NON_SUFFIX_BOTS: ReadonlySet<string> = new Set([
  "dependabot",
  "renovate",
  "github-actions",
]);

/** `org/slug` — both halves are required for `orgs/<org>/teams/<slug>/members`. */
const ORG_TEAM_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** GitHub login shape used by `config.ts` for allowed authors. */
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*(\[bot\])?$/;

/** Why a configured team fetch failed. Never paired with a members set. */
export type TeamFetchReason =
  | "http-403"
  | "http-404"
  | "malformed-json"
  | "invalid-slug"
  | "invalid-login"
  | "gh-exit";

/** Structured failure — deliberately has no `members` field. */
export interface TeamFetchError {
  reason: TeamFetchReason;
  message: string;
  status?: number;
}

/**
 * Outcome of {@link fetchTeamMembers}.
 *
 * `members` exists only on a successful fetch. An error result and the
 * "exclusion off" result both omit it so a caller cannot accidentally
 * spread `[]` into exclusions.
 */
export type TeamMemberSet =
  | { ok: true; value: { kind: "off" } }
  | { ok: true; value: { kind: "members"; members: ReadonlySet<string> } }
  | { ok: false; error: TeamFetchError };

/** Reserved for API symmetry with the collaborator-fetch sibling. */
export type FetchTeamMembersDeps = Record<PropertyKey, never>;

/**
 * The single `[bot]`-detection predicate in the worker.
 *
 * True when `login` matches a {@link BOT_PATTERNS} pattern or is a
 * known bot that does not carry the `[bot]` suffix. Comparison is
 * case-insensitive ({@link normaliseLogin}).
 */
export function isBotLogin(login: string): boolean {
  const normalised = normaliseLogin(login);
  if (!normalised) return false;
  if (KNOWN_NON_SUFFIX_BOTS.has(normalised)) return true;
  return BOT_PATTERNS.some((pattern) => pattern.test(normalised));
}

/**
 * Host login plus every `service_accounts` entry, all normalised.
 *
 * Bot-shaped logins among those inputs are included like any other
 * account; callers also apply {@link isBotLogin} to collaborator logins
 * so a `[bot]` account that is not in `service_accounts` is still
 * excluded.
 */
export function resolveStaticExclusions(input: {
  serviceAccounts: readonly string[];
  githubUser: string;
}): Set<string> {
  const exclusions = new Set<string>();
  const add = (login: string | undefined) => {
    const normalised = normaliseLogin(login ?? "");
    if (normalised) exclusions.add(normalised);
  };
  add(input.githubUser);
  for (const account of input.serviceAccounts) {
    add(account);
  }
  return exclusions;
}

/** Extract `(HTTP nnn)` or fall back to 403/404 keywords. */
function parseHttpStatus(message: string): number | null {
  if (!message) return null;
  const match = /\(HTTP (\d{3})\)/.exec(message);
  if (match) return Number(match[1]);
  const lower = message.toLowerCase();
  if (lower.includes("403") || lower.includes("forbidden")) return 403;
  if (lower.includes("404") || lower.includes("not found")) return 404;
  return null;
}

function errorResult(
  reason: TeamFetchReason,
  message: string,
  status?: number,
): TeamMemberSet {
  return { ok: false, error: { reason, message, ...(status ? { status } : {}) } };
}

/**
 * Parse a `gh api --paginate` team-members payload into normalised logins.
 *
 * Accepts one JSON array or concatenated page arrays (`][`). Throws on
 * malformed JSON or a payload that is not an array of objects.
 */
function parseTeamMembers(raw: string): Set<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return new Set();

  const chunks: unknown[] = [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      chunks.push(...parsed);
    } else {
      throw new Error("team members payload is not a JSON array");
    }
  } catch (first) {
    // Concatenated pages: `[{...}][{...}]` is not valid JSON as a whole.
    if (!/\]\s*\[/.test(trimmed)) {
      const message = first instanceof Error ? first.message : String(first);
      throw new TeamMembersParseError(`malformed-json:${message}`);
    }
    for (const piece of trimmed.split(/\]\s*\[/)) {
      const text = piece.startsWith("[") ? piece : `[${piece}`;
      const json = text.endsWith("]") ? text : `${text}]`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TeamMembersParseError(`malformed-json:${message}`);
      }
      if (!Array.isArray(parsed)) {
        throw new TeamMembersParseError(
          "malformed-json:team members page is not a JSON array",
        );
      }
      chunks.push(...parsed);
    }
  }

  const members = new Set<string>();
  for (const entry of chunks) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TeamMembersParseError(
        "malformed-json:team member entry is not an object",
      );
    }
    const login = (entry as { login?: unknown }).login;
    if (typeof login !== "string" || normaliseLogin(login).length === 0) {
      throw new TeamMembersParseError("invalid-login:team member missing login");
    }
    const normalised = normaliseLogin(login);
    if (!USERNAME_PATTERN.test(normalised) && !USERNAME_PATTERN.test(login)) {
      throw new TeamMembersParseError(
        `invalid-login:invalid team member login "${login}"`,
      );
    }
    members.add(normalised);
  }
  return members;
}

class TeamMembersParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamMembersParseError";
  }
}

/**
 * Fetch members of the configured exclusion team.
 *
 * No slug (empty / unset) means team exclusion is off — no `gh` call.
 * A configured slug that cannot be fetched is an error result with no
 * `members` field.
 *
 * @param orgTeamSlug - `org/slug` (e.g. `stSoftwareAU/vibe-workers`).
 * @param _deps - Reserved; tests inject `_setGhSpawnRunner`.
 */
export async function fetchTeamMembers(
  orgTeamSlug: string | undefined | null,
  _deps: FetchTeamMembersDeps = {},
): Promise<TeamMemberSet> {
  const trimmed = (orgTeamSlug ?? "").trim();
  if (!trimmed) {
    return { ok: true, value: { kind: "off" } };
  }
  if (!ORG_TEAM_SLUG.test(trimmed)) {
    return errorResult(
      "invalid-slug",
      `Exclusion team slug must be org/slug (e.g. stSoftwareAU/vibe-workers), got "${trimmed}"`,
    );
  }

  const [org, slug] = trimmed.split("/");
  const path = `orgs/${org}/teams/${slug}/members?per_page=100`;
  const spawned = await spawnGh(["api", "--paginate", path]);
  if (!spawned.success) {
    const detail = spawned.stderr.trim() || spawned.stdout.trim();
    const status = parseHttpStatus(`${spawned.stderr}\n${spawned.stdout}`);
    if (status === 403) {
      return errorResult(
        "http-403",
        `Team fetch 403 for ${trimmed} — token is missing read:org. ${detail}`,
        403,
      );
    }
    if (status === 404) {
      return errorResult(
        "http-404",
        `Team fetch 404 for ${trimmed} — team does not exist. ${detail}`,
        404,
      );
    }
    return errorResult(
      "gh-exit",
      `Team fetch failed for ${trimmed} (exit ${spawned.code}): ${detail}`,
    );
  }

  try {
    const members = parseTeamMembers(spawned.stdout);
    return { ok: true, value: { kind: "members", members } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("invalid-login:")) {
      return errorResult("invalid-login", message.slice("invalid-login:".length));
    }
    if (message.startsWith("malformed-json:")) {
      return errorResult(
        "malformed-json",
        message.slice("malformed-json:".length),
      );
    }
    return errorResult("malformed-json", message);
  }
}
