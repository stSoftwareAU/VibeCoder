/**
 * The `main` branch ruleset payload, and the drift between it and the ruleset
 * GitHub actually applies (Issue #858).
 *
 * `validate` was not a required status check on `main`. Auto-merge therefore
 * fired while it was red and put `main` red twice — PR #825 (a `deno lint`
 * `no-invalid-regexp` failure whose fix was lost in the squash) and PR #832
 * (`no-unused-vars`). Nothing in the fleet reported the gap: the only evidence
 * was `main` going red and a human noticing.
 *
 * `infra/rulesets/main.json` is the source of truth for that ruleset, matching
 * `infra/rulesets/release-tags.json` for tags (Issue #869). A committed file
 * on its own is only a wish, so this module supplies the other half:
 * {@link diffLiveRuleset} compares what GitHub applies against what the file
 * says, field by field, and names every difference. A ruleset that could not
 * be read is never reported as agreeing — see
 * `main_branch_ruleset_check.ts`, which fails loud on an absent ruleset and
 * skips loudly with no credential.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  parseRulesetPayload,
  type RulesetPayload,
  type RulesetRule,
} from "./ruleset_payload.ts";
import {
  diffRulesetPayloads,
  liveRulesetRules,
  type RulesetDrift,
  setDiff,
} from "./ruleset_reconcile.ts";

export { ruleTypes } from "./ruleset_payload.ts";
export type { RulesetRule } from "./ruleset_payload.ts";
export type { RulesetDrift } from "./ruleset_reconcile.ts";

/** Path of the checked-in payload, relative to the repository root. */
export const MAIN_BRANCH_RULESET_PATH = "infra/rulesets/main.json";

/** A branch ruleset payload, in the shape the update API accepts. */
export type BranchRuleset = RulesetPayload;

/** Parse a branch ruleset payload, failing loud on anything malformed. */
export function parseBranchRuleset(
  text: string,
  source: string = MAIN_BRANCH_RULESET_PATH,
): BranchRuleset {
  return parseRulesetPayload(text, source);
}

/** Repository root, resolved from this module's location. */
function repoRoot(): string {
  return decodeURIComponent(new URL("../../../", import.meta.url).pathname);
}

/** Read and validate the checked-in payload. Throws if it is missing or bad. */
export async function loadMainBranchRuleset(
  root: string = repoRoot(),
): Promise<BranchRuleset> {
  const path = `${root.replace(/\/$/, "")}/${MAIN_BRANCH_RULESET_PATH}`;
  return parseBranchRuleset(await Deno.readTextFile(path));
}

/** The `required_status_checks` rule, or `undefined` when there is none. */
function statusCheckRule(rules: RulesetRule[]): RulesetRule | undefined {
  return rules.find((rule) => rule.type === "required_status_checks");
}

/** The contexts a rule requires, in payload order. */
function contextsOf(rule: RulesetRule | undefined): string[] {
  const raw = rule?.parameters?.required_status_checks;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (entry as { context?: unknown })?.context)
    .filter((context): context is string => typeof context === "string");
}

/**
 * The status-check contexts a ruleset requires.
 *
 * A ruleset with no `required_status_checks` rule throws rather than
 * returning an empty list: "no contexts" and "no rule" are the same value but
 * very different facts, and the second one means nothing is gated at all.
 *
 * `source` names the payload in that error — the milestone ruleset of Issue
 * #1073 is read by the same function.
 */
export function requiredContexts(
  ruleset: BranchRuleset,
  source: string = MAIN_BRANCH_RULESET_PATH,
): string[] {
  const rule = statusCheckRule(ruleset.rules);
  if (!rule) {
    throw new Error(
      `${source}: no required_status_checks rule — nothing would gate a merge`,
    );
  }
  return contextsOf(rule);
}

/** Whether the rule enforces the strict (branch-up-to-date) policy. */
function strictPolicy(rule: RulesetRule | undefined): boolean {
  return (rule?.parameters
    ?.strict_required_status_checks_policy as boolean | undefined) === true;
}

/**
 * The branch-only half of the comparison: the required status-check contexts
 * and the strict policy, appended to the shared field-by-field diff.
 *
 * Kept separate from {@link diffRulesetPayloads} because it is meaningless for
 * a tag ruleset — a tag has no merge to gate.
 */
export function diffRequiredStatusChecks(
  live: unknown,
  committed: BranchRuleset,
): RulesetDrift[] {
  const wantedRule = statusCheckRule(committed.rules);
  if (!wantedRule) return [];

  const drift: RulesetDrift[] = [];
  const note = (field: string, detail: string) => drift.push({ field, detail });
  const appliedRule = statusCheckRule(liveRulesetRules(live));
  const contextDiff = setDiff(contextsOf(appliedRule), contextsOf(wantedRule));
  for (const context of contextDiff.missing) {
    note(
      "required_status_checks",
      `"${context}" is not required — a PR can merge with it red`,
    );
  }
  for (const context of contextDiff.extra) {
    note(
      "required_status_checks",
      `"${context}" is required but not committed`,
    );
  }
  if (appliedRule && strictPolicy(appliedRule) !== strictPolicy(wantedRule)) {
    note(
      "strict_required_status_checks_policy",
      `applied ${strictPolicy(appliedRule)}, committed ` +
        `${strictPolicy(wantedRule)} — a stale branch could merge`,
    );
  }
  return drift;
}

/**
 * Compare the ruleset GitHub applies against the committed `main` payload.
 *
 * Every field that could weaken enforcement is compared, not just the rule
 * types: a ruleset with a bypass actor is technically still "active" and
 * protects nothing, and one whose enforcement dropped to `evaluate` reports
 * without blocking. An empty array means the two agree.
 */
export function diffLiveRuleset(
  live: unknown,
  committed: BranchRuleset,
): RulesetDrift[] {
  return [
    ...diffRulesetPayloads(live, committed),
    ...diffRequiredStatusChecks(live, committed),
  ];
}
