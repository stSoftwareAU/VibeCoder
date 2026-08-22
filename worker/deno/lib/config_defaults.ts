/**
 * Configuration defaults — single source of truth for TypeScript.
 *
 * These values mirror the shell defaults in worker/shared/config_defaults.sh.
 * Both files must be kept in sync. Tests verify consistency.
 *
 * Issue #216: Consolidate configuration defaults into single source of truth.
 * Issue #277: All configuration (including operational) loaded from .config.json.
 * Issue #2166: buildDefaultWorkerConfig() now returns a concrete WorkerConfig
 *   rather than `any`, so missing or stale fields in the literal are caught at
 *   compile time and call sites no longer need `as WorkerConfig` rescue casts.
 */

import type { WorkerConfig } from "../types.ts";
import { DEFAULT_AGENT_PROVIDER_ID } from "./agent_provider.ts";
import { DEFAULT_MIN_CLAIM_RUNWAY_SECONDS } from "./claim_runway.ts";
import { DEFAULT_LONG_JOB_LABELS } from "./claim_runway_evidence.ts";
import { DEFAULT_CADENCE_POLICY } from "./idle_task_cadence.ts";
import { DEFAULT_RUN_MODE } from "./run_mode.ts";
import { cloneCadencePolicy } from "./idle_task_cadence_config.ts";

/**
 * Default label values used across shell and TypeScript configuration.
 *
 * Issue #1834: `topPriorityLabel`, `workOnLabel` and `lowPriorityLabel` are
 * the three hardwired discovery labels — every Vibe Coder picks them up
 * with zero configuration. `.config.json` may not override any of them.
 */
export const LABEL_DEFAULTS = {
  /**
   * Top-priority label (Issue #1834).
   * Hardwired — `.config.json` may not override. Highest-priority pickup
   * signal in the configured-label tier.
   */
  topPriorityLabel: "top-priority",
  /**
   * Work-on label.
   * Hardwired since Issue #1834 — `.config.json` may not override.
   * Signals worker pickup on issues not created by an allowed author
   * (verified via the GitHub timeline API).
   */
  workOnLabel: "work-on",
  failedOnceLabel: "failed-once",
  failedLabel: "failed",
  refineIssueLabel: "refine-issue",
  planningLabel: "planning",
  questionLabel: "question",
  needsRevisionLabel: "needs-revision",
  documentationLabel: "documentation",
  needsScreenshotLabel: "needs-screenshot",
  needsHumanLabel: "needs-human",
  grillMeLabel: "grill-me",
  /**
   * Quorum plan-off label (Issue #4112, parent #4102).
   *
   * Human-applied only: it routes the issue into a three-agent plan-off ahead
   * of planning, so it is reserved (see {@link RESERVED_LABELS}) and the
   * worker refuses to self-apply it.
   */
  quorumLabel: "quorum",
  /**
   * Low-priority label (Issue #1723).
   * Hardwired since Issue #1834 — `.config.json` may not override.
   * Reserved so the worker never self-applies it. Used by the priority
   * hierarchy collector and selector built in subsequent sub-issues of #1721.
   */
  lowPriorityLabel: "low-priority",
} as const;

/**
 * The three hardwired discovery labels (Issue #1834).
 *
 * `top-priority`, `work-on`, and `low-priority` are the canonical
 * pickup signals. They are not configurable — every Vibe Coder picks
 * them up by default with zero configuration. The diagnostic discovery
 * check uses this set, deduplicated, when reporting which labels make
 * an issue eligible.
 */
export const DISCOVERY_LABELS: readonly string[] = [
  LABEL_DEFAULTS.topPriorityLabel,
  LABEL_DEFAULTS.workOnLabel,
  LABEL_DEFAULTS.lowPriorityLabel,
] as const;

/**
 * Partial Failure-Detection repair label (Issue #59, part of #54).
 *
 * Marks a planning parent whose run published a usable plan but left one or
 * more sub-issues without a filled `## Failure Detection` section. Defined here
 * rather than beside its apply helper because being *reserved* is the property
 * that governs it: the worker raises it, and the planner must never be able to
 * apply it as a descriptive label on a sub-issue. Not configurable.
 */
export const FAILURE_DETECTION_REPAIR_LABEL = "needs-failure-detection-repair";

/**
 * Reserved labels that must not be applied when the worker creates issues.
 *
 * These labels are used by the worker for operational purposes (issue discovery,
 * prioritisation, failure tracking, workflow state). Only the repository owner
 * should apply these labels.
 *
 * Issue #297: Prevent the vibe coder from labelling created issues with
 * special operational labels.
 */
export const RESERVED_LABELS: readonly string[] = [
  // Issue #2022: the legacy `claude` and `help wanted` discovery/watch
  // labels are still reserved so the worker never self-applies them on
  // repos that have not yet been cleaned up — but the canonical
  // discovery set is now `top-priority` > `work-on` > `low-priority` >
  // `idle-task`. `idle-task` is the only label the worker may add.
  "claude",
  "help wanted",
  // Issue #1834: top-priority is the canonical highest-priority discovery
  // signal and reserved so the worker never self-applies it.
  LABEL_DEFAULTS.topPriorityLabel,
  // Issue #1723: low-priority is reserved so the worker never self-applies it.
  LABEL_DEFAULTS.lowPriorityLabel,
  // Prioritisation label
  LABEL_DEFAULTS.workOnLabel,
  // Failure tracking labels
  LABEL_DEFAULTS.failedLabel,
  LABEL_DEFAULTS.failedOnceLabel,
  // Workflow state labels
  // Issue #2031: needs-clarification retired — needs-human is the handoff
  // signal. The literal label name stays reserved here as defence in depth
  // so the worker never re-applies it to a newly filed issue and the
  // PR-copy filter strips it from older repos that still carry the label.
  "needs-clarification",
  LABEL_DEFAULTS.refineIssueLabel,
  LABEL_DEFAULTS.planningLabel,
  LABEL_DEFAULTS.questionLabel,
  // Issue #2030: `answered` retired — question workflow now signals handoff
  // with `needs-human`. The literal label name stays reserved as defence in
  // depth so the worker never re-applies it to a freshly filed issue and the
  // PR-copy filter strips it from older repos that still carry the label.
  "answered",
  LABEL_DEFAULTS.needsRevisionLabel,
  LABEL_DEFAULTS.needsHumanLabel,
  LABEL_DEFAULTS.grillMeLabel,
  // Issue #4112: `quorum` starts a three-agent plan-off — a privileged,
  // triple-billed phase. It is human-applied only, so it is reserved here and
  // the worker's own label guard refuses it.
  LABEL_DEFAULTS.quorumLabel,
  // Issue #59 (part of #54): `needs-failure-detection-repair` marks a planning
  // parent whose published sub-issues still need their `## Failure Detection`
  // criterion. The worker raises it (see `failure_detection_repair_label.ts`);
  // reserved so the planner can never apply it as a descriptive label on a
  // sub-issue and manufacture a phantom repair queue.
  FAILURE_DETECTION_REPAIR_LABEL,
];

/**
 * Lower-cased view of {@link RESERVED_LABELS} for case-insensitive membership
 * checks (Issue #3088).
 *
 * GitHub treats label names case-insensitively (it forbids two labels that
 * differ only in case), so the reserved-label guards must match the same way.
 * Built once at module load from the single `RESERVED_LABELS` constant so the
 * set stays in sync automatically (no second hand-maintained list — DRY).
 */
const RESERVED_LABELS_LOWER: ReadonlySet<string> = new Set(
  RESERVED_LABELS.map((label) => label.toLowerCase()),
);

/**
 * Return true if `label` is a reserved workflow label, comparing
 * case-insensitively (Issue #3088).
 *
 * The canonical `RESERVED_LABELS` entries are all lower-case, but a repo could
 * store a canonical label in a non-lower-case form (e.g. `Planning`). A
 * case-sensitive `RESERVED_LABELS.includes(label)` would then miss it, leaving
 * the strip guards out of step with the dispatch gate
 * (`requiresLabelAdderTrust`), which already lower-cases. This helper keeps all
 * the guards consistent.
 *
 * @param label - The label name to test
 * @returns True if the label (case-insensitively) is reserved
 */
export function isReservedLabel(label: string): boolean {
  return RESERVED_LABELS_LOWER.has(label.toLowerCase());
}

/**
 * Operational defaults — timeouts, intervals, and numeric settings.
 *
 * Issue #277: These values are now configurable via .config.json.
 * Only values that differ from these defaults need to be stored in the config file.
 * If a default changes in the codebase, all users get the new default unless
 * they have explicitly overridden it.
 */
export const OPERATIONAL_DEFAULTS = {
  // Issue #1824: lowered from 14400 (4h) to 3600 (1h). A 4-hour wedge on
  // a single Claude run consumed an entire iteration's run-duration budget
  // and starved other repositories. If issue work genuinely needs more
  // than an hour, the escape hatch should raise a sub-issue.
  claudeTimeout: 3600,
  /**
   * Claim-runway floor in seconds (Issue #289). Five minutes: enough to rule
   * out a claim that cannot finish setup, small enough that a run keeps
   * claiming until its last minutes. The single definition lives in
   * `claim_runway.ts`.
   */
  minClaimRunwaySeconds: DEFAULT_MIN_CLAIM_RUNWAY_SECONDS,
  /**
   * Full-execute-budget claim gate (Issue #289). Off by default: on a host
   * whose cycle is longer than `claudeTimeout` it idles the cycle tail, and
   * WIP preservation (Issues #47/#148) makes a deadline-bound execute safe.
   */
  claimRequireFullExecuteBudget: false,
  /**
   * Re-armable hard deadline for issue work (Issue #4296, part of #4290).
   *
   * Off by default: the change lands dark and is switched on deliberately.
   * With it on, the `claudeTimeout` kill for **issue work only** is deferred
   * while the run shows both recent tool activity and a working tree that
   * actually advanced. Every other phase keeps its unconditional cap.
   */
  progressExtensionEnabled: false,
  /** Seconds each grant adds to the deadline, measured from now (#4296). */
  progressExtensionGrantSeconds: 900,
  /** A tool call older than this is no longer evidence of activity (#4296). */
  progressExtensionStallSeconds: 300,
  /**
   * How often the working tree is sampled between deadline checks (#4295).
   *
   * Bounds how stale the tree verdict can be when the deadline decision is
   * taken, so a run that stops changing the checkout is noticed within a
   * check interval rather than a whole grant. Must not exceed
   * `progressExtensionStallSeconds`, or a run that progressed inside the
   * sampling window could still be killed for stale tool activity.
   */
  progressExtensionCheckSeconds: 300,
  claudeKillAfter: 30,
  maxClarificationRounds: 3,
  sleepInterval: 30,
  // Concurrent-issue slots (Issues #4174/#4177, VibeCoder#170): two by
  // default — the intended cadence is "work as many issues as possible in
  // each hourly run", and the slot governor (#4179) lowers the effective
  // count under memory pressure. `1` opts back into the serial loop.
  maxConcurrentIssues: 2,
  creditWaitInterval: 300,
  refinementTimeout: 300,
  refinementKillAfter: 10,
  // Issue #1824: lowered from 14400 (4h) to 1800 (30 min). Planning produces
  // sub-issues — it should be quick.
  planningTimeout: 1800,
  planningKillAfter: 10,
  /**
   * Hard timeout in seconds for the PR feedback phase (Issue #1824).
   * A single PR comment cannot reasonably need more than 30 minutes.
   * Distinct from `claudeTimeout` so reactive phases do not inherit
   * the larger issue-work budget.
   */
  prFeedbackTimeout: 1800,
  /**
   * Hard timeout in seconds for the CI fix phase (Issue #1824).
   * The failed annotation set is bounded — 30 minutes is generous.
   * Distinct from `claudeTimeout` so reactive phases do not inherit
   * the larger issue-work budget.
   */
  ciFixTimeout: 1800,
  questionTimeout: 600,
  questionKillAfter: 10,
  clarificationTimeout: 120,
  clarificationKillAfter: 10,
  /**
   * Maximum number of grill-me clarification rounds before the workflow
   * gives up and hands the issue back (Issue #1616).
   */
  maxGrillMeRounds: 5,
  /**
   * Timeout in seconds for a single grill-me round (Issue #1616).
   *
   * Grill-me is an analysis phase, not a code change — a round may need to
   * investigate the codebase, run a live model probe (e.g. confirm Fable is
   * actually served), and reason at top-tier model + `max` effort. The old
   * 600s ceiling was borrowed from the lightweight question/clarification
   * phases and starved that work, so heavy rounds died at "Claude timed out"
   * and escalated to `needs-human` (Issue #3154). It now matches the
   * issue-work budget (`claudeTimeout`, 1h); the process is killed at the
   * hour regardless, which is the intended safety cap.
   */
  grillMeTimeout: 3600,
  /** Grace period in seconds after grillMeTimeout before kill (Issue #1616). */
  grillMeKillAfter: 10,
  /**
   * Wall-clock budget in seconds for **one** Quorum agent (Issue #4112).
   *
   * A Quorum agent drafts (or judges) a plan, which is planning-shaped work —
   * so the budget matches `planningTimeout` rather than the hour an
   * implementation run gets. The two drafts run concurrently, so a whole run
   * costs one draft plus one judgement, not three sequential budgets.
   */
  quorumTimeout: 1800,
  /** Grace in seconds after quorumTimeout before the agent is killed (#4112). */
  quorumKillAfter: 10,
  maxRateLimitRetries: 2,
  maxRateLimitWait: 600,
  retryMaxDelay: 60,
  maxIssueBodyTokens: 50000,
  summariseTimeout: 120,
  summariseKillAfter: 10,
  featureCheckTimeout: 5,
  // Issue #1825: lowered from 900 (15 min) to 600 (10 min). 15 minutes of
  // silence is too generous for unattended self-healing — wedged Claude
  // processes need the silence watchdog to kick in earlier.
  claudeNoOutputTimeout: 600,
  qualityCheckTimeout: 600,
  claimChurnThreshold: 3,
  healthCacheTtl: 900,
  enableModelFallback: true,
  minDiskSpaceMb: 500,
  syncMilestoneBranches: true,
  milestoneSyncCooldownSeconds: 3600,
  repoTimeoutThreshold: 3,
  staleFailedDiagnosticDays: 3,
  stalePlanningWarningDays: 2,
  includeRecentActivity: true,
  recentActivityMergedPrLimit: 10,
  recentActivityCommitLimit: 20,
  recentActivityMaxTokens: 1000,
  recentActivityCacheTtlSeconds: 300,
  /**
   * Inject the generated per-repo codebase map into issue prompts
   * (Issue #4281). On by default: without it every session pays a
   * rediscovery tax before it can start work.
   */
  includeCodebaseMap: true,
  /**
   * TTL in seconds for the issue-timeline cache used by label-author
   * checks (Issue #1673). Defaults to 5 minutes — shorter than the
   * 10-minute issues TTL because timelines mutate when labels are
   * re-applied. The worker invalidates the entry whenever it adds a
   * label itself.
   */
  timelineCacheTtlSeconds: 300,
  enableSessionResume: false,
  /** Maximum session store size in bytes before compaction (50 MB) (Issue #1328). */
  maxSessionSizeBytes: 50 * 1024 * 1024,
  /** Maximum session age in days before cleanup (Issue #1328). */
  maxSessionAgeDays: 7,
  contextBudgetWarningPercent: 50,
  contextBudgetErrorPercent: 80,
  /**
   * Hard context-budget ceiling as a percentage (Issue #3713). At or above
   * this usage the execution phase stops and escalates instead of sending a
   * prompt the model would truncate. `0` disables the ceiling.
   */
  contextBudgetBlockPercent: 95,
  /** Maximum total characters across all comments included in the prompt (Issue #1342). */
  maxTotalCommentChars: 20_000,
  /** Maximum characters per untrusted comment before truncation (Issue #1342). */
  maxUntrustedCommentChars: 2_000,
  /** Maximum number of untrusted comments to include in the prompt (Issue #1342). */
  maxUntrustedCommentCount: 5,
  /** Threshold of untrusted comments that triggers a flood audit event (Issue #1342). */
  commentFloodThreshold: 10,
  /**
   * Whether to include untrusted comments in the prompt (Issue #1340).
   * - `true` (default): include with trust-level annotations (defence in depth)
   * - `false` (strict mode): exclude untrusted comments entirely
   */
  includeUntrustedComments: true,
  /**
   * Cooldown in seconds before an issue with a recently-closed PR can be
   * picked up again (Issue #1427). Prevents creating duplicate PRs for the
   * same issue when the previous PR was closed without merge.
   */
  closedPrCooldownSeconds: 3600,
  /**
   * Whether to unassign the worker from the source issue immediately after
   * a successful PR creation (Issue #1453). This removes the
   * "assigned + no heartbeat" state that triggers false-positive recoveries
   * in `detectAssignedWithoutHeartbeat`. Defaults to `true`.
   */
  unassignOnPrCreated: true,
  /**
   * Age threshold in days before a repo work directory with no heartbeat
   * is classified as stale and removed (Issue #1493). Defaults to 7 days.
   */
  staleWorkDirDays: 7,
  /**
   * Maximum retry attempts for a single software update command (Issue #1496).
   * Defaults to 3 so transient failures self-heal without dropping the
   * weekly update entirely.
   */
  updateRetryMaxAttempts: 3,
  /**
   * Exponential backoff delays in seconds between software update retries
   * (Issue #1496). The i-th entry is the delay AFTER attempt i+1 failed.
   * Defaults to [30, 90, 300] — gentle for flaky mirrors, short enough to
   * complete inside the weekly update window.
   */
  updateRetryBackoffSeconds: [30, 90, 300] as readonly number[],
  /**
   * Per-tool minimum version floors for software auto-update (Issue #2622).
   * When the installed version of a tool is below its floor, the update runs
   * immediately, bypassing the 7-day interval gate. `claude` is pinned to
   * 2.1.170 — the oldest release verified to support `--model fable`. Generic
   * per-tool map so gh/deno floors can be added later; empty for tools without
   * a floor.
   */
  softwareMinVersions: { claude: "2.1.170" } as Readonly<
    Record<string, string>
  >,
  /**
   * Whether the worker's quality gate should treat the post-Claude run as
   * passed when every current diffable finding (mermaid, markdownlint,
   * docs prompt-version) was already present at baseline (Issue #1549,
   * generalised by #2604). When true, a failing post-Claude quality run
   * is compared against the baseline finding set captured before Claude
   * started; if no new findings were introduced the gate is treated as
   * passed. When false, any failing run consumes a `failed-once` attempt
   * regardless of the baseline. Defaults to `true`. Per-repo override is
   * honoured via `repoConfig[repo].baselineAwareQualityGate`.
   */
  baselineAwareQualityGate: true,
  /**
   * Backoff in milliseconds before an in-process retry of an
   * infrastructure-category phase failure (Issue #1550). Defaults to 15s —
   * gives transient environment blips (rate limits, zero-output, push
   * rejection) a chance to clear before applying the `failed-once` label.
   */
  infraRetryBackoffMs: 15_000,
  /**
   * Maximum automatic fix attempts per failure signature before the worker
   * stops and escalates with `needs-human` (Issue #3582). Counted against a
   * signature that survives pushes, so three attempted fixes on one failure
   * exhaust the budget. `infrastructure`-category failures do not consume an
   * attempt. Per-repo override: `repoConfig[repo].maxAutoFixAttempts`.
   */
  maxAutoFixAttempts: 3,
} as const;

/**
 * Default list of trusted PR review bot accounts (Issue #1856).
 *
 * Bots in this list have their **PR review comments** (line-level
 * comments on `/pulls/{n}/comments`) auto-trusted by the PR feedback
 * worker without requiring a thumbs-up reaction or membership in
 * `authorisedCommenters`. Issue comments (top-level discussion) are
 * NOT auto-trusted by this list — they still require a thumbs-up or
 * `authorisedCommenters` membership.
 *
 * Names are case-sensitive exact GitHub usernames.
 */
export const DEFAULT_TRUSTED_REVIEW_BOTS: readonly string[] = [
  "github-code-quality[bot]",
  "coderabbitai[bot]",
  "sonarcloud[bot]",
  "deepsource-io[bot]",
  "codeclimate[bot]",
] as const;

/**
 * @deprecated Use OPERATIONAL_DEFAULTS instead (Issue #277).
 * Kept for backward compatibility with existing code.
 */
export const NUMERIC_DEFAULTS = {
  claudeTimeout: OPERATIONAL_DEFAULTS.claudeTimeout,
  maxClarificationRounds: OPERATIONAL_DEFAULTS.maxClarificationRounds,
} as const;

/**
 * Default worker_name setting (Issue #436).
 * When empty (default), falls back to the GitHub username.
 * When set, appears in issue comments and PR descriptions for
 * multi-worker visibility.
 */
export const DEFAULT_WORKER_NAME = "" as const;

/**
 * Default shuffle_repos setting (Issue #435).
 * When true (default), repos are shuffled to prevent starvation.
 * When false, repos are scanned in configured order for per-worker priority.
 */
export const DEFAULT_SHUFFLE_REPOS = true as const;

/**
 * Default per-repo `nice` value (Issue #2772, part of #2771).
 *
 * Unix-`nice` semantics: **lower = worked sooner**. `0` is the neutral
 * default, so a repo with no configured `nice` is neither promoted nor
 * deprioritised. Operator-side only — read from `.config.json`
 * `repo_config.<owner/repo>`, never from the target repo (Issue #2626).
 *
 * Single source of truth for the resolver `getRepoNice()` in
 * `repo_config.ts` (Issue #904).
 */
export const DEFAULT_REPO_NICE = 0 as const;

/**
 * Verbosity levels for configurable response output (Issue #1330).
 *
 * Part of #1329 (caveman mode). Different task types and repositories
 * benefit from different levels of output detail:
 * - minimal: bare minimum output (e.g. "done", one-line summary)
 * - concise: brief but informative — key decisions and outcomes only
 * - standard: current default behaviour — balanced detail
 * - verbose: detailed explanations of reasoning, trade-offs, alternatives
 */
export const VERBOSITY_LEVELS = {
  minimal: "minimal",
  concise: "concise",
  standard: "standard",
  verbose: "verbose",
} as const;

/**
 * Default verbosity level (Issue #1330).
 * "standard" preserves existing behaviour for all repositories unless overridden.
 */
export const DEFAULT_VERBOSITY = "standard" as const;

/**
 * Phase-specific verbosity defaults (Issue #1330).
 *
 * Maps each worker phase to a sensible default verbosity level.
 * Phases not listed here fall back to DEFAULT_VERBOSITY ("standard").
 *
 * Rationale:
 * - spelling_fix / summarise → minimal (trivial, mechanical tasks)
 * - ci_fix / pr_feedback / quality_fix / refinement / revision / clarification → concise
 *   (reactive tasks with structured input — brief output is sufficient)
 * - issue → standard (general implementation — balanced detail)
 * - planning / question → verbose (architecture decisions need full reasoning)
 */
export const PHASE_VERBOSITY_DEFAULTS: Readonly<Record<string, string>> = {
  spelling_fix: VERBOSITY_LEVELS.minimal,
  summarise: VERBOSITY_LEVELS.minimal,
  ci_fix: VERBOSITY_LEVELS.concise,
  pr_feedback: VERBOSITY_LEVELS.concise,
  quality_fix: VERBOSITY_LEVELS.concise,
  refinement: VERBOSITY_LEVELS.concise,
  revision: VERBOSITY_LEVELS.concise,
  clarification: VERBOSITY_LEVELS.concise,
  issue: VERBOSITY_LEVELS.standard,
  planning: VERBOSITY_LEVELS.verbose,
  question: VERBOSITY_LEVELS.verbose,
} as const;

/**
 * Effort levels for the Claude CLI `--effort` flag (Issue #1402, #2620).
 *
 * Part of #1389. Different task phases benefit from different effort levels —
 * planning needs maximum effort for architectural decisions, while simple tasks
 * like spelling fixes need minimal effort to save cost and time.
 *
 * `xhigh` (Issue #2620) sits between `high` and `max`. Claude Code 2.1.170+
 * accepts five levels (`low, medium, high, xhigh, max`); `xhigh` is Anthropic's
 * recommended setting for most coding and agentic use on Opus 4.7+ / Fable 5
 * (Claude Code's own interactive default).
 */
export const EFFORT_LEVELS = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

/**
 * Default effort level (Issue #1402).
 * "high" is the global fallback for phases not listed in PHASE_EFFORT_DEFAULTS.
 */
export const DEFAULT_EFFORT = "high" as const;

/**
 * Default effort level for the planning phase (Issue #1402, #3229).
 * Planning is one of the six planning-shaped phases — where the Vibe Coder
 * interprets the user's words into an implementable state — that run on the
 * Fable 5 top tier (see PHASE_MODEL_DEFAULTS). The *normal* effort for those
 * phases is "high"; the `max` bump is reserved for the pre-flight reroute to
 * Opus when Fable is unavailable (a separate #3217 sub-issue). Previously max.
 */
export const DEFAULT_CLAUDE_EFFORT_PLANNING = "high" as const;

/**
 * Default effort level for the grill-me phase (Issue #2621, #3229).
 * Requirements interrogation shapes every downstream sub-issue — the same
 * plan-quality argument as planning — so it is one of the six planning-shaped
 * phases that run on the Fable 5 top tier at "high" effort. Previously max.
 */
export const DEFAULT_CLAUDE_EFFORT_GRILL_ME = "high" as const;

/**
 * Default effort for both Quorum phases (Issue #4112, parent #4102).
 * Drafting a plan and judging two of them are planning-shaped work, so both
 * run at the same "high" effort as planning and grill-me.
 */
export const DEFAULT_CLAUDE_EFFORT_QUORUM = "high" as const;

/**
 * Default effort level for the issue phase (Issue #1402).
 * General implementation benefits from thorough reasoning.
 */
export const DEFAULT_CLAUDE_EFFORT_ISSUE = "high" as const;

/**
 * Default effort level for the question phase (Issue #1402, #2391, #3229).
 * Answering a user's question is one of the six planning-shaped phases — the
 * Vibe Coder interprets the user's words into an implementable state — so it
 * runs on the Fable 5 top tier at "high" effort (see PHASE_MODEL_DEFAULTS).
 * Previously opus + medium.
 */
export const DEFAULT_CLAUDE_EFFORT_QUESTION = "high" as const;

/**
 * Default effort level for the CI fix phase (Issue #1402).
 * CI failures come with structured error messages — reactive, well-scoped.
 */
export const DEFAULT_CLAUDE_EFFORT_CI_FIX = "medium" as const;

/**
 * Default effort level for the PR feedback phase (Issue #1402).
 * Targeted fixes from reviewer comments — reactive, constrained.
 */
export const DEFAULT_CLAUDE_EFFORT_PR_FEEDBACK = "medium" as const;

/**
 * Default effort level for the quality fix phase (Issue #1402).
 * Reactive test/lint fixes with structured error output.
 */
export const DEFAULT_CLAUDE_EFFORT_QUALITY_FIX = "medium" as const;

/**
 * Default effort level for the refinement phase (Issue #1402, #3229).
 * Rewording titles/descriptions is one of the six planning-shaped phases —
 * the Vibe Coder interprets the user's words into an implementable state — so
 * it runs on the Fable 5 top tier at "high" effort. Previously medium.
 */
export const DEFAULT_CLAUDE_EFFORT_REFINEMENT = "high" as const;

/**
 * Default effort level for the revision phase (Issue #1402, #3229).
 * Review-based rewriting is one of the six planning-shaped phases — the Vibe
 * Coder interprets the user's words into an implementable state — so it runs
 * on the Fable 5 top tier at "high" effort. Previously medium.
 */
export const DEFAULT_CLAUDE_EFFORT_REVISION = "high" as const;

/**
 * Default effort level for the clarification phase (Issue #1402, #3229).
 * Assessing issue clarity is one of the six planning-shaped phases — the Vibe
 * Coder interprets the user's words into an implementable state — so it runs
 * on the Fable 5 top tier at "high" effort. Previously medium.
 */
export const DEFAULT_CLAUDE_EFFORT_CLARIFICATION = "high" as const;

/**
 * Default effort level for the spelling fix phase (Issue #1402).
 * Simple typo corrections — minimal effort needed.
 */
export const DEFAULT_CLAUDE_EFFORT_SPELLING_FIX = "low" as const;

/**
 * Default effort level for the summarise phase (Issue #1402).
 * Lightweight summarisation — minimal effort is sufficient.
 */
export const DEFAULT_CLAUDE_EFFORT_SUMMARISE = "low" as const;

/**
 * Default effort level for the health check phase (Issue #1402).
 * Trivial health check — minimal effort needed.
 */
export const DEFAULT_CLAUDE_EFFORT_HEALTH = "low" as const;

/**
 * Phase-specific effort defaults (Issue #1402, #2391).
 *
 * Maps phase names to their default effort level. Phases not listed here
 * fall back to DEFAULT_EFFORT ("high").
 *
 * Effort-first routing (Issue #2391): effort is the *primary* cost lever
 * and the effort tiers below encode each phase's complexity. Issue #2621
 * adds model tier as a *secondary* lever above Opus (Fable 5), and Issue
 * #3229 extends the Fable tier to all six planning-shaped phases — wherever
 * the Vibe Coder interprets the user's words into an implementable state, use
 * the highest model available (see PHASE_MODEL_DEFAULTS). The effort tiers:
 * - planning / grill_me / refinement / revision / question / clarification →
 *   high (the six planning-shaped phases; their `max` bump is reserved for the
 *   #3217 pre-flight reroute to Opus when Fable is unavailable)
 * - issue → high (thorough reasoning for implementation)
 * - ci_fix / pr_feedback / quality_fix → medium (reactive tasks with
 *   structured input)
 * - spelling_fix / summarise / health → low (trivial, mechanical tasks)
 */
export const PHASE_EFFORT_DEFAULTS: Readonly<Record<string, string>> = {
  planning: DEFAULT_CLAUDE_EFFORT_PLANNING,
  grill_me: DEFAULT_CLAUDE_EFFORT_GRILL_ME,
  // Issue #4112: the two Quorum phases — `quorum` drafts, `quorum_judge`
  // adjudicates (the phase names `quorum_orchestrator.ts` stamps).
  quorum: DEFAULT_CLAUDE_EFFORT_QUORUM,
  quorum_judge: DEFAULT_CLAUDE_EFFORT_QUORUM,
  issue: DEFAULT_CLAUDE_EFFORT_ISSUE,
  question: DEFAULT_CLAUDE_EFFORT_QUESTION,
  ci_fix: DEFAULT_CLAUDE_EFFORT_CI_FIX,
  pr_feedback: DEFAULT_CLAUDE_EFFORT_PR_FEEDBACK,
  quality_fix: DEFAULT_CLAUDE_EFFORT_QUALITY_FIX,
  refinement: DEFAULT_CLAUDE_EFFORT_REFINEMENT,
  revision: DEFAULT_CLAUDE_EFFORT_REVISION,
  clarification: DEFAULT_CLAUDE_EFFORT_CLARIFICATION,
  spelling_fix: DEFAULT_CLAUDE_EFFORT_SPELLING_FIX,
  summarise: DEFAULT_CLAUDE_EFFORT_SUMMARISE,
  health: DEFAULT_CLAUDE_EFFORT_HEALTH,
} as const;

/**
 * Default Claude model selection (Issue #260, #2391).
 *
 * Opus is the single base tier. Under effort-first routing (#2391) every
 * phase defaults to this one tier and varies *effort* rather than switching
 * model families — see the per-phase constants below and PHASE_EFFORT_DEFAULTS.
 */
export const DEFAULT_CLAUDE_MODEL = "opus" as const;

// ---------------------------------------------------------------------------
// Per-phase model defaults — effort-first routing (Issues #2390, #2391)
//
// Now that a single model (Opus 4.8) spans the full effort range and the
// Opus↔Sonnet price gap is small (~1.7×), the worker consolidates the former
// mid (Sonnet) tier up onto the single top tier (Opus) and uses effort
// (PHASE_EFFORT_DEFAULTS) as the *primary* cost lever — one quality bar with a
// tunable depth dial — instead of routing each phase to a different model
// family. This also sidesteps the Opus alias→pricing mismatch (#2389).
//
// Tier is the *secondary* lever, applied at both extremes. At the cheap
// extreme the three trivial phases (spelling_fix, summarise, health) stay on
// Haiku — the Opus↔Haiku gap is still ~5×, summarise can be fed very large
// inputs, and the large-input escalation in phase_model_escalation.ts (#2393)
// already lifts a Haiku phase to a 1M-window tier when an input would
// otherwise truncate. At the top extreme the six planning-shaped phases run on
// the Fable 5 tier above Opus. Issue #2621 promoted the first two (planning,
// grill_me); Issue #3229 extended the tier to the other four (refinement,
// revision, question, clarification) under one guiding rule: wherever the Vibe
// Coder interprets the user's words into an implementable state, use the
// highest model available. A better interpretation compounds across every
// downstream sub-issue and PR, so the ~2× Fable premium is spent there.
//
// Issue #2390 specifically evaluated whether the reactive phases (ci_fix,
// pr_feedback, quality_fix) should drop to opus + LOW effort, and whether
// refinement / clarification / question should demote to Haiku. The decision
// — recorded in docs/MODEL-AND-CACHING.md under "Per-phase decision log" — was
// to consolidate the reactive phases on opus + medium: preserve the
// medium-effort floor on reactive work (the hard cases need the reasoning
// depth) and let operators override per-repo if they want a cheaper tier.
// Issue #3229 later re-tiered refinement / revision / question / clarification
// *up* to Fable + high (not down to Haiku): they are planning-shaped phases
// where the Vibe Coder interprets the user's words, so they join planning and
// grill_me on the top tier. The three genuinely reactive phases (ci_fix,
// pr_feedback, quality_fix) keep opus + medium.
//
// The named per-phase constants are retained so the override chain
// (CLAUDE_MODEL_<PHASE> env vars, phase_model_overrides config) and the
// shell-default emitter keep working unchanged.
// ---------------------------------------------------------------------------

/**
 * Top model tier — Fable 5, the tier above Opus (Issues #2619, #2621).
 *
 * The worker passes the `fable` alias; the Claude CLI resolves it to the
 * latest Fable model (combined with the CLI minimum-version floor in #2622,
 * this keeps the tier current with no per-release config change). Reserved
 * for the six planning-shaped phases (planning, grill_me, refinement,
 * revision, question, clarification) where the Vibe Coder interprets the
 * user's words into an implementable state and a better interpretation
 * compounds across every downstream sub-issue and PR. Fable is ~2× Opus
 * pricing, so the spend is deliberately concentrated on those phases.
 */
export const DEFAULT_CLAUDE_MODEL_TOP_TIER = "fable" as const;

/** Planning phase model — Fable 5 top tier (effort: high, Issue #2621, #3229). */
export const DEFAULT_CLAUDE_MODEL_PLANNING = DEFAULT_CLAUDE_MODEL_TOP_TIER;

/**
 * Default configured best planning model (Issue #2654).
 *
 * The degraded-model detector (`planning_run_stats.ts`) flags a planning run
 * as degraded when a plan-generating response was served by a model other than
 * this configured best planning model, then labels the parent issue and every
 * sub-issue with `degraded-model` (#2646).
 *
 * Empty by default: an empty value means "derive the expected model from the
 * planning routing chain" — `buildClaudeModelArgs("planning")`, which already
 * resolves to {@link DEFAULT_CLAUDE_MODEL_PLANNING} and honours every per-repo
 * and global model override. This keeps the per-repo-override-for-free
 * behaviour (#2625) and never flags a repo that deliberately routes planning to
 * a different tier. Pin a specific model (globally via `best_planning_model`,
 * or per-repo via `repo_config`) to expect that exact model regardless of which
 * tier the worker routes the request to.
 */
export const DEFAULT_BEST_PLANNING_MODEL = "" as const;

/** Grill-me phase model — Fable 5 top tier (effort: high, Issue #2621, #3229). */
export const DEFAULT_CLAUDE_MODEL_GRILL_ME = DEFAULT_CLAUDE_MODEL_TOP_TIER;

/**
 * Quorum phase model — Fable 5 top tier (effort: high, Issue #4112).
 *
 * Quorum decides *what the plan is* before the planning phase splits it into
 * sub-issues, so both its phases are planning-shaped and take the same tier as
 * planning. A non-Claude provider ignores the alias — the routing entry is what
 * the Claude-backed members of the trio resolve.
 */
export const DEFAULT_CLAUDE_MODEL_QUORUM = DEFAULT_CLAUDE_MODEL_TOP_TIER;

/**
 * The two drafting providers of a Quorum run (Issue #4112).
 *
 * Claude-only by default: the wiring lands ahead of the multi-vendor
 * credential work, so an unchanged deployment runs both planners on the
 * provider it already has credentials for.
 *
 * A function, not a top-level constant: `agent_provider.ts` imports this
 * module back, so reading `DEFAULT_AGENT_PROVIDER_ID` at module-evaluation
 * time throws a temporal-dead-zone error. Deferring the read to call time —
 * the same thing `buildDefaultWorkerConfig` already does — keeps the single
 * source of truth without the cycle.
 */
export function defaultQuorumPlanners(): string[] {
  return [DEFAULT_AGENT_PROVIDER_ID, DEFAULT_AGENT_PROVIDER_ID];
}

/** The adjudicating provider of a Quorum run — Claude by default (#4112). */
export function defaultQuorumJudge(): string {
  return DEFAULT_AGENT_PROVIDER_ID;
}

/**
 * Issue (coding/implementation) phase model — Opus base tier (effort: high,
 * Issue #2709).
 *
 * The coding run now routes through `phase: "issue"`, so this pins the
 * implementation tier explicitly rather than relying on the CLI default.
 * Effort is the primary lever (PHASE_EFFORT_DEFAULTS.issue = "high"); model
 * stays on the single Opus base tier like every other non-extreme phase.
 */
export const DEFAULT_CLAUDE_MODEL_ISSUE = DEFAULT_CLAUDE_MODEL;

/**
 * Refinement phase model — Fable 5 top tier (effort: high, Issue #3229).
 * A planning-shaped phase: the Vibe Coder interprets the user's words into an
 * implementable state. Previously opus.
 */
export const DEFAULT_CLAUDE_MODEL_REFINEMENT = DEFAULT_CLAUDE_MODEL_TOP_TIER;

/** CI fix phase model — Opus base tier (effort: medium). */
export const DEFAULT_CLAUDE_MODEL_CI_FIX = DEFAULT_CLAUDE_MODEL;

/**
 * Revision phase model — Fable 5 top tier (effort: high, Issue #3229).
 * A planning-shaped phase: the Vibe Coder interprets the user's words into an
 * implementable state. Previously opus.
 */
export const DEFAULT_CLAUDE_MODEL_REVISION = DEFAULT_CLAUDE_MODEL_TOP_TIER;

/** PR feedback phase model — Opus base tier (effort: medium). */
export const DEFAULT_CLAUDE_MODEL_PR_FEEDBACK = DEFAULT_CLAUDE_MODEL;

/** Quality fix phase model — Opus base tier (effort: medium). */
export const DEFAULT_CLAUDE_MODEL_QUALITY_FIX = DEFAULT_CLAUDE_MODEL;

/**
 * Question phase model — Fable 5 top tier (effort: high, Issue #3229).
 * A planning-shaped phase: the Vibe Coder interprets the user's words into an
 * implementable state. Previously opus.
 */
export const DEFAULT_CLAUDE_MODEL_QUESTION = DEFAULT_CLAUDE_MODEL_TOP_TIER;

/**
 * Clarification phase model — Fable 5 top tier (effort: high, Issue #3229).
 * A planning-shaped phase: the Vibe Coder interprets the user's words into an
 * implementable state. Previously opus.
 */
export const DEFAULT_CLAUDE_MODEL_CLARIFICATION = DEFAULT_CLAUDE_MODEL_TOP_TIER;

/**
 * Spelling fix phase model — Haiku (secondary tier lever, effort: low).
 * Simplest, lowest-volume task; the ~5× Opus premium buys nothing here.
 */
export const DEFAULT_CLAUDE_MODEL_SPELLING_FIX = "haiku" as const;

/**
 * Summarise phase model — Haiku (secondary tier lever, effort: low).
 * Lightweight compression, but fed the largest inputs (whole sessions); the
 * #2393 escalation lifts it to a 1M-window tier when an input would truncate.
 */
export const DEFAULT_CLAUDE_MODEL_SUMMARISE = "haiku" as const;

/**
 * Health check phase model — Haiku (secondary tier lever, effort: low).
 * Trivial pre-flight ("Respond with exactly: OK") run frequently — keep cheap.
 */
export const DEFAULT_CLAUDE_MODEL_HEALTH = "haiku" as const;

/**
 * Model tier fallback mapping (Issue #1112, #2619).
 *
 * Maps each model tier to its next-cheaper alternative.
 * Used by the budget-exceeded fallback feature to downgrade models.
 * Fable 5 is the top tier above Opus, so the chain degrades
 * fable → opus → sonnet → haiku.
 */
export const MODEL_FALLBACK_MAP: Readonly<Record<string, string | null>> = {
  fable: "opus",
  opus: "sonnet",
  sonnet: "haiku",
  haiku: null,
} as const;

/**
 * Look up the cheaper fallback model for a given model string.
 *
 * Handles both short names (e.g. "opus") and full model IDs
 * (e.g. "claude-opus-4-7"). Returns null if no cheaper model
 * exists or the model is unrecognised.
 *
 * Issue #1112: Foundational utility for budget-exceeded fallback.
 */
export function getCheaperModel(currentModel: string): string | null {
  // Direct match on short name
  if (currentModel in MODEL_FALLBACK_MAP) {
    return MODEL_FALLBACK_MAP[currentModel] ?? null;
  }

  // Try to extract tier from full model ID (e.g. "claude-opus-4-6")
  for (const tier of Object.keys(MODEL_FALLBACK_MAP)) {
    if (
      currentModel.includes(`-${tier}-`) || currentModel.includes(`-${tier}`)
    ) {
      return MODEL_FALLBACK_MAP[tier] ?? null;
    }
  }

  return null;
}

/**
 * Phase-specific model defaults (Issue #1071, #2391).
 *
 * Maps phase names to their default model. Phases not listed here
 * fall back to the base CLAUDE_MODEL env var (or no model args).
 *
 * Routing (Issues #2391, #2621, #3229): effort (PHASE_EFFORT_DEFAULTS) is the
 * *primary* cost lever; model tier is the *secondary* lever applied at both
 * extremes. The six planning-shaped phases (planning, grill_me, refinement,
 * revision, question, clarification) run on the Fable 5 top tier — wherever
 * the Vibe Coder interprets the user's words into an implementable state, use
 * the highest model available, because a better interpretation compounds
 * across every downstream sub-issue and PR (#2621, #3229). The three trivial
 * phases (spelling_fix, summarise, health) stay on the cheaper Haiku tier. The
 * remaining phases (issue, ci_fix, pr_feedback, quality_fix) resolve to Opus
 * (DEFAULT_CLAUDE_MODEL), differentiated by effort. The map stays populated
 * (rather than empty) so each phase is explicitly pinned regardless of the
 * CLI's own default, while the override chain keeps tier fully tunable.
 */
export const PHASE_MODEL_DEFAULTS: Readonly<Record<string, string>> = {
  planning: DEFAULT_CLAUDE_MODEL_PLANNING,
  grill_me: DEFAULT_CLAUDE_MODEL_GRILL_ME,
  // Issue #4112: both Quorum phases join the planning-shaped top tier.
  quorum: DEFAULT_CLAUDE_MODEL_QUORUM,
  quorum_judge: DEFAULT_CLAUDE_MODEL_QUORUM,
  issue: DEFAULT_CLAUDE_MODEL_ISSUE,
  refinement: DEFAULT_CLAUDE_MODEL_REFINEMENT,
  revision: DEFAULT_CLAUDE_MODEL_REVISION,
  ci_fix: DEFAULT_CLAUDE_MODEL_CI_FIX,
  quality_fix: DEFAULT_CLAUDE_MODEL_QUALITY_FIX,
  pr_feedback: DEFAULT_CLAUDE_MODEL_PR_FEEDBACK,
  spelling_fix: DEFAULT_CLAUDE_MODEL_SPELLING_FIX,
  question: DEFAULT_CLAUDE_MODEL_QUESTION,
  clarification: DEFAULT_CLAUDE_MODEL_CLARIFICATION,
  summarise: DEFAULT_CLAUDE_MODEL_SUMMARISE,
  health: DEFAULT_CLAUDE_MODEL_HEALTH,
} as const;

/**
 * Overrides accepted by {@link buildDefaultWorkerConfig}. Issue #2166: typed as
 * `Partial<WorkerConfig>` so a misspelt key is caught at compile time.
 */
type DefaultConfigOverrides = Partial<WorkerConfig>;

/**
 * Build a default WorkerConfig with all operational values filled in.
 *
 * Use this to construct a WorkerConfig without specifying every field.
 * Pass overrides to customise specific values.
 *
 * Issue #277: Centralised default config builder to keep things DRY.
 * Issue #2166: Returns a concrete `WorkerConfig` (previously `any`) so the
 *   literal below is structurally checked against the interface. Excess
 *   fields and missing required fields are both compile-time errors.
 */
export function buildDefaultWorkerConfig(
  overrides: DefaultConfigOverrides = {},
): WorkerConfig {
  return {
    allowedAuthors: [],
    allowedAuthor: "",
    prReviewer: "",
    prReviewers: [],
    repos: [],
    // Issue #1834: issueLabels is hardwired — only the top-priority label
    // is iterated by the configured-label collector. The work-on and
    // low-priority labels have dedicated, author-checked collectors.
    issueLabels: [LABEL_DEFAULTS.topPriorityLabel],
    authorisedCommenters: [],
    // Issue #252: local arrays remain the default source so this schema
    // change is behaviour-neutral until the GitHub-derived wiring lands.
    authorSource: "config",
    // Issue #3528: identity-guard allowlist. Empty by default — the guard
    // warns loudly that it is inactive until operators configure it.
    serviceAccounts: [],
    // Issue #3530: service-account auth env (gh_config_dir / ssh_key_path).
    // Empty defaults mean "ambient auth" — applyServiceAccountEnv is a no-op.
    ghConfigDir: "",
    sshKeyPath: "",
    trustedReviewBots: [...DEFAULT_TRUSTED_REVIEW_BOTS],
    fleetPrAuthors: [],
    workOnLabel: LABEL_DEFAULTS.workOnLabel,
    failedOnceLabel: LABEL_DEFAULTS.failedOnceLabel,
    failedLabel: LABEL_DEFAULTS.failedLabel,
    refineIssueLabel: LABEL_DEFAULTS.refineIssueLabel,
    planningLabel: LABEL_DEFAULTS.planningLabel,
    questionLabel: LABEL_DEFAULTS.questionLabel,
    needsRevisionLabel: LABEL_DEFAULTS.needsRevisionLabel,
    needsHumanLabel: LABEL_DEFAULTS.needsHumanLabel,
    grillMeLabel: LABEL_DEFAULTS.grillMeLabel,
    quorumLabel: LABEL_DEFAULTS.quorumLabel,
    lowPriorityLabel: LABEL_DEFAULTS.lowPriorityLabel,
    workDir: "",
    // Issue #4146: containment is the default — native is an explicit opt-in.
    runMode: DEFAULT_RUN_MODE,
    // Issue #4067: the coding-agent provider seam defaults to Claude.
    agentProvider: DEFAULT_AGENT_PROVIDER_ID,
    // Issue #4108: only the active provider is enabled unless a deployment
    // enables more, so an existing deployment mounts exactly what it did.
    enabledAgentProviders: [DEFAULT_AGENT_PROVIDER_ID],
    claudeModel: "",
    // Issue #2654: configured best planning model for degraded-model detection.
    bestPlanningModel: DEFAULT_BEST_PLANNING_MODEL,
    claudeTimeout: OPERATIONAL_DEFAULTS.claudeTimeout,
    minClaimRunwaySeconds: OPERATIONAL_DEFAULTS.minClaimRunwaySeconds,
    claimRequireFullExecuteBudget:
      OPERATIONAL_DEFAULTS.claimRequireFullExecuteBudget,
    // Adaptive claim floor (Issue #245): the labels that mark a long job.
    claimLongJobLabels: [...DEFAULT_LONG_JOB_LABELS],
    progressExtensionEnabled: OPERATIONAL_DEFAULTS.progressExtensionEnabled,
    progressExtensionGrantSeconds:
      OPERATIONAL_DEFAULTS.progressExtensionGrantSeconds,
    progressExtensionStallSeconds:
      OPERATIONAL_DEFAULTS.progressExtensionStallSeconds,
    progressExtensionCheckSeconds:
      OPERATIONAL_DEFAULTS.progressExtensionCheckSeconds,
    prFeedbackTimeout: OPERATIONAL_DEFAULTS.prFeedbackTimeout,
    ciFixTimeout: OPERATIONAL_DEFAULTS.ciFixTimeout,
    claudeKillAfter: OPERATIONAL_DEFAULTS.claudeKillAfter,
    maxClarificationRounds: OPERATIONAL_DEFAULTS.maxClarificationRounds,
    sleepInterval: OPERATIONAL_DEFAULTS.sleepInterval,
    maxConcurrentIssues: OPERATIONAL_DEFAULTS.maxConcurrentIssues,
    creditWaitInterval: OPERATIONAL_DEFAULTS.creditWaitInterval,
    refinementTimeout: OPERATIONAL_DEFAULTS.refinementTimeout,
    refinementKillAfter: OPERATIONAL_DEFAULTS.refinementKillAfter,
    planningTimeout: OPERATIONAL_DEFAULTS.planningTimeout,
    planningKillAfter: OPERATIONAL_DEFAULTS.planningKillAfter,
    questionTimeout: OPERATIONAL_DEFAULTS.questionTimeout,
    questionKillAfter: OPERATIONAL_DEFAULTS.questionKillAfter,
    clarificationTimeout: OPERATIONAL_DEFAULTS.clarificationTimeout,
    clarificationKillAfter: OPERATIONAL_DEFAULTS.clarificationKillAfter,
    maxGrillMeRounds: OPERATIONAL_DEFAULTS.maxGrillMeRounds,
    grillMeTimeout: OPERATIONAL_DEFAULTS.grillMeTimeout,
    grillMeKillAfter: OPERATIONAL_DEFAULTS.grillMeKillAfter,
    quorumTimeout: OPERATIONAL_DEFAULTS.quorumTimeout,
    quorumKillAfter: OPERATIONAL_DEFAULTS.quorumKillAfter,
    quorumPlanners: defaultQuorumPlanners(),
    quorumJudge: defaultQuorumJudge(),
    maxRateLimitRetries: OPERATIONAL_DEFAULTS.maxRateLimitRetries,
    maxRateLimitWait: OPERATIONAL_DEFAULTS.maxRateLimitWait,
    retryMaxDelay: OPERATIONAL_DEFAULTS.retryMaxDelay,
    maxIssueBodyTokens: OPERATIONAL_DEFAULTS.maxIssueBodyTokens,
    summariseTimeout: OPERATIONAL_DEFAULTS.summariseTimeout,
    summariseKillAfter: OPERATIONAL_DEFAULTS.summariseKillAfter,
    featureCheckTimeout: OPERATIONAL_DEFAULTS.featureCheckTimeout,
    claudeNoOutputTimeout: OPERATIONAL_DEFAULTS.claudeNoOutputTimeout,
    qualityCheckTimeout: OPERATIONAL_DEFAULTS.qualityCheckTimeout,
    // Issue #2166: claimChurnThreshold is consumed by shell scripts via the
    // CLAIM_CHURN_THRESHOLD env var, not via WorkerConfig — the previous
    // builder field was dead (no `config.claimChurnThreshold` reader exists).
    healthCacheTtl: OPERATIONAL_DEFAULTS.healthCacheTtl,
    shuffleRepos: DEFAULT_SHUFFLE_REPOS,
    workerName: DEFAULT_WORKER_NAME,
    enableModelFallback: OPERATIONAL_DEFAULTS.enableModelFallback,
    minDiskSpaceMb: OPERATIONAL_DEFAULTS.minDiskSpaceMb,
    syncMilestoneBranches: OPERATIONAL_DEFAULTS.syncMilestoneBranches,
    milestoneSyncCooldownSeconds:
      OPERATIONAL_DEFAULTS.milestoneSyncCooldownSeconds,
    staleFailedDiagnosticDays: OPERATIONAL_DEFAULTS.staleFailedDiagnosticDays,
    stalePlanningWarningDays: OPERATIONAL_DEFAULTS.stalePlanningWarningDays,
    phaseModelOverrides: {},
    phaseEffortOverrides: {},
    includeRecentActivity: OPERATIONAL_DEFAULTS.includeRecentActivity,
    recentActivityMergedPrLimit:
      OPERATIONAL_DEFAULTS.recentActivityMergedPrLimit,
    recentActivityCommitLimit: OPERATIONAL_DEFAULTS.recentActivityCommitLimit,
    recentActivityMaxTokens: OPERATIONAL_DEFAULTS.recentActivityMaxTokens,
    recentActivityCacheTtlSeconds:
      OPERATIONAL_DEFAULTS.recentActivityCacheTtlSeconds,
    includeCodebaseMap: OPERATIONAL_DEFAULTS.includeCodebaseMap,
    timelineCacheTtlSeconds: OPERATIONAL_DEFAULTS.timelineCacheTtlSeconds,
    enableSessionResume: OPERATIONAL_DEFAULTS.enableSessionResume,
    verbosity: DEFAULT_VERBOSITY,
    contextBudgetWarningPercent:
      OPERATIONAL_DEFAULTS.contextBudgetWarningPercent,
    contextBudgetErrorPercent: OPERATIONAL_DEFAULTS.contextBudgetErrorPercent,
    contextBudgetBlockPercent: OPERATIONAL_DEFAULTS.contextBudgetBlockPercent,
    // Issue #2166: includeUntrustedComments is required on WorkerConfig
    // (Issue #1340) and was missing from the builder literal because the
    // previous `any` return type silently allowed the gap.
    includeUntrustedComments: OPERATIONAL_DEFAULTS.includeUntrustedComments,
    // Issue #2166/#2873: comment-rate-limit fields (maxTotalCommentChars,
    // maxUntrustedCommentChars, maxUntrustedCommentCount, commentFloodThreshold)
    // live in COMMENT_RATE_LIMIT_DEFAULTS in comment_rate_limiter.ts, not on
    // WorkerConfig. They are enforced by prepareTrustAnnotatedComments() in
    // comment_trust_filter.ts, which applies the caps and flood detection to
    // every comment forwarded into a Claude prompt.
    closedPrCooldownSeconds: OPERATIONAL_DEFAULTS.closedPrCooldownSeconds,
    unassignOnPrCreated: OPERATIONAL_DEFAULTS.unassignOnPrCreated,
    staleWorkDirDays: OPERATIONAL_DEFAULTS.staleWorkDirDays,
    updateRetryMaxAttempts: OPERATIONAL_DEFAULTS.updateRetryMaxAttempts,
    updateRetryBackoffSeconds: [
      ...OPERATIONAL_DEFAULTS.updateRetryBackoffSeconds,
    ],
    baselineAwareQualityGate: OPERATIONAL_DEFAULTS.baselineAwareQualityGate,
    infraRetryBackoffMs: OPERATIONAL_DEFAULTS.infraRetryBackoffMs,
    // Issue #3582: auto-fix attempt cap per stable failure signature.
    maxAutoFixAttempts: OPERATIONAL_DEFAULTS.maxAutoFixAttempts,
    // Issue #2401: default to an empty map → uniform idle-task draw. An
    // operator opts into biasing via `idle_task_template_weights`.
    idleTaskTemplateWeights: {},
    // Issue #4003/#4011: the converged cadence policy ships as the default —
    // an operator who changes nothing gets weekly `sonnet` and monthly `fable`
    // floors on the three important templates. Cloned so a caller mutating the
    // built config can never corrupt the shared default.
    idleTaskCadence: cloneCadencePolicy(DEFAULT_CADENCE_POLICY),
    // Issue #2622: per-tool minimum version floors for software auto-update.
    softwareMinVersions: { ...OPERATIONAL_DEFAULTS.softwareMinVersions },
    ...overrides,
  };
}
