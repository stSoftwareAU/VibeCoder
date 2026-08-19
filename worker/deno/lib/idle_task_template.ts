/**
 * Idle-task template registry (Issue #1960).
 *
 * The idle-task framework lets the worker perform background units of work
 * (security scans, maintainability reviews, etc.) when no claimable issues
 * exist. Each unit of work is described by an `IdleTaskTemplate`. Templates
 * are registered into a module-level map at import time so callers do not
 * need to invoke a setup function.
 *
 * This file provides only the registry foundation — issue filing, dispatch,
 * and claim handling are implemented in subsequent sub-issues of #1959.
 */

import type { ModelTier } from "./token_usage.ts";

/** Options passed to {@link IdleTaskTemplate.buildIssueBody}. */
export interface IdleTaskBodyOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
  /** ISO-8601 timestamp marking when the idle task was picked. */
  pickedAt: string;
  /** Worker user login filing the issue. */
  workerUser: string;
}

/**
 * Options passed to {@link IdleTaskTemplate.shouldFile} (Issue #2056).
 *
 * Templates use these to decide whether the framework should file a fresh
 * idle-task issue in a given repo right now. Returning `false` lets a
 * template say "the previous batch of work I produced is still being
 * triaged — do not queue another run yet" (e.g. security-scan refuses to
 * re-run while open `security` findings remain).
 */
export interface IdleTaskShouldFileOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
}

/** Options passed to {@link IdleTaskTemplate.runTask} (Issue #1965). */
export interface IdleTaskRunOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
  /**
   * PARENT working directory holding every repo clone side by side, NOT the
   * target checkout — `setupRepo` checks each repo out at
   * `${workDir}/${repoName}`. A native detector that reads the repo tree must
   * derive the checkout with `repoCheckoutPath(workDir, repo)` (Issues #2880,
   * #3292); passing the bare parent reads the wrong tree.
   */
  workDir: string;
  /** Issue number of the filed idle-task issue. */
  idleTaskIssueNumber: number;
  /**
   * Model tier this wrapper was filed for (Issue #4003/#4010), recovered from
   * the wrapper body's attribution-footer stamp and allowlisted against
   * {@link ModelTier}. Undefined — the case for every randomly-picked wrapper
   * — means "leave the model unset", so the run keeps its template/phase
   * default exactly as before.
   */
  modelTier?: ModelTier;
}

/** Result returned from {@link IdleTaskTemplate.runTask}. */
export interface IdleTaskRunResult {
  /** Whether the task completed successfully. */
  ok: boolean;
  /** Short human-readable summary suitable for an issue comment. */
  summary: string;
}

/**
 * A unit of background work the worker can perform.
 *
 * Implementations describe how an `idle-task` issue is titled and bodied
 * for a given target repository. The framework files the issue, the worker
 * later claims it and dispatches to the template-specific handler (added
 * in a later sub-issue).
 */
export interface IdleTaskTemplate {
  /**
   * Template slug — lowercase letters, digits, and hyphens; no leading or
   * trailing hyphen. Used in the idle-task issue marker and as the dedup key.
   */
  name: string;
  /** Short human-readable description embedded in the filed issue body. */
  description: string;
  /**
   * Produces the title for the filed idle-task issue.
   *
   * The `repo` argument is supplied for templates that want to embed
   * it; templates that prefer a human-style, repo-independent title
   * (e.g. `security-scan` files `Run a security scan` — see Issue
   * #2077) may ignore it. Dispatch matches issues to templates by
   * comparing this title to the claimed issue's title.
   */
  buildIssueTitle(repo: string): string;
  /**
   * Produces the body for the filed idle-task issue.
   *
   * Issue #2077: a template may return a Promise so it can load and
   * substitute a prompt file (security-scan does this to keep the
   * filed wrapper indistinguishable from a hand-typed issue).
   */
  buildIssueBody(opts: IdleTaskBodyOptions): string | Promise<string>;
  /**
   * Optionally veto filing a fresh idle-task issue in a given repo
   * (Issue #2056). Templates use this to honour outstanding results
   * from a previous run — for example, `security-scan` returns
   * `false` while open `security`-labelled findings still exist, so
   * the worker does not pile a new scan on top of an un-triaged batch.
   *
   * Defaults to "always file" when the template does not implement it.
   * Implementations should never throw — return `true` on any
   * transient lookup failure so the framework remains the only place
   * that decides whether filing is safe.
   */
  shouldFile?(opts: IdleTaskShouldFileOptions): Promise<boolean>;
  /**
   * Execute the actual unit of work for this template (Issue #1965).
   *
   * Invoked by the claim handler when the worker picks up an
   * `idle-task` issue tagged with this template. Implementations
   * should never throw — they return an `IdleTaskRunResult` whose
   * `summary` is suitable for posting back as the closing comment on
   * the idle-task issue.
   */
  runTask(opts: IdleTaskRunOptions): Promise<IdleTaskRunResult>;
  /**
   * Optional body fingerprint check (Issue #2087). Returns `true` when
   * `body` looks like an instance of this template's filed wrapper
   * (e.g. contains the prompt's distinctive heading). Used as a third
   * dispatch signal alongside the `idle-task` label and the title
   * match — defence in depth against label-strip races, title edits,
   * and stale workers picking up newer-format wrappers whose body the
   * old dispatch could not recognise.
   *
   * When omitted, body matching is skipped for this template. Pure —
   * implementations must not perform I/O or throw.
   */
  matchesIdleTaskBody?(body: string): boolean;
  /**
   * When true, the framework neither ensures nor assigns a per-template
   * milestone for issues filed under this template (Issue #2067). Used
   * by templates whose units of work are best tracked as standalone
   * issues — `security-scan` files findings as ordinary issues, so
   * grouping the wrapper issue under `idle-task: security-scan` would
   * trigger the milestone-completion → merge-PR flow on close (see
   * #2062).
   *
   * Defaults to false (a per-template milestone is ensured and assigned
   * as the regular path does).
   */
  skipMilestone?: boolean;
  /**
   * Label that this template's output (findings, follow-up issues) carry
   * on the target repo (Issue #2082). When set, the generic idle-task
   * filer counts open issues in the target repo with this label and
   * refuses to raise a new wrapper if there are already 6 or more — the
   * previous batch is still being remediated and adding more idle-task
   * noise would only delay it.
   *
   * For `security-scan` this is `security`. A future bump-deps template
   * would declare whichever label its filed issues carry.
   *
   * Templates that have no output backlog to track (purely
   * informational, no follow-up issues filed) leave this `undefined` and
   * the backlog gate is skipped for them.
   */
  outputLabel?: string;
  /**
   * When true, the standard issue pipeline must NOT post a "Partial
   * Answer" fallback for a wrapper that matches this template — the
   * wrapper's outcome is filed issues, not narrative text, so any
   * partial textual output is meaningless to the user (Issue #2098).
   *
   * The check is defence-in-depth on top of `idle_task_guard` in
   * `lib/issue_worker.ts`: when the guard somehow lets a wrapper reach
   * the no-changes phase (e.g. via a routing race), the no-changes
   * phase still refuses to dump narrative output back on the wrapper.
   *
   * Defaults to false. Match a registered template by title or by
   * `matchesIdleTaskBody?.(body)`.
   */
  requiresStructuredOutput?: boolean;
  /**
   * Per-repo cooldown window in hours (Issue #2104). When set, the
   * idle-task filer skips a target repo for this template if the most
   * recent filed wrapper or finding's `createdAt` is younger than this
   * many hours. Omit to use the framework default
   * (`DEFAULT_COOLDOWN_HOURS` in `lib/idle_task_cooldown_gate.ts`,
   * currently 24h). Templates that benefit from a tighter or looser
   * loop (e.g. a fast doc audit at 6h, or a heavy weekly sweep at
   * 168h) override this field.
   */
  cooldownHours?: number;
}

/**
 * Slug pattern: one or more lowercase alphanumeric "words" separated by
 * single hyphens. Each word must start and end with `[a-z0-9]`, so leading
 * and trailing hyphens are rejected automatically.
 *
 * Exported so peer modules (e.g. `idle_task_milestone.ts`) can validate
 * template slugs against the same single source of truth.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Module-level registry. */
const templates = new Map<string, IdleTaskTemplate>();

/**
 * Validate a template slug.
 *
 * @throws Error if the name is not a valid slug.
 */
function assertValidName(name: string): void {
  if (!SLUG_PATTERN.test(name)) {
    throw new Error(
      `IdleTaskTemplate: invalid template name "${name}" — ` +
        `must be lowercase alphanumeric with single hyphens, ` +
        `no leading or trailing hyphen`,
    );
  }
}

/**
 * Register a template. Replaces any previously registered template with
 * the same name (later registrations win).
 *
 * @throws Error if the template name is not a valid slug.
 */
export function registerTemplate(template: IdleTaskTemplate): void {
  assertValidName(template.name);
  templates.set(template.name, template);
}

/** Return the template with the given name, or undefined if not registered. */
export function getTemplate(name: string): IdleTaskTemplate | undefined {
  return templates.get(name);
}

/** Return all registered templates in registration order. */
export function listTemplates(): IdleTaskTemplate[] {
  return [...templates.values()];
}
