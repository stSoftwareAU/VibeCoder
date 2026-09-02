/**
 * What a failed default-branch ruleset sync means, in words an operator can
 * act on (Issue #733).
 *
 * Applying the ruleset to a **private** repository on a free plan returns HTTP
 * 403: repository rulesets need GitHub Pro there. The failure is correctly
 * non-fatal — setup finishes, labels and workflow audits and the collaborator
 * check all succeeded — but it was reported as
 * `Ruleset sync had issues (non-fatal)`, which is also what a missing token
 * scope, a revoked token and an organisation policy print. The reporter had to
 * work the plan limitation out for themselves (report item 4 of #722).
 *
 * The two cases are told apart by what GitHub itself says: the plan
 * limitation carries its own upgrade wording, which no scope or policy failure
 * does. Anything else keeps a warning, but one naming the repository and the
 * HTTP status, so the next step is the operator's to choose rather than to
 * guess.
 *
 * Pure: the caller supplies the error text, so every case is unit-tested with
 * no network.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { RepoVisibility } from "./repo_visibility.ts";

/** What kind of failure the sync hit. */
export type RulesetFailureKind =
  /** The repository's plan does not include rulesets (private + free). */
  | "plan-required"
  /** Any other failure, including a 403 that is not the plan limitation. */
  | "other";

/** One failed repository, explained. */
export interface RulesetFailureExplanation {
  /** Which case this is. */
  kind: RulesetFailureKind;
  /** The HTTP status GitHub named, when it named one. */
  status?: number;
  /** The line to print, naming the repository. */
  message: string;
}

/** `(HTTP 403)`, `HTTP 403:`, `HTTP 403` — however gh spells it that day. */
const HTTP_STATUS_RE = /\bHTTP[\s:]*(\d{3})\b/i;

/**
 * GitHub's own words for "this feature needs a paid plan on a private repo".
 *
 * Matching the message rather than inferring from `403 + private` is
 * deliberate: a 403 on a private repository is also what a token missing
 * `admin:repo_hook`, a revoked token, or an organisation policy produces, and
 * telling an operator to buy a subscription for any of those is worse than
 * saying nothing.
 */
const PLAN_REQUIRED_RE =
  /upgrade to github pro|make (?:this|the) repository public|available (?:to|for|in) (?:github )?(?:pro|team|enterprise)|only available (?:on|with) (?:paid|github pro)/i;

/**
 * Read the HTTP status out of a gh error message.
 *
 * @param error - The error text as gh reported it
 * @returns The status, or undefined when the message names none
 */
export function rulesetFailureStatus(error: string): number | undefined {
  const match = error.match(HTTP_STATUS_RE);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : undefined;
}

/** Collapse an error to one line, so a warning stays one line. */
function oneLine(error: string): string {
  return error.replace(/\s+/g, " ").trim();
}

/**
 * Explain one repository's ruleset failure.
 *
 * @param opts.repo - The `owner/repo` the sync was applying to
 * @param opts.error - The failure text, as `gh` reported it
 * @param opts.visibility - The repository's visibility, when it was resolved
 * @returns The kind, the status when known, and the line to print
 */
export function explainRulesetFailure(opts: {
  repo: string;
  error: string;
  visibility?: RepoVisibility;
}): RulesetFailureExplanation {
  const error = oneLine(opts.error) || "no reason given";
  const status = rulesetFailureStatus(error);

  if (status === 403 && PLAN_REQUIRED_RE.test(error)) {
    const where = opts.visibility === "private"
      ? "this private repository"
      : "this repository";
    return {
      kind: "plan-required",
      status,
      message:
        `Ruleset sync for ${opts.repo}: repository rulesets need GitHub Pro ` +
        `on ${where}, so GitHub refused with HTTP 403 — "${error}". ` +
        `Non-fatal: setup continues and the branch is simply left ` +
        `unprotected. Upgrade the plan, make the repository public, or leave ` +
        `it as it is.`,
    };
  }

  return {
    kind: "other",
    ...(status === undefined ? {} : { status }),
    message: status === undefined
      ? `Ruleset sync for ${opts.repo} failed: ${error} (non-fatal)`
      : `Ruleset sync for ${opts.repo} failed with HTTP ${status}: ${error} ` +
        `(non-fatal)`,
  };
}
