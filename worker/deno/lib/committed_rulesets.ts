/**
 * Every ruleset this repository commits, and the one reconciliation that
 * covers all of them (Issue #1073).
 *
 * `main` got a live-versus-committed check with Issue #858 and the release
 * tags got one with Issue #1049. `Milestone` had neither, and drifted to two
 * required contexts — `gitleaks` and `semgrep` — so a PR into a milestone
 * branch could merge with the whole test suite red. PR #1039 did exactly that
 * with `validate (tests 1/4)` failing, and rode a resurrected `fleet_health.ts`
 * onto the milestone branch (Issue #1042).
 *
 * A payload nobody compares to GitHub is the fault, not the missing contexts,
 * so this module holds the **registry**: adding a file under `infra/rulesets/`
 * without registering it here fails the test suite, and every registered
 * payload is reconciled by the same code path — the drift/absent/skipped
 * semantics of `ruleset_reconcile.ts`, plus the required-status-check
 * comparison for a branch target.
 *
 * Read-only throughout. Applying a ruleset needs **admin** on the repository,
 * which the fleet's service account does not hold; the output is a per-field
 * diff and the `gh` command an operator runs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  type BranchRuleset,
  diffRequiredStatusChecks,
  MAIN_BRANCH_RULESET_PATH,
  parseBranchRuleset,
} from "./main_branch_ruleset.ts";
import { RELEASE_TAG_RULESET_PATH } from "./release_tag_ruleset.ts";
import type { GhExec } from "./repo_rulesets.ts";
import type { RulesetPayload } from "./ruleset_payload.ts";
import {
  reconcileRuleset,
  type RulesetReconcileResult,
} from "./ruleset_reconcile.ts";

/** Path of the checked-in milestone payload, relative to the repo root. */
export const MILESTONE_BRANCH_RULESET_PATH = "infra/rulesets/milestone.json";

/** The repository these payloads describe. */
export const COMMITTED_RULESET_REPO = "stSoftwareAU/VibeCoder";

/** One committed ruleset payload. */
export interface CommittedRuleset {
  /** Repo-relative path of the payload. */
  path: string;
  /** What it protects, named in operator-facing output. */
  protects: string;
  /**
   * The ruleset target. A `branch` payload is additionally compared on its
   * required status checks; a tag has no merge to gate.
   */
  target: "branch" | "tag";
}

/**
 * Every payload under `infra/rulesets/`.
 *
 * The list is asserted against the directory by the test suite, so a committed
 * ruleset that nothing reconciles cannot go unnoticed — which is how the
 * milestone ruleset drifted in the first place.
 */
export const COMMITTED_RULESETS: readonly CommittedRuleset[] = [
  {
    path: MAIN_BRANCH_RULESET_PATH,
    protects: "the default branch",
    target: "branch",
  },
  {
    path: MILESTONE_BRANCH_RULESET_PATH,
    protects: "milestone branches",
    target: "branch",
  },
  {
    path: RELEASE_TAG_RULESET_PATH,
    protects: "release tags",
    target: "tag",
  },
];

/** Repository root, resolved from this module's location. */
function repoRoot(): string {
  return decodeURIComponent(new URL("../../../", import.meta.url).pathname)
    .replace(/\/$/, "");
}

/** Read and validate one committed payload. Throws if missing or malformed. */
export async function loadCommittedRuleset(
  entry: CommittedRuleset,
  root: string = repoRoot(),
): Promise<RulesetPayload> {
  const path = `${root.replace(/\/$/, "")}/${entry.path}`;
  return parseBranchRuleset(await Deno.readTextFile(path), entry.path);
}

/** Read and validate `infra/rulesets/milestone.json`. */
export async function loadMilestoneBranchRuleset(
  root: string = repoRoot(),
): Promise<BranchRuleset> {
  const entry = COMMITTED_RULESETS.find((r) =>
    r.path === MILESTONE_BRANCH_RULESET_PATH
  );
  if (!entry) {
    throw new Error(
      `${MILESTONE_BRANCH_RULESET_PATH} is not registered in COMMITTED_RULESETS`,
    );
  }
  return await loadCommittedRuleset(entry, root);
}

/** Options for {@link reconcileCommittedRuleset}. */
export interface CommittedRulesetOptions {
  /** `owner/repo` whose rulesets are read. */
  repo?: string;
  /** Repository root holding `infra/rulesets/`. */
  root?: string;
  /** Injectable `gh` executor; defaults to the shared chokepoint. */
  ghExec?: GhExec;
}

/** One payload and what the comparison found. */
export interface CommittedRulesetResult {
  ruleset: CommittedRuleset;
  result: RulesetReconcileResult;
}

/**
 * Compare one committed payload against the ruleset GitHub applies.
 *
 * Nothing is written. A branch payload also has its required status-check
 * contexts and strict policy compared, because that is the field a milestone
 * merge actually rides on.
 */
export async function reconcileCommittedRuleset(
  entry: CommittedRuleset,
  options: CommittedRulesetOptions = {},
): Promise<RulesetReconcileResult> {
  const { repo = COMMITTED_RULESET_REPO, root, ghExec } = options;
  const committed = await loadCommittedRuleset(
    entry,
    root === undefined ? repoRoot() : root,
  );
  return await reconcileRuleset({
    repo,
    committed,
    path: entry.path,
    ...(entry.target === "branch"
      ? { extraDiff: diffRequiredStatusChecks }
      : {}),
    ...(ghExec ? { ghExec } : {}),
  });
}

/**
 * Compare every committed payload against the rulesets GitHub applies.
 *
 * Sequential on purpose: three reads, and a failure on one must not be lost
 * behind another's rejection.
 */
export async function reconcileCommittedRulesets(
  options: CommittedRulesetOptions = {},
): Promise<CommittedRulesetResult[]> {
  const results: CommittedRulesetResult[] = [];
  for (const ruleset of COMMITTED_RULESETS) {
    results.push({
      ruleset,
      result: await reconcileCommittedRuleset(ruleset, options),
    });
  }
  return results;
}
