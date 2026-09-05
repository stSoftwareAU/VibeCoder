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

export { ruleTypes } from "./ruleset_payload.ts";
export type { RulesetRule } from "./ruleset_payload.ts";

/** Path of the checked-in payload, relative to the repository root. */
export const MAIN_BRANCH_RULESET_PATH = "infra/rulesets/main.json";

/** A branch ruleset payload, in the shape the update API accepts. */
export type BranchRuleset = RulesetPayload;

/** One field where the applied ruleset differs from the committed payload. */
export interface RulesetDrift {
  /** The payload field that differs, e.g. `required_status_checks`. */
  field: string;
  /** One line naming what differs, applied versus committed. */
  detail: string;
}

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
 */
export function requiredContexts(ruleset: BranchRuleset): string[] {
  const rule = statusCheckRule(ruleset.rules);
  if (!rule) {
    throw new Error(
      `${MAIN_BRANCH_RULESET_PATH}: no required_status_checks rule — ` +
        "nothing would gate a merge",
    );
  }
  return contextsOf(rule);
}

/** Whether the rule enforces the strict (branch-up-to-date) policy. */
function strictPolicy(rule: RulesetRule | undefined): boolean {
  return (rule?.parameters
    ?.strict_required_status_checks_policy as boolean | undefined) === true;
}

/** Coerce the live payload into the parsed shape, tolerating missing fields. */
function liveView(live: unknown): {
  name: string;
  target: string;
  enforcement: string;
  bypassActors: unknown[];
  include: string[];
  exclude: string[];
  rules: RulesetRule[];
} {
  const obj = (typeof live === "object" && live !== null)
    ? live as Record<string, unknown>
    : {};
  const conditions = obj.conditions as
    | { ref_name?: { include?: unknown; exclude?: unknown } }
    | undefined;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  return {
    name: typeof obj.name === "string" ? obj.name : "",
    target: typeof obj.target === "string" ? obj.target : "",
    enforcement: typeof obj.enforcement === "string" ? obj.enforcement : "",
    bypassActors: Array.isArray(obj.bypass_actors) ? obj.bypass_actors : [],
    include: strings(conditions?.ref_name?.include),
    exclude: strings(conditions?.ref_name?.exclude),
    rules: Array.isArray(obj.rules) ? obj.rules as RulesetRule[] : [],
  };
}

/** Compare two lists as sets, returning what the first is missing and has extra. */
function setDiff(
  applied: string[],
  wanted: string[],
): { missing: string[]; extra: string[] } {
  const appliedSet = new Set(applied);
  const wantedSet = new Set(wanted);
  return {
    missing: wanted.filter((v) => !appliedSet.has(v)),
    extra: applied.filter((v) => !wantedSet.has(v)),
  };
}

/**
 * Compare the ruleset GitHub applies against the committed payload.
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
  const applied = liveView(live);
  const drift: RulesetDrift[] = [];
  const note = (field: string, detail: string) => drift.push({ field, detail });

  if (applied.name !== committed.name) {
    note("name", `applied "${applied.name}", committed "${committed.name}"`);
  }
  if (applied.target !== committed.target) {
    note(
      "target",
      `applied "${applied.target}", committed "${committed.target}"`,
    );
  }
  if (applied.enforcement !== committed.enforcement) {
    note(
      "enforcement",
      `applied "${applied.enforcement}", committed ` +
        `"${committed.enforcement}"`,
    );
  }
  if (applied.bypassActors.length !== committed.bypass_actors.length) {
    note(
      "bypass_actors",
      `applied ${applied.bypassActors.length} bypass actor(s), committed ` +
        `${committed.bypass_actors.length} — a bypass actor makes an active ` +
        "ruleset protect nothing",
    );
  }

  for (
    const [field, appliedList, wantedList] of [
      [
        "conditions.ref_name.include",
        applied.include,
        committed.conditions.ref_name.include,
      ],
      [
        "conditions.ref_name.exclude",
        applied.exclude,
        committed.conditions.ref_name.exclude,
      ],
    ] as Array<[string, string[], string[]]>
  ) {
    const { missing, extra } = setDiff(appliedList, wantedList);
    for (const value of missing) note(field, `"${value}" is not applied`);
    for (const value of extra) {
      note(field, `"${value}" is applied but not committed`);
    }
  }

  const appliedTypes = applied.rules.map((rule) => rule.type);
  const wantedTypes = committed.rules.map((rule) => rule.type);
  const ruleDiff = setDiff(appliedTypes, wantedTypes);
  for (const type of ruleDiff.missing) {
    note("rules", `rule "${type}" is committed but not applied`);
  }
  for (const type of ruleDiff.extra) {
    note("rules", `rule "${type}" is applied but not committed`);
  }

  const appliedRule = statusCheckRule(applied.rules);
  const wantedRule = statusCheckRule(committed.rules);
  if (wantedRule) {
    const contextDiff = setDiff(
      contextsOf(appliedRule),
      contextsOf(wantedRule),
    );
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
  }

  return drift;
}
