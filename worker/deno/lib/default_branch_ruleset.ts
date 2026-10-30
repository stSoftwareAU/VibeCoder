/**
 * Idempotent **ruleset** configurator for a repo's default branch
 * (Issue #4163, replacing the classic-protection configurator of Issue #2586;
 * direct-push guard added by Issue #4356).
 *
 * GitHub enforces through repository **rulesets**; classic branch protection
 * (`PUT /repos/{repo}/branches/{branch}/protection`) is the legacy surface and
 * the worker no longer writes it at all. Every Vibe setup run used to recreate
 * a classic rule that humans then deleted — and that rule demanded status
 * contexts (`gitleaks`, `semgrep`) many repos no longer report, so the merge
 * box sat on *"Expected — Waiting for status to be reported"* forever while the
 * repo's real ruleset checks were green.
 *
 * Behaviour:
 *
 *   - **Never writes classic protection.** The only classic endpoint touched is
 *     a read, used to report a leftover legacy rule for an operator to delete.
 *   - **Defers to an existing ruleset.** When the default branch is already
 *     covered by a ruleset the worker does not own — a human-managed one, or an
 *     organisation ruleset — the sync is a genuine no-op. The worker never
 *     competes with an existing enforcement policy.
 *   - **Never locks a direct-push branch** (Issue #4356). A required-status-
 *     checks ruleset on a branch that is pushed to directly (a data repo the
 *     fleet checks results in to, with no PR) refuses every push with `GH013`.
 *     Before creating or updating, the recent history is inspected via
 *     {@link assessBranchPushPolicy}; a branch that takes direct pushes, has
 *     opted out (topic `direct-push` / marker `.vibe/no-default-branch-ruleset`),
 *     or whose history cannot be read gets no ruleset.
 *   - **Only removes protection on evidence it trusts** (Issue #1289). The
 *     worker's own stale ruleset is deleted for observed direct pushes or the
 *     admin-gated `direct-push` topic — never on the marker file alone, which
 *     is repository content anyone with write access can land, and never an
 *     unreadable history. Only the ruleset named exactly
 *     {@link VIBE_RULESET_NAME} is ever deleted; a human-managed or
 *     organisation ruleset is untouched.
 *   - **Never requires an unsatisfiable check.** The candidate contexts from
 *     {@link getRequiredChecksForRepo} are intersected with the names the repo
 *     has genuinely reported ({@link getReportedCheckNames}), so a ghost
 *     context can never be written. When nothing matches, no ruleset is
 *     created.
 *   - **Converges additively** (Issue #3656). Updating the worker's own
 *     ruleset writes the union of its desired contexts and the contexts
 *     already live in it, each live check keeping its `integration_id`
 *     (Issue #4487), so a check someone else added to it survives.
 *   - **Never weakens the ruleset it updates** (Issue #1290). The update is a
 *     full-document PUT, so the live ruleset is read first and every rule the
 *     worker does not model — `pull_request`, `non_fast_forward`, `deletion`,
 *     `required_signatures`, bypass actors — is carried through unchanged. The
 *     `required_status_checks` rule is the same union (Issue #4487). A
 *     ruleset whose current rules cannot be read fails the sync loudly rather
 *     than being overwritten with a body built from status checks alone.
 *   - **Merge queue where GitHub allows one** (Issue #4424). Where the
 *     repository can carry a merge queue, every required check reports on
 *     `merge_group`, and the repo has not opted out (topic `no-merge-queue`),
 *     the ruleset gets a `merge_queue` rule and the strict up-to-date policy
 *     is off, replacing the branch-up-to-date churn. Otherwise strict stays
 *     on, as before. A queue is never written or removed on an unverified
 *     read: a transient failure keeps whatever queue is already live.
 *
 * The decision is separated from the write: {@link planDefaultBranchRuleset}
 * returns what *would* happen (its only write is the merge-queue probe, which
 * a `readOnly` plan never makes; see its doc comment), and
 * {@link ensureDefaultBranchRuleset} applies that plan. The read-only sweep
 * (`audit-default-branch-rulesets`) uses the plan alone with `readOnly` set, so
 * it never probes.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  type CheckVisibility,
  getRequiredChecksForRepo,
} from "./branch_protection_definitions.ts";
import { assessBranchPushPolicy } from "./branch_push_policy.ts";
import {
  buildMergeQueueParameters,
  MERGE_QUEUE_RULE_TYPE,
} from "./merge_queue.ts";
import {
  decideMergeQueue,
  type MergeQueueDecision,
  type MergeQueueVerdict,
} from "./merge_queue_decision.ts";
import { getReportedCheckNames } from "./reported_check_names.ts";
import {
  buildDefaultBranchRulesetBody,
  buildDefaultBranchRulesetUpdateBody,
  createRuleset,
  defaultGhExec,
  deleteRuleset,
  getBranchRules,
  getRuleset,
  type GhExec,
  hasClassicBranchProtection,
  isValidBranchName,
  isValidRepoSlug,
  listRepoRulesets,
  type MergeQueueParameters,
  mergeQueueParametersFromDetail,
  type OpaqueRulesetRule,
  preservedRulesFromDetail,
  requiredContextsFromRules,
  type RulesetBody,
  type RulesetDetail,
  updateRuleset,
} from "./repo_rulesets.ts";

export type { GhExec };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Name of the ruleset the worker owns. Matched exactly — never guessed. */
export const VIBE_RULESET_NAME = "Vibe Coder default branch";

/** Options for {@link ensureDefaultBranchRuleset}. */
export interface EnsureRulesetOptions {
  /** Default branch name (e.g. `main`). */
  branch: string;
  /** Repository visibility, forwarded to {@link getRequiredChecksForRepo}. */
  visibility: CheckVisibility;
  /** Optional detected languages, forwarded to {@link getRequiredChecksForRepo}. */
  detectedLanguages?: string[];
  /**
   * True for a read-only plan (the audit sweep). Such a plan never creates the
   * merge-queue probe ruleset, so it makes no non-GET call at all; an
   * inconclusive merge-queue answer is then unverified. Default false
   * (Issue #4424).
   */
  readOnly?: boolean;
}

/** Why a run made no change, when it made none. */
export type RulesetSkipReason =
  /** Another (human- or org-managed) ruleset already covers the branch. */
  | "existing-ruleset"
  /** No catalogue check matches a name the repo actually reports. */
  | "no-reported-checks"
  /**
   * The default branch takes direct pushes — or its history could not be
   * read, so it is treated as though it does (Issue #4356). A required-status-
   * checks ruleset would refuse every push there.
   */
  | "direct-push-branch"
  /** The repo opted out via topic `direct-push` or the marker file. */
  | "opted-out";

/** What applying a plan would do to the worker's ruleset. */
export type RulesetAction = "create" | "update" | "delete" | "none";

/**
 * The merge-queue state of the worker's ruleset after a create, an update, or
 * an unchanged run (Issue #4424).
 */
export interface RulesetMergeQueue {
  /** Why the queue was or was not used — see {@link MergeQueueDecision}. */
  verdict: MergeQueueVerdict;
  /** True when the ruleset carries a `merge_queue` rule once written. */
  enabled: boolean;
  /** Human sentence naming the cause; logged when the worker falls back. */
  reason: string;
}

/**
 * Read-only decision for one repo — what {@link ensureDefaultBranchRuleset}
 * would do, computed without writing anything. The merge-queue probe is the
 * one exception: it is created and deleted within the plan's call, and a
 * `readOnly` plan never makes it (Issue #4424).
 */
export interface RulesetPlan {
  action: RulesetAction;
  /** Set when `action` is `none` or `delete`; absent for create/update. */
  skipped?: RulesetSkipReason;
  /** Human-readable reason detail (offending sha/subject, opt-out signal, …). */
  detail?: string;
  /** Contexts a create/update would add to the worker's ruleset. */
  added: string[];
  /** Contexts already required by rulesets, kept as-is. */
  preserved: string[];
  /**
   * Types of the live ruleset's other rules (`pull_request`,
   * `non_fast_forward`, …) an update carries through unchanged (Issue #1290).
   * Empty for every action but `update`.
   */
  preservedRules: string[];
  /**
   * True when the branch still carries a legacy classic protection rule.
   * The worker never writes or deletes it — deleting it is a deliberate
   * human action — but it is reported so an operator can clear it.
   */
  legacyClassicProtection: boolean;
  /** Body a create/update would write. */
  body?: RulesetBody;
  /** Id of the worker's own ruleset, for update/delete. */
  rulesetId?: number;
  /**
   * Merge-queue state a create, an update, or an unchanged run of the worker's
   * ruleset would leave in place (Issue #4424). Absent on every other exit.
   */
  mergeQueue?: RulesetMergeQueue;
}

/** Result of a {@link planDefaultBranchRuleset} call. */
export type PlanRulesetResult =
  | { ok: true; plan: RulesetPlan }
  | { ok: false; error: Error };

/** Result of an {@link ensureDefaultBranchRuleset} call. */
export type EnsureRulesetResult =
  | {
    ok: true;
    /** True when the worker's ruleset was created or updated. */
    changed: boolean;
    /** True when the worker's own stale ruleset was deleted (Issue #4356). */
    deleted: boolean;
    /** Contexts added to the worker's ruleset this run. */
    added: string[];
    /** Contexts already required by rulesets, kept as-is. */
    preserved: string[];
    /** See {@link RulesetPlan.preservedRules}. */
    preservedRules: string[];
    /** Set when no ruleset was created or updated; absent when `changed`. */
    skipped?: RulesetSkipReason;
    /** Human-readable detail for a skip (offending sha/subject, opt-out). */
    detail?: string;
    /** See {@link RulesetPlan.legacyClassicProtection}. */
    legacyClassicProtection: boolean;
    /** See {@link RulesetPlan.mergeQueue}. */
    mergeQueue?: RulesetMergeQueue;
  }
  | { ok: false; error: Error };

// ---------------------------------------------------------------------------
// Merge queue helpers (Issue #4424)
// ---------------------------------------------------------------------------

/** The live ruleset's rules, dropping any entry that is not rule-shaped. */
function liveRules(detail: RulesetDetail): OpaqueRulesetRule[] {
  const rules: unknown[] = Array.isArray(detail.rules) ? detail.rules : [];
  // `?.` covers null and every non-object entry: a primitive has no string
  // `type`, so one test of that field is the whole rule-shape check.
  return rules.filter((rule): rule is OpaqueRulesetRule =>
    typeof (rule as { type?: unknown } | null)?.type === "string"
  );
}

/** Whether the live ruleset carries a `merge_queue` rule, readable or not. */
function liveHasMergeQueueRule(detail: RulesetDetail): boolean {
  return liveRules(detail).some((rule) => rule.type === MERGE_QUEUE_RULE_TYPE);
}

/** The strict up-to-date policy the live status-checks rule carries. */
function liveStrictPolicy(detail: RulesetDetail): unknown {
  const rule = liveRules(detail).find((candidate) =>
    candidate.type === "required_status_checks"
  );
  return rule?.parameters?.strict_required_status_checks_policy;
}

/**
 * The merge queue an update of the worker's ruleset writes (Issue #4424).
 *
 * An enabled decision writes the live queue when there is one, so a queue a
 * human tuned survives, and the decided parameters otherwise. A definitive
 * refusal writes none. An unverified read keeps a live queue (the worker's
 * defaults when its parameters are unreadable) and adds none, so a transient
 * failure never weakens or removes enforcement.
 */
function effectiveMergeQueue(
  decision: MergeQueueDecision,
  live: RulesetDetail,
): MergeQueueParameters | undefined {
  if (decision.verdict === "enabled") {
    return mergeQueueParametersFromDetail(live) ?? decision.parameters;
  }
  if (decision.definitive) return undefined;
  if (!liveHasMergeQueueRule(live)) return undefined;
  return mergeQueueParametersFromDetail(live) ??
    buildMergeQueueParameters("SQUASH");
}

/** The merge-queue state a plan or result records for a decision. */
function mergeQueueState(
  decision: MergeQueueDecision,
  enabled: boolean,
): RulesetMergeQueue {
  return { verdict: decision.verdict, enabled, reason: decision.reason };
}

// ---------------------------------------------------------------------------
// Plan (read-only, bar the merge-queue probe unless readOnly)
// ---------------------------------------------------------------------------

/**
 * Decide, without writing, what the default-branch ruleset sync would do
 * (bar the merge-queue probe, which `readOnly` suppresses; see below).
 *
 * The one write this can make is the merge-queue probe (Issue #4424): where
 * repository metadata cannot settle whether GitHub allows a merge queue, a
 * disabled probe ruleset is created and deleted again to ask GitHub. Every
 * other read is GET-only. With `options.readOnly` set (the audit sweep) no
 * write is made at all: the inconclusive answer is unverified instead.
 *
 * @param repo - `owner/repo` slug.
 * @param options - Branch name, visibility, and optional detected languages.
 * @param ghFn - Injected `gh` executor (defaults to a real `gh` spawn).
 */
export async function planDefaultBranchRuleset(
  repo: string,
  options: EnsureRulesetOptions,
  ghFn: GhExec = defaultGhExec,
): Promise<PlanRulesetResult> {
  // --- Input validation (never trust the caller's slug/branch) ---
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: new Error(`Invalid repo slug: ${repo}`) };
  }
  const branch = options.branch?.trim();
  if (!branch) {
    return { ok: false, error: new Error("Missing default branch name") };
  }
  if (!isValidBranchName(branch)) {
    return { ok: false, error: new Error(`Invalid branch name: ${branch}`) };
  }

  // --- Which ruleset (if any) is ours? ---
  const rulesets = await listRepoRulesets(repo, ghFn);
  if (!rulesets.ok) return { ok: false, error: rulesets.error };
  // Only a *repository* ruleset with our exact name is ours; the list also
  // carries organisation rulesets that apply to the repo, and those are never
  // ours to update or delete.
  const ours = rulesets.value.find((r) =>
    r.name === VIBE_RULESET_NAME &&
    (r.source_type === undefined || r.source_type === "Repository")
  );

  // --- What already covers the branch? ---
  const branchRules = await getBranchRules(repo, branch, ghFn);
  if (!branchRules.ok) return { ok: false, error: branchRules.error };
  const foreignRules = branchRules.value.filter(
    (rule) => ours === undefined || rule.ruleset_id !== ours.id,
  );

  const legacyClassicProtection = await hasClassicBranchProtection(
    repo,
    branch,
    ghFn,
  );

  // Someone else already enforces this branch — defer to them entirely.
  if (foreignRules.length > 0) {
    return {
      ok: true,
      plan: {
        action: "none",
        skipped: "existing-ruleset",
        added: [],
        preserved: requiredContextsFromRules(branchRules.value),
        preservedRules: [],
        legacyClassicProtection,
      },
    };
  }

  // --- Does the branch take direct pushes? (Issue #4356) ---
  // Decided before any write: a required-status-checks ruleset on a branch
  // the fleet pushes to directly refuses every push. A branch that has opted
  // out or demonstrably takes direct pushes also loses the worker's own stale
  // ruleset; an unreadable history skips the write but leaves any existing
  // ruleset alone — the worker acts on evidence in either direction, never on
  // uncertainty.
  const policy = await assessBranchPushPolicy(repo, branch, ghFn);
  if (policy.kind !== "pr-only") {
    const skipped: RulesetSkipReason = policy.kind === "opted-out"
      ? "opted-out"
      : "direct-push-branch";
    // Removal needs evidence the worker can trust (Issue #1289): observed
    // direct pushes (commit history the worker read itself) or the
    // admin-gated `direct-push` topic. The marker file is repository content
    // anyone with write access can land, so it suppresses creation only —
    // never the deletion of protection that already exists.
    const removeOwn = ours !== undefined &&
      (policy.kind === "direct-push" ||
        (policy.kind === "opted-out" && policy.source === "topic"));
    return {
      ok: true,
      plan: {
        action: removeOwn ? "delete" : "none",
        skipped,
        detail: policy.detail,
        added: [],
        preserved: ours ? requiredContextsFromRules(branchRules.value) : [],
        preservedRules: [],
        legacyClassicProtection,
        rulesetId: removeOwn ? ours.id : undefined,
      },
    };
  }

  // --- Desired contexts: catalogue ∩ genuinely reported names ---
  const reported = await getReportedCheckNames(repo, branch, ghFn);
  const reportedSet = new Set(reported.names);
  const desired = reported.ok
    ? Array.from(
      new Set(
        getRequiredChecksForRepo(options.visibility, options.detectedLanguages)
          .map((check) => check.contextNames.find((n) => reportedSet.has(n)))
          .filter((n): n is string => typeof n === "string"),
      ),
    )
    : [];

  const currentContexts = ours
    ? requiredContextsFromRules(branchRules.value)
    : [];
  const currentSet = new Set(currentContexts);
  const added = desired.filter((c) => !currentSet.has(c));

  // Nothing enforceable to require, and no ruleset of ours to keep current.
  if (added.length === 0 && ours === undefined) {
    return {
      ok: true,
      plan: {
        action: "none",
        skipped: "no-reported-checks",
        added: [],
        preserved: [],
        preservedRules: [],
        legacyClassicProtection,
      },
    };
  }

  // --- Converge additively (union of current and desired) ---
  const contexts = [...currentContexts, ...added];

  // --- Merge queue (Issue #4424): on where GitHub allows it, else strict ---
  const decision = await decideMergeQueue(
    repo,
    branch,
    contexts,
    options.readOnly !== true,
    ghFn,
  );

  if (ours === undefined) {
    return {
      ok: true,
      plan: {
        action: "create",
        added,
        preserved: currentContexts,
        preservedRules: [],
        legacyClassicProtection,
        body: buildDefaultBranchRulesetBody(
          VIBE_RULESET_NAME,
          contexts,
          decision.parameters,
        ),
        mergeQueue: mergeQueueState(
          decision,
          decision.parameters !== undefined,
        ),
      },
    };
  }

  // The update is a full-document PUT, so the live ruleset must be read before
  // it is rewritten: a body built from status checks alone silently discards
  // every other rule an admin added (Issue #1290). An unreadable ruleset fails
  // the run loudly rather than overwriting rules the worker never saw. The
  // live ruleset is read even when nothing needs adding, because the merge
  // queue state may have drifted (Issue #4424).
  const live = await getRuleset(repo, ours.id, ghFn);
  if (!live.ok) {
    return {
      ok: false,
      error: new Error(
        `Refusing to update ruleset ${ours.id} in ${repo}: its current rules ` +
          `could not be read (${live.error.message})`,
      ),
    };
  }

  const queue = effectiveMergeQueue(decision, live.value);
  const mergeQueue = mergeQueueState(decision, queue !== undefined);
  // Drift: the queue rule is present or absent differently from what is
  // wanted, or the queue is wanted but strict up-to-date is still on.
  const drift = (queue !== undefined) !== liveHasMergeQueueRule(live.value) ||
    (queue !== undefined && liveStrictPolicy(live.value) !== false);

  // Our ruleset already requires everything satisfiable and carries the queue
  // state it should — genuine no-op.
  if (added.length === 0 && !drift) {
    return {
      ok: true,
      plan: {
        action: "none",
        skipped: "existing-ruleset",
        added: [],
        preserved: currentContexts,
        preservedRules: [],
        legacyClassicProtection,
        rulesetId: ours.id,
        mergeQueue,
      },
    };
  }

  return {
    ok: true,
    plan: {
      action: "update",
      added,
      preserved: currentContexts,
      preservedRules: preservedRulesFromDetail(live.value).map((r) => r.type),
      legacyClassicProtection,
      body: buildDefaultBranchRulesetUpdateBody(
        VIBE_RULESET_NAME,
        contexts,
        live.value,
        queue,
      ),
      rulesetId: ours.id,
      mergeQueue,
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point (plan + apply)
// ---------------------------------------------------------------------------

/**
 * Idempotently ensure the default branch is covered by a ruleset requiring the
 * satisfiable status checks, with either an up-to-date branch or — where GitHub
 * allows one and every required check reports on `merge_group` — a merge queue
 * (Issue #4424). On a direct-push branch the worker's own ruleset is absent.
 *
 * @param repo - `owner/repo` slug.
 * @param options - Branch name, visibility, and optional detected languages.
 * @param ghFn - Injected `gh` executor (defaults to a real `gh` spawn).
 */
export async function ensureDefaultBranchRuleset(
  repo: string,
  options: EnsureRulesetOptions,
  ghFn: GhExec = defaultGhExec,
): Promise<EnsureRulesetResult> {
  const planned = await planDefaultBranchRuleset(repo, options, ghFn);
  if (!planned.ok) return planned;
  const plan = planned.plan;

  const common = {
    added: plan.added,
    preserved: plan.preserved,
    preservedRules: plan.preservedRules,
    skipped: plan.skipped,
    detail: plan.detail,
    legacyClassicProtection: plan.legacyClassicProtection,
  };
  // Present only when the plan decided a merge-queue state (Issue #4424).
  const queue = plan.mergeQueue ? { mergeQueue: plan.mergeQueue } : {};

  switch (plan.action) {
    case "none":
      return { ok: true, changed: false, deleted: false, ...common, ...queue };
    case "delete": {
      const removed = await deleteRuleset(repo, plan.rulesetId!, ghFn);
      if (!removed.ok) return { ok: false, error: removed.error };
      return { ok: true, changed: false, deleted: true, ...common };
    }
    case "create":
    case "update": {
      const written = plan.action === "update"
        ? await updateRuleset(repo, plan.rulesetId!, plan.body!, ghFn)
        : await createRuleset(repo, plan.body!, ghFn);
      if (!written.ok) return { ok: false, error: written.error };
      return { ok: true, changed: true, deleted: false, ...common, ...queue };
    }
  }
}
