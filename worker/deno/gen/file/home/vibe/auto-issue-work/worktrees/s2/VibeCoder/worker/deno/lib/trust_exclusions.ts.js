/**
 * Trust exclusion sources (Issue #251, parent #234).
 *
 * The derived allowlist excludes the worker's own accounts and, optionally,
 * the members of a named GitHub org team. A failed exclusion fetch is a
 * hard error — never an empty set — so a missing `read:org` scope cannot
 * silently widen trust.
 *
 * Australian English throughout (behaviour, organised, normalised).
 */ import { spawnGh } from "./gh_spawn.ts";
import { normaliseLogin } from "./identity_guard.ts";
import { parseJsonArrayPages } from "./json_array_pages.ts";
/** The only shape GitHub itself guarantees is a bot: the `[bot]` suffix. */ const BOT_SUFFIX = /\[bot\]$/;
/**
 * Known bot-account patterns. Single source of truth for `[bot]` detection
 * (Issue #251). Previously forked across `security.ts` (`BOT_PATTERNS`) and
 * `config_validator.ts` (`KNOWN_NON_SUFFIX_BOTS`).
 *
 * All but the first are **prefix** matches, so `cursorjoe` and `snyked` read
 * as bots here. That is deliberate for the trust paths this list serves —
 * over-detecting a bot only withholds trust — but it must never decide
 * whether the worker takes over a PR. Use
 * {@link isBotAuthorForMaintenance} for that (Issue #1872).
 */ const BOT_PATTERNS = [
  BOT_SUFFIX,
  /^github-copilot/,
  /^copilot/,
  /^cursor/,
  /^dependabot/,
  /^renovate/,
  /^snyk/,
  /^codecov/
];
/**
 * Known bot-shaped names that do not carry the `[bot]` suffix.
 * Accepted by `trusted_review_bots` without warning (Issue #1856) and
 * treated as bots by {@link isBotLogin}.
 */ const KNOWN_NON_SUFFIX_BOTS = new Set([
  "dependabot",
  "renovate",
  "github-actions"
]);
/** `org/slug` — both halves are required for `orgs/<org>/teams/<slug>/members`. */ const ORG_TEAM_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** GitHub login shape used by `config.ts` for allowed authors. */ const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*(\[bot\])?$/;
/**
 * The single `[bot]`-detection predicate in the worker.
 *
 * True when `login` matches a {@link BOT_PATTERNS} pattern or is a
 * known bot that does not carry the `[bot]` suffix. Comparison is
 * case-insensitive ({@link normaliseLogin}).
 */ export function isBotLogin(login) {
  const normalised = normaliseLogin(login);
  if (!normalised) return false;
  if (KNOWN_NON_SUFFIX_BOTS.has(normalised)) return true;
  return BOT_PATTERNS.some((pattern)=>pattern.test(normalised));
}
/**
 * The admission-grade bot predicate: may the worker take this PR over?
 *
 * Admission is not a trust question, it is an ownership one. A scan that
 * admits a PR claims it, pushes fix commits to its head branch, answers its
 * comments and arms auto-merge — so a false positive adopts a human's PR
 * uninvited, the exact outcome `docs/HUMAN-PR-POLICY.md` exists to prevent.
 * {@link isBotLogin}'s prefix patterns cannot carry that weight: they read
 * `cursorjoe` and `snyked` as bots (Issue #1872).
 *
 * This predicate therefore matches only what GitHub itself attests — the
 * `[bot]` suffix — or an exact member of {@link KNOWN_NON_SUFFIX_BOTS}. No
 * prefix ever matches, so a human login is admitted only if it *is* one of
 * those three names. Comparison is case-insensitive
 * ({@link normaliseLogin}).
 *
 * It does not accept the `app/<slug>` spelling `gh pr list --json author`
 * reports for a GitHub App; pass such a login through
 * {@link normaliseGhAppLogin} first (Issue #4719).
 */ export function isBotAuthorForMaintenance(login) {
  const normalised = normaliseLogin(login);
  if (!normalised) return false;
  if (KNOWN_NON_SUFFIX_BOTS.has(normalised)) return true;
  return BOT_SUFFIX.test(normalised);
}
/** `app/<slug>` as `gh pr list --json author` reports a GitHub App author. */ const GH_APP_LOGIN = /^app\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)$/i;
/**
 * Re-spell a `gh`-reported GitHub App author in the REST `<slug>[bot]` form
 * (Issue #4719).
 *
 * `gh pr list --json author` reports a GitHub App as
 * `{"is_bot":true,"login":"app/dependabot"}`, while the REST API and
 * {@link isBotAuthorForMaintenance} use `dependabot[bot]`. A `/` cannot occur
 * in a real user login, so `app/<slug>` is unambiguous. Anything else is
 * returned trimmed and otherwise unchanged.
 *
 * This is representation handling only. It confers no trust: admission still
 * goes through {@link isBotAuthorForMaintenance} plus the cross-repository and
 * fleet checks in `listBotPrs`.
 */ export function normaliseGhAppLogin(login) {
  const trimmed = login.trim();
  const match = GH_APP_LOGIN.exec(trimmed);
  return match ? `${match[1]}[bot]` : trimmed;
}
/**
 * The configuration keys that name the fleet's own GitHub logins.
 *
 * Deliberately not named `VIBE_*`: `vibe_env_registry_test.ts` treats every
 * `VIBE_`-prefixed identifier in the source as an environment variable that
 * must be declared with a role, and this is a config-key list, not an env var.
 */ export const FLEET_LOGIN_CONFIG_KEYS = [
  "service_accounts",
  "fleet_pr_authors"
];
/**
 * The single "these logins are Vibe Coders" set (Issue #1066).
 *
 * The fleet accounts hold write access by necessity — they push branches —
 * so under the collaborator-derived trust rule they would otherwise become
 * authors entitled to direct their own work, which is the exact opposite of
 * the requirement. The exclusion therefore defaults to the fleet login list
 * the configuration already carries (`service_accounts` and
 * `fleet_pr_authors`) plus this host's own login, with no operator action
 * required; `exclusion_team` remains an optional *additional* exclusion for
 * org-team-based setups.
 *
 * Bot-shaped logins among these inputs are included like any other account;
 * callers also apply {@link isBotLogin} to collaborator logins so a `[bot]`
 * account that is named nowhere here is still excluded.
 */ export function resolveVibeCoderLogins(input) {
  const logins = new Set();
  const add = (login)=>{
    const normalised = normaliseLogin(login ?? "");
    if (normalised) logins.add(normalised);
  };
  add(input.githubUser);
  for (const account of input.serviceAccounts)add(account);
  for (const sibling of input.fleetPrAuthors)add(sibling);
  return logins;
}
/** Extract `(HTTP nnn)` or fall back to 403/404 keywords. */ function parseHttpStatus(message) {
  if (!message) return null;
  const match = /\(HTTP (\d{3})\)/.exec(message);
  if (match) return Number(match[1]);
  const lower = message.toLowerCase();
  if (lower.includes("403") || lower.includes("forbidden")) return 403;
  if (lower.includes("404") || lower.includes("not found")) return 404;
  return null;
}
function errorResult(reason, message, status) {
  return {
    ok: false,
    error: {
      reason,
      message,
      ...status ? {
        status
      } : {}
    }
  };
}
/**
 * Parse a `gh api --paginate` team-members payload into normalised logins.
 *
 * Delegates page-boundary scanning to the shared
 * {@link parseJsonArrayPages}, which tracks JSON string state so a page
 * containing `][` inside a string value is not mistaken for a page
 * boundary. Throws {@link TeamMembersParseError} on malformed JSON or a
 * payload that is not an array of objects.
 */ function parseTeamMembers(raw) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return new Set();
  let chunks;
  try {
    chunks = parseJsonArrayPages(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TeamMembersParseError(`malformed-json:${message}`);
  }
  const members = new Set();
  for (const entry of chunks){
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TeamMembersParseError("malformed-json:team member entry is not an object");
    }
    const login = entry.login;
    if (typeof login !== "string" || normaliseLogin(login).length === 0) {
      throw new TeamMembersParseError("invalid-login:team member missing login");
    }
    const normalised = normaliseLogin(login);
    if (!USERNAME_PATTERN.test(normalised) && !USERNAME_PATTERN.test(login)) {
      throw new TeamMembersParseError(`invalid-login:invalid team member login "${login}"`);
    }
    members.add(normalised);
  }
  return members;
}
class TeamMembersParseError extends Error {
  constructor(message){
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
 */ export async function fetchTeamMembers(orgTeamSlug, _deps = {}) {
  const trimmed = (orgTeamSlug ?? "").trim();
  if (!trimmed) {
    return {
      ok: true,
      value: {
        kind: "off"
      }
    };
  }
  if (!ORG_TEAM_SLUG.test(trimmed)) {
    return errorResult("invalid-slug", `Exclusion team slug must be org/slug (e.g. stSoftwareAU/vibe-workers), got "${trimmed}"`);
  }
  const [org, slug] = trimmed.split("/");
  const path = `orgs/${org}/teams/${slug}/members?per_page=100`;
  const spawned = await spawnGh([
    "api",
    "--paginate",
    path
  ]);
  if (!spawned.success) {
    const detail = spawned.stderr.trim() || spawned.stdout.trim();
    const status = parseHttpStatus(`${spawned.stderr}\n${spawned.stdout}`);
    if (status === 403) {
      return errorResult("http-403", `Team fetch 403 for ${trimmed} — token is missing read:org. ${detail}`, 403);
    }
    if (status === 404) {
      return errorResult("http-404", `Team fetch 404 for ${trimmed} — team does not exist. ${detail}`, 404);
    }
    return errorResult("gh-exit", `Team fetch failed for ${trimmed} (exit ${spawned.code}): ${detail}`);
  }
  try {
    const members = parseTeamMembers(spawned.stdout);
    return {
      ok: true,
      value: {
        kind: "members",
        members
      }
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("invalid-login:")) {
      return errorResult("invalid-login", message.slice("invalid-login:".length));
    }
    if (message.startsWith("malformed-json:")) {
      return errorResult("malformed-json", message.slice("malformed-json:".length));
    }
    return errorResult("malformed-json", message);
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi90cnVzdF9leGNsdXNpb25zLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVHJ1c3QgZXhjbHVzaW9uIHNvdXJjZXMgKElzc3VlICMyNTEsIHBhcmVudCAjMjM0KS5cbiAqXG4gKiBUaGUgZGVyaXZlZCBhbGxvd2xpc3QgZXhjbHVkZXMgdGhlIHdvcmtlcidzIG93biBhY2NvdW50cyBhbmQsIG9wdGlvbmFsbHksXG4gKiB0aGUgbWVtYmVycyBvZiBhIG5hbWVkIEdpdEh1YiBvcmcgdGVhbS4gQSBmYWlsZWQgZXhjbHVzaW9uIGZldGNoIGlzIGFcbiAqIGhhcmQgZXJyb3Ig4oCUIG5ldmVyIGFuIGVtcHR5IHNldCDigJQgc28gYSBtaXNzaW5nIGByZWFkOm9yZ2Agc2NvcGUgY2Fubm90XG4gKiBzaWxlbnRseSB3aWRlbiB0cnVzdC5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzZWQsIG5vcm1hbGlzZWQpLlxuICovXG5cbmltcG9ydCB7IHNwYXduR2ggfSBmcm9tIFwiLi9naF9zcGF3bi50c1wiO1xuaW1wb3J0IHsgbm9ybWFsaXNlTG9naW4gfSBmcm9tIFwiLi9pZGVudGl0eV9ndWFyZC50c1wiO1xuaW1wb3J0IHsgcGFyc2VKc29uQXJyYXlQYWdlcyB9IGZyb20gXCIuL2pzb25fYXJyYXlfcGFnZXMudHNcIjtcblxuLyoqIFRoZSBvbmx5IHNoYXBlIEdpdEh1YiBpdHNlbGYgZ3VhcmFudGVlcyBpcyBhIGJvdDogdGhlIGBbYm90XWAgc3VmZml4LiAqL1xuY29uc3QgQk9UX1NVRkZJWCA9IC9cXFtib3RcXF0kLztcblxuLyoqXG4gKiBLbm93biBib3QtYWNjb3VudCBwYXR0ZXJucy4gU2luZ2xlIHNvdXJjZSBvZiB0cnV0aCBmb3IgYFtib3RdYCBkZXRlY3Rpb25cbiAqIChJc3N1ZSAjMjUxKS4gUHJldmlvdXNseSBmb3JrZWQgYWNyb3NzIGBzZWN1cml0eS50c2AgKGBCT1RfUEFUVEVSTlNgKSBhbmRcbiAqIGBjb25maWdfdmFsaWRhdG9yLnRzYCAoYEtOT1dOX05PTl9TVUZGSVhfQk9UU2ApLlxuICpcbiAqIEFsbCBidXQgdGhlIGZpcnN0IGFyZSAqKnByZWZpeCoqIG1hdGNoZXMsIHNvIGBjdXJzb3Jqb2VgIGFuZCBgc255a2VkYCByZWFkXG4gKiBhcyBib3RzIGhlcmUuIFRoYXQgaXMgZGVsaWJlcmF0ZSBmb3IgdGhlIHRydXN0IHBhdGhzIHRoaXMgbGlzdCBzZXJ2ZXMg4oCUXG4gKiBvdmVyLWRldGVjdGluZyBhIGJvdCBvbmx5IHdpdGhob2xkcyB0cnVzdCDigJQgYnV0IGl0IG11c3QgbmV2ZXIgZGVjaWRlXG4gKiB3aGV0aGVyIHRoZSB3b3JrZXIgdGFrZXMgb3ZlciBhIFBSLiBVc2VcbiAqIHtAbGluayBpc0JvdEF1dGhvckZvck1haW50ZW5hbmNlfSBmb3IgdGhhdCAoSXNzdWUgIzE4NzIpLlxuICovXG5jb25zdCBCT1RfUEFUVEVSTlM6IHJlYWRvbmx5IFJlZ0V4cFtdID0gW1xuICBCT1RfU1VGRklYLFxuICAvXmdpdGh1Yi1jb3BpbG90LyxcbiAgL15jb3BpbG90LyxcbiAgL15jdXJzb3IvLFxuICAvXmRlcGVuZGFib3QvLFxuICAvXnJlbm92YXRlLyxcbiAgL15zbnlrLyxcbiAgL15jb2RlY292Lyxcbl07XG5cbi8qKlxuICogS25vd24gYm90LXNoYXBlZCBuYW1lcyB0aGF0IGRvIG5vdCBjYXJyeSB0aGUgYFtib3RdYCBzdWZmaXguXG4gKiBBY2NlcHRlZCBieSBgdHJ1c3RlZF9yZXZpZXdfYm90c2Agd2l0aG91dCB3YXJuaW5nIChJc3N1ZSAjMTg1NikgYW5kXG4gKiB0cmVhdGVkIGFzIGJvdHMgYnkge0BsaW5rIGlzQm90TG9naW59LlxuICovXG5jb25zdCBLTk9XTl9OT05fU1VGRklYX0JPVFM6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcbiAgXCJkZXBlbmRhYm90XCIsXG4gIFwicmVub3ZhdGVcIixcbiAgXCJnaXRodWItYWN0aW9uc1wiLFxuXSk7XG5cbi8qKiBgb3JnL3NsdWdgIOKAlCBib3RoIGhhbHZlcyBhcmUgcmVxdWlyZWQgZm9yIGBvcmdzLzxvcmc+L3RlYW1zLzxzbHVnPi9tZW1iZXJzYC4gKi9cbmNvbnN0IE9SR19URUFNX1NMVUcgPSAvXltBLVphLXowLTlfLi1dK1xcL1tBLVphLXowLTlfLi1dKyQvO1xuXG4vKiogR2l0SHViIGxvZ2luIHNoYXBlIHVzZWQgYnkgYGNvbmZpZy50c2AgZm9yIGFsbG93ZWQgYXV0aG9ycy4gKi9cbmNvbnN0IFVTRVJOQU1FX1BBVFRFUk4gPSAvXlthLXpBLVowLTldW2EtekEtWjAtOV8tXSooXFxbYm90XFxdKT8kLztcblxuLyoqIFdoeSBhIGNvbmZpZ3VyZWQgdGVhbSBmZXRjaCBmYWlsZWQuIE5ldmVyIHBhaXJlZCB3aXRoIGEgbWVtYmVycyBzZXQuICovXG5leHBvcnQgdHlwZSBUZWFtRmV0Y2hSZWFzb24gPVxuICB8IFwiaHR0cC00MDNcIlxuICB8IFwiaHR0cC00MDRcIlxuICB8IFwibWFsZm9ybWVkLWpzb25cIlxuICB8IFwiaW52YWxpZC1zbHVnXCJcbiAgfCBcImludmFsaWQtbG9naW5cIlxuICB8IFwiZ2gtZXhpdFwiO1xuXG4vKiogU3RydWN0dXJlZCBmYWlsdXJlIOKAlCBkZWxpYmVyYXRlbHkgaGFzIG5vIGBtZW1iZXJzYCBmaWVsZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgVGVhbUZldGNoRXJyb3Ige1xuICByZWFzb246IFRlYW1GZXRjaFJlYXNvbjtcbiAgbWVzc2FnZTogc3RyaW5nO1xuICBzdGF0dXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogT3V0Y29tZSBvZiB7QGxpbmsgZmV0Y2hUZWFtTWVtYmVyc30uXG4gKlxuICogYG1lbWJlcnNgIGV4aXN0cyBvbmx5IG9uIGEgc3VjY2Vzc2Z1bCBmZXRjaC4gQW4gZXJyb3IgcmVzdWx0IGFuZCB0aGVcbiAqIFwiZXhjbHVzaW9uIG9mZlwiIHJlc3VsdCBib3RoIG9taXQgaXQgc28gYSBjYWxsZXIgY2Fubm90IGFjY2lkZW50YWxseVxuICogc3ByZWFkIGBbXWAgaW50byBleGNsdXNpb25zLlxuICovXG5leHBvcnQgdHlwZSBUZWFtTWVtYmVyU2V0ID1cbiAgfCB7IG9rOiB0cnVlOyB2YWx1ZTogeyBraW5kOiBcIm9mZlwiIH0gfVxuICB8IHsgb2s6IHRydWU7IHZhbHVlOiB7IGtpbmQ6IFwibWVtYmVyc1wiOyBtZW1iZXJzOiBSZWFkb25seVNldDxzdHJpbmc+IH0gfVxuICB8IHsgb2s6IGZhbHNlOyBlcnJvcjogVGVhbUZldGNoRXJyb3IgfTtcblxuLyoqIFJlc2VydmVkIGZvciBBUEkgc3ltbWV0cnkgd2l0aCB0aGUgY29sbGFib3JhdG9yLWZldGNoIHNpYmxpbmcuICovXG5leHBvcnQgdHlwZSBGZXRjaFRlYW1NZW1iZXJzRGVwcyA9IFJlY29yZDxQcm9wZXJ0eUtleSwgbmV2ZXI+O1xuXG4vKipcbiAqIFRoZSBzaW5nbGUgYFtib3RdYC1kZXRlY3Rpb24gcHJlZGljYXRlIGluIHRoZSB3b3JrZXIuXG4gKlxuICogVHJ1ZSB3aGVuIGBsb2dpbmAgbWF0Y2hlcyBhIHtAbGluayBCT1RfUEFUVEVSTlN9IHBhdHRlcm4gb3IgaXMgYVxuICoga25vd24gYm90IHRoYXQgZG9lcyBub3QgY2FycnkgdGhlIGBbYm90XWAgc3VmZml4LiBDb21wYXJpc29uIGlzXG4gKiBjYXNlLWluc2Vuc2l0aXZlICh7QGxpbmsgbm9ybWFsaXNlTG9naW59KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQm90TG9naW4obG9naW46IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBub3JtYWxpc2VkID0gbm9ybWFsaXNlTG9naW4obG9naW4pO1xuICBpZiAoIW5vcm1hbGlzZWQpIHJldHVybiBmYWxzZTtcbiAgaWYgKEtOT1dOX05PTl9TVUZGSVhfQk9UUy5oYXMobm9ybWFsaXNlZCkpIHJldHVybiB0cnVlO1xuICByZXR1cm4gQk9UX1BBVFRFUk5TLnNvbWUoKHBhdHRlcm4pID0+IHBhdHRlcm4udGVzdChub3JtYWxpc2VkKSk7XG59XG5cbi8qKlxuICogVGhlIGFkbWlzc2lvbi1ncmFkZSBib3QgcHJlZGljYXRlOiBtYXkgdGhlIHdvcmtlciB0YWtlIHRoaXMgUFIgb3Zlcj9cbiAqXG4gKiBBZG1pc3Npb24gaXMgbm90IGEgdHJ1c3QgcXVlc3Rpb24sIGl0IGlzIGFuIG93bmVyc2hpcCBvbmUuIEEgc2NhbiB0aGF0XG4gKiBhZG1pdHMgYSBQUiBjbGFpbXMgaXQsIHB1c2hlcyBmaXggY29tbWl0cyB0byBpdHMgaGVhZCBicmFuY2gsIGFuc3dlcnMgaXRzXG4gKiBjb21tZW50cyBhbmQgYXJtcyBhdXRvLW1lcmdlIOKAlCBzbyBhIGZhbHNlIHBvc2l0aXZlIGFkb3B0cyBhIGh1bWFuJ3MgUFJcbiAqIHVuaW52aXRlZCwgdGhlIGV4YWN0IG91dGNvbWUgYGRvY3MvSFVNQU4tUFItUE9MSUNZLm1kYCBleGlzdHMgdG8gcHJldmVudC5cbiAqIHtAbGluayBpc0JvdExvZ2lufSdzIHByZWZpeCBwYXR0ZXJucyBjYW5ub3QgY2FycnkgdGhhdCB3ZWlnaHQ6IHRoZXkgcmVhZFxuICogYGN1cnNvcmpvZWAgYW5kIGBzbnlrZWRgIGFzIGJvdHMgKElzc3VlICMxODcyKS5cbiAqXG4gKiBUaGlzIHByZWRpY2F0ZSB0aGVyZWZvcmUgbWF0Y2hlcyBvbmx5IHdoYXQgR2l0SHViIGl0c2VsZiBhdHRlc3RzIOKAlCB0aGVcbiAqIGBbYm90XWAgc3VmZml4IOKAlCBvciBhbiBleGFjdCBtZW1iZXIgb2Yge0BsaW5rIEtOT1dOX05PTl9TVUZGSVhfQk9UU30uIE5vXG4gKiBwcmVmaXggZXZlciBtYXRjaGVzLCBzbyBhIGh1bWFuIGxvZ2luIGlzIGFkbWl0dGVkIG9ubHkgaWYgaXQgKmlzKiBvbmUgb2ZcbiAqIHRob3NlIHRocmVlIG5hbWVzLiBDb21wYXJpc29uIGlzIGNhc2UtaW5zZW5zaXRpdmVcbiAqICh7QGxpbmsgbm9ybWFsaXNlTG9naW59KS5cbiAqXG4gKiBJdCBkb2VzIG5vdCBhY2NlcHQgdGhlIGBhcHAvPHNsdWc+YCBzcGVsbGluZyBgZ2ggcHIgbGlzdCAtLWpzb24gYXV0aG9yYFxuICogcmVwb3J0cyBmb3IgYSBHaXRIdWIgQXBwOyBwYXNzIHN1Y2ggYSBsb2dpbiB0aHJvdWdoXG4gKiB7QGxpbmsgbm9ybWFsaXNlR2hBcHBMb2dpbn0gZmlyc3QgKElzc3VlICM0NzE5KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQm90QXV0aG9yRm9yTWFpbnRlbmFuY2UobG9naW46IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBub3JtYWxpc2VkID0gbm9ybWFsaXNlTG9naW4obG9naW4pO1xuICBpZiAoIW5vcm1hbGlzZWQpIHJldHVybiBmYWxzZTtcbiAgaWYgKEtOT1dOX05PTl9TVUZGSVhfQk9UUy5oYXMobm9ybWFsaXNlZCkpIHJldHVybiB0cnVlO1xuICByZXR1cm4gQk9UX1NVRkZJWC50ZXN0KG5vcm1hbGlzZWQpO1xufVxuXG4vKiogYGFwcC88c2x1Zz5gIGFzIGBnaCBwciBsaXN0IC0tanNvbiBhdXRob3JgIHJlcG9ydHMgYSBHaXRIdWIgQXBwIGF1dGhvci4gKi9cbmNvbnN0IEdIX0FQUF9MT0dJTiA9IC9eYXBwXFwvKFtBLVphLXowLTldKD86W0EtWmEtejAtOS1dKltBLVphLXowLTldKT8pJC9pO1xuXG4vKipcbiAqIFJlLXNwZWxsIGEgYGdoYC1yZXBvcnRlZCBHaXRIdWIgQXBwIGF1dGhvciBpbiB0aGUgUkVTVCBgPHNsdWc+W2JvdF1gIGZvcm1cbiAqIChJc3N1ZSAjNDcxOSkuXG4gKlxuICogYGdoIHByIGxpc3QgLS1qc29uIGF1dGhvcmAgcmVwb3J0cyBhIEdpdEh1YiBBcHAgYXNcbiAqIGB7XCJpc19ib3RcIjp0cnVlLFwibG9naW5cIjpcImFwcC9kZXBlbmRhYm90XCJ9YCwgd2hpbGUgdGhlIFJFU1QgQVBJIGFuZFxuICoge0BsaW5rIGlzQm90QXV0aG9yRm9yTWFpbnRlbmFuY2V9IHVzZSBgZGVwZW5kYWJvdFtib3RdYC4gQSBgL2AgY2Fubm90IG9jY3VyXG4gKiBpbiBhIHJlYWwgdXNlciBsb2dpbiwgc28gYGFwcC88c2x1Zz5gIGlzIHVuYW1iaWd1b3VzLiBBbnl0aGluZyBlbHNlIGlzXG4gKiByZXR1cm5lZCB0cmltbWVkIGFuZCBvdGhlcndpc2UgdW5jaGFuZ2VkLlxuICpcbiAqIFRoaXMgaXMgcmVwcmVzZW50YXRpb24gaGFuZGxpbmcgb25seS4gSXQgY29uZmVycyBubyB0cnVzdDogYWRtaXNzaW9uIHN0aWxsXG4gKiBnb2VzIHRocm91Z2gge0BsaW5rIGlzQm90QXV0aG9yRm9yTWFpbnRlbmFuY2V9IHBsdXMgdGhlIGNyb3NzLXJlcG9zaXRvcnkgYW5kXG4gKiBmbGVldCBjaGVja3MgaW4gYGxpc3RCb3RQcnNgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXNlR2hBcHBMb2dpbihsb2dpbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IGxvZ2luLnRyaW0oKTtcbiAgY29uc3QgbWF0Y2ggPSBHSF9BUFBfTE9HSU4uZXhlYyh0cmltbWVkKTtcbiAgcmV0dXJuIG1hdGNoID8gYCR7bWF0Y2hbMV19W2JvdF1gIDogdHJpbW1lZDtcbn1cblxuLyoqXG4gKiBUaGUgY29uZmlndXJhdGlvbiBrZXlzIHRoYXQgbmFtZSB0aGUgZmxlZXQncyBvd24gR2l0SHViIGxvZ2lucy5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgbm90IG5hbWVkIGBWSUJFXypgOiBgdmliZV9lbnZfcmVnaXN0cnlfdGVzdC50c2AgdHJlYXRzIGV2ZXJ5XG4gKiBgVklCRV9gLXByZWZpeGVkIGlkZW50aWZpZXIgaW4gdGhlIHNvdXJjZSBhcyBhbiBlbnZpcm9ubWVudCB2YXJpYWJsZSB0aGF0XG4gKiBtdXN0IGJlIGRlY2xhcmVkIHdpdGggYSByb2xlLCBhbmQgdGhpcyBpcyBhIGNvbmZpZy1rZXkgbGlzdCwgbm90IGFuIGVudiB2YXIuXG4gKi9cbmV4cG9ydCBjb25zdCBGTEVFVF9MT0dJTl9DT05GSUdfS0VZUyA9IFtcbiAgXCJzZXJ2aWNlX2FjY291bnRzXCIsXG4gIFwiZmxlZXRfcHJfYXV0aG9yc1wiLFxuXSBhcyBjb25zdDtcblxuLyoqIElucHV0cyBmcm9tIHdoaWNoIHRoZSBmbGVldCdzIG93biBsb2dpbnMgYXJlIHJlc29sdmVkLiAqL1xuZXhwb3J0IGludGVyZmFjZSBWaWJlQ29kZXJMb2dpbklucHV0IHtcbiAgLyoqIGBzZXJ2aWNlX2FjY291bnRzYCDigJQgdGhlIGxvZ2lucyB0aGlzIGZsZWV0IGF1dGhlbnRpY2F0ZXMgYXMuICovXG4gIHNlcnZpY2VBY2NvdW50czogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBgZmxlZXRfcHJfYXV0aG9yc2Ag4oCUIHNpYmxpbmcgZmxlZXQgaG9zdHMnIGxvZ2lucy4gKi9cbiAgZmxlZXRQckF1dGhvcnM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogVGhpcyBob3N0J3Mgb3duIHJlc29sdmVkIGBnaGAgbG9naW4sIHdoZW4ga25vd24uICovXG4gIGdpdGh1YlVzZXI/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogVGhlIHNpbmdsZSBcInRoZXNlIGxvZ2lucyBhcmUgVmliZSBDb2RlcnNcIiBzZXQgKElzc3VlICMxMDY2KS5cbiAqXG4gKiBUaGUgZmxlZXQgYWNjb3VudHMgaG9sZCB3cml0ZSBhY2Nlc3MgYnkgbmVjZXNzaXR5IOKAlCB0aGV5IHB1c2ggYnJhbmNoZXMg4oCUXG4gKiBzbyB1bmRlciB0aGUgY29sbGFib3JhdG9yLWRlcml2ZWQgdHJ1c3QgcnVsZSB0aGV5IHdvdWxkIG90aGVyd2lzZSBiZWNvbWVcbiAqIGF1dGhvcnMgZW50aXRsZWQgdG8gZGlyZWN0IHRoZWlyIG93biB3b3JrLCB3aGljaCBpcyB0aGUgZXhhY3Qgb3Bwb3NpdGUgb2ZcbiAqIHRoZSByZXF1aXJlbWVudC4gVGhlIGV4Y2x1c2lvbiB0aGVyZWZvcmUgZGVmYXVsdHMgdG8gdGhlIGZsZWV0IGxvZ2luIGxpc3RcbiAqIHRoZSBjb25maWd1cmF0aW9uIGFscmVhZHkgY2FycmllcyAoYHNlcnZpY2VfYWNjb3VudHNgIGFuZFxuICogYGZsZWV0X3ByX2F1dGhvcnNgKSBwbHVzIHRoaXMgaG9zdCdzIG93biBsb2dpbiwgd2l0aCBubyBvcGVyYXRvciBhY3Rpb25cbiAqIHJlcXVpcmVkOyBgZXhjbHVzaW9uX3RlYW1gIHJlbWFpbnMgYW4gb3B0aW9uYWwgKmFkZGl0aW9uYWwqIGV4Y2x1c2lvbiBmb3JcbiAqIG9yZy10ZWFtLWJhc2VkIHNldHVwcy5cbiAqXG4gKiBCb3Qtc2hhcGVkIGxvZ2lucyBhbW9uZyB0aGVzZSBpbnB1dHMgYXJlIGluY2x1ZGVkIGxpa2UgYW55IG90aGVyIGFjY291bnQ7XG4gKiBjYWxsZXJzIGFsc28gYXBwbHkge0BsaW5rIGlzQm90TG9naW59IHRvIGNvbGxhYm9yYXRvciBsb2dpbnMgc28gYSBgW2JvdF1gXG4gKiBhY2NvdW50IHRoYXQgaXMgbmFtZWQgbm93aGVyZSBoZXJlIGlzIHN0aWxsIGV4Y2x1ZGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVZpYmVDb2RlckxvZ2lucyhcbiAgaW5wdXQ6IFZpYmVDb2RlckxvZ2luSW5wdXQsXG4pOiBTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IGxvZ2lucyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBhZGQgPSAobG9naW46IHN0cmluZyB8IHVuZGVmaW5lZCkgPT4ge1xuICAgIGNvbnN0IG5vcm1hbGlzZWQgPSBub3JtYWxpc2VMb2dpbihsb2dpbiA/PyBcIlwiKTtcbiAgICBpZiAobm9ybWFsaXNlZCkgbG9naW5zLmFkZChub3JtYWxpc2VkKTtcbiAgfTtcbiAgYWRkKGlucHV0LmdpdGh1YlVzZXIpO1xuICBmb3IgKGNvbnN0IGFjY291bnQgb2YgaW5wdXQuc2VydmljZUFjY291bnRzKSBhZGQoYWNjb3VudCk7XG4gIGZvciAoY29uc3Qgc2libGluZyBvZiBpbnB1dC5mbGVldFByQXV0aG9ycykgYWRkKHNpYmxpbmcpO1xuICByZXR1cm4gbG9naW5zO1xufVxuXG4vKiogRXh0cmFjdCBgKEhUVFAgbm5uKWAgb3IgZmFsbCBiYWNrIHRvIDQwMy80MDQga2V5d29yZHMuICovXG5mdW5jdGlvbiBwYXJzZUh0dHBTdGF0dXMobWVzc2FnZTogc3RyaW5nKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghbWVzc2FnZSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IG1hdGNoID0gL1xcKEhUVFAgKFxcZHszfSlcXCkvLmV4ZWMobWVzc2FnZSk7XG4gIGlmIChtYXRjaCkgcmV0dXJuIE51bWJlcihtYXRjaFsxXSk7XG4gIGNvbnN0IGxvd2VyID0gbWVzc2FnZS50b0xvd2VyQ2FzZSgpO1xuICBpZiAobG93ZXIuaW5jbHVkZXMoXCI0MDNcIikgfHwgbG93ZXIuaW5jbHVkZXMoXCJmb3JiaWRkZW5cIikpIHJldHVybiA0MDM7XG4gIGlmIChsb3dlci5pbmNsdWRlcyhcIjQwNFwiKSB8fCBsb3dlci5pbmNsdWRlcyhcIm5vdCBmb3VuZFwiKSkgcmV0dXJuIDQwNDtcbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIGVycm9yUmVzdWx0KFxuICByZWFzb246IFRlYW1GZXRjaFJlYXNvbixcbiAgbWVzc2FnZTogc3RyaW5nLFxuICBzdGF0dXM/OiBudW1iZXIsXG4pOiBUZWFtTWVtYmVyU2V0IHtcbiAgcmV0dXJuIHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHsgcmVhc29uLCBtZXNzYWdlLCAuLi4oc3RhdHVzID8geyBzdGF0dXMgfSA6IHt9KSB9LFxuICB9O1xufVxuXG4vKipcbiAqIFBhcnNlIGEgYGdoIGFwaSAtLXBhZ2luYXRlYCB0ZWFtLW1lbWJlcnMgcGF5bG9hZCBpbnRvIG5vcm1hbGlzZWQgbG9naW5zLlxuICpcbiAqIERlbGVnYXRlcyBwYWdlLWJvdW5kYXJ5IHNjYW5uaW5nIHRvIHRoZSBzaGFyZWRcbiAqIHtAbGluayBwYXJzZUpzb25BcnJheVBhZ2VzfSwgd2hpY2ggdHJhY2tzIEpTT04gc3RyaW5nIHN0YXRlIHNvIGEgcGFnZVxuICogY29udGFpbmluZyBgXVtgIGluc2lkZSBhIHN0cmluZyB2YWx1ZSBpcyBub3QgbWlzdGFrZW4gZm9yIGEgcGFnZVxuICogYm91bmRhcnkuIFRocm93cyB7QGxpbmsgVGVhbU1lbWJlcnNQYXJzZUVycm9yfSBvbiBtYWxmb3JtZWQgSlNPTiBvciBhXG4gKiBwYXlsb2FkIHRoYXQgaXMgbm90IGFuIGFycmF5IG9mIG9iamVjdHMuXG4gKi9cbmZ1bmN0aW9uIHBhcnNlVGVhbU1lbWJlcnMocmF3OiBzdHJpbmcpOiBTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IHRyaW1tZWQgPSByYXcudHJpbSgpO1xuICBpZiAodHJpbW1lZC5sZW5ndGggPT09IDApIHJldHVybiBuZXcgU2V0KCk7XG5cbiAgbGV0IGNodW5rczogdW5rbm93bltdO1xuICB0cnkge1xuICAgIGNodW5rcyA9IHBhcnNlSnNvbkFycmF5UGFnZXModHJpbW1lZCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgdGhyb3cgbmV3IFRlYW1NZW1iZXJzUGFyc2VFcnJvcihgbWFsZm9ybWVkLWpzb246JHttZXNzYWdlfWApO1xuICB9XG5cbiAgY29uc3QgbWVtYmVycyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIGNodW5rcykge1xuICAgIGlmICh0eXBlb2YgZW50cnkgIT09IFwib2JqZWN0XCIgfHwgZW50cnkgPT09IG51bGwgfHwgQXJyYXkuaXNBcnJheShlbnRyeSkpIHtcbiAgICAgIHRocm93IG5ldyBUZWFtTWVtYmVyc1BhcnNlRXJyb3IoXG4gICAgICAgIFwibWFsZm9ybWVkLWpzb246dGVhbSBtZW1iZXIgZW50cnkgaXMgbm90IGFuIG9iamVjdFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgbG9naW4gPSAoZW50cnkgYXMgeyBsb2dpbj86IHVua25vd24gfSkubG9naW47XG4gICAgaWYgKHR5cGVvZiBsb2dpbiAhPT0gXCJzdHJpbmdcIiB8fCBub3JtYWxpc2VMb2dpbihsb2dpbikubGVuZ3RoID09PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgVGVhbU1lbWJlcnNQYXJzZUVycm9yKFxuICAgICAgICBcImludmFsaWQtbG9naW46dGVhbSBtZW1iZXIgbWlzc2luZyBsb2dpblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3Qgbm9ybWFsaXNlZCA9IG5vcm1hbGlzZUxvZ2luKGxvZ2luKTtcbiAgICBpZiAoIVVTRVJOQU1FX1BBVFRFUk4udGVzdChub3JtYWxpc2VkKSAmJiAhVVNFUk5BTUVfUEFUVEVSTi50ZXN0KGxvZ2luKSkge1xuICAgICAgdGhyb3cgbmV3IFRlYW1NZW1iZXJzUGFyc2VFcnJvcihcbiAgICAgICAgYGludmFsaWQtbG9naW46aW52YWxpZCB0ZWFtIG1lbWJlciBsb2dpbiBcIiR7bG9naW59XCJgLFxuICAgICAgKTtcbiAgICB9XG4gICAgbWVtYmVycy5hZGQobm9ybWFsaXNlZCk7XG4gIH1cbiAgcmV0dXJuIG1lbWJlcnM7XG59XG5cbmNsYXNzIFRlYW1NZW1iZXJzUGFyc2VFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJUZWFtTWVtYmVyc1BhcnNlRXJyb3JcIjtcbiAgfVxufVxuXG4vKipcbiAqIEZldGNoIG1lbWJlcnMgb2YgdGhlIGNvbmZpZ3VyZWQgZXhjbHVzaW9uIHRlYW0uXG4gKlxuICogTm8gc2x1ZyAoZW1wdHkgLyB1bnNldCkgbWVhbnMgdGVhbSBleGNsdXNpb24gaXMgb2ZmIOKAlCBubyBgZ2hgIGNhbGwuXG4gKiBBIGNvbmZpZ3VyZWQgc2x1ZyB0aGF0IGNhbm5vdCBiZSBmZXRjaGVkIGlzIGFuIGVycm9yIHJlc3VsdCB3aXRoIG5vXG4gKiBgbWVtYmVyc2AgZmllbGQuXG4gKlxuICogQHBhcmFtIG9yZ1RlYW1TbHVnIC0gYG9yZy9zbHVnYCAoZS5nLiBgc3RTb2Z0d2FyZUFVL3ZpYmUtd29ya2Vyc2ApLlxuICogQHBhcmFtIF9kZXBzIC0gUmVzZXJ2ZWQ7IHRlc3RzIGluamVjdCBgX3NldEdoU3Bhd25SdW5uZXJgLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hUZWFtTWVtYmVycyhcbiAgb3JnVGVhbVNsdWc6IHN0cmluZyB8IHVuZGVmaW5lZCB8IG51bGwsXG4gIF9kZXBzOiBGZXRjaFRlYW1NZW1iZXJzRGVwcyA9IHt9LFxuKTogUHJvbWlzZTxUZWFtTWVtYmVyU2V0PiB7XG4gIGNvbnN0IHRyaW1tZWQgPSAob3JnVGVhbVNsdWcgPz8gXCJcIikudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsga2luZDogXCJvZmZcIiB9IH07XG4gIH1cbiAgaWYgKCFPUkdfVEVBTV9TTFVHLnRlc3QodHJpbW1lZCkpIHtcbiAgICByZXR1cm4gZXJyb3JSZXN1bHQoXG4gICAgICBcImludmFsaWQtc2x1Z1wiLFxuICAgICAgYEV4Y2x1c2lvbiB0ZWFtIHNsdWcgbXVzdCBiZSBvcmcvc2x1ZyAoZS5nLiBzdFNvZnR3YXJlQVUvdmliZS13b3JrZXJzKSwgZ290IFwiJHt0cmltbWVkfVwiYCxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgW29yZywgc2x1Z10gPSB0cmltbWVkLnNwbGl0KFwiL1wiKTtcbiAgY29uc3QgcGF0aCA9IGBvcmdzLyR7b3JnfS90ZWFtcy8ke3NsdWd9L21lbWJlcnM/cGVyX3BhZ2U9MTAwYDtcbiAgY29uc3Qgc3Bhd25lZCA9IGF3YWl0IHNwYXduR2goW1wiYXBpXCIsIFwiLS1wYWdpbmF0ZVwiLCBwYXRoXSk7XG4gIGlmICghc3Bhd25lZC5zdWNjZXNzKSB7XG4gICAgY29uc3QgZGV0YWlsID0gc3Bhd25lZC5zdGRlcnIudHJpbSgpIHx8IHNwYXduZWQuc3Rkb3V0LnRyaW0oKTtcbiAgICBjb25zdCBzdGF0dXMgPSBwYXJzZUh0dHBTdGF0dXMoYCR7c3Bhd25lZC5zdGRlcnJ9XFxuJHtzcGF3bmVkLnN0ZG91dH1gKTtcbiAgICBpZiAoc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHJldHVybiBlcnJvclJlc3VsdChcbiAgICAgICAgXCJodHRwLTQwM1wiLFxuICAgICAgICBgVGVhbSBmZXRjaCA0MDMgZm9yICR7dHJpbW1lZH0g4oCUIHRva2VuIGlzIG1pc3NpbmcgcmVhZDpvcmcuICR7ZGV0YWlsfWAsXG4gICAgICAgIDQwMyxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChzdGF0dXMgPT09IDQwNCkge1xuICAgICAgcmV0dXJuIGVycm9yUmVzdWx0KFxuICAgICAgICBcImh0dHAtNDA0XCIsXG4gICAgICAgIGBUZWFtIGZldGNoIDQwNCBmb3IgJHt0cmltbWVkfSDigJQgdGVhbSBkb2VzIG5vdCBleGlzdC4gJHtkZXRhaWx9YCxcbiAgICAgICAgNDA0LFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIGVycm9yUmVzdWx0KFxuICAgICAgXCJnaC1leGl0XCIsXG4gICAgICBgVGVhbSBmZXRjaCBmYWlsZWQgZm9yICR7dHJpbW1lZH0gKGV4aXQgJHtzcGF3bmVkLmNvZGV9KTogJHtkZXRhaWx9YCxcbiAgICApO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBtZW1iZXJzID0gcGFyc2VUZWFtTWVtYmVycyhzcGF3bmVkLnN0ZG91dCk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IGtpbmQ6IFwibWVtYmVyc1wiLCBtZW1iZXJzIH0gfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBpZiAobWVzc2FnZS5zdGFydHNXaXRoKFwiaW52YWxpZC1sb2dpbjpcIikpIHtcbiAgICAgIHJldHVybiBlcnJvclJlc3VsdChcbiAgICAgICAgXCJpbnZhbGlkLWxvZ2luXCIsXG4gICAgICAgIG1lc3NhZ2Uuc2xpY2UoXCJpbnZhbGlkLWxvZ2luOlwiLmxlbmd0aCksXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZS5zdGFydHNXaXRoKFwibWFsZm9ybWVkLWpzb246XCIpKSB7XG4gICAgICByZXR1cm4gZXJyb3JSZXN1bHQoXG4gICAgICAgIFwibWFsZm9ybWVkLWpzb25cIixcbiAgICAgICAgbWVzc2FnZS5zbGljZShcIm1hbGZvcm1lZC1qc29uOlwiLmxlbmd0aCksXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gZXJyb3JSZXN1bHQoXCJtYWxmb3JtZWQtanNvblwiLCBtZXNzYWdlKTtcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Q0FTQyxHQUVELFNBQVMsT0FBTyxRQUFRLGdCQUFnQjtBQUN4QyxTQUFTLGNBQWMsUUFBUSxzQkFBc0I7QUFDckQsU0FBUyxtQkFBbUIsUUFBUSx3QkFBd0I7QUFFNUQsMEVBQTBFLEdBQzFFLE1BQU0sYUFBYTtBQUVuQjs7Ozs7Ozs7OztDQVVDLEdBQ0QsTUFBTSxlQUFrQztFQUN0QztFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0NBQ0Q7QUFFRDs7OztDQUlDLEdBQ0QsTUFBTSx3QkFBNkMsSUFBSSxJQUFJO0VBQ3pEO0VBQ0E7RUFDQTtDQUNEO0FBRUQsaUZBQWlGLEdBQ2pGLE1BQU0sZ0JBQWdCO0FBRXRCLGdFQUFnRSxHQUNoRSxNQUFNLG1CQUFtQjtBQWlDekI7Ozs7OztDQU1DLEdBQ0QsT0FBTyxTQUFTLFdBQVcsS0FBYTtFQUN0QyxNQUFNLGFBQWEsZUFBZTtFQUNsQyxJQUFJLENBQUMsWUFBWSxPQUFPO0VBQ3hCLElBQUksc0JBQXNCLEdBQUcsQ0FBQyxhQUFhLE9BQU87RUFDbEQsT0FBTyxhQUFhLElBQUksQ0FBQyxDQUFDLFVBQVksUUFBUSxJQUFJLENBQUM7QUFDckQ7QUFFQTs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQW1CQyxHQUNELE9BQU8sU0FBUywwQkFBMEIsS0FBYTtFQUNyRCxNQUFNLGFBQWEsZUFBZTtFQUNsQyxJQUFJ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
// denoCacheMetadata=4521801787125635245,15131337440056376951