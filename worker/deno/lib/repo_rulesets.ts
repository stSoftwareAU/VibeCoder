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
      required_status_checks: Array<{ context: string }>;
    };
  }
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
  enforcement: "active";
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
 * Build the body for a default-branch ruleset requiring `contexts` and an
 * up-to-date branch.
 *
 * `~DEFAULT_BRANCH` is GitHub's built-in ref alias, so the ruleset keeps
 * tracking the default branch if it is ever renamed.
 */
export function buildDefaultBranchRulesetBody(
  name: string,
  contexts: string[],
): RulesetBody {
  return {
    name,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: contexts.map((context) => ({ context })),
        },
      },
    ],
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
 * not model — everything except the required-status-checks rule it rewrites.
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
    typeof rule.type === "string" && rule.type !== "required_status_checks"
  );
}

/**
 * Build the **update** body for the worker's default-branch ruleset.
 *
 * The update is a full-document PUT, so a body rebuilt from status checks
 * alone silently discards every other rule an admin added — required reviews,
 * force-push protection, deletion protection, bypass actors (Issue #1290).
 * This replaces only the `required_status_checks` rule and carries every other
 * rule and the bypass actors of the live ruleset through unchanged.
 */
export function buildDefaultBranchRulesetUpdateBody(
  name: string,
  contexts: string[],
  existing: RulesetDetail,
): RulesetBody {
  const base = buildDefaultBranchRulesetBody(name, contexts);
  const bypassActors = Array.isArray(existing.bypass_actors)
    ? existing.bypass_actors
    : [];
  return {
    ...base,
    rules: [...preservedRulesFromDetail(existing), ...base.rules],
    ...(bypassActors.length > 0 ? { bypass_actors: bypassActors } : {}),
  };
}

/** Ref pattern the milestone ruleset targets. */
export const MILESTONE_REF_PATTERN = "refs/heads/milestone/**";

/**
 * Build the body for the `milestone/**` ruleset.
 *
 * Deliberately carries NO `pull_request` rule: milestone branches are the
 * fleet's own collection branches, and a review gate there would put a human
 * in front of every child PR — review belongs on the default branch (Issue
 * #586). Required checks alone are what makes a milestone PR auto-mergeable,
 * which is the whole point.
 *
 * `deletion` and `non_fast_forward` mirror the default-branch ruleset: a
 * collection branch that can be force-pushed or deleted loses the chain.
 */
export function buildMilestoneRulesetBody(
  name: string,
  contexts: string[],
  bypassActors: RulesetBypassActorBody[] = [],
): RulesetBody {
  return {
    name,
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: { include: [MILESTONE_REF_PATTERN], exclude: [] },
    },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: contexts.map((context) => ({ context })),
        },
      },
    ],
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
