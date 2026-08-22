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
 * `fleet_pr_authors` and `service_accounts` (Issue #209) into the guard's
 * author set, so a sibling listed *only* in one of them is no longer a
 * blind spot. This validation
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
   * Sibling logins present in `fleet_pr_authors` or `service_accounts`
   * but absent from `allowed_authors` (case-insensitive) — the exact
   * blind-spot shape. The host's own login is never reported.
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
  /**
   * Fleet service accounts (`service_accounts`) — fleet logins by
   * definition, so they join the effective author set (Issue #209).
   */
  serviceAccounts?: string[];
  /**
   * The active trust source (Issue #256). Under `"github"` the local
   * `allowed_authors` array is ignored by design, so its emptiness is the
   * expected healthy state and warning about it every start-up would train
   * operators to ignore this validator. The sibling-divergence checks still
   * run: `fleet_pr_authors` and `service_accounts` are host configuration
   * either way, and a sibling missing from them is still worth naming.
   */
  authorSource?: "config" | "github";
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
  const serviceAccounts = input.serviceAccounts ?? [];

  const effectiveAuthors = resolveFleetAuthors(
    githubUser,
    allowedAuthors,
    fleetPrAuthors,
    serviceAccounts,
  );

  const allowedSet = lowerSet(allowedAuthors);
  const hostKey = typeof githubUser === "string"
    ? githubUser.trim().toLowerCase()
    : "";
  const seenMissing = new Set<string>();
  const missingFromAllowed: string[] = [];
  for (const sibling of [...fleetPrAuthors, ...serviceAccounts]) {
    if (typeof sibling !== "string") continue;
    const trimmed = sibling.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    // The host's own login is never a sibling — `service_accounts`
    // routinely contains it (Issue #4030 defaults it), and warning that
    // the host is missing from `allowed_authors` is noise (Issue #209).
    if (key === hostKey) continue;
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

  // Issue #256: under author_source "github" an empty allowed_authors is
  // correct, not a misconfiguration — the derived resolver supplies the set
  // each cycle and the local array is deliberately ignored. Warning here
  // would fire on every healthy start-up.
  if (allowedSet.size === 0 && input.authorSource !== "github") {
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
      `Fleet sibling "${sibling}" is in fleet_pr_authors/service_accounts ` +
        "but not allowed_authors. The open-PR guard now covers it via the " +
        "union (Issues #3138, #209), but the lists diverging is a " +
        "configuration smell — add it to allowed_authors to keep them " +
        "consistent.",
    );
  }

  return { level, effectiveAuthors, missingFromAllowed, messages };
}

/**
 * Format a {@link FleetConfigValidation} as prefixed log lines suitable
 * for both the startup banner and `diagnose-repo` output.
 *
 * The effective author set is named on **every** run, not just a clean
 * one (Issue #209): when a host is uncoordinated, the one fact an
 * operator needs from the log is which logins the guards actually see.
 *
 * @param result - The validation result to render.
 * @returns One `[fleet-config]` line per message, preceded by the
 *   effective-authors line (which is the whole output when there are no
 *   messages).
 */
export function formatFleetConfigValidation(
  result: FleetConfigValidation,
): string[] {
  const authors = result.effectiveAuthors.join(",") || "(none)";
  if (result.messages.length === 0) {
    return [`[fleet-config] ok effective-authors=${authors}`];
  }
  const tag = result.level === "error" ? "ERROR" : "WARNING";
  return [
    `[fleet-config] effective-authors=${authors}`,
    ...result.messages.map((m) => `[fleet-config] ${tag} ${m}`),
  ];
}
