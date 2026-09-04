/**
 * CLI entry point for the idle-task issue filer (Issue #1963).
 *
 * Invoked by the worker loop after a fully-idle scan pass — the loop
 * already gates the filer on `tracker.scanHadSuccess === false`, i.e.
 * "the scan loop just determined there is no claimable work". The command:
 *   1. Picks an idle-task template from the registry. For now only the
 *      `security-scan` template is registered so the choice is
 *      deterministic; the picker is hoisted into an injectable hook so a
 *      future round-robin or random strategy can be slotted in without
 *      touching the command.
 *   2. Shuffles `monitoredRepos` randomly (#1986 — `crypto.getRandomValues`
 *      backed Fisher-Yates, injectable for tests) and walks the result,
 *      picking the first repo with no open `idle-task` issue. The
 *      label-only dedup from #1984 means any open `idle-task` issue
 *      blocks further filing, regardless of template.
 *   3. Ensures the `idle-task` label exists on the target repo and the
 *      per-template milestone (`idle-task: <template>`, #1985), then
 *      files the issue via `gh issue create --milestone <title>`. Note
 *      gh wants the milestone *title* — passing the number makes gh
 *      look up a milestone whose title is the literal digits (Issue
 *      #2050). Success
 *      and failure are reported as structured progress log lines:
 *
 *        [idle-task] template=<name> repo=<owner/repo> action=filed issue=<n> milestone=<m> label=<label> verification=ok|reapplied|failed|skipped
 *        [idle-task] template=<name> repo=<owner/repo> action=filed issue=<n> milestone=skipped label=<label> verification=ok
 *        [idle-task] template=<name> repo=<owner/repo> action=skipped reason=duplicate
 *        [idle-task] template=<name> repo=<owner/repo> action=error reason=<msg>
 *
 *      Issue #2130: every `action=filed` line carries a
 *      `verification=` field reporting whether the wrapper's
 *      `idle-task` label was confirmed (`ok`), re-applied because the
 *      initial create dropped it (`reapplied`), or could not be
 *      landed at all (`failed reason=<msg>`). When `gh issue create`
 *      returned a URL we could not parse, `verification=skipped
 *      reason=no_issue_number` is emitted instead.
 *
 *      Where `milestone=skipped` reports that the picked template opted
 *      out of the per-template milestone via `skipMilestone: true`
 *      (Issue #2067).
 *
 * Issue #4009 inserts a **pair-first bias step** ahead of that random
 * pick. Before the shuffle, the cadence policy (`lib/idle_task_cadence.ts`)
 * is asked which (repo, template) pairs have missed their weekly/monthly
 * floor, most overdue first (`lib/idle_task_due_scans.ts`, cached with a
 * 6 h TTL so the freshness reconstruction costs at most one `gh issue
 * list` per repo per window). The first overdue pair that clears **every**
 * existing gate is filed directly — the bias changes *preference*, never
 * *permission*, so cross-repo dedup, the fleet-global work gate, per-repo
 * dedup, cooldown, busy, backlog and `shouldFile` all still apply, and
 * queued `work-on` work is never preempted. When no overdue pair is
 * eligible — or the freshness lookup fails — the command falls through to
 * the unchanged weighted-template + shuffled-repo path. Each tick emits
 * one of:
 *
 *   [idle-task] action=bias template=<name> repo=<owner/repo> tier=<tier> overdue_days=<n> source=cadence
 *   [idle-task] action=bias_skipped template=<name> repo=<owner/repo> reason=<gate>
 *   [idle-task] action=bias_none reason=<no_overdue_pairs|freshness_failed>
 *
 * `overdue_days=never` marks a pair with no reading at all on the window's
 * clock (see `NEVER_RUN_OVERDUE_DAYS`); every other value is days past the
 * deadline to one decimal place.
 *
 * Issue #2026: a previous version re-checked repo availability here via
 * `checkRepoAvailability`, which considers a repo to "have work" if any
 * issue exists that is not assigned to the worker user — including
 * issues assigned to humans, labelled `failed`/`needs-human`, or
 * otherwise unclaimable. That definition is broader than what the worker
 * scan loop actually treats as claimable, so the re-check returned
 * "hasAvailableWork=true" virtually every cycle and the filer skipped
 * with `reason=work_available` indefinitely. The re-check is removed:
 * the caller (`run_core.ts`) already gates the filer on the scan loop's
 * verdict, and label-only dedup prevents flooding within a repo.
 *
 * The command never throws — every failure mode (gh failure, label
 * create failure, dedup query failure) is logged and surfaced as
 * `success: false` so the calling shell sees a non-zero exit while the
 * worker loop stays in control of the response.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import type { Result } from "../types.ts";
import {
  type ExistingIdleTaskIssue,
  type ExistingIdleTaskWrapper,
  findAnyOpenIdleTaskWrapper as defaultFindAnyOpenIdleTaskWrapper,
  findExistingIdleTaskIssue as defaultFindExistingIdleTaskIssue,
  IDLE_TASK_LABEL,
} from "../lib/idle_task_issue.ts";
import {
  getTemplate,
  type IdleTaskTemplate,
  listTemplates,
} from "../lib/idle_task_template.ts";
import {
  type DueScan,
  NEVER_RUN_OVERDUE_DAYS,
} from "../lib/idle_task_cadence.ts";
import { loadDueScans as defaultLoadDueScans } from "../lib/idle_task_due_scans.ts";
import {
  addLabelToIssue as defaultAddLabelToIssue,
  ensureIdleTaskLabel as defaultEnsureIdleTaskLabel,
} from "../lib/label_operations.ts";
import { fetchIssueLabels as defaultFetchIssueLabels } from "../lib/issue_query.ts";
import {
  filterReservedLabelsWithWarning,
  runGhCommand as defaultGhCommand,
} from "../lib/github.ts";
import { createLogger } from "../lib/logger.ts";
import { customLabelPromptLabels } from "../lib/custom_label_prompts_config.ts";
import { getRunId } from "../lib/run_id.ts";
import { appendIdleTaskAttribution } from "../lib/idle_task_attribution.ts";
import {
  clampIdleTaskBody,
  GITHUB_ISSUE_BODY_MAX_CHARS,
} from "../lib/idle_task_body_limit.ts";
import {
  ensureIdleTaskMilestone as defaultEnsureIdleTaskMilestone,
  type IdleTaskMilestone,
} from "../lib/idle_task_milestone.ts";
import {
  anyRepoHasUnblockedRealWork as defaultAnyRepoHasUnblockedRealWork,
  isRepoBusyForIdleTask as defaultIsRepoBusyForIdleTask,
} from "../lib/repo_busy_for_idle_task.ts";
import {
  BACKLOG_THRESHOLD,
  countOpenIssuesByLabel as defaultCountOpenIssuesByLabel,
} from "../lib/idle_task_backlog_gate.ts";
import { isRepoCooledDown as defaultIsRepoCooledDown } from "../lib/idle_task_cooldown_gate.ts";

// Importing the bundled templates for their registration side-effect
// keeps the production set wired up regardless of which call site reaches
// this module first. Issue #2149 added `best-practices` alongside
// `security-scan`; Issue #2251 added `test-audit`; Issue #2256 added
// `github-actions-audit`; Issue #2398 added `supply-chain-readiness`;
// Issue #2904 added `orphan-deps`; Issue #2930 wired the four Boy Scout
// templates (dead-code, doc-coverage, format-drift, deprecated-api) into
// the filer; Issue #3228 added `bash-script-refs`; Issue #3238 added
// `bash-syntax-audit`; Issue #3319 added `documentation-audit`; Issue #3394
// added `alert-feed`; Issue #3488 added `workflow-annotation-scan`; Issue #3549
// added `private-repo-reference-audit`; Issue #3609 added
// `duplicated-knowledge`, so the dispatcher now picks between the seventeen
// templates uniformly at random (1/17 each).
import "../lib/idle_task_templates/security_scan_template.ts";
import "../lib/idle_task_templates/best_practices_template.ts";
import "../lib/idle_task_templates/test_audit_template.ts";
import "../lib/idle_task_templates/github_actions_audit_template.ts";
import "../lib/idle_task_templates/supply_chain_readiness_template.ts";
import "../lib/idle_task_templates/orphan_deps_template.ts";
import "../lib/idle_task_templates/dead_code_template.ts";
import "../lib/idle_task_templates/doc_coverage_template.ts";
import "../lib/idle_task_templates/format_drift_template.ts";
import "../lib/idle_task_templates/deprecated_api_template.ts";
import "../lib/idle_task_templates/bash_script_refs_template.ts";
import "../lib/idle_task_templates/bash_syntax_audit_template.ts";
import "../lib/idle_task_templates/documentation_audit_template.ts";
import "../lib/idle_task_templates/alert_feed_template.ts";
import "../lib/idle_task_templates/workflow_annotation_scan_template.ts";
import "../lib/idle_task_templates/private_repo_reference_template.ts";
import "../lib/idle_task_templates/duplicated_knowledge_template.ts";
import "../lib/idle_task_templates/retro_template.ts";

// ---------------------------------------------------------------------------
// Public data shape
// ---------------------------------------------------------------------------

/** Outcome reported back via `CommandResult.data`. */
export interface MaybeFileIdleTaskData {
  /** `filed`, `skipped`, or `error`. */
  action: "filed" | "skipped" | "error";
  /** Structured reason — populated for `skipped` and `error` actions. */
  reason?:
    | "no_template"
    | "duplicate"
    | "existing_wrapper_open"
    | "pending_results"
    | "approved_work_in_flight"
    | "cooldown_active"
    | "all_repos_cooled_down"
    | "output_backlog"
    | "label_failed"
    | "milestone_failed"
    | "gh_create_failed"
    | "unknown_error";
  /** Template name when one was picked. */
  template?: string;
  /** Target repo when one was chosen. */
  repo?: string;
  /** Newly filed issue number on a successful `filed` action. */
  issueNumber?: number;
  /** Milestone number the new issue was filed into. */
  milestoneNumber?: number;
  /**
   * Pickup label applied to the filed issue. Always `idle-task`
   * (Issue #2077 retired the `idle-task-pending` approval gate); kept
   * in the data shape so existing operator log scrapers continue to
   * parse `label=<value>` lines without breakage.
   */
  pickupLabel?: string;
  /**
   * True when the cadence bias (Issue #4009) chose this (repo, template)
   * pair rather than the random fallback path.
   */
  biased?: boolean;
  /**
   * Model tier the cadence floor owes this pair (`sonnet` weekly, `fable`
   * monthly). Present only on a biased pick.
   */
  tier?: string;
}

// ---------------------------------------------------------------------------
// Test surface (kept off the public CLI)
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies — exposed via the `__testDeps` arg so tests can
 * drive the full decision tree without touching the network. In
 * production every functional dep resolves to its real implementation.
 *
 * Issue #2018: the production caller in
 * `lib/run_core_production_deps.ts` also injects `log` here to route
 * the structured progress lines (`[idle-task] ...`) through the shared
 * worker Logger instead of letting them sink into the inherited tty —
 * the same visibility fix #2016 applied to the fleet heartbeat.
 */
interface TestDeps {
  /**
   * Open-idle-task dedup lookup. Label-only dedup: any open
   * `idle-task` issue in the repo blocks further filing.
   */
  findExistingFn?: (
    opts: { repo: string },
  ) => Promise<ExistingIdleTaskIssue | null>;
  /**
   * Cross-repo wrapper lookup (Issue #2092). Scans every monitored repo
   * and returns the first open `idle-task` wrapper found anywhere, or
   * `null` when the entire set is clean. Defaults to
   * {@link defaultFindAnyOpenIdleTaskWrapper}.
   */
  findAnyOpenWrapperFn?: (
    repos: readonly string[],
  ) => Promise<ExistingIdleTaskWrapper | null>;
  /** Ensure-label helper for the `idle-task` label. */
  ensureLabelFn?: (repo: string) => Promise<Result<void>>;
  /** gh CLI runner. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Strategy hook for picking the next template. */
  pickTemplateFn?: (templates: IdleTaskTemplate[]) => IdleTaskTemplate | null;
  /**
   * Overdue (repo, template, tier) pairs driving the cadence bias (Issue
   * #4009), most overdue first. Defaults to the cached, `gh`-backed
   * {@link defaultLoadDueScans}. A throw is fail-open: the command logs
   * `bias_none reason=freshness_failed` and files via the random path.
   */
  dueScansFn?: (
    opts: { repos: readonly string[]; now: Date },
  ) => Promise<DueScan[]>;
  /** Clock — used for the marker timestamp. */
  nowFn?: () => Date;
  /** Progress log sink. Defaults to `console.log`. */
  log?: (line: string) => void;
  /**
   * Random function used to shuffle the monitored-repo list. Defaults to a
   * `crypto.getRandomValues`-backed source. Pinned in tests to make the
   * shuffle order deterministic.
   */
  randomFn?: () => number;
  /**
   * Per-template milestone helper — returns the milestone the issue will
   * be filed into. Defaults to `ensureIdleTaskMilestone` from
   * `lib/idle_task_milestone.ts`.
   */
  ensureMilestoneFn?: (
    opts: { repo: string; template: string },
  ) => Promise<IdleTaskMilestone>;
  /**
   * Busy-repo check (Issue #2054). Returns true when `repo` already has
   * an open issue carrying any approved-work label (`top-priority`,
   * `work-on`, `low-priority`, or `idle-task`), which means the worker
   * fleet already has approved work queued in that repo and a new
   * idle-task there would not unblock an idle worker. Defaults to
   * `isRepoBusyForIdleTask` from `lib/repo_busy_for_idle_task.ts`.
   */
  isRepoBusyFn?: (
    opts: { repo: string; logFn?: (message: string) => void },
  ) => Promise<boolean>;
  /**
   * Fleet-global existence gate (Issue #2813). Returns true when ANY
   * monitored repo holds an open, unblocked
   * `top-priority`/`work-on`/`low-priority` issue — even one merely
   * *deferred* this cycle by `nice` tiering, fair rotation, or cooldown
   * rather than claimed. When true the filer suppresses idle-task creation
   * across the whole set, repairing the filing half of the #2806
   * idle-vs-work-on inversion. Defaults to `anyRepoHasUnblockedRealWork`
   * from `lib/repo_busy_for_idle_task.ts`. A helper throw is treated as
   * "no work" (matches the `busy_check_failed` pattern) so a transient gh
   * hiccup never silently disables the filer.
   */
  anyRepoHasWorkFn?: (
    opts: { repos: readonly string[]; logFn?: (message: string) => void },
  ) => Promise<boolean>;
  /**
   * Output-backlog count for the active template (Issue #2082, "backlog
   * gate"). Returns the number of open issues in `repo` that carry the
   * template's `outputLabel`, capped at the backlog threshold. The filer
   * refuses to file when the count meets or exceeds {@link
   * BACKLOG_THRESHOLD}. Defaults to {@link
   * defaultCountOpenIssuesByLabel}.
   */
  countOutputLabelOpenIssuesFn?: (
    opts: { repo: string; label: string },
  ) => Promise<number>;
  /**
   * Per-repo cooldown check (Issue #2105). Returns true when the
   * template has filed against `repo` within its rolling cooldown
   * window. Defaults to `isRepoCooledDown` from
   * `lib/idle_task_cooldown_gate.ts`. A helper throw is treated as
   * "not cooled down" (matches the `busy_check_failed` pattern) so a
   * transient gh hiccup never silently disables the filer.
   */
  isRepoCooledDownFn?: (
    opts: { repo: string; template: IdleTaskTemplate },
  ) => Promise<boolean>;
  /**
   * Post-create label verification (Issue #2130). After `gh issue
   * create` returns, fetch the new issue's labels so we can confirm
   * `idle-task` actually landed. Defaults to {@link
   * defaultFetchIssueLabels}. A `null` return is treated as "labels
   * unknown — assume missing" so the re-apply fires defensively.
   */
  verifyLabelsFn?: (
    repo: string,
    issueNumber: number,
  ) => Promise<string[] | null>;
  /**
   * Re-apply hook for the `idle-task` label (Issue #2130). Invoked when
   * the post-create verification reports the label is missing. Defaults
   * to {@link defaultAddLabelToIssue}.
   */
  addLabelFn?: (
    repo: string,
    issueNumber: number,
    label: string,
  ) => Promise<Result<void>>;
  /**
   * Sleep hook for the re-apply backoff (Issue #2137). Injected in tests
   * so the suite never actually waits. Defaults to a real
   * `setTimeout`-backed sleep.
   */
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * Checkout root the filed wrapper's prompt files are read from
   * (Issue #1024). Forwarded to the picked template's `buildIssueBody` as
   * its `rootDir`. Omit for the production resolution
   * (`PROMPTS_DIR`, `VIBE_BASE_DIR`, then the module-relative path); a test
   * names its own checkout so building a real body depends on neither the
   * working directory nor the environment.
   */
  rootDir?: string;
}

/**
 * Re-apply retry schedule (Issue #2137). Three attempts with a short
 * exponential backoff between them. The first attempt has no leading
 * delay (the post-create REST API call should usually settle
 * immediately); subsequent attempts wait 500 ms then 1500 ms to give a
 * transient GitHub hiccup time to clear. Total worst-case added latency
 * per filing is ~2 s.
 */
export const REAPPLY_MAX_ATTEMPTS = 3;
export const REAPPLY_BACKOFF_MS: readonly number[] = [0, 500, 1500];

// ---------------------------------------------------------------------------
// Argument parsing helpers
// ---------------------------------------------------------------------------

/** Split a comma-separated CLI arg into a trimmed, non-empty list. */
function splitCsv(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Default random source — backed by `crypto.getRandomValues` for fair
 * uniform output. Falls back to `Math.random()` in the unlikely event
 * that `crypto.getRandomValues` is unavailable (e.g. exotic runtime).
 */
function defaultRandom(): number {
  try {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0]! / 0x1_0000_0000;
  } catch {
    return Math.random();
  }
}

/**
 * Fisher-Yates shuffle parameterised by a random source so tests can pin
 * the result. The original input is not mutated.
 */
function shuffleWith<T>(items: readonly T[], rand: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }
  return result;
}

/**
 * Default template picker — uniform random selection across the registered
 * templates (Issue #2149). With N templates registered this gives a 1/N
 * split (seventeen as of Issue #3609, which added `duplicated-knowledge`);
 * with a single template registered it always picks that one.
 * The RNG is injected so tests can pin the distribution deterministically.
 *
 * Exported so unit tests can drive it directly without spinning up the
 * full command pipeline.
 */
export function defaultPickTemplate(
  templates: IdleTaskTemplate[],
  rand: () => number = defaultRandom,
): IdleTaskTemplate | null {
  if (templates.length === 0) return null;
  const raw = Math.floor(rand() * templates.length);
  // Clamp defensively in case `rand()` returns exactly 1.0 (some RNG
  // implementations do — `Math.random()` does not, but injected sources
  // might).
  const idx = Math.min(templates.length - 1, Math.max(0, raw));
  return templates[idx] ?? null;
}

/**
 * Resolve a template's effective draw weight (Issue #2401).
 *
 * A configured weight counts only when it is a finite, strictly positive
 * number; anything else (absent key, zero, negative, NaN, Infinity, wrong
 * type) collapses to the baseline weight of 1. This makes the partial-map
 * case ergonomic — an operator names only the templates to boost and every
 * other template keeps the uniform baseline — and makes a zero weight a
 * "fall back to uniform for this template" signal rather than an exclusion.
 */
function effectiveWeight(
  name: string,
  weights: Record<string, number>,
): number {
  const raw = weights[name];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * Weighted template picker (Issue #2401).
 *
 * Biases the idle-task draw toward templates an operator has flagged as
 * higher priority (e.g. `security-scan`, `supply-chain-readiness`) via the
 * `idleTaskTemplateWeights` config. Each template's relative weight comes
 * from {@link effectiveWeight}; the draw is a standard cumulative-weight
 * selection over `rand() * total`.
 *
 * Falls back to {@link defaultPickTemplate} (uniform) whenever no
 * registered template carries a configured positive weight — the default
 * empty map and an all-zero map both yield no behaviour change, and the
 * uniform path preserves the exact pinned-RNG mapping the pre-#2401 tests
 * rely on. The RNG is injected so tests can pin the distribution
 * deterministically.
 *
 * Exported so unit tests can drive it directly without spinning up the
 * full command pipeline.
 */
export function weightedPickTemplate(
  templates: IdleTaskTemplate[],
  weights: Record<string, number>,
  rand: () => number = defaultRandom,
): IdleTaskTemplate | null {
  if (templates.length === 0) return null;

  // No usable weights → uniform. Preserves both the pre-#2401 behaviour
  // and the existing pinned-RNG tests that compare against
  // `defaultPickTemplate`.
  const hasPositiveWeight = templates.some((t) => {
    const raw = weights[t.name];
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0;
  });
  if (!hasPositiveWeight) {
    return defaultPickTemplate(templates, rand);
  }

  const effective = templates.map((t) => effectiveWeight(t.name, weights));
  const total = effective.reduce((sum, w) => sum + w, 0);

  // Walk the cumulative weights. `target` starts in [0, total); subtracting
  // each weight in turn lands in the matching bucket. The trailing return
  // guards against `rand()` returning exactly 1.0 (floating-point slop).
  let target = rand() * total;
  for (let i = 0; i < templates.length; i++) {
    target -= effective[i]!;
    if (target < 0) return templates[i]!;
  }
  return templates[templates.length - 1]!;
}

/**
 * `gh issue create` prints the URL of the new issue on its own line.
 * Recover the issue number for the structured progress log. A parsing
 * failure degrades to omitting the number — the filing itself still
 * counted as a success.
 */
function parseIssueNumber(output: string): number | undefined {
  const trimmed = output.trim();
  if (trimmed.length === 0) return undefined;
  const lastLine = trimmed.split(/\r?\n/).pop()?.trim() ?? "";
  const match = lastLine.match(/\/issues\/(\d+)\/?$/);
  if (match === null) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Per-repo gate walk (shared by the cadence bias and the random fallback)
// ---------------------------------------------------------------------------

/** Why a (repo, template) pair may not be filed right now. */
type RepoGateReason =
  | "duplicate"
  | "cooldown_active"
  | "approved_work_in_flight"
  | "output_backlog"
  | "pending_results";

/** Verdict of {@link checkRepoGates} for one (repo, template) pair. */
type RepoGateOutcome =
  | { kind: "eligible" }
  | {
    kind: "blocked";
    reason: RepoGateReason;
    /** Output label and count, populated for `output_backlog` only. */
    label?: string;
    count?: number;
  }
  | { kind: "dedup_failed"; message: string };

/** Dependencies {@link checkRepoGates} needs, resolved by the caller. */
interface RepoGateDeps {
  findExistingFn: (
    opts: { repo: string },
  ) => Promise<ExistingIdleTaskIssue | null>;
  isRepoCooledDownFn: (
    opts: { repo: string; template: IdleTaskTemplate },
  ) => Promise<boolean>;
  isRepoBusyFn: (
    opts: { repo: string; logFn?: (message: string) => void },
  ) => Promise<boolean>;
  countOutputLabelOpenIssuesFn: (
    opts: { repo: string; label: string },
  ) => Promise<number>;
  log: (line: string) => void;
}

/**
 * Run every per-repo gate against one (repo, template) pair, in the
 * established order: dedup (#1984) → cooldown (#2105) → busy (#2054) →
 * backlog (#2082) → the template's own `shouldFile` veto (#2056).
 *
 * Single source of truth for the gate sequence, so the cadence bias (Issue
 * #4009) can only ever change *preference*, never *permission* — both the
 * biased walk and the random walk clear the identical set of gates.
 *
 * Each helper failure degrades to "not blocked" and is logged as an
 * `action=warn` line (the `busy_check_failed` pattern) so a transient gh
 * hiccup never silently disables the filer. The one exception is the dedup
 * query, whose failure is returned to the caller to handle — filing on top
 * of an unknown dedup state is the one risk worth failing loud over.
 */
async function checkRepoGates(
  repo: string,
  template: IdleTaskTemplate,
  deps: RepoGateDeps,
): Promise<RepoGateOutcome> {
  const { log } = deps;

  let existing: ExistingIdleTaskIssue | null;
  try {
    existing = await deps.findExistingFn({ repo });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "dedup_failed", message };
  }
  if (existing !== null) return { kind: "blocked", reason: "duplicate" };

  let cooledDown: boolean;
  try {
    cooledDown = await deps.isRepoCooledDownFn({ repo, template });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `[idle-task] template=${template.name} repo=${repo} action=warn reason=cooldown_check_failed message=${message}`,
    );
    cooledDown = false;
  }
  if (cooledDown) return { kind: "blocked", reason: "cooldown_active" };

  let busy: boolean;
  try {
    busy = await deps.isRepoBusyFn({ repo, logFn: log });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `[idle-task] template=${template.name} repo=${repo} action=warn reason=busy_check_failed message=${message}`,
    );
    busy = false;
  }
  if (busy) return { kind: "blocked", reason: "approved_work_in_flight" };

  if (template.outputLabel !== undefined && template.outputLabel.length > 0) {
    let backlog: number;
    try {
      backlog = await deps.countOutputLabelOpenIssuesFn({
        repo,
        label: template.outputLabel,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[idle-task] template=${template.name} repo=${repo} action=warn reason=backlog_check_failed message=${message}`,
      );
      backlog = 0;
    }
    if (backlog >= BACKLOG_THRESHOLD) {
      return {
        kind: "blocked",
        reason: "output_backlog",
        label: template.outputLabel,
        count: backlog,
      };
    }
  }

  if (template.shouldFile !== undefined) {
    let ok: boolean;
    try {
      ok = await template.shouldFile({ repo });
    } catch (err) {
      // Treat lookup failures as "go ahead and file" so a transient gh
      // hiccup does not silently disable the template.
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[idle-task] template=${template.name} repo=${repo} action=warn reason=should_file_failed message=${message}`,
      );
      ok = true;
    }
    if (!ok) return { kind: "blocked", reason: "pending_results" };
  }

  return { kind: "eligible" };
}

/**
 * Render a cadence `overdueDays` reading for the log stream: one decimal
 * place, or the literal `never` for the "no reading on this window's clock"
 * sentinel — printing `9007199254740991` would be technically numeric and
 * practically useless to an operator.
 */
function formatOverdueDays(overdueDays: number): string {
  if (overdueDays >= NEVER_RUN_OVERDUE_DAYS) return "never";
  return String(Math.round(overdueDays * 10) / 10);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const maybeFileIdleTaskCommand: Command = {
  name: "maybe-file-idle-task",
  description:
    "Idle-task issue filer: after a fully-idle pass, picks the next " +
    "template, dedups against open idle-task issues, and files a new " +
    "GitHub issue with the `idle-task` label (Issue #1963).",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<MaybeFileIdleTaskData>> {
    const monitoredRepos = splitCsv(args["monitored-repos"]);
    const githubUser = String(args["github-user"] ?? "");
    const workerUser = String(args["worker-user"] ?? githubUser);
    // Issue #2467: the `worker-repo` arg used to drive the #2082 queue
    // gate. The gate was removed because it fired whenever the worker
    // repo had any open `work-on` issue — i.e. virtually all the time
    // during normal operation — and starved idle-task creation across
    // every monitored repo. The arg is still accepted (and ignored) so
    // older call sites keep working without a flag day. Overcreation is
    // still bounded by the cross-repo wrapper dedup (#2092), the
    // per-template cooldown (#2104), the per-repo busy check (#2054,
    // tightened by #2440), and the runTask re-check (#2441).

    const deps: TestDeps = (args["__testDeps"] as TestDeps | undefined) ?? {};
    const log = deps.log ?? ((line: string) => console.log(line));

    if (monitoredRepos.length === 0) {
      return {
        success: false,
        message: "Missing required argument: --monitored-repos",
      };
    }
    if (githubUser.length === 0) {
      return {
        success: false,
        message: "Missing required argument: --github-user",
      };
    }

    const ghCommandFn = deps.ghCommandFn ?? defaultGhCommand;
    const findExistingFn = deps.findExistingFn ??
      ((opts: { repo: string }) => defaultFindExistingIdleTaskIssue(opts));
    // Issue #2092 — cross-repo dedup. Thread `ghCommandFn` through so a
    // caller that has already injected a gh stub does not also need to
    // stub the cross-repo check.
    const findAnyOpenWrapperFn = deps.findAnyOpenWrapperFn ??
      ((repos: readonly string[]) =>
        defaultFindAnyOpenIdleTaskWrapper(repos, { ghCommandFn }));
    const ensureLabelFn = deps.ensureLabelFn ??
      ((repo: string) => defaultEnsureIdleTaskLabel(repo));
    const nowFn = deps.nowFn ?? (() => new Date());
    const randomFn = deps.randomFn ?? defaultRandom;
    // Issue #2149: the default picker performs random selection across
    // the registered templates. Issue #2401: the draw is now weighted by
    // the operator-configured `idleTaskTemplateWeights` so security &
    // supply-chain templates can be biased ahead of the rest. When no
    // template carries a positive weight (the default empty map) the
    // weighted picker falls back to a uniform draw — no behaviour change.
    // The `randomFn` injected here drives both the per-repo shuffle and
    // the template pick so a single seeded RNG pins both behaviours in
    // tests.
    const templateWeights = config.idleTaskTemplateWeights ?? {};
    const pickTemplateFn = deps.pickTemplateFn ??
      ((templates: IdleTaskTemplate[]) =>
        weightedPickTemplate(templates, templateWeights, randomFn));
    const ensureMilestoneFn = deps.ensureMilestoneFn ??
      ((opts: { repo: string; template: string }) =>
        defaultEnsureIdleTaskMilestone(opts));
    // The default busy-repo check threads `ghCommandFn` through so a
    // caller that has already injected a gh stub (e.g. the e2e tests)
    // does not also need to stub the busy check separately.
    const isRepoBusyFn = deps.isRepoBusyFn ??
      ((opts: { repo: string }) =>
        defaultIsRepoBusyForIdleTask({
          repo: opts.repo,
          ghCommandFn,
        }));
    // Issue #2813 — fleet-global existence gate. Threads `ghCommandFn`
    // through so a caller that has already injected a gh stub does not
    // also need to stub this check separately.
    const anyRepoHasWorkFn = deps.anyRepoHasWorkFn ??
      ((
        opts: { repos: readonly string[]; logFn?: (message: string) => void },
      ) =>
        defaultAnyRepoHasUnblockedRealWork({
          repos: opts.repos,
          ghCommandFn,
          logFn: opts.logFn,
        }));
    // Issue #2082 — backlog gate. Counts open issues on the target repo
    // carrying the template's `outputLabel`.
    const countOutputLabelOpenIssuesFn = deps.countOutputLabelOpenIssuesFn ??
      ((opts: { repo: string; label: string }) =>
        defaultCountOpenIssuesByLabel({
          repo: opts.repo,
          label: opts.label,
          ghCommandFn,
        }));
    // Issue #2105 — per-repo cooldown gate. Threads `ghCommandFn`
    // through so callers that have already stubbed gh do not need a
    // separate cooldown stub.
    const isRepoCooledDownFn = deps.isRepoCooledDownFn ??
      ((opts: { repo: string; template: IdleTaskTemplate }) =>
        defaultIsRepoCooledDown({
          repo: opts.repo,
          template: opts.template,
          ghCommandFn,
        }));
    // Issue #2130 — post-create verification. Threads `ghCommandFn`
    // through so callers that have already stubbed gh do not need a
    // separate verify stub.
    const verifyLabelsFn = deps.verifyLabelsFn ??
      ((repo: string, issueNumber: number) =>
        defaultFetchIssueLabels(repo, issueNumber, undefined, ghCommandFn));
    const addLabelFn = deps.addLabelFn ??
      ((repo: string, issueNumber: number, label: string) =>
        defaultAddLabelToIssue(repo, issueNumber, label, { ghCommandFn }));
    // Issue #4009 — cadence bias. The default lookup is cached with a 6 h
    // TTL, so the freshness reconstruction costs at most one `gh issue
    // list` per repo per window rather than one per idle tick. Threads
    // `ghCommandFn` through so callers that have already stubbed gh do not
    // need a separate freshness stub.
    // Issue #4011 — the cadence policy itself is operator-only configuration
    // (`.config.json` → `idle_task_cadence`), so it is read from the config
    // rather than embedded here; an unconfigured worker gets the #4003 default.
    const dueScansFn = deps.dueScansFn ??
      ((opts: { repos: readonly string[]; now: Date }) =>
        defaultLoadDueScans({
          repos: opts.repos,
          now: opts.now,
          ghCommandFn,
          policy: config.idleTaskCadence,
          warn: log,
        }));
    // Issue #2137 — real sleep for the re-apply backoff. Tests inject a
    // no-op (or a recording stub) so the suite never actually waits.
    const sleepFn = deps.sleepFn ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    // Issue #2026: no per-repo "has available work" re-check here. The
    // caller (`run_core.ts`) already gates this command on
    // `tracker.scanHadSuccess === false` — a much tighter signal than
    // anything we could reconstruct from `gh issue list` alone — and the
    // label-only dedup below prevents flooding within a repo.

    // 1. Pick a template.
    const template = pickTemplateFn(listTemplates());
    if (template === null) {
      log("[idle-task] action=skipped reason=no_template");
      return {
        success: true,
        message: "[idle-task] skipped: no template registered",
        data: { action: "skipped", reason: "no_template" },
      };
    }

    // 1a. Issue #2467: the legacy queue gate (#2082) was removed. It
    //     fired whenever the worker repo had any open `work-on`
    //     issue — i.e. virtually all the time — and starved idle-task
    //     creation across every monitored repo. Overcreation is now
    //     bounded by the cross-repo wrapper dedup (#2092, immediately
    //     below), the per-template cooldown (#2104), the per-repo busy
    //     check (#2054, tightened by #2440), and the runTask re-check
    //     (#2441).

    // 1b. Issue #2092 — cross-repo wrapper dedup. At most one open
    //     `idle-task` wrapper across the entire monitored set: if any
    //     monitored repo already has one, skip filing entirely and let
    //     the next iteration of the main loop claim the existing
    //     wrapper through standard priority dispatch. Without this gate
    //     successive idle ticks could each pick a different "clean"
    //     repo from the per-repo shuffle and fan wrappers out across
    //     the fleet (root cause observed in #2089).
    let crossRepoWrapper: ExistingIdleTaskWrapper | null;
    try {
      crossRepoWrapper = await findAnyOpenWrapperFn(monitoredRepos);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[idle-task] template=${template.name} action=warn reason=cross_repo_check_failed message=${message}`,
      );
      crossRepoWrapper = null;
    }
    if (crossRepoWrapper !== null) {
      log(
        `[idle-task] template=${template.name} repo=${crossRepoWrapper.repo} issue=${crossRepoWrapper.number} action=skipped reason=existing_wrapper_open`,
      );
      return {
        success: true,
        message:
          `[idle-task] skipped: open idle-task wrapper already exists in ${crossRepoWrapper.repo}#${crossRepoWrapper.number}`,
        data: {
          action: "skipped",
          reason: "existing_wrapper_open",
          template: template.name,
          repo: crossRepoWrapper.repo,
        },
      };
    }

    // 1c. Issue #2813 — fleet-global existence gate. If ANY monitored
    //     repo holds an open, unblocked
    //     `top-priority`/`work-on`/`low-priority` issue, the fleet has
    //     real work — even when that issue was merely *deferred* this
    //     cycle by `nice` tiering, fair rotation, or local/cross-worker
    //     cooldown rather than claimed. The per-repo busy check (#2054)
    //     below only skips the *individual* busy repo, so a quiet repo B
    //     could still be filed into while a different repo A held the
    //     deferred backlog — the filing half of the #2806 idle-vs-work-on
    //     inversion. This gate suppresses idle filing across the whole
    //     set. Best-effort: a throw degrades to "no work" so a transient
    //     gh hiccup never silently disables the filer (matches the
    //     `busy_check_failed` pattern).
    let fleetHasWork: boolean;
    try {
      fleetHasWork = await anyRepoHasWorkFn({
        repos: monitoredRepos,
        logFn: log,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[idle-task] template=${template.name} action=warn reason=fleet_work_check_failed message=${message}`,
      );
      fleetHasWork = false;
    }
    if (fleetHasWork) {
      log(
        `[idle-task] template=${template.name} action=skipped reason=approved_work_in_flight scope=monitored_set`,
      );
      return {
        success: true,
        message:
          "[idle-task] skipped: unblocked top-priority/work-on/low-priority work exists in the monitored set (deferred this cycle)",
        data: {
          action: "skipped",
          reason: "approved_work_in_flight",
          template: template.name,
        },
      };
    }

    const gateDeps: RepoGateDeps = {
      findExistingFn,
      isRepoCooledDownFn,
      isRepoBusyFn,
      countOutputLabelOpenIssuesFn,
      log,
    };

    // 2. Issue #4009 — cadence bias. Ask the policy which (repo, template)
    //    pairs have missed their weekly/monthly floor and take the first
    //    one that clears every per-repo gate, most overdue first. The
    //    lookup sits *after* the two fleet-wide short-circuits above so a
    //    tick that was going to skip anyway pays no freshness cost.
    //
    //    Fail-open throughout: a throwing or failing lookup logs
    //    `bias_none reason=freshness_failed` and falls through to the
    //    unchanged random path, and a blocked pair is announced with
    //    `bias_skipped` before the walk moves on. The bias expresses a
    //    *preference*, never a *permission* — nothing here can file into a
    //    repo the random path could not.
    let biasedPick:
      | { repo: string; template: IdleTaskTemplate; tier: string }
      | null = null;
    let dueScans: DueScan[] | null;
    try {
      dueScans = await dueScansFn({ repos: monitoredRepos, now: nowFn() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[idle-task] action=bias_none reason=freshness_failed message=${message}`,
      );
      dueScans = null;
    }
    if (dueScans !== null) {
      const monitoredSet = new Set(monitoredRepos);
      for (const due of dueScans) {
        // Defensive: a due list naming a repo we no longer monitor, or a
        // template that is not registered in this process, is ignored
        // rather than filed against.
        if (!monitoredSet.has(due.repo)) continue;
        const dueTemplate = getTemplate(due.template);
        if (dueTemplate === undefined) continue;

        const outcome = await checkRepoGates(due.repo, dueTemplate, gateDeps);
        if (outcome.kind === "eligible") {
          biasedPick = {
            repo: due.repo,
            template: dueTemplate,
            tier: due.tier,
          };
          log(
            `[idle-task] action=bias template=${due.template} repo=${due.repo} tier=${due.tier} overdue_days=${
              formatOverdueDays(due.overdueDays)
            } source=cadence`,
          );
          break;
        }
        // A dedup failure only disqualifies *this* pair; the random walk
        // below still surfaces it loudly if it recurs there.
        const reason = outcome.kind === "dedup_failed"
          ? "dedup_query_failed"
          : outcome.reason;
        log(
          `[idle-task] action=bias_skipped template=${due.template} repo=${due.repo} reason=${reason}`,
        );
      }
      if (biasedPick === null) {
        log("[idle-task] action=bias_none reason=no_overdue_pairs");
      }
    }

    // 3. No overdue pair was eligible — fall back to the pre-#4009
    //    behaviour: pick the first repo with no open `idle-task` issue at
    //    all (#1984 — label-only dedup, regardless of template) and where
    //    the template does not veto filing (#2056 — e.g. security-scan
    //    refuses to re-run while open `security` findings remain). The
    //    list is shuffled randomly (#1986) so a busy lead-of-list repo
    //    does not starve the rest. The cross-repo gate at #1b above
    //    already ensures the entire set is clean before we reach this
    //    point; the per-repo dedup inside the loop stays as
    //    defence-in-depth against TOCTOU races (Issue #2092).
    //
    //    Issue #2776 (part of #2771) — filer selection stays **uniform**:
    //    deliberately no repo `nice` weighting here. Idle tasks are already
    //    the lowest tier overall, and once filed the resulting `idle-task`
    //    issue is discovered through `find_oldest_issue` and is therefore
    //    already `nice`-tiered at *selection* time (the Priority 2 wiring,
    //    Issue #2774) — not at *filing* time. Weighting the filer by `nice`
    //    would double-count the same preference. A future `nice`-weighted
    //    filing change, if ever wanted, is a separate issue.
    let targetRepo: string | null = null;
    if (biasedPick !== null) {
      targetRepo = biasedPick.repo;
    } else {
      const shuffledRepos = shuffleWith(monitoredRepos, randomFn);
      // Track which fall-through reason applies so we can emit an
      // informative `action=skipped` line when no repo was eligible.
      // Specificity order (most → least specific): `output_backlog` >
      // `pending_results` > `approved_work_in_flight` > `cooldown_active`
      // > `duplicate`. `output_backlog` means the previous batch of output
      // issues is still un-triaged (Issue #2082); `pending_results` means
      // a template's `shouldFile` vetoed (Issue #2056);
      // `approved_work_in_flight` means another worker already has
      // approved work queued in the repo (Issue #2054); `cooldown_active`
      // means the template fired against the repo within its rolling
      // window (Issue #2105); `duplicate` is the catch-all "we already
      // filed".
      let sawOutputBacklog = false;
      let sawPendingResults = false;
      let sawApprovedWork = false;
      let sawCooldownActive = false;
      // Issue #2105: count repos skipped specifically because of the
      // cooldown gate. When this equals the entire shuffled list, the
      // dedicated `all_repos_cooled_down` summary fires.
      let cooldownSkipCount = 0;
      for (const repo of shuffledRepos) {
        // The gate sequence itself lives in `checkRepoGates` so the cadence
        // bias above clears exactly the same gates in the same order
        // (Issue #4009). Only the reporting differs between the two paths.
        const outcome = await checkRepoGates(repo, template, gateDeps);
        if (outcome.kind === "dedup_failed") {
          log(
            `[idle-task] template=${template.name} repo=${repo} action=error reason=dedup_query_failed message=${outcome.message}`,
          );
          return {
            success: false,
            message: `[idle-task] dedup query failed: ${outcome.message}`,
            data: {
              action: "error",
              reason: "unknown_error",
              template: template.name,
              repo,
            },
          };
        }
        if (outcome.kind === "eligible") {
          targetRepo = repo;
          break;
        }
        switch (outcome.reason) {
          case "duplicate":
            // Per-repo `duplicate` lines are deliberately silent — the
            // fall-through summary below reports them once.
            break;
          case "cooldown_active":
            sawCooldownActive = true;
            cooldownSkipCount += 1;
            log(
              `[idle-task] template=${template.name} repo=${repo} action=skipped reason=cooldown_active`,
            );
            break;
          case "approved_work_in_flight":
            sawApprovedWork = true;
            log(
              `[idle-task] template=${template.name} repo=${repo} action=skipped reason=approved_work_in_flight`,
            );
            break;
          case "output_backlog":
            sawOutputBacklog = true;
            log(
              `[idle-task] template=${template.name} repo=${repo} action=skipped reason=output_backlog label=${outcome.label} count=${outcome.count}`,
            );
            break;
          case "pending_results":
            sawPendingResults = true;
            log(
              `[idle-task] template=${template.name} repo=${repo} action=skipped reason=pending_results`,
            );
            break;
        }
      }

      if (targetRepo === null) {
        const firstRepo = shuffledRepos[0]!;
        // Issue #2105: when every monitored repo is inside its cooldown
        // window — i.e. each repo in the shuffled list was skipped via
        // the cooldown gate, with no duplicates, busy hits, or other
        // signals firing — emit the dedicated `all_repos_cooled_down`
        // summary called out in the parent issue: "When every monitored
        // repo is inside its window on an idle tick: file nothing, log
        // `all repos cooled down`, exit quietly." The line omits the
        // repo identifier because the message is about the whole set.
        if (cooldownSkipCount === shuffledRepos.length) {
          log(
            `[idle-task] template=${template.name} action=skipped reason=all_repos_cooled_down`,
          );
          return {
            success: true,
            message:
              "[idle-task] skipped: every monitored repo is inside its cooldown window",
            data: {
              action: "skipped",
              reason: "all_repos_cooled_down",
              template: template.name,
            },
          };
        }
        // Specificity order (most → least specific): output_backlog >
        // pending_results > approved_work_in_flight > cooldown_active >
        // duplicate. The first that fired wins.
        const reason:
          | "output_backlog"
          | "pending_results"
          | "approved_work_in_flight"
          | "cooldown_active"
          | "duplicate" = sawOutputBacklog
            ? "output_backlog"
            : sawPendingResults
            ? "pending_results"
            : sawApprovedWork
            ? "approved_work_in_flight"
            : sawCooldownActive
            ? "cooldown_active"
            : "duplicate";
        const summary = reason === "output_backlog"
          ? "output-label backlog at or above threshold in every repo"
          : reason === "pending_results"
          ? "previous results still open in every repo"
          : reason === "approved_work_in_flight"
          ? "approved work already queued in every repo"
          : reason === "cooldown_active"
          ? "cooldown active in every repo"
          : "duplicate idle-task issue open in every repo";
        // Per-repo lines are already emitted for `output_backlog`,
        // `pending_results`, `approved_work_in_flight`, and
        // `cooldown_active` inside the loop; only the `duplicate` case
        // is logged here as a single summary line.
        if (reason === "duplicate") {
          log(
            `[idle-task] template=${template.name} repo=${firstRepo} action=skipped reason=${reason}`,
          );
        }
        return {
          success: true,
          message: `[idle-task] skipped: ${summary}`,
          data: {
            action: "skipped",
            reason,
            template: template.name,
            repo: firstRepo,
          },
        };
      }
    }

    // From here on the pick is fixed: the cadence bias's pair when one was
    // eligible, otherwise the randomly drawn template (Issue #4009).
    const filedTemplate = biasedPick?.template ?? template;

    // 4. Ensure the `idle-task` pickup label exists before filing.
    //    Issue #2077 retired the `requiresApproval` / `idle-task-pending`
    //    branch — `idle-task` is already the lowest priority in the
    //    queue, so a separate approval gate added no value.
    const pickupLabel = IDLE_TASK_LABEL;
    const labelResult = await ensureLabelFn(targetRepo);
    if (!labelResult.ok) {
      const message = labelResult.error.message;
      log(
        `[idle-task] template=${filedTemplate.name} repo=${targetRepo} action=error reason=label_failed message=${message}`,
      );
      return {
        success: false,
        message: `[idle-task] failed to ensure label: ${message}`,
        data: {
          action: "error",
          reason: "label_failed",
          template: filedTemplate.name,
          repo: targetRepo,
        },
      };
    }

    // 5. Ensure the per-template milestone exists in the target repo.
    //    Each template owns one open milestone (`idle-task: <template>`),
    //    and every filed idle-task issue is assigned to it (#1985) —
    //    unless the template opts out via `skipMilestone: true` (Issue
    //    #2067), in which case the milestone helper is never consulted
    //    and the `--milestone` flag is omitted from `gh issue create`.
    const skipMilestone = filedTemplate.skipMilestone === true;
    let milestone: IdleTaskMilestone | null = null;
    if (!skipMilestone) {
      try {
        milestone = await ensureMilestoneFn({
          repo: targetRepo,
          template: filedTemplate.name,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(
          `[idle-task] template=${filedTemplate.name} repo=${targetRepo} action=error reason=milestone_failed message=${message}`,
        );
        return {
          success: false,
          message: `[idle-task] failed to ensure milestone: ${message}`,
          data: {
            action: "error",
            reason: "milestone_failed",
            template: filedTemplate.name,
            repo: targetRepo,
          },
        };
      }
    }

    // 6. File the issue. Issue #2077: body = `filedTemplate.buildIssueBody`
    //    verbatim — no marker, no parameters block. The body builder
    //    may be async (e.g. security-scan loads the prompt and
    //    substitutes placeholders), so we await it.
    const pickedAt = nowFn().toISOString();
    let body: string;
    try {
      body = await Promise.resolve(filedTemplate.buildIssueBody({
        repo: targetRepo,
        pickedAt,
        workerUser,
        rootDir: deps.rootDir,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[idle-task] template=${filedTemplate.name} repo=${targetRepo} action=error reason=body_failed message=${message}`,
      );
      return {
        success: false,
        message: `[idle-task] failed to build issue body: ${message}`,
        data: {
          action: "error",
          reason: "unknown_error",
          template: filedTemplate.name,
          repo: targetRepo,
        },
      };
    }
    // Attribution + run-id traceability (Issues #2438, #2381). Append a
    // visible human-readable footer naming the picked template and the
    // worker run id, followed by the machine-readable run-id metadata
    // block for greppability. Both are visible (no hidden marker) so the
    // human-style wrapper convention from Issue #2077 still holds.
    // `appendIdleTaskAttribution` stamps the footer only once even when the
    // template body already embedded it (Issue #3513).
    const runId = getRunId();
    body = appendIdleTaskAttribution(body, {
      template: filedTemplate.name,
      runId,
    });

    // Issue #3634: GitHub rejects bodies over 65,536 characters, which the
    // security-scan preview now exceeds. Clamp to fit and announce the drop
    // in the idle-task log stream as well as in the body itself.
    const clamped = clampIdleTaskBody(body);
    body = clamped.body;
    if (clamped.truncated) {
      log(
        `[idle-task] repo=${targetRepo} template=${filedTemplate.name} action=truncated_body original=${clamped.originalLength} dropped=${clamped.droppedChars} limit=${GITHUB_ISSUE_BODY_MAX_CHARS}`,
      );
    }

    const title = filedTemplate.buildIssueTitle(targetRepo);

    // Issue #2825: route the wrapper's labels through the warning filter
    // before they reach `gh issue create`, so no worker-built creation path
    // can apply a reserved label silently. `idle-task` is the one
    // self-appliable label (deliberately absent from RESERVED_LABELS), so it
    // passes through unchanged — this is defence-in-depth. The logger writes
    // into the same `log` sink so any stripped label is visible in the
    // idle-task log stream.
    const labelLogger = createLogger({ write: log });
    const safeLabels = filterReservedLabelsWithWarning(
      [pickupLabel],
      `${targetRepo} idle-task filer`,
      labelLogger,
      // Issue #847: a configured custom label dispatches a privileged phase —
      // the worker must never self-apply one.
      customLabelPromptLabels(config),
    );

    // Build the gh args, conditionally including `--milestone` only when
    // the template did not opt out (Issue #2067).
    const createArgs: string[] = [
      "issue",
      "create",
      "--repo",
      targetRepo,
      ...safeLabels.flatMap((l) => ["--label", l]),
    ];
    if (milestone !== null) {
      // `gh issue create --milestone` expects the milestone *title*,
      // not its number. Passing a numeric string makes gh look up a
      // milestone whose title is the literal digits and fail with
      // "could not add to milestone '<n>': '<n>' not found" (Issue
      // #2050). The milestone helper guarantees `title` is the
      // canonical `idle-task: <template>` string.
      createArgs.push("--milestone", milestone.title);
    }
    createArgs.push("--title", title, "--body", body);

    let createOutput: string;
    try {
      createOutput = await ghCommandFn(createArgs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[idle-task] template=${filedTemplate.name} repo=${targetRepo} action=error reason=gh_create_failed message=${message}`,
      );
      return {
        success: false,
        message: `[idle-task] gh issue create failed: ${message}`,
        data: {
          action: "error",
          reason: "gh_create_failed",
          template: filedTemplate.name,
          repo: targetRepo,
        },
      };
    }

    const issueNumber = parseIssueNumber(createOutput);
    const issueField = issueNumber !== undefined ? issueNumber : "unknown";
    // `milestone=skipped` makes the opt-out (#2067) visible in the
    // structured progress log so operators can tell why no milestone
    // number is present.
    const milestoneField = milestone !== null
      ? String(milestone.number)
      : "skipped";

    // Issue #2130 / #2137 — verify the wrapper actually carries
    // `idle-task` after `gh issue create` returns. Production has
    // observed wrappers landing with no labels at all (e.g.
    // private-repo-19#180 and again #182, exhibit B for #2137), which
    // makes them invisible to the priority queue and the cross-repo
    // dedup. Defence-in-depth: when the label is missing, re-apply via
    // the REST-primary helper, **with retry and exponential backoff**
    // (Issue #2137) so a single transient REST/CLI hiccup no longer
    // leaves the wrapper unlabelled. A view failure is treated as
    // "label missing" so a transient hiccup still triggers the
    // re-apply. On terminal failure a loud `ALERT` line is emitted at
    // `severity=error` carrying the issue URL so operators can spot
    // the regression immediately.
    let verificationField: string;
    if (issueNumber === undefined) {
      // Without a parsed number we cannot verify or re-apply. Surface
      // the gap in the progress log rather than silently claiming `ok`.
      verificationField = "verification=skipped reason=no_issue_number";
    } else {
      let labels: string[] | null;
      try {
        labels = await verifyLabelsFn(targetRepo, issueNumber);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(
          `[idle-task] template=${filedTemplate.name} repo=${targetRepo} issue=${issueNumber} action=warn reason=verify_query_failed message=${message}`,
        );
        labels = null;
      }
      const hasLabel = labels !== null && labels.includes(pickupLabel);
      if (hasLabel) {
        verificationField = "verification=ok";
      } else {
        // Issue #2137 — retry-with-backoff. Try `addLabelFn` up to
        // `REAPPLY_MAX_ATTEMPTS` times, sleeping per
        // `REAPPLY_BACKOFF_MS` between attempts. The first attempt has
        // no leading delay so the happy path stays fast; subsequent
        // attempts wait progressively longer to let a transient
        // GitHub hiccup clear before giving up.
        let reapplied = false;
        let lastError = "label still missing";
        let attemptsUsed = 0;
        for (let attempt = 0; attempt < REAPPLY_MAX_ATTEMPTS; attempt++) {
          if (attempt > 0) {
            const delay = REAPPLY_BACKOFF_MS[attempt] ??
              REAPPLY_BACKOFF_MS[REAPPLY_BACKOFF_MS.length - 1]!;
            await sleepFn(delay);
          }
          attemptsUsed = attempt + 1;
          const reapply = await addLabelFn(
            targetRepo,
            issueNumber,
            pickupLabel,
          );
          if (reapply.ok) {
            reapplied = true;
            break;
          }
          lastError = reapply.error.message;
          log(
            `[idle-task] template=${filedTemplate.name} repo=${targetRepo} issue=${issueNumber} action=warn reason=reapply_attempt_failed attempt=${attemptsUsed} message=${lastError}`,
          );
        }
        if (reapplied) {
          verificationField = "verification=reapplied";
        } else {
          verificationField = `verification=failed reason=${lastError}`;
          // Loud alert (Issue #2137 acceptance criterion #3). Logged at
          // `severity=error` with the canonical GitHub issue URL so
          // operators can jump straight to the orphaned wrapper.
          const issueUrl =
            `https://github.com/${targetRepo}/issues/${issueNumber}`;
          log(
            `[idle-task] ALERT severity=error template=${filedTemplate.name} repo=${targetRepo} issue=${issueNumber} url=${issueUrl} action=verification_failed attempts=${attemptsUsed} reason=${lastError} — idle-task label could not be applied; wrapper will NOT be picked up`,
          );
        }
      }
    }
    log(
      `[idle-task] template=${filedTemplate.name} repo=${targetRepo} action=filed issue=${issueField} milestone=${milestoneField} label=${pickupLabel} ${verificationField}`,
    );

    return {
      success: true,
      message:
        `[idle-task] filed: template=${filedTemplate.name} repo=${targetRepo} issue=${issueField} milestone=${milestoneField}`,
      data: {
        action: "filed",
        template: filedTemplate.name,
        repo: targetRepo,
        pickupLabel,
        ...(milestone !== null ? { milestoneNumber: milestone.number } : {}),
        ...(issueNumber !== undefined ? { issueNumber } : {}),
        // Issue #4009: only a biased pick carries these, so a caller can
        // tell a cadence-driven filing from a random one without parsing
        // the log stream.
        ...(biasedPick !== null ? { biased: true, tier: biasedPick.tier } : {}),
      },
    };
  },
};
