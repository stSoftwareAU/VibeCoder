/**
 * Fail-loud fleet-configuration validation (Issue #3138).
 *
 * The #3100 open-PR duplicate guard is only as good as the fleet-account
 * configuration that feeds it. A host that is missing a sibling fleet
 * login is silently blind to that sibling's open PRs and will raise
 * duplicate PRs (Issue #3095/#3100). This module surfaces that structural
 * blind spot loudly — at startup and in `diagnose-repo` — instead of
 * letting it fail silently.
 *
 * Note: `resolveFleetAuthors` (fleet_authors.ts) already unions
 * `fleet_pr_authors` into the guard's author set, so a sibling listed
 * *only* in `fleet_pr_authors` is no longer a blind spot. This validation
 * still warns on that state because the two lists diverging is a
 * configuration smell worth an operator's attention, and it hard-errors
 * on the genuinely broken case: an empty effective fleet set.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { resolveFleetAuthors } from "./fleet_authors.ts";

/** Severity of the overall fleet-config validation result. */
export type FleetConfigLevel = "ok" | "warning" | "error";

/** Structured result of validating a host's fleet configuration. */
export interface FleetConfigValidation {
  /** Overall severity: `error` beats `warning` beats `ok`. */
  level: FleetConfigLevel;
  /** The effective fleet author set the guard will query. */
  effectiveAuthors: string[];
  /**
   * Sibling logins present in `fleet_pr_authors` but absent from
   * `allowed_authors` (case-insensitive) — the exact blind-spot shape.
   */
  missingFromAllowed: string[];
  /** Human-readable diagnostic messages, most severe first. */
  messages: string[];
}

/** Input shape for {@link validateFleetConfig}. */
export interface FleetConfigInput {
  githubUser: string;
  allowedAuthors: string[];
  fleetPrAuthors: string[];
}

/** Trim, drop blanks, and return a lowercase membership set. */
function lowerSet(values: string[]): Set<string> {
  const set = new Set<string>();
  for (const v of values) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t.length > 0) set.add(t.toLowerCase());
  }
  return set;
}

/**
 * Validate a host's fleet configuration for the open-PR guard.
 *
 * - **error** when the effective fleet author set is empty: the guard
 *   cannot see any account's PRs, so duplicate prevention is inoperative.
 * - **warning** when `allowed_authors` is empty (the guard sees only the
 *   host's own login and is blind to every sibling), or when a
 *   `fleet_pr_authors` sibling is missing from `allowed_authors`.
 * - **ok** otherwise.
 *
 * @param input - The host login and the two fleet lists.
 * @returns Structured validation result.
 */
export function validateFleetConfig(
  input: FleetConfigInput,
): FleetConfigValidation {
  const { githubUser, allowedAuthors, fleetPrAuthors } = input;

  const effectiveAuthors = resolveFleetAuthors(
    githubUser,
    allowedAuthors,
    fleetPrAuthors,
  );

  const allowedSet = lowerSet(allowedAuthors);
  const seenMissing = new Set<string>();
  const missingFromAllowed: string[] = [];
  for (const sibling of fleetPrAuthors) {
    if (typeof sibling !== "string") continue;
    const trimmed = sibling.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (allowedSet.has(key)) continue;
    if (seenMissing.has(key)) continue;
    seenMissing.add(key);
    missingFromAllowed.push(trimmed);
  }

  const messages: string[] = [];
  let level: FleetConfigLevel = "ok";

  if (effectiveAuthors.length === 0) {
    level = "error";
    messages.push(
      "Fleet author set is EMPTY — the open-PR duplicate guard cannot see " +
        "any account's PRs. Set allowed_authors (and the host github_user) " +
        "in .config.json.",
    );
    return { level, effectiveAuthors, missingFromAllowed, messages };
  }

  if (allowedSet.size === 0) {
    level = "warning";
    messages.push(
      "allowed_authors is empty — the open-PR duplicate guard sees only " +
        `this host (${githubUser || "unknown"}) and is blind to sibling ` +
        "fleet accounts' open PRs. Add every fleet login to allowed_authors.",
    );
  }

  for (const sibling of missingFromAllowed) {
    if (level === "ok") level = "warning";
    messages.push(
      `Fleet sibling "${sibling}" is in fleet_pr_authors but not ` +
        "allowed_authors. The open-PR guard now covers it via the union " +
        "(Issue #3138), but the two lists diverging is a configuration " +
        "smell — add it to allowed_authors to keep them consistent.",
    );
  }

  return { level, effectiveAuthors, missingFromAllowed, messages };
}

/**
 * Format a {@link FleetConfigValidation} as prefixed log lines suitable
 * for both the startup banner and `diagnose-repo` output.
 *
 * @param result - The validation result to render.
 * @returns One `[fleet-config]` line per message (a single `ok` line when
 *   there are no messages).
 */
export function formatFleetConfigValidation(
  result: FleetConfigValidation,
): string[] {
  if (result.messages.length === 0) {
    return [
      `[fleet-config] ok effective-authors=${
        result.effectiveAuthors.join(",") || "(none)"
      }`,
    ];
  }
  const tag = result.level === "error" ? "ERROR" : "WARNING";
  return result.messages.map((m) => `[fleet-config] ${tag} ${m}`);
}
