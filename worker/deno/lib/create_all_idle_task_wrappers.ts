/**
 * Seed all seventeen standard idle-task wrappers in a target repo (Issue #2577,
 * extended in Issue #2930 to cover the four Boy Scout templates).
 *
 * When a repo is freshly added to the monitored set, the normal idle-task
 * filer (`maybe_file_idle_task.ts`) would only ever seed *one* wrapper per
 * idle tick — it picks a single template at random and is gated by the
 * cross-repo "any open idle-task blocks filing" check
 * (`findAnyOpenIdleTaskWrapper`). That is the right behaviour for steady-state
 * background work, but it is too slow for bringing a brand-new repo up to best
 * practice: it can take many idle cycles before all seventeen templates have run at
 * least once.
 *
 * {@link createAllIdleTaskWrappers} deliberately bypasses both the random
 * single-pick and the cross-repo gate so a single call seeds every registered
 * idle-task wrapper at once. It stays idempotent by reusing the canonical
 * wrapper-title allowlist (`IDLE_TASK_WRAPPER_TITLES`) and a per-repo dedup
 * lookup: before filing each template it skips any wrapper whose canonical
 * title is already open in the repo. Re-running therefore never produces
 * duplicates — already-open wrappers are reported in `skipped`.
 *
 * Which of the seventeen actually *fire* on a given (e.g. private) repo is governed
 * at runtime elsewhere (Issue #2571); this helper only seeds the wrappers.
 *
 * Failure handling (Issue #3862). A sweep no longer throws away its progress
 * on the first bad template:
 *
 *   - a **preflight** check refuses an off-allowlist target repo before any
 *     body is built, so a blocked sweep costs zero `gh` calls and zero
 *     blocked-write audit events;
 *   - a **terminal** failure (a `WriteRepoBlockedError` /
 *     `WriteTargetUndeterminableError` surfacing from the `gh` chokepoint)
 *     aborts the sweep immediately — it would fail identically for every
 *     remaining template;
 *   - a **non-terminal** per-template failure is recorded and the sweep
 *     carries on, so one `gh` hiccup no longer costs the other sixteen;
 *   - every failure path returns an {@link IdleTaskSweepError} carrying the
 *     `created` / `skipped` / `failed` lists so callers can report them
 *     (`formatIdleTaskOutcomeTable`).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";
import { runGhCommand as defaultGhCommand } from "./github.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";
import { listTemplates } from "./idle_task_template.ts";
import { ensureIdleTaskLabel as defaultEnsureIdleTaskLabel } from "./label_operations.ts";
import { appendIdleTaskAttribution } from "./idle_task_attribution.ts";
import {
  clampIdleTaskBody,
  GITHUB_ISSUE_BODY_MAX_CHARS,
} from "./idle_task_body_limit.ts";
import { getRunId } from "./run_id.ts";
import {
  ensureIdleTaskMilestone as defaultEnsureIdleTaskMilestone,
  type IdleTaskMilestone,
} from "./idle_task_milestone.ts";
import { IDLE_TASK_WRAPPER_TITLES } from "./idle_task_backfill.ts";
import {
  isWriteRepoAllowed,
  isWriteRepoAllowlistActive,
  listAllowedWriteRepos,
  WriteRepoBlockedError,
  WriteTargetUndeterminableError,
} from "./write_repo_allowlist.ts";

// Importing the bundled templates for their registration side-effect so the
// production set is wired up regardless of which call site reaches this module
// first (mirrors `maybe_file_idle_task.ts`).
import "./idle_task_templates/security_scan_template.ts";
import "./idle_task_templates/best_practices_template.ts";
import "./idle_task_templates/test_audit_template.ts";
import "./idle_task_templates/github_actions_audit_template.ts";
import "./idle_task_templates/supply_chain_readiness_template.ts";
import "./idle_task_templates/orphan_deps_template.ts";
import "./idle_task_templates/dead_code_template.ts";
import "./idle_task_templates/doc_coverage_template.ts";
import "./idle_task_templates/format_drift_template.ts";
import "./idle_task_templates/deprecated_api_template.ts";
import "./idle_task_templates/bash_script_refs_template.ts";
import "./idle_task_templates/bash_syntax_audit_template.ts";
import "./idle_task_templates/documentation_audit_template.ts";
import "./idle_task_templates/alert_feed_template.ts";
import "./idle_task_templates/workflow_annotation_scan_template.ts";
import "./idle_task_templates/private_repo_reference_template.ts";
import "./idle_task_templates/duplicated_knowledge_template.ts";
import "./idle_task_templates/retro_template.ts";

/** Canonical wrapper titles, as a set for O(1) allowlist / dedup checks. */
const WRAPPER_TITLE_SET: ReadonlySet<string> = new Set(
  IDLE_TASK_WRAPPER_TITLES,
);

/** Injectable dependencies — every functional dep resolves to production. */
export interface CreateAllIdleTaskWrappersDeps {
  /** gh CLI runner. Defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Ensure-label helper for the `idle-task` label. */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /**
   * Per-repo dedup lookup — returns the set of canonical wrapper titles
   * already open in `repo`. Defaults to a gh `issue list --label idle-task`
   * query filtered to {@link IDLE_TASK_WRAPPER_TITLES}.
   */
  findExistingWrapperTitlesFn?: (repo: string) => Promise<Set<string>>;
  /**
   * Per-template milestone helper. Only consulted for templates that do NOT
   * set `skipMilestone: true`. All seventeen production templates set it, so this
   * is never called in practice. Defaults to `ensureIdleTaskMilestone`.
   */
  ensureMilestoneFn?: (
    opts: { repo: string; template: string },
  ) => Promise<IdleTaskMilestone>;
  /** Worker login filing the issues (embedded in the body). */
  workerUser?: string;
  /** Clock — used for the wrapper body's `pickedAt` field. */
  nowFn?: () => Date;
  /** Canonical worker run id. Defaults to {@link getRunId}. */
  runId?: string;
  /** Progress log sink. Defaults to a no-op. */
  log?: (line: string) => void;
  /**
   * Checkout root the wrapper bodies' prompt files are read from
   * (Issue #1024). Forwarded verbatim to each template's `buildIssueBody`
   * as its `rootDir`. Omit for the production
   * resolution (`PROMPTS_DIR`, `VIBE_BASE_DIR`, then the module-relative
   * path); name a root to pin every read in the sweep to that checkout,
   * independent of the process's working directory and environment.
   */
  rootDir?: string;
  /**
   * Optional template-name allowlist (Issue #2933). When provided, only
   * templates whose `name` is in this set are seeded; the rest are ignored
   * entirely (not even reported as skipped). Defaults to "all seventeen canonical
   * wrappers" when omitted, preserving the original behaviour. Used by the
   * Boy Scout multi-repo raiser to seed just the four Boy Scout wrappers.
   */
  templateNames?: ReadonlySet<string>;
}

/** A single template's failure within a sweep (Issue #3862). */
export interface IdleTaskWrapperFailure {
  /** The template whose wrapper could not be filed. */
  template: string;
  /** Why it failed, as surfaced to the operator. */
  reason: string;
  /**
   * True when the failure will recur identically for every remaining template
   * — a write-repo allowlist refusal. Terminal failures abort the sweep.
   */
  terminal: boolean;
}

/** Outcome of {@link createAllIdleTaskWrappers}. */
export interface CreateAllIdleTaskWrappersResult {
  /** Template names whose wrapper was newly filed. */
  created: string[];
  /** Template names skipped because an open wrapper already existed. */
  skipped: string[];
  /**
   * Per-template failures (Issue #3862). Always populated by
   * {@link createAllIdleTaskWrappers}; optional so injected test seams may
   * omit it.
   */
  failed?: IdleTaskWrapperFailure[];
  /** Set when a terminal failure stopped the sweep before the last template. */
  aborted?: boolean;
}

/**
 * Sweep failure carrying the progress made before it (Issue #3862).
 *
 * The sweep used to return a bare `{ok: false, error}` on the first
 * `gh issue create` failure, discarding the `created`/`skipped` lists an
 * operator needs to see what already landed (#3634, #3858). The partial
 * outcome now rides on the error itself, so every caller — including the
 * per-repo fan-out raisers — can report it.
 */
export class IdleTaskSweepError extends Error {
  /** What the sweep managed to do before failing. */
  readonly partial: CreateAllIdleTaskWrappersResult;
  /** True when a retry or re-run in this process cannot succeed. */
  readonly terminal: boolean;

  constructor(
    message: string,
    partial: CreateAllIdleTaskWrappersResult,
    terminal = false,
  ) {
    super(message);
    this.name = "IdleTaskSweepError";
    this.partial = partial;
    this.terminal = terminal;
  }
}

/** The progress carried by a sweep failure; an empty outcome for other errors. */
export function partialFromSweepError(
  err: unknown,
): CreateAllIdleTaskWrappersResult {
  if (err instanceof IdleTaskSweepError) return err.partial;
  return { created: [], skipped: [], failed: [] };
}

/** Whether a sweep failure is terminal — a retry cannot succeed. */
export function isTerminalSweepError(err: unknown): boolean {
  return err instanceof IdleTaskSweepError && err.terminal;
}

/**
 * Whether `err` is a write-repo allowlist refusal (Issue #3311/#3703).
 *
 * Matched by class *and* by name: the refusal can be re-thrown across module
 * instances (the agent-side `gh` guard shim), where `instanceof` no longer
 * holds but the name survives.
 */
function isWriteRefusal(err: unknown): boolean {
  if (
    err instanceof WriteRepoBlockedError ||
    err instanceof WriteTargetUndeterminableError
  ) {
    return true;
  }
  return err instanceof Error &&
    (err.name === "WriteRepoBlockedError" ||
      err.name === "WriteTargetUndeterminableError");
}

/**
 * Render a sweep outcome as a per-template table (Issue #3862).
 *
 * Printed by the CLI on both the success and the failure path so an operator
 * always sees which wrappers landed, which were already open, and which
 * failed — instead of only the name of the template that died.
 */
export function formatIdleTaskOutcomeTable(
  repo: string,
  outcome: CreateAllIdleTaskWrappersResult,
): string[] {
  const failed = outcome.failed ?? [];
  const rows = [
    ...outcome.created.map((t) => ({
      template: t,
      status: "created",
      reason: "-",
    })),
    ...outcome.skipped.map((t) => ({
      template: t,
      status: "skipped",
      reason: "already_open",
    })),
    ...failed.map((f) => ({
      template: f.template,
      status: "failed",
      reason: f.terminal ? `terminal: ${f.reason}` : f.reason,
    })),
  ];

  const width = Math.max(8, ...rows.map((r) => r.template.length));
  const lines = [
    `[create-all-idle-task] outcome table repo=${repo} ` +
    `created=${outcome.created.length} skipped=${outcome.skipped.length} ` +
    `failed=${failed.length}`,
    `  ${"TEMPLATE".padEnd(width)}  STATUS   REASON`,
  ];
  for (const r of rows) {
    lines.push(
      `  ${r.template.padEnd(width)}  ${r.status.padEnd(7)}  ${r.reason}`,
    );
  }
  if (outcome.aborted) {
    lines.push(
      "  (sweep aborted on a terminal failure — the remaining templates were not attempted)",
    );
  }
  return lines;
}

/**
 * Default per-repo dedup lookup. Lists the repo's open `idle-task`-labelled
 * issues and returns the subset of titles that match the canonical wrapper
 * allowlist. A malformed gh response degrades to "nothing open" so a transient
 * hiccup never blocks seeding.
 */
async function defaultFindExistingWrapperTitles(
  repo: string,
  gh: (args: string[]) => Promise<string>,
): Promise<Set<string>> {
  const raw = await gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    IDLE_TASK_LABEL,
    "--state",
    "open",
    "--json",
    "title",
    "--limit",
    "200",
  ]);

  const found = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return found;
  }
  if (!Array.isArray(parsed)) return found;
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const title = (item as { title?: unknown }).title;
    if (typeof title !== "string") continue;
    const trimmed = title.trim();
    if (WRAPPER_TITLE_SET.has(trimmed)) found.add(trimmed);
  }
  return found;
}

/**
 * File all seventeen standard idle-task wrappers in `repo`, skipping any whose
 * canonical title is already open.
 *
 * Iterates the template registry via {@link listTemplates} and acts only on
 * templates whose `buildIssueTitle(repo)` matches the canonical wrapper
 * allowlist — this naturally excludes any test-only templates registered into
 * the shared registry and guarantees a clean repo gets exactly the seventeen
 * production wrappers.
 *
 * Bypasses the random single-pick and the cross-repo `findAnyOpenIdleTaskWrapper`
 * gate so one call seeds every wrapper; per-template title dedup still prevents
 * duplicates.
 */
export async function createAllIdleTaskWrappers(
  repo: string,
  deps: CreateAllIdleTaskWrappersDeps = {},
): Promise<Result<CreateAllIdleTaskWrappersResult>> {
  if (typeof repo !== "string" || repo.trim().length === 0) {
    return { ok: false, error: new Error("repo must be a non-empty string") };
  }

  const emptyOutcome = (): CreateAllIdleTaskWrappersResult => ({
    created: [],
    skipped: [],
    failed: [],
  });

  // Preflight (Issue #3862): an off-allowlist target fails identically for
  // every template, so refuse before a single body is built. Aborting here
  // also keeps the sweep to zero blocked-write audit events rather than one
  // per template.
  if (isWriteRepoAllowlistActive() && !isWriteRepoAllowed(repo)) {
    return {
      ok: false,
      error: new IdleTaskSweepError(
        `[create-all-idle-task] refusing to seed ${repo}: not on this run's ` +
          `write-repo allowlist [${listAllowedWriteRepos().join(", ")}] — ` +
          `every template would be refused, so nothing was attempted`,
        emptyOutcome(),
        true,
      ),
    };
  }

  const gh = deps.ghCommandFn ?? defaultGhCommand;
  const ensureLabelFn = deps.ensureLabelFn ??
    ((r: string) => defaultEnsureIdleTaskLabel(r));
  const findExistingWrapperTitlesFn = deps.findExistingWrapperTitlesFn ??
    ((r: string) => defaultFindExistingWrapperTitles(r, gh));
  const ensureMilestoneFn = deps.ensureMilestoneFn ??
    ((opts: { repo: string; template: string }) =>
      defaultEnsureIdleTaskMilestone(opts));
  const workerUser = deps.workerUser ?? "";
  const nowFn = deps.nowFn ?? (() => new Date());
  const runId = deps.runId ?? getRunId();
  const log = deps.log ?? (() => {});
  const rootDir = deps.rootDir;

  // The canonical seventeen wrappers only. Filtering by the allowlist excludes any
  // test-only template registered into the shared registry. An optional
  // template-name allowlist (Issue #2933) narrows this further — e.g. to the
  // four Boy Scout templates.
  const nameFilter = deps.templateNames;
  const templates = listTemplates().filter((t) =>
    WRAPPER_TITLE_SET.has(t.buildIssueTitle(repo).trim()) &&
    (nameFilter === undefined || nameFilter.has(t.name))
  );

  // Ensure the `idle-task` pickup label exists once before filing.
  const labelResult = await ensureLabelFn(repo);
  if (!labelResult.ok) {
    return {
      ok: false,
      error: new IdleTaskSweepError(
        `[create-all-idle-task] failed to ensure idle-task label in ${repo}: ${labelResult.error.message}`,
        emptyOutcome(),
        isWriteRefusal(labelResult.error),
      ),
    };
  }

  // Snapshot the open canonical wrappers once for per-template dedup.
  let openTitles: Set<string>;
  try {
    openTitles = await findExistingWrapperTitlesFn(repo);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new IdleTaskSweepError(
        `[create-all-idle-task] dedup lookup failed in ${repo}: ${message}`,
        emptyOutcome(),
        isWriteRefusal(err),
      ),
    };
  }

  const created: string[] = [];
  const skipped: string[] = [];
  const failed: IdleTaskWrapperFailure[] = [];

  for (const template of templates) {
    const title = template.buildIssueTitle(repo).trim();

    // Idempotency: skip a template whose canonical wrapper is already open.
    if (openTitles.has(title)) {
      skipped.push(template.name);
      log(
        `[create-all-idle-task] repo=${repo} template=${template.name} action=skipped reason=already_open`,
      );
      continue;
    }

    // Preparing the body can throw too (a missing prompt file, a milestone
    // lookup failure), so it shares the per-template failure handling below
    // rather than escaping as an unhandled exception.
    let stage: "prepare" | "create" = "prepare";
    try {
      // Respect `skipMilestone` per template (all seventeen set it `true`, so
      // no per-template milestone is created in practice).
      let milestone: IdleTaskMilestone | null = null;
      if (template.skipMilestone !== true) {
        milestone = await ensureMilestoneFn({ repo, template: template.name });
      }

      // Build the body exactly as the normal filer does: the template body
      // followed by the visible attribution footer and the machine-readable
      // run-id metadata block. `appendIdleTaskAttribution` stamps the footer
      // only once even when the template already embedded it (Issue #3513).
      const pickedAt = nowFn().toISOString();
      const rawBody = await Promise.resolve(
        template.buildIssueBody({ repo, pickedAt, workerUser, rootDir }),
      );
      // Issue #3634: GitHub rejects bodies over 65,536 characters, and the
      // security-scan preview now exceeds that. Clamp and say so loudly.
      const clamped = clampIdleTaskBody(
        appendIdleTaskAttribution(rawBody, {
          template: template.name,
          runId,
        }),
      );
      const body = clamped.body;
      if (clamped.truncated) {
        log(
          `[create-all-idle-task] repo=${repo} template=${template.name} action=truncated_body original=${clamped.originalLength} dropped=${clamped.droppedChars} limit=${GITHUB_ISSUE_BODY_MAX_CHARS}`,
        );
      }

      const createArgs: string[] = [
        "issue",
        "create",
        "--repo",
        repo,
        "--label",
        IDLE_TASK_LABEL,
      ];
      if (milestone !== null) {
        createArgs.push("--milestone", milestone.title);
      }
      createArgs.push("--title", title, "--body", body);

      stage = "create";
      await gh(createArgs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = stage === "create"
        ? `[create-all-idle-task] gh issue create failed for template=${template.name} in ${repo}: ${message}`
        : `[create-all-idle-task] failed to build the wrapper body for template=${template.name} in ${repo}: ${message}`;
      const terminal = isWriteRefusal(err);
      failed.push({ template: template.name, reason, terminal });
      log(
        `[create-all-idle-task] repo=${repo} template=${template.name} ` +
          `action=failed terminal=${terminal} reason=${message}`,
      );

      // A write-repo refusal fails identically for every remaining template
      // and can never succeed in this process — abort now rather than emit a
      // blocked-write audit event per template (Issue #3862).
      if (terminal) {
        return {
          ok: false,
          error: new IdleTaskSweepError(
            `[create-all-idle-task] aborting sweep of ${repo}: blocked write — ` +
              `${message}. Active write-repo allowlist ` +
              `[${
                listAllowedWriteRepos().join(", ")
              }]; a retry cannot succeed ` +
              `until ${repo} is on it. ${created.length} wrapper(s) filed, ` +
              `${skipped.length} already open, remaining templates not attempted.`,
            { created, skipped, failed, aborted: true },
            true,
          ),
        };
      }
      // A one-off gh hiccup must not cost the whole sweep — carry on.
      continue;
    }

    created.push(template.name);
    log(
      `[create-all-idle-task] repo=${repo} template=${template.name} action=filed label=${IDLE_TASK_LABEL}`,
    );
  }

  // Fail loud when any template failed, but still hand back what landed.
  if (failed.length > 0) {
    return {
      ok: false,
      error: new IdleTaskSweepError(
        `[create-all-idle-task] ${failed.length} of ${templates.length} ` +
          `template(s) failed in ${repo} (${created.length} filed, ` +
          `${skipped.length} already open): ` +
          failed.map((f) => f.reason).join("; "),
        { created, skipped, failed },
        false,
      ),
    };
  }

  return { ok: true, value: { created, skipped, failed } };
}
