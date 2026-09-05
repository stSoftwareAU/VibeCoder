/**
 * Read the tag ruleset GitHub applies and compare it against the committed
 * payload (Issue #1049).
 *
 * `infra/rulesets/release-tags.json` says a released tag cannot be deleted or
 * re-pointed. Only this check proves the repository agrees — and it did not:
 * the applied ruleset carried `deletion` and `non_fast_forward` but not
 * `update`, so `1.2.0` could still be fast-forwarded onto a later commit while
 * the file, the docs and the tests all said it could not.
 *
 * Deliberately read-only. Applying a ruleset needs **admin** on the
 * repository, and tightening tag protection unattended is an operator
 * decision, so the output is a per-field diff plus the `gh` command that
 * applies the file. The status semantics — drift, absent, skipped — are the
 * shared ones in `ruleset_reconcile.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  loadReleaseTagRuleset,
  RELEASE_TAG_RULESET_PATH,
} from "./release_tag_ruleset.ts";
import type { GhExec } from "./repo_rulesets.ts";
import {
  reconcileRuleset,
  type RulesetReconcileResult,
} from "./ruleset_reconcile.ts";

export type {
  RulesetDrift,
  RulesetReconcileResult,
  RulesetStatus,
} from "./ruleset_reconcile.ts";

/** Options for {@link checkReleaseTagRuleset}. */
export interface ReleaseTagRulesetCheckOptions {
  /** `owner/repo` whose tag ruleset is read. */
  repo: string;
  /** Injectable `gh` executor; defaults to the shared chokepoint. */
  ghExec?: GhExec;
  /** Repository root holding `infra/rulesets/release-tags.json`. */
  root?: string;
}

/**
 * Compare the applied tag ruleset against
 * `infra/rulesets/release-tags.json`.
 */
export async function checkReleaseTagRuleset(
  options: ReleaseTagRulesetCheckOptions,
): Promise<RulesetReconcileResult> {
  const { repo, ghExec, root } = options;
  const committed = root === undefined
    ? await loadReleaseTagRuleset()
    : await loadReleaseTagRuleset(root);
  return await reconcileRuleset({
    repo,
    committed,
    path: RELEASE_TAG_RULESET_PATH,
    ...(ghExec ? { ghExec } : {}),
  });
}
