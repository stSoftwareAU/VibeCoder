/**
 * Read the ruleset GitHub applies to `main` and compare it against the
 * committed payload (Issue #858).
 *
 * The committed `infra/rulesets/main.json` says which checks must gate a
 * merge; only this check proves the repository agrees. It is deliberately
 * read-only — writing branch protection unattended is an operator decision,
 * and the fleet's account holds no admin permission on this repository — so
 * the output is a per-field diff plus the `gh` command that applies the file.
 *
 * Failure modes are separated, never conflated:
 *
 *   - **drift** — the ruleset was read and differs. Reported field by field.
 *   - **absent** — no ruleset of that name exists. Fails loud: an unreadable
 *     or missing ruleset is indistinguishable from an unprotected branch.
 *   - **skipped** — no credential, no permission, or GitHub unreachable. Says
 *     `SKIPPED` in as many words; it is never reported as agreement.
 *
 * Anything else propagates. A `gh` failure this module does not recognise is
 * not quietly turned into a pass.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { classifyGitHubError, GitHubErrorCategory } from "./github_errors.ts";
import {
  diffLiveRuleset,
  loadMainBranchRuleset,
  MAIN_BRANCH_RULESET_PATH,
  type RulesetDrift,
} from "./main_branch_ruleset.ts";
import {
  defaultGhExec,
  type GhExec,
  isValidRepoSlug,
} from "./repo_rulesets.ts";

/** Outcome of one comparison. */
export type MainRulesetStatus = "ok" | "drift" | "absent" | "skipped";

/** What the check found. */
export interface MainRulesetCheckResult {
  status: MainRulesetStatus;
  /** Every field that differs. Empty unless the status is `drift`. */
  findings: RulesetDrift[];
  /** Operator-facing summary — the diff, or why nothing was compared. */
  message: string;
}

/** Options for {@link checkMainBranchRuleset}. */
export interface MainRulesetCheckOptions {
  /** `owner/repo` whose ruleset is read. */
  repo: string;
  /** Injectable `gh` executor; defaults to the shared chokepoint. */
  ghExec?: GhExec;
  /** Repository root holding `infra/rulesets/main.json`. */
  root?: string;
}

/** A ruleset as `GET /repos/{repo}/rulesets` lists it. */
interface RulesetSummary {
  id?: number;
  name?: string;
  target?: string;
}

/** Categories that mean "could not look", not "looked and found nothing". */
const SKIP_CATEGORIES = new Set([
  GitHubErrorCategory.Authentication,
  GitHubErrorCategory.Permission,
  GitHubErrorCategory.Network,
  GitHubErrorCategory.RateLimit,
  GitHubErrorCategory.TransientServer,
]);

/** Parse `gh` output, failing loud when it is not the JSON we asked for. */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `could not read ${what} — ${(error as Error).message}`,
    );
  }
}

/** The `gh api` command that applies the committed payload. */
export function applyCommand(repo: string, rulesetId: number | string): string {
  return `gh api --method PUT repos/${repo}/rulesets/${rulesetId} ` +
    `--input ${MAIN_BRANCH_RULESET_PATH}`;
}

/**
 * Compare the applied branch ruleset against `infra/rulesets/main.json`.
 *
 * Nothing is written. The ruleset is matched by the committed payload's
 * `name` on the `branch` target — never by id, so recreating it by hand does
 * not silently stop the check working.
 */
export async function checkMainBranchRuleset(
  options: MainRulesetCheckOptions,
): Promise<MainRulesetCheckResult> {
  const { repo, ghExec = defaultGhExec, root } = options;
  if (!isValidRepoSlug(repo)) {
    throw new Error(`invalid repo slug: ${repo}`);
  }
  const committed = root === undefined
    ? await loadMainBranchRuleset()
    : await loadMainBranchRuleset(root);

  let listText: string;
  try {
    listText = await ghExec(["api", `repos/${repo}/rulesets`]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (SKIP_CATEGORIES.has(classifyGitHubError(message).category)) {
      return {
        status: "skipped",
        findings: [],
        message: `SKIPPED: the ${repo} rulesets could not be read — ` +
          `${message}. Nothing was compared; this is not a pass.`,
      };
    }
    throw error;
  }

  const summaries = parseJson(listText, `the ${repo} ruleset list`);
  const match = (Array.isArray(summaries) ? summaries as RulesetSummary[] : [])
    .find((entry) =>
      entry?.name === committed.name &&
      (entry.target === undefined || entry.target === "branch")
    );
  if (!match?.id) {
    return {
      status: "absent",
      findings: [],
      message:
        `No branch ruleset named "${committed.name}" exists on ${repo}. ` +
        `${MAIN_BRANCH_RULESET_PATH} describes a ruleset that is not ` +
        "applied, so the branch is unprotected. Create it with: " +
        `gh api --method POST repos/${repo}/rulesets --input ` +
        MAIN_BRANCH_RULESET_PATH,
    };
  }

  const detailText = await ghExec([
    "api",
    `repos/${repo}/rulesets/${match.id}`,
  ]);
  const live = parseJson(detailText, `ruleset ${match.id} on ${repo}`);
  const findings = diffLiveRuleset(live, committed);
  if (findings.length === 0) {
    return {
      status: "ok",
      findings,
      message: `Ruleset "${committed.name}" (${match.id}) on ${repo} matches ` +
        `${MAIN_BRANCH_RULESET_PATH}.`,
    };
  }
  const lines = findings.map((f) => `  - ${f.field}: ${f.detail}`).join("\n");
  return {
    status: "drift",
    findings,
    message: `Ruleset "${committed.name}" (${match.id}) on ${repo} differs ` +
      `from ${MAIN_BRANCH_RULESET_PATH}:\n${lines}\n\nApply the committed ` +
      `payload with:\n  ${applyCommand(repo, match.id)}`,
  };
}
