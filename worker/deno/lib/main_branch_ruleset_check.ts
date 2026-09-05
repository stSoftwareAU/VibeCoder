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
 * The fetch and the drift/absent/skipped semantics are shared with the tag
 * check of Issue #1049 and live in `ruleset_reconcile.ts`; what stays here is
 * the branch-only half — the required status-check contexts and the strict
 * policy, passed in as the extra comparison.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  diffRequiredStatusChecks,
  loadMainBranchRuleset,
  MAIN_BRANCH_RULESET_PATH,
  type RulesetDrift,
} from "./main_branch_ruleset.ts";
import type { GhExec } from "./repo_rulesets.ts";
import {
  applyRulesetCommand,
  reconcileRuleset,
  type RulesetStatus,
} from "./ruleset_reconcile.ts";

/** Outcome of one comparison. */
export type MainRulesetStatus = RulesetStatus;

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

/** The `gh api` command that applies the committed payload. */
export function applyCommand(repo: string, rulesetId: number | string): string {
  return applyRulesetCommand(repo, rulesetId, MAIN_BRANCH_RULESET_PATH);
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
  const { repo, ghExec, root } = options;
  const committed = root === undefined
    ? await loadMainBranchRuleset()
    : await loadMainBranchRuleset(root);
  return await reconcileRuleset({
    repo,
    committed,
    path: MAIN_BRANCH_RULESET_PATH,
    extraDiff: diffRequiredStatusChecks,
    ...(ghExec ? { ghExec } : {}),
  });
}
