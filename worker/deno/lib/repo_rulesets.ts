/**
 * Repository **ruleset** primitives (Issue #4163).
 *
 * GitHub has moved branch enforcement from classic branch protection
 * (`PUT /repos/{repo}/branches/{branch}/protection`) to **repository
 * rulesets**. Classic protection is the legacy surface: on a repo that already
 * enforces through a ruleset, a classic rule is redundant at best, and — when
 * it names a status context nothing reports any more — it blocks every merge
 * with a permanent "Expected — Waiting for status to be reported".
 *
 * This module is the read/write surface for rulesets (create, update, and —
 * for the worker's own ruleset only — delete, Issue #4356). It deliberately
 * exposes **no** classic-protection writer; the only classic endpoint touched anywhere
 * is the read in {@link hasClassicBranchProtection}, used to *report* a
 * leftover legacy rule so an operator can delete it.
 *
 * The `gh` executor is injected for testability (mirrors the mock pattern in
 * `setup/collaborator_precheck.ts`).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { classifyGitHubError, GitHubErrorCategory } from "./github_errors.ts";
import { runGhOrThrow } from "./gh_spawn.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injectable `gh` executor.
 *
 * Receives the argument list for a `gh` invocation and an optional `stdin`
 * payload (used to feed a JSON body to `gh api ... --input -`). Returns the
 * trimmed stdout on success and throws on failure — a thrown error whose
 * message classifies as {@link GitHubErrorCategory.NotFound} is treated as
 * "not configured" by the readers below.
 */
export type GhExec = (args: string[], stdin?: string) => Promise<string>;

/** One rule as `GET /repos/{repo}/rules/branches/{branch}` returns it. */
export interface BranchRule {
  type: string;
  ruleset_id?: number;
  ruleset_source?: string;
  ruleset_source_type?: string;
  parameters?: {
    strict_required_status_checks_policy?: boolean;
    required_status_checks?: Array<{ context?: string }>;
  };
}

/** One entry of `GET /repos/{repo}/rulesets` (summary shape — no rules). */
export interface RulesetSummary {
  id: number;
  name: string;
  target?: string;
  enforcement?: string;
  source_type?: string;
}

/** A bypass actor, as the ruleset create/update calls accept it. */
export interface RulesetBypassActorBody {
  actor_type: "RepositoryRole" | "Team" | "Integration" | "OrganizationAdmin";
  actor_id: number;
  bypass_mode: "always" | "pull_request";
}

/**
 * One required check. `integration_id` pins the check to the app that reports
 * it; omitted, any reporter of that context name satisfies it.
 */
export interface RequiredStatusCheckBody {
  context: string;
  integration_id?: number;
}

/** A ruleset's enforcement status, as GitHub accepts it. */
export type RulesetEnforcement = "active" | "disabled" | "evaluate";

/** Parameters of a `merge_queue` ruleset rule, as GitHub accepts them. */
export interface MergeQueueParameters {
  check_response_timeout_minutes: number;
  grouping_strategy: "ALLGREEN" | "HEADGREEN";
  max_entries_to_build: number;
  max_entries_to_merge: number;
  merge_method: "MERGE" | "SQUASH" | "REBASE";
  min_entries_to_merge: number;
  min_entries_to_merge_wait_minutes: number;
}

/**
 * One rule this module models and writes.
 *
 * A rule the module does *not* model — anything an admin added to the live
 * ruleset — is carried through as an opaque {@link OpaqueRulesetRule} rather
 * than being dropped (Issue #1290).
 */
export type RulesetRuleBody =
  | {
    type: "required_status_checks";
    parameters: {
      strict_required_status_checks_policy: boolean;
      required_status_checks: RequiredStatusCheckBody[];
      /**
       * When true the checks gate the MERGE but not branch creation. A branch
       * that does not exist yet has no check runs, so without this the push
       * that would create it is declined (Issue #2067).
       */
      do_not_enforce_on_create?: boolean;
    };
  }
  | { type: "merge_queue"; parameters: MergeQueueParameters }
  | { type: "deletion" | "non_fast_forward" };

/**
 * A rule read back from a live ruleset whose shape this module does not model
 * (`pull_request`, `required_signatures`, …). Preserved verbatim on update.
 */
export interface OpaqueRulesetRule {
  type: string;
  parameters?: Record<string, unknown>;
}

/** Full detail of one ruleset (`GET /repos/{repo}/rulesets/{id}`). */
export interface RulesetDetail {
  id: number;
  name: string;
  target?: string;
  enforcement?: string;
  rules?: OpaqueRulesetRule[];
  bypass_actors?: RulesetBypassActorBody[];
}

/** Body accepted by the ruleset create (`POST`) and update (`PUT`) calls. */
export interface RulesetBody {
  name: string;
  target: "branch";
  enforcement: RulesetEnforcement;
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Array<RulesetRuleBody | OpaqueRulesetRule>;
  /** Actors exempt from the rules. Omitted when nothing is exempt. */
  bypass_actors?: RulesetBypassActorBody[];
}

/** Success/failure envelope so callers never have to catch. */
export type RulesetResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

// ---------------------------------------------------------------------------
// Default executor
// ---------------------------------------------------------------------------

/**
 * Default production `gh` executor. Spawns `gh` via the shared chokepoint
 * (Issue #3703) so every ruleset mutation is allowlist-checked and journalled,
 * optionally piping a JSON body to stdin (for `--input -`).
 */
export async function defaultGhExec(
  args: string[],
  stdin?: string,
): Promise<string> {
  const stdout = await runGhOrThrow(
    args,
    stdin !== undefined ? { stdin } : {},
  );
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Validate an `owner/repo` slug (allowlist — no shell metacharacters). */
export function isValidRepoSlug(repo: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo);
}

/**
 * Validate a git branch name for interpolation into an API path.
 *
 * Allowlist only: letters, digits, and `._/-`. A name with a shell
 * metacharacter, a space, or a path traversal segment is rejected outright
 * rather than escaped.
 */
export function isValidBranchName(branch: string): boolean {
  if (!/^[A-Za-z0-9._\/-]+$/.test(branch)) return false;
  return !branch.split("/").includes("..");
}

/** True when the thrown `gh` error is a 404 (nothing configured / absent). */
export function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return classifyGitHubError(message).category === GitHubErrorCategory.NotFound;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Read the rules that currently apply to a branch, from every ruleset
 * (repository **and** organisation) that covers it.
 *
 * `GET /repos/{repo}/rules/branches/{branch}` answers "is this branch covered
 * by a ruleset, and with what?" in a single call — no per-ruleset condition
 * evaluation needed. A 404 means the branch (or the repo) has no rules and is
 * reported as an empty list, not an error.
 */
export async function getBranchRules(
  repo: string,
  branch: string,
  ghFn: GhExec = defaultGhExec,
): Promise<RulesetResult<BranchRule[]>> {
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: new Error(`Invalid repo slug: ${repo}`) };
  }
  if (!isValidBranchName(branch)) {
    return { ok: false, error: new Error(`Invalid branch name: ${branch}`) };
  }
  try {
    const raw = await ghFn(["api", `repos/${repo}/rules/branches/${branch}`]);
    if (!raw) return { ok: true, value: [] };
    const parsed = JSON.parse(raw);
    return { ok: true, value: Array.isArray(parsed) ? parsed : [] };
  } catch (error) {
    if (isNotFoundError(error)) return { ok: true, value: [] };
    return { ok: false, error: toError(error) };
  }
}

/** List the repository's own rulesets (summary shape). */
export async function listRepoRulesets(
  repo: string,
  ghFn: GhExec = defaultGhExec,
): Promise<RulesetResult<RulesetSummary[]>> {
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: new Error(`Invalid repo slug: ${repo}`) };
  }
  try {
    const raw = await ghFn(["api", `repos/${repo}/rulesets`]);
    if (!raw) return { ok: true, value: [] };
    const parsed = JSON.parse(raw);
    return { ok: true, value: Array.isArray(parsed) ? parsed : [] };
  } catch (error) {
    if (isNotFoundError(error)) return { ok: true, value: [] };
    return { ok: false, error: toError(error) };
  }
}

/**
 * Read one ruleset in full (`GET /repos/{repo}/rulesets/{id}`).
 *
 * The list endpoint returns a summary with no `rules` and no `bypass_actors`,
 * so this is the only way to see what a ruleset actually enforces before a
 * full-document PUT replaces it (Issue #1290). Every failure — a 404 included
 * — is reported as an error: a caller about to overwrite the document must
 * never read "could not see it" as "there was nothing there".
 */
export async function getRuleset(
  repo: string,
  rulesetId: number,
  ghFn: GhExec = defaultGhExec,
): Promise<RulesetResult<RulesetDetail>> {
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: new Error(`Invalid repo slug: ${repo}`) };
  }
  if (!Number.isInteger(rulesetId) || rulesetId <= 0) {
    return { ok: false, error: new Error(`Invalid ruleset id: ${rulesetId}`) };
  }
  try {
    const raw = await ghFn(["api", `repos/${repo}/rulesets/${rulesetId}`]);
    const parsed = raw ? JSON.parse(raw) : undefined;
    if (parsed === null || typeof parsed !== "object") {
      return {
        ok: false,
        error: new Error(`Unreadable ruleset ${rulesetId} in ${repo}`),
      };
    }
    return { ok: true, value: parsed as RulesetDetail };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}

/**
 * True when the branch still carries a **classic** protection rule.
 *
 * Read-only. The worker no longer writes classic protection (Issue #4163);
 * this exists so a leftover legacy rule can be reported to an operator, since
 * a classic rule demanding a context nothing reports blocks every merge even
 * when the ruleset's own required checks are green.
 */
export async function hasClassicBranchProtection(
  repo: string,
  branch: string,
  ghFn: GhExec = defaultGhExec,
): Promise<boolean> {
  if (!isValidRepoSlug(repo) || !isValidBranchName(branch)) return false;
  try {
    await ghFn(["api", `repos/${repo}/branches/${branch}/protection`]);
    return true;
  } catch {
    // 404 (unprotected) and permission/read failures alike: report "no legacy
    // rule seen" rather than inventing one. A false negative only costs the
    // operator hint, never enforcement.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rule inspection
// ---------------------------------------------------------------------------

/** Required status-check contexts named by a set of branch rules. */
export function requiredContextsFromRules(rules: BranchRule[]): string[] {
  const contexts: string[] = [];
  for (const rule of rules) {
    if (rule.type !== "required_status_checks") continue;
    for (const check of rule.parameters?.required_status_checks ?? []) {
      if (typeof check.context === "string" && check.context.length > 0) {
        contexts.push(check.context);
      }
    }
  }
  return [...new Set(contexts)];
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/**
 * Build the body for a default-branch ruleset requiring `contexts`.
 *
 * Without `mergeQueue` the branch must also be up to date (strict). With
 * `mergeQueue` the ruleset gains a `merge_queue` rule appended after the
 * status-checks rule, and the strict policy is turned off: the queue itself
 * builds each entry on top of the base, so an up-to-date requirement is not
 * wanted alongside it.
 *
 * `~DEFAULT_BRANCH` is GitHub's built-in ref alias, so the ruleset keeps
 * tracking the default branch if it is ever renamed.
 */
export function buildDefaultBranchRulesetBody(
  name: string,
  contexts: string[],
  mergeQueue?: MergeQueueParameters,
): RulesetBody {
  const rules: RulesetRuleBody[] = [
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: mergeQueue === undefined,
        required_status_checks: contexts.map((context) => ({ context })),
      },
    },
  ];
  if (mergeQueue !== undefined) {
    rules.push({ type: "merge_queue", parameters: mergeQueue });
  }
  return {
    name,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules,
  };
}

/**
 * Type guard selecting the modelled required-status-checks rule of a body.
 *
 * `rules` also carries opaque rules preserved from a live ruleset, so the
 * shape is checked as well as the type — an entry that merely claims the type
 * without carrying parameters is not the rule this module writes.
 */
export function isRequiredStatusChecksRule(
  rule: RulesetRuleBody | OpaqueRulesetRule,
): rule is Extract<RulesetRuleBody, { type: "required_status_checks" }> {
  return rule.type === "required_status_checks" && "parameters" in rule &&
    rule.parameters !== undefined;
}

/**
 * Rules of the live ruleset that {@link buildDefaultBranchRulesetBody} does
 * not model — everything except the required-status-checks rule it rewrites
 * and the `merge_queue` rule the configurator now owns (it is rebuilt from the
 * `mergeQueue` argument or deliberately dropped; see
 * {@link buildDefaultBranchRulesetUpdateBody}).
 *
 * Entries that are not rule-shaped objects are dropped: the input is an API
 * response, so it is validated before it is written back.
 */
export function preservedRulesFromDetail(
  existing: RulesetDetail,
): OpaqueRulesetRule[] {
  const rules = Array.isArray(existing.rules) ? existing.rules : [];
  return rules.filter((rule): rule is OpaqueRulesetRule =>
    rule !== null && typeof rule === "object" &&
    typeof rule.type === "string" &&
    rule.type !== "required_status_checks" && rule.type !== "merge_queue"
  );
}

/**
 * The `merge_queue` rule parameters of a live ruleset, or `undefined`.
 *
 * Returns the parameters only when the rule is present and all seven fields
 * carry the right type (integers for the counts and minutes, the enum values
 * for `grouping_strategy` and `merge_method`). Anything else — no rule, a
 * malformed rule, a field GitHub does not accept — is `undefined`, because the
 * response is validated before anything is read back from it.
 */
export function mergeQueueParametersFromDetail(
  existing: RulesetDetail,
): MergeQueueParameters | undefined {
  const rules = Array.isArray(existing.rules) ? existing.rules : [];
  const rule = rules.find((candidate) =>
    candidate !== null && typeof candidate === "object" &&
    candidate.type === "merge_queue"
  );
  const parameters: unknown = rule?.parameters;
  if (parameters === null || typeof parameters !== "object") return undefined;
  const p = parameters as Record<string, unknown>;
  const isCount = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value);
  if (
    !isCount(p.check_response_timeout_minutes) ||
    !isCount(p.max_entries_to_build) ||
    !isCount(p.max_entries_to_merge) ||
    !isCount(p.min_entries_to_merge) ||
    !isCount(p.min_entries_to_merge_wait_minutes)
  ) {
    return undefined;
  }
  if (
    p.grouping_strategy !== "ALLGREEN" && p.grouping_strategy !== "HEADGREEN"
  ) {
    return undefined;
  }
  if (
    p.merge_method !== "MERGE" && p.merge_method !== "SQUASH" &&
    p.merge_method !== "REBASE"
  ) {
    return undefined;
  }
  return {
    check_response_timeout_minutes: p.check_response_timeout_minutes,
    grouping_strategy: p.grouping_strategy,
    max_entries_to_build: p.max_entries_to_build,
    max_entries_to_merge: p.max_entries_to_merge,
    merge_method: p.merge_method,
    min_entries_to_merge: p.min_entries_to_merge,
    min_entries_to_merge_wait_minutes: p.min_entries_to_merge_wait_minutes,
  };
}

/**
 * Required checks the live ruleset already enforces, across every
 * `required_status_checks` rule it carries (Issue #4487).
 *
 * A missing or malformed rules array, or a malformed
 * `required_status_checks` rule, throws rather than being dropped or stripped, so a
 * reconcile never writes back a body that silently forgets a live check. That
 * covers a non-object entry, a `context` that is not a non-empty string, an
 * `integration_id` that is present (not `undefined` or `null`) but not an
 * integer, and a `required_status_checks` value that is not an array. Every
 * entry is validated before de-duplication. Exact duplicate checks keep the
 * first entry; checks with distinct `integration_id`s remain distinct.
 *
 * @throws Error naming the malformed live check.
 */
function liveRequiredChecks(
  existing: RulesetDetail,
): RequiredStatusCheckBody[] {
  if (!Array.isArray(existing.rules)) {
    throw new Error(
      "Refusing to rewrite required checks: live rules is not an array",
    );
  }
  const checks = new Map<string, RequiredStatusCheckBody>();
  const keyFor = (check: RequiredStatusCheckBody) =>
    JSON.stringify([check.context, check.integration_id ?? null]);
  const rules: unknown[] = existing.rules;
  for (const [ruleIndex, rule] of rules.entries()) {
    if (rule === null || typeof rule !== "object") continue;
    if ((rule as { type?: unknown }).type !== "required_status_checks") {
      continue;
    }
    const parameters: unknown = (rule as { parameters?: unknown }).parameters;
    if (parameters === null || typeof parameters !== "object") {
      throw new Error(
        `Refusing to rewrite required checks: live rule ${ruleIndex} has no parameters object`,
      );
    }
    const entries: unknown =
      (parameters as Record<string, unknown>).required_status_checks;
    if (entries === undefined) {
      throw new Error(
        `Refusing to rewrite required checks: live rule ${ruleIndex} has no required_status_checks array`,
      );
    }
    if (!Array.isArray(entries)) {
      throw new Error(
        `Refusing to rewrite required checks: required_status_checks of live ` +
          `rule ${ruleIndex} is not an array`,
      );
    }
    for (const [checkIndex, entry] of (entries as unknown[]).entries()) {
      const where = `live required check ${checkIndex} of rule ${ruleIndex}`;
      if (entry === null || typeof entry !== "object") {
        throw new Error(
          `Refusing to rewrite required checks: ${where} is not an object`,
        );
      }
      const { context, integration_id: integrationId } = entry as Record<
        string,
        unknown
      >;
      if (typeof context !== "string" || context.length === 0) {
        throw new Error(
          `Refusing to rewrite required checks: ${where} has no usable context`,
        );
      }
      if (
        integrationId !== undefined && integrationId !== null &&
        !(typeof integrationId === "number" && Number.isInteger(integrationId))
      ) {
        throw new Error(
          `Refusing to rewrite required checks: ${where} has a non-integer ` +
            `integration_id for context "${context}"`,
        );
      }
      const check = typeof integrationId === "number"
        ? { context, integration_id: integrationId }
        : { context };
      const key = keyFor(check);
      if (!checks.has(key)) checks.set(key, check);
    }
  }
  return [...checks.values()];
}

/**
 * The checks the status-checks rule writes: the worker's `contexts` in order,
 * each omitted when that context is already live, followed by the live checks
 * in live order. Distinct live `integration_id`s for one context are retained;
 * exact duplicate context/app pairs keep the first entry (Issue #4487).
 */
function unionRequiredChecks(
  contexts: string[],
  live: RequiredStatusCheckBody[],
): RequiredStatusCheckBody[] {
  const written = new Map<string, RequiredStatusCheckBody>();
  const liveByContext = new Map<string, RequiredStatusCheckBody[]>();
  for (const check of live) {
    const checks = liveByContext.get(check.context) ?? [];
    checks.push(check);
    liveByContext.set(check.context, checks);
  }
  const keyFor = (check: RequiredStatusCheckBody) =>
    JSON.stringify([check.context, check.integration_id ?? null]);
  for (const context of contexts) {
    const liveChecks = liveByContext.get(context);
    for (const check of liveChecks ?? [{ context }]) {
      const key = keyFor(check);
      if (!written.has(key)) written.set(key, check);
    }
  }
  for (const check of live) {
    const key = keyFor(check);
    if (!written.has(key)) written.set(key, check);
  }
  return [...written.values()];
}

/**
 * Build the **update** body for the worker's default-branch ruleset.
 *
 * The update is a full-document PUT, so a body rebuilt from status checks
 * alone silently discards every other rule an admin added — required reviews,
 * force-push protection, deletion protection, bypass actors (Issue #1290).
 * This rewrites only the `required_status_checks` rule, as the union of
 * `contexts` and the checks the live ruleset already requires, each live check
 * keeping its `integration_id`. The update PUT therefore never drops a check the
 * live ruleset requires; it never removes a check, so pruning one is a
 * deliberate human action. Every other rule and the bypass actors of the live
 * ruleset are carried through unchanged.
 *
 * The live `merge_queue` rule, if any, is never carried through: it is
 * replaced by a rule built from `mergeQueue` when one is given, and dropped
 * otherwise. So a re-run never duplicates the rule.
 *
 * @throws Error when the live rules array or required-check rule is malformed
 *   (see {@link liveRequiredChecks}), so nothing is built and nothing is
 *   written.
 */
export function buildDefaultBranchRulesetUpdateBody(
  name: string,
  contexts: string[],
  existing: RulesetDetail,
  mergeQueue?: MergeQueueParameters,
): RulesetBody {
  const base = buildDefaultBranchRulesetBody(name, contexts, mergeQueue);
  const live = liveRequiredChecks(existing);
  const rules: RulesetBody["rules"] = base.rules.map((rule) =>
    isRequiredStatusChecksRule(rule)
      ? {
        ...rule,
        parameters: {
          ...rule.parameters,
          required_status_checks: unionRequiredChecks(contexts, live),
        },
      }
      : rule
  );
  const bypassActors = Array.isArray(existing.bypass_actors)
    ? existing.bypass_actors
    : [];
  return {
    ...base,
    rules: [...preservedRulesFromDetail(existing), ...rules],
    ...(bypassActors.length > 0 ? { bypass_actors: bypassActors } : {}),
  };
}

/** Ref pattern the milestone ruleset targets. */
export const MILESTONE_REF_PATTERN = "refs/heads/milestone/**";

/**
 * Build the body for the `milestone/**` ruleset — GRQ-AutoTrader's "milestone
 * branches" template (Issue #2623).
 *
 * Deliberately carries NO `pull_request` rule: milestone branches are the
 * fleet's own collection branches, and a review gate there would put a human
 * in front of every child PR — review belongs on the default branch (Issue
 * #586). Required checks alone are what makes a milestone PR auto-mergeable,
 * which is the whole point.
 *
 * `deletion` and `non_fast_forward` mirror the default-branch ruleset: a
 * collection branch that can be force-pushed or deleted loses the chain.
 * With no checks to mirror those two are the whole ruleset — a guessed check
 * would block every milestone PR on a context that never reports.
 *
 * The checks are exempt on **creation** (Issue #2067). GitHub evaluates
 * `required_status_checks` against the pushed commit, and a branch that does
 * not exist yet has no check runs — so a ruleset written without
 * `do_not_enforce_on_create` refuses the very push that would open the
 * milestone branch it exists to protect. The flag is the remedy rather than
 * dropping the rule: the checks still gate every merge, and
 * `required_status_checks` must stay present because that is what makes the
 * base protected enough for auto-merge to be armed (`pr_auto_merge.ts`).
 *
 * The strict up-to-date policy is off, as the template has it (Issue #2623).
 *
 * @param checks - Required checks, each keeping its `integration_id` if any.
 * @param enforcement - Kept from an existing ruleset when aligning one; a
 *   human's `disabled` or `evaluate` is never overridden.
 */
export function buildMilestoneRulesetBody(
  name: string,
  checks: readonly RequiredStatusCheckBody[],
  bypassActors: RulesetBypassActorBody[] = [],
  enforcement: RulesetEnforcement = "active",
): RulesetBody {
  const rules: RulesetRuleBody[] = [
    { type: "deletion" },
    { type: "non_fast_forward" },
  ];
  if (checks.length > 0) {
    rules.push({
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: true,
        required_status_checks: checks.map((check) => ({ ...check })),
      },
    });
  }
  return {
    name,
    target: "branch",
    enforcement,
    conditions: {
      ref_name: { include: [MILESTONE_REF_PATTERN], exclude: [] },
    },
    rules,
    ...(bypassActors.length > 0 ? { bypass_actors: bypassActors } : {}),
  };
}

/** Create a repository ruleset. */
export async function createRuleset(
  repo: string,
  body: RulesetBody,
  ghFn: GhExec = defaultGhExec,
): Promise<RulesetResult<void>> {
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: new Error(`Invalid repo slug: ${repo}`) };
  }
  try {
    await ghFn(
      ["api", "-X", "POST", `repos/${repo}/rulesets`, "--input", "-"],
      JSON.stringify(body),
    );
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}

/**
 * The create call succeeded but its response carried no usable ruleset id.
 *
 * A distinct class so a caller can tell "the ruleset was not created" (a
 * plain create error) from "it may have been created and its id is unknown".
 */
export class RulesetIdUnreadableError extends Error {}

/**
 * Create a repository ruleset and return the id GitHub assigned to it.
 *
 * Same validation and request as {@link createRuleset}; the difference is that
 * the JSON response is parsed for its positive-integer `id`. An unparseable
 * response, or one without a usable id, is a {@link RulesetIdUnreadableError}.
 */
export async function createRulesetReturningId(
  repo: string,
  body: RulesetBody,
  ghFn: GhExec = defaultGhExec,
): Promise<RulesetResult<number>> {
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: new Error(`Invalid repo slug: ${repo}`) };
  }
  let raw: string;
  try {
    raw = await ghFn(
      ["api", "-X", "POST", `repos/${repo}/rulesets`, "--input", "-"],
      JSON.stringify(body),
    );
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: new RulesetIdUnreadableError(
        `Unreadable ruleset create response for ${repo}: not JSON`,
      ),
    };
  }
  const id = parsed !== null && typeof parsed === "object"
    ? (parsed as { id?: unknown }).id
    : undefined;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    return {
      ok: false,
      error: new RulesetIdUnreadableError(
        `Unreadable ruleset create response for ${repo}: no ruleset id`,
      ),
    };
  }
  return { ok: true, value: id };
}

/** Update an existing repository ruleset in place. */
export async function updateRuleset(
  repo: string,
  rulesetId: number,
  body: RulesetBody,
  ghFn: GhExec = defaultGhExec,
): Promise<RulesetResult<void>> {
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: new Error(`Invalid repo slug: ${repo}`) };
  }
  if (!Number.isInteger(rulesetId) || rulesetId <= 0) {
    return { ok: false, error: new Error(`Invalid ruleset id: ${rulesetId}`) };
  }
  try {
    await ghFn(
      [
        "api",
        "-X",
        "PUT",
        `repos/${repo}/rulesets/${rulesetId}`,
        "--input",
        "-",
      ],
      JSON.stringify(body),
    );
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}

/**
 * Delete a repository ruleset.
 *
 * Exists so the configurator can remove **its own** stale ruleset from a
 * branch that turns out to take direct pushes (Issue #4356). The caller is
 * responsible for passing only the id of the ruleset it owns — this primitive
 * does not know names.
 */
export async function deleteRuleset(
  repo: string,
  rulesetId: number,
  ghFn: GhExec = defaultGhExec,
): Promise<RulesetResult<void>> {
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: new Error(`Invalid repo slug: ${repo}`) };
  }
  if (!Number.isInteger(rulesetId) || rulesetId <= 0) {
    return { ok: false, error: new Error(`Invalid ruleset id: ${rulesetId}`) };
  }
  try {
    await ghFn(["api", "-X", "DELETE", `repos/${repo}/rulesets/${rulesetId}`]);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}
