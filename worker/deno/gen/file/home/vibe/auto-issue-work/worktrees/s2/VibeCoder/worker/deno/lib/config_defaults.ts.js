import { modelsForPhaseTiers } from "./phase_routing.ts";
import { DEFAULT_CLAUDE_MAX_TURNS } from "./claude_turn_limit.ts";
import { DEFAULT_AGENT_PROVIDER_ID } from "./agent_provider.ts";
import { DEFAULT_MIN_CLAIM_RUNWAY_SECONDS } from "./claim_runway.ts";
import { DEFAULT_RUN_FINISH_SECONDS } from "./run_timeline.ts";
import { DEFAULT_CALL_STORM_NOVEL_SHARE } from "./call_storm.ts";
import { DEFAULT_LONG_JOB_LABELS } from "./claim_runway_evidence.ts";
import { DEFAULT_CADENCE_POLICY } from "./idle_task_cadence.ts";
import { DEFAULT_RUN_MODE } from "./run_mode.ts";
import { cloneCadencePolicy } from "./idle_task_cadence_config.ts";
import { noCallbacks } from "./run_callbacks_config.ts";
import { graftContextOff } from "./graft_context_config.ts";
/**
 * Default label values used across shell and TypeScript configuration.
 *
 * Issue #1834: `topPriorityLabel`, `workOnLabel` and `lowPriorityLabel` are
 * the three hardwired discovery labels — every Vibe Coder picks them up
 * with zero configuration. `.config.json` may not override any of them.
 */ export const LABEL_DEFAULTS = {
  /**
   * Top-priority label (Issue #1834).
   * Hardwired — `.config.json` may not override. Highest-priority pickup
   * signal in the configured-label tier.
   */ topPriorityLabel: "top-priority",
  /**
   * Work-on label.
   * Hardwired since Issue #1834 — `.config.json` may not override.
   * Signals worker pickup on issues not created by an allowed author
   * (verified via the GitHub timeline API).
   */ workOnLabel: "work-on",
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
   */ quorumLabel: "quorum",
  /**
   * Low-priority label (Issue #1723).
   * Hardwired since Issue #1834 — `.config.json` may not override.
   * Reserved so the worker never self-applies it. Used by the priority
   * hierarchy collector and selector built in subsequent sub-issues of #1721.
   */ lowPriorityLabel: "low-priority"
};
/**
 * The three hardwired discovery labels (Issue #1834).
 *
 * `top-priority`, `work-on`, and `low-priority` are the canonical
 * pickup signals. They are not configurable — every Vibe Coder picks
 * them up by default with zero configuration. The diagnostic discovery
 * check uses this set, deduplicated, when reporting which labels make
 * an issue eligible.
 */ export const DISCOVERY_LABELS = [
  LABEL_DEFAULTS.topPriorityLabel,
  LABEL_DEFAULTS.workOnLabel,
  LABEL_DEFAULTS.lowPriorityLabel
];
/**
 * Partial Failure-Detection repair label (Issue #59, part of #54).
 *
 * Marks a planning parent whose run published a usable plan but left one or
 * more sub-issues without a filled `## Failure Detection` section. Defined here
 * rather than beside its apply helper because being *reserved* is the property
 * that governs it: the worker raises it, and the planner must never be able to
 * apply it as a descriptive label on a sub-issue. Not configurable.
 */ export const FAILURE_DETECTION_REPAIR_LABEL = "needs-failure-detection-repair";
/**
 * Reserved labels that must not be applied when the worker creates issues.
 *
 * These labels are used by the worker for operational purposes (issue discovery,
 * prioritisation, failure tracking, workflow state). Only the repository owner
 * should apply these labels.
 *
 * Issue #297: Prevent the vibe coder from labelling created issues with
 * special operational labels.
 */ export const RESERVED_LABELS = [
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
  FAILURE_DETECTION_REPAIR_LABEL
];
/**
 * Lower-cased view of {@link RESERVED_LABELS} for case-insensitive membership
 * checks (Issue #3088).
 *
 * GitHub treats label names case-insensitively (it forbids two labels that
 * differ only in case), so the reserved-label guards must match the same way.
 * Built once at module load from the single `RESERVED_LABELS` constant so the
 * set stays in sync automatically (no second hand-maintained list — DRY).
 */ const RESERVED_LABELS_LOWER = new Set(RESERVED_LABELS.map((label)=>label.toLowerCase()));
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
 */ export function isReservedLabel(label) {
  return RESERVED_LABELS_LOWER.has(label.toLowerCase());
}
/**
 * Operational defaults — timeouts, intervals, and numeric settings.
 *
 * Issue #277: These values are now configurable via .config.json.
 * Only values that differ from these defaults need to be stored in the config file.
 * If a default changes in the codebase, all users get the new default unless
 * they have explicitly overridden it.
 */ export const OPERATIONAL_DEFAULTS = {
  // Issue #1824: lowered from 14400 (4h) to 3600 (1h). A 4-hour wedge on
  // a single Claude run consumed an entire iteration's run-duration budget
  // and starved other repositories. If issue work genuinely needs more
  // than an hour, the escape hatch should raise a sub-issue.
  claudeTimeout: 3600,
  claudeMaxTurns: DEFAULT_CLAUDE_MAX_TURNS,
  /**
   * Claim-runway floor in seconds (Issue #289). Five minutes: enough to rule
   * out a claim that cannot finish setup, small enough that a run keeps
   * claiming until its last minutes. The single definition lives in
   * `claim_runway.ts`.
   */ minClaimRunwaySeconds: DEFAULT_MIN_CLAIM_RUNWAY_SECONDS,
  /**
   * Run finish deadline in seconds from run start (Issue #4242): two hours.
   * Must exceed the one-hour run target. The single definition lives in
   * `run_timeline.ts`.
   */ runFinishSeconds: DEFAULT_RUN_FINISH_SECONDS,
  /**
   * Re-armable hard deadline for issue work (Issue #4296, part of #4290).
   *
   * **On by default** (Issue #422, parent #397): killing a claim that is
   * demonstrably progressing throws the run's work away, so the
   * `claudeTimeout` kill for **issue work only** is deferred while the run
   * shows recent tool activity together with progress — a working tree that
   * actually advanced, or a descendant process doing work outside the
   * checkout (Issue #508). Every other phase keeps its unconditional cap.
   *
   * The chain is bounded, not open-ended: every grant is clamped to the
   * supervisor hard cap `VIBE_RUN_MAX_SECONDS` (Issue #421), the no-output
   * watchdog still kills a silent run, and a stalled run dies within one
   * grant. Set `progress_extension_enabled: false` to get the flat one-shot
   * kill back.
   */ progressExtensionEnabled: true,
  /**
   * Tee every agent invocation's raw stream-json to a redacted transcript
   * (Issue #1141).
   *
   * **Off by default.** A transcript is the raw agent stream — model output,
   * issue and repository text, file contents the agent read, command output —
   * passing only through the console secret redaction, which is a net for
   * known credential shapes rather than a guarantee. That is not something to
   * start capturing on a deployment's behalf, so it stays off until
   * `agent_transcript_enabled` asks for it.
   */ agentTranscriptEnabled: false,
  /** Seconds each grant adds to the deadline, measured from now (#4296). */ progressExtensionGrantSeconds: 900,
  /**
   * Timeout for the screenshot gate's one extra in-run agent turn
   * (Issue #2960) — long enough to navigate, screenshot and commit.
   */ screenshotRetryTimeoutSeconds: 600,
  /**
   * Timeout for the pre-push gate's one extra in-run agent turn (Issue #4128)
   * — long enough to fix, re-check and commit.
   */ prePushRetryTimeoutSeconds: 600,
  /** A tool call older than this is no longer evidence of activity (#4296). */ progressExtensionStallSeconds: 300,
  /**
   * How often progress is sampled between deadline checks (#4295): the
   * working tree, and the agent's descendant CPU (Issue #508).
   *
   * Bounds how stale the tree verdict can be when the deadline decision is
   * taken, so a run that stops changing the checkout is noticed within a
   * check interval rather than a whole grant. Must not exceed
   * `progressExtensionStallSeconds`, or a run that progressed inside the
   * sampling window could still be killed for stale tool activity.
   */ progressExtensionCheckSeconds: 300,
  /**
   * Call-storm stall guard (Issue #2230).
   *
   * **On by default.** A run polling a background job turn by turn — GRQ-23
   * managed ~700 tool calls and `echo w252` in an hour — is stalled by
   * definition, and neither the no-output watchdog (it sees output every
   * second) nor the progress extension (it only declines to extend) stops
   * it. Set `call_storm_enabled: false` to give a polling loop its whole
   * budget back.
   */ callStormEnabled: true,
  /**
   * Tool calls inside the window at which a run is judged a storm (#2230).
   *
   * Sixty calls in five minutes is twelve a minute, sustained, with nothing
   * to show for it in the checkout; the incident that prompted the guard ran
   * at roughly twenty-five a minute for twenty minutes. Raise it if an
   * exploration phase that genuinely reads faster than this is being stopped.
   */ callStormCalls: 60,
  /**
   * Sliding window the calls are counted over (#2230).
   *
   * Matched to `progressExtensionCheckSeconds`, because that is the cadence
   * the guard is evaluated at: the window judged is the window observed.
   */ callStormWindowSeconds: 300,
  /**
   * Novel share below which a busy window is a storm (#2773).
   *
   * A security sweep reads a new module on nearly every call and a poll loop
   * repeats three or four commands, so under a quarter distinct is the loop.
   * Lower it if an investigation that revisits files is being stopped.
   */ callStormNovelShare: DEFAULT_CALL_STORM_NOVEL_SHARE,
  /**
   * Quota-aware polling gate floors (Issue #3628).
   *
   * `quotaPollParkFloor`: below this many GraphQL points remaining, repos
   * with `nice >= quotaPollParkNice` are skipped whole for the cycle.
   * `quotaPollIdleFloor`: below this many, idle-task collection is deferred
   * fleet-wide (scan collector and filer). Both are strict less-than
   * boundaries; a floor of 0 disables its tier. A failed quota probe defers
   * nothing — the gate fails open.
   */ quotaPollParkFloor: 1500,
  quotaPollParkNice: 99,
  quotaPollIdleFloor: 500,
  /**
   * Nice-derived poll cadence (Issue #3667): the per-repo Priority 1.x
   * passes poll a `0 < nice < quotaPollParkNice` repo every
   * `pollCadenceLowCycles` cycles and a `nice >= quotaPollParkNice` repo
   * every `pollCadenceParkCycles` cycles. `nice <= 0` repos are polled every
   * cycle; 1 turns a tier's cadence off.
   */ pollCadenceLowCycles: 3,
  pollCadenceParkCycles: 10,
  /**
   * Self-scheduling for auto-filed worker diagnostics (Issue #505).
   *
   * **On by default.** The worker diagnoses its own faults accurately and
   * then stopped dead at the one action reserved for humans, so on an
   * unattended host the alarm just accumulated — `NEAT-AI-Rebase#39` waited
   * two days for a label the fix then took 79 minutes to honour. Only
   * issues the worker filed about itself, in its own repo, carrying a
   * recognised provenance marker, qualify; no label is ever self-applied.
   * Set `self_schedule_diagnostics_enabled: false` to restore the
   * wait-for-a-human behaviour exactly.
   */ selfScheduleDiagnosticsEnabled: true,
  /**
   * One self-scheduled diagnostic in flight at a time (Issue #505), so a
   * misfiring detector cannot fill the queue with its own work.
   */ selfScheduleDiagnosticsMaxInFlight: 1,
  claudeKillAfter: 30,
  maxClarificationRounds: 3,
  /**
   * Seconds slept between scan cycles. Raised from 120 to 300 because each
   * cycle carries a fixed GraphQL cost; fewer cycles reduce shared-account
   * quota spend. An explicit
   * `sleep_interval` in `.config.json` still wins.
   */ sleepInterval: 300,
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
   */ prFeedbackTimeout: 1800,
  /**
   * Hard timeout in seconds for the CI fix phase (Issue #1824).
   * The failed annotation set is bounded — 30 minutes is generous.
   * Distinct from `claudeTimeout` so reactive phases do not inherit
   * the larger issue-work budget.
   */ ciFixTimeout: 1800,
  questionTimeout: 600,
  questionKillAfter: 10,
  clarificationTimeout: 120,
  clarificationKillAfter: 10,
  /**
   * Runaway ceiling on grill-me clarification rounds (Issue #1616, #1933).
   *
   * Not a productivity budget: a grilling stops when the stall guard sees a
   * round repeat every question stem it had already asked, so this number only
   * bounds a grilling that keeps finding new questions forever. The
   * ceiling-th round is itself the forced final round, so a grilling posts at
   * most this many rounds since its latest Ready comment. Raised from 5 by
   * Issue #1933, where a five-round productive grilling was halted mid-flow.
   */ maxGrillMeRounds: 20,
  /**
   * Timeout in seconds for a single grill-me round (Issue #1616).
   *
   * Grill-me is an analysis phase, not a code change — a round may need to
   * investigate the codebase, run a live model probe (e.g. confirm the
   * top-tier model is actually served), and reason at high effort. The old
   * 600s ceiling was borrowed from the lightweight question/clarification
   * phases and starved that work, so heavy rounds died at "Claude timed out"
   * and escalated to `needs-human` (Issue #3154). It now matches the
   * issue-work budget (`claudeTimeout`, 1h); the process is killed at the
   * hour regardless, which is the intended safety cap.
   */ grillMeTimeout: 3600,
  /** Grace period in seconds after grillMeTimeout before kill (Issue #1616). */ grillMeKillAfter: 10,
  /**
   * Wall-clock budget in seconds for **one** Quorum agent (Issue #4112).
   *
   * A Quorum agent drafts (or judges) a plan, which is planning-shaped work —
   * so the budget matches `planningTimeout` rather than the hour an
   * implementation run gets. The two drafts run concurrently, so a whole run
   * costs one draft plus one judgement, not three sequential budgets.
   */ quorumTimeout: 1800,
  /** Grace in seconds after quorumTimeout before the agent is killed (#4112). */ quorumKillAfter: 10,
  maxRateLimitRetries: 2,
  maxRateLimitWait: 600,
  /**
   * One hour between collaborator refreshes (Issue #1453). The operator's
   * stated trade-off: a newly added team member may wait an hour or two to
   * be trusted; in return the fleet stops spending ~33 API calls per cycle
   * per host on a set that changes a few times a year.
   */ trustedAuthorsCacheHours: 1,
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
  repoTimeoutThreshold: 3,
  /**
   * Issue #1950: a failed run under a minute never reached the agent's
   * work — it died claiming or setting up. 60s separates that from a run
   * the agent genuinely spent on the issue.
   */ fastFailureSeconds: 60,
  /** Issue #1950: fast failures in the window before a repo is backed off. */ repoFastFailureThreshold: 3,
  /** Issue #1950: the rolling window, and the decay period, in hours. */ repoFastFailureWindowHours: 24,
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
   */ includeCodebaseMap: true,
  /**
   * Graft repo-context injection (Issue #2098, part of #2060). Off: a host
   * that never writes the `graft_context` block behaves exactly as today,
   * and the operator turns it on per host for the #2060 trial.
   */ graftContext: graftContextOff(),
  /**
   * The CodeGraph repo-context switch (Issue #2154, part of #2145). Off by
   * default: turning it on adds an index step at run start and a `codegraph`
   * MCP entry, so a host opts in rather than inherits it.
   */ codegraphContext: {
    enabled: false
  },
  /**
   * The RTK output switch (Issue #2380, part of #2328). On by default since
   * Issue #2432 — the owner's decision once it was seen to function in a live
   * run, not a verdict on the trial's token bar. It adds a `PreToolUse` Bash
   * rewrite hook and a prompt line to the wired Claude spawns; a host that
   * wants the raw output back sets `rtk_output.enabled` to `false`.
   */ rtkOutput: {
    enabled: true
  },
  /**
   * TTL in seconds for the issue-timeline cache used by label-author
   * checks (Issue #1673). Defaults to 5 minutes — shorter than the
   * 10-minute issues TTL because timelines mutate when labels are
   * re-applied. The worker invalidates the entry whenever it adds a
   * label itself.
   */ timelineCacheTtlSeconds: 300,
  /**
   * CLI-level session continuity (Issue #2339). On by default: the stream
   * machinery (Issues #2333–#2338) is in place, so an unconfigured host runs
   * one conversation per (repository, milestone) plus one blank stream per
   * repository, takes the stream locks, and compacts the conversation before
   * each new issue. Setting `enable_session_resume: false` returns the host
   * to per-issue sessions with no stream lock; the milestone-close
   * housekeeping sweep runs either way.
   */ enableSessionResume: true,
  /**
   * Whether `issue`-phase runs use the split executor (Issue #2341): the
   * manager plans and dispatches sub-agent executors that edit, on the
   * sub-agent tier (`issue_sub_agent_tier`, Haiku by default, Issue #3402). On
   * by default since Issue #2812; `issue_executor_split: false` opts out.
   */ issueExecutorSplit: true,
  /**
   * Model tier of the `issue`-phase executor and Standards reviewer
   * sub-agents, and whether the read-only `explorer` rides the run
   * (Issues #3401, #3402). Resolved per repo by
   * `resolveIssueSubAgentTier` and consumed by `buildIssueRunAgents`
   * in `issue_executor_agents.ts`. Each `issue` run also records the
   * resolved tier in fleet telemetry (per-tier runs and USD) and stamps it
   * on the PR body as a `vibe-sub-agent-tier` marker (Issue #3403).
   */ issueSubAgentTier: "haiku",
  /**
   * Whether `issue`-phase runs dispatch the Spec and Standards reviewers as
   * defined cheaper sub-agents (Issue #2575). On by default (Issue #2812);
   * `issue_reviewer_agents: false` opts out, and they inherit the phase model.
   */ issueReviewerAgents: true,
  /**
   * Whether `issue`-phase runs go through the external orchestrator (Issue
   * #3642) instead of Claude-native `--agents`. Off by default;
   * `external_orchestration: true` opts in. Host-wide only.
   */ externalOrchestration: false,
  /**
   * Optional provider, model, effort and bounds for the orchestrated path
   * (Issue #3642). Empty by default, so the built-in role defaults apply.
   */ externalOrchestrationSettings: {},
  /** Maximum session store size in bytes before compaction (50 MB) (Issue #1328). */ maxSessionSizeBytes: 50 * 1024 * 1024,
  /** Maximum session age in days before cleanup (Issue #1328). */ maxSessionAgeDays: 7,
  contextBudgetWarningPercent: 50,
  contextBudgetErrorPercent: 80,
  /**
   * Hard context-budget ceiling as a percentage (Issue #3713). At or above
   * this usage the execution phase stops and escalates instead of sending a
   * prompt the model would truncate. `0` disables the ceiling.
   */ contextBudgetBlockPercent: 95,
  /** Maximum total characters across all comments included in the prompt (Issue #1342). */ maxTotalCommentChars: 20_000,
  /** Maximum characters per untrusted comment before truncation (Issue #1342). */ maxUntrustedCommentChars: 2_000,
  /** Maximum number of untrusted comments to include in the prompt (Issue #1342). */ maxUntrustedCommentCount: 5,
  /** Threshold of untrusted comments that triggers a flood audit event (Issue #1342). */ commentFloodThreshold: 10,
  /**
   * Whether to include untrusted comments in the prompt (Issue #1340).
   * - `true` (default): include with trust-level annotations (defence in depth)
   * - `false` (strict mode): exclude untrusted comments entirely
   */ includeUntrustedComments: true,
  /**
   * Cooldown in seconds before an issue with a recently-closed PR can be
   * picked up again (Issue #1427). Prevents creating duplicate PRs for the
   * same issue when the previous PR was closed without merge.
   */ closedPrCooldownSeconds: 3600,
  /**
   * Whether to unassign the worker from the source issue immediately after
   * a successful PR creation (Issue #1453). This removes the
   * "assigned + no heartbeat" state that triggers false-positive recoveries
   * in `detectAssignedWithoutHeartbeat`. Defaults to `true`.
   */ unassignOnPrCreated: true,
  /**
   * Age threshold in days before a repo work directory with no heartbeat
   * is classified as stale and removed (Issue #1493). Defaults to 7 days.
   */ staleWorkDirDays: 7,
  /**
   * Maximum retry attempts for a single software update command (Issue #1496).
   * Defaults to 3 so transient failures self-heal without dropping the
   * weekly update entirely.
   */ updateRetryMaxAttempts: 3,
  /**
   * Exponential backoff delays in seconds between software update retries
   * (Issue #1496). The i-th entry is the delay AFTER attempt i+1 failed.
   * Defaults to [30, 90, 300] — gentle for flaky mirrors, short enough to
   * complete inside the weekly update window.
   */ updateRetryBackoffSeconds: [
    30,
    90,
    300
  ],
  /**
   * Per-tool minimum version floors for software auto-update (Issue #2622).
   * When the installed version of a tool is below its floor, the update runs
   * immediately, bypassing the 7-day interval gate. Generic per-tool map so
   * gh/deno floors can be added later; empty for tools without a floor.
   *
   * `claude` is pinned to 2.1.293 (PR #3432 review, Issue #3400) — the oldest
   * release whose bundled alias table resolves `haiku` to Haiku 5.5
   * (`claude-haiku-5-5`), the model `MODEL_CONTEXT_WINDOWS.haiku`'s 1M window
   * assumes. It was 2.1.280 (Issue #2560), the oldest release resolving `opus`
   * to Opus 5.5; 2.1.293 is above that, so an Opus- or Fable-pinned phase keeps
   * its own generation too. The CLI resolves each alias from its own bundled
   * table, so this floor decides which generation the phases are served; the
   * per-version evidence is in
   * `docs/MODEL-AND-CACHING.md#which-cli-version-actually-serves-51-issue-1362`.
   */ softwareMinVersions: {
    claude: "2.1.293"
  },
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
   */ baselineAwareQualityGate: true,
  /**
   * Backoff in milliseconds before an in-process retry of an
   * infrastructure-category phase failure (Issue #1550). Defaults to 15s —
   * gives transient environment blips (rate limits, zero-output, push
   * rejection) a chance to clear before applying the `failed-once` label.
   */ infraRetryBackoffMs: 15_000,
  /**
   * Maximum automatic fix attempts per failure signature before the worker
   * stops and escalates with `needs-human` (Issue #3582). Counted against a
   * signature that survives pushes, so three attempted fixes on one failure
   * exhaust the budget. `infrastructure`-category failures do not consume an
   * attempt. Per-repo override: `repoConfig[repo].maxAutoFixAttempts`.
   */ maxAutoFixAttempts: 3
};
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
 */ export const DEFAULT_TRUSTED_REVIEW_BOTS = [
  "github-code-quality[bot]",
  "coderabbitai[bot]",
  "sonarcloud[bot]",
  "deepsource-io[bot]",
  "codeclimate[bot]"
];
/**
 * Default `authorized_commenters` — the known bots whose input the worker
 * acts on (Issue #1066).
 *
 * Trust for **directing** work is derived from repository permissions, and a
 * GitHub App is never a repository collaborator: Copilot's reviews and the
 * Actions bot's results would silently stop being processed under a pure
 * `hasWriteAccess` rule. They are a third category the one-sentence rule does
 * not cover — neither humans with write access nor Vibe Coders — so they are
 * trusted because they are *named*, and named only for input.
 *
 * Applied only when `authorized_commenters` is absent from `.config.json`,
 * so an operator who sets the key keeps exactly what they wrote — including
 * an empty list, which denies every bot.
 */ export const DEFAULT_TRUSTED_INPUT_BOTS = [
  "github-copilot[bot]",
  "github-actions[bot]"
];
/**
 * @deprecated Use OPERATIONAL_DEFAULTS instead (Issue #277).
 * Kept for backward compatibility with existing code.
 */ export const NUMERIC_DEFAULTS = {
  claudeTimeout: OPERATIONAL_DEFAULTS.claudeTimeout,
  maxClarificationRounds: OPERATIONAL_DEFAULTS.maxClarificationRounds
};
/**
 * Default worker_name setting (Issue #436).
 * When empty (default), falls back to the GitHub username.
 * When set, appears in issue comments and PR descriptions for
 * multi-worker visibility.
 */ export const DEFAULT_WORKER_NAME = "";
/**
 * Default shuffle_repos setting (Issue #435).
 * When true (default), repos are shuffled to prevent starvation.
 * When false, repos are scanned in configured order for per-worker priority.
 */ export const DEFAULT_SHUFFLE_REPOS = true;
/**
 * Every update mode a host may be configured with (Issue #622, part of #583).
 *
 * `dynamic` tracks the latest Vibe Coder; `frozen` holds the host at a pinned
 * checkout and pinned tool versions. Named here so the validator can list the
 * accepted values in its fail-loud message.
 */ export const UPDATE_MODES = [
  "dynamic",
  "frozen"
];
/**
 * Default update mode (Issue #622, part of #583).
 *
 * `dynamic` is what every host did before the key existed, so an existing
 * `.config.json` with no update-mode keys behaves exactly as it does today.
 */ export const DEFAULT_UPDATE_MODE = "dynamic";
/**
 * Default answer the setup conversation offers for a host being configured
 * (Issue #692, part of #674).
 *
 * Deliberately **not** {@link DEFAULT_UPDATE_MODE}: a new host is pinned to
 * the latest release and the tool versions that release recorded, so accepting
 * every default reproduces a released, tested combination. `dynamic` stays a
 * valid typed answer — the deliberate, opt-in exception.
 *
 * An *absent* `update_mode` still resolves to {@link DEFAULT_UPDATE_MODE} at
 * config load: existing hosts carry no pins, and freezing them by default
 * would fail validation at their next launch (frozen is all-or-nothing,
 * Issue #622). This constant is the setup conversation's default answer, not
 * the meaning of a missing key.
 */ export const SETUP_DEFAULT_UPDATE_MODE = "frozen";
/**
 * Every `copilot_code_review` value a host may set (Issue #2701), named here
 * so the validator and the setup conversation list the same three.
 */ export const COPILOT_CODE_REVIEW_MODES = [
  "on",
  "off",
  "leave"
];
/**
 * What an absent `copilot_code_review` means (Issue #2701): read and write
 * nothing, so a host that never answered the question changes nothing, and
 * setup offers it as the answer on a fresh host.
 */ export const DEFAULT_COPILOT_CODE_REVIEW = "leave";
/**
 * Tools whose exact version a frozen host pins (Issue #622, part of #583).
 *
 * All three are required under `update_mode: "frozen"` — a host that pinned
 * only some of them would silently drift on the rest.
 */ export const PINNED_TOOLS = [
  "claude",
  "gh",
  "deno"
];
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
 */ export const DEFAULT_REPO_NICE = 0;
/**
 * Verbosity levels for configurable response output (Issue #1330).
 *
 * Part of #1329 (caveman mode). Different repositories benefit from different
 * levels of output detail — the level is configured, never derived from the
 * phase (Issue #798):
 * - minimal: bare minimum output (e.g. "done", one-line summary)
 * - concise: brief but informative — key decisions and outcomes only
 * - standard: current default behaviour — balanced detail
 * - verbose: detailed explanations of reasoning, trade-offs, alternatives
 */ export const VERBOSITY_LEVELS = {
  minimal: "minimal",
  concise: "concise",
  standard: "standard",
  verbose: "verbose"
};
/**
 * Default verbosity level (Issue #1330).
 * "standard" preserves existing behaviour for all repositories unless overridden.
 */ export const DEFAULT_VERBOSITY = "standard";
// Issue #798: a per-phase verbosity default map used to live here and was
// deleted as dead configuration — see `resolveVerbosity()` in verbosity.ts for
// why, and do not reintroduce it without threading a resolved level through
// every prompt builder.
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
 */ export const EFFORT_LEVELS = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max"
};
/**
 * Default effort level (Issue #1402).
 * "high" is the global fallback for phases not listed in PHASE_EFFORT_DEFAULTS.
 */ export const DEFAULT_EFFORT = "high";
/**
 * Default effort level for the planning phase (Issue #1402, #3229, #2560).
 * Planning is one of the planning-shaped phases — where the Vibe Coder
 * interprets the user's words into an implementable state — that run on the
 * Opus top tier (see PHASE_MODEL_DEFAULTS). Since #2560 those phases share
 * Opus with every other substantive phase, so "high" effort is what marks
 * them out; the `max` bump is reserved for the #3217 pre-flight reroute that
 * fires only when an operator has pinned a phase back to Fable and Fable is
 * unavailable. Previously max.
 */ export const DEFAULT_CLAUDE_EFFORT_PLANNING = "high";
/**
 * Default effort level for the grill-me phase (Issue #2621, #3229, #2560).
 * Requirements interrogation shapes every downstream sub-issue — the same
 * plan-quality argument as planning — so it is one of the planning-shaped
 * phases that run on the Opus top tier at "high" effort. Previously max.
 */ export const DEFAULT_CLAUDE_EFFORT_GRILL_ME = "high";
/**
 * Default effort for both Quorum phases (Issue #4112, parent #4102).
 * Drafting a plan and judging two of them are planning-shaped work, so both
 * run at the same "high" effort as planning and grill-me.
 */ export const DEFAULT_CLAUDE_EFFORT_QUORUM = "high";
/**
 * Default effort level for the issue phase (Issue #1402).
 * General implementation benefits from thorough reasoning.
 */ export const DEFAULT_CLAUDE_EFFORT_ISSUE = "high";
/**
 * Default effort level for the question phase (Issue #1402, #2391, #3229,
 * #2560). Answering a user's question is one of the planning-shaped phases —
 * the Vibe Coder interprets the user's words into an implementable state — so
 * it runs on the Opus top tier at "high" effort (see PHASE_MODEL_DEFAULTS).
 * Previously opus + medium.
 */ export const DEFAULT_CLAUDE_EFFORT_QUESTION = "high";
/**
 * Default effort level for the CI fix phase (Issues #1402, #2812).
 * Reactive and well-scoped; high because it now runs on Sonnet, not Opus.
 */ export const DEFAULT_CLAUDE_EFFORT_CI_FIX = "high";
/**
 * Default effort level for the PR feedback phase (Issues #1402, #2812).
 * Targeted reviewer fixes; high because it now runs on Sonnet, not Opus.
 */ export const DEFAULT_CLAUDE_EFFORT_PR_FEEDBACK = "high";
/**
 * Default effort level for the quality fix phase (Issues #1402, #2812).
 * Reactive test/lint fixes; high because it now runs on Sonnet, not Opus.
 */ export const DEFAULT_CLAUDE_EFFORT_QUALITY_FIX = "high";
/**
 * Default effort level for the refinement phase (Issue #1402, #3229, #2560).
 * Rewording titles/descriptions is one of the planning-shaped phases —
 * the Vibe Coder interprets the user's words into an implementable state — so
 * it runs on the Opus top tier at "high" effort. Previously medium.
 */ export const DEFAULT_CLAUDE_EFFORT_REFINEMENT = "high";
/**
 * Default effort level for the revision phase (Issue #1402, #3229, #2560).
 * Review-based rewriting is one of the planning-shaped phases — the Vibe
 * Coder interprets the user's words into an implementable state — so it runs
 * on the Opus top tier at "high" effort. Previously medium.
 */ export const DEFAULT_CLAUDE_EFFORT_REVISION = "high";
/**
 * Default effort level for the clarification phase (Issue #1402, #3229, #2560).
 * Assessing issue clarity is one of the planning-shaped phases — the Vibe
 * Coder interprets the user's words into an implementable state — so it runs
 * on the Opus top tier at "high" effort. Previously medium.
 */ export const DEFAULT_CLAUDE_EFFORT_CLARIFICATION = "high";
/**
 * Default effort level for the spelling fix phase (Issue #1402).
 * Simple typo corrections — minimal effort needed.
 */ export const DEFAULT_CLAUDE_EFFORT_SPELLING_FIX = "low";
/**
 * Default effort level for the summarise phase (Issue #1402).
 * Lightweight summarisation — minimal effort is sufficient.
 */ export const DEFAULT_CLAUDE_EFFORT_SUMMARISE = "low";
/**
 * Default effort level for the health check phase (Issue #1402).
 * Trivial health check — minimal effort needed.
 */ export const DEFAULT_CLAUDE_EFFORT_HEALTH = "low";
/**
 * Phase-specific effort defaults (Issue #1402, #2391).
 *
 * Maps phase names to their default effort level. Phases not listed here
 * fall back to DEFAULT_EFFORT ("high").
 *
 * Effort-first routing (Issue #2391): effort is the *primary* cost lever
 * and the effort tiers below encode each phase's complexity. Model tier is
 * the *secondary* lever, and since Issue #2560 collapsed the top tier onto
 * Opus it separates only the trivial phases (Haiku) from everything else —
 * so effort alone distinguishes the eight planning-shaped phases from the
 * reactive ones (see PHASE_MODEL_DEFAULTS). The effort tiers:
 * - planning / grill_me / refinement / revision / question / clarification /
 *   quorum / quorum_judge → high (the eight planning-shaped phases; their
 *   `max` bump is reserved for the #3217 pre-flight reroute, which fires only
 *   when a phase has been pinned back to Fable and Fable is unavailable)
 * - issue → high (thorough reasoning for implementation)
 * - ci_fix / pr_feedback / quality_fix / merge_conflict → high (reactive
 *   tasks, run on Sonnet since Issue #2812 so they take the deeper effort at
 *   half the Opus rate; merge_conflict is the same class, Issue #4174)
 * - spelling_fix / summarise / health / compaction → low (trivial or
 *   summarising tasks; compaction is the fast tier, Issue #4174)
 */ export const PHASE_EFFORT_DEFAULTS = {
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
  // Issue #4174: the merge engineer, same effort as the other reactive phases.
  merge_conflict: DEFAULT_CLAUDE_EFFORT_QUALITY_FIX,
  refinement: DEFAULT_CLAUDE_EFFORT_REFINEMENT,
  revision: DEFAULT_CLAUDE_EFFORT_REVISION,
  clarification: DEFAULT_CLAUDE_EFFORT_CLARIFICATION,
  spelling_fix: DEFAULT_CLAUDE_EFFORT_SPELLING_FIX,
  summarise: DEFAULT_CLAUDE_EFFORT_SUMMARISE,
  health: DEFAULT_CLAUDE_EFFORT_HEALTH,
  // Issue #4174: a summarising /compact turn, same effort as summarise.
  compaction: DEFAULT_CLAUDE_EFFORT_SUMMARISE
};
/**
 * Default Claude model selection (Issue #260, #2391).
 *
 * Opus is the single base tier. Under effort-first routing (#2391) every
 * phase defaults to this one tier and varies *effort* rather than switching
 * model families — see the per-phase constants below and PHASE_EFFORT_DEFAULTS.
 */ export const DEFAULT_CLAUDE_MODEL = "opus";
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
// Tier is the *secondary* lever, and since Issue #2560 it is applied at the
// cheap extreme only: the three trivial phases (spelling_fix, summarise,
// health) stay on Haiku — the Opus↔Haiku gap is still ~5×, summarise can be
// fed very large inputs, and the large-input escalation in
// phase_model_escalation.ts (#2393) already lifts a Haiku phase to a 1M-window
// tier when an input would otherwise truncate. The eight planning-shaped
// phases used to sit on a Fable tier above Opus (#2621 promoted planning and
// grill_me, #3229 extended it to refinement, revision, question and
// clarification, #4112 added quorum and quorum_judge) under one guiding rule:
// wherever the Vibe Coder interprets the user's words into an implementable
// state, use the highest model available. Opus 5.5 matches or beats Fable 5.1
// on plan quality at roughly half the price, so #2560 collapsed that tier onto
// Opus — the rule is unchanged, the highest model available is simply Opus
// now, and "high" effort is what still separates those phases from the
// reactive ones.
//
// Issue #2390 specifically evaluated whether the reactive phases (ci_fix,
// pr_feedback, quality_fix) should drop to opus + LOW effort, and whether
// refinement / clarification / question should demote to Haiku. The decision
// — recorded in docs/MODEL-AND-CACHING.md under "Per-phase decision log" — was
// to consolidate the reactive phases on opus + medium: preserve the
// medium-effort floor on reactive work (the hard cases need the reasoning
// depth) and let operators override per-repo if they want a cheaper tier.
// Issue #3229 later re-tiered refinement / revision / question / clarification
// *up* (not down to Haiku): they are planning-shaped phases where the Vibe
// Coder interprets the user's words, so they join planning and grill_me at
// high effort. Issue #2812 then moved the three genuinely reactive phases
// (ci_fix, pr_feedback, quality_fix) to sonnet + high: Sonnet 5.5 costs half
// of Opus 5.5, so the medium-effort floor rises to high at lower cost.
//
// The named per-phase constants are retained so the override chain
// (CLAUDE_MODEL_<PHASE> env vars, phase_model_overrides config) and the
// shell-default emitter keep working unchanged.
// ---------------------------------------------------------------------------
/**
 * Top model tier — the `opus` alias (Issues #2619, #2621, #2543, #2560).
 *
 * The worker passes the `opus` alias; the Claude CLI resolves it to the latest
 * Opus model (combined with the CLI minimum-version floor in #2622, this keeps
 * the tier current with no per-release config change). Opus 5.5 matches or
 * beats Fable 5.1 on plan quality at ~half the price, so Issue #2560 collapsed
 * the top tier onto the base tier: the planning-shaped phases now share the
 * `opus` alias with every other substantive phase, and **effort** alone
 * separates them (high for planning-shaped, medium for reactive).
 *
 * The constant is kept — rather than folded into {@link DEFAULT_CLAUDE_MODEL} —
 * so a future tier above Opus is a one-line change again, and so operators
 * pinning `CLAUDE_MODEL_PLANNING=fable` keep a documented rollback.
 */ export const DEFAULT_CLAUDE_MODEL_TOP_TIER = "opus";
/** Planning phase model — Opus top tier (effort: high, Issues #2621, #3229, #2560). */ export const DEFAULT_CLAUDE_MODEL_PLANNING = DEFAULT_CLAUDE_MODEL_TOP_TIER;
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
 */ export const DEFAULT_BEST_PLANNING_MODEL = "";
/** Grill-me phase model — Opus top tier (effort: high, Issues #2621, #3229, #2560). */ export const DEFAULT_CLAUDE_MODEL_GRILL_ME = DEFAULT_CLAUDE_MODEL_TOP_TIER;
/**
 * Quorum phase model — Opus top tier (effort: high, Issues #4112, #2560).
 *
 * Quorum decides *what the plan is* before the planning phase splits it into
 * sub-issues, so both its phases are planning-shaped and take the same tier as
 * planning. A non-Claude provider ignores the alias — the routing entry is what
 * the Claude-backed members of the trio resolve.
 */ export const DEFAULT_CLAUDE_MODEL_QUORUM = DEFAULT_CLAUDE_MODEL_TOP_TIER;
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
 */ export function defaultQuorumPlanners() {
  return [
    DEFAULT_AGENT_PROVIDER_ID,
    DEFAULT_AGENT_PROVIDER_ID
  ];
}
/** The adjudicating provider of a Quorum run — Claude by default (#4112). */ export function defaultQuorumJudge() {
  return DEFAULT_AGENT_PROVIDER_ID;
}
/**
 * Issue (coding/implementation) phase model — the Sonnet manager (effort:
 * high).
 *
 * The coding run routes through `phase: "issue"`, so this pins the
 * implementation tier explicitly rather than relying on the CLI default. Since
 * the owner's decision on #3473 the run is Sonnet managing Haiku executors
 * ({@link OPERATIONAL_DEFAULTS}.issueSubAgentTier), with the PR reviewer on
 * Opus: an Opus manager cost about a whole solo Opus run on its own, so the
 * subscription ran out and the fleet fell back to DeepSeek, while the Opus
 * review is what keeps merged quality high. `phase_model_overrides.issue:
 * "opus"` restores the Opus manager.
 */ export const DEFAULT_CLAUDE_MODEL_ISSUE = "sonnet";
/**
 * Refinement phase model — Opus top tier (effort: high, Issues #3229, #2560).
 * A planning-shaped phase: the Vibe Coder interprets the user's words into an
 * implementable state. Effort, not tier, is what marks it out.
 */ export const DEFAULT_CLAUDE_MODEL_REFINEMENT = DEFAULT_CLAUDE_MODEL_TOP_TIER;
/** CI fix phase model — Sonnet (effort: high, Issue #2812). */ export const DEFAULT_CLAUDE_MODEL_CI_FIX = "sonnet";
/**
 * Revision phase model — Opus top tier (effort: high, Issues #3229, #2560).
 * A planning-shaped phase: the Vibe Coder interprets the user's words into an
 * implementable state. Effort, not tier, is what marks it out.
 */ export const DEFAULT_CLAUDE_MODEL_REVISION = DEFAULT_CLAUDE_MODEL_TOP_TIER;
/** PR feedback phase model — Sonnet (effort: high, Issue #2812). */ export const DEFAULT_CLAUDE_MODEL_PR_FEEDBACK = "sonnet";
/** Quality fix phase model — Sonnet (effort: high, Issue #2812). */ export const DEFAULT_CLAUDE_MODEL_QUALITY_FIX = "sonnet";
/**
 * Question phase model — Opus top tier (effort: high, Issues #3229, #2560).
 * A planning-shaped phase: the Vibe Coder interprets the user's words into an
 * implementable state. Effort, not tier, is what marks it out.
 */ export const DEFAULT_CLAUDE_MODEL_QUESTION = DEFAULT_CLAUDE_MODEL_TOP_TIER;
/**
 * Clarification phase model — Opus top tier (effort: high, Issues #3229, #2560).
 * A planning-shaped phase: the Vibe Coder interprets the user's words into an
 * implementable state. Effort, not tier, is what marks it out.
 */ export const DEFAULT_CLAUDE_MODEL_CLARIFICATION = DEFAULT_CLAUDE_MODEL_TOP_TIER;
/**
 * Spelling fix phase model — Haiku (secondary tier lever, effort: low).
 * Simplest, lowest-volume task; the ~5× Opus premium buys nothing here.
 */ export const DEFAULT_CLAUDE_MODEL_SPELLING_FIX = "haiku";
/**
 * Summarise phase model — Haiku (secondary tier lever, effort: low).
 * Lightweight compression, but fed the largest inputs (whole sessions); the
 * #2393 escalation lifts it to a 1M-window tier when an input would truncate.
 */ export const DEFAULT_CLAUDE_MODEL_SUMMARISE = "haiku";
/**
 * Health check phase model — Haiku (secondary tier lever, effort: low).
 * Trivial pre-flight ("Respond with exactly: OK") run frequently — keep cheap.
 */ export const DEFAULT_CLAUDE_MODEL_HEALTH = "haiku";
/**
 * Model tier fallback mapping (Issue #1112, #2619).
 *
 * Maps each model tier to its next-cheaper alternative.
 * Used by the budget-exceeded fallback feature to downgrade models.
 * Fable 5 is the top tier above Opus, so the chain degrades
 * fable → opus → sonnet → haiku.
 */ export const MODEL_FALLBACK_MAP = {
  fable: "opus",
  opus: "sonnet",
  sonnet: "haiku",
  haiku: null
};
/**
 * Look up the cheaper fallback model for a given model string.
 *
 * Handles both short names (e.g. "opus") and full model IDs
 * (e.g. "claude-opus-4-7"). Returns null if no cheaper model
 * exists or the model is unrecognised.
 *
 * Issue #1112: Foundational utility for budget-exceeded fallback.
 */ export function getCheaperModel(currentModel) {
  // Direct match on short name
  if (currentModel in MODEL_FALLBACK_MAP) {
    return MODEL_FALLBACK_MAP[currentModel] ?? null;
  }
  // Try to extract tier from full model ID (e.g. "claude-opus-4-6")
  for (const tier of Object.keys(MODEL_FALLBACK_MAP)){
    if (currentModel.includes(`-${tier}-`) || currentModel.includes(`-${tier}`)) {
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
 * Routing (Issues #2391, #2621, #3229, #2560): effort (PHASE_EFFORT_DEFAULTS)
 * is the *primary* cost lever; model tier is the *secondary* lever, and since
 * #2560 it is applied at the cheap end only. The eight planning-shaped
 * phases (planning, grill_me, refinement, revision, question, clarification,
 * quorum, quorum_judge) run on Opus at "high" effort, because wherever the
 * Vibe Coder interprets the user's words into an implementable state a better
 * interpretation compounds across every downstream sub-issue and PR (#2621,
 * #3229); `issue` runs on Opus too. The reactive phases (ci_fix, pr_feedback,
 * quality_fix) run on Sonnet at "high" (#2812). The three trivial phases
 * (spelling_fix, summarise, health) stay on the cheaper Haiku tier. The map
 * stays populated (rather than empty) so each phase is explicitly pinned
 * regardless of the CLI's own default, while the override chain keeps tier
 * fully tunable.
 */ export const PHASE_MODEL_DEFAULTS = modelsForPhaseTiers({
  best: DEFAULT_CLAUDE_MODEL_TOP_TIER,
  standard: DEFAULT_CLAUDE_MODEL_ISSUE,
  fast: DEFAULT_CLAUDE_MODEL_HEALTH
});
// ---------------------------------------------------------------------------
// Codex per-phase routing (Issue #363, parent #357)
//
// The Codex CLI has both levers Claude has — `--model` and
// `-c model_reasoning_effort=…` — so the phase cost design documented in
// docs/MODEL-AND-CACHING.md applies to it unchanged: effort is the primary
// lever, model tier the secondary one applied at both extremes. The tables
// below therefore mirror PHASE_MODEL_DEFAULTS / PHASE_EFFORT_DEFAULTS key for
// key, with Codex model ids and Codex effort values substituted.
//
// The model ids are an implementation decision (Issue #363 leaves the "correct"
// ids open): a sane cheap/base/top mapping over the current Codex-capable
// OpenAI line-up. Explicit configuration always overrides them — a
// `CODEX_MODEL_<PHASE>` env var, a per-repo `codex_phase_model_overrides`
// entry, a per-repo `codex_model` base tier, or a global
// `codex_phase_model_overrides` entry — so a deployment on a different line-up
// re-pins the tier without a code change.
// ---------------------------------------------------------------------------
/**
 * Top Codex model tier — Codex's Opus (Issue #363; owner decision
 * 2026-10-22).
 *
 * `gpt-6-astra`, "frontier intelligence for the most demanding work" in the
 * account's Codex models catalogue. Reserved for the planning-shaped phases
 * and the reviewer role, where a better judgement compounds across every
 * downstream sub-issue and PR. The `gpt-5*` ids this replaced were refused by
 * the ChatGPT login (Issue #4019).
 */ export const DEFAULT_CODEX_MODEL_TOP_TIER = "gpt-6-astra";
/**
 * Base Codex model tier — Codex's Sonnet (Issue #363; owner decision
 * 2026-10-22).
 *
 * `gpt-6.1-sol`, the catalogue's "latest workhorse model". The `issue`
 * manager and every non-extreme phase run on it, differentiated by effort
 * rather than by tier.
 */ export const DEFAULT_CODEX_MODEL = "gpt-6.1-sol";
/**
 * Cheap Codex model tier — Codex's Haiku (Issue #363; owner decision
 * 2026-10-22).
 *
 * `gpt-6-luna`, the catalogue's "fast and affordable model for easier
 * tasks". The executor role and the three trivial phases (`spelling_fix`,
 * `summarise`, `health`) run on it. The flagship premium buys nothing on a
 * typo fix.
 */ export const DEFAULT_CODEX_MODEL_CHEAP_TIER = "gpt-6-luna";
/**
 * Reasoning-effort levels the Codex CLI accepts for
 * `-c model_reasoning_effort=…` (Issue #363).
 *
 * Four levels, not Claude's five: Codex has `minimal` below `low` and nothing
 * above `high`, so Claude's `xhigh`/`max` have no Codex equivalent and the
 * planning-shaped phases top out at `high`.
 */ export const CODEX_EFFORT_LEVELS = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high"
};
/**
 * Per-phase Codex model defaults (Issue #363).
 *
 * Same phase keys as {@link PHASE_MODEL_DEFAULTS}, same tier design: the
 * planning-shaped phases (planning, grill_me, both Quorum phases, refinement,
 * revision, question, clarification) take the top tier; the trivial trio takes
 * the cheap tier; everything else runs on the base tier and varies effort.
 */ export const CODEX_PHASE_MODEL_DEFAULTS = modelsForPhaseTiers({
  best: DEFAULT_CODEX_MODEL_TOP_TIER,
  standard: DEFAULT_CODEX_MODEL,
  fast: DEFAULT_CODEX_MODEL_CHEAP_TIER
});
/**
 * Per-phase Codex reasoning-effort defaults (Issue #363).
 *
 * Same phase keys and the same tiering as {@link PHASE_EFFORT_DEFAULTS},
 * clamped to the four levels Codex accepts: the planning-shaped phases and
 * `issue` run at `high`, the reactive phases (including `merge_conflict`) at
 * `medium`, and the trivial phases plus `compaction` at `low`.
 */ export const CODEX_PHASE_EFFORT_DEFAULTS = {
  planning: CODEX_EFFORT_LEVELS.high,
  grill_me: CODEX_EFFORT_LEVELS.high,
  quorum: CODEX_EFFORT_LEVELS.high,
  quorum_judge: CODEX_EFFORT_LEVELS.high,
  refinement: CODEX_EFFORT_LEVELS.high,
  revision: CODEX_EFFORT_LEVELS.high,
  question: CODEX_EFFORT_LEVELS.high,
  clarification: CODEX_EFFORT_LEVELS.high,
  issue: CODEX_EFFORT_LEVELS.high,
  ci_fix: CODEX_EFFORT_LEVELS.medium,
  pr_feedback: CODEX_EFFORT_LEVELS.medium,
  quality_fix: CODEX_EFFORT_LEVELS.medium,
  // Issue #4174: reactive code, so medium like ci_fix, not the issue manager's high.
  merge_conflict: CODEX_EFFORT_LEVELS.medium,
  spelling_fix: CODEX_EFFORT_LEVELS.low,
  summarise: CODEX_EFFORT_LEVELS.low,
  health: CODEX_EFFORT_LEVELS.low,
  // Issue #4174: a summarising turn, low like summarise.
  compaction: CODEX_EFFORT_LEVELS.low
};
// ---------------------------------------------------------------------------
// Gemini per-phase routing (Issue #364, parent #357)
//
// The Gemini CLI has one of the two levers: `--model`, but no
// reasoning-effort option at all. The model half of the phase cost design
// documented in docs/MODEL-AND-CACHING.md therefore applies unchanged, and the
// table below mirrors PHASE_MODEL_DEFAULTS key for key with Gemini model ids.
// There is deliberately no GEMINI_PHASE_EFFORT_DEFAULTS: a table of efforts
// the CLI can never apply would be dead configuration. An effort that is
// nonetheless requested for a Gemini phase is reported loudly by
// `gemini_executor.ts` rather than dropped in silence (Issue #3234).
//
// The model ids are an implementation decision (Issue #364 leaves the
// "correct" ids open): a sane cheap/base/top mapping over the current Gemini
// line-up. Explicit configuration always overrides them — a
// `GEMINI_MODEL_<PHASE>` env var, a per-repo `gemini_phase_model_overrides`
// entry, a per-repo `gemini_model` base tier, or a global
// `gemini_phase_model_overrides` entry — so a deployment on a different
// line-up re-pins the tier without a code change.
// ---------------------------------------------------------------------------
/**
 * Top Gemini model tier — the reasoning flagship (Issue #364).
 *
 * Reserved for the planning-shaped phases, where the Vibe Coder interprets the
 * user's words into an implementable state and a better interpretation
 * compounds across every downstream sub-issue and PR.
 */ export const DEFAULT_GEMINI_MODEL_TOP_TIER = "gemini-2.5-pro";
/**
 * Base Gemini model tier (Issue #364) — the general-purpose model every
 * non-extreme phase runs on. Gemini has no effort lever to differentiate them
 * further, so the tier itself carries the whole routing decision.
 */ export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
/**
 * Cheap Gemini model tier (Issue #364) — the small model the three trivial
 * phases (`spelling_fix`, `summarise`, `health`) run on, mirroring Claude's
 * Haiku tier. The flagship premium buys nothing on a typo fix.
 */ export const DEFAULT_GEMINI_MODEL_CHEAP_TIER = "gemini-2.5-flash-lite";
/**
 * Per-phase Gemini model defaults (Issue #364).
 *
 * Same phase keys as {@link PHASE_MODEL_DEFAULTS}, same tier design: the
 * planning-shaped phases (planning, grill_me, both Quorum phases, refinement,
 * revision, question, clarification) take the top tier; the trivial trio takes
 * the cheap tier; everything else runs on the base tier.
 */ export const GEMINI_PHASE_MODEL_DEFAULTS = modelsForPhaseTiers({
  best: DEFAULT_GEMINI_MODEL_TOP_TIER,
  standard: DEFAULT_GEMINI_MODEL,
  fast: DEFAULT_GEMINI_MODEL_CHEAP_TIER
});
// ---------------------------------------------------------------------------
// DeepSeek per-phase routing (Issue #413, parent #396)
//
// DeepSeek is carried on the *Claude* CLI, so its argv shape is Claude's — and
// Claude's routing resolves to tier aliases (`fable`, `opus`, `sonnet`,
// `haiku`), which DeepSeek's endpoint cannot resolve. A provider with no
// routing of its own would therefore send an Anthropic tier alias to a
// third-party endpoint and fail mid-run, so every phase is pinned here to a
// real DeepSeek model id.
//
// The CLI's `--effort` flag is not reachable either: DeepSeek's
// Anthropic-compatible endpoint does not implement Anthropic's effort control.
// There is deliberately no DEEPSEEK_PHASE_EFFORT_DEFAULTS and no DeepSeek
// effort config key — either would be dead configuration. An effort requested
// for a DeepSeek phase is reported loudly by `deepseek_executor.ts` rather than
// dropped in silence (Issue #3234), which is the Gemini precedent (Issue #364).
//
// Explicit configuration always overrides these — a `DEEPSEEK_MODEL_<PHASE>`
// env var, a per-repo `deepseek_phase_model_overrides` entry, a per-repo
// `deepseek_model` base tier, or a global `deepseek_phase_model_overrides`
// entry — so a deployment on a different line-up re-pins the tier without a
// code change.
// ---------------------------------------------------------------------------
/**
 * Top DeepSeek model tier — the pro model (Issue #413).
 *
 * Reserved for the planning-shaped phases, where the Vibe Coder interprets the
 * user's words into an implementable state and a better interpretation
 * compounds across every downstream sub-issue and PR.
 */ export const DEFAULT_DEEPSEEK_MODEL_TOP_TIER = "deepseek-v4-pro";
/**
 * Base DeepSeek model tier (Issue #413) — the general-purpose model every
 * other phase runs on. DeepSeek has no usable effort lever, so the tier itself
 * carries the whole routing decision.
 */ export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
/**
 * Per-phase DeepSeek model defaults (Issue #413).
 *
 * Same phase keys as {@link PHASE_MODEL_DEFAULTS}: the planning-shaped phases
 * (planning, grill_me, both Quorum phases, refinement, revision, question,
 * clarification) take the reasoning model; everything else takes the base
 * tier.
 *
 * There is no cheap rung here, unlike Claude and Gemini: DeepSeek publishes no
 * third, cheaper tier, so the trivial trio (`spelling_fix`, `summarise`,
 * `health`) runs on `deepseek-flash` too. That is a deliberate absence, not an
 * omission.
 */ export const DEEPSEEK_PHASE_MODEL_DEFAULTS = modelsForPhaseTiers({
  best: DEFAULT_DEEPSEEK_MODEL_TOP_TIER,
  standard: DEFAULT_DEEPSEEK_MODEL,
  fast: DEFAULT_DEEPSEEK_MODEL
});
/** Concrete provider models for the shared best/standard/fast policy. */ export const PROVIDER_MODEL_TIERS = {
  claude: {
    best: DEFAULT_CLAUDE_MODEL_TOP_TIER,
    standard: DEFAULT_CLAUDE_MODEL_ISSUE,
    fast: DEFAULT_CLAUDE_MODEL_HEALTH
  },
  codex: {
    best: DEFAULT_CODEX_MODEL_TOP_TIER,
    standard: DEFAULT_CODEX_MODEL,
    fast: DEFAULT_CODEX_MODEL_CHEAP_TIER
  },
  gemini: {
    best: DEFAULT_GEMINI_MODEL_TOP_TIER,
    standard: DEFAULT_GEMINI_MODEL,
    fast: DEFAULT_GEMINI_MODEL_CHEAP_TIER
  },
  deepseek: {
    best: DEFAULT_DEEPSEEK_MODEL_TOP_TIER,
    standard: DEFAULT_DEEPSEEK_MODEL,
    fast: DEFAULT_DEEPSEEK_MODEL
  }
};
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
 */ export function buildDefaultWorkerConfig(overrides = {}) {
  return {
    allowedAuthors: [],
    allowedAuthor: "",
    prReviewer: "",
    prReviewers: [],
    repos: [],
    // Issue #1834: issueLabels is hardwired — only the top-priority label
    // is iterated by the configured-label collector. The work-on and
    // low-priority labels have dedicated, author-checked collectors.
    issueLabels: [
      LABEL_DEFAULTS.topPriorityLabel
    ],
    // Issue #1066: axis 2 only — the known bots whose input we act on. Axis
    // 1 (who may direct work) is derived from collaborators and starts empty.
    authorisedCommenters: [
      ...DEFAULT_TRUSTED_INPUT_BOTS
    ],
    // Issue #3528: identity-guard allowlist. Empty by default — the guard
    // warns loudly that it is inactive until operators configure it.
    serviceAccounts: [],
    // Issue #3530: service-account auth env (gh_config_dir / ssh_key_path).
    // Empty defaults mean "ambient auth" — applyServiceAccountEnv is a no-op.
    ghConfigDir: "",
    sshKeyPath: "",
    trustedReviewBots: [
      ...DEFAULT_TRUSTED_REVIEW_BOTS
    ],
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
    // Issue #622: dynamic is what every host did before the key existed, so
    // an unconfigured host tracks the latest exactly as it always has.
    updateMode: DEFAULT_UPDATE_MODE,
    // Issue #4067: the coding-agent provider seam defaults to Claude.
    agentProvider: DEFAULT_AGENT_PROVIDER_ID,
    // Issue #4108: only the active provider is enabled unless a deployment
    // enables more, so an existing deployment mounts exactly what it did.
    enabledAgentProviders: [
      DEFAULT_AGENT_PROVIDER_ID
    ],
    agentProviderFallback: [],
    // Issue #2474: drain the held Claude token to zero rather than parking
    // the backlog at the week-pace projection. The default, because a pool
    // host has subscriptions to rotate and the outage fallback handles the
    // token that dies mid-issue — the projection guard's reservation buys
    // nothing there. `false` opts a host back into the guard.
    claudeWeekPaceDrain: true,
    claudeModel: "",
    // Issue #2654: configured best planning model for degraded-model detection.
    bestPlanningModel: DEFAULT_BEST_PLANNING_MODEL,
    claudeTimeout: OPERATIONAL_DEFAULTS.claudeTimeout,
    claudeMaxTurns: OPERATIONAL_DEFAULTS.claudeMaxTurns,
    minClaimRunwaySeconds: OPERATIONAL_DEFAULTS.minClaimRunwaySeconds,
    runFinishSeconds: OPERATIONAL_DEFAULTS.runFinishSeconds,
    // Adaptive claim floor (Issue #245): the labels that mark a long job.
    claimLongJobLabels: [
      ...DEFAULT_LONG_JOB_LABELS
    ],
    progressExtensionEnabled: OPERATIONAL_DEFAULTS.progressExtensionEnabled,
    // Issue #1141: the agent transcript tee, off until configured on.
    agentTranscriptEnabled: OPERATIONAL_DEFAULTS.agentTranscriptEnabled,
    progressExtensionGrantSeconds: OPERATIONAL_DEFAULTS.progressExtensionGrantSeconds,
    progressExtensionStallSeconds: OPERATIONAL_DEFAULTS.progressExtensionStallSeconds,
    progressExtensionCheckSeconds: OPERATIONAL_DEFAULTS.progressExtensionCheckSeconds,
    callStormEnabled: OPERATIONAL_DEFAULTS.callStormEnabled,
    callStormCalls: OPERATIONAL_DEFAULTS.callStormCalls,
    callStormWindowSeconds: OPERATIONAL_DEFAULTS.callStormWindowSeconds,
    callStormNovelShare: OPERATIONAL_DEFAULTS.callStormNovelShare,
    // Issue #3628: quota-aware polling gate floors.
    quotaPollParkFloor: OPERATIONAL_DEFAULTS.quotaPollParkFloor,
    quotaPollParkNice: OPERATIONAL_DEFAULTS.quotaPollParkNice,
    quotaPollIdleFloor: OPERATIONAL_DEFAULTS.quotaPollIdleFloor,
    // Issue #3667: nice-derived poll cadence.
    pollCadenceLowCycles: OPERATIONAL_DEFAULTS.pollCadenceLowCycles,
    pollCadenceParkCycles: OPERATIONAL_DEFAULTS.pollCadenceParkCycles,
    // Issue #505: self-scheduling for auto-filed worker diagnostics.
    selfScheduleDiagnosticsEnabled: OPERATIONAL_DEFAULTS.selfScheduleDiagnosticsEnabled,
    selfScheduleDiagnosticsMaxInFlight: OPERATIONAL_DEFAULTS.selfScheduleDiagnosticsMaxInFlight,
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
    trustedAuthorsCacheHours: OPERATIONAL_DEFAULTS.trustedAuthorsCacheHours,
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
    fastFailureSeconds: OPERATIONAL_DEFAULTS.fastFailureSeconds,
    repoFastFailureThreshold: OPERATIONAL_DEFAULTS.repoFastFailureThreshold,
    repoFastFailureWindowHours: OPERATIONAL_DEFAULTS.repoFastFailureWindowHours,
    staleFailedDiagnosticDays: OPERATIONAL_DEFAULTS.staleFailedDiagnosticDays,
    stalePlanningWarningDays: OPERATIONAL_DEFAULTS.stalePlanningWarningDays,
    phaseModelOverrides: {},
    phaseEffortOverrides: {},
    codexPhaseModelOverrides: {},
    codexPhaseEffortOverrides: {},
    geminiPhaseModelOverrides: {},
    deepseekPhaseModelOverrides: {},
    issueExecutorSplit: OPERATIONAL_DEFAULTS.issueExecutorSplit,
    issueSubAgentTier: OPERATIONAL_DEFAULTS.issueSubAgentTier,
    issueReviewerAgents: OPERATIONAL_DEFAULTS.issueReviewerAgents,
    externalOrchestration: OPERATIONAL_DEFAULTS.externalOrchestration,
    externalOrchestrationSettings: {},
    includeRecentActivity: OPERATIONAL_DEFAULTS.includeRecentActivity,
    recentActivityMergedPrLimit: OPERATIONAL_DEFAULTS.recentActivityMergedPrLimit,
    recentActivityCommitLimit: OPERATIONAL_DEFAULTS.recentActivityCommitLimit,
    recentActivityMaxTokens: OPERATIONAL_DEFAULTS.recentActivityMaxTokens,
    recentActivityCacheTtlSeconds: OPERATIONAL_DEFAULTS.recentActivityCacheTtlSeconds,
    includeCodebaseMap: OPERATIONAL_DEFAULTS.includeCodebaseMap,
    // Fresh object per config: the default must never be shared and mutated.
    codegraphContext: {
      enabled: OPERATIONAL_DEFAULTS.codegraphContext.enabled
    },
    rtkOutput: {
      enabled: OPERATIONAL_DEFAULTS.rtkOutput.enabled
    },
    timelineCacheTtlSeconds: OPERATIONAL_DEFAULTS.timelineCacheTtlSeconds,
    enableSessionResume: OPERATIONAL_DEFAULTS.enableSessionResume,
    verbosity: DEFAULT_VERBOSITY,
    contextBudgetWarningPercent: OPERATIONAL_DEFAULTS.contextBudgetWarningPercent,
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
      ...OPERATIONAL_DEFAULTS.updateRetryBackoffSeconds
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
    softwareMinVersions: {
      ...OPERATIONAL_DEFAULTS.softwareMinVersions
    },
    // Issue #846 (part of #843): no custom label → prompt mappings until an
    // operator opts in — the feature is off by default.
    customLabelPrompts: [],
    // Issue #806: no hooks configured — an existing configuration without a
    // `callbacks` block behaves exactly as before.
    callbacks: noCallbacks(),
    // Issue #2098: Graft off. Spread so a caller mutating the built config
    // cannot corrupt the shared default.
    graftContext: {
      ...OPERATIONAL_DEFAULTS.graftContext
    },
    ...overrides
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb25maWdfZGVmYXVsdHMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgbW9kZWxzRm9yUGhhc2VUaWVycyB9IGZyb20gXCIuL3BoYXNlX3JvdXRpbmcudHNcIjtcbmltcG9ydCB7IERFRkFVTFRfQ0xBVURFX01BWF9UVVJOUyB9IGZyb20gXCIuL2NsYXVkZV90dXJuX2xpbWl0LnRzXCI7XG4vKipcbiAqIENvbmZpZ3VyYXRpb24gZGVmYXVsdHMg4oCUIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGggZm9yIFR5cGVTY3JpcHQuXG4gKlxuICogVGhlc2UgdmFsdWVzIG1pcnJvciB0aGUgc2hlbGwgZGVmYXVsdHMgaW4gd29ya2VyL3NoYXJlZC9jb25maWdfZGVmYXVsdHMuc2guXG4gKiBCb3RoIGZpbGVzIG11c3QgYmUga2VwdCBpbiBzeW5jLiBUZXN0cyB2ZXJpZnkgY29uc2lzdGVuY3kuXG4gKlxuICogSXNzdWUgIzIxNjogQ29uc29saWRhdGUgY29uZmlndXJhdGlvbiBkZWZhdWx0cyBpbnRvIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGguXG4gKiBJc3N1ZSAjMjc3OiBBbGwgY29uZmlndXJhdGlvbiAoaW5jbHVkaW5nIG9wZXJhdGlvbmFsKSBsb2FkZWQgZnJvbSAuY29uZmlnLmpzb24uXG4gKiBJc3N1ZSAjMjE2NjogYnVpbGREZWZhdWx0V29ya2VyQ29uZmlnKCkgbm93IHJldHVybnMgYSBjb25jcmV0ZSBXb3JrZXJDb25maWdcbiAqICAgcmF0aGVyIHRoYW4gYGFueWAsIHNvIG1pc3Npbmcgb3Igc3RhbGUgZmllbGRzIGluIHRoZSBsaXRlcmFsIGFyZSBjYXVnaHQgYXRcbiAqICAgY29tcGlsZSB0aW1lIGFuZCBjYWxsIHNpdGVzIG5vIGxvbmdlciBuZWVkIGBhcyBXb3JrZXJDb25maWdgIHJlc2N1ZSBjYXN0cy5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7XG4gIENvcGlsb3RDb2RlUmV2aWV3TW9kZSxcbiAgRXh0ZXJuYWxPcmNoZXN0cmF0aW9uU2V0dGluZ3MsXG4gIElzc3VlU3ViQWdlbnRUaWVyLFxuICBVcGRhdGVNb2RlLFxuICBXb3JrZXJDb25maWcsXG59IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgREVGQVVMVF9BR0VOVF9QUk9WSURFUl9JRCB9IGZyb20gXCIuL2FnZW50X3Byb3ZpZGVyLnRzXCI7XG5pbXBvcnQgeyBERUZBVUxUX01JTl9DTEFJTV9SVU5XQVlfU0VDT05EUyB9IGZyb20gXCIuL2NsYWltX3J1bndheS50c1wiO1xuaW1wb3J0IHsgREVGQVVMVF9SVU5fRklOSVNIX1NFQ09ORFMgfSBmcm9tIFwiLi9ydW5fdGltZWxpbmUudHNcIjtcbmltcG9ydCB7IERFRkFVTFRfQ0FMTF9TVE9STV9OT1ZFTF9TSEFSRSB9IGZyb20gXCIuL2NhbGxfc3Rvcm0udHNcIjtcbmltcG9ydCB7IERFRkFVTFRfTE9OR19KT0JfTEFCRUxTIH0gZnJvbSBcIi4vY2xhaW1fcnVud2F5X2V2aWRlbmNlLnRzXCI7XG5pbXBvcnQgeyBERUZBVUxUX0NBREVOQ0VfUE9MSUNZIH0gZnJvbSBcIi4vaWRsZV90YXNrX2NhZGVuY2UudHNcIjtcbmltcG9ydCB7IERFRkFVTFRfUlVOX01PREUgfSBmcm9tIFwiLi9ydW5fbW9kZS50c1wiO1xuaW1wb3J0IHsgY2xvbmVDYWRlbmNlUG9saWN5IH0gZnJvbSBcIi4vaWRsZV90YXNrX2NhZGVuY2VfY29uZmlnLnRzXCI7XG5pbXBvcnQgeyBub0NhbGxiYWNrcyB9IGZyb20gXCIuL3J1bl9jYWxsYmFja3NfY29uZmlnLnRzXCI7XG5pbXBvcnQgeyBncmFmdENvbnRleHRPZmYgfSBmcm9tIFwiLi9ncmFmdF9jb250ZXh0X2NvbmZpZy50c1wiO1xuXG4vKipcbiAqIERlZmF1bHQgbGFiZWwgdmFsdWVzIHVzZWQgYWNyb3NzIHNoZWxsIGFuZCBUeXBlU2NyaXB0IGNvbmZpZ3VyYXRpb24uXG4gKlxuICogSXNzdWUgIzE4MzQ6IGB0b3BQcmlvcml0eUxhYmVsYCwgYHdvcmtPbkxhYmVsYCBhbmQgYGxvd1ByaW9yaXR5TGFiZWxgIGFyZVxuICogdGhlIHRocmVlIGhhcmR3aXJlZCBkaXNjb3ZlcnkgbGFiZWxzIOKAlCBldmVyeSBWaWJlIENvZGVyIHBpY2tzIHRoZW0gdXBcbiAqIHdpdGggemVybyBjb25maWd1cmF0aW9uLiBgLmNvbmZpZy5qc29uYCBtYXkgbm90IG92ZXJyaWRlIGFueSBvZiB0aGVtLlxuICovXG5leHBvcnQgY29uc3QgTEFCRUxfREVGQVVMVFMgPSB7XG4gIC8qKlxuICAgKiBUb3AtcHJpb3JpdHkgbGFiZWwgKElzc3VlICMxODM0KS5cbiAgICogSGFyZHdpcmVkIOKAlCBgLmNvbmZpZy5qc29uYCBtYXkgbm90IG92ZXJyaWRlLiBIaWdoZXN0LXByaW9yaXR5IHBpY2t1cFxuICAgKiBzaWduYWwgaW4gdGhlIGNvbmZpZ3VyZWQtbGFiZWwgdGllci5cbiAgICovXG4gIHRvcFByaW9yaXR5TGFiZWw6IFwidG9wLXByaW9yaXR5XCIsXG4gIC8qKlxuICAgKiBXb3JrLW9uIGxhYmVsLlxuICAgKiBIYXJkd2lyZWQgc2luY2UgSXNzdWUgIzE4MzQg4oCUIGAuY29uZmlnLmpzb25gIG1heSBub3Qgb3ZlcnJpZGUuXG4gICAqIFNpZ25hbHMgd29ya2VyIHBpY2t1cCBvbiBpc3N1ZXMgbm90IGNyZWF0ZWQgYnkgYW4gYWxsb3dlZCBhdXRob3JcbiAgICogKHZlcmlmaWVkIHZpYSB0aGUgR2l0SHViIHRpbWVsaW5lIEFQSSkuXG4gICAqL1xuICB3b3JrT25MYWJlbDogXCJ3b3JrLW9uXCIsXG4gIGZhaWxlZE9uY2VMYWJlbDogXCJmYWlsZWQtb25jZVwiLFxuICBmYWlsZWRMYWJlbDogXCJmYWlsZWRcIixcbiAgcmVmaW5lSXNzdWVMYWJlbDogXCJyZWZpbmUtaXNzdWVcIixcbiAgcGxhbm5pbmdMYWJlbDogXCJwbGFubmluZ1wiLFxuICBxdWVzdGlvbkxhYmVsOiBcInF1ZXN0aW9uXCIsXG4gIG5lZWRzUmV2aXNpb25MYWJlbDogXCJuZWVkcy1yZXZpc2lvblwiLFxuICBkb2N1bWVudGF0aW9uTGFiZWw6IFwiZG9jdW1lbnRhdGlvblwiLFxuICBuZWVkc1NjcmVlbnNob3RMYWJlbDogXCJuZWVkcy1zY3JlZW5zaG90XCIsXG4gIG5lZWRzSHVtYW5MYWJlbDogXCJuZWVkcy1odW1hblwiLFxuICBncmlsbE1lTGFiZWw6IFwiZ3JpbGwtbWVcIixcbiAgLyoqXG4gICAqIFF1b3J1bSBwbGFuLW9mZiBsYWJlbCAoSXNzdWUgIzQxMTIsIHBhcmVudCAjNDEwMikuXG4gICAqXG4gICAqIEh1bWFuLWFwcGxpZWQgb25seTogaXQgcm91dGVzIHRoZSBpc3N1ZSBpbnRvIGEgdGhyZWUtYWdlbnQgcGxhbi1vZmYgYWhlYWRcbiAgICogb2YgcGxhbm5pbmcsIHNvIGl0IGlzIHJlc2VydmVkIChzZWUge0BsaW5rIFJFU0VSVkVEX0xBQkVMU30pIGFuZCB0aGVcbiAgICogd29ya2VyIHJlZnVzZXMgdG8gc2VsZi1hcHBseSBpdC5cbiAgICovXG4gIHF1b3J1bUxhYmVsOiBcInF1b3J1bVwiLFxuICAvKipcbiAgICogTG93LXByaW9yaXR5IGxhYmVsIChJc3N1ZSAjMTcyMykuXG4gICAqIEhhcmR3aXJlZCBzaW5jZSBJc3N1ZSAjMTgzNCDigJQgYC5jb25maWcuanNvbmAgbWF5IG5vdCBvdmVycmlkZS5cbiAgICogUmVzZXJ2ZWQgc28gdGhlIHdvcmtlciBuZXZlciBzZWxmLWFwcGxpZXMgaXQuIFVzZWQgYnkgdGhlIHByaW9yaXR5XG4gICAqIGhpZXJhcmNoeSBjb2xsZWN0b3IgYW5kIHNlbGVjdG9yIGJ1aWx0IGluIHN1YnNlcXVlbnQgc3ViLWlzc3VlcyBvZiAjMTcyMS5cbiAgICovXG4gIGxvd1ByaW9yaXR5TGFiZWw6IFwibG93LXByaW9yaXR5XCIsXG59IGFzIGNvbnN0O1xuXG4vKipcbiAqIFRoZSB0aHJlZSBoYXJkd2lyZWQgZGlzY292ZXJ5IGxhYmVscyAoSXNzdWUgIzE4MzQpLlxuICpcbiAqIGB0b3AtcHJpb3JpdHlgLCBgd29yay1vbmAsIGFuZCBgbG93LXByaW9yaXR5YCBhcmUgdGhlIGNhbm9uaWNhbFxuICogcGlja3VwIHNpZ25hbHMuIFRoZXkgYXJlIG5vdCBjb25maWd1cmFibGUg4oCUIGV2ZXJ5IFZpYmUgQ29kZXIgcGlja3NcbiAqIHRoZW0gdXAgYnkgZGVmYXVsdCB3aXRoIHplcm8gY29uZmlndXJhdGlvbi4gVGhlIGRpYWdub3N0aWMgZGlzY292ZXJ5XG4gKiBjaGVjayB1c2VzIHRoaXMgc2V0LCBkZWR1cGxpY2F0ZWQsIHdoZW4gcmVwb3J0aW5nIHdoaWNoIGxhYmVscyBtYWtlXG4gKiBhbiBpc3N1ZSBlbGlnaWJsZS5cbiAqL1xuZXhwb3J0IGNvbnN0IERJU0NPVkVSWV9MQUJFTFM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1xuICBMQUJFTF9ERUZBVUxUUy50b3BQcmlvcml0eUxhYmVsLFxuICBMQUJFTF9ERUZBVUxUUy53b3JrT25MYWJlbCxcbiAgTEFCRUxfREVGQVVMVFMubG93UHJpb3JpdHlMYWJlbCxcbl0gYXMgY29uc3Q7XG5cbi8qKlxuICogUGFydGlhbCBGYWlsdXJlLURldGVjdGlvbiByZXBhaXIgbGFiZWwgKElzc3VlICM1OSwgcGFydCBvZiAjNTQpLlxuICpcbiAqIE1hcmtzIGEgcGxhbm5pbmcgcGFyZW50IHdob3NlIHJ1biBwdWJsaXNoZWQgYSB1c2FibGUgcGxhbiBidXQgbGVmdCBvbmUgb3JcbiAqIG1vcmUgc3ViLWlzc3VlcyB3aXRob3V0IGEgZmlsbGVkIGAjIyBGYWlsdXJlIERldGVjdGlvbmAgc2VjdGlvbi4gRGVmaW5lZCBoZXJlXG4gKiByYXRoZXIgdGhhbiBiZXNpZGUgaXRzIGFwcGx5IGhlbHBlciBiZWNhdXNlIGJlaW5nICpyZXNlcnZlZCogaXMgdGhlIHByb3BlcnR5XG4gKiB0aGF0IGdvdmVybnMgaXQ6IHRoZSB3b3JrZXIgcmFpc2VzIGl0LCBhbmQgdGhlIHBsYW5uZXIgbXVzdCBuZXZlciBiZSBhYmxlIHRvXG4gKiBhcHBseSBpdCBhcyBhIGRlc2NyaXB0aXZlIGxhYmVsIG9uIGEgc3ViLWlzc3VlLiBOb3QgY29uZmlndXJhYmxlLlxuICovXG5leHBvcnQgY29uc3QgRkFJTFVSRV9ERVRFQ1RJT05fUkVQQUlSX0xBQkVMID0gXCJuZWVkcy1mYWlsdXJlLWRldGVjdGlvbi1yZXBhaXJcIjtcblxuLyoqXG4gKiBSZXNlcnZlZCBsYWJlbHMgdGhhdCBtdXN0IG5vdCBiZSBhcHBsaWVkIHdoZW4gdGhlIHdvcmtlciBjcmVhdGVzIGlzc3Vlcy5cbiAqXG4gKiBUaGVzZSBsYWJlbHMgYXJlIHVzZWQgYnkgdGhlIHdvcmtlciBmb3Igb3BlcmF0aW9uYWwgcHVycG9zZXMgKGlzc3VlIGRpc2NvdmVyeSxcbiAqIHByaW9yaXRpc2F0aW9uLCBmYWlsdXJlIHRyYWNraW5nLCB3b3JrZmxvdyBzdGF0ZSkuIE9ubHkgdGhlIHJlcG9zaXRvcnkgb3duZXJcbiAqIHNob3VsZCBhcHBseSB0aGVzZSBsYWJlbHMuXG4gKlxuICogSXNzdWUgIzI5NzogUHJldmVudCB0aGUgdmliZSBjb2RlciBmcm9tIGxhYmVsbGluZyBjcmVhdGVkIGlzc3VlcyB3aXRoXG4gKiBzcGVjaWFsIG9wZXJhdGlvbmFsIGxhYmVscy5cbiAqL1xuZXhwb3J0IGNvbnN0IFJFU0VSVkVEX0xBQkVMUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIC8vIElzc3VlICMyMDIyOiB0aGUgbGVnYWN5IGBjbGF1ZGVgIGFuZCBgaGVscCB3YW50ZWRgIGRpc2NvdmVyeS93YXRjaFxuICAvLyBsYWJlbHMgYXJlIHN0aWxsIHJlc2VydmVkIHNvIHRoZSB3b3JrZXIgbmV2ZXIgc2VsZi1hcHBsaWVzIHRoZW0gb25cbiAgLy8gcmVwb3MgdGhhdCBoYXZlIG5vdCB5ZXQgYmVlbiBjbGVhbmVkIHVwIOKAlCBidXQgdGhlIGNhbm9uaWNhbFxuICAvLyBkaXNjb3Zlcnkgc2V0IGlzIG5vdyBgdG9wLXByaW9yaXR5YCA+IGB3b3JrLW9uYCA+IGBsb3ctcHJpb3JpdHlgID5cbiAgLy8gYGlkbGUtdGFza2AuIGBpZGxlLXRhc2tgIGlzIHRoZSBvbmx5IGxhYmVsIHRoZSB3b3JrZXIgbWF5IGFkZC5cbiAgXCJjbGF1ZGVcIixcbiAgXCJoZWxwIHdhbnRlZFwiLFxuICAvLyBJc3N1ZSAjMTgzNDogdG9wLXByaW9yaXR5IGlzIHRoZSBjYW5vbmljYWwgaGlnaGVzdC1wcmlvcml0eSBkaXNjb3ZlcnlcbiAgLy8gc2lnbmFsIGFuZCByZXNlcnZlZCBzbyB0aGUgd29ya2VyIG5ldmVyIHNlbGYtYXBwbGllcyBpdC5cbiAgTEFCRUxfREVGQVVMVFMudG9wUHJpb3JpdHlMYWJlbCxcbiAgLy8gSXNzdWUgIzE3MjM6IGxvdy1wcmlvcml0eSBpcyByZXNlcnZlZCBzbyB0aGUgd29ya2VyIG5ldmVyIHNlbGYtYXBwbGllcyBpdC5cbiAgTEFCRUxfREVGQVVMVFMubG93UHJpb3JpdHlMYWJlbCxcbiAgLy8gUHJpb3JpdGlzYXRpb24gbGFiZWxcbiAgTEFCRUxfREVGQVVMVFMud29ya09uTGFiZWwsXG4gIC8vIEZhaWx1cmUgdHJhY2tpbmcgbGFiZWxzXG4gIExBQkVMX0RFRkFVTFRTLmZhaWxlZExhYmVsLFxuICBMQUJFTF9ERUZBVUxUUy5mYWlsZWRPbmNlTGFiZWwsXG4gIC8vIFdvcmtmbG93IHN0YXRlIGxhYmVsc1xuICAvLyBJc3N1ZSAjMjAzMTogbmVlZHMtY2xhcmlmaWNhdGlvbiByZXRpcmVkIOKAlCBuZWVkcy1odW1hbiBpcyB0aGUgaGFuZG9mZlxuICAvLyBzaWduYWwuIFRoZSBsaXRlcmFsIGxhYmVsIG5hbWUgc3RheXMgcmVzZXJ2ZWQgaGVyZSBhcyBkZWZlbmNlIGluIGRlcHRoXG4gIC8vIHNvIHRoZSB3b3JrZXIgbmV2ZXIgcmUtYXBwbGllcyBpdCB0byBhIG5ld2x5IGZpbGVkIGlzc3VlIGFuZCB0aGVcbiAgLy8gUFItY29weSBmaWx0ZXIgc3RyaXBzIGl0IGZyb20gb2xkZXIgcmVwb3MgdGhhdCBzdGlsbCBjYXJyeSB0aGUgbGFiZWwuXG4gIFwibmVlZHMtY2xhcmlmaWNhdGlvblwiLFxuICBMQUJFTF9ERUZBVUxUUy5yZWZpbmVJc3N1ZUxhYmVsLFxuICBMQUJFTF9ERUZBVUxUUy5wbGFubmluZ0xhYmVsLFxuICBMQUJFTF9ERUZBVUxUUy5xdWVzdGlvbkxhYmVsLFxuICAvLyBJc3N1ZSAjMjAzMDogYGFuc3dlcmVkYCByZXRpcmVkIOKAlCBxdWVzdGlvbiB3b3JrZmxvdyBub3cgc2lnbmFscyBoYW5kb2ZmXG4gIC8vIHdpdGggYG5lZWRzLWh1bWFuYC4gVGhlIGxpdGVyYWwgbGFiZWwgbmFtZSBzdGF5cyByZXNlcnZlZCBhcyBkZWZlbmNlIGluXG4gIC8vIGRlcHRoIHNvIHRoZSB3b3JrZXIgbmV2ZXIgcmUtYXBwbGllcyBpdCB0byBhIGZyZXNobHkgZmlsZWQgaXNzdWUgYW5kIHRoZVxuICAvLyBQUi1jb3B5IGZpbHRlciBzdHJpcHMgaXQgZnJvbSBvbGRlciByZXBvcyB0aGF0IHN0aWxsIGNhcnJ5IHRoZSBsYWJlbC5cbiAgXCJhbnN3ZXJlZFwiLFxuICBMQUJFTF9ERUZBVUxUUy5uZWVkc1JldmlzaW9uTGFiZWwsXG4gIExBQkVMX0RFRkFVTFRTLm5lZWRzSHVtYW5MYWJlbCxcbiAgTEFCRUxfREVGQVVMVFMuZ3JpbGxNZUxhYmVsLFxuICAvLyBJc3N1ZSAjNDExMjogYHF1b3J1bWAgc3RhcnRzIGEgdGhyZWUtYWdlbnQgcGxhbi1vZmYg4oCUIGEgcHJpdmlsZWdlZCxcbiAgLy8gdHJpcGxlLWJpbGxlZCBwaGFzZS4gSXQgaXMgaHVtYW4tYXBwbGllZCBvbmx5LCBzbyBpdCBpcyByZXNlcnZlZCBoZXJlIGFuZFxuICAvLyB0aGUgd29ya2VyJ3Mgb3duIGxhYmVsIGd1YXJkIHJlZnVzZXMgaXQuXG4gIExBQkVMX0RFRkFVTFRTLnF1b3J1bUxhYmVsLFxuICAvLyBJc3N1ZSAjNTkgKHBhcnQgb2YgIzU0KTogYG5lZWRzLWZhaWx1cmUtZGV0ZWN0aW9uLXJlcGFpcmAgbWFya3MgYSBwbGFubmluZ1xuICAvLyBwYXJlbnQgd2hvc2UgcHVibGlzaGVkIHN1Yi1pc3N1ZXMgc3RpbGwgbmVlZCB0aGVpciBgIyMgRmFpbHVyZSBEZXRlY3Rpb25gXG4gIC8vIGNyaXRlcmlvbi4gVGhlIHdvcmtlciByYWlzZXMgaXQgKHNlZSBgZmFpbHVyZV9kZXRlY3Rpb25fcmVwYWlyX2xhYmVsLnRzYCk7XG4gIC8vIHJlc2VydmVkIHNvIHRoZSBwbGFubmVyIGNhbiBuZXZlciBhcHBseSBpdCBhcyBhIGRlc2NyaXB0aXZlIGxhYmVsIG9uIGFcbiAgLy8gc3ViLWlzc3VlIGFuZCBtYW51ZmFjdHVyZSBhIHBoYW50b20gcmVwYWlyIHF1ZXVlLlxuICBGQUlMVVJFX0RFVEVDVElPTl9SRVBBSVJfTEFCRUwsXG5dO1xuXG4vKipcbiAqIExvd2VyLWNhc2VkIHZpZXcgb2Yge0BsaW5rIFJFU0VSVkVEX0xBQkVMU30gZm9yIGNhc2UtaW5zZW5zaXRpdmUgbWVtYmVyc2hpcFxuICogY2hlY2tzIChJc3N1ZSAjMzA4OCkuXG4gKlxuICogR2l0SHViIHRyZWF0cyBsYWJlbCBuYW1lcyBjYXNlLWluc2Vuc2l0aXZlbHkgKGl0IGZvcmJpZHMgdHdvIGxhYmVscyB0aGF0XG4gKiBkaWZmZXIgb25seSBpbiBjYXNlKSwgc28gdGhlIHJlc2VydmVkLWxhYmVsIGd1YXJkcyBtdXN0IG1hdGNoIHRoZSBzYW1lIHdheS5cbiAqIEJ1aWx0IG9uY2UgYXQgbW9kdWxlIGxvYWQgZnJvbSB0aGUgc2luZ2xlIGBSRVNFUlZFRF9MQUJFTFNgIGNvbnN0YW50IHNvIHRoZVxuICogc2V0IHN0YXlzIGluIHN5bmMgYXV0b21hdGljYWxseSAobm8gc2Vjb25kIGhhbmQtbWFpbnRhaW5lZCBsaXN0IOKAlCBEUlkpLlxuICovXG5jb25zdCBSRVNFUlZFRF9MQUJFTFNfTE9XRVI6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFxuICBSRVNFUlZFRF9MQUJFTFMubWFwKChsYWJlbCkgPT4gbGFiZWwudG9Mb3dlckNhc2UoKSksXG4pO1xuXG4vKipcbiAqIFJldHVybiB0cnVlIGlmIGBsYWJlbGAgaXMgYSByZXNlcnZlZCB3b3JrZmxvdyBsYWJlbCwgY29tcGFyaW5nXG4gKiBjYXNlLWluc2Vuc2l0aXZlbHkgKElzc3VlICMzMDg4KS5cbiAqXG4gKiBUaGUgY2Fub25pY2FsIGBSRVNFUlZFRF9MQUJFTFNgIGVudHJpZXMgYXJlIGFsbCBsb3dlci1jYXNlLCBidXQgYSByZXBvIGNvdWxkXG4gKiBzdG9yZSBhIGNhbm9uaWNhbCBsYWJlbCBpbiBhIG5vbi1sb3dlci1jYXNlIGZvcm0gKGUuZy4gYFBsYW5uaW5nYCkuIEFcbiAqIGNhc2Utc2Vuc2l0aXZlIGBSRVNFUlZFRF9MQUJFTFMuaW5jbHVkZXMobGFiZWwpYCB3b3VsZCB0aGVuIG1pc3MgaXQsIGxlYXZpbmdcbiAqIHRoZSBzdHJpcCBndWFyZHMgb3V0IG9mIHN0ZXAgd2l0aCB0aGUgZGlzcGF0Y2ggZ2F0ZVxuICogKGByZXF1aXJlc0xhYmVsQWRkZXJUcnVzdGApLCB3aGljaCBhbHJlYWR5IGxvd2VyLWNhc2VzLiBUaGlzIGhlbHBlciBrZWVwcyBhbGxcbiAqIHRoZSBndWFyZHMgY29uc2lzdGVudC5cbiAqXG4gKiBAcGFyYW0gbGFiZWwgLSBUaGUgbGFiZWwgbmFtZSB0byB0ZXN0XG4gKiBAcmV0dXJucyBUcnVlIGlmIHRoZSBsYWJlbCAoY2FzZS1pbnNlbnNpdGl2ZWx5KSBpcyByZXNlcnZlZFxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNSZXNlcnZlZExhYmVsKGxhYmVsOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIFJFU0VSVkVEX0xBQkVMU19MT1dFUi5oYXMobGFiZWwudG9Mb3dlckNhc2UoKSk7XG59XG5cbi8qKlxuICogT3BlcmF0aW9uYWwgZGVmYXVsdHMg4oCUIHRpbWVvdXRzLCBpbnRlcnZhbHMsIGFuZCBudW1lcmljIHNldHRpbmdzLlxuICpcbiAqIElzc3VlICMyNzc6IFRoZXNlIHZhbHVlcyBhcmUgbm93IGNvbmZpZ3VyYWJsZSB2aWEgLmNvbmZpZy5qc29uLlxuICogT25seSB2YWx1ZXMgdGhhdCBkaWZmZXIgZnJvbSB0aGVzZSBkZWZhdWx0cyBuZWVkIHRvIGJlIHN0b3JlZCBpbiB0aGUgY29uZmlnIGZpbGUuXG4gKiBJZiBhIGRlZmF1bHQgY2hhbmdlcyBpbiB0aGUgY29kZWJhc2UsIGFsbCB1c2VycyBnZXQgdGhlIG5ldyBkZWZhdWx0IHVubGVzc1xuICogdGhleSBoYXZlIGV4cGxpY2l0bHkgb3ZlcnJpZGRlbiBpdC5cbiAqL1xuZXhwb3J0IGNvbnN0IE9QRVJBVElPTkFMX0RFRkFVTFRTID0ge1xuICAvLyBJc3N1ZSAjMTgyNDogbG93ZXJlZCBmcm9tIDE0NDAwICg0aCkgdG8gMzYwMCAoMWgpLiBBIDQtaG91ciB3ZWRnZSBvblxuICAvLyBhIHNpbmdsZSBDbGF1ZGUgcnVuIGNvbnN1bWVkIGFuIGVudGlyZSBpdGVyYXRpb24ncyBydW4tZHVyYXRpb24gYnVkZ2V0XG4gIC8vIGFuZCBzdGFydmVkIG90aGVyIHJlcG9zaXRvcmllcy4gSWYgaXNzdWUgd29yayBnZW51aW5lbHkgbmVlZHMgbW9yZVxuICAvLyB0aGFuIGFuIGhvdXIsIHRoZSBlc2NhcGUgaGF0Y2ggc2hvdWxkIHJhaXNlIGEgc3ViLWlzc3VlLlxuICBjbGF1ZGVUaW1lb3V0OiAzNjAwLFxuICBjbGF1ZGVNYXhUdXJuczogREVGQVVMVF9DTEFVREVfTUFYX1RVUk5TLFxuICAvKipcbiAgICogQ2xhaW0tcnVud2F5IGZsb29yIGluIHNlY29uZHMgKElzc3VlICMyODkpLiBGaXZlIG1pbnV0ZXM6IGVub3VnaCB0byBydWxlXG4gICAqIG91dCBhIGNsYWltIHRoYXQgY2Fubm90IGZpbmlzaCBzZXR1cCwgc21hbGwgZW5vdWdoIHRoYXQgYSBydW4ga2VlcHNcbiAgICogY2xhaW1pbmcgdW50aWwgaXRzIGxhc3QgbWludXRlcy4gVGhlIHNpbmdsZSBkZWZpbml0aW9uIGxpdmVzIGluXG4gICAqIGBjbGFpbV9ydW53YXkudHNgLlxuICAgKi9cbiAgbWluQ2xhaW1SdW53YXlTZWNvbmRzOiBERUZBVUxUX01JTl9DTEFJTV9SVU5XQVlfU0VDT05EUyxcbiAgLyoqXG4gICAqIFJ1biBmaW5pc2ggZGVhZGxpbmUgaW4gc2Vjb25kcyBmcm9tIHJ1biBzdGFydCAoSXNzdWUgIzQyNDIpOiB0d28gaG91cnMuXG4gICAqIE11c3QgZXhjZWVkIHRoZSBvbmUtaG91ciBydW4gdGFyZ2V0LiBUaGUgc2luZ2xlIGRlZmluaXRpb24gbGl2ZXMgaW5cbiAgICogYHJ1bl90aW1lbGluZS50c2AuXG4gICAqL1xuICBydW5GaW5pc2hTZWNvbmRzOiBERUZBVUxUX1JVTl9GSU5JU0hfU0VDT05EUyxcbiAgLyoqXG4gICAqIFJlLWFybWFibGUgaGFyZCBkZWFkbGluZSBmb3IgaXNzdWUgd29yayAoSXNzdWUgIzQyOTYsIHBhcnQgb2YgIzQyOTApLlxuICAgKlxuICAgKiAqKk9uIGJ5IGRlZmF1bHQqKiAoSXNzdWUgIzQyMiwgcGFyZW50ICMzOTcpOiBraWxsaW5nIGEgY2xhaW0gdGhhdCBpc1xuICAgKiBkZW1vbnN0cmFibHkgcHJvZ3Jlc3NpbmcgdGhyb3dzIHRoZSBydW4ncyB3b3JrIGF3YXksIHNvIHRoZVxuICAgKiBgY2xhdWRlVGltZW91dGAga2lsbCBmb3IgKippc3N1ZSB3b3JrIG9ubHkqKiBpcyBkZWZlcnJlZCB3aGlsZSB0aGUgcnVuXG4gICAqIHNob3dzIHJlY2VudCB0b29sIGFjdGl2aXR5IHRvZ2V0aGVyIHdpdGggcHJvZ3Jlc3Mg4oCUIGEgd29ya2luZyB0cmVlIHRoYXRcbiAgICogYWN0dWFsbHkgYWR2YW5jZWQsIG9yIGEgZGVzY2VuZGFudCBwcm9jZXNzIGRvaW5nIHdvcmsgb3V0c2lkZSB0aGVcbiAgICogY2hlY2tvdXQgKElzc3VlICM1MDgpLiBFdmVyeSBvdGhlciBwaGFzZSBrZWVwcyBpdHMgdW5jb25kaXRpb25hbCBjYXAuXG4gICAqXG4gICAqIFRoZSBjaGFpbiBpcyBib3VuZGVkLCBub3Qgb3Blbi1lbmRlZDogZXZlcnkgZ3JhbnQgaXMgY2xhbXBlZCB0byB0aGVcbiAgICogc3VwZXJ2aXNvciBoYXJkIGNhcCBgVklCRV9SVU5fTUFYX1NFQ09ORFNgIChJc3N1ZSAjNDIxKSwgdGhlIG5vLW91dHB1dFxuICAgKiB3YXRjaGRvZyBzdGlsbCBraWxscyBhIHNpbGVudCBydW4sIGFuZCBhIHN0YWxsZWQgcnVuIGRpZXMgd2l0aGluIG9uZVxuICAgKiBncmFudC4gU2V0IGBwcm9ncmVzc19leHRlbnNpb25fZW5hYmxlZDogZmFsc2VgIHRvIGdldCB0aGUgZmxhdCBvbmUtc2hvdFxuICAgKiBraWxsIGJhY2suXG4gICAqL1xuICBwcm9ncmVzc0V4dGVuc2lvbkVuYWJsZWQ6IHRydWUsXG4gIC8qKlxuICAgKiBUZWUgZXZlcnkgYWdlbnQgaW52b2NhdGlvbidzIHJhdyBzdHJlYW0tanNvbiB0byBhIHJlZGFjdGVkIHRyYW5zY3JpcHRcbiAgICogKElzc3VlICMxMTQxKS5cbiAgICpcbiAgICogKipPZmYgYnkgZGVmYXVsdC4qKiBBIHRyYW5zY3JpcHQgaXMgdGhlIHJhdyBhZ2VudCBzdHJlYW0g4oCUIG1vZGVsIG91dHB1dCxcbiAgICogaXNzdWUgYW5kIHJlcG9zaXRvcnkgdGV4dCwgZmlsZSBjb250ZW50cyB0aGUgYWdlbnQgcmVhZCwgY29tbWFuZCBvdXRwdXQg4oCUXG4gICAqIHBhc3Npbmcgb25seSB0aHJvdWdoIHRoZSBjb25zb2xlIHNlY3JldCByZWRhY3Rpb24sIHdoaWNoIGlzIGEgbmV0IGZvclxuICAgKiBrbm93biBjcmVkZW50aWFsIHNoYXBlcyByYXRoZXIgdGhhbiBhIGd1YXJhbnRlZS4gVGhhdCBpcyBub3Qgc29tZXRoaW5nIHRvXG4gICAqIHN0YXJ0IGNhcHR1cmluZyBvbiBhIGRlcGxveW1lbnQncyBiZWhhbGYsIHNvIGl0IHN0YXlzIG9mZiB1bnRpbFxuICAgKiBgYWdlbnRfdHJhbnNjcmlwdF9lbmFibGVkYCBhc2tzIGZvciBpdC5cbiAgICovXG4gIGFnZW50VHJhbnNjcmlwdEVuYWJsZWQ6IGZhbHNlLFxuICAvKiogU2Vjb25kcyBlYWNoIGdyYW50IGFkZHMgdG8gdGhlIGRlYWRsaW5lLCBtZWFzdXJlZCBmcm9tIG5vdyAoIzQyOTYpLiAqL1xuICBwcm9ncmVzc0V4dGVuc2lvbkdyYW50U2Vjb25kczogOTAwLFxuICAvKipcbiAgICogVGltZW91dCBmb3IgdGhlIHNjcmVlbnNob3QgZ2F0ZSdzIG9uZSBleHRyYSBpbi1ydW4gYWdlbnQgdHVyblxuICAgKiAoSXNzdWUgIzI5NjApIOKAlCBsb25nIGVub3VnaCB0byBuYXZpZ2F0ZSwgc2NyZWVuc2hvdCBhbmQgY29tbWl0LlxuICAgKi9cbiAgc2NyZWVuc2hvdFJldHJ5VGltZW91dFNlY29uZHM6IDYwMCxcbiAgLyoqXG4gICAqIFRpbWVvdXQgZm9yIHRoZSBwcmUtcHVzaCBnYXRlJ3Mgb25lIGV4dHJhIGluLXJ1biBhZ2VudCB0dXJuIChJc3N1ZSAjNDEyOClcbiAgICog4oCUIGxvbmcgZW5vdWdoIHRvIGZpeCwgcmUtY2hlY2sgYW5kIGNvbW1pdC5cbiAgICovXG4gIHByZVB1c2hSZXRyeVRpbWVvdXRTZWNvbmRzOiA2MDAsXG4gIC8qKiBBIHRvb2wgY2FsbCBvbGRlciB0aGFuIHRoaXMgaXMgbm8gbG9uZ2VyIGV2aWRlbmNlIG9mIGFjdGl2aXR5ICgjNDI5NikuICovXG4gIHByb2dyZXNzRXh0ZW5zaW9uU3RhbGxTZWNvbmRzOiAzMDAsXG4gIC8qKlxuICAgKiBIb3cgb2Z0ZW4gcHJvZ3Jlc3MgaXMgc2FtcGxlZCBiZXR3ZWVuIGRlYWRsaW5lIGNoZWNrcyAoIzQyOTUpOiB0aGVcbiAgICogd29ya2luZyB0cmVlLCBhbmQgdGhlIGFnZW50J3MgZGVzY2VuZGFudCBDUFUgKElzc3VlICM1MDgpLlxuICAgKlxuICAgKiBCb3VuZHMgaG93IHN0YWxlIHRoZSB0cmVlIHZlcmRpY3QgY2FuIGJlIHdoZW4gdGhlIGRlYWRsaW5lIGRlY2lzaW9uIGlzXG4gICAqIHRha2VuLCBzbyBhIHJ1biB0aGF0IHN0b3BzIGNoYW5naW5nIHRoZSBjaGVja291dCBpcyBub3RpY2VkIHdpdGhpbiBhXG4gICAqIGNoZWNrIGludGVydmFsIHJhdGhlciB0aGFuIGEgd2hvbGUgZ3JhbnQuIE11c3Qgbm90IGV4Y2VlZFxuICAgKiBgcHJvZ3Jlc3NFeHRlbnNpb25TdGFsbFNlY29uZHNgLCBvciBhIHJ1biB0aGF0IHByb2dyZXNzZWQgaW5zaWRlIHRoZVxuICAgKiBzYW1wbGluZyB3aW5kb3cgY291bGQgc3RpbGwgYmUga2lsbGVkIGZvciBzdGFsZSB0b29sIGFjdGl2aXR5LlxuICAgKi9cbiAgcHJvZ3Jlc3NFeHRlbnNpb25DaGVja1NlY29uZHM6IDMwMCxcbiAgLyoqXG4gICAqIENhbGwtc3Rvcm0gc3RhbGwgZ3VhcmQgKElzc3VlICMyMjMwKS5cbiAgICpcbiAgICogKipPbiBieSBkZWZhdWx0LioqIEEgcnVuIHBvbGxpbmcgYSBiYWNrZ3JvdW5kIGpvYiB0dXJuIGJ5IHR1cm4g4oCUIEdSUS0yM1xuICAgKiBtYW5hZ2VkIH43MDAgdG9vbCBjYWxscyBhbmQgYGVjaG8gdzI1MmAgaW4gYW4gaG91ciDigJQgaXMgc3RhbGxlZCBieVxuICAgKiBkZWZpbml0aW9uLCBhbmQgbmVpdGhlciB0aGUgbm8tb3V0cHV0IHdhdGNoZG9nIChpdCBzZWVzIG91dHB1dCBldmVyeVxuICAgKiBzZWNvbmQpIG5vciB0aGUgcHJvZ3Jlc3MgZXh0ZW5zaW9uIChpdCBvbmx5IGRlY2xpbmVzIHRvIGV4dGVuZCkgc3RvcHNcbiAgICogaXQuIFNldCBgY2FsbF9zdG9ybV9lbmFibGVkOiBmYWxzZWAgdG8gZ2l2ZSBhIHBvbGxpbmcgbG9vcCBpdHMgd2hvbGVcbiAgICogYnVkZ2V0IGJhY2suXG4gICAqL1xuICBjYWxsU3Rvcm1FbmFibGVkOiB0cnVlLFxuICAvKipcbiAgICogVG9vbCBjYWxscyBpbnNpZGUgdGhlIHdpbmRvdyBhdCB3aGljaCBhIHJ1biBpcyBqdWRnZWQgYSBzdG9ybSAoIzIyMzApLlxuICAgKlxuICAgKiBTaXh0eSBjYWxscyBpbiBmaXZlIG1pbnV0ZXMgaXMgdHdlbHZlIGEgbWludXRlLCBzdXN0YWluZWQsIHdpdGggbm90aGluZ1xuICAgKiB0byBzaG93IGZvciBpdCBpbiB0aGUgY2hlY2tvdXQ7IHRoZSBpbmNpZGVudCB0aGF0IHByb21wdGVkIHRoZSBndWFyZCByYW5cbiAgICogYXQgcm91Z2hseSB0d2VudHktZml2ZSBhIG1pbnV0ZSBmb3IgdHdlbnR5IG1pbnV0ZXMuIFJhaXNlIGl0IGlmIGFuXG4gICAqIGV4cGxvcmF0aW9uIHBoYXNlIHRoYXQgZ2VudWluZWx5IHJlYWRzIGZhc3RlciB0aGFuIHRoaXMgaXMgYmVpbmcgc3RvcHBlZC5cbiAgICovXG4gIGNhbGxTdG9ybUNhbGxzOiA2MCxcbiAgLyoqXG4gICAqIFNsaWRpbmcgd2luZG93IHRoZSBjYWxscyBhcmUgY291bnRlZCBvdmVyICgjMjIzMCkuXG4gICAqXG4gICAqIE1hdGNoZWQgdG8gYHByb2dyZXNzRXh0ZW5zaW9uQ2hlY2tTZWNvbmRzYCwgYmVjYXVzZSB0aGF0IGlzIHRoZSBjYWRlbmNlXG4gICAqIHRoZSBndWFyZCBpcyBldmFsdWF0ZWQgYXQ6IHRoZSB3aW5kb3cganVkZ2VkIGlzIHRoZSB3aW5kb3cgb2JzZXJ2ZWQuXG4gICAqL1xuICBjYWxsU3Rvcm1XaW5kb3dTZWNvbmRzOiAzMDAsXG4gIC8qKlxuICAgKiBOb3ZlbCBzaGFyZSBiZWxvdyB3aGljaCBhIGJ1c3kgd2luZG93IGlzIGEgc3Rvcm0gKCMyNzczKS5cbiAgICpcbiAgICogQSBzZWN1cml0eSBzd2VlcCByZWFkcyBhIG5ldyBtb2R1bGUgb24gbmVhcmx5IGV2ZXJ5IGNhbGwgYW5kIGEgcG9sbCBsb29wXG4gICAqIHJlcGVhdHMgdGhyZWUgb3IgZm91ciBjb21tYW5kcywgc28gdW5kZXIgYSBxdWFydGVyIGRpc3RpbmN0IGlzIHRoZSBsb29wLlxuICAgKiBMb3dlciBpdCBpZiBhbiBpbnZlc3RpZ2F0aW9uIHRoYXQgcmV2aXNpdHMgZmlsZXMgaXMgYmVpbmcgc3RvcHBlZC5cbiAgICovXG4gIGNhbGxTdG9ybU5vdmVsU2hhcmU6IERFRkFVTFRfQ0FMTF9TVE9STV9OT1ZFTF9TSEFSRSxcbiAgLyoqXG4gICAqIFF1b3RhLWF3YXJlIHBvbGxpbmcgZ2F0ZSBmbG9vcnMgKElzc3VlICMzNjI4KS5cbiAgICpcbiAgICogYHF1b3RhUG9sbFBhcmtGbG9vcmA6IGJlbG93IHRoaXMgbWFueSBHcmFwaFFMIHBvaW50cyByZW1haW5pbmcsIHJlcG9zXG4gICAqIHdpdGggYG5pY2UgPj0gcXVvdGFQb2xsUGFya05pY2VgIGFyZSBza2lwcGVkIHdob2xlIGZvciB0aGUgY3ljbGUuXG4gICAqIGBxdW90YVBvbGxJZGxlRmxvb3JgOiBiZWxvdyB0aGlzIG1hbnksIGlkbGUtdGFzayBjb2xsZWN0aW9uIGlzIGRlZmVycmVkXG4gICAqIGZsZWV0LXdpZGUgKHNjYW4gY29sbGVjdG9yIGFuZCBmaWxlcikuIEJvdGggYXJlIHN0cmljdCBsZXNzLXRoYW5cbiAgICogYm91bmRhcmllczsgYSBmbG9vciBvZiAwIGRpc2FibGVzIGl0cyB0aWVyLiBBIGZhaWxlZCBxdW90YSBwcm9iZSBkZWZlcnNcbiAgICogbm90aGluZyDigJQgdGhlIGdhdGUgZmFpbHMgb3Blbi5cbiAgICovXG4gIHF1b3RhUG9sbFBhcmtGbG9vcjogMTUwMCxcbiAgcXVvdGFQb2xsUGFya05pY2U6IDk5LFxuICBxdW90YVBvbGxJZGxlRmxvb3I6IDUwMCxcbiAgLyoqXG4gICAqIE5pY2UtZGVyaXZlZCBwb2xsIGNhZGVuY2UgKElzc3VlICMzNjY3KTogdGhlIHBlci1yZXBvIFByaW9yaXR5IDEueFxuICAgKiBwYXNzZXMgcG9sbCBhIGAwIDwgbmljZSA8IHF1b3RhUG9sbFBhcmtOaWNlYCByZXBvIGV2ZXJ5XG4gICAqIGBwb2xsQ2FkZW5jZUxvd0N5Y2xlc2AgY3ljbGVzIGFuZCBhIGBuaWNlID49IHF1b3RhUG9sbFBhcmtOaWNlYCByZXBvXG4gICAqIGV2ZXJ5IGBwb2xsQ2FkZW5jZVBhcmtDeWNsZXNgIGN5Y2xlcy4gYG5pY2UgPD0gMGAgcmVwb3MgYXJlIHBvbGxlZCBldmVyeVxuICAgKiBjeWNsZTsgMSB0dXJucyBhIHRpZXIncyBjYWRlbmNlIG9mZi5cbiAgICovXG4gIHBvbGxDYWRlbmNlTG93Q3ljbGVzOiAzLFxuICBwb2xsQ2FkZW5jZVBhcmtDeWNsZXM6IDEwLFxuICAvKipcbiAgICogU2VsZi1zY2hlZHVsaW5nIGZvciBhdXRvLWZpbGVkIHdvcmtlciBkaWFnbm9zdGljcyAoSXNzdWUgIzUwNSkuXG4gICAqXG4gICAqICoqT24gYnkgZGVmYXVsdC4qKiBUaGUgd29ya2VyIGRpYWdub3NlcyBpdHMgb3duIGZhdWx0cyBhY2N1cmF0ZWx5IGFuZFxuICAgKiB0aGVuIHN0b3BwZWQgZGVhZCBhdCB0aGUgb25lIGFjdGlvbiByZXNlcnZlZCBmb3IgaHVtYW5zLCBzbyBvbiBhblxuICAgKiB1bmF0dGVuZGVkIGhvc3QgdGhlIGFsYXJtIGp1c3QgYWNjdW11bGF0ZWQg4oCUIGBORUFULUFJLVJlYmFzZSMzOWAgd2FpdGVkXG4gICAqIHR3byBkYXlzIGZvciBhIGxhYmVsIHRoZSBmaXggdGhlbiB0b29rIDc5IG1pbnV0ZXMgdG8gaG9ub3VyLiBPbmx5XG4gICAqIGlzc3VlcyB0aGUgd29ya2VyIGZpbGVkIGFib3V0IGl0c2VsZiwgaW4gaXRzIG93biByZXBvLCBjYXJyeWluZyBhXG4gICAqIHJlY29nbmlzZWQgcHJvdmVuYW5jZSBtYXJrZXIsIHF1YWxpZnk7IG5vIGxhYmVsIGlzIGV2ZXIgc2VsZi1hcHBsaWVkLlxuICAgKiBTZXQgYHNlbGZfc2NoZWR1bGVfZGlhZ25vc3RpY3NfZW5hYmxlZDogZmFsc2VgIHRvIHJlc3RvcmUgdGhlXG4gICAqIHdhaXQtZm9yLWEtaHVtYW4gYmVoYXZpb3VyIGV4YWN0bHkuXG4gICAqL1xuICBzZWxmU2NoZWR1bGVEaWFnbm9zdGljc0VuYWJsZWQ6IHRydWUsXG4gIC8qKlxuICAgKiBPbmUgc2VsZi1zY2hlZHVsZWQgZGlhZ25vc3RpYyBpbiBmbGlnaHQgYXQgYSB0aW1lIChJc3N1ZSAjNTA1KSwgc28gYVxuICAgKiBtaXNmaXJpbmcgZGV0ZWN0b3IgY2Fubm90IGZpbGwgdGhlIHF1ZXVlIHdpdGggaXRzIG93biB3b3JrLlxuICAgKi9cbiAgc2VsZlNjaGVkdWxlRGlhZ25vc3RpY3NNYXhJbkZsaWdodDogMSxcbiAgY2xhdWRlS2lsbEFmdGVyOiAzMCxcbiAgbWF4Q2xhcmlmaWNhdGlvblJvdW5kczogMyxcbiAgLyoqXG4gICAqIFNlY29uZHMgc2xlcHQgYmV0d2VlbiBzY2FuIGN5Y2xlcy4gUmFpc2VkIGZyb20gMTIwIHRvIDMwMCBiZWNhdXNlIGVhY2hcbiAgICogY3ljbGUgY2FycmllcyBhIGZpeGVkIEdyYXBoUUwgY29zdDsgZmV3ZXIgY3ljbGVzIHJlZHVjZSBzaGFyZWQtYWNjb3VudFxuICAgKiBxdW90YSBzcGVuZC4gQW4gZXhwbGljaXRcbiAgICogYHNsZWVwX2ludGVydmFsYCBpbiBgLmNvbmZpZy5qc29uYCBzdGlsbCB3aW5zLlxuICAgKi9cbiAgc2xlZXBJbnRlcnZhbDogMzAwLFxuICAvLyBDb25jdXJyZW50LWlzc3VlIHNsb3RzIChJc3N1ZXMgIzQxNzQvIzQxNzcsIFZpYmVDb2RlciMxNzApOiB0d28gYnlcbiAgLy8gZGVmYXVsdCDigJQgdGhlIGludGVuZGVkIGNhZGVuY2UgaXMgXCJ3b3JrIGFzIG1hbnkgaXNzdWVzIGFzIHBvc3NpYmxlIGluXG4gIC8vIGVhY2ggaG91cmx5IHJ1blwiLCBhbmQgdGhlIHNsb3QgZ292ZXJub3IgKCM0MTc5KSBsb3dlcnMgdGhlIGVmZmVjdGl2ZVxuICAvLyBjb3VudCB1bmRlciBtZW1vcnkgcHJlc3N1cmUuIGAxYCBvcHRzIGJhY2sgaW50byB0aGUgc2VyaWFsIGxvb3AuXG4gIG1heENvbmN1cnJlbnRJc3N1ZXM6IDIsXG4gIGNyZWRpdFdhaXRJbnRlcnZhbDogMzAwLFxuICByZWZpbmVtZW50VGltZW91dDogMzAwLFxuICByZWZpbmVtZW50S2lsbEFmdGVyOiAxMCxcbiAgLy8gSXNzdWUgIzE4MjQ6IGxvd2VyZWQgZnJvbSAxNDQwMCAoNGgpIHRvIDE4MDAgKDMwIG1pbikuIFBsYW5uaW5nIHByb2R1Y2VzXG4gIC8vIHN1Yi1pc3N1ZXMg4oCUIGl0IHNob3VsZCBiZSBxdWljay5cbiAgcGxhbm5pbmdUaW1lb3V0OiAxODAwLFxuICBwbGFubmluZ0tpbGxBZnRlcjogMTAsXG4gIC8qKlxuICAgKiBIYXJkIHRpbWVvdXQgaW4gc2Vjb25kcyBmb3IgdGhlIFBSIGZlZWRiYWNrIHBoYXNlIChJc3N1ZSAjMTgyNCkuXG4gICAqIEEgc2luZ2xlIFBSIGNvbW1lbnQgY2Fubm90IHJlYXNvbmFibHkgbmVlZCBtb3JlIHRoYW4gMzAgbWludXRlcy5cbiAgICogRGlzdGluY3QgZnJvbSBgY2xhdWRlVGltZW91dGAgc28gcmVhY3RpdmUgcGhhc2VzIGRvIG5vdCBpbmhlcml0XG4gICAqIHRoZSBsYXJnZXIgaXNzdWUtd29yayBidWRnZXQuXG4gICAqL1xuICBwckZlZWRiYWNrVGltZW91dDogMTgwMCxcbiAgLyoqXG4gICAqIEhhcmQgdGltZW91dCBpbiBzZWNvbmRzIGZvciB0aGUgQ0kgZml4IHBoYXNlIChJc3N1ZSAjMTgyNCkuXG4gICAqIFRoZSBmYWlsZWQgYW5ub3RhdGlvbiBzZXQgaXMgYm91bmRlZCDigJQgMzAgbWludXRlcyBpcyBnZW5lcm91cy5cbiAgICogRGlzdGluY3QgZnJvbSBgY2xhdWRlVGltZW91dGAgc28gcmVhY3RpdmUgcGhhc2VzIGRvIG5vdCBpbmhlcml0XG4gICAqIHRoZSBsYXJnZXIgaXNzdWUtd29yayBidWRnZXQuXG4gICAqL1xuICBjaUZpeFRpbWVvdXQ6IDE4MDAsXG4gIHF1ZXN0aW9uVGltZW91dDogNjAwLFxuICBxdWVzdGlvbktpbGxBZnRlcjogMTAsXG4gIGNsYXJpZmljYXRpb25UaW1lb3V0OiAxMjAsXG4gIGNsYXJpZmljYXRpb25LaWxsQWZ0ZXI6IDEwLFxuICAvKipcbiAgICogUnVuYXdheSBjZWlsaW5nIG9uIGdyaWxsLW1lIGNsYXJpZmljYXRpb24gcm91bmRzIChJc3N1ZSAjMTYxNiwgIzE5MzMpLlxuICAgKlxuICAgKiBOb3QgYSBwcm9kdWN0aXZpdHkgYnVkZ2V0OiBhIGdyaWxsaW5nIHN0b3BzIHdoZW4gdGhlIHN0YWxsIGd1YXJkIHNlZXMgYVxuICAgKiByb3VuZCByZXBlYXQgZXZlcnkgcXVlc3Rpb24gc3RlbSBpdCBoYWQgYWxyZWFkeSBhc2tlZCwgc28gdGhpcyBudW1iZXIgb25seVxuICAgKiBib3VuZHMgYSBncmlsbGluZyB0aGF0IGtlZXBzIGZpbmRpbmcgbmV3IHF1ZXN0aW9ucyBmb3JldmVyLiBUaGVcbiAgICogY2VpbGluZy10aCByb3VuZCBpcyBpdHNlbGYgdGhlIGZvcmNlZCBmaW5hbCByb3VuZCwgc28gYSBncmlsbGluZyBwb3N0cyBhdFxuICAgKiBtb3N0IHRoaXMgbWFueSByb3VuZHMgc2luY2UgaXRzIGxhdGVzdCBSZWFkeSBjb21tZW50LiBSYWlzZWQgZnJvbSA1IGJ5XG4gICAqIElzc3VlICMxOTMzLCB3aGVyZSBhIGZpdmUtcm91bmQgcHJvZHVjdGl2ZSBncmlsbGluZyB3YXMgaGFsdGVkIG1pZC1mbG93LlxuICAgKi9cbiAgbWF4R3JpbGxNZVJvdW5kczogMjAsXG4gIC8qKlxuICAgKiBUaW1lb3V0IGluIHNlY29uZHMgZm9yIGEgc2luZ2xlIGdyaWxsLW1lIHJvdW5kIChJc3N1ZSAjMTYxNikuXG4gICAqXG4gICAqIEdyaWxsLW1lIGlzIGFuIGFuYWx5c2lzIHBoYXNlLCBub3QgYSBjb2RlIGNoYW5nZSDigJQgYSByb3VuZCBtYXkgbmVlZCB0b1xuICAgKiBpbnZlc3RpZ2F0ZSB0aGUgY29kZWJhc2UsIHJ1biBhIGxpdmUgbW9kZWwgcHJvYmUgKGUuZy4gY29uZmlybSB0aGVcbiAgICogdG9wLXRpZXIgbW9kZWwgaXMgYWN0dWFsbHkgc2VydmVkKSwgYW5kIHJlYXNvbiBhdCBoaWdoIGVmZm9ydC4gVGhlIG9sZFxuICAgKiA2MDBzIGNlaWxpbmcgd2FzIGJvcnJvd2VkIGZyb20gdGhlIGxpZ2h0d2VpZ2h0IHF1ZXN0aW9uL2NsYXJpZmljYXRpb25cbiAgICogcGhhc2VzIGFuZCBzdGFydmVkIHRoYXQgd29yaywgc28gaGVhdnkgcm91bmRzIGRpZWQgYXQgXCJDbGF1ZGUgdGltZWQgb3V0XCJcbiAgICogYW5kIGVzY2FsYXRlZCB0byBgbmVlZHMtaHVtYW5gIChJc3N1ZSAjMzE1NCkuIEl0IG5vdyBtYXRjaGVzIHRoZVxuICAgKiBpc3N1ZS13b3JrIGJ1ZGdldCAoYGNsYXVkZVRpbWVvdXRgLCAxaCk7IHRoZSBwcm9jZXNzIGlzIGtpbGxlZCBhdCB0aGVcbiAgICogaG91ciByZWdhcmRsZXNzLCB3aGljaCBpcyB0aGUgaW50ZW5kZWQgc2FmZXR5IGNhcC5cbiAgICovXG4gIGdyaWxsTWVUaW1lb3V0OiAzNjAwLFxuICAvKiogR3JhY2UgcGVyaW9kIGluIHNlY29uZHMgYWZ0ZXIgZ3JpbGxNZVRpbWVvdXQgYmVmb3JlIGtpbGwgKElzc3VlICMxNjE2KS4gKi9cbiAgZ3JpbGxNZUtpbGxBZnRlcjogMTAsXG4gIC8qKlxuICAgKiBXYWxsLWNsb2NrIGJ1ZGdldCBpbiBzZWNvbmRzIGZvciAqKm9uZSoqIFF1b3J1bSBhZ2VudCAoSXNzdWUgIzQxMTIpLlxuICAgKlxuICAgKiBBIFF1b3J1bSBhZ2VudCBkcmFmdHMgKG9yIGp1ZGdlcykgYSBwbGFuLCB3aGljaCBpcyBwbGFubmluZy1zaGFwZWQgd29yayDigJRcbiAgICogc28gdGhlIGJ1ZGdldCBtYXRjaGVzIGBwbGFubmluZ1RpbWVvdXRgIHJhdGhlciB0aGFuIHRoZSBob3VyIGFuXG4gICAqIGltcGxlbWVudGF0aW9uIHJ1biBnZXRzLiBUaGUgdHdvIGRyYWZ0cyBydW4gY29uY3VycmVudGx5LCBzbyBhIHdob2xlIHJ1blxuICAgKiBjb3N0cyBvbmUgZHJhZnQgcGx1cyBvbmUganVkZ2VtZW50LCBub3QgdGhyZWUgc2VxdWVudGlhbCBidWRnZXRzLlxuICAgKi9cbiAgcXVvcnVtVGltZW91dDogMTgwMCxcbiAgLyoqIEdyYWNlIGluIHNlY29uZHMgYWZ0ZXIgcXVvcnVtVGltZW91dCBiZWZvcmUgdGhlIGFnZW50IGlzIGtpbGxlZCAoIzQxMTIpLiAqL1xuICBxdW9ydW1LaWxsQWZ0ZXI6IDEwLFxuICBtYXhSYXRlTGltaXRSZXRyaWVzOiAyLFxuICBtYXhSYXRlTGltaXRXYWl0OiA2MDAsXG4gIC8qKlxuICAgKiBPbmUgaG91ciBiZXR3ZWVuIGNvbGxhYm9yYXRvciByZWZyZXNoZXMgKElzc3VlICMxNDUzKS4gVGhlIG9wZXJhdG9yJ3NcbiAgICogc3RhdGVkIHRyYWRlLW9mZjogYSBuZXdseSBhZGRlZCB0ZWFtIG1lbWJlciBtYXkgd2FpdCBhbiBob3VyIG9yIHR3byB0b1xuICAgKiBiZSB0cnVzdGVkOyBpbiByZXR1cm4gdGhlIGZsZWV0IHN0b3BzIHNwZW5kaW5nIH4zMyBBUEkgY2FsbHMgcGVyIGN5Y2xlXG4gICAqIHBlciBob3N0IG9uIGEgc2V0IHRoYXQgY2hhbmdlcyBhIGZldyB0aW1lcyBhIHllYXIuXG4gICAqL1xuICB0cnVzdGVkQXV0aG9yc0NhY2hlSG91cnM6IDEsXG4gIHJldHJ5TWF4RGVsYXk6IDYwLFxuICBtYXhJc3N1ZUJvZHlUb2tlbnM6IDUwMDAwLFxuICBzdW1tYXJpc2VUaW1lb3V0OiAxMjAsXG4gIHN1bW1hcmlzZUtpbGxBZnRlcjogMTAsXG4gIGZlYXR1cmVDaGVja1RpbWVvdXQ6IDUsXG4gIC8vIElzc3VlICMxODI1OiBsb3dlcmVkIGZyb20gOTAwICgxNSBtaW4pIHRvIDYwMCAoMTAgbWluKS4gMTUgbWludXRlcyBvZlxuICAvLyBzaWxlbmNlIGlzIHRvbyBnZW5lcm91cyBmb3IgdW5hdHRlbmRlZCBzZWxmLWhlYWxpbmcg4oCUIHdlZGdlZCBDbGF1ZGVcbiAgLy8gcHJvY2Vzc2VzIG5lZWQgdGhlIHNpbGVuY2Ugd2F0Y2hkb2cgdG8ga2ljayBpbiBlYXJsaWVyLlxuICBjbGF1ZGVOb091dHB1dFRpbWVvdXQ6IDYwMCxcbiAgcXVhbGl0eUNoZWNrVGltZW91dDogNjAwLFxuICBjbGFpbUNodXJuVGhyZXNob2xkOiAzLFxuICBoZWFsdGhDYWNoZVR0bDogOTAwLFxuICBlbmFibGVNb2RlbEZhbGxiYWNrOiB0cnVlLFxuICBtaW5EaXNrU3BhY2VNYjogNTAwLFxuICBzeW5jTWlsZXN0b25lQnJhbmNoZXM6IHRydWUsXG4gIHJlcG9UaW1lb3V0VGhyZXNob2xkOiAzLFxuICAvKipcbiAgICogSXNzdWUgIzE5NTA6IGEgZmFpbGVkIHJ1biB1bmRlciBhIG1pbnV0ZSBuZXZlciByZWFjaGVkIHRoZSBhZ2VudCdzXG4gICAqIHdvcmsg4oCUIGl0IGRpZWQgY2xhaW1pbmcgb3Igc2V0dGluZyB1cC4gNjBzIHNlcGFyYXRlcyB0aGF0IGZyb20gYSBydW5cbiAgICogdGhlIGFnZW50IGdlbnVpbmVseSBzcGVudCBvbiB0aGUgaXNzdWUuXG4gICAqL1xuICBmYXN0RmFpbHVyZVNlY29uZHM6IDYwLFxuICAvKiogSXNzdWUgIzE5NTA6IGZhc3QgZmFpbHVyZXMgaW4gdGhlIHdpbmRvdyBiZWZvcmUgYSByZXBvIGlzIGJhY2tlZCBvZmYuICovXG4gIHJlcG9GYXN0RmFpbHVyZVRocmVzaG9sZDogMyxcbiAgLyoqIElzc3VlICMxOTUwOiB0aGUgcm9sbGluZyB3aW5kb3csIGFuZCB0aGUgZGVjYXkgcGVyaW9kLCBpbiBob3Vycy4gKi9cbiAgcmVwb0Zhc3RGYWlsdXJlV2luZG93SG91cnM6IDI0LFxuICBzdGFsZUZhaWxlZERpYWdub3N0aWNEYXlzOiAzLFxuICBzdGFsZVBsYW5uaW5nV2FybmluZ0RheXM6IDIsXG4gIGluY2x1ZGVSZWNlbnRBY3Rpdml0eTogdHJ1ZSxcbiAgcmVjZW50QWN0aXZpdHlNZXJnZWRQckxpbWl0OiAxMCxcbiAgcmVjZW50QWN0aXZpdHlDb21taXRMaW1pdDogMjAsXG4gIHJlY2VudEFjdGl2aXR5TWF4VG9rZW5zOiAxMDAwLFxuICByZWNlbnRBY3Rpdml0eUNhY2hlVHRsU2Vjb25kczogMzAwLFxuICAvKipcbiAgICogSW5qZWN0IHRoZSBnZW5lcmF0ZWQgcGVyLXJlcG8gY29kZWJhc2UgbWFwIGludG8gaXNzdWUgcHJvbXB0c1xuICAgKiAoSXNzdWUgIzQyODEpLiBPbiBieSBkZWZhdWx0OiB3aXRob3V0IGl0IGV2ZXJ5IHNlc3Npb24gcGF5cyBhXG4gICAqIHJlZGlzY292ZXJ5IHRheCBiZWZvcmUgaXQgY2FuIHN0YXJ0IHdvcmsuXG4gICAqL1xuICBpbmNsdWRlQ29kZWJhc2VNYXA6IHRydWUsXG4gIC8qKlxuICAgKiBHcmFmdCByZXBvLWNvbnRleHQgaW5qZWN0aW9uIChJc3N1ZSAjMjA5OCwgcGFydCBvZiAjMjA2MCkuIE9mZjogYSBob3N0XG4gICAqIHRoYXQgbmV2ZXIgd3JpdGVzIHRoZSBgZ3JhZnRfY29udGV4dGAgYmxvY2sgYmVoYXZlcyBleGFjdGx5IGFzIHRvZGF5LFxuICAgKiBhbmQgdGhlIG9wZXJhdG9yIHR1cm5zIGl0IG9uIHBlciBob3N0IGZvciB0aGUgIzIwNjAgdHJpYWwuXG4gICAqL1xuICBncmFmdENvbnRleHQ6IGdyYWZ0Q29udGV4dE9mZigpLFxuICAvKipcbiAgICogVGhlIENvZGVHcmFwaCByZXBvLWNvbnRleHQgc3dpdGNoIChJc3N1ZSAjMjE1NCwgcGFydCBvZiAjMjE0NSkuIE9mZiBieVxuICAgKiBkZWZhdWx0OiB0dXJuaW5nIGl0IG9uIGFkZHMgYW4gaW5kZXggc3RlcCBhdCBydW4gc3RhcnQgYW5kIGEgYGNvZGVncmFwaGBcbiAgICogTUNQIGVudHJ5LCBzbyBhIGhvc3Qgb3B0cyBpbiByYXRoZXIgdGhhbiBpbmhlcml0cyBpdC5cbiAgICovXG4gIGNvZGVncmFwaENvbnRleHQ6IHsgZW5hYmxlZDogZmFsc2UgfSxcbiAgLyoqXG4gICAqIFRoZSBSVEsgb3V0cHV0IHN3aXRjaCAoSXNzdWUgIzIzODAsIHBhcnQgb2YgIzIzMjgpLiBPbiBieSBkZWZhdWx0IHNpbmNlXG4gICAqIElzc3VlICMyNDMyIOKAlCB0aGUgb3duZXIncyBkZWNpc2lvbiBvbmNlIGl0IHdhcyBzZWVuIHRvIGZ1bmN0aW9uIGluIGEgbGl2ZVxuICAgKiBydW4sIG5vdCBhIHZlcmRpY3Qgb24gdGhlIHRyaWFsJ3MgdG9rZW4gYmFyLiBJdCBhZGRzIGEgYFByZVRvb2xVc2VgIEJhc2hcbiAgICogcmV3cml0ZSBob29rIGFuZCBhIHByb21wdCBsaW5lIHRvIHRoZSB3aXJlZCBDbGF1ZGUgc3Bhd25zOyBhIGhvc3QgdGhhdFxuICAgKiB3YW50cyB0aGUgcmF3IG91dHB1dCBiYWNrIHNldHMgYHJ0a19vdXRwdXQuZW5hYmxlZGAgdG8gYGZhbHNlYC5cbiAgICovXG4gIHJ0a091dHB1dDogeyBlbmFibGVkOiB0cnVlIH0sXG4gIC8qKlxuICAgKiBUVEwgaW4gc2Vjb25kcyBmb3IgdGhlIGlzc3VlLXRpbWVsaW5lIGNhY2hlIHVzZWQgYnkgbGFiZWwtYXV0aG9yXG4gICAqIGNoZWNrcyAoSXNzdWUgIzE2NzMpLiBEZWZhdWx0cyB0byA1IG1pbnV0ZXMg4oCUIHNob3J0ZXIgdGhhbiB0aGVcbiAgICogMTAtbWludXRlIGlzc3VlcyBUVEwgYmVjYXVzZSB0aW1lbGluZXMgbXV0YXRlIHdoZW4gbGFiZWxzIGFyZVxuICAgKiByZS1hcHBsaWVkLiBUaGUgd29ya2VyIGludmFsaWRhdGVzIHRoZSBlbnRyeSB3aGVuZXZlciBpdCBhZGRzIGFcbiAgICogbGFiZWwgaXRzZWxmLlxuICAgKi9cbiAgdGltZWxpbmVDYWNoZVR0bFNlY29uZHM6IDMwMCxcbiAgLyoqXG4gICAqIENMSS1sZXZlbCBzZXNzaW9uIGNvbnRpbnVpdHkgKElzc3VlICMyMzM5KS4gT24gYnkgZGVmYXVsdDogdGhlIHN0cmVhbVxuICAgKiBtYWNoaW5lcnkgKElzc3VlcyAjMjMzM+KAkyMyMzM4KSBpcyBpbiBwbGFjZSwgc28gYW4gdW5jb25maWd1cmVkIGhvc3QgcnVuc1xuICAgKiBvbmUgY29udmVyc2F0aW9uIHBlciAocmVwb3NpdG9yeSwgbWlsZXN0b25lKSBwbHVzIG9uZSBibGFuayBzdHJlYW0gcGVyXG4gICAqIHJlcG9zaXRvcnksIHRha2VzIHRoZSBzdHJlYW0gbG9ja3MsIGFuZCBjb21wYWN0cyB0aGUgY29udmVyc2F0aW9uIGJlZm9yZVxuICAgKiBlYWNoIG5ldyBpc3N1ZS4gU2V0dGluZyBgZW5hYmxlX3Nlc3Npb25fcmVzdW1lOiBmYWxzZWAgcmV0dXJucyB0aGUgaG9zdFxuICAgKiB0byBwZXItaXNzdWUgc2Vzc2lvbnMgd2l0aCBubyBzdHJlYW0gbG9jazsgdGhlIG1pbGVzdG9uZS1jbG9zZVxuICAgKiBob3VzZWtlZXBpbmcgc3dlZXAgcnVucyBlaXRoZXIgd2F5LlxuICAgKi9cbiAgZW5hYmxlU2Vzc2lvblJlc3VtZTogdHJ1ZSxcbiAgLyoqXG4gICAqIFdoZXRoZXIgYGlzc3VlYC1waGFzZSBydW5zIHVzZSB0aGUgc3BsaXQgZXhlY3V0b3IgKElzc3VlICMyMzQxKTogdGhlXG4gICAqIG1hbmFnZXIgcGxhbnMgYW5kIGRpc3BhdGNoZXMgc3ViLWFnZW50IGV4ZWN1dG9ycyB0aGF0IGVkaXQsIG9uIHRoZVxuICAgKiBzdWItYWdlbnQgdGllciAoYGlzc3VlX3N1Yl9hZ2VudF90aWVyYCwgSGFpa3UgYnkgZGVmYXVsdCwgSXNzdWUgIzM0MDIpLiBPblxuICAgKiBieSBkZWZhdWx0IHNpbmNlIElzc3VlICMyODEyOyBgaXNzdWVfZXhlY3V0b3Jfc3BsaXQ6IGZhbHNlYCBvcHRzIG91dC5cbiAgICovXG4gIGlzc3VlRXhlY3V0b3JTcGxpdDogdHJ1ZSxcbiAgLyoqXG4gICAqIE1vZGVsIHRpZXIgb2YgdGhlIGBpc3N1ZWAtcGhhc2UgZXhlY3V0b3IgYW5kIFN0YW5kYXJkcyByZXZpZXdlclxuICAgKiBzdWItYWdlbnRzLCBhbmQgd2hldGhlciB0aGUgcmVhZC1vbmx5IGBleHBsb3JlcmAgcmlkZXMgdGhlIHJ1blxuICAgKiAoSXNzdWVzICMzNDAxLCAjMzQwMikuIFJlc29sdmVkIHBlciByZXBvIGJ5XG4gICAqIGByZXNvbHZlSXNzdWVTdWJBZ2VudFRpZXJgIGFuZCBjb25zdW1lZCBieSBgYnVpbGRJc3N1ZVJ1bkFnZW50c2BcbiAgICogaW4gYGlzc3VlX2V4ZWN1dG9yX2FnZW50cy50c2AuIEVhY2ggYGlzc3VlYCBydW4gYWxzbyByZWNvcmRzIHRoZVxuICAgKiByZXNvbHZlZCB0aWVyIGluIGZsZWV0IHRlbGVtZXRyeSAocGVyLXRpZXIgcnVucyBhbmQgVVNEKSBhbmQgc3RhbXBzIGl0XG4gICAqIG9uIHRoZSBQUiBib2R5IGFzIGEgYHZpYmUtc3ViLWFnZW50LXRpZXJgIG1hcmtlciAoSXNzdWUgIzM0MDMpLlxuICAgKi9cbiAgaXNzdWVTdWJBZ2VudFRpZXI6IFwiaGFpa3VcIiBhcyBJc3N1ZVN1YkFnZW50VGllcixcbiAgLyoqXG4gICAqIFdoZXRoZXIgYGlzc3VlYC1waGFzZSBydW5zIGRpc3BhdGNoIHRoZSBTcGVjIGFuZCBTdGFuZGFyZHMgcmV2aWV3ZXJzIGFzXG4gICAqIGRlZmluZWQgY2hlYXBlciBzdWItYWdlbnRzIChJc3N1ZSAjMjU3NSkuIE9uIGJ5IGRlZmF1bHQgKElzc3VlICMyODEyKTtcbiAgICogYGlzc3VlX3Jldmlld2VyX2FnZW50czogZmFsc2VgIG9wdHMgb3V0LCBhbmQgdGhleSBpbmhlcml0IHRoZSBwaGFzZSBtb2RlbC5cbiAgICovXG4gIGlzc3VlUmV2aWV3ZXJBZ2VudHM6IHRydWUsXG4gIC8qKlxuICAgKiBXaGV0aGVyIGBpc3N1ZWAtcGhhc2UgcnVucyBnbyB0aHJvdWdoIHRoZSBleHRlcm5hbCBvcmNoZXN0cmF0b3IgKElzc3VlXG4gICAqICMzNjQyKSBpbnN0ZWFkIG9mIENsYXVkZS1uYXRpdmUgYC0tYWdlbnRzYC4gT2ZmIGJ5IGRlZmF1bHQ7XG4gICAqIGBleHRlcm5hbF9vcmNoZXN0cmF0aW9uOiB0cnVlYCBvcHRzIGluLiBIb3N0LXdpZGUgb25seS5cbiAgICovXG4gIGV4dGVybmFsT3JjaGVzdHJhdGlvbjogZmFsc2UsXG4gIC8qKlxuICAgKiBPcHRpb25hbCBwcm92aWRlciwgbW9kZWwsIGVmZm9ydCBhbmQgYm91bmRzIGZvciB0aGUgb3JjaGVzdHJhdGVkIHBhdGhcbiAgICogKElzc3VlICMzNjQyKS4gRW1wdHkgYnkgZGVmYXVsdCwgc28gdGhlIGJ1aWx0LWluIHJvbGUgZGVmYXVsdHMgYXBwbHkuXG4gICAqL1xuICBleHRlcm5hbE9yY2hlc3RyYXRpb25TZXR0aW5nczoge30gYXMgRXh0ZXJuYWxPcmNoZXN0cmF0aW9uU2V0dGluZ3MsXG4gIC8qKiBNYXhpbXVtIHNlc3Npb24gc3RvcmUgc2l6ZSBpbiBieXRlcyBiZWZvcmUgY29tcGFjdGlvbiAoNTAgTUIpIChJc3N1ZSAjMTMyOCkuICovXG4gIG1heFNlc3Npb25TaXplQnl0ZXM6IDUwICogMTAyNCAqIDEwMjQsXG4gIC8qKiBNYXhpbXVtIHNlc3Npb24gYWdlIGluIGRheXMgYmVmb3JlIGNsZWFudXAgKElzc3VlICMxMzI4KS4gKi9cbiAgbWF4U2Vzc2lvbkFnZURheXM6IDcsXG4gIGNvbnRleHRCdWRnZXRXYXJuaW5nUGVyY2VudDogNTAsXG4gIGNvbnRleHRCdWRnZXRFcnJvclBlcmNlbnQ6IDgwLFxuICAvKipcbiAgICogSGFyZCBjb250ZXh0LWJ1ZGdldCBjZWlsaW5nIGFzIGEgcGVyY2VudGFnZSAoSXNzdWUgIzM3MTMpLiBBdCBvciBhYm92ZVxuICAgKiB0aGlzIHVzYWdlIHRoZSBleGVjdXRpb24gcGhhc2Ugc3RvcHMgYW5kIGVzY2FsYXRlcyBpbnN0ZWFkIG9mIHNlbmRpbmcgYVxuICAgKiBwcm9tcHQgdGhlIG1vZGVsIHdvdWxkIHRydW5jYXRlLiBgMGAgZGlzYWJsZXMgdGhlIGNlaWxpbmcuXG4gICAqL1xuICBjb250ZXh0QnVkZ2V0QmxvY2tQZXJjZW50OiA5NSxcbiAgLyoqIE1heGltdW0gdG90YWwgY2hhcmFjdGVycyBhY3Jvc3MgYWxsIGNvbW1lbnRzIGluY2x1ZGVkIGluIHRoZSBwcm9tcHQgKElzc3VlICMxMzQyKS4gKi9cbiAgbWF4VG90YWxDb21tZW50Q2hhcnM6IDIwXzAwMCxcbiAgLyoqIE1heGltdW0gY2hhcmFjdGVycyBwZXIgdW50cnVzdGVkIGNvbW1lbnQgYmVmb3JlIHRydW5jYXRpb24gKElzc3VlICMxMzQyKS4gKi9cbiAgbWF4VW50cnVzdGVkQ29tbWVudENoYXJzOiAyXzAwMCxcbiAgLyoqIE1heGltdW0gbnVtYmVyIG9mIHVudHJ1c3RlZCBjb21tZW50cyB0byBpbmNsdWRlIGluIHRoZSBwcm9tcHQgKElzc3VlICMxMzQyKS4gKi9cbiAgbWF4VW50cnVzdGVkQ29tbWVudENvdW50OiA1LFxuICAvKiogVGhyZXNob2xkIG9mIHVudHJ1c3RlZCBjb21tZW50cyB0aGF0IHRyaWdnZXJzIGEgZmxvb2QgYXVkaXQgZXZlbnQgKElzc3VlICMxMzQyKS4gKi9cbiAgY29tbWVudEZsb29kVGhyZXNob2xkOiAxMCxcbiAgLyoqXG4gICAqIFdoZXRoZXIgdG8gaW5jbHVkZSB1bnRydXN0ZWQgY29tbWVudHMgaW4gdGhlIHByb21wdCAoSXNzdWUgIzEzNDApLlxuICAgKiAtIGB0cnVlYCAoZGVmYXVsdCk6IGluY2x1ZGUgd2l0aCB0cnVzdC1sZXZlbCBhbm5vdGF0aW9ucyAoZGVmZW5jZSBpbiBkZXB0aClcbiAgICogLSBgZmFsc2VgIChzdHJpY3QgbW9kZSk6IGV4Y2x1ZGUgdW50cnVzdGVkIGNvbW1lbnRzIGVudGlyZWx5XG4gICAqL1xuICBpbmNsdWRlVW50cnVzdGVkQ29tbWVudHM6IHRydWUsXG4gIC8qKlxuICAgKiBDb29sZG93biBpbiBzZWNvbmRzIGJlZm9yZSBhbiBpc3N1ZSB3aXRoIGEgcmVjZW50bHktY2xvc2VkIFBSIGNhbiBiZVxuICAgKiBwaWNrZWQgdXAgYWdhaW4gKElzc3VlICMxNDI3KS4gUHJldmVudHMgY3JlYXRpbmcgZHVwbGljYXRlIFBScyBmb3IgdGhlXG4gICAqIHNhbWUgaXNzdWUgd2hlbiB0aGUgcHJldmlvdXMgUFIgd2FzIGNsb3NlZCB3aXRob3V0IG1lcmdlLlxuICAgKi9cbiAgY2xvc2VkUHJDb29sZG93blNlY29uZHM6IDM2MDAsXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIHVuYXNzaWduIHRoZSB3b3JrZXIgZnJvbSB0aGUgc291cmNlIGlzc3VlIGltbWVkaWF0ZWx5IGFmdGVyXG4gICAqIGEgc3VjY2Vzc2Z1bCBQUiBjcmVhdGlvbiAoSXNzdWUgIzE0NTMpLiBUaGlzIHJlbW92ZXMgdGhlXG4gICAqIFwiYXNzaWduZWQgKyBubyBoZWFydGJlYXRcIiBzdGF0ZSB0aGF0IHRyaWdnZXJzIGZhbHNlLXBvc2l0aXZlIHJlY292ZXJpZXNcbiAgICogaW4gYGRldGVjdEFzc2lnbmVkV2l0aG91dEhlYXJ0YmVhdGAuIERlZmF1bHRzIHRvIGB0cnVlYC5cbiAgICovXG4gIHVuYXNzaWduT25QckNyZWF0ZWQ6IHRydWUsXG4gIC8qKlxuICAgKiBBZ2UgdGhyZXNob2xkIGluIGRheXMgYmVmb3JlIGEgcmVwbyB3b3JrIGRpcmVjdG9yeSB3aXRoIG5vIGhlYXJ0YmVhdFxuICAgKiBpcyBjbGFzc2lmaWVkIGFzIHN0YWxlIGFuZCByZW1vdmVkIChJc3N1ZSAjMTQ5MykuIERlZmF1bHRzIHRvIDcgZGF5cy5cbiAgICovXG4gIHN0YWxlV29ya0RpckRheXM6IDcsXG4gIC8qKlxuICAgKiBNYXhpbXVtIHJldHJ5IGF0dGVtcHRzIGZvciBhIHNpbmdsZSBzb2Z0d2FyZSB1cGRhdGUgY29tbWFuZCAoSXNzdWUgIzE0OTYpLlxuICAgKiBEZWZhdWx0cyB0byAzIHNvIHRyYW5zaWVudCBmYWlsdXJlcyBzZWxmLWhlYWwgd2l0aG91dCBkcm9wcGluZyB0aGVcbiAgICogd2Vla2x5IHVwZGF0ZSBlbnRpcmVseS5cbiAgICovXG4gIHVwZGF0ZVJldHJ5TWF4QXR0ZW1wdHM6IDMsXG4gIC8qKlxuICAgKiBFeHBvbmVudGlhbCBiYWNrb2ZmIGRlbGF5cyBpbiBzZWNvbmRzIGJldHdlZW4gc29mdHdhcmUgdXBkYXRlIHJldHJpZXNcbiAgICogKElzc3VlICMxNDk2KS4gVGhlIGktdGggZW50cnkgaXMgdGhlIGRlbGF5IEFGVEVSIGF0dGVtcHQgaSsxIGZhaWxlZC5cbiAgICogRGVmYXVsdHMgdG8gWzMwLCA5MCwgMzAwXSDigJQgZ2VudGxlIGZvciBmbGFreSBtaXJyb3JzLCBzaG9ydCBlbm91Z2ggdG9cbiAgICogY29tcGxldGUgaW5zaWRlIHRoZSB3ZWVrbHkgdXBkYXRlIHdpbmRvdy5cbiAgICovXG4gIHVwZGF0ZVJldHJ5QmFja29mZlNlY29uZHM6IFszMCwgOTAsIDMwMF0gYXMgcmVhZG9ubHkgbnVtYmVyW10sXG4gIC8qKlxuICAgKiBQZXItdG9vbCBtaW5pbXVtIHZlcnNpb24gZmxvb3JzIGZvciBzb2Z0d2FyZSBhdXRvLXVwZGF0ZSAoSXNzdWUgIzI2MjIpLlxuICAgKiBXaGVuIHRoZSBpbnN0YWxsZWQgdmVyc2lvbiBvZiBhIHRvb2wgaXMgYmVsb3cgaXRzIGZsb29yLCB0aGUgdXBkYXRlIHJ1bnNcbiAgICogaW1tZWRpYXRlbHksIGJ5cGFzc2luZyB0aGUgNy1kYXkgaW50ZXJ2YWwgZ2F0ZS4gR2VuZXJpYyBwZXItdG9vbCBtYXAgc29cbiAgICogZ2gvZGVubyBmbG9vcnMgY2FuIGJlIGFkZGVkIGxhdGVyOyBlbXB0eSBmb3IgdG9vbHMgd2l0aG91dCBhIGZsb29yLlxuICAgKlxuICAgKiBgY2xhdWRlYCBpcyBwaW5uZWQgdG8gMi4xLjI5MyAoUFIgIzM0MzIgcmV2aWV3LCBJc3N1ZSAjMzQwMCkg4oCUIHRoZSBvbGRlc3RcbiAgICogcmVsZWFzZSB3aG9zZSBidW5kbGVkIGFsaWFzIHRhYmxlIHJlc29sdmVzIGBoYWlrdWAgdG8gSGFpa3UgNS41XG4gICAqIChgY2xhdWRlLWhhaWt1LTUtNWApLCB0aGUgbW9kZWwgYE1PREVMX0NPTlRFWFRfV0lORE9XUy5oYWlrdWAncyAxTSB3aW5kb3dcbiAgICogYXNzdW1lcy4gSXQgd2FzIDIuMS4yODAgKElzc3VlICMyNTYwKSwgdGhlIG9sZGVzdCByZWxlYXNlIHJlc29sdmluZyBgb3B1c2BcbiAgICogdG8gT3B1cyA1LjU7IDIuMS4yOTMgaXMgYWJvdmUgdGhhdCwgc28gYW4gT3B1cy0gb3IgRmFibGUtcGlubmVkIHBoYXNlIGtlZXBzXG4gICAqIGl0cyBvd24gZ2VuZXJhdGlvbiB0b28uIFRoZSBDTEkgcmVzb2x2ZXMgZWFjaCBhbGlhcyBmcm9tIGl0cyBvd24gYnVuZGxlZFxuICAgKiB0YWJsZSwgc28gdGhpcyBmbG9vciBkZWNpZGVzIHdoaWNoIGdlbmVyYXRpb24gdGhlIHBoYXNlcyBhcmUgc2VydmVkOyB0aGVcbiAgICogcGVyLXZlcnNpb24gZXZpZGVuY2UgaXMgaW5cbiAgICogYGRvY3MvTU9ERUwtQU5ELUNBQ0hJTkcubWQjd2hpY2gtY2xpLXZlcnNpb24tYWN0dWFsbHktc2VydmVzLTUxLWlzc3VlLTEzNjJgLlxuICAgKi9cbiAgc29mdHdhcmVNaW5WZXJzaW9uczogeyBjbGF1ZGU6IFwiMi4xLjI5M1wiIH0gYXMgUmVhZG9ubHk8XG4gICAgUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuICA+LFxuICAvKipcbiAgICogV2hldGhlciB0aGUgd29ya2VyJ3MgcXVhbGl0eSBnYXRlIHNob3VsZCB0cmVhdCB0aGUgcG9zdC1DbGF1ZGUgcnVuIGFzXG4gICAqIHBhc3NlZCB3aGVuIGV2ZXJ5IGN1cnJlbnQgZGlmZmFibGUgZmluZGluZyAobWVybWFpZCwgbWFya2Rvd25saW50LFxuICAgKiBkb2NzIHByb21wdC12ZXJzaW9uKSB3YXMgYWxyZWFkeSBwcmVzZW50IGF0IGJhc2VsaW5lIChJc3N1ZSAjMTU0OSxcbiAgICogZ2VuZXJhbGlzZWQgYnkgIzI2MDQpLiBXaGVuIHRydWUsIGEgZmFpbGluZyBwb3N0LUNsYXVkZSBxdWFsaXR5IHJ1blxuICAgKiBpcyBjb21wYXJlZCBhZ2FpbnN0IHRoZSBiYXNlbGluZSBmaW5kaW5nIHNldCBjYXB0dXJlZCBiZWZvcmUgQ2xhdWRlXG4gICAqIHN0YXJ0ZWQ7IGlmIG5vIG5ldyBmaW5kaW5ncyB3ZXJlIGludHJvZHVjZWQgdGhlIGdhdGUgaXMgdHJlYXRlZCBhc1xuICAgKiBwYXNzZWQuIFdoZW4gZmFsc2UsIGFueSBmYWlsaW5nIHJ1biBjb25zdW1lcyBhIGBmYWlsZWQtb25jZWAgYXR0ZW1wdFxuICAgKiByZWdhcmRsZXNzIG9mIHRoZSBiYXNlbGluZS4gRGVmYXVsdHMgdG8gYHRydWVgLiBQZXItcmVwbyBvdmVycmlkZSBpc1xuICAgKiBob25vdXJlZCB2aWEgYHJlcG9Db25maWdbcmVwb10uYmFzZWxpbmVBd2FyZVF1YWxpdHlHYXRlYC5cbiAgICovXG4gIGJhc2VsaW5lQXdhcmVRdWFsaXR5R2F0ZTogdHJ1ZSxcbiAgLyoqXG4gICAqIEJhY2tvZmYgaW4gbWlsbGlzZWNvbmRzIGJlZm9yZSBhbiBpbi1wcm9jZXNzIHJldHJ5IG9mIGFuXG4gICAqIGluZnJhc3RydWN0dXJlLWNhdGVnb3J5IHBoYXNlIGZhaWx1cmUgKElzc3VlICMxNTUwKS4gRGVmYXVsdHMgdG8gMTVzIOKAlFxuICAgKiBnaXZlcyB0cmFuc2llbnQgZW52aXJvbm1lbnQgYmxpcHMgKHJhdGUgbGltaXRzLCB6ZXJvLW91dHB1dCwgcHVzaFxuICAgKiByZWplY3Rpb24pIGEgY2hhbmNlIHRvIGNsZWFyIGJlZm9yZSBhcHBseWluZyB0aGUgYGZhaWxlZC1vbmNlYCBsYWJlbC5cbiAgICovXG4gIGluZnJhUmV0cnlCYWNrb2ZmTXM6IDE1XzAwMCxcbiAgLyoqXG4gICAqIE1heGltdW0gYXV0b21hdGljIGZpeCBhdHRlbXB0cyBwZXIgZmFpbHVyZSBzaWduYXR1cmUgYmVmb3JlIHRoZSB3b3JrZXJcbiAgICogc3RvcHMgYW5kIGVzY2FsYXRlcyB3aXRoIGBuZWVkcy1odW1hbmAgKElzc3VlICMzNTgyKS4gQ291bnRlZCBhZ2FpbnN0IGFcbiAgICogc2lnbmF0dXJlIHRoYXQgc3Vydml2ZXMgcHVzaGVzLCBzbyB0aHJlZSBhdHRlbXB0ZWQgZml4ZXMgb24gb25lIGZhaWx1cmVcbiAgICogZXhoYXVzdCB0aGUgYnVkZ2V0LiBgaW5mcmFzdHJ1Y3R1cmVgLWNhdGVnb3J5IGZhaWx1cmVzIGRvIG5vdCBjb25zdW1lIGFuXG4gICAqIGF0dGVtcHQuIFBlci1yZXBvIG92ZXJyaWRlOiBgcmVwb0NvbmZpZ1tyZXBvXS5tYXhBdXRvRml4QXR0ZW1wdHNgLlxuICAgKi9cbiAgbWF4QXV0b0ZpeEF0dGVtcHRzOiAzLFxufSBhcyBjb25zdDtcblxuLyoqXG4gKiBEZWZhdWx0IGxpc3Qgb2YgdHJ1c3RlZCBQUiByZXZpZXcgYm90IGFjY291bnRzIChJc3N1ZSAjMTg1NikuXG4gKlxuICogQm90cyBpbiB0aGlzIGxpc3QgaGF2ZSB0aGVpciAqKlBSIHJldmlldyBjb21tZW50cyoqIChsaW5lLWxldmVsXG4gKiBjb21tZW50cyBvbiBgL3B1bGxzL3tufS9jb21tZW50c2ApIGF1dG8tdHJ1c3RlZCBieSB0aGUgUFIgZmVlZGJhY2tcbiAqIHdvcmtlciB3aXRob3V0IHJlcXVpcmluZyBhIHRodW1icy11cCByZWFjdGlvbiBvciBtZW1iZXJzaGlwIGluXG4gKiBgYXV0aG9yaXNlZENvbW1lbnRlcnNgLiBJc3N1ZSBjb21tZW50cyAodG9wLWxldmVsIGRpc2N1c3Npb24pIGFyZVxuICogTk9UIGF1dG8tdHJ1c3RlZCBieSB0aGlzIGxpc3Qg4oCUIHRoZXkgc3RpbGwgcmVxdWlyZSBhIHRodW1icy11cCBvclxuICogYGF1dGhvcmlzZWRDb21tZW50ZXJzYCBtZW1iZXJzaGlwLlxuICpcbiAqIE5hbWVzIGFyZSBjYXNlLXNlbnNpdGl2ZSBleGFjdCBHaXRIdWIgdXNlcm5hbWVzLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9UUlVTVEVEX1JFVklFV19CT1RTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgXCJnaXRodWItY29kZS1xdWFsaXR5W2JvdF1cIixcbiAgXCJjb2RlcmFiYml0YWlbYm90XVwiLFxuICBcInNvbmFyY2xvdWRbYm90XVwiLFxuICBcImRlZXBzb3VyY2UtaW9bYm90XVwiLFxuICBcImNvZGVjbGltYXRlW2JvdF1cIixcbl0gYXMgY29uc3Q7XG5cbi8qKlxuICogRGVmYXVsdCBgYXV0aG9yaXplZF9jb21tZW50ZXJzYCDigJQgdGhlIGtub3duIGJvdHMgd2hvc2UgaW5wdXQgdGhlIHdvcmtlclxuICogYWN0cyBvbiAoSXNzdWUgIzEwNjYpLlxuICpcbiAqIFRydXN0IGZvciAqKmRpcmVjdGluZyoqIHdvcmsgaXMgZGVyaXZlZCBmcm9tIHJlcG9zaXRvcnkgcGVybWlzc2lvbnMsIGFuZCBhXG4gKiBHaXRIdWIgQXBwIGlzIG5ldmVyIGEgcmVwb3NpdG9yeSBjb2xsYWJvcmF0b3I6IENvcGlsb3QncyByZXZpZXdzIGFuZCB0aGVcbiAqIEFjdGlvbnMgYm90J3MgcmVzdWx0cyB3b3VsZCBzaWxlbnRseSBzdG9wIGJlaW5nIHByb2Nlc3NlZCB1bmRlciBhIHB1cmVcbiAqIGBoYXNXcml0ZUFjY2Vzc2AgcnVsZS4gVGhleSBhcmUgYSB0aGlyZCBjYXRlZ29yeSB0aGUgb25lLXNlbnRlbmNlIHJ1bGUgZG9lc1xuICogbm90IGNvdmVyIOKAlCBuZWl0aGVyIGh1bWFucyB3aXRoIHdyaXRlIGFjY2VzcyBub3IgVmliZSBDb2RlcnMg4oCUIHNvIHRoZXkgYXJlXG4gKiB0cnVzdGVkIGJlY2F1c2UgdGhleSBhcmUgKm5hbWVkKiwgYW5kIG5hbWVkIG9ubHkgZm9yIGlucHV0LlxuICpcbiAqIEFwcGxpZWQgb25seSB3aGVuIGBhdXRob3JpemVkX2NvbW1lbnRlcnNgIGlzIGFic2VudCBmcm9tIGAuY29uZmlnLmpzb25gLFxuICogc28gYW4gb3BlcmF0b3Igd2hvIHNldHMgdGhlIGtleSBrZWVwcyBleGFjdGx5IHdoYXQgdGhleSB3cm90ZSDigJQgaW5jbHVkaW5nXG4gKiBhbiBlbXB0eSBsaXN0LCB3aGljaCBkZW5pZXMgZXZlcnkgYm90LlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9UUlVTVEVEX0lOUFVUX0JPVFM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1xuICBcImdpdGh1Yi1jb3BpbG90W2JvdF1cIixcbiAgXCJnaXRodWItYWN0aW9uc1tib3RdXCIsXG5dIGFzIGNvbnN0O1xuXG4vKipcbiAqIEBkZXByZWNhdGVkIFVzZSBPUEVSQVRJT05BTF9ERUZBVUxUUyBpbnN0ZWFkIChJc3N1ZSAjMjc3KS5cbiAqIEtlcHQgZm9yIGJhY2t3YXJkIGNvbXBhdGliaWxpdHkgd2l0aCBleGlzdGluZyBjb2RlLlxuICovXG5leHBvcnQgY29uc3QgTlVNRVJJQ19ERUZBVUxUUyA9IHtcbiAgY2xhdWRlVGltZW91dDogT1BFUkFUSU9OQUxfREVGQVVMVFMuY2xhdWRlVGltZW91dCxcbiAgbWF4Q2xhcmlmaWNhdGlvblJvdW5kczogT1BFUkFUSU9OQUxfREVGQVVMVFMubWF4Q2xhcmlmaWNhdGlvblJvdW5kcyxcbn0gYXMgY29uc3Q7XG5cbi8qKlxuICogRGVmYXVsdCB3b3JrZXJfbmFtZSBzZXR0aW5nIChJc3N1ZSAjNDM2KS5cbiAqIFdoZW4gZW1wdHkgKGRlZmF1bHQpLCBmYWxscyBiYWNrIHRvIHRoZSBHaXRIdWIgdXNlcm5hbWUuXG4gKiBXaGVuIHNldCwgYXBwZWFycyBpbiBpc3N1ZSBjb21tZW50cyBhbmQgUFIgZGVzY3JpcHRpb25zIGZvclxuICogbXVsdGktd29ya2VyIHZpc2liaWxpdHkuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1dPUktFUl9OQU1FID0gXCJcIiBhcyBjb25zdDtcblxuLyoqXG4gKiBEZWZhdWx0IHNodWZmbGVfcmVwb3Mgc2V0dGluZyAoSXNzdWUgIzQzNSkuXG4gKiBXaGVuIHRydWUgKGRlZmF1bHQpLCByZXBvcyBhcmUgc2h1ZmZsZWQgdG8gcHJldmVudCBzdGFydmF0aW9uLlxuICogV2hlbiBmYWxzZSwgcmVwb3MgYXJlIHNjYW5uZWQgaW4gY29uZmlndXJlZCBvcmRlciBmb3IgcGVyLXdvcmtlciBwcmlvcml0eS5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU0hVRkZMRV9SRVBPUyA9IHRydWUgYXMgY29uc3Q7XG5cbi8qKlxuICogRXZlcnkgdXBkYXRlIG1vZGUgYSBob3N0IG1heSBiZSBjb25maWd1cmVkIHdpdGggKElzc3VlICM2MjIsIHBhcnQgb2YgIzU4MykuXG4gKlxuICogYGR5bmFtaWNgIHRyYWNrcyB0aGUgbGF0ZXN0IFZpYmUgQ29kZXI7IGBmcm96ZW5gIGhvbGRzIHRoZSBob3N0IGF0IGEgcGlubmVkXG4gKiBjaGVja291dCBhbmQgcGlubmVkIHRvb2wgdmVyc2lvbnMuIE5hbWVkIGhlcmUgc28gdGhlIHZhbGlkYXRvciBjYW4gbGlzdCB0aGVcbiAqIGFjY2VwdGVkIHZhbHVlcyBpbiBpdHMgZmFpbC1sb3VkIG1lc3NhZ2UuXG4gKi9cbmV4cG9ydCBjb25zdCBVUERBVEVfTU9ERVM6IHJlYWRvbmx5IFVwZGF0ZU1vZGVbXSA9IFtcImR5bmFtaWNcIiwgXCJmcm96ZW5cIl07XG5cbi8qKlxuICogRGVmYXVsdCB1cGRhdGUgbW9kZSAoSXNzdWUgIzYyMiwgcGFydCBvZiAjNTgzKS5cbiAqXG4gKiBgZHluYW1pY2AgaXMgd2hhdCBldmVyeSBob3N0IGRpZCBiZWZvcmUgdGhlIGtleSBleGlzdGVkLCBzbyBhbiBleGlzdGluZ1xuICogYC5jb25maWcuanNvbmAgd2l0aCBubyB1cGRhdGUtbW9kZSBrZXlzIGJlaGF2ZXMgZXhhY3RseSBhcyBpdCBkb2VzIHRvZGF5LlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9VUERBVEVfTU9ERTogVXBkYXRlTW9kZSA9IFwiZHluYW1pY1wiO1xuXG4vKipcbiAqIERlZmF1bHQgYW5zd2VyIHRoZSBzZXR1cCBjb252ZXJzYXRpb24gb2ZmZXJzIGZvciBhIGhvc3QgYmVpbmcgY29uZmlndXJlZFxuICogKElzc3VlICM2OTIsIHBhcnQgb2YgIzY3NCkuXG4gKlxuICogRGVsaWJlcmF0ZWx5ICoqbm90Kioge0BsaW5rIERFRkFVTFRfVVBEQVRFX01PREV9OiBhIG5ldyBob3N0IGlzIHBpbm5lZCB0b1xuICogdGhlIGxhdGVzdCByZWxlYXNlIGFuZCB0aGUgdG9vbCB2ZXJzaW9ucyB0aGF0IHJlbGVhc2UgcmVjb3JkZWQsIHNvIGFjY2VwdGluZ1xuICogZXZlcnkgZGVmYXVsdCByZXByb2R1Y2VzIGEgcmVsZWFzZWQsIHRlc3RlZCBjb21iaW5hdGlvbi4gYGR5bmFtaWNgIHN0YXlzIGFcbiAqIHZhbGlkIHR5cGVkIGFuc3dlciDigJQgdGhlIGRlbGliZXJhdGUsIG9wdC1pbiBleGNlcHRpb24uXG4gKlxuICogQW4gKmFic2VudCogYHVwZGF0ZV9tb2RlYCBzdGlsbCByZXNvbHZlcyB0byB7QGxpbmsgREVGQVVMVF9VUERBVEVfTU9ERX0gYXRcbiAqIGNvbmZpZyBsb2FkOiBleGlzdGluZyBob3N0cyBjYXJyeSBubyBwaW5zLCBhbmQgZnJlZXppbmcgdGhlbSBieSBkZWZhdWx0XG4gKiB3b3VsZCBmYWlsIHZhbGlkYXRpb24gYXQgdGhlaXIgbmV4dCBsYXVuY2ggKGZyb3plbiBpcyBhbGwtb3Itbm90aGluZyxcbiAqIElzc3VlICM2MjIpLiBUaGlzIGNvbnN0YW50IGlzIHRoZSBzZXR1cCBjb252ZXJzYXRpb24ncyBkZWZhdWx0IGFuc3dlciwgbm90XG4gKiB0aGUgbWVhbmluZyBvZiBhIG1pc3Npbmcga2V5LlxuICovXG5leHBvcnQgY29uc3QgU0VUVVBfREVGQVVMVF9VUERBVEVfTU9ERTogVXBkYXRlTW9kZSA9IFwiZnJvemVuXCI7XG5cbi8qKlxuICogRXZlcnkgYGNvcGlsb3RfY29kZV9yZXZpZXdgIHZhbHVlIGEgaG9zdCBtYXkgc2V0IChJc3N1ZSAjMjcwMSksIG5hbWVkIGhlcmVcbiAqIHNvIHRoZSB2YWxpZGF0b3IgYW5kIHRoZSBzZXR1cCBjb252ZXJzYXRpb24gbGlzdCB0aGUgc2FtZSB0aHJlZS5cbiAqL1xuZXhwb3J0IGNvbnN0IENPUElMT1RfQ09ERV9SRVZJRVdfTU9ERVM6IHJlYWRvbmx5IENvcGlsb3RDb2RlUmV2aWV3TW9kZVtdID0gW1xuICBcIm9uXCIsXG4gIFwib2ZmXCIsXG4gIFwibGVhdmVcIixcbl07XG5cbi8qKlxuICogV2hhdCBhbiBhYnNlbnQgYGNvcGlsb3RfY29kZV9yZXZpZXdgIG1lYW5zIChJc3N1ZSAjMjcwMSk6IHJlYWQgYW5kIHdyaXRlXG4gKiBub3RoaW5nLCBzbyBhIGhvc3QgdGhhdCBuZXZlciBhbnN3ZXJlZCB0aGUgcXVlc3Rpb24gY2hhbmdlcyBub3RoaW5nLCBhbmRcbiAqIHNldHVwIG9mZmVycyBpdCBhcyB0aGUgYW5zd2VyIG9uIGEgZnJlc2ggaG9zdC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQ09QSUxPVF9DT0RFX1JFVklFVzogQ29waWxvdENvZGVSZXZpZXdNb2RlID0gXCJsZWF2ZVwiO1xuXG4vKipcbiAqIFRvb2xzIHdob3NlIGV4YWN0IHZlcnNpb24gYSBmcm96ZW4gaG9zdCBwaW5zIChJc3N1ZSAjNjIyLCBwYXJ0IG9mICM1ODMpLlxuICpcbiAqIEFsbCB0aHJlZSBhcmUgcmVxdWlyZWQgdW5kZXIgYHVwZGF0ZV9tb2RlOiBcImZyb3plblwiYCDigJQgYSBob3N0IHRoYXQgcGlubmVkXG4gKiBvbmx5IHNvbWUgb2YgdGhlbSB3b3VsZCBzaWxlbnRseSBkcmlmdCBvbiB0aGUgcmVzdC5cbiAqL1xuZXhwb3J0IGNvbnN0IFBJTk5FRF9UT09MUyA9IFtcImNsYXVkZVwiLCBcImdoXCIsIFwiZGVub1wiXSBhcyBjb25zdDtcblxuLyoqXG4gKiBEZWZhdWx0IHBlci1yZXBvIGBuaWNlYCB2YWx1ZSAoSXNzdWUgIzI3NzIsIHBhcnQgb2YgIzI3NzEpLlxuICpcbiAqIFVuaXgtYG5pY2VgIHNlbWFudGljczogKipsb3dlciA9IHdvcmtlZCBzb29uZXIqKi4gYDBgIGlzIHRoZSBuZXV0cmFsXG4gKiBkZWZhdWx0LCBzbyBhIHJlcG8gd2l0aCBubyBjb25maWd1cmVkIGBuaWNlYCBpcyBuZWl0aGVyIHByb21vdGVkIG5vclxuICogZGVwcmlvcml0aXNlZC4gT3BlcmF0b3Itc2lkZSBvbmx5IOKAlCByZWFkIGZyb20gYC5jb25maWcuanNvbmBcbiAqIGByZXBvX2NvbmZpZy48b3duZXIvcmVwbz5gLCBuZXZlciBmcm9tIHRoZSB0YXJnZXQgcmVwbyAoSXNzdWUgIzI2MjYpLlxuICpcbiAqIFNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGggZm9yIHRoZSByZXNvbHZlciBgZ2V0UmVwb05pY2UoKWAgaW5cbiAqIGByZXBvX2NvbmZpZy50c2AgKElzc3VlICM5MDQpLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9SRVBPX05JQ0UgPSAwIGFzIGNvbnN0O1xuXG4vKipcbiAqIFZlcmJvc2l0eSBsZXZlbHMgZm9yIGNvbmZpZ3VyYWJsZSByZXNwb25zZSBvdXRwdXQgKElzc3VlICMxMzMwKS5cbiAqXG4gKiBQYXJ0IG9mICMxMzI5IChjYXZlbWFuIG1vZGUpLiBEaWZmZXJlbnQgcmVwb3NpdG9yaWVzIGJlbmVmaXQgZnJvbSBkaWZmZXJlbnRcbiAqIGxldmVscyBvZiBvdXRwdXQgZGV0YWlsIOKAlCB0aGUgbGV2ZWwgaXMgY29uZmlndXJlZCwgbmV2ZXIgZGVyaXZlZCBmcm9tIHRoZVxuICogcGhhc2UgKElzc3VlICM3OTgpOlxuICogLSBtaW5pbWFsOiBiYXJlIG1pbmltdW0gb3V0cHV0IChlLmcuIFwiZG9uZVwiLCBvbmUtbGluZSBzdW1tYXJ5KVxuICogLSBjb25jaXNlOiBicmllZiBidXQgaW5mb3JtYXRpdmUg4oCUIGtleSBkZWNpc2lvbnMgYW5kIG91dGNvbWVzIG9ubHlcbiAqIC0gc3RhbmRhcmQ6IGN1cnJlbnQgZGVmYXVsdCBiZWhhdmlvdXIg4oCUIGJhbGFuY2VkIGRldGFpbFxuICogLSB2ZXJib3NlOiBkZXRhaWxlZCBleHBsYW5hdGlvbnMgb2YgcmVhc29uaW5nLCB0cmFkZS1vZmZzLCBhbHRlcm5hdGl2ZXNcbiAqL1xuZXhwb3J0IGNvbnN0IFZFUkJPU0lUWV9MRVZFTFMgPSB7XG4gIG1pbmltYWw6IFwibWluaW1hbFwiLFxuICBjb25jaXNlOiBcImNvbmNpc2VcIixcbiAgc3RhbmRhcmQ6IFwic3RhbmRhcmRcIixcbiAgdmVyYm9zZTogXCJ2ZXJib3NlXCIsXG59IGFzIGNvbnN0O1xuXG4vKipcbiAqIERlZmF1bHQgdmVyYm9zaXR5IGxldmVsIChJc3N1ZSAjMTMzMCkuXG4gKiBcInN0YW5kYXJkXCIgcHJlc2VydmVzIGV4aXN0aW5nIGJlaGF2aW91ciBmb3IgYWxsIHJlcG9zaXRvcmllcyB1bmxlc3Mgb3ZlcnJpZGRlbi5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfVkVSQk9TSVRZID0gXCJzdGFuZGFyZFwiIGFzIGNvbnN0O1xuXG4vLyBJc3N1ZSAjNzk4OiBhIHBlci1waGFzZSB2ZXJib3NpdHkgZGVmYXVsdCBtYXAgdXNlZCB0byBsaXZlIGhlcmUgYW5kIHdhc1xuLy8gZGVsZXRlZCBhcyBkZWFkIGNvbmZpZ3VyYXRpb24g4oCUIHNlZSBgcmVzb2x2ZVZlcmJvc2l0eSgpYCBpbiB2ZXJib3NpdHkudHMgZm9yXG4vLyB3aHksIGFuZCBkbyBub3QgcmVpbnRyb2R1Y2UgaXQgd2l0aG91dCB0aHJlYWRpbmcgYSByZXNvbHZlZCBsZXZlbCB0aHJvdWdoXG4vLyBldmVyeSBwcm9tcHQgYnVpbGRlci5cblxuLyoqXG4gKiBFZmZvcnQgbGV2ZWxzIGZvciB0aGUgQ2xhdWRlIENMSSBgLS1lZmZvcnRgIGZsYWcgKElzc3VlICMxNDAyLCAjMjYyMCkuXG4gKlxuICogUGFydCBvZiAjMTM4OS4gRGlmZmVyZW50IHRhc2sgcGhhc2VzIGJlbmVmaXQgZnJvbSBkaWZmZXJlbnQgZWZmb3J0IGxldmVscyDigJRcbiAqIHBsYW5uaW5nIG5lZWRzIG1heGltdW0gZWZmb3J0IGZvciBhcmNoaXRlY3R1cmFsIGRlY2lzaW9ucywgd2hpbGUgc2ltcGxlIHRhc2tzXG4gKiBsaWtlIHNwZWxsaW5nIGZpeGVzIG5lZWQgbWluaW1hbCBlZmZvcnQgdG8gc2F2ZSBjb3N0IGFuZCB0aW1lLlxuICpcbiAqIGB4aGlnaGAgKElzc3VlICMyNjIwKSBzaXRzIGJldHdlZW4gYGhpZ2hgIGFuZCBgbWF4YC4gQ2xhdWRlIENvZGUgMi4xLjE3MCtcbiAqIGFjY2VwdHMgZml2ZSBsZXZlbHMgKGBsb3csIG1lZGl1bSwgaGlnaCwgeGhpZ2gsIG1heGApOyBgeGhpZ2hgIGlzIEFudGhyb3BpYydzXG4gKiByZWNvbW1lbmRlZCBzZXR0aW5nIGZvciBtb3N0IGNvZGluZyBhbmQgYWdlbnRpYyB1c2Ugb24gT3B1cyA0LjcrIC8gRmFibGUgNVxuICogKENsYXVkZSBDb2RlJ3Mgb3duIGludGVyYWN0aXZlIGRlZmF1bHQpLlxuICovXG5leHBvcnQgY29uc3QgRUZGT1JUX0xFVkVMUyA9IHtcbiAgbG93OiBcImxvd1wiLFxuICBtZWRpdW06IFwibWVkaXVtXCIsXG4gIGhpZ2g6IFwiaGlnaFwiLFxuICB4aGlnaDogXCJ4aGlnaFwiLFxuICBtYXg6IFwibWF4XCIsXG59IGFzIGNvbnN0O1xuXG4vKipcbiAqIERlZmF1bHQgZWZmb3J0IGxldmVsIChJc3N1ZSAjMTQwMikuXG4gKiBcImhpZ2hcIiBpcyB0aGUgZ2xvYmFsIGZhbGxiYWNrIGZvciBwaGFzZXMgbm90IGxpc3RlZCBpbiBQSEFTRV9FRkZPUlRfREVGQVVMVFMuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0VGRk9SVCA9IFwiaGlnaFwiIGFzIGNvbnN0O1xuXG4vKipcbiAqIERlZmF1bHQgZWZmb3J0IGxldmVsIGZvciB0aGUgcGxhbm5pbmcgcGhhc2UgKElzc3VlICMxNDAyLCAjMzIyOSwgIzI1NjApLlxuICogUGxhbm5pbmcgaXMgb25lIG9mIHRoZSBwbGFubmluZy1zaGFwZWQgcGhhc2VzIOKAlCB3aGVyZSB0aGUgVmliZSBDb2RlclxuICogaW50ZXJwcmV0cyB0aGUgdXNlcidzIHdvcmRzIGludG8gYW4gaW1wbGVtZW50YWJsZSBzdGF0ZSDigJQgdGhhdCBydW4gb24gdGhlXG4gKiBPcHVzIHRvcCB0aWVyIChzZWUgUEhBU0VfTU9ERUxfREVGQVVMVFMpLiBTaW5jZSAjMjU2MCB0aG9zZSBwaGFzZXMgc2hhcmVcbiAqIE9wdXMgd2l0aCBldmVyeSBvdGhlciBzdWJzdGFudGl2ZSBwaGFzZSwgc28gXCJoaWdoXCIgZWZmb3J0IGlzIHdoYXQgbWFya3NcbiAqIHRoZW0gb3V0OyB0aGUgYG1heGAgYnVtcCBpcyByZXNlcnZlZCBmb3IgdGhlICMzMjE3IHByZS1mbGlnaHQgcmVyb3V0ZSB0aGF0XG4gKiBmaXJlcyBvbmx5IHdoZW4gYW4gb3BlcmF0b3IgaGFzIHBpbm5lZCBhIHBoYXNlIGJhY2sgdG8gRmFibGUgYW5kIEZhYmxlIGlzXG4gKiB1bmF2YWlsYWJsZS4gUHJldmlvdXNseSBtYXguXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NMQVVERV9FRkZPUlRfUExBTk5JTkcgPSBcImhpZ2hcIiBhcyBjb25zdDtcblxuLyoqXG4gKiBEZWZhdWx0IGVmZm9ydCBsZXZlbCBmb3IgdGhlIGdyaWxsLW1lIHBoYXNlIChJc3N1ZSAjMjYyMSwgIzMyMjksICMyNTYwKS5cbiAqIFJlcXVpcmVtZW50cyBpbnRlcnJvZ2F0aW9uIHNoYXBlcyBldmVyeSBkb3duc3RyZWFtIHN1Yi1pc3N1ZSDigJQgdGhlIHNhbWVcbiAqIHBsYW4tcXVhbGl0eSBhcmd1bWVudCBhcyBwbGFubmluZyDigJQgc28gaXQgaXMgb25lIG9mIHRoZSBwbGFubmluZy1zaGFwZWRcbiAqIHBoYXNlcyB0aGF0IHJ1biBvbiB0aGUgT3B1cyB0b3AgdGllciBhdCBcImhpZ2hcIiBlZmZvcnQuIFByZXZpb3VzbHkgbWF4LlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9DTEFVREVfRUZGT1JUX0dSSUxMX01FID0gXCJoaWdoXCIgYXMgY29uc3Q7XG5cbi8qKlxuICogRGVmYXVsdCBlZmZvcnQgZm9yIGJvdGggUXVvcnVtIHBoYXNlcyAoSXNzdWUgIzQxMTIsIHBhcmVudCAjNDEwMikuXG4gKiBEcmFmdGluZyBhIHBsYW4gYW5kIGp1ZGdpbmcgdHdvIG9mIHRoZW0gYXJlIHBsYW5uaW5nLXNoYXBlZCB3b3JrLCBzbyBib3RoXG4gKiBydW4gYXQgdGhlIHNhbWUgXCJoaWdoXCIgZWZmb3J0IGFzIHBsYW5uaW5nIGFuZCBncmlsbC1tZS5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQ0xBVURFX0VGRk9SVF9RVU9SVU0gPSBcImhpZ2hcIiBhcyBjb25zdDtcblxuLyoqXG4gKiBEZWZhdWx0IGVmZm9ydCBsZXZlbCBmb3IgdGhlIGlzc3VlIHBoYXNlIChJc3N1ZSAjMTQwMikuXG4gKiBHZW5lcmFsIGltcGxlbWVudGF0aW9uIGJlbmVmaXRzIGZyb20gdGhvcm91Z2ggcmVhc29uaW5nLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9DTEFVREVfRUZGT1JUX0lTU1VFID0gXCJoaWdoXCIgYXMgY29uc3Q7XG5cbi8qKlxuICogRGVmYXVsdCBlZmZvcnQgbGV2ZWwgZm9yIHRoZSBxdWVzdGlvbiBwaGFzZSAoSXNzdWUgIzE0MDIsICMyMzkxLCAjMzIyOSxcbiAqICMyNTYwKS4gQW5zd2VyaW5nIGEgdXNlcidzIHF1ZXN0aW9uIGlzIG9uZSBvZiB0aGUgcGxhbm5pbmctc2hhcGVkIHBoYXNlcyDigJRcbiAqIHRoZSBWaWJlIENvZGVyIGludGVycHJldHMgdGhlIHVzZXIncyB3b3JkcyBpbnRvIGFuIGltcGxlbWVudGFibGUgc3RhdGUg4oCUIHNvXG4gKiBpdCBydW5zIG9uIHRoZSBPcHVzIHRvcCB0aWVyIGF0IFwiaGlnaFwiIGVmZm9ydCAoc2VlIFBIQVNFX01PREVMX0RFRkFVTFRTKS5cbiAqIFByZXZpb3VzbHkgb3B1cyArIG1lZGl1bS5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQ0xBVURFX0VGRk9SVF9RVUVTVElPTiA9IFwiaGlnaFwiIGFzIGNvbnN0O1xuXG4vKipcbiAqIERlZmF1bHQgZWZmb3J0IGxldmVsIGZvciB0aGUgQ0kgZml4IHBoYXNlIChJc3N1ZXMgIzE0MDIsICMyODEyKS5cbiAqIFJlYWN0aXZlIGFuZCB3ZWxsLXNjb3BlZDsgaGlnaCBiZWNhdXNlIGl0IG5vdyBydW5zIG9uIFNvbm5ldCwgbm90IE9wdXMuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NMQVVERV9FRkZPUlRfQ0lfRklYID0gXCJoaWdoXCIgYXMgY29uc3Q7XG5cbi8qKlxuICogRGVmYXVsdCBlZmZvcnQgbGV2ZWwgZm9yIHRoZSBQUiBmZWVkYmFjayBwaGFzZSAoSXNzdWVzICMxNDAyLCAjMjgxMikuXG4gKiBUYXJnZXRlZCByZXZpZXdlciBmaXhlczsgaGlnaCBiZWNhdXNlIGl0IG5vdyBydW5zIG9uIFNvbm5ldCwgbm90IE9wdXMuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NMQVVERV9FRkZPUlRfUFJfRkVFREJBQ0sgPSBcImhpZ2hcIiBhcyBjb25zdDtcblxuLyoqXG4gKiBEZWZhdWx0IGVmZm9ydCBsZXZlbCBmb3IgdGhlIHF1YWxpdHkgZml4IHBoYXNlIChJc3N1ZXMgIzE0MDIsICMyODEyKS5cbiAqIFJlYWN0aXZlIHRlc3QvbGludCBmaXhlczsgaGlnaCBiZWNhdXNlIGl0IG5vdyBydW5zIG9uIFNvbm5ldCwgbm90IE9wdXMuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NMQVVERV9FRkZPUlRfUVVBTElUWV9GSVggPSBcImhpZ2hcIiBhcyBjb25zdDtcblxuLyoqXG4gKiBEZWZhdWx0IGVmZm9ydCBsZXZlbCBmb3IgdGhlIHJlZmluZW1lbnQgcGhhc2UgKElzc3VlICMxNDAyLCAjMzIyOSwgIzI1NjApLlxuICogUmV3b3JkaW5nIHRpdGxlcy9kZXNjcmlwdGlvbnMgaXMgb25lIG9mIHRoZSBwbGFubmluZy1zaGFwZWQgcGhhc2VzIOKAlFxuICogdGhlIFZpYmUgQ29kZXIgaW50ZXJwcmV0cyB0aGUgdXNlcidzIHdvcmRzIGludG8gYW4gaW1wbGVtZW50YWJsZSBzdGF0ZSDigJQgc29cbiAqIGl0IHJ1bnMgb24gdGhlIE9wdXMgdG9wIHRpZXIgYXQgXCJoaWdoXCIgZWZmb3J0LiBQcmV2aW91c2x5IG1lZGl1bS5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQ0xBVURFX0VGRk9SVF9SRUZJTkVNRU5UID0gXCJoaWdoXCIgYXMgY29uc3Q7XG5cbi8qKlxuICogRGVmYXVsdCBlZmZvcnQgbGV2ZWwgZm9yIHRoZSByZXZpc2lvbiBwaGFzZSAoSXNzdWUgIzE0MDIsICMzMjI5LCAjMjU2MCkuXG4gKiBSZXZpZXctYmFzZWQgcmV3cml0aW5nIGlzIG9uZSBvZiB0aGUgcGxhbm5pbmctc2hhcGVkIHBoYXNlcyDigJQgdGhlIFZpYmVcbiAqIENvZGVyIGludGVycHJldHMgdGhlIHVzZXIncyB3b3JkcyBpbnRvIGFuIGltcGxlbWVudGFibGUgc3RhdGUg4oCUIHNvIGl0IHJ1bnNcbiAqIG9uIHRoZSBPcHVzIHRvcCB0aWVyIGF0IFwiaGlnaFwiIGVmZm9ydC4gUHJldmlvdXNseSBtZWRpdW0uXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NMQVVERV9FRkZPUlRfUkVWSVNJT04gPSBcImhpZ2hcIiBhcyBjb25zdDtcblxuLyoqXG4gKiBEZWZhdWx0IGVmZm9ydCBsZXZlbCBmb3IgdGhlIGNsYXJpZmljYXRpb24gcGhhc2UgKElzc3VlICMxNDAyLCAjMzIyOSwgIzI1NjApLlxuICogQXNzZXNzaW5nIGlzc3VlIGNsYXJpdHkgaXMgb25lIG9mIHRoZSBwbGFubmluZy1zaGFwZWQgcGhhc2VzIOKAlCB0aGUgVmliZVxuICogQ29kZXIgaW50ZXJwcmV0cyB0aGUgdXNlcidzIHdvcmRzIGludG8gYW4gaW1wbGVtZW50YWJsZSBzdGF0ZSDigJQgc28gaXQgcnVuc1xuICogb24gdGhlIE9wdXMgdG9wIHRpZXIgYXQgXCJoaWdoXCIgZWZmb3J0LiBQcmV2aW91c2x5IG1lZGl1bS5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQ0xBVURFX0VGRk9SVF9DTEFSSUZJQ0FUSU9OID0gXCJoaWdoXCIgYXMgY29uc3Q7XG5cbi8qKlxuICogRGVmYXVsdCBlZmZvcnQgbGV2ZWwgZm9yIHRoZSBzcGVsbGluZyBmaXggcGhhc2UgKElzc3VlICMxNDAyKS5cbiAqIFNpbXBsZSB0eXBvIGNvcnJlY3Rpb25zIOKAlCBtaW5pbWFsIGVmZm9ydCBuZWVkZWQuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NMQVVERV9FRkZPUlRfU1BFTExJTkdfRklYID0gXCJsb3dcIiBhcyBjb25zdDtcblxuLyoqXG4gKiBEZWZhdWx0IGVmZm9ydCBsZXZlbCBmb3IgdGhlIHN1bW1hcmlzZSBwaGFzZSAoSXNzdWUgIzE0MDIpLlxuICogTGlnaHR3ZWlnaHQgc3VtbWFyaXNhdGlvbiDigJQgbWluaW1hbCBlZmZvcnQgaXMgc3VmZmljaWVudC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQ0xBVURFX0VGRk9SVF9TVU1NQVJJU0UgPSBcImxvd1wiIGFzIGNvbnN0O1xuXG4vKipcbiAqIERlZmF1bHQgZWZmb3J0IGxldmVsIGZvciB0aGUgaGVhbHRoIGNoZWNrIHBoYXNlIChJc3N1ZSAjMTQwMikuXG4gKiBUcml2aWFsIGhlYWx0aCBjaGVjayDigJQgbWluaW1hbCBlZmZvcnQgbmVlZGVkLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9DTEFVREVfRUZGT1JUX0hFQUxUSCA9IFwibG93XCIgYXMgY29uc3Q7XG5cbi8qKlxuICogUGhhc2Utc3BlY2lmaWMgZWZmb3J0IGRlZmF1bHRzIChJc3N1ZSAjMTQwMiwgIzIzOTEpLlxuICpcbiAqIE1hcHMgcGhhc2UgbmFtZXMgdG8gdGhlaXIgZGVmYXVsdCBlZmZvcnQgbGV2ZWwuIFBoYXNlcyBub3QgbGlzdGVkIGhlcmVcbiAqIGZhbGwgYmFjayB0byBERUZBVUxUX0VGRk9SVCAoXCJoaWdoXCIpLlxuICpcbiAqIEVmZm9ydC1maXJzdCByb3V0aW5nIChJc3N1ZSAjMjM5MSk6IGVmZm9ydCBpcyB0aGUgKnByaW1hcnkqIGNvc3QgbGV2ZXJcbiAqIGFuZCB0aGUgZWZmb3J0IHRpZXJzIGJlbG93IGVuY29kZSBlYWNoIHBoYXNlJ3MgY29tcGxleGl0eS4gTW9kZWwgdGllciBpc1xuICogdGhlICpzZWNvbmRhcnkqIGxldmVyLCBhbmQgc2luY2UgSXNzdWUgIzI1NjAgY29sbGFwc2VkIHRoZSB0b3AgdGllciBvbnRvXG4gKiBPcHVzIGl0IHNlcGFyYXRlcyBvbmx5IHRoZSB0cml2aWFsIHBoYXNlcyAoSGFpa3UpIGZyb20gZXZlcnl0aGluZyBlbHNlIOKAlFxuICogc28gZWZmb3J0IGFsb25lIGRpc3Rpbmd1aXNoZXMgdGhlIGVpZ2h0IHBsYW5uaW5nLXNoYXBlZCBwaGFzZXMgZnJvbSB0aGVcbiAqIHJlYWN0aXZlIG9uZXMgKHNlZSBQSEFTRV9NT0RFTF9ERUZBVUxUUykuIFRoZSBlZmZvcnQgdGllcnM6XG4gKiAtIHBsYW5uaW5nIC8gZ3JpbGxfbWUgLyByZWZpbmVtZW50IC8gcmV2aXNpb24gLyBxdWVzdGlvbiAvIGNsYXJpZmljYXRpb24gL1xuICogICBxdW9ydW0gLyBxdW9ydW1fanVkZ2Ug4oaSIGhpZ2ggKHRoZSBlaWdodCBwbGFubmluZy1zaGFwZWQgcGhhc2VzOyB0aGVpclxuICogICBgbWF4YCBidW1wIGlzIHJlc2VydmVkIGZvciB0aGUgIzMyMTcgcHJlLWZsaWdodCByZXJvdXRlLCB3aGljaCBmaXJlcyBvbmx5XG4gKiAgIHdoZW4gYSBwaGFzZSBoYXMgYmVlbiBwaW5uZWQgYmFjayB0byBGYWJsZSBhbmQgRmFibGUgaXMgdW5hdmFpbGFibGUpXG4gKiAtIGlzc3VlIOKGkiBoaWdoICh0aG9yb3VnaCByZWFzb25pbmcgZm9yIGltcGxlbWVudGF0aW9uKVxuICogLSBjaV9maXggLyBwcl9mZWVkYmFjayAvIHF1YWxpdHlfZml4IC8gbWVyZ2VfY29uZmxpY3Qg4oaSIGhpZ2ggKHJlYWN0aXZlXG4gKiAgIHRhc2tzLCBydW4gb24gU29ubmV0IHNpbmNlIElzc3VlICMyODEyIHNvIHRoZXkgdGFrZSB0aGUgZGVlcGVyIGVmZm9ydCBhdFxuICogICBoYWxmIHRoZSBPcHVzIHJhdGU7IG1lcmdlX2NvbmZsaWN0IGlzIHRoZSBzYW1lIGNsYXNzLCBJc3N1ZSAjNDE3NClcbiAqIC0gc3BlbGxpbmdfZml4IC8gc3VtbWFyaXNlIC8gaGVhbHRoIC8gY29tcGFjdGlvbiDihpIgbG93ICh0cml2aWFsIG9yXG4gKiAgIHN1bW1hcmlzaW5nIHRhc2tzOyBjb21wYWN0aW9uIGlzIHRoZSBmYXN0IHRpZXIsIElzc3VlICM0MTc0KVxuICovXG5leHBvcnQgY29uc3QgUEhBU0VfRUZGT1JUX0RFRkFVTFRTOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiA9IHtcbiAgcGxhbm5pbmc6IERFRkFVTFRfQ0xBVURFX0VGRk9SVF9QTEFOTklORyxcbiAgZ3JpbGxfbWU6IERFRkFVTFRfQ0xBVURFX0VGRk9SVF9HUklMTF9NRSxcbiAgLy8gSXNzdWUgIzQxMTI6IHRoZSB0d28gUXVvcnVtIHBoYXNlcyDigJQgYHF1b3J1bWAgZHJhZnRzLCBgcXVvcnVtX2p1ZGdlYFxuICAvLyBhZGp1ZGljYXRlcyAodGhlIHBoYXNlIG5hbWVzIGBxdW9ydW1fb3JjaGVzdHJhdG9yLnRzYCBzdGFtcHMpLlxuICBxdW9ydW06IERFRkFVTFRfQ0xBVURFX0VGRk9SVF9RVU9SVU0sXG4gIHF1b3J1bV9qdWRnZTogREVGQVVMVF9DTEFVREVfRUZGT1JUX1FVT1JVTSxcbiAgaXNzdWU6IERFRkFVTFRfQ0xBVURFX0VGRk9SVF9JU1NVRSxcbiAgcXVlc3Rpb246IERFRkFVTFRfQ0xBVURFX0VGRk9SVF9RVUVTVElPTixcbiAgY2lfZml4OiBERUZBVUxUX0NMQVVERV9FRkZPUlRfQ0lfRklYLFxuICBwcl9mZWVkYmFjazogREVGQVVMVF9DTEFVREVfRUZGT1JUX1BSX0ZFRURCQUNLLFxuICBxdWFsaXR5X2ZpeDogREVGQVVMVF9DTEFVREVfRUZGT1JUX1FVQUxJVFlfRklYLFxuICAvLyBJc3N1ZSAjNDE3NDogdGhlIG1lcmdlIGVuZ2luZWVyLCBzYW1lIGVmZm9ydCBhcyB0aGUgb3RoZXIgcmVhY3RpdmUgcGhhc2VzLlxuICBtZXJnZV9jb25mbGljdDogREVGQVVMVF9DTEFVREVfRUZGT1JUX1FVQUxJVFlfRklYLFxuICByZWZpbmVtZW50OiBERUZBVUxUX0NMQVVERV9FRkZPUlRfUkVGSU5FTUVOVCxcbiAgcmV2aXNpb246IERFRkFVTFRfQ0xBVURFX0VGRk9SVF9SRVZJU0lPTixcbiAgY2xhcmlmaWNhdGlvbjogREVGQVVMVF9DTEFVREVfRUZGT1JUX0NMQVJJRklDQVRJT04sXG4gIHNwZWxsaW5nX2ZpeDogREVGQVVMVF9DTEFVREVfRUZGT1JUX1NQRUxMSU5HX0ZJWCxcbiAgc3VtbWFyaXNlOiBERUZBVUxUX0NMQVVERV9FRkZPUlRfU1VNTUFSSVNFLFxuICBoZWFsdGg6IERFRkFVTFRfQ0xBVURFX0VGRk9SVF9IRUFMVEgsXG4gIC8vIElzc3VlICM0MTc0OiBhIHN1bW1hcmlzaW5nIC9jb21wYWN0IHR1cm4sIHNhbWUgZWZmb3J0IGFzIHN1bW1hcmlzZS5cbiAgY29tcGFjdGlvbjogREVGQVVMVF9DTEFVREVfRUZGT1JUX1NVTU1BUklTRSxcbn0gYXMgY29uc3Q7XG5cbi8qKlxuICogRGVmYXVsdCBDbGF1ZGUgbW9kZWwgc2VsZWN0aW9uIChJc3N1ZSAjMjYwLCAjMjM5MSkuXG4gKlxuICogT3B1cyBpcyB0aGUgc2luZ2xlIGJhc2UgdGllci4gVW5kZXIgZWZmb3J0LWZpcnN0IHJvdXRpbmcgKCMyMzkxKSBldmVyeVxuICogcGhhc2UgZGVmYXVsdHMgdG8gdGhpcyBvbmUgdGllciBhbmQgdmFyaWVzICplZmZvcnQqIHJhdGhlciB0aGFuIHN3aXRjaGluZ1xuICogbW9kZWwgZmFtaWxpZXMg4oCUIHNlZSB0aGUgcGVyLXBoYXNlIGNvbnN0YW50cyBiZWxvdyBhbmQgUEhBU0VfRUZGT1JUX0RFRkFVTFRTLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9DTEFVREVfTU9ERUwgPSBcIm9wdXNcIiBhcyBjb25zdDtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQZXItcGhhc2UgbW9kZWwgZGVmYXVsdHMg4oCUIGVmZm9ydC1maXJzdCByb3V0aW5nIChJc3N1ZXMgIzIzOTAsICMyMzkxKVxuLy9cbi8vIE5vdyB0aGF0IGEgc2luZ2xlIG1vZGVsIChPcHVzIDQuOCkgc3BhbnMgdGhlIGZ1bGwgZWZmb3J0IHJhbmdlIGFuZCB0aGVcbi8vIE9wdXPihpRTb25uZXQgcHJpY2UgZ2FwIGlzIHNtYWxsICh+MS43w5cpLCB0aGUgd29ya2VyIGNvbnNvbGlkYXRlcyB0aGUgZm9ybWVyXG4vLyBtaWQgKFNvbm5ldCkgdGllciB1cCBvbnRvIHRoZSBzaW5nbGUgdG9wIHRpZXIgKE9wdXMpIGFuZCB1c2VzIGVmZm9ydFxuLy8gKFBIQVNFX0VGRk9SVF9ERUZBVUxUUykgYXMgdGhlICpwcmltYXJ5KiBjb3N0IGxldmVyIOKAlCBvbmUgcXVhbGl0eSBiYXIgd2l0aCBhXG4vLyB0dW5hYmxlIGRlcHRoIGRpYWwg4oCUIGluc3RlYWQgb2Ygcm91dGluZyBlYWNoIHBoYXNlIHRvIGEgZGlmZmVyZW50IG1vZGVsXG4vLyBmYW1pbHkuIFRoaXMgYWxzbyBzaWRlc3RlcHMgdGhlIE9wdXMgYWxpYXPihpJwcmljaW5nIG1pc21hdGNoICgjMjM4OSkuXG4vL1xuLy8gVGllciBpcyB0aGUgKnNlY29uZGFyeSogbGV2ZXIsIGFuZCBzaW5jZSBJc3N1ZSAjMjU2MCBpdCBpcyBhcHBsaWVkIGF0IHRoZVxuLy8gY2hlYXAgZXh0cmVtZSBvbmx5OiB0aGUgdGhyZWUgdHJpdmlhbCBwaGFzZXMgKHNwZWxsaW5nX2ZpeCwgc3VtbWFyaXNlLFxuLy8gaGVhbHRoKSBzdGF5IG9uIEhhaWt1IOKAlCB0aGUgT3B1c+KGlEhhaWt1IGdhcCBpcyBzdGlsbCB+NcOXLCBzdW1tYXJpc2UgY2FuIGJlXG4vLyBmZWQgdmVyeSBsYXJnZSBpbnB1dHMsIGFuZCB0aGUgbGFyZ2UtaW5wdXQgZXNjYWxhdGlvbiBpblxuLy8gcGhhc2VfbW9kZWxfZXNjYWxhdGlvbi50cyAoIzIzOTMpIGFscmVhZHkgbGlmdHMgYSBIYWlrdSBwaGFzZSB0byBhIDFNLXdpbmRvd1xuLy8gdGllciB3aGVuIGFuIGlucHV0IHdvdWxkIG90aGVyd2lzZSB0cnVuY2F0ZS4gVGhlIGVpZ2h0IHBsYW5uaW5nLXNoYXBlZFxuLy8gcGhhc2VzIHVzZWQgdG8gc2l0IG9uIGEgRmFibGUgdGllciBhYm92ZSBPcHVzICgjMjYyMSBwcm9tb3RlZCBwbGFubmluZyBhbmRcbi8vIGdyaWxsX21lLCAjMzIyOSBleHRlbmRlZCBpdCB0byByZWZpbmVtZW50LCByZXZpc2lvbiwgcXVlc3Rpb24gYW5kXG4vLyBjbGFyaWZpY2F0aW9uLCAjNDExMiBhZGRlZCBxdW9ydW0gYW5kIHF1b3J1bV9qdWRnZSkgdW5kZXIgb25lIGd1aWRpbmcgcnVsZTpcbi8vIHdoZXJldmVyIHRoZSBWaWJlIENvZGVyIGludGVycHJldHMgdGhlIHVzZXIncyB3b3JkcyBpbnRvIGFuIGltcGxlbWVudGFibGVcbi8vIHN0YXRlLCB1c2UgdGhlIGhpZ2hlc3QgbW9kZWwgYXZhaWxhYmxlLiBPcHVzIDUuNSBtYXRjaGVzIG9yIGJlYXRzIEZhYmxlIDUuMVxuLy8gb24gcGxhbiBxdWFsaXR5IGF0IHJvdWdobHkgaGFsZiB0aGUgcHJpY2UsIHNvICMyNTYwIGNvbGxhcHNlZCB0aGF0IHRpZXIgb250b1xuLy8gT3B1cyDigJQgdGhlIHJ1bGUgaXMgdW5jaGFuZ2VkLCB0aGUgaGlnaGVzdCBtb2RlbCBhdmFpbGFibGUgaXMgc2ltcGx5IE9wdXNcbi8vIG5vdywgYW5kIFwiaGlnaFwiIGVmZm9ydCBpcyB3aGF0IHN0aWxsIHNlcGFyYXRlcyB0aG9zZSBwaGFzZXMgZnJvbSB0aGVcbi8vIHJlYWN0aXZlIG9uZXMuXG4vL1xuLy8gSXNzdWUgIzIzOTAgc3BlY2lmaWNhbGx5IGV2YWx1YXRlZCB3aGV0aGVyIHRoZSByZWFjdGl2ZSBwaGFzZXMgKGNpX2ZpeCxcbi8vIHByX2ZlZWRiYWNrLCBxdWFsaXR5X2ZpeCkgc2hvdWxkIGRyb3AgdG8gb3B1cyArIExPVyBlZmZvcnQsIGFuZCB3aGV0aGVyXG4vLyByZWZpbmVtZW50IC8gY2xhcmlmaWNhdGlvbiAvIHF1ZXN0aW9uIHNob3VsZCBkZW1vdGUgdG8gSGFpa3UuIFRoZSBkZWNpc2lvblxuLy8g4oCUIHJlY29yZGVkIGluIGRvY3MvTU9ERUwtQU5ELUNBQ0hJTkcubWQgdW5kZXIgXCJQZXItcGhhc2UgZGVjaXNpb24gbG9nXCIg4oCUIHdhc1xuLy8gdG8gY29uc29saWRhdGUgdGhlIHJlYWN0aXZlIHBoYXNlcyBvbiBvcHVzICsgbWVkaXVtOiBwcmVzZXJ2ZSB0aGVcbi8vIG1lZGl1bS1lZmZvcnQgZmxvb3Igb24gcmVhY3RpdmUgd29yayAodGhlIGhhcmQgY2FzZXMgbmVlZCB0aGUgcmVhc29uaW5nXG4vLyBkZXB0aCkgYW5kIGxldCBvcGVyYXRvcnMgb3ZlcnJpZGUgcGVyLXJlcG8gaWYgdGhleSB3YW50IGEgY2hlYXBlciB0aWVyLlxuLy8gSXNzdWUgIzMyMjkgbGF0ZXIgcmUtdGllcmVkIHJlZmluZW1lbnQgLyByZXZpc2lvbiAvIHF1ZXN0aW9uIC8gY2xhcmlmaWNhdGlvblxuLy8gKnVwKiAobm90IGRvd24gdG8gSGFpa3UpOiB0aGV5IGFyZSBwbGFubmluZy1zaGFwZWQgcGhhc2VzIHdoZXJlIHRoZSBWaWJlXG4vLyBDb2RlciBpbnRlcnByZXRzIHRoZSB1c2VyJ3Mgd29yZHMsIHNvIHRoZXkgam9pbiBwbGFubmluZyBhbmQgZ3JpbGxfbWUgYXRcbi8vIGhpZ2ggZWZmb3J0LiBJc3N1ZSAjMjgxMiB0aGVuIG1vdmVkIHRoZSB0aHJlZSBnZW51aW5lbHkgcmVhY3RpdmUgcGhhc2VzXG4vLyAoY2lfZml4LCBwcl9mZWVkYmFjaywgcXVhbGl0eV9maXgpIHRvIHNvbm5ldCArIGhpZ2g6IFNvbm5ldCA1LjUgY29zdHMgaGFsZlxuLy8gb2YgT3B1cyA1LjUsIHNvIHRoZSBtZWRpdW0tZWZmb3J0IGZsb29yIHJpc2VzIHRvIGhpZ2ggYXQgbG93ZXIgY29zdC5cbi8vXG4vLyBUaGUgbmFtZWQgcGVyLXBoYXNlIGNvbnN0YW50cyBhcmUgcmV0YWluZWQgc28gdGhlIG92ZXJyaWRlIGNoYWluXG4vLyAoQ0xBVURFX01PREVMXzxQSEFTRT4gZW52IHZhcnMsIHBoYXNlX21vZGVsX292ZXJyaWRlcyBjb25maWcpIGFuZCB0aGVcbi8vIHNoZWxsLWRlZmF1bHQgZW1pdHRlciBrZWVwIHdvcmtpbmcgdW5jaGFuZ2VkLlxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogVG9wIG1vZGVsIHRpZXIg4oCUIHRoZSBgb3B1c2AgYWxpYXMgKElzc3VlcyAjMjYxOSwgIzI2MjEsICMyNTQzLCAjMjU2MCkuXG4gKlxuICogVGhlIHdvcmtlciBwYXNzZXMgdGhlIGBvcHVzYCBhbGlhczsgdGhlIENsYXVkZSBDTEkgcmVzb2x2ZXMgaXQgdG8gdGhlIGxhdGVzdFxuICogT3B1cyBtb2RlbCAoY29tYmluZWQgd2l0aCB0aGUgQ0xJIG1pbmltdW0tdmVyc2lvbiBmbG9vciBpbiAjMjYyMiwgdGhpcyBrZWVwc1xuICogdGhlIHRpZXIgY3VycmVudCB3aXRoIG5vIHBlci1yZWxlYXNlIGNvbmZpZyBjaGFuZ2UpLiBPcHVzIDUuNSBtYXRjaGVzIG9yXG4gKiBiZWF0cyBGYWJsZSA1LjEgb24gcGxhbiBxdWFsaXR5IGF0IH5oYWxmIHRoZSBwcmljZSwgc28gSXNzdWUgIzI1NjAgY29sbGFwc2VkXG4gKiB0aGUgdG9wIHRpZXIgb250byB0aGUgYmFzZSB0aWVyOiB0aGUgcGxhbm5pbmctc2hhcGVkIHBoYXNlcyBub3cgc2hhcmUgdGhlXG4gKiBgb3B1c2AgYWxpYXMgd2l0aCBldmVyeSBvdGhlciBzdWJzdGFudGl2ZSBwaGFzZSwgYW5kICoqZWZmb3J0KiogYWxvbmVcbiAqIHNlcGFyYXRlcyB0aGVtIChoaWdoIGZvciBwbGFubmluZy1zaGFwZWQsIG1lZGl1bSBmb3IgcmVhY3RpdmUpLlxuICpcbiAqIFRoZSBjb25zdGFudCBpcyBrZXB0IOKAlCByYXRoZXIgdGhhbiBmb2xkZWQgaW50byB7QGxpbmsgREVGQVVMVF9DTEFVREVfTU9ERUx9IOKAlFxuICogc28gYSBmdXR1cmUgdGllciBhYm92ZSBPcHVzIGlzIGEgb25lLWxpbmUgY2hhbmdlIGFnYWluLCBhbmQgc28gb3BlcmF0b3JzXG4gKiBwaW5uaW5nIGBDTEFVREVfTU9ERUxfUExBTk5JTkc9ZmFibGVgIGtlZXAgYSBkb2N1bWVudGVkIHJvbGxiYWNrLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9DTEFVREVfTU9ERUxfVE9QX1RJRVIgPSBcIm9wdXNcIiBhcyBjb25zdDtcblxuLyoqIFBsYW5uaW5nIHBoYXNlIG1vZGVsIOKAlCBPcHVzIHRvcCB0aWVyIChlZmZvcnQ6IGhpZ2gsIElzc3VlcyAjMjYyMSwgIzMyMjksICMyNTYwKS4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NMQVVERV9NT0RFTF9QTEFOTklORyA9IERFRkFVTFRfQ0xBVURFX01PREVMX1RPUF9USUVSO1xuXG4vKipcbiAqIERlZmF1bHQgY29uZmlndXJlZCBiZXN0IHBsYW5uaW5nIG1vZGVsIChJc3N1ZSAjMjY1NCkuXG4gKlxuICogVGhlIGRlZ3JhZGVkLW1vZGVsIGRldGVjdG9yIChgcGxhbm5pbmdfcnVuX3N0YXRzLnRzYCkgZmxhZ3MgYSBwbGFubmluZyBydW5cbiAqIGFzIGRlZ3JhZGVkIHdoZW4gYSBwbGFuLWdlbmVyYXRpbmcgcmVzcG9uc2Ugd2FzIHNlcnZlZCBieSBhIG1vZGVsIG90aGVyIHRoYW5cbiAqIHRoaXMgY29uZmlndXJlZCBiZXN0IHBsYW5uaW5nIG1vZGVsLCB0aGVuIGxhYmVscyB0aGUgcGFyZW50IGlzc3VlIGFuZCBldmVyeVxuICogc3ViLWlzc3VlIHdpdGggYGRlZ3JhZGVkLW1vZGVsYCAoIzI2NDYpLlxuICpcbiAqIEVtcHR5IGJ5IGRlZmF1bHQ6IGFuIGVtcHR5IHZhbHVlIG1lYW5zIFwiZGVyaXZlIHRoZSBleHBlY3RlZCBtb2RlbCBmcm9tIHRoZVxuICogcGxhbm5pbmcgcm91dGluZyBjaGFpblwiIOKAlCBgYnVpbGRDbGF1ZGVNb2RlbEFyZ3MoXCJwbGFubmluZ1wiKWAsIHdoaWNoIGFscmVhZHlcbiAqIHJlc29sdmVzIHRvIHtAbGluayBERUZBVUxUX0NMQVVERV9NT0RFTF9QTEFOTklOR30gYW5kIGhvbm91cnMgZXZlcnkgcGVyLXJlcG9cbiAqIGFuZCBnbG9iYWwgbW9kZWwgb3ZlcnJpZGUuIFRoaXMga2VlcHMgdGhlIHBlci1yZXBvLW92ZXJyaWRlLWZvci1mcmVlXG4gKiBiZWhhdmlvdXIgKCMyNjI1KSBhbmQgbmV2ZXIgZmxhZ3MgYSByZXBvIHRoYXQgZGVsaWJlcmF0ZWx5IHJvdXRlcyBwbGFubmluZyB0b1xuICogYSBkaWZmZXJlbnQgdGllci4gUGluIGEgc3BlY2lmaWMgbW9kZWwgKGdsb2JhbGx5IHZpYSBgYmVzdF9wbGFubmluZ19tb2RlbGAsXG4gKiBvciBwZXItcmVwbyB2aWEgYHJlcG9fY29uZmlnYCkgdG8gZXhwZWN0IHRoYXQgZXhhY3QgbW9kZWwgcmVnYXJkbGVzcyBvZiB3aGljaFxuICogdGllciB0aGUgd29ya2VyIHJvdXRlcyB0aGUgcmVxdWVzdCB0by5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQkVTVF9QTEFOTklOR19NT0RFTCA9IFwiXCIgYXMgY29uc3Q7XG5cbi8qKiBHcmlsbC1tZSBwaGFzZSBtb2RlbCDigJQgT3B1cyB0b3AgdGllciAoZWZmb3J0OiBoaWdoLCBJc3N1ZXMgIzI2MjEsICMzMjI5LCAjMjU2MCkuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9DTEFVREVfTU9ERUxfR1JJTExfTUUgPSBERUZBVUxUX0NMQVVERV9NT0RFTF9UT1BfVElFUjtcblxuLyoqXG4gKiBRdW9ydW0gcGhhc2UgbW9kZWwg4oCUIE9wdXMgdG9wIHRpZXIgKGVmZm9ydDogaGlnaCwgSXNzdWVzICM0MTEyLCAjMjU2MCkuXG4gKlxuICogUXVvcnVtIGRlY2lkZXMgKndoYXQgdGhlIHBsYW4gaXMqIGJlZm9yZSB0aGUgcGxhbm5pbmcgcGhhc2Ugc3BsaXRzIGl0IGludG9cbiAqIHN1Yi1pc3N1ZXMsIHNvIGJvdGggaXRzIHBoYXNlcyBhcmUgcGxhbm5pbmctc2hhcGVkIGFuZCB0YWtlIHRoZSBzYW1lIHRpZXIgYXNcbiAqIHBsYW5uaW5nLiBBIG5vbi1DbGF1ZGUgcHJvdmlkZXIgaWdub3JlcyB0aGUgYWxpYXMg4oCUIHRoZSByb3V0aW5nIGVudHJ5IGlzIHdoYXRcbiAqIHRoZSBDbGF1ZGUtYmFja2VkIG1lbWJlcnMgb2YgdGhlIHRyaW8gcmVzb2x2ZS5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQ0xBVURFX01PREVMX1FVT1JVTSA9IERFRkFVTFRfQ0xBVURFX01PREVMX1RPUF9USUVSO1xuXG4vKipcbiAqIFRoZSB0d28gZHJhZnRpbmcgcHJvdmlkZXJzIG9mIGEgUXVvcnVtIHJ1biAoSXNzdWUgIzQxMTIpLlxuICpcbiAqIENsYXVkZS1vbmx5IGJ5IGRlZmF1bHQ6IHRoZSB3aXJpbmcgbGFuZHMgYWhlYWQgb2YgdGhlIG11bHRpLXZlbmRvclxuICogY3JlZGVudGlhbCB3b3JrLCBzbyBhbiB1bmNoYW5nZWQgZGVwbG95bWVudCBydW5zIGJvdGggcGxhbm5lcnMgb24gdGhlXG4gKiBwcm92aWRlciBpdCBhbHJlYWR5IGhhcyBjcmVkZW50aWFscyBmb3IuXG4gKlxuICogQSBmdW5jdGlvbiwgbm90IGEgdG9wLWxldmVsIGNvbnN0YW50OiBgYWdlbnRfcHJvdmlkZXIudHNgIGltcG9ydHMgdGhpc1xuICogbW9kdWxlIGJhY2ssIHNvIHJlYWRpbmcgYERFRkFVTFRfQUdFTlRfUFJPVklERVJfSURgIGF0IG1vZHVsZS1ldmFsdWF0aW9uXG4gKiB0aW1lIHRocm93cyBhIHRlbXBvcmFsLWRlYWQtem9uZSBlcnJvci4gRGVmZXJyaW5nIHRoZSByZWFkIHRvIGNhbGwgdGltZSDigJRcbiAqIHRoZSBzYW1lIHRoaW5nIGBidWlsZERlZmF1bHRXb3JrZXJDb25maWdgIGFscmVhZHkgZG9lcyDigJQga2VlcHMgdGhlIHNpbmdsZVxuICogc291cmNlIG9mIHRydXRoIHdpdGhvdXQgdGhlIGN5Y2xlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdFF1b3J1bVBsYW5uZXJzKCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFtERUZBVUxUX0FHRU5UX1BST1ZJREVSX0lELCBERUZBVUxUX0FHRU5UX1BST1ZJREVSX0lEXTtcbn1cblxuLyoqIFRoZSBhZGp1ZGljYXRpbmcgcHJvdmlkZXIgb2YgYSBRdW9ydW0gcnVuIOKAlCBDbGF1ZGUgYnkgZGVmYXVsdCAoIzQxMTIpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlZmF1bHRRdW9ydW1KdWRnZSgpOiBzdHJpbmcge1xuICByZXR1cm4gREVGQVVMVF9BR0VOVF9QUk9WSURFUl9JRDtcbn1cblxuLyoqXG4gKiBJc3N1ZSAoY29kaW5nL2ltcGxlbWVudGF0aW9uKSBwaGFzZSBtb2RlbCDigJQgdGhlIFNvbm5ldCBtYW5hZ2VyIChlZmZvcnQ6XG4gKiBoaWdoKS5cbiAqXG4gKiBUaGUgY29kaW5nIHJ1biByb3V0ZXMgdGhyb3VnaCBgcGhhc2U6IFwiaXNzdWVcImAsIHNvIHRoaXMgcGlucyB0aGVcbiAqIGltcGxlbWVudGF0aW9uIHRpZXIgZXhwbGljaXRseSByYXRoZXIgdGhhbiByZWx5aW5nIG9uIHRoZSBDTEkgZGVmYXVsdC4gU2luY2VcbiAqIHRoZSBvd25lcidzIGRlY2lzaW9uIG9uICMzNDczIHRoZSBydW4gaXMgU29ubmV0IG1hbmFnaW5nIEhhaWt1IGV4ZWN1dG9yc1xuICogKHtAbGluayBPUEVSQVRJT05BTF9ERUZBVUxUU30uaXNzdWVTdWJBZ2VudFRpZXIpLCB3aXRoIHRoZSBQUiByZXZpZXdlciBvblxuICogT3B1czogYW4gT3B1cyBtYW5hZ2VyIGNvc3QgYWJvdXQgYSB3aG9sZSBzb2xvIE9wdXMgcnVuIG9uIGl0cyBvd24sIHNvIHRoZVxuICogc3Vic2NyaXB0aW9uIHJhbiBvdXQgYW5kIHRoZSBmbGVldCBmZWxsIGJhY2sgdG8gRGVlcFNlZWssIHdoaWxlIHRoZSBPcHVzXG4gKiByZXZpZXcgaXMgd2hhdCBrZWVwcyBtZXJnZWQgcXVhbGl0eSBoaWdoLiBgcGhhc2VfbW9kZWxfb3ZlcnJpZGVzLmlzc3VlOlxuICogXCJvcHVzXCJgIHJlc3RvcmVzIHRoZSBPcHVzIG1hbmFnZXIuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NMQVVERV9NT0RFTF9JU1NVRSA9IFwic29ubmV0XCIgYXMgY29uc3Q7XG5cbi8qKlxuICogUmVmaW5lbWVudCBwaGFzZSBtb2RlbCDigJQgT3B1cyB0b3AgdGllciAoZWZmb3J0OiBoaWdoLCBJc3N1ZXMgIzMyMjksICMyNTYwKS5cbiAqIEEgcGxhbm5pbmctc2hhcGVkIHBoYXNlOiB0aGUgVmliZSBDb2RlciBpbnRlcnByZXRzIHRoZSB1c2VyJ3Mgd29yZHMgaW50byBhblxuICogaW1wbGVtZW50YWJsZSBzdGF0ZS4gRWZmb3J0LCBub3QgdGllciwgaXMgd2hhdCBtYXJrcyBpdCBvdXQuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NMQVVERV9NT0RFTF9SRUZJTkVNRU5UID0gREVGQVVMVF9DTEFVREVfTU9ERUxfVE9QX1RJRVI7XG5cbi8qKiBDSSBmaXggcGhhc2UgbW9kZWwg4oCUIFNvbm5ldCAoZWZmb3J0OiBoaWdoLCBJc3N1ZSAjMjgxMikuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9DTEFVREVfTU9ERUxfQ0lfRklYID0gXCJzb25uZXRcIiBhcyBjb25zdDtcblxuLyoqXG4gKiBSZXZpc2lvbiBwaGFzZSBtb2RlbCDigJQgT3B1cyB0b3AgdGllciAoZWZmb3J0OiBoaWdoLCBJc3N1ZXMgIzMyMjksICMyNTYwKS5cbiAqIEEgcGxhbm5pbmctc2hhcGVkIHBoYXNlOiB0aGUgVmliZSBDb2RlciBpbnRlcnByZXRzIHRoZSB1c2VyJ3Mgd29yZHMgaW50byBhblxuICogaW1wbGVtZW50YWJsZSBzdGF0ZS4gRWZmb3J0LCBub3QgdGllciwgaXMgd2hhdCBtYXJrcyBpdCBvdXQuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NMQVVERV9NT0RFTF9SRVZJU0lPTiA9IERFRkFVTFRfQ0xBVURFX01PREVMX1RPUF9USUVSO1xuXG4vKiogUFIgZmVlZGJhY2sgcGhhc2UgbW9kZWwg4oCUIFNvbm5ldCAoZWZmb3J0OiBoaWdoLCBJc3N1ZSAjMjgxMikuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9DTEFVREVfTU9ERUxfUFJfRkVFREJBQ0sgPSBcInNvbm5ldFwiIGFzIGNvbnN0O1xuXG4vKiogUXVhbGl0eSBmaXggcGhhc2UgbW9kZWwg4oCUIFNvbm5ldCAoZWZmb3J0OiBoaWdoLCBJc3N1ZSAjMjgxMikuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9DTEFVREVfTU9ERUxfUVVBTElUWV9GSVggPSBcInNvbm5ldFwiIGFzIGNvbnN0O1xuXG4vKipcbiAqIFF1ZXN0aW9uIHBoYXNlIG1vZGVsIOKAlCBPcHVzIHRvcCB0aWVyIChlZmZvcnQ6IGhpZ2gsIElzc3VlcyAjMzIyOSwgIzI1NjApLlxuICogQSBwbGFubmluZy1zaGFwZWQgcGhhc2U6IHRoZSBWaWJlIENvZGVyIGludGVycHJldHMgdGhlIHVzZXIncyB3b3JkcyBpbnRvIGFuXG4gKiBpbXBsZW1lbnRhYmxlIHN0YXRlLiBFZmZvcnQsIG5vdCB0aWVyLCBpcyB3aGF0IG1hcmtzIGl0IG91dC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQ0xBVURFX01PREVMX1FVRVNUSU9OID0gREVGQVVMVF9DTEFVREVfTU9ERUxfVE9QX1RJRVI7XG5cbi8qKlxuICogQ2xhcmlmaWNhdGlvbiBwaGFzZSBtb2RlbCDigJQgT3B1cyB0b3AgdGllciAoZWZmb3J0OiBoaWdoLCBJc3N1ZXMgIzMyMjksICMyNTYwKS5cbiAqIEEgcGxhbm5pbmctc2hhcGVkIHBoYXNlOiB0aGUgVmliZSBDb2RlciBpbnRlcnByZXRzIHRoZSB1c2VyJ3Mgd29yZHMgaW50byBhblxuICogaW1wbGVtZW50YWJsZSBzdGF0ZS4gRWZmb3J0LCBub3QgdGllciwgaXMgd2hhdCBtYXJrcyBpdCBvdXQuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NMQVVERV9NT0RFTF9DTEFSSUZJQ0FUSU9OID0gREVGQVVMVF9DTEFVREVfTU9ERUxfVE9QX1RJRVI7XG5cbi8qKlxuICogU3BlbGxpbmcgZml4IHBoYXNlIG1vZGVsIOKAlCBIYWlrdSAoc2Vjb25kYXJ5IHRpZXIgbGV2ZXIsIGVmZm9ydDogbG93KS5cbiAqIFNpbXBsZXN0LCBsb3dlc3Qtdm9sdW1lIHRhc2s7IHRoZSB+NcOXIE9wdXMgcHJlbWl1bSBidXlzIG5vdGhpbmcgaGVyZS5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQ0xBVURFX01PREVMX1NQRUxMSU5HX0ZJWCA9IFwiaGFpa3VcIiBhcyBjb25zdDtcblxuLyoqXG4gKiBTdW1tYXJpc2UgcGhhc2UgbW9kZWwg4oCUIEhhaWt1IChzZWNvbmRhcnkgdGllciBsZXZlciwgZWZmb3J0OiBsb3cpLlxuICogTGlnaHR3ZWlnaHQgY29tcHJlc3Npb24sIGJ1dCBmZWQgdGhlIGxhcmdlc3QgaW5wdXRzICh3aG9sZSBzZXNzaW9ucyk7IHRoZVxuICogIzIzOTMgZXNjYWxhdGlvbiBsaWZ0cyBpdCB0byBhIDFNLXdpbmRvdyB0aWVyIHdoZW4gYW4gaW5wdXQgd291bGQgdHJ1bmNhdGUuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NMQVVERV9NT0RFTF9TVU1NQVJJU0UgPSBcImhhaWt1XCIgYXMgY29uc3Q7XG5cbi8qKlxuICogSGVhbHRoIGNoZWNrIHBoYXNlIG1vZGVsIOKAlCBIYWlrdSAoc2Vjb25kYXJ5IHRpZXIgbGV2ZXIsIGVmZm9ydDogbG93KS5cbiAqIFRyaXZpYWwgcHJlLWZsaWdodCAoXCJSZXNwb25kIHdpdGggZXhhY3RseTogT0tcIikgcnVuIGZyZXF1ZW50bHkg4oCUIGtlZXAgY2hlYXAuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NMQVVERV9NT0RFTF9IRUFMVEggPSBcImhhaWt1XCIgYXMgY29uc3Q7XG5cbi8qKlxuICogTW9kZWwgdGllciBmYWxsYmFjayBtYXBwaW5nIChJc3N1ZSAjMTExMiwgIzI2MTkpLlxuICpcbiAqIE1hcHMgZWFjaCBtb2RlbCB0aWVyIHRvIGl0cyBuZXh0LWNoZWFwZXIgYWx0ZXJuYXRpdmUuXG4gKiBVc2VkIGJ5IHRoZSBidWRnZXQtZXhjZWVkZWQgZmFsbGJhY2sgZmVhdHVyZSB0byBkb3duZ3JhZGUgbW9kZWxzLlxuICogRmFibGUgNSBpcyB0aGUgdG9wIHRpZXIgYWJvdmUgT3B1cywgc28gdGhlIGNoYWluIGRlZ3JhZGVzXG4gKiBmYWJsZSDihpIgb3B1cyDihpIgc29ubmV0IOKGkiBoYWlrdS5cbiAqL1xuZXhwb3J0IGNvbnN0IE1PREVMX0ZBTExCQUNLX01BUDogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nIHwgbnVsbD4+ID0ge1xuICBmYWJsZTogXCJvcHVzXCIsXG4gIG9wdXM6IFwic29ubmV0XCIsXG4gIHNvbm5ldDogXCJoYWlrdVwiLFxuICBoYWlrdTogbnVsbCxcbn0gYXMgY29uc3Q7XG5cbi8qKlxuICogTG9vayB1cCB0aGUgY2hlYXBlciBmYWxsYmFjayBtb2RlbCBmb3IgYSBnaXZlbiBtb2RlbCBzdHJpbmcuXG4gKlxuICogSGFuZGxlcyBib3RoIHNob3J0IG5hbWVzIChlLmcuIFwib3B1c1wiKSBhbmQgZnVsbCBtb2RlbCBJRHNcbiAqIChlLmcuIFwiY2xhdWRlLW9wdXMtNC03XCIpLiBSZXR1cm5zIG51bGwgaWYgbm8gY2hlYXBlciBtb2RlbFxuICogZXhpc3RzIG9yIHRoZSBtb2RlbCBpcyB1bnJlY29nbmlzZWQuXG4gKlxuICogSXNzdWUgIzExMTI6IEZvdW5kYXRpb25hbCB1dGlsaXR5IGZvciBidWRnZXQtZXhjZWVkZWQgZmFsbGJhY2suXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRDaGVhcGVyTW9kZWwoY3VycmVudE1vZGVsOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgLy8gRGlyZWN0IG1hdGNoIG9uIHNob3J0IG5hbWVcbiAgaWYgKGN1cnJlbnRNb2RlbCBpbiBNT0RFTF9GQUxMQkFDS19NQVApIHtcbiAgICByZXR1cm4gTU9ERUxfRkFMTEJBQ0tfTUFQW2N1cnJlbnRNb2RlbF0gPz8gbnVsbDtcbiAgfVxuXG4gIC8vIFRyeSB0byBleHRyYWN0IHRpZXIgZnJvbSBmdWxsIG1vZGVsIElEIChlLmcuIFwiY2xhdWRlLW9wdXMtNC02XCIpXG4gIGZvciAoY29uc3QgdGllciBvZiBPYmplY3Qua2V5cyhNT0RFTF9GQUxMQkFDS19NQVApKSB7XG4gICAgaWYgKFxuICAgICAgY3VycmVudE1vZGVsLmluY2x1ZGVzKGAtJHt0aWVyfS1gKSB8fCBjdXJyZW50TW9kZWwuaW5jbHVkZXMoYC0ke3RpZXJ9YClcbiAgICApIHtcbiAgICAgIHJldHVybiBNT0RFTF9GQUxMQkFDS19NQVBbdGllcl0gPz8gbnVsbDtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBQaGFzZS1zcGVjaWZpYyBtb2RlbCBkZWZhdWx0cyAoSXNzdWUgIzEwNzEsICMyMzkxKS5cbiAqXG4gKiBNYXBzIHBoYXNlIG5hbWVzIHRvIHRoZWlyIGRlZmF1bHQgbW9kZWwuIFBoYXNlcyBub3QgbGlzdGVkIGhlcmVcbiAqIGZhbGwgYmFjayB0byB0aGUgYmFzZSBDTEFVREVfTU9ERUwgZW52IHZhciAob3Igbm8gbW9kZWwgYXJncykuXG4gKlxuICogUm91dGluZyAoSXNzdWVzICMyMzkxLCAjMjYyMSwgIzMyMjksICMyNTYwKTogZWZmb3J0IChQSEFTRV9FRkZPUlRfREVGQVVMVFMpXG4gKiBpcyB0aGUgKnByaW1hcnkqIGNvc3QgbGV2ZXI7IG1vZGVsIHRpZXIgaXMgdGhlICpzZWNvbmRhcnkqIGxldmVyLCBhbmQgc2luY2VcbiAqICMyNTYwIGl0IGlzIGFwcGxpZWQgYXQgdGhlIGNoZWFwIGVuZCBvbmx5LiBUaGUgZWlnaHQgcGxhbm5pbmctc2hhcGVkXG4gKiBwaGFzZXMgKHBsYW5uaW5nLCBncmlsbF9tZSwgcmVmaW5lbWVudCwgcmV2aXNpb24sIHF1ZXN0aW9uLCBjbGFyaWZpY2F0aW9uLFxuICogcXVvcnVtLCBxdW9ydW1fanVkZ2UpIHJ1biBvbiBPcHVzIGF0IFwiaGlnaFwiIGVmZm9ydCwgYmVjYXVzZSB3aGVyZXZlciB0aGVcbiAqIFZpYmUgQ29kZXIgaW50ZXJwcmV0cyB0aGUgdXNlcidzIHdvcmRzIGludG8gYW4gaW1wbGVtZW50YWJsZSBzdGF0ZSBhIGJldHRlclxuICogaW50ZXJwcmV0YXRpb24gY29tcG91bmRzIGFjcm9zcyBldmVyeSBkb3duc3RyZWFtIHN1Yi1pc3N1ZSBhbmQgUFIgKCMyNjIxLFxuICogIzMyMjkpOyBgaXNzdWVgIHJ1bnMgb24gT3B1cyB0b28uIFRoZSByZWFjdGl2ZSBwaGFzZXMgKGNpX2ZpeCwgcHJfZmVlZGJhY2ssXG4gKiBxdWFsaXR5X2ZpeCkgcnVuIG9uIFNvbm5ldCBhdCBcImhpZ2hcIiAoIzI4MTIpLiBUaGUgdGhyZWUgdHJpdmlhbCBwaGFzZXNcbiAqIChzcGVsbGluZ19maXgsIHN1bW1hcmlzZSwgaGVhbHRoKSBzdGF5IG9uIHRoZSBjaGVhcGVyIEhhaWt1IHRpZXIuIFRoZSBtYXBcbiAqIHN0YXlzIHBvcHVsYXRlZCAocmF0aGVyIHRoYW4gZW1wdHkpIHNvIGVhY2ggcGhhc2UgaXMgZXhwbGljaXRseSBwaW5uZWRcbiAqIHJlZ2FyZGxlc3Mgb2YgdGhlIENMSSdzIG93biBkZWZhdWx0LCB3aGlsZSB0aGUgb3ZlcnJpZGUgY2hhaW4ga2VlcHMgdGllclxuICogZnVsbHkgdHVuYWJsZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFBIQVNFX01PREVMX0RFRkFVTFRTOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiA9XG4gIG1vZGVsc0ZvclBoYXNlVGllcnMoe1xuICAgIGJlc3Q6IERFRkFVTFRfQ0xBVURFX01PREVMX1RPUF9USUVSLFxuICAgIHN0YW5kYXJkOiBERUZBVUxUX0NMQVVERV9NT0RFTF9JU1NVRSxcbiAgICBmYXN0OiBERUZBVUxUX0NMQVVERV9NT0RFTF9IRUFMVEgsXG4gIH0pO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENvZGV4IHBlci1waGFzZSByb3V0aW5nIChJc3N1ZSAjMzYzLCBwYXJlbnQgIzM1Nylcbi8vXG4vLyBUaGUgQ29kZXggQ0xJIGhhcyBib3RoIGxldmVycyBDbGF1ZGUgaGFzIOKAlCBgLS1tb2RlbGAgYW5kXG4vLyBgLWMgbW9kZWxfcmVhc29uaW5nX2VmZm9ydD3igKZgIOKAlCBzbyB0aGUgcGhhc2UgY29zdCBkZXNpZ24gZG9jdW1lbnRlZCBpblxuLy8gZG9jcy9NT0RFTC1BTkQtQ0FDSElORy5tZCBhcHBsaWVzIHRvIGl0IHVuY2hhbmdlZDogZWZmb3J0IGlzIHRoZSBwcmltYXJ5XG4vLyBsZXZlciwgbW9kZWwgdGllciB0aGUgc2Vjb25kYXJ5IG9uZSBhcHBsaWVkIGF0IGJvdGggZXh0cmVtZXMuIFRoZSB0YWJsZXNcbi8vIGJlbG93IHRoZXJlZm9yZSBtaXJyb3IgUEhBU0VfTU9ERUxfREVGQVVMVFMgLyBQSEFTRV9FRkZPUlRfREVGQVVMVFMga2V5IGZvclxuLy8ga2V5LCB3aXRoIENvZGV4IG1vZGVsIGlkcyBhbmQgQ29kZXggZWZmb3J0IHZhbHVlcyBzdWJzdGl0dXRlZC5cbi8vXG4vLyBUaGUgbW9kZWwgaWRzIGFyZSBhbiBpbXBsZW1lbnRhdGlvbiBkZWNpc2lvbiAoSXNzdWUgIzM2MyBsZWF2ZXMgdGhlIFwiY29ycmVjdFwiXG4vLyBpZHMgb3Blbik6IGEgc2FuZSBjaGVhcC9iYXNlL3RvcCBtYXBwaW5nIG92ZXIgdGhlIGN1cnJlbnQgQ29kZXgtY2FwYWJsZVxuLy8gT3BlbkFJIGxpbmUtdXAuIEV4cGxpY2l0IGNvbmZpZ3VyYXRpb24gYWx3YXlzIG92ZXJyaWRlcyB0aGVtIOKAlCBhXG4vLyBgQ09ERVhfTU9ERUxfPFBIQVNFPmAgZW52IHZhciwgYSBwZXItcmVwbyBgY29kZXhfcGhhc2VfbW9kZWxfb3ZlcnJpZGVzYFxuLy8gZW50cnksIGEgcGVyLXJlcG8gYGNvZGV4X21vZGVsYCBiYXNlIHRpZXIsIG9yIGEgZ2xvYmFsXG4vLyBgY29kZXhfcGhhc2VfbW9kZWxfb3ZlcnJpZGVzYCBlbnRyeSDigJQgc28gYSBkZXBsb3ltZW50IG9uIGEgZGlmZmVyZW50IGxpbmUtdXBcbi8vIHJlLXBpbnMgdGhlIHRpZXIgd2l0aG91dCBhIGNvZGUgY2hhbmdlLlxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogVG9wIENvZGV4IG1vZGVsIHRpZXIg4oCUIENvZGV4J3MgT3B1cyAoSXNzdWUgIzM2Mzsgb3duZXIgZGVjaXNpb25cbiAqIDIwMjYtMTAtMjIpLlxuICpcbiAqIGBncHQtNi1hc3RyYWAsIFwiZnJvbnRpZXIgaW50ZWxsaWdlbmNlIGZvciB0aGUgbW9zdCBkZW1hbmRpbmcgd29ya1wiIGluIHRoZVxuICogYWNjb3VudCdzIENvZGV4IG1vZGVscyBjYXRhbG9ndWUuIFJlc2VydmVkIGZvciB0aGUgcGxhbm5pbmctc2hhcGVkIHBoYXNlc1xuICogYW5kIHRoZSByZXZpZXdlciByb2xlLCB3aGVyZSBhIGJldHRlciBqdWRnZW1lbnQgY29tcG91bmRzIGFjcm9zcyBldmVyeVxuICogZG93bnN0cmVhbSBzdWItaXNzdWUgYW5kIFBSLiBUaGUgYGdwdC01KmAgaWRzIHRoaXMgcmVwbGFjZWQgd2VyZSByZWZ1c2VkIGJ5XG4gKiB0aGUgQ2hhdEdQVCBsb2dpbiAoSXNzdWUgIzQwMTkpLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9DT0RFWF9NT0RFTF9UT1BfVElFUiA9IFwiZ3B0LTYtYXN0cmFcIiBhcyBjb25zdDtcblxuLyoqXG4gKiBCYXNlIENvZGV4IG1vZGVsIHRpZXIg4oCUIENvZGV4J3MgU29ubmV0IChJc3N1ZSAjMzYzOyBvd25lciBkZWNpc2lvblxuICogMjAyNi0xMC0yMikuXG4gKlxuICogYGdwdC02LjEtc29sYCwgdGhlIGNhdGFsb2d1ZSdzIFwibGF0ZXN0IHdvcmtob3JzZSBtb2RlbFwiLiBUaGUgYGlzc3VlYFxuICogbWFuYWdlciBhbmQgZXZlcnkgbm9uLWV4dHJlbWUgcGhhc2UgcnVuIG9uIGl0LCBkaWZmZXJlbnRpYXRlZCBieSBlZmZvcnRcbiAqIHJhdGhlciB0aGFuIGJ5IHRpZXIuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NPREVYX01PREVMID0gXCJncHQtNi4xLXNvbFwiIGFzIGNvbnN0O1xuXG4vKipcbiAqIENoZWFwIENvZGV4IG1vZGVsIHRpZXIg4oCUIENvZGV4J3MgSGFpa3UgKElzc3VlICMzNjM7IG93bmVyIGRlY2lzaW9uXG4gKiAyMDI2LTEwLTIyKS5cbiAqXG4gKiBgZ3B0LTYtbHVuYWAsIHRoZSBjYXRhbG9ndWUncyBcImZhc3QgYW5kIGFmZm9yZGFibGUgbW9kZWwgZm9yIGVhc2llclxuICogdGFza3NcIi4gVGhlIGV4ZWN1dG9yIHJvbGUgYW5kIHRoZSB0aHJlZSB0cml2aWFsIHBoYXNlcyAoYHNwZWxsaW5nX2ZpeGAsXG4gKiBgc3VtbWFyaXNlYCwgYGhlYWx0aGApIHJ1biBvbiBpdC4gVGhlIGZsYWdzaGlwIHByZW1pdW0gYnV5cyBub3RoaW5nIG9uIGFcbiAqIHR5cG8gZml4LlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9DT0RFWF9NT0RFTF9DSEVBUF9USUVSID0gXCJncHQtNi1sdW5hXCIgYXMgY29uc3Q7XG5cbi8qKlxuICogUmVhc29uaW5nLWVmZm9ydCBsZXZlbHMgdGhlIENvZGV4IENMSSBhY2NlcHRzIGZvclxuICogYC1jIG1vZGVsX3JlYXNvbmluZ19lZmZvcnQ94oCmYCAoSXNzdWUgIzM2MykuXG4gKlxuICogRm91ciBsZXZlbHMsIG5vdCBDbGF1ZGUncyBmaXZlOiBDb2RleCBoYXMgYG1pbmltYWxgIGJlbG93IGBsb3dgIGFuZCBub3RoaW5nXG4gKiBhYm92ZSBgaGlnaGAsIHNvIENsYXVkZSdzIGB4aGlnaGAvYG1heGAgaGF2ZSBubyBDb2RleCBlcXVpdmFsZW50IGFuZCB0aGVcbiAqIHBsYW5uaW5nLXNoYXBlZCBwaGFzZXMgdG9wIG91dCBhdCBgaGlnaGAuXG4gKi9cbmV4cG9ydCBjb25zdCBDT0RFWF9FRkZPUlRfTEVWRUxTID0ge1xuICBtaW5pbWFsOiBcIm1pbmltYWxcIixcbiAgbG93OiBcImxvd1wiLFxuICBtZWRpdW06IFwibWVkaXVtXCIsXG4gIGhpZ2g6IFwiaGlnaFwiLFxufSBhcyBjb25zdDtcblxuLyoqXG4gKiBQZXItcGhhc2UgQ29kZXggbW9kZWwgZGVmYXVsdHMgKElzc3VlICMzNjMpLlxuICpcbiAqIFNhbWUgcGhhc2Uga2V5cyBhcyB7QGxpbmsgUEhBU0VfTU9ERUxfREVGQVVMVFN9LCBzYW1lIHRpZXIgZGVzaWduOiB0aGVcbiAqIHBsYW5uaW5nLXNoYXBlZCBwaGFzZXMgKHBsYW5uaW5nLCBncmlsbF9tZSwgYm90aCBRdW9ydW0gcGhhc2VzLCByZWZpbmVtZW50LFxuICogcmV2aXNpb24sIHF1ZXN0aW9uLCBjbGFyaWZpY2F0aW9uKSB0YWtlIHRoZSB0b3AgdGllcjsgdGhlIHRyaXZpYWwgdHJpbyB0YWtlc1xuICogdGhlIGNoZWFwIHRpZXI7IGV2ZXJ5dGhpbmcgZWxzZSBydW5zIG9uIHRoZSBiYXNlIHRpZXIgYW5kIHZhcmllcyBlZmZvcnQuXG4gKi9cbmV4cG9ydCBjb25zdCBDT0RFWF9QSEFTRV9NT0RFTF9ERUZBVUxUUzogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4gPVxuICBtb2RlbHNGb3JQaGFzZVRpZXJzKHtcbiAgICBiZXN0OiBERUZBVUxUX0NPREVYX01PREVMX1RPUF9USUVSLFxuICAgIHN0YW5kYXJkOiBERUZBVUxUX0NPREVYX01PREVMLFxuICAgIGZhc3Q6IERFRkFVTFRfQ09ERVhfTU9ERUxfQ0hFQVBfVElFUixcbiAgfSk7XG5cbi8qKlxuICogUGVyLXBoYXNlIENvZGV4IHJlYXNvbmluZy1lZmZvcnQgZGVmYXVsdHMgKElzc3VlICMzNjMpLlxuICpcbiAqIFNhbWUgcGhhc2Uga2V5cyBhbmQgdGhlIHNhbWUgdGllcmluZyBhcyB7QGxpbmsgUEhBU0VfRUZGT1JUX0RFRkFVTFRTfSxcbiAqIGNsYW1wZWQgdG8gdGhlIGZvdXIgbGV2ZWxzIENvZGV4IGFjY2VwdHM6IHRoZSBwbGFubmluZy1zaGFwZWQgcGhhc2VzIGFuZFxuICogYGlzc3VlYCBydW4gYXQgYGhpZ2hgLCB0aGUgcmVhY3RpdmUgcGhhc2VzIChpbmNsdWRpbmcgYG1lcmdlX2NvbmZsaWN0YCkgYXRcbiAqIGBtZWRpdW1gLCBhbmQgdGhlIHRyaXZpYWwgcGhhc2VzIHBsdXMgYGNvbXBhY3Rpb25gIGF0IGBsb3dgLlxuICovXG5leHBvcnQgY29uc3QgQ09ERVhfUEhBU0VfRUZGT1JUX0RFRkFVTFRTOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiA9IHtcbiAgcGxhbm5pbmc6IENPREVYX0VGRk9SVF9MRVZFTFMuaGlnaCxcbiAgZ3JpbGxfbWU6IENPREVYX0VGRk9SVF9MRVZFTFMuaGlnaCxcbiAgcXVvcnVtOiBDT0RFWF9FRkZPUlRfTEVWRUxTLmhpZ2gsXG4gIHF1b3J1bV9qdWRnZTogQ09ERVhfRUZGT1JUX0xFVkVMUy5oaWdoLFxuICByZWZpbmVtZW50OiBDT0RFWF9FRkZPUlRfTEVWRUxTLmhpZ2gsXG4gIHJldmlzaW9uOiBDT0RFWF9FRkZPUlRfTEVWRUxTLmhpZ2gsXG4gIHF1ZXN0aW9uOiBDT0RFWF9FRkZPUlRfTEVWRUxTLmhpZ2gsXG4gIGNsYXJpZmljYXRpb246IENPREVYX0VGRk9SVF9MRVZFTFMuaGlnaCxcbiAgaXNzdWU6IENPREVYX0VGRk9SVF9MRVZFTFMuaGlnaCxcbiAgY2lfZml4OiBDT0RFWF9FRkZPUlRfTEVWRUxTLm1lZGl1bSxcbiAgcHJfZmVlZGJhY2s6IENPREVYX0VGRk9SVF9MRVZFTFMubWVkaXVtLFxuICBxdWFsaXR5X2ZpeDogQ09ERVhfRUZGT1JUX0xFVkVMUy5tZWRpdW0sXG4gIC8vIElzc3VlICM0MTc0OiByZWFjdGl2ZSBjb2RlLCBzbyBtZWRpdW0gbGlrZSBjaV9maXgsIG5vdCB0aGUgaXNzdWUgbWFuYWdlcidzIGhpZ2guXG4gIG1lcmdlX2NvbmZsaWN0OiBDT0RFWF9FRkZPUlRfTEVWRUxTLm1lZGl1bSxcbiAgc3BlbGxpbmdfZml4OiBDT0RFWF9FRkZPUlRfTEVWRUxTLmxvdyxcbiAgc3VtbWFyaXNlOiBDT0RFWF9FRkZPUlRfTEVWRUxTLmxvdyxcbiAgaGVhbHRoOiBDT0RFWF9FRkZPUlRfTEVWRUxTLmxvdyxcbiAgLy8gSXNzdWUgIzQxNzQ6IGEgc3VtbWFyaXNpbmcgdHVybiwgbG93IGxpa2Ugc3VtbWFyaXNlLlxuICBjb21wYWN0aW9uOiBDT0RFWF9FRkZPUlRfTEVWRUxTLmxvdyxcbn0gYXMgY29uc3Q7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gR2VtaW5pIHBlci1waGFzZSByb3V0aW5nIChJc3N1ZSAjMzY0LCBwYXJlbnQgIzM1Nylcbi8vXG4vLyBUaGUgR2VtaW5pIENMSSBoYXMgb25lIG9mIHRoZSB0d28gbGV2ZXJzOiBgLS1tb2RlbGAsIGJ1dCBub1xuLy8gcmVhc29uaW5nLWVmZm9ydCBvcHRpb24gYXQgYWxsLiBUaGUgbW9kZWwgaGFsZiBvZiB0aGUgcGhhc2UgY29zdCBkZXNpZ25cbi8vIGRvY3VtZW50ZWQgaW4gZG9jcy9NT0RFTC1BTkQtQ0FDSElORy5tZCB0aGVyZWZvcmUgYXBwbGllcyB1bmNoYW5nZWQsIGFuZCB0aGVcbi8vIHRhYmxlIGJlbG93IG1pcnJvcnMgUEhBU0VfTU9ERUxfREVGQVVMVFMga2V5IGZvciBrZXkgd2l0aCBHZW1pbmkgbW9kZWwgaWRzLlxuLy8gVGhlcmUgaXMgZGVsaWJlcmF0ZWx5IG5vIEdFTUlOSV9QSEFTRV9FRkZPUlRfREVGQVVMVFM6IGEgdGFibGUgb2YgZWZmb3J0c1xuLy8gdGhlIENMSSBjYW4gbmV2ZXIgYXBwbHkgd291bGQgYmUgZGVhZCBjb25maWd1cmF0aW9uLiBBbiBlZmZvcnQgdGhhdCBpc1xuLy8gbm9uZXRoZWxlc3MgcmVxdWVzdGVkIGZvciBhIEdlbWluaSBwaGFzZSBpcyByZXBvcnRlZCBsb3VkbHkgYnlcbi8vIGBnZW1pbmlfZXhlY3V0b3IudHNgIHJhdGhlciB0aGFuIGRyb3BwZWQgaW4gc2lsZW5jZSAoSXNzdWUgIzMyMzQpLlxuLy9cbi8vIFRoZSBtb2RlbCBpZHMgYXJlIGFuIGltcGxlbWVudGF0aW9uIGRlY2lzaW9uIChJc3N1ZSAjMzY0IGxlYXZlcyB0aGVcbi8vIFwiY29ycmVjdFwiIGlkcyBvcGVuKTogYSBzYW5lIGNoZWFwL2Jhc2UvdG9wIG1hcHBpbmcgb3ZlciB0aGUgY3VycmVudCBHZW1pbmlcbi8vIGxpbmUtdXAuIEV4cGxpY2l0IGNvbmZpZ3VyYXRpb24gYWx3YXlzIG92ZXJyaWRlcyB0aGVtIOKAlCBhXG4vLyBgR0VNSU5JX01PREVMXzxQSEFTRT5gIGVudiB2YXIsIGEgcGVyLXJlcG8gYGdlbWluaV9waGFzZV9tb2RlbF9vdmVycmlkZXNgXG4vLyBlbnRyeSwgYSBwZXItcmVwbyBgZ2VtaW5pX21vZGVsYCBiYXNlIHRpZXIsIG9yIGEgZ2xvYmFsXG4vLyBgZ2VtaW5pX3BoYXNlX21vZGVsX292ZXJyaWRlc2AgZW50cnkg4oCUIHNvIGEgZGVwbG95bWVudCBvbiBhIGRpZmZlcmVudFxuLy8gbGluZS11cCByZS1waW5zIHRoZSB0aWVyIHdpdGhvdXQgYSBjb2RlIGNoYW5nZS5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFRvcCBHZW1pbmkgbW9kZWwgdGllciDigJQgdGhlIHJlYXNvbmluZyBmbGFnc2hpcCAoSXNzdWUgIzM2NCkuXG4gKlxuICogUmVzZXJ2ZWQgZm9yIHRoZSBwbGFubmluZy1zaGFwZWQgcGhhc2VzLCB3aGVyZSB0aGUgVmliZSBDb2RlciBpbnRlcnByZXRzIHRoZVxuICogdXNlcidzIHdvcmRzIGludG8gYW4gaW1wbGVtZW50YWJsZSBzdGF0ZSBhbmQgYSBiZXR0ZXIgaW50ZXJwcmV0YXRpb25cbiAqIGNvbXBvdW5kcyBhY3Jvc3MgZXZlcnkgZG93bnN0cmVhbSBzdWItaXNzdWUgYW5kIFBSLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9HRU1JTklfTU9ERUxfVE9QX1RJRVIgPSBcImdlbWluaS0yLjUtcHJvXCIgYXMgY29uc3Q7XG5cbi8qKlxuICogQmFzZSBHZW1pbmkgbW9kZWwgdGllciAoSXNzdWUgIzM2NCkg4oCUIHRoZSBnZW5lcmFsLXB1cnBvc2UgbW9kZWwgZXZlcnlcbiAqIG5vbi1leHRyZW1lIHBoYXNlIHJ1bnMgb24uIEdlbWluaSBoYXMgbm8gZWZmb3J0IGxldmVyIHRvIGRpZmZlcmVudGlhdGUgdGhlbVxuICogZnVydGhlciwgc28gdGhlIHRpZXIgaXRzZWxmIGNhcnJpZXMgdGhlIHdob2xlIHJvdXRpbmcgZGVjaXNpb24uXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0dFTUlOSV9NT0RFTCA9IFwiZ2VtaW5pLTIuNS1mbGFzaFwiIGFzIGNvbnN0O1xuXG4vKipcbiAqIENoZWFwIEdlbWluaSBtb2RlbCB0aWVyIChJc3N1ZSAjMzY0KSDigJQgdGhlIHNtYWxsIG1vZGVsIHRoZSB0aHJlZSB0cml2aWFsXG4gKiBwaGFzZXMgKGBzcGVsbGluZ19maXhgLCBgc3VtbWFyaXNlYCwgYGhlYWx0aGApIHJ1biBvbiwgbWlycm9yaW5nIENsYXVkZSdzXG4gKiBIYWlrdSB0aWVyLiBUaGUgZmxhZ3NoaXAgcHJlbWl1bSBidXlzIG5vdGhpbmcgb24gYSB0eXBvIGZpeC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfR0VNSU5JX01PREVMX0NIRUFQX1RJRVIgPSBcImdlbWluaS0yLjUtZmxhc2gtbGl0ZVwiIGFzIGNvbnN0O1xuXG4vKipcbiAqIFBlci1waGFzZSBHZW1pbmkgbW9kZWwgZGVmYXVsdHMgKElzc3VlICMzNjQpLlxuICpcbiAqIFNhbWUgcGhhc2Uga2V5cyBhcyB7QGxpbmsgUEhBU0VfTU9ERUxfREVGQVVMVFN9LCBzYW1lIHRpZXIgZGVzaWduOiB0aGVcbiAqIHBsYW5uaW5nLXNoYXBlZCBwaGFzZXMgKHBsYW5uaW5nLCBncmlsbF9tZSwgYm90aCBRdW9ydW0gcGhhc2VzLCByZWZpbmVtZW50LFxuICogcmV2aXNpb24sIHF1ZXN0aW9uLCBjbGFyaWZpY2F0aW9uKSB0YWtlIHRoZSB0b3AgdGllcjsgdGhlIHRyaXZpYWwgdHJpbyB0YWtlc1xuICogdGhlIGNoZWFwIHRpZXI7IGV2ZXJ5dGhpbmcgZWxzZSBydW5zIG9uIHRoZSBiYXNlIHRpZXIuXG4gKi9cbmV4cG9ydCBjb25zdCBHRU1JTklfUEhBU0VfTU9ERUxfREVGQVVMVFM6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+ID1cbiAgbW9kZWxzRm9yUGhhc2VUaWVycyh7XG4gICAgYmVzdDogREVGQVVMVF9HRU1JTklfTU9ERUxfVE9QX1RJRVIsXG4gICAgc3RhbmRhcmQ6IERFRkFVTFRfR0VNSU5JX01PREVMLFxuICAgIGZhc3Q6IERFRkFVTFRfR0VNSU5JX01PREVMX0NIRUFQX1RJRVIsXG4gIH0pO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIERlZXBTZWVrIHBlci1waGFzZSByb3V0aW5nIChJc3N1ZSAjNDEzLCBwYXJlbnQgIzM5Nilcbi8vXG4vLyBEZWVwU2VlayBpcyBjYXJyaWVkIG9uIHRoZSAqQ2xhdWRlKiBDTEksIHNvIGl0cyBhcmd2IHNoYXBlIGlzIENsYXVkZSdzIOKAlCBhbmRcbi8vIENsYXVkZSdzIHJvdXRpbmcgcmVzb2x2ZXMgdG8gdGllciBhbGlhc2VzIChgZmFibGVgLCBgb3B1c2AsIGBzb25uZXRgLFxuLy8gYGhhaWt1YCksIHdoaWNoIERlZXBTZWVrJ3MgZW5kcG9pbnQgY2Fubm90IHJlc29sdmUuIEEgcHJvdmlkZXIgd2l0aCBub1xuLy8gcm91dGluZyBvZiBpdHMgb3duIHdvdWxkIHRoZXJlZm9yZSBzZW5kIGFuIEFudGhyb3BpYyB0aWVyIGFsaWFzIHRvIGFcbi8vIHRoaXJkLXBhcnR5IGVuZHBvaW50IGFuZCBmYWlsIG1pZC1ydW4sIHNvIGV2ZXJ5IHBoYXNlIGlzIHBpbm5lZCBoZXJlIHRvIGFcbi8vIHJlYWwgRGVlcFNlZWsgbW9kZWwgaWQuXG4vL1xuLy8gVGhlIENMSSdzIGAtLWVmZm9ydGAgZmxhZyBpcyBub3QgcmVhY2hhYmxlIGVpdGhlcjogRGVlcFNlZWsnc1xuLy8gQW50aHJvcGljLWNvbXBhdGlibGUgZW5kcG9pbnQgZG9lcyBub3QgaW1wbGVtZW50IEFudGhyb3BpYydzIGVmZm9ydCBjb250cm9sLlxuLy8gVGhlcmUgaXMgZGVsaWJlcmF0ZWx5IG5vIERFRVBTRUVLX1BIQVNFX0VGRk9SVF9ERUZBVUxUUyBhbmQgbm8gRGVlcFNlZWtcbi8vIGVmZm9ydCBjb25maWcga2V5IOKAlCBlaXRoZXIgd291bGQgYmUgZGVhZCBjb25maWd1cmF0aW9uLiBBbiBlZmZvcnQgcmVxdWVzdGVkXG4vLyBmb3IgYSBEZWVwU2VlayBwaGFzZSBpcyByZXBvcnRlZCBsb3VkbHkgYnkgYGRlZXBzZWVrX2V4ZWN1dG9yLnRzYCByYXRoZXIgdGhhblxuLy8gZHJvcHBlZCBpbiBzaWxlbmNlIChJc3N1ZSAjMzIzNCksIHdoaWNoIGlzIHRoZSBHZW1pbmkgcHJlY2VkZW50IChJc3N1ZSAjMzY0KS5cbi8vXG4vLyBFeHBsaWNpdCBjb25maWd1cmF0aW9uIGFsd2F5cyBvdmVycmlkZXMgdGhlc2Ug4oCUIGEgYERFRVBTRUVLX01PREVMXzxQSEFTRT5gXG4vLyBlbnYgdmFyLCBhIHBlci1yZXBvIGBkZWVwc2Vla19waGFzZV9tb2RlbF9vdmVycmlkZXNgIGVudHJ5LCBhIHBlci1yZXBvXG4vLyBgZGVlcHNlZWtfbW9kZWxgIGJhc2UgdGllciwgb3IgYSBnbG9iYWwgYGRlZXBzZWVrX3BoYXNlX21vZGVsX292ZXJyaWRlc2Bcbi8vIGVudHJ5IOKAlCBzbyBhIGRlcGxveW1lbnQgb24gYSBkaWZmZXJlbnQgbGluZS11cCByZS1waW5zIHRoZSB0aWVyIHdpdGhvdXQgYVxuLy8gY29kZSBjaGFuZ2UuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBUb3AgRGVlcFNlZWsgbW9kZWwgdGllciDigJQgdGhlIHBybyBtb2RlbCAoSXNzdWUgIzQxMykuXG4gKlxuICogUmVzZXJ2ZWQgZm9yIHRoZSBwbGFubmluZy1zaGFwZWQgcGhhc2VzLCB3aGVyZSB0aGUgVmliZSBDb2RlciBpbnRlcnByZXRzIHRoZVxuICogdXNlcidzIHdvcmRzIGludG8gYW4gaW1wbGVtZW50YWJsZSBzdGF0ZSBhbmQgYSBiZXR0ZXIgaW50ZXJwcmV0YXRpb25cbiAqIGNvbXBvdW5kcyBhY3Jvc3MgZXZlcnkgZG93bnN0cmVhbSBzdWItaXNzdWUgYW5kIFBSLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9ERUVQU0VFS19NT0RFTF9UT1BfVElFUiA9IFwiZGVlcHNlZWstdjQtcHJvXCIgYXMgY29uc3Q7XG5cbi8qKlxuICogQmFzZSBEZWVwU2VlayBtb2RlbCB0aWVyIChJc3N1ZSAjNDEzKSDigJQgdGhlIGdlbmVyYWwtcHVycG9zZSBtb2RlbCBldmVyeVxuICogb3RoZXIgcGhhc2UgcnVucyBvbi4gRGVlcFNlZWsgaGFzIG5vIHVzYWJsZSBlZmZvcnQgbGV2ZXIsIHNvIHRoZSB0aWVyIGl0c2VsZlxuICogY2FycmllcyB0aGUgd2hvbGUgcm91dGluZyBkZWNpc2lvbi5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfREVFUFNFRUtfTU9ERUwgPSBcImRlZXBzZWVrLWZsYXNoXCIgYXMgY29uc3Q7XG5cbi8qKlxuICogUGVyLXBoYXNlIERlZXBTZWVrIG1vZGVsIGRlZmF1bHRzIChJc3N1ZSAjNDEzKS5cbiAqXG4gKiBTYW1lIHBoYXNlIGtleXMgYXMge0BsaW5rIFBIQVNFX01PREVMX0RFRkFVTFRTfTogdGhlIHBsYW5uaW5nLXNoYXBlZCBwaGFzZXNcbiAqIChwbGFubmluZywgZ3JpbGxfbWUsIGJvdGggUXVvcnVtIHBoYXNlcywgcmVmaW5lbWVudCwgcmV2aXNpb24sIHF1ZXN0aW9uLFxuICogY2xhcmlmaWNhdGlvbikgdGFrZSB0aGUgcmVhc29uaW5nIG1vZGVsOyBldmVyeXRoaW5nIGVsc2UgdGFrZXMgdGhlIGJhc2VcbiAqIHRpZXIuXG4gKlxuICogVGhlcmUgaXMgbm8gY2hlYXAgcnVuZyBoZXJlLCB1bmxpa2UgQ2xhdWRlIGFuZCBHZW1pbmk6IERlZXBTZWVrIHB1Ymxpc2hlcyBub1xuICogdGhpcmQsIGNoZWFwZXIgdGllciwgc28gdGhlIHRyaXZpYWwgdHJpbyAoYHNwZWxsaW5nX2ZpeGAsIGBzdW1tYXJpc2VgLFxuICogYGhlYWx0aGApIHJ1bnMgb24gYGRlZXBzZWVrLWZsYXNoYCB0b28uIFRoYXQgaXMgYSBkZWxpYmVyYXRlIGFic2VuY2UsIG5vdCBhblxuICogb21pc3Npb24uXG4gKi9cbmV4cG9ydCBjb25zdCBERUVQU0VFS19QSEFTRV9NT0RFTF9ERUZBVUxUUzogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4gPVxuICBtb2RlbHNGb3JQaGFzZVRpZXJzKHtcbiAgICBiZXN0OiBERUZBVUxUX0RFRVBTRUVLX01PREVMX1RPUF9USUVSLFxuICAgIHN0YW5kYXJkOiBERUZBVUxUX0RFRVBTRUVLX01PREVMLFxuICAgIGZhc3Q6IERFRkFVTFRfREVFUFNFRUtfTU9ERUwsXG4gIH0pO1xuXG4vKiogQ29uY3JldGUgcHJvdmlkZXIgbW9kZWxzIGZvciB0aGUgc2hhcmVkIGJlc3Qvc3RhbmRhcmQvZmFzdCBwb2xpY3kuICovXG5leHBvcnQgY29uc3QgUFJPVklERVJfTU9ERUxfVElFUlMgPSB7XG4gIGNsYXVkZToge1xuICAgIGJlc3Q6IERFRkFVTFRfQ0xBVURFX01PREVMX1RPUF9USUVSLFxuICAgIHN0YW5kYXJkOiBERUZBVUxUX0NMQVVERV9NT0RFTF9JU1NVRSxcbiAgICBmYXN0OiBERUZBVUxUX0NMQVVERV9NT0RFTF9IRUFMVEgsXG4gIH0sXG4gIGNvZGV4OiB7XG4gICAgYmVzdDogREVGQVVMVF9DT0RFWF9NT0RFTF9UT1BfVElFUixcbiAgICBzdGFuZGFyZDogREVGQVVMVF9DT0RFWF9NT0RFTCxcbiAgICBmYXN0OiBERUZBVUxUX0NPREVYX01PREVMX0NIRUFQX1RJRVIsXG4gIH0sXG4gIGdlbWluaToge1xuICAgIGJlc3Q6IERFRkFVTFRfR0VNSU5JX01PREVMX1RPUF9USUVSLFxuICAgIHN0YW5kYXJkOiBERUZBVUxUX0dFTUlOSV9NT0RFTCxcbiAgICBmYXN0OiBERUZBVUxUX0dFTUlOSV9NT0RFTF9DSEVBUF9USUVSLFxuICB9LFxuICBkZWVwc2Vlazoge1xuICAgIGJlc3Q6IERFRkFVTFRfREVFUFNFRUtfTU9ERUxfVE9QX1RJRVIsXG4gICAgc3RhbmRhcmQ6IERFRkFVTFRfREVFUFNFRUtfTU9ERUwsXG4gICAgZmFzdDogREVGQVVMVF9ERUVQU0VFS19NT0RFTCxcbiAgfSxcbn0gYXMgY29uc3Q7XG5cbi8qKlxuICogT3ZlcnJpZGVzIGFjY2VwdGVkIGJ5IHtAbGluayBidWlsZERlZmF1bHRXb3JrZXJDb25maWd9LiBJc3N1ZSAjMjE2NjogdHlwZWQgYXNcbiAqIGBQYXJ0aWFsPFdvcmtlckNvbmZpZz5gIHNvIGEgbWlzc3BlbHQga2V5IGlzIGNhdWdodCBhdCBjb21waWxlIHRpbWUuXG4gKi9cbnR5cGUgRGVmYXVsdENvbmZpZ092ZXJyaWRlcyA9IFBhcnRpYWw8V29ya2VyQ29uZmlnPjtcblxuLyoqXG4gKiBCdWlsZCBhIGRlZmF1bHQgV29ya2VyQ29uZmlnIHdpdGggYWxsIG9wZXJhdGlvbmFsIHZhbHVlcyBmaWxsZWQgaW4uXG4gKlxuICogVXNlIHRoaXMgdG8gY29uc3RydWN0IGEgV29ya2VyQ29uZmlnIHdpdGhvdXQgc3BlY2lmeWluZyBldmVyeSBmaWVsZC5cbiAqIFBhc3Mgb3ZlcnJpZGVzIHRvIGN1c3RvbWlzZSBzcGVjaWZpYyB2YWx1ZXMuXG4gKlxuICogSXNzdWUgIzI3NzogQ2VudHJhbGlzZWQgZGVmYXVsdCBjb25maWcgYnVpbGRlciB0byBrZWVwIHRoaW5ncyBEUlkuXG4gKiBJc3N1ZSAjMjE2NjogUmV0dXJucyBhIGNvbmNyZXRlIGBXb3JrZXJDb25maWdgIChwcmV2aW91c2x5IGBhbnlgKSBzbyB0aGVcbiAqICAgbGl0ZXJhbCBiZWxvdyBpcyBzdHJ1Y3R1cmFsbHkgY2hlY2tlZCBhZ2FpbnN0IHRoZSBpbnRlcmZhY2UuIEV4Y2Vzc1xuICogICBmaWVsZHMgYW5kIG1pc3NpbmcgcmVxdWlyZWQgZmllbGRzIGFyZSBib3RoIGNvbXBpbGUtdGltZSBlcnJvcnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZERlZmF1bHRXb3JrZXJDb25maWcoXG4gIG92ZXJyaWRlczogRGVmYXVsdENvbmZpZ092ZXJyaWRlcyA9IHt9LFxuKTogV29ya2VyQ29uZmlnIHtcbiAgcmV0dXJuIHtcbiAgICBhbGxvd2VkQXV0aG9yczogW10sXG4gICAgYWxsb3dlZEF1dGhvcjogXCJcIixcbiAgICBwclJldmlld2VyOiBcIlwiLFxuICAgIHByUmV2aWV3ZXJzOiBbXSxcbiAgICByZXBvczogW10sXG4gICAgLy8gSXNzdWUgIzE4MzQ6IGlzc3VlTGFiZWxzIGlzIGhhcmR3aXJlZCDigJQgb25seSB0aGUgdG9wLXByaW9yaXR5IGxhYmVsXG4gICAgLy8gaXMgaXRlcmF0ZWQgYnkgdGhlIGNvbmZpZ3VyZWQtbGFiZWwgY29sbGVjdG9yLiBUaGUgd29yay1vbiBhbmRcbiAgICAvLyBsb3ctcHJpb3JpdHkgbGFiZWxzIGhhdmUgZGVkaWNhdGVkLCBhdXRob3ItY2hlY2tlZCBjb2xsZWN0b3JzLlxuICAgIGlzc3VlTGFiZWxzOiBbTEFCRUxfREVGQVVMVFMudG9wUHJpb3JpdHlMYWJlbF0sXG4gICAgLy8gSXNzdWUgIzEwNjY6IGF4aXMgMiBvbmx5IOKAlCB0aGUga25vd24gYm90cyB3aG9zZSBpbnB1dCB3ZSBhY3Qgb24uIEF4aXNcbiAgICAvLyAxICh3aG8gbWF5IGRpcmVjdCB3b3JrKSBpcyBkZXJpdmVkIGZyb20gY29sbGFib3JhdG9ycyBhbmQgc3RhcnRzIGVtcHR5LlxuICAgIGF1dGhvcmlzZWRDb21tZW50ZXJzOiBbLi4uREVGQVVMVF9UUlVTVEVEX0lOUFVUX0JPVFNdLFxuICAgIC8vIElzc3VlICMzNTI4OiBpZGVudGl0eS1ndWFyZCBhbGxvd2xpc3QuIEVtcHR5IGJ5IGRlZmF1bHQg4oCUIHRoZSBndWFyZFxuICAgIC8vIHdhcm5zIGxvdWRseSB0aGF0IGl0IGlzIGluYWN0aXZlIHVudGlsIG9wZXJhdG9ycyBjb25maWd1cmUgaXQuXG4gICAgc2VydmljZUFjY291bnRzOiBbXSxcbiAgICAvLyBJc3N1ZSAjMzUzMDogc2VydmljZS1hY2NvdW50IGF1dGggZW52IChnaF9jb25maWdfZGlyIC8gc3NoX2tleV9wYXRoKS5cbiAgICAvLyBFbXB0eSBkZWZhdWx0cyBtZWFuIFwiYW1iaWVudCBhdXRoXCIg4oCUIGFwcGx5U2VydmljZUFjY291bnRFbnYgaXMgYSBuby1vcC5cbiAgICBnaENvbmZpZ0RpcjogXCJcIixcbiAgICBzc2hLZXlQYXRoOiBcIlwiLFxuICAgIHRydXN0ZWRSZXZpZXdCb3RzOiBbLi4uREVGQVVMVF9UUlVTVEVEX1JFVklFV19CT1RTXSxcbiAgICBmbGVldFByQXV0aG9yczogW10sXG4gICAgd29ya09uTGFiZWw6IExBQkVMX0RFRkFVTFRTLndvcmtPbkxhYmVsLFxuICAgIGZhaWxlZE9uY2VMYWJlbDogTEFCRUxfREVGQVVMVFMuZmFpbGVkT25jZUxhYmVsLFxuICAgIGZhaWxlZExhYmVsOiBMQUJFTF9ERUZBVUxUUy5mYWlsZWRMYWJlbCxcbiAgICByZWZpbmVJc3N1ZUxhYmVsOiBMQUJFTF9ERUZBVUxUUy5yZWZpbmVJc3N1ZUxhYmVsLFxuICAgIHBsYW5uaW5nTGFiZWw6IExBQkVMX0RFRkFVTFRTLnBsYW5uaW5nTGFiZWwsXG4gICAgcXVlc3Rpb25MYWJlbDogTEFCRUxfREVGQVVMVFMucXVlc3Rpb25MYWJlbCxcbiAgICBuZWVkc1JldmlzaW9uTGFiZWw6IExBQkVMX0RFRkFVTFRTLm5lZWRzUmV2aXNpb25MYWJlbCxcbiAgICBuZWVkc0h1bWFuTGFiZWw6IExBQkVMX0RFRkFVTFRTLm5lZWRzSHVtYW5MYWJlbCxcbiAgICBncmlsbE1lTGFiZWw6IExBQkVMX0RFRkFVTFRTLmdyaWxsTWVMYWJlbCxcbiAgICBxdW9ydW1MYWJlbDogTEFCRUxfREVGQVVMVFMucXVvcnVtTGFiZWwsXG4gICAgbG93UHJpb3JpdHlMYWJlbDogTEFCRUxfREVGQVVMVFMubG93UHJpb3JpdHlMYWJlbCxcbiAgICB3b3JrRGlyOiBcIlwiLFxuICAgIC8vIElzc3VlICM0MTQ2OiBjb250YWlubWVudCBpcyB0aGUgZGVmYXVsdCDigJQgbmF0aXZlIGlzIGFuIGV4cGxpY2l0IG9wdC1pbi5cbiAgICBydW5Nb2RlOiBERUZBVUxUX1JVTl9NT0RFLFxuICAgIC8vIElzc3VlICM2MjI6IGR5bmFtaWMgaXMgd2hhdCBldmVyeSBob3N0IGRpZCBiZWZvcmUgdGhlIGtleSBleGlzdGVkLCBzb1xuICAgIC8vIGFuIHVuY29uZmlndXJlZCBob3N0IHRyYWNrcyB0aGUgbGF0ZXN0IGV4YWN0bHkgYXMgaXQgYWx3YXlzIGhhcy5cbiAgICB1cGRhdGVNb2RlOiBERUZBVUxUX1VQREFURV9NT0RFLFxuICAgIC8vIElzc3VlICM0MDY3OiB0aGUgY29kaW5nLWFnZW50IHByb3ZpZGVyIHNlYW0gZGVmYXVsdHMgdG8gQ2xhdWRlLlxuICAgIGFnZW50UHJvdmlkZXI6IERFRkFVTFRfQUdFTlRfUFJPVklERVJfSUQsXG4gICAgLy8gSXNzdWUgIzQxMDg6IG9ubHkgdGhlIGFjdGl2ZSBwcm92aWRlciBpcyBlbmFibGVkIHVubGVzcyBhIGRlcGxveW1lbnRcbiAgICAvLyBlbmFibGVzIG1vcmUsIHNvIGFuIGV4aXN0aW5nIGRlcGxveW1lbnQgbW91bnRzIGV4YWN0bHkgd2hhdCBpdCBkaWQuXG4gICAgZW5hYmxlZEFnZW50UHJvdmlkZXJzOiBbREVGQVVMVF9BR0VOVF9QUk9WSURFUl9JRF0sXG4gICAgYWdlbnRQcm92aWRlckZhbGxiYWNrOiBbXSxcbiAgICAvLyBJc3N1ZSAjMjQ3NDogZHJhaW4gdGhlIGhlbGQgQ2xhdWRlIHRva2VuIHRvIHplcm8gcmF0aGVyIHRoYW4gcGFya2luZ1xuICAgIC8vIHRoZSBiYWNrbG9nIGF0IHRoZSB3ZWVrLXBhY2UgcHJvamVjdGlvbi4gVGhlIGRlZmF1bHQsIGJlY2F1c2UgYSBwb29sXG4gICAgLy8gaG9zdCBoYXMgc3Vic2NyaXB0aW9ucyB0byByb3RhdGUgYW5kIHRoZSBvdXRhZ2UgZmFsbGJhY2sgaGFuZGxlcyB0aGVcbiAgICAvLyB0b2tlbiB0aGF0IGRpZXMgbWlkLWlzc3VlIOKAlCB0aGUgcHJvamVjdGlvbiBndWFyZCdzIHJlc2VydmF0aW9uIGJ1eXNcbiAgICAvLyBub3RoaW5nIHRoZXJlLiBgZmFsc2VgIG9wdHMgYSBob3N0IGJhY2sgaW50byB0aGUgZ3VhcmQuXG4gICAgY2xhdWRlV2Vla1BhY2VEcmFpbjogdHJ1ZSxcbiAgICBjbGF1ZGVNb2RlbDogXCJcIixcbiAgICAvLyBJc3N1ZSAjMjY1NDogY29uZmlndXJlZCBiZXN0IHBsYW5uaW5nIG1vZGVsIGZvciBkZWdyYWRlZC1tb2RlbCBkZXRlY3Rpb24uXG4gICAgYmVzdFBsYW5uaW5nTW9kZWw6IERFRkFVTFRfQkVTVF9QTEFOTklOR19NT0RFTCxcbiAgICBjbGF1ZGVUaW1lb3V0OiBPUEVSQVRJT05BTF9ERUZBVUxUUy5jbGF1ZGVUaW1lb3V0LFxuICAgIGNsYXVkZU1heFR1cm5zOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5jbGF1ZGVNYXhUdXJucyxcbiAgICBtaW5DbGFpbVJ1bndheVNlY29uZHM6IE9QRVJBVElPTkFMX0RFRkFVTFRTLm1pbkNsYWltUnVud2F5U2Vjb25kcyxcbiAgICBydW5GaW5pc2hTZWNvbmRzOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5ydW5GaW5pc2hTZWNvbmRzLFxuICAgIC8vIEFkYXB0aXZlIGNsYWltIGZsb29yIChJc3N1ZSAjMjQ1KTogdGhlIGxhYmVscyB0aGF0IG1hcmsgYSBsb25nIGpvYi5cbiAgICBjbGFpbUxvbmdKb2JMYWJlbHM6IFsuLi5ERUZBVUxUX0xPTkdfSk9CX0xBQkVMU10sXG4gICAgcHJvZ3Jlc3NFeHRlbnNpb25FbmFibGVkOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5wcm9ncmVzc0V4dGVuc2lvbkVuYWJsZWQsXG4gICAgLy8gSXNzdWUgIzExNDE6IHRoZSBhZ2VudCB0cmFuc2NyaXB0IHRlZSwgb2ZmIHVudGlsIGNvbmZpZ3VyZWQgb24uXG4gICAgYWdlbnRUcmFuc2NyaXB0RW5hYmxlZDogT1BFUkFUSU9OQUxfREVGQVVMVFMuYWdlbnRUcmFuc2NyaXB0RW5hYmxlZCxcbiAgICBwcm9ncmVzc0V4dGVuc2lvbkdyYW50U2Vjb25kczpcbiAgICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnByb2dyZXNzRXh0ZW5zaW9uR3JhbnRTZWNvbmRzLFxuICAgIHByb2dyZXNzRXh0ZW5zaW9uU3RhbGxTZWNvbmRzOlxuICAgICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucHJvZ3Jlc3NFeHRlbnNpb25TdGFsbFNlY29uZHMsXG4gICAgcHJvZ3Jlc3NFeHRlbnNpb25DaGVja1NlY29uZHM6XG4gICAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5wcm9ncmVzc0V4dGVuc2lvbkNoZWNrU2Vjb25kcyxcbiAgICBjYWxsU3Rvcm1FbmFibGVkOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5jYWxsU3Rvcm1FbmFibGVkLFxuICAgIGNhbGxTdG9ybUNhbGxzOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5jYWxsU3Rvcm1DYWxscyxcbiAgICBjYWxsU3Rvcm1XaW5kb3dTZWNvbmRzOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5jYWxsU3Rvcm1XaW5kb3dTZWNvbmRzLFxuICAgIGNhbGxTdG9ybU5vdmVsU2hhcmU6IE9QRVJBVElPTkFMX0RFRkFVTFRTLmNhbGxTdG9ybU5vdmVsU2hhcmUsXG4gICAgLy8gSXNzdWUgIzM2Mjg6IHF1b3RhLWF3YXJlIHBvbGxpbmcgZ2F0ZSBmbG9vcnMuXG4gICAgcXVvdGFQb2xsUGFya0Zsb29yOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5xdW90YVBvbGxQYXJrRmxvb3IsXG4gICAgcXVvdGFQb2xsUGFya05pY2U6IE9QRVJBVElPTkFMX0RFRkFVTFRTLnF1b3RhUG9sbFBhcmtOaWNlLFxuICAgIHF1b3RhUG9sbElkbGVGbG9vcjogT1BFUkFUSU9OQUxfREVGQVVMVFMucXVvdGFQb2xsSWRsZUZsb29yLFxuICAgIC8vIElzc3VlICMzNjY3OiBuaWNlLWRlcml2ZWQgcG9sbCBjYWRlbmNlLlxuICAgIHBvbGxDYWRlbmNlTG93Q3ljbGVzOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5wb2xsQ2FkZW5jZUxvd0N5Y2xlcyxcbiAgICBwb2xsQ2FkZW5jZVBhcmtDeWNsZXM6IE9QRVJBVElPTkFMX0RFRkFVTFRTLnBvbGxDYWRlbmNlUGFya0N5Y2xlcyxcbiAgICAvLyBJc3N1ZSAjNTA1OiBzZWxmLXNjaGVkdWxpbmcgZm9yIGF1dG8tZmlsZWQgd29ya2VyIGRpYWdub3N0aWNzLlxuICAgIHNlbGZTY2hlZHVsZURpYWdub3N0aWNzRW5hYmxlZDpcbiAgICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnNlbGZTY2hlZHVsZURpYWdub3N0aWNzRW5hYmxlZCxcbiAgICBzZWxmU2NoZWR1bGVEaWFnbm9zdGljc01heEluRmxpZ2h0OlxuICAgICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuc2VsZlNjaGVkdWxlRGlhZ25vc3RpY3NNYXhJbkZsaWdodCxcbiAgICBwckZlZWRiYWNrVGltZW91dDogT1BFUkFUSU9OQUxfREVGQVVMVFMucHJGZWVkYmFja1RpbWVvdXQsXG4gICAgY2lGaXhUaW1lb3V0OiBPUEVSQVRJT05BTF9ERUZBVUxUUy5jaUZpeFRpbWVvdXQsXG4gICAgY2xhdWRlS2lsbEFmdGVyOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5jbGF1ZGVLaWxsQWZ0ZXIsXG4gICAgbWF4Q2xhcmlmaWNhdGlvblJvdW5kczogT1BFUkFUSU9OQUxfREVGQVVMVFMubWF4Q2xhcmlmaWNhdGlvblJvdW5kcyxcbiAgICBzbGVlcEludGVydmFsOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5zbGVlcEludGVydmFsLFxuICAgIG1heENvbmN1cnJlbnRJc3N1ZXM6IE9QRVJBVElPTkFMX0RFRkFVTFRTLm1heENvbmN1cnJlbnRJc3N1ZXMsXG4gICAgY3JlZGl0V2FpdEludGVydmFsOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5jcmVkaXRXYWl0SW50ZXJ2YWwsXG4gICAgcmVmaW5lbWVudFRpbWVvdXQ6IE9QRVJBVElPTkFMX0RFRkFVTFRTLnJlZmluZW1lbnRUaW1lb3V0LFxuICAgIHJlZmluZW1lbnRLaWxsQWZ0ZXI6IE9QRVJBVElPTkFMX0RFRkFVTFRTLnJlZmluZW1lbnRLaWxsQWZ0ZXIsXG4gICAgcGxhbm5pbmdUaW1lb3V0OiBPUEVSQVRJT05BTF9ERUZBVUxUUy5wbGFubmluZ1RpbWVvdXQsXG4gICAgcGxhbm5pbmdLaWxsQWZ0ZXI6IE9QRVJBVElPTkFMX0RFRkFVTFRTLnBsYW5uaW5nS2lsbEFmdGVyLFxuICAgIHF1ZXN0aW9uVGltZW91dDogT1BFUkFUSU9OQUxfREVGQVVMVFMucXVlc3Rpb25UaW1lb3V0LFxuICAgIHF1ZXN0aW9uS2lsbEFmdGVyOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5xdWVzdGlvbktpbGxBZnRlcixcbiAgICBjbGFyaWZpY2F0aW9uVGltZW91dDogT1BFUkFUSU9OQUxfREVGQVVMVFMuY2xhcmlmaWNhdGlvblRpbWVvdXQsXG4gICAgY2xhcmlmaWNhdGlvbktpbGxBZnRlcjogT1BFUkFUSU9OQUxfREVGQVVMVFMuY2xhcmlmaWNhdGlvbktpbGxBZnRlcixcbiAgICBtYXhHcmlsbE1lUm91bmRzOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5tYXhHcmlsbE1lUm91bmRzLFxuICAgIGdyaWxsTWVUaW1lb3V0OiBPUEVSQVRJT05BTF9ERUZBVUxUUy5ncmlsbE1lVGltZW91dCxcbiAgICBncmlsbE1lS2lsbEFmdGVyOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5ncmlsbE1lS2lsbEFmdGVyLFxuICAgIHF1b3J1bVRpbWVvdXQ6IE9QRVJBVElPTkFMX0RFRkFVTFRTLnF1b3J1bVRpbWVvdXQsXG4gICAgcXVvcnVtS2lsbEFmdGVyOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5xdW9ydW1LaWxsQWZ0ZXIsXG4gICAgcXVvcnVtUGxhbm5lcnM6IGRlZmF1bHRRdW9ydW1QbGFubmVycygpLFxuICAgIHF1b3J1bUp1ZGdlOiBkZWZhdWx0UXVvcnVtSnVkZ2UoKSxcbiAgICBtYXhSYXRlTGltaXRSZXRyaWVzOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5tYXhSYXRlTGltaXRSZXRyaWVzLFxuICAgIG1heFJhdGVMaW1pdFdhaXQ6IE9QRVJBVElPTkFMX0RFRkFVTFRTLm1heFJhdGVMaW1pdFdhaXQsXG4gICAgdHJ1c3RlZEF1dGhvcnNDYWNoZUhvdXJzOiBPUEVSQVRJT05BTF9ERUZBVUxUUy50cnVzdGVkQXV0aG9yc0NhY2hlSG91cnMsXG4gICAgcmV0cnlNYXhEZWxheTogT1BFUkFUSU9OQUxfREVGQVVMVFMucmV0cnlNYXhEZWxheSxcbiAgICBtYXhJc3N1ZUJvZHlUb2tlbnM6IE9QRVJBVElPTkFMX0RFRkFVTFRTLm1heElzc3VlQm9keVRva2VucyxcbiAgICBzdW1tYXJpc2VUaW1lb3V0OiBPUEVSQVRJT05BTF9ERUZBVUxUUy5zdW1tYXJpc2VUaW1lb3V0LFxuICAgIHN1bW1hcmlzZUtpbGxBZnRlcjogT1BFUkFUSU9OQUxfREVGQVVMVFMuc3VtbWFyaXNlS2lsbEFmdGVyLFxuICAgIGZlYXR1cmVDaGVja1RpbWVvdXQ6IE9QRVJBVElPTkFMX0RFRkFVTFRTLmZlYXR1cmVDaGVja1RpbWVvdXQsXG4gICAgY2xhdWRlTm9PdXRwdXRUaW1lb3V0OiBPUEVSQVRJT05BTF9ERUZBVUxUUy5jbGF1ZGVOb091dHB1dFRpbWVvdXQsXG4gICAgcXVhbGl0eUNoZWNrVGltZW91dDogT1BFUkFUSU9OQUxfREVGQVVMVFMucXVhbGl0eUNoZWNrVGltZW91dCxcbiAgICAvLyBJc3N1ZSAjMjE2NjogY2xhaW1DaHVyblRocmVzaG9sZCBpcyBjb25zdW1lZCBieSBzaGVsbCBzY3JpcHRzIHZpYSB0aGVcbiAgICAvLyBDTEFJTV9DSFVSTl9USFJFU0hPTEQgZW52IHZhciwgbm90IHZpYSBXb3JrZXJDb25maWcg4oCUIHRoZSBwcmV2aW91c1xuICAgIC8vIGJ1aWxkZXIgZmllbGQgd2FzIGRlYWQgKG5vIGBjb25maWcuY2xhaW1DaHVyblRocmVzaG9sZGAgcmVhZGVyIGV4aXN0cykuXG4gICAgaGVhbHRoQ2FjaGVUdGw6IE9QRVJBVElPTkFMX0RFRkFVTFRTLmhlYWx0aENhY2hlVHRsLFxuICAgIHNodWZmbGVSZXBvczogREVGQVVMVF9TSFVGRkxFX1JFUE9TLFxuICAgIHdvcmtlck5hbWU6IERFRkFVTFRfV09SS0VSX05BTUUsXG4gICAgZW5hYmxlTW9kZWxGYWxsYmFjazogT1BFUkFUSU9OQUxfREVGQVVMVFMuZW5hYmxlTW9kZWxGYWxsYmFjayxcbiAgICBtaW5EaXNrU3BhY2VNYjogT1BFUkFUSU9OQUxfREVGQVVMVFMubWluRGlza1NwYWNlTWIsXG4gICAgc3luY01pbGVzdG9uZUJyYW5jaGVzOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5zeW5jTWlsZXN0b25lQnJhbmNoZXMsXG4gICAgZmFzdEZhaWx1cmVTZWNvbmRzOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5mYXN0RmFpbHVyZVNlY29uZHMsXG4gICAgcmVwb0Zhc3RGYWlsdXJlVGhyZXNob2xkOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5yZXBvRmFzdEZhaWx1cmVUaHJlc2hvbGQsXG4gICAgcmVwb0Zhc3RGYWlsdXJlV2luZG93SG91cnM6IE9QRVJBVElPTkFMX0RFRkFVTFRTLnJlcG9GYXN0RmFpbHVyZVdpbmRvd0hvdXJzLFxuICAgIHN0YWxlRmFpbGVkRGlhZ25vc3RpY0RheXM6IE9QRVJBVElPTkFMX0RFRkFVTFRTLnN0YWxlRmFpbGVkRGlhZ25vc3RpY0RheXMsXG4gICAgc3RhbGVQbGFubmluZ1dhcm5pbmdEYXlzOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5zdGFsZVBsYW5uaW5nV2FybmluZ0RheXMsXG4gICAgcGhhc2VNb2RlbE92ZXJyaWRlczoge30sXG4gICAgcGhhc2VFZmZvcnRPdmVycmlkZXM6IHt9LFxuICAgIGNvZGV4UGhhc2VNb2RlbE92ZXJyaWRlczoge30sXG4gICAgY29kZXhQaGFzZUVmZm9ydE92ZXJyaWRlczoge30sXG4gICAgZ2VtaW5pUGhhc2VNb2RlbE92ZXJyaWRlczoge30sXG4gICAgZGVlcHNlZWtQaGFzZU1vZGVsT3ZlcnJpZGVzOiB7fSxcbiAgICBpc3N1ZUV4ZWN1dG9yU3BsaXQ6IE9QRVJBVElPTkFMX0RFRkFVTFRTLmlzc3VlRXhlY3V0b3JTcGxpdCxcbiAgICBpc3N1ZVN1YkFnZW50VGllcjogT1BFUkFUSU9OQUxfREVGQVVMVFMuaXNzdWVTdWJBZ2VudFRpZXIsXG4gICAgaXNzdWVSZXZpZXdlckFnZW50czogT1BFUkFUSU9OQUxfREVGQVVMVFMuaXNzdWVSZXZpZXdlckFnZW50cyxcbiAgICBleHRlcm5hbE9yY2hlc3RyYXRpb246IE9QRVJBVElPTkFMX0RFRkFVTFRTLmV4dGVybmFsT3JjaGVzdHJhdGlvbixcbiAgICBleHRlcm5hbE9yY2hlc3RyYXRpb25TZXR0aW5nczoge30sXG4gICAgaW5jbHVkZVJlY2VudEFjdGl2aXR5OiBPUEVSQVRJT05BTF9ERUZBVUxUUy5pbmNsdWRlUmVjZW50QWN0aXZpdHksXG4gICAgcmVjZW50QWN0aXZpdHlNZXJnZWRQckxpbWl0OlxuICAgICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucmVjZW50QWN0aXZpdHlNZXJnZWRQckxpbWl0LFxuICAgIHJlY2VudEFjdGl2aXR5Q29tbWl0TGltaXQ6IE9QRVJBVElPTkFMX0RFRkFVTFRTLnJlY2VudEFjdGl2aXR5Q29tbWl0TGltaXQsXG4gICAgcmVjZW50QWN0aXZpdHlNYXhUb2tlbnM6IE9QRVJBVElPTkFMX0RFRkFVTFRTLnJlY2VudEFjdGl2aXR5TWF4VG9rZW5zLFxuICAgIHJlY2VudEFjdGl2aXR5Q2FjaGVUdGxTZWNvbmRzOlxuICAgICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucmVjZW50QWN0aXZpdHlDYWNoZVR0bFNlY29uZHMsXG4gICAgaW5jbHVkZUNvZGViYXNlTWFwOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5pbmNsdWRlQ29kZWJhc2VNYXAsXG4gICAgLy8gRnJlc2ggb2JqZWN0IHBlciBjb25maWc6IHRoZSBkZWZhdWx0IG11c3QgbmV2ZXIgYmUgc2hhcmVkIGFuZCBtdXRhdGVkLlxuICAgIGNvZGVncmFwaENvbnRleHQ6IHtcbiAgICAgIGVuYWJsZWQ6IE9QRVJBVElPTkFMX0RFRkFVTFRTLmNvZGVncmFwaENvbnRleHQuZW5hYmxlZCxcbiAgICB9LFxuICAgIHJ0a091dHB1dDogeyBlbmFibGVkOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5ydGtPdXRwdXQuZW5hYmxlZCB9LFxuICAgIHRpbWVsaW5lQ2FjaGVUdGxTZWNvbmRzOiBPUEVSQVRJT05BTF9ERUZBVUxUUy50aW1lbGluZUNhY2hlVHRsU2Vjb25kcyxcbiAgICBlbmFibGVTZXNzaW9uUmVzdW1lOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5lbmFibGVTZXNzaW9uUmVzdW1lLFxuICAgIHZlcmJvc2l0eTogREVGQVVMVF9WRVJCT1NJVFksXG4gICAgY29udGV4dEJ1ZGdldFdhcm5pbmdQZXJjZW50OlxuICAgICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuY29udGV4dEJ1ZGdldFdhcm5pbmdQZXJjZW50LFxuICAgIGNvbnRleHRCdWRnZXRFcnJvclBlcmNlbnQ6IE9QRVJBVElPTkFMX0RFRkFVTFRTLmNvbnRleHRCdWRnZXRFcnJvclBlcmNlbnQsXG4gICAgY29udGV4dEJ1ZGdldEJsb2NrUGVyY2VudDogT1BFUkFUSU9OQUxfREVGQVVMVFMuY29udGV4dEJ1ZGdldEJsb2NrUGVyY2VudCxcbiAgICAvLyBJc3N1ZSAjMjE2NjogaW5jbHVkZVVudHJ1c3RlZENvbW1lbnRzIGlzIHJlcXVpcmVkIG9uIFdvcmtlckNvbmZpZ1xuICAgIC8vIChJc3N1ZSAjMTM0MCkgYW5kIHdhcyBtaXNzaW5nIGZyb20gdGhlIGJ1aWxkZXIgbGl0ZXJhbCBiZWNhdXNlIHRoZVxuICAgIC8vIHByZXZpb3VzIGBhbnlgIHJldHVybiB0eXBlIHNpbGVudGx5IGFsbG93ZWQgdGhlIGdhcC5cbiAgICBpbmNsdWRlVW50cnVzdGVkQ29tbWVudHM6IE9QRVJBVElPTkFMX0RFRkFVTFRTLmluY2x1ZGVVbnRydXN0ZWRDb21tZW50cyxcbiAgICAvLyBJc3N1ZSAjMjE2Ni8jMjg3MzogY29tbWVudC1yYXRlLWxpbWl0IGZpZWxkcyAobWF4VG90YWxDb21tZW50Q2hhcnMsXG4gICAgLy8gbWF4VW50cnVzdGVkQ29tbWVudENoYXJzLCBtYXhVbnRydXN0ZWRDb21tZW50Q291bnQsIGNvbW1lbnRGbG9vZFRocmVzaG9sZClcbiAgICAvLyBsaXZlIGluIENPTU1FTlRfUkFURV9MSU1JVF9ERUZBVUxUUyBpbiBjb21tZW50X3JhdGVfbGltaXRlci50cywgbm90IG9uXG4gICAgLy8gV29ya2VyQ29uZmlnLiBUaGV5IGFyZSBlbmZvcmNlZCBieSBwcmVwYXJlVHJ1c3RBbm5vdGF0ZWRDb21tZW50cygpIGluXG4gICAgLy8gY29tbWVudF90cnVzdF9maWx0ZXIudHMsIHdoaWNoIGFwcGxpZXMgdGhlIGNhcHMgYW5kIGZsb29kIGRldGVjdGlvbiB0b1xuICAgIC8vIGV2ZXJ5IGNvbW1lbnQgZm9yd2FyZGVkIGludG8gYSBDbGF1ZGUgcHJvbXB0LlxuICAgIGNsb3NlZFByQ29vbGRvd25TZWNvbmRzOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5jbG9zZWRQckNvb2xkb3duU2Vjb25kcyxcbiAgICB1bmFzc2lnbk9uUHJDcmVhdGVkOiBPUEVSQVRJT05BTF9ERUZBVUxUUy51bmFzc2lnbk9uUHJDcmVhdGVkLFxuICAgIHN0YWxlV29ya0RpckRheXM6IE9QRVJBVElPTkFMX0RFRkFVTFRTLnN0YWxlV29ya0RpckRheXMsXG4gICAgdXBkYXRlUmV0cnlNYXhBdHRlbXB0czogT1BFUkFUSU9OQUxfREVGQVVMVFMudXBkYXRlUmV0cnlNYXhBdHRlbXB0cyxcbiAgICB1cGRhdGVSZXRyeUJhY2tvZmZTZWNvbmRzOiBbXG4gICAgICAuLi5PUEVSQVRJT05BTF9ERUZBVUxUUy51cGRhdGVSZXRyeUJhY2tvZmZTZWNvbmRzLFxuICAgIF0sXG4gICAgYmFzZWxpbmVBd2FyZVF1YWxpdHlHYXRlOiBPUEVSQVRJT05BTF9ERUZBVUxUUy5iYXNlbGluZUF3YXJlUXVhbGl0eUdhdGUsXG4gICAgaW5mcmFSZXRyeUJhY2tvZmZNczogT1BFUkFUSU9OQUxfREVGQVVMVFMuaW5mcmFSZXRyeUJhY2tvZmZNcyxcbiAgICAvLyBJc3N1ZSAjMzU4MjogYXV0by1maXggYXR0ZW1wdCBjYXAgcGVyIHN0YWJsZSBmYWlsdXJlIHNpZ25hdHVyZS5cbiAgICBtYXhBdXRvRml4QXR0ZW1wdHM6IE9QRVJBVElPTkFMX0RFRkFVTFRTLm1heEF1dG9GaXhBdHRlbXB0cyxcbiAgICAvLyBJc3N1ZSAjMjQwMTogZGVmYXVsdCB0byBhbiBlbXB0eSBtYXAg4oaSIHVuaWZvcm0gaWRsZS10YXNrIGRyYXcuIEFuXG4gICAgLy8gb3BlcmF0b3Igb3B0cyBpbnRvIGJpYXNpbmcgdmlhIGBpZGxlX3Rhc2tfdGVtcGxhdGVfd2VpZ2h0c2AuXG4gICAgaWRsZVRhc2tUZW1wbGF0ZVdlaWdodHM6IHt9LFxuICAgIC8vIElzc3VlICM0MDAzLyM0MDExOiB0aGUgY29udmVyZ2VkIGNhZGVuY2UgcG9saWN5IHNoaXBzIGFzIHRoZSBkZWZhdWx0IOKAlFxuICAgIC8vIGFuIG9wZXJhdG9yIHdobyBjaGFuZ2VzIG5vdGhpbmcgZ2V0cyB3ZWVrbHkgYHNvbm5ldGAgYW5kIG1vbnRobHkgYGZhYmxlYFxuICAgIC8vIGZsb29ycyBvbiB0aGUgdGhyZWUgaW1wb3J0YW50IHRlbXBsYXRlcy4gQ2xvbmVkIHNvIGEgY2FsbGVyIG11dGF0aW5nIHRoZVxuICAgIC8vIGJ1aWx0IGNvbmZpZyBjYW4gbmV2ZXIgY29ycnVwdCB0aGUgc2hhcmVkIGRlZmF1bHQuXG4gICAgaWRsZVRhc2tDYWRlbmNlOiBjbG9uZUNhZGVuY2VQb2xpY3koREVGQVVMVF9DQURFTkNFX1BPTElDWSksXG4gICAgLy8gSXNzdWUgIzI2MjI6IHBlci10b29sIG1pbmltdW0gdmVyc2lvbiBmbG9vcnMgZm9yIHNvZnR3YXJlIGF1dG8tdXBkYXRlLlxuICAgIHNvZnR3YXJlTWluVmVyc2lvbnM6IHsgLi4uT1BFUkFUSU9OQUxfREVGQVVMVFMuc29mdHdhcmVNaW5WZXJzaW9ucyB9LFxuICAgIC8vIElzc3VlICM4NDYgKHBhcnQgb2YgIzg0Myk6IG5vIGN1c3RvbSBsYWJlbCDihpIgcHJvbXB0IG1hcHBpbmdzIHVudGlsIGFuXG4gICAgLy8gb3BlcmF0b3Igb3B0cyBpbiDigJQgdGhlIGZlYXR1cmUgaXMgb2ZmIGJ5IGRlZmF1bHQuXG4gICAgY3VzdG9tTGFiZWxQcm9tcHRzOiBbXSxcbiAgICAvLyBJc3N1ZSAjODA2OiBubyBob29rcyBjb25maWd1cmVkIOKAlCBhbiBleGlzdGluZyBjb25maWd1cmF0aW9uIHdpdGhvdXQgYVxuICAgIC8vIGBjYWxsYmFja3NgIGJsb2NrIGJlaGF2ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAgY2FsbGJhY2tzOiBub0NhbGxiYWNrcygpLFxuICAgIC8vIElzc3VlICMyMDk4OiBHcmFmdCBvZmYuIFNwcmVhZCBzbyBhIGNhbGxlciBtdXRhdGluZyB0aGUgYnVpbHQgY29uZmlnXG4gICAgLy8gY2Fubm90IGNvcnJ1cHQgdGhlIHNoYXJlZCBkZWZhdWx0LlxuICAgIGdyYWZ0Q29udGV4dDogeyAuLi5PUEVSQVRJT05BTF9ERUZBVUxUUy5ncmFmdENvbnRleHQgfSxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsU0FBUyxtQkFBbUIsUUFBUSxxQkFBcUI7QUFDekQsU0FBUyx3QkFBd0IsUUFBUSx5QkFBeUI7QUFxQmxFLFNBQVMseUJBQXlCLFFBQVEsc0JBQXNCO0FBQ2hFLFNBQVMsZ0NBQWdDLFFBQVEsb0JBQW9CO0FBQ3JFLFNBQVMsMEJBQTBCLFFBQVEsb0JBQW9CO0FBQy9ELFNBQVMsOEJBQThCLFFBQVEsa0JBQWtCO0FBQ2pFLFNBQVMsdUJBQXVCLFFBQVEsNkJBQTZCO0FBQ3JFLFNBQVMsc0JBQXNCLFFBQVEseUJBQXlCO0FBQ2hFLFNBQVMsZ0JBQWdCLFFBQVEsZ0JBQWdCO0FBQ2pELFNBQVMsa0JBQWtCLFFBQVEsZ0NBQWdDO0FBQ25FLFNBQVMsV0FBVyxRQUFRLDRCQUE0QjtBQUN4RCxTQUFTLGVBQWUsUUFBUSw0QkFBNEI7QUFFNUQ7Ozs7OztDQU1DLEdBQ0QsT0FBTyxNQUFNLGlCQUFpQjtFQUM1Qjs7OztHQUlDLEdBQ0Qsa0JBQWtCO0VBQ2xCOzs7OztHQUtDLEdBQ0QsYUFBYTtFQUNiLGlCQUFpQjtFQUNqQixhQUFhO0VBQ2Isa0JBQWtCO0VBQ2xCLGVBQWU7RUFDZixlQUFlO0VBQ2Ysb0JBQW9CO0VBQ3BCLG9CQUFvQjtFQUNwQixzQkFBc0I7RUFDdEIsaUJBQWlCO0VBQ2pCLGNBQWM7RUFDZDs7Ozs7O0dBTUMsR0FDRCxhQUFhO0VBQ2I7Ozs7O0dBS0MsR0FDRCxrQkFBa0I7QUFDcEIsRUFBVztBQUVYOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxNQUFNLG1CQUFzQztFQUNqRCxlQUFlLGdCQUFnQjtFQUMvQixlQUFlLFdBQVc7RUFDMUIsZUFBZSxnQkFBZ0I7Q0FDaEMsQ0FBVTtBQUVYOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxNQUFNLGlDQUFpQyxpQ0FBaUM7QUFFL0U7Ozs7Ozs7OztDQVNDLEdBQ0QsT0FBTyxNQUFNLGtCQUFxQztFQUNoRCxxRUFBcUU7RUFDckUscUVBQXFFO0VBQ3JFLDhEQUE4RDtFQUM5RCxxRUFBcUU7RUFDckUsaUVBQWlFO0VBQ2pFO0VBQ0E7RUFDQSx3RUFBd0U7RUFDeEUsMkRBQTJEO0VBQzNELGVBQWUsZ0JBQWdCO0VBQy9CLDZFQUE2RTtFQUM3RSxlQUFlLGdCQUFnQjtFQUMvQix1QkFBdUI7RUFDdkIsZUFBZSxXQUFXO0VBQzFCLDBCQUEwQjtFQUMxQixlQUFlLFdBQVc7RUFDMUIsZUFBZSxlQUFlO0VBQzlCLHdCQUF3QjtFQUN4Qix3RUFBd0U7RUFDeEUseUVBQXlFO0VBQ3pFLG1FQUFtRTtFQUNuRSx3RUFBd0U7RUFDeEU7RUFDQSxlQUFlLGdCQUFnQjtFQUMvQixlQUFlLGFBQWE7RUFDNUIsZUFBZSxhQUFhO0VBQzVCLDBFQUEwRTtFQUMxRSwwRUFBMEU7RUFDMUUsMkVBQTJFO0VBQzNFLHdFQUF3RTtFQUN4RTtFQUNBLGVBQWUsa0JBQWtCO0VBQ2pDLGVBQWUsZUFBZTtFQUM5QixlQUFlLFlBQVk7RUFDM0Isc0VBQXNFO0VBQ3RFLDRFQUE0RTtFQUM1RSwyQ0FBMkM7RUFDM0MsZUFBZSxXQUFXO0VBQzFCLDZFQUE2RTtFQUM3RSw0RUFBNEU7RUFDNUUsNkVBQTZFO0VBQzdFLHlFQUF5RTtFQUN6RSxvREFBb0Q7RUFDcEQ7Q0FDRCxDQUFDO0FBRUY7Ozs7Ozs7O0NBUUMsR0FDRCxNQUFNLHdCQUE2QyxJQUFJLElBQ3JELGdCQUFnQixHQUFHLENBQUMsQ0FBQyxRQUFVLE1BQU0sV0FBVztBQUdsRDs7Ozs7Ozs7Ozs7OztDQWFDLEdBQ0QsT0FBTyxTQUFTLGdCQUFnQixLQUFhO0VBQzNDLE9BQU8sc0JBQXNCLEdBQUcsQ0FBQyxNQUFNLFdBQVc7QUFDcEQ7QUFFQTs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxNQUFNLHVCQUF1QjtFQUNsQyx1RUFBdUU7RUFDdkUseUVBQXlFO0VBQ3pFLHFFQUFxRTtFQUNyRSwyREFBMkQ7RUFDM0QsZUFBZTtFQUNmLGdCQUFnQjtFQUNoQjs7Ozs7R0FLQyxHQUNELHVCQUF1QjtFQUN2Qjs7OztHQUlDLEdBQ0Qsa0JBQWtCO0VBQ2xCOzs7Ozs7Ozs7Ozs7Ozs7R0FlQyxHQUNELDBCQUEwQjtFQUMxQjs7Ozs7Ozs7OztHQVVDLEdBQ0Qsd0JBQXdCO0VBQ3hCLHdFQUF3RSxHQUN4RSwrQkFBK0I7RUFDL0I7OztHQUdDLEdBQ0QsK0JBQStCO0VBQy9COzs7R0FHQyxHQUNELDRCQUE0QjtFQUM1QiwyRUFBMkUsR0FDM0UsK0JBQStCO0VBQy9COzs7Ozs7Ozs7R0FTQyxHQUNELCtCQUErQjtFQUMvQjs7Ozs7Ozs7O0dBU0MsR0FDRCxrQkFBa0I7RUFDbEI7Ozs7Ozs7R0FPQyxHQUNELGdCQUFnQjtFQUNoQjs7Ozs7R0FLQyxHQUNELHdCQUF3QjtFQUN4Qjs7Ozs7O0dBTUMsR0FDRCxxQkFBcUI7RUFDckI7Ozs7Ozs7OztHQVNDLEdBQ0Qsb0JBQW9CO0VBQ3BCLG1CQUFtQjtFQUNuQixvQkFBb0I7RUFDcEI7Ozs7OztHQU1DLEdBQ0Qsc0JBQXNCO0VBQ3RCLHVCQUF1QjtFQUN2Qjs7Ozs7Ozs7Ozs7R0FXQyxHQUNELGdDQUFnQztFQUNoQzs7O0dBR0MsR0FDRCxvQ0FBb0M7RUFDcEMsaUJBQWlCO0VBQ2pCLHdCQUF3QjtFQUN4Qjs7Ozs7R0FLQyxHQUNELGVBQWU7RUFDZixxRUFBcUU7RUFDckUsd0VBQXdFO0VBQ3hFLHVFQUF1RTtFQUN2RSxtRUFBbUU7RUFDbkUscUJBQXFCO0VBQ3JCLG9CQUFvQjtFQUNwQixtQkFBbUI7RUFDbkIscUJBQXFCO0VBQ3JCLDJFQUEyRTtFQUMzRSxtQ0FBbUM7RUFDbkMsaUJBQWlCO0VBQ2pCLG1CQUFtQjtFQUNuQjs7Ozs7R0FLQyxHQUNELG1CQUFtQjtFQUNuQjs7Ozs7R0FLQyxHQUNELGNBQWM7RUFDZCxpQkFBaUI7RUFDakIsbUJBQW1CO0VBQ25CLHNCQUFzQjtFQUN0Qix3QkFBd0I7RUFDeEI7Ozs7Ozs7OztHQVNDLEdBQ0Qsa0JBQWtCO0VBQ2xCOzs7Ozs7Ozs7OztHQVdDLEdBQ0QsZ0JBQWdCO0VBQ2hCLDRFQUE0RSxHQUM1RSxrQkFBa0I7RUFDbEI7Ozs7Ozs7R0FPQyxHQUNELGVBQWU7RUFDZiw2RUFBNkUsR0FDN0UsaUJBQWlCO0VBQ2pCLHFCQUFxQjtFQUNyQixrQkFBa0I7RUFDbEI7Ozs7O0dBS0MsR0FDRCwwQkFBMEI7RUFDMUIsZUFBZTtFQUNmLG9CQUFvQjtFQUNwQixrQkFBa0I7RUFDbEIsb0JBQW9CO0VBQ3BCLHFCQUFxQjtFQUNyQix3RUFBd0U7RUFDeEUsc0VBQXNFO0VBQ3RFLDBEQUEwRDtFQUMxRCx1QkFBdUI7RUFDdkIscUJBQXFCO0VBQ3JCLHFCQUFxQjtFQUNyQixnQkFBZ0I7RUFDaEIscUJBQXFCO0VBQ3JCLGdCQUFnQjtFQUNoQix1QkFBdUI7RUFDdkIsc0JBQXNCO0VBQ3RCOzs7O0dBSUMsR0FDRCxvQkFBb0I7RUFDcEIsMEVBQTBFLEdBQzFFLDBCQUEwQjtFQUMxQixxRUFBcUUsR0FDckUsNEJBQTRCO0VBQzVCLDJCQUEyQjtFQUMzQiwwQkFBMEI7RUFDMUIsdUJBQXVCO0VBQ3ZCLDZCQUE2QjtFQUM3QiwyQkFBMkI7RUFDM0IseUJBQXlCO0VBQ3pCLCtCQUErQjtFQUMvQjs7OztHQUlDLEdBQ0Qsb0JBQW9CO0VBQ3BCOzs7O0dBSUMsR0FDRCxjQUFjO0VBQ2Q7Ozs7R0FJQyxHQUNELGtCQUFrQjtJQUFFLFNBQVM7RUFBTTtFQUNuQzs7Ozs7O0dBTUMsR0FDRCxXQUFXO0lBQUUsU0FBUztFQUFLO0VBQzNCOzs7Ozs7R0FNQyxHQUNELHlCQUF5QjtFQUN6Qjs7Ozs7Ozs7R0FRQyxHQUNELHFCQUFxQjtFQUNyQjs7Ozs7R0FLQyxHQUNELG9CQUFvQjtFQUNwQjs7Ozs7Ozs7R0FRQyxHQUNELG1CQUFtQjtFQUNuQjs7OztHQUlDLEdBQ0QscUJBQXFCO0VBQ3JCOzs7O0dBSUMsR0FDRCx1QkFBdUI7RUFDdkI7OztHQUdDLEdBQ0QsK0JBQStCLENBQUM7RUFDaEMsaUZBQWlGLEdBQ2pGLHFCQUFxQixLQUFLLE9BQU87RUFDakMsOERBQThELEdBQzlELG1CQUFtQjtFQUNuQiw2QkFBNkI7RUFDN0IsMkJBQTJCO0VBQzNCOzs7O0dBSUMsR0FDRCwyQkFBMkI7RUFDM0IsdUZBQXVGLEdBQ3ZGLHNCQUFzQjtFQUN0Qiw4RUFBOEUsR0FDOUUsMEJBQTBCO0VBQzFCLGlGQUFpRixHQUNqRiwwQkFBMEI7RUFDMUIscUZBQXFGLEdBQ3JGLHVCQUF1QjtFQUN2Qjs7OztHQUlDLEdBQ0QsMEJBQTBCO0VBQzFCOzs7O0dBSUMsR0FDRCx5QkFBeUI7RUFDekI7Ozs7O0dBS0MsR0FDRCxxQkFBcUI7RUFDckI7OztHQUdDLEdBQ0Qsa0JBQWtCO0VBQ2xCOzs7O0dBSUMsR0FDRCx3QkFBd0I7RUFDeEI7Ozs7O0dBS0MsR0FDRCwyQkFBMkI7SUFBQztJQUFJO0lBQUk7R0FBSTtFQUN4Qzs7Ozs7Ozs7Ozs7Ozs7O0dBZUMsR0FDRCxxQkFBcUI7SUFBRSxRQUFRO0VBQVU7RUFHekM7Ozs7Ozs7Ozs7R0FVQyxHQUNELDBCQUEwQjtFQUMxQjs7Ozs7R0FLQyxHQUNELHFCQUFxQjtFQUNyQjs7Ozs7O0dBTUMsR0FDRCxvQkFBb0I7QUFDdEIsRUFBVztBQUVYOzs7Ozs7Ozs7OztDQVdDLEdBQ0QsT0FBTyxNQUFNLDhCQUFpRDtFQUM1RDtFQUNBO0VBQ0E7RUFDQTtFQUNBO0NBQ0QsQ0FBVTtBQUVYOzs7Ozs7Ozs7Ozs7OztDQWNDLEdBQ0QsT0FBTyxNQUFNLDZCQUFnRDtFQUMzRDtFQUNBO0NBQ0QsQ0FBVTtBQUVYOzs7Q0FHQyxHQUNELE9BQU8sTUFBTSxtQkFBbUI7RUFDOUIsZUFBZSxxQkFBcUIsYUFBYTtFQUNqRCx3QkFBd0IscUJBQXFCLHNCQUFzQjtBQUNyRSxFQUFXO0FBRVg7Ozs7O0NBS0MsR0FDRCxPQUFPLE1BQU0sc0JBQXNCLEdBQVk7QUFFL0M7Ozs7Q0FJQyxHQUNELE9BQU8sTUFBTSx3QkFBd0IsS0FBYztBQUVuRDs7Ozs7O0NBTUMsR0FDRCxPQUFPLE1BQU0sZUFBc0M7RUFBQztFQUFXO0NBQVMsQ0FBQztBQUV6RTs7Ozs7Q0FLQyxHQUNELE9BQU8sTUFBTSxzQkFBa0MsVUFBVTtBQUV6RDs7Ozs7Ozs7Ozs7Ozs7Q0FjQyxHQUNELE9BQU8sTUFBTSw0QkFBd0MsU0FBUztBQUU5RDs7O0NBR0MsR0FDRCxPQUFPLE1BQU0sNEJBQThEO0VBQ3pFO0VBQ0E7RUFDQTtDQUNELENBQUM7QUFFRjs7OztDQUlDLEdBQ0QsT0FBTyxNQUFNLDhCQUFxRCxRQUFRO0FBRTFFOzs7OztDQUtDLEdBQ0QsT0FBTyxNQUFNLGVBQWU7RUFBQztFQUFVO0VBQU07Q0FBTyxDQUFVO0FBRTlEOzs7Ozs7Ozs7O0NBVUMsR0FDRCxPQUFPLE1BQU0sb0JBQW9CLEVBQVc7QUFFNUM7Ozs7Ozs7Ozs7Q0FVQyxHQUNELE9BQU8sTUFBTSxtQkFBbUI7RUFDOUIsU0FBUztFQUNULFNBQVM7RUFDVCxVQUFVO0VBQ1YsU0FBUztBQUNYLEVBQVc7QUFFWDs7O0NBR0MsR0FDRCxPQUFPLE1BQU0sb0JBQW9CLFdBQW9CO0FBRXJELDBFQUEwRTtBQUMxRSwrRUFBK0U7QUFDL0UsNEVBQTRFO0FBQzVFLHdCQUF3QjtBQUV4Qjs7Ozs7Ozs7Ozs7Q0FXQyxHQUNELE9BQU8sTUFBTSxnQkFBZ0I7RUFDM0IsS0FBSztFQUNMLFFBQVE7RUFDUixNQUFNO0VBQ04sT0FBTztFQUNQLEtBQUs7QUFDUCxFQUFXO0FBRVg7OztDQUdDLEdBQ0QsT0FBTyxNQUFNLGlCQUFpQixPQUFnQjtBQUU5Qzs7Ozs7Ozs7O0NBU0MsR0FDRCxPQUFPLE1BQU0saUNBQWlDLE9BQWdCO0FBRTlEOzs7OztDQUtDLEdBQ0QsT0FBTyxNQUFNLGlDQUFpQyxPQUFnQjtBQUU5RDs7OztDQUlDLEdBQ0QsT0FBTyxNQUFNLCtCQUErQixPQUFnQjtBQUU1RDs7O0NBR0MsR0FDRCxPQUFPLE1BQU0sOEJBQThCLE9BQWdCO0FBRTNEOzs7Ozs7Q0FNQyxHQUNELE9BQU8sTUFBTSxpQ0FBaUMsT0FBZ0I7QUFFOUQ7OztDQUdDLEdBQ0QsT0FBTyxNQUFNLCtCQUErQixPQUFnQjtBQUU1RDs7O0NBR0MsR0FDRCxPQUFPLE1BQU0sb0NBQW9DLE9BQWdCO0FBRWpFOzs7Q0FHQyxHQUNELE9BQU8sTUFBTSxvQ0FBb0MsT0FBZ0I7QUFFakU7Ozs7O0NBS0MsR0FDRCxPQUFPLE1BQU0sbUNBQW1DLE9BQWdCO0FBRWhFOzs7OztDQUtDLEdBQ0QsT0FBTyxNQUFNLGlDQUFpQyxPQUFnQjtBQUU5RDs7Ozs7Q0FLQyxHQUNELE9BQU8sTUFBTSxzQ0FBc0MsT0FBZ0I7QUFFbkU7OztDQUdDLEdBQ0QsT0FBTyxNQUFNLHFDQUFxQyxNQUFlO0FBRWpFOzs7Q0FHQyxHQUNELE9BQU8sTUFBTSxrQ0FBa0MsTUFBZTtBQUU5RDs7O0NBR0MsR0FDRCxPQUFPLE1BQU0sK0JBQStCLE1BQWU7QUFFM0Q7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FzQkMsR0FDRCxPQUFPLE1BQU0sd0JBQTBEO0VBQ3JFLFVBQVU7RUFDVixVQUFVO0VBQ1YsdUVBQXVFO0VBQ3ZFLGlFQUFpRTtFQUNqRSxRQUFRO0VBQ1IsY0FBYztFQUNkLE9BQU87RUFDUCxVQUFVO0VBQ1YsUUFBUTtFQUNSLGFBQWE7RUFDYixhQUFhO0VBQ2IsNkVBQTZFO0VBQzdFLGdCQUFnQjtFQUNoQixZQUFZO0VBQ1osVUFBVTtFQUNWLGVBQWU7RUFDZixjQUFjO0VBQ2QsV0FBVztFQUNYLFFBQVE7RUFDUixzRUFBc0U7RUFDdEUsWUFBWTtBQUNkLEVBQVc7QUFFWDs7Ozs7O0NBTUMsR0FDRCxPQUFPLE1BQU0sdUJBQXVCLE9BQWdCO0FBRXBELDhFQUE4RTtBQUM5RSx3RUFBd0U7QUFDeEUsRUFBRTtBQUNGLHlFQUF5RTtBQUN6RSw2RUFBNkU7QUFDN0UsdUVBQXVFO0FBQ3ZFLCtFQUErRTtBQUMvRSwwRUFBMEU7QUFDMUUsdUVBQXVFO0FBQ3ZFLEVBQUU7QUFDRiw0RUFBNEU7QUFDNUUseUVBQXlFO0FBQ3pFLDRFQUE0RTtBQUM1RSwyREFBMkQ7QUFDM0QsK0VBQStFO0FBQy9FLHlFQUF5RTtBQUN6RSw2RUFBNkU7QUFDN0Usb0VBQW9FO0FBQ3BFLDhFQUE4RTtBQUM5RSw0RUFBNEU7QUFDNUUsOEVBQThFO0FBQzlFLCtFQUErRTtBQUMvRSwyRUFBMkU7QUFDM0UsdUVBQXVFO0FBQ3ZFLGlCQUFpQjtBQUNqQixFQUFFO0FBQ0YsMEVBQTBFO0FBQzFFLDBFQUEwRTtBQUMxRSw2RUFBNkU7QUFDN0UsK0VBQStFO0FBQy9FLG9FQUFvRTtBQUNwRSwwRUFBMEU7QUFDMUUsMEVBQTBFO0FBQzFFLCtFQUErRTtBQUMvRSwyRUFBMkU7QUFDM0UsMkVBQTJFO0FBQzNFLDBFQUEwRTtBQUMxRSw2RUFBNkU7QUFDN0UsdUVBQXVFO0FBQ3ZFLEVBQUU7QUFDRixtRUFBbUU7QUFDbkUsd0VBQXdFO0FBQ3hFLGdEQUFnRDtBQUNoRCw4RUFBOEU7QUFFOUU7Ozs7Ozs7Ozs7Ozs7O0NBY0MsR0FDRCxPQUFPLE1BQU0sZ0NBQWdDLE9BQWdCO0FBRTdELHFGQUFxRixHQUNyRixPQUFPLE1BQU0sZ0NBQWdDLDhCQUE4QjtBQUUzRTs7Ozs7Ozs7Ozs7Ozs7OztDQWdCQyxHQUNELE9BQU8sTUFBTSw4QkFBOEIsR0FBWTtBQUV2RCxxRkFBcUYsR0FDckYsT0FBTyxNQUFNLGdDQUFnQyw4QkFBOEI7QUFFM0U7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sTUFBTSw4QkFBOEIsOEJBQThCO0FBRXpFOzs7Ozs7Ozs7Ozs7Q0FZQyxHQUNELE9BQU8sU0FBUztFQUNkLE9BQU87SUFBQztJQUEyQjtHQUEwQjtBQUMvRDtBQUVBLDJFQUEyRSxHQUMzRSxPQUFPLFNBQVM7RUFDZCxPQUFPO0FBQ1Q7QUFFQTs7Ozs7Ozs7Ozs7O0NBWUMsR0FDRCxPQUFPLE1BQU0sNkJBQTZCLFNBQWtCO0FBRTVEOzs7O0NBSUMsR0FDRCxPQUFPLE1BQU0sa0NBQWtDLDhCQUE4QjtBQUU3RSw2REFBNkQsR0FDN0QsT0FBTyxNQUFNLDhCQUE4QixTQUFrQjtBQUU3RDs7OztDQUlDLEdBQ0QsT0FBTyxNQUFNLGdDQUFnQyw4QkFBOEI7QUFFM0Usa0VBQWtFLEdBQ2xFLE9BQU8sTUFBTSxtQ0FBbUMsU0FBa0I7QUFFbEUsa0VBQWtFLEdBQ2xFLE9BQU8sTUFBTSxtQ0FBbUMsU0FBa0I7QUFFbEU7Ozs7Q0FJQyxHQUNELE9BQU8sTUFBTSxnQ0FBZ0MsOEJBQThCO0FBRTNFOzs7O0NBSUMsR0FDRCxPQUFPLE1BQU0scUNBQXFDLDhCQUE4QjtBQUVoRjs7O0NBR0MsR0FDRCxPQUFPLE1BQU0sb0NBQW9DLFFBQWlCO0FBRWxFOzs7O0NBSUMsR0FDRCxPQUFPLE1BQU0saUNBQWlDLFFBQWlCO0FBRS9EOzs7Q0FHQyxHQUNELE9BQU8sTUFBTSw4QkFBOEIsUUFBaUI7QUFFNUQ7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sTUFBTSxxQkFBOEQ7RUFDekUsT0FBTztFQUNQLE1BQU07RUFDTixRQUFRO0VBQ1IsT0FBTztBQUNULEVBQVc7QUFFWDs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sU0FBUyxnQkFBZ0IsWUFBb0I7RUFDbEQsNkJBQTZCO0VBQzdCLElBQUksZ0JBQWdCLG9CQUFvQjtJQUN0QyxPQUFPLGtCQUFrQixDQUFDLGFBQWEsSUFBSTtFQUM3QztFQUVBLGtFQUFrRTtFQUNsRSxLQUFLLE1BQU0sUUFBUSxPQUFPLElBQUksQ0FBQyxvQkFBcUI7SUFDbEQsSUFDRSxhQUFhLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxLQUFLLGFBQWEsUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLE1BQU0sR0FDdEU7TUFDQSxPQUFPLGtCQUFrQixDQUFDLEtBQUssSUFBSTtJQUNyQztFQUNGO0VBRUEsT0FBTztBQUNUO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FtQkMsR0FDRCxPQUFPLE1BQU0sdUJBQ1gsb0JBQW9CO0VBQ2xCLE1BQU07RUFDTixVQUFVO0VBQ1YsTUFBTTtBQUNSLEdBQUc7QUFFTCw4RUFBOEU7QUFDOUUsb0RBQW9EO0FBQ3BELEVBQUU7QUFDRiwyREFBMkQ7QUFDM0QseUVBQXlFO0FBQ3pFLDJFQUEyRTtBQUMzRSwyRUFBMkU7QUFDM0UsOEVBQThFO0FBQzlFLGlFQUFpRTtBQUNqRSxFQUFFO0FBQ0YsZ0ZBQWdGO0FBQ2hGLDBFQUEwRTtBQUMxRSxtRUFBbUU7QUFDbkUsMEVBQTBFO0FBQzFFLHlEQUF5RDtBQUN6RCwrRUFBK0U7QUFDL0UsMENBQTBDO0FBQzFDLDhFQUE4RTtBQUU5RTs7Ozs7Ozs7O0NBU0MsR0FDRCxPQUFPLE1BQU0sK0JBQStCLGNBQXVCO0FBRW5FOzs7Ozs7O0NBT0MsR0FDRCxPQUFPLE1BQU0sc0JBQXNCLGNBQXVCO0FBRTFEOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxNQUFNLGlDQUFpQyxhQUFzQjtBQUVwRTs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxNQUFNLHNCQUFzQjtFQUNqQyxTQUFTO0VBQ1QsS0FBSztFQUNMLFFBQVE7RUFDUixNQUFNO0FBQ1IsRUFBVztBQUVYOzs7Ozs7O0NBT0MsR0FDRCxPQUFPLE1BQU0sNkJBQ1gsb0JBQW9CO0VBQ2xCLE1BQU07RUFDTixVQUFVO0VBQ1YsTUFBTTtBQUNSLEdBQUc7QUFFTDs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxNQUFNLDhCQUFnRTtFQUMzRSxVQUFVLG9CQUFvQixJQUFJO0VBQ2xDLFVBQVUsb0JBQW9CLElBQUk7RUFDbEMsUUFBUSxvQkFBb0IsSUFBSTtFQUNoQyxjQUFjLG9CQUFvQixJQUFJO0VBQ3RDLFlBQVksb0JBQW9CLElBQUk7RUFDcEMsVUFBVSxvQkFBb0IsSUFBSTtFQUNsQyxVQUFVLG9CQUFvQixJQUFJO0VBQ2xDLGVBQWUsb0JBQW9CLElBQUk7RUFDdkMsT0FBTyxvQkFBb0IsSUFBSTtFQUMvQixRQUFRLG9CQUFvQixNQUFNO0VBQ2xDLGFBQWEsb0JBQW9CLE1BQU07RUFDdkMsYUFBYSxvQkFBb0IsTUFBTTtFQUN2QyxtRkFBbUY7RUFDbkYsZ0JBQWdCLG9CQUFvQixNQUFNO0VBQzFDLGNBQWMsb0JBQW9CLEdBQUc7RUFDckMsV0FBVyxvQkFBb0IsR0FBRztFQUNsQyxRQUFRLG9CQUFvQixHQUFHO0VBQy9CLHVEQUF1RDtFQUN2RCxZQUFZLG9CQUFvQixHQUFHO0FBQ3JDLEVBQVc7QUFFWCw4RUFBOEU7QUFDOUUscURBQXFEO0FBQ3JELEVBQUU7QUFDRiw4REFBOEQ7QUFDOUQsMEVBQTBFO0FBQzFFLCtFQUErRTtBQUMvRSw4RUFBOEU7QUFDOUUsNEVBQTRFO0FBQzVFLHlFQUF5RTtBQUN6RSxpRUFBaUU7QUFDakUscUVBQXFFO0FBQ3JFLEVBQUU7QUFDRixzRUFBc0U7QUFDdEUsNkVBQTZFO0FBQzdFLDREQUE0RDtBQUM1RCw0RUFBNEU7QUFDNUUsMERBQTBEO0FBQzFELHdFQUF3RTtBQUN4RSxrREFBa0Q7QUFDbEQsOEVBQThFO0FBRTlFOzs7Ozs7Q0FNQyxHQUNELE9BQU8sTUFBTSxnQ0FBZ0MsaUJBQTBCO0FBRXZFOzs7O0NBSUMsR0FDRCxPQUFPLE1BQU0sdUJBQXVCLG1CQUE0QjtBQUVoRTs7OztDQUlDLEdBQ0QsT0FBTyxNQUFNLGtDQUFrQyx3QkFBaUM7QUFFaEY7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sTUFBTSw4QkFDWCxvQkFBb0I7RUFDbEIsTUFBTTtFQUNOLFVBQVU7RUFDVixNQUFNO0FBQ1IsR0FBRztBQUVMLDhFQUE4RTtBQUM5RSx1REFBdUQ7QUFDdkQsRUFBRTtBQUNGLCtFQUErRTtBQUMvRSx3RUFBd0U7QUFDeEUseUVBQXlFO0FBQ3pFLHVFQUF1RTtBQUN2RSw0RUFBNEU7QUFDNUUsMEJBQTBCO0FBQzFCLEVBQUU7QUFDRixnRUFBZ0U7QUFDaEUsK0VBQStFO0FBQy9FLDBFQUEwRTtBQUMxRSw4RUFBOEU7QUFDOUUsZ0ZBQWdGO0FBQ2hGLGdGQUFnRjtBQUNoRixFQUFFO0FBQ0YsNkVBQTZFO0FBQzdFLHlFQUF5RTtBQUN6RSwyRUFBMkU7QUFDM0UsNEVBQTRFO0FBQzVFLGVBQWU7QUFDZiw4RUFBOEU7QUFFOUU7Ozs7OztDQU1DLEdBQ0QsT0FBTyxNQUFNLGtDQUFrQyxrQkFBMkI7QUFFMUU7Ozs7Q0FJQyxHQUNELE9BQU8sTUFBTSx5QkFBeUIsaUJBQTBCO0FBRWhFOzs7Ozs7Ozs7Ozs7Q0FZQyxHQUNELE9BQU8sTUFBTSxnQ0FDWCxvQkFBb0I7RUFDbEIsTUFBTTtFQUNOLFVBQVU7RUFDVixNQUFNO0FBQ1IsR0FBRztBQUVMLHVFQUF1RSxHQUN2RSxPQUFPLE1BQU0sdUJBQXVCO0VBQ2xDLFFBQVE7SUFDTixNQUFNO0lBQ04sVUFBVTtJQUNWLE1BQU07RUFDUjtFQUNBLE9BQU87SUFDTCxNQUFNO0lBQ04sVUFBVTtJQUNWLE1BQU07RUFDUjtFQUNBLFFBQVE7SUFDTixNQUFNO0lBQ04sVUFBVTtJQUNWLE1BQU07RUFDUjtFQUNBLFVBQVU7SUFDUixNQUFNO0lBQ04sVUFBVTtJQUNWLE1BQU07RUFDUjtBQUNGLEVBQVc7QUFRWDs7Ozs7Ozs7OztDQVVDLEdBQ0QsT0FBTyxTQUFTLHlCQUNkLFlBQW9DLENBQUMsQ0FBQztFQUV0QyxPQUFPO0lBQ0wsZ0JBQWdCLEVBQUU7SUFDbEIsZUFBZTtJQUNmLFlBQVk7SUFDWixhQUFhLEVBQUU7SUFDZixPQUFPLEVBQUU7SUFDVCxzRUFBc0U7SUFDdEUsaUVBQWlFO0lBQ2pFLGlFQUFpRTtJQUNqRSxhQUFhO01BQUMsZUFBZSxnQkFBZ0I7S0FBQztJQUM5Qyx3RUFBd0U7SUFDeEUsMEVBQTBFO0lBQzFFLHNCQUFzQjtTQUFJO0tBQTJCO0lBQ3JELHNFQUFzRTtJQUN0RSxpRUFBaUU7SUFDakUsaUJBQWlCLEVBQUU7SUFDbkIsd0VBQXdFO0lBQ3hFLDBFQUEwRTtJQUMxRSxhQUFhO0lBQ2IsWUFBWTtJQUNaLG1CQUFtQjtTQUFJO0tBQTRCO0lBQ25ELGdCQUFnQixFQUFFO0lBQ2xCLGFBQWEsZUFBZSxXQUFXO0lBQ3ZDLGlCQUFpQixlQUFlLGVBQWU7SUFDL0MsYUFBYSxlQUFlLFdBQVc7SUFDdkMsa0JBQWtCLGVBQWUsZ0JBQWdCO0lBQ2pELGVBQWUsZUFBZSxhQUFhO0lBQzNDLGVBQWUsZUFBZSxhQUFhO0lBQzNDLG9CQUFvQixlQUFlLGtCQUFrQjtJQUNyRCxpQkFBaUIsZUFBZSxlQUFlO0lBQy9DLGNBQWMsZUFBZSxZQUFZO0lBQ3pDLGFBQWEsZUFBZSxXQUFXO0lBQ3ZDLGtCQUFrQixlQUFlLGdCQUFnQjtJQUNqRCxTQUFTO0lBQ1QsMEVBQTBFO0lBQzFFLFNBQVM7SUFDVCx3RUFBd0U7SUFDeEUsbUVBQW1FO0lBQ25FLFlBQVk7SUFDWixrRUFBa0U7SUFDbEUsZUFBZTtJQUNmLHVFQUF1RTtJQUN2RSxzRUFBc0U7SUFDdEUsdUJBQXVCO01BQUM7S0FBMEI7SUFDbEQsdUJBQXVCLEVBQUU7SUFDekIsdUVBQXVFO0lBQ3ZFLHVFQUF1RTtJQUN2RSx1RUFBdUU7SUFDdkUsc0VBQXNFO0lBQ3RFLDBEQUEwRDtJQUMxRCxxQkFBcUI7SUFDckIsYUFBYTtJQUNiLDRFQUE0RTtJQUM1RSxtQkFBbUI7SUFDbkIsZUFBZSxxQkFBcUIsYUFBYTtJQUNqRCxnQkFBZ0IscUJBQXFCLGNBQWM7SUFDbkQsdUJBQXVCLHFCQUFxQixxQkFBcUI7SUFDakUsa0JBQWtCLHFCQUFxQixnQkFBZ0I7SUFDdkQsc0VBQXNFO0lBQ3RFLG9CQUFvQjtTQUFJO0tBQXdCO0lBQ2hELDBCQUEwQixxQkFBcUIsd0JBQXdCO0lBQ3ZFLGtFQUFrRTtJQUNsRSx3QkFBd0IscUJBQXFCLHNCQUFzQjtJQUNuRSwrQkFDRSxxQkFBcUIsNkJBQTZCO0lBQ3BELCtCQUNFLHFCQUFxQiw2QkFBNkI7SUFDcEQsK0JBQ0UscUJBQXFCLDZCQUE2QjtJQUNwRCxrQkFBa0IscUJBQXFCLGdCQUFnQjtJQUN2RCxnQkFBZ0IscUJBQXFCLGNBQWM7SUFDbkQsd0JBQXdCLHFCQUFxQixzQkFBc0I7SUFDbkUscUJBQXFCLHFCQUFxQixtQkFBbUI7SUFDN0QsZ0RBQWdEO0lBQ2hELG9CQUFvQixxQkFBcUIsa0JBQWtCO0lBQzNELG1CQUFtQixxQkFBcUIsaUJBQWlCO0lBQ3pELG9CQUFvQixxQkFBcUIsa0JBQWtCO0lBQzNELDBDQUEwQztJQUMxQyxzQkFBc0IscUJBQXFCLG9CQUFvQjtJQUMvRCx1QkFBdUIscUJBQXFCLHFCQUFxQjtJQUNqRSxpRUFBaUU7SUFDakUsZ0NBQ0UscUJBQXFCLDhCQUE4QjtJQUNyRCxvQ0FDRSxxQkFBcUIsa0NBQWtDO0lBQ3pELG1CQUFtQixxQkFBcUIsaUJBQWlCO0lBQ3pELGNBQWMscUJBQXFCLFlBQVk7SUFDL0MsaUJBQWlCLHFCQUFxQixlQUFlO0lBQ3JELHdCQUF3QixxQkFBcUIsc0JBQXNCO0lBQ25FLGVBQWUscUJBQXFCLGFBQWE7SUFDakQscUJBQXFCLHFCQUFxQixtQkFBbUI7SUFDN0Qsb0JBQW9CLHFCQUFxQixrQkFBa0I7SUFDM0QsbUJBQW1CLHFCQUFxQixpQkFBaUI7SUFDekQscUJBQXFCLHFCQUFxQixtQkFBbUI7SUFDN0QsaUJBQWlCLHFCQUFxQixlQUFlO0lBQ3JELG1CQUFtQixxQkFBcUIsaUJBQWlCO0lBQ3pELGlCQUFpQixxQkFBcUIsZUFBZTtJQUNyRCxtQkFBbUIscUJBQXFCLGlCQUFpQjtJQUN6RCxzQkFBc0IscUJBQXFCLG9CQUFvQjtJQUMvRCx3QkFBd0IscUJBQXFCLHNCQUFzQjtJQUNuRSxrQkFBa0IscUJBQXFCLGdCQUFnQjtJQUN2RCxnQkFBZ0IscUJBQXFCLGNBQWM7SUFDbkQsa0JBQWtCLHFCQUFxQixnQkFBZ0I7SUFDdkQsZUFBZSxxQkFBcUIsYUFBYTtJQUNqRCxpQkFBaUIscUJBQXFCLGVBQWU7SUFDckQsZ0JBQWdCO0lBQ2hCLGFBQWE7SUFDYixxQkFBcUIscUJBQXFCLG1CQUFtQjtJQUM3RCxrQkFBa0IscUJBQXFCLGdCQUFnQjtJQUN2RCwwQkFBMEIscUJBQXFCLHdCQUF3QjtJQUN2RSxlQUFlLHFCQUFxQixhQUFhO0lBQ2pELG9CQUFvQixxQkFBcUIsa0JBQWtCO0lBQzNELGtCQUFrQixxQkFBcUIsZ0JBQWdCO0lBQ3ZELG9CQUFvQixxQkFBcUIsa0JBQWtCO0lBQzNELHFCQUFxQixxQkFBcUIsbUJBQW1CO0lBQzdELHVCQUF1QixxQkFBcUIscUJBQXFCO0lBQ2pFLHFCQUFxQixxQkFBcUIsbUJBQW1CO0lBQzdELHdFQUF3RTtJQUN4RSxxRUFBcUU7SUFDckUsMEVBQTBFO0lBQzFFLGdCQUFnQixxQkFBcUIsY0FBYztJQUNuRCxjQUFjO0lBQ2QsWUFBWTtJQUNaLHFCQUFxQixxQkFBcUIsbUJBQW1CO0lBQzdELGdCQUFnQixxQkFBcUIsY0FBYztJQUNuRCx1QkFBdUIscUJBQXFCLHFCQUFxQjtJQUNqRSxvQkFBb0IscUJBQXFCLGtCQUFrQjtJQUMzRCwwQkFBMEIscUJBQXFCLHdCQUF3QjtJQUN2RSw0QkFBNEIscUJBQXFCLDBCQUEwQjtJQUMzRSwyQkFBMkIscUJBQXFCLHlCQUF5QjtJQUN6RSwwQkFBMEIscUJBQXFCLHdCQUF3QjtJQUN2RSxxQkFBcUIsQ0FBQztJQUN0QixzQkFBc0IsQ0FBQztJQUN2QiwwQkFBMEIsQ0FBQztJQUMzQiwyQkFBMkIsQ0FBQztJQUM1QiwyQkFBMkIsQ0FBQztJQUM1Qiw2QkFBNkIsQ0FBQztJQUM5QixvQkFBb0IscUJBQXFCLGtCQUFrQjtJQUMzRCxtQkFBbUIscUJBQXFCLGlCQUFpQjtJQUN6RCxxQkFBcUIscUJBQXFCLG1CQUFtQjtJQUM3RCx1QkFBdUIscUJBQXFCLHFCQUFxQjtJQUNqRSwrQkFBK0IsQ0FBQztJQUNoQyx1QkFBdUIscUJBQXFCLHFCQUFxQjtJQUNqRSw2QkFDRSxxQkFBcUIsMkJBQTJCO0lBQ2xELDJCQUEyQixxQkFBcUIseUJBQXlCO0lBQ3pFLHlCQUF5QixxQkFBcUIsdUJBQXVCO0lBQ3JFLCtCQUNFLHFCQUFxQiw2QkFBNkI7SUFDcEQsb0JBQW9CLHFCQUFxQixrQkFBa0I7SUFDM0QseUVBQXlFO0lBQ3pFLGtCQUFrQjtNQUNoQixTQUFTLHFCQUFxQixnQkFBZ0IsQ0FBQyxPQUFPO0lBQ3hEO0lBQ0EsV0FBVztNQUFFLFNBQVMscUJBQXFCLFNBQVMsQ0FBQyxPQUFPO0lBQUM7SUFDN0QseUJBQXlCLHFCQUFxQix1QkFBdUI7SUFDckUscUJBQXFCLHFCQUFxQixtQkFBbUI7SUFDN0QsV0FBVztJQUNYLDZCQUNFLHFCQUFxQiwyQkFBMkI7SUFDbEQsMkJBQTJCLHFCQUFxQix5QkFBeUI7SUFDekUsMkJBQTJCLHFCQUFxQix5QkFBeUI7SUFDekUsb0VBQW9FO0lBQ3BFLHFFQUFxRTtJQUNyRSx1REFBdUQ7SUFDdkQsMEJBQTBCLHFCQUFxQix3QkFBd0I7SUFDdkUsc0VBQXNFO0lBQ3RFLDZFQUE2RTtJQUM3RSx5RUFBeUU7SUFDekUsd0VBQXdFO0lBQ3hFLHlFQUF5RTtJQUN6RSxnREFBZ0Q7SUFDaEQseUJBQXlCLHFCQUFxQix1QkFBdUI7SUFDckUscUJBQXFCLHFCQUFxQixtQkFBbUI7SUFDN0Qsa0JBQWtCLHFCQUFxQixnQkFBZ0I7SUFDdkQsd0JBQXdCLHFCQUFxQixzQkFBc0I7SUFDbkUsMkJBQTJCO1NBQ3RCLHFCQUFxQix5QkFBeUI7S0FDbEQ7SUFDRCwwQkFBMEIscUJBQXFCLHdCQUF3QjtJQUN2RSxxQkFBcUIscUJBQXFCLG1CQUFtQjtJQUM3RCxrRUFBa0U7SUFDbEUsb0JBQW9CLHFCQUFxQixrQkFBa0I7SUFDM0Qsb0VBQW9FO0lBQ3BFLCtEQUErRDtJQUMvRCx5QkFBeUIsQ0FBQztJQUMxQix5RUFBeUU7SUFDekUsMkVBQTJFO0lBQzNFLDJFQUEyRTtJQUMzRSxxREFBcUQ7SUFDckQsaUJBQWlCLG1CQUFtQjtJQUNwQyx5RUFBeUU7SUFDekUscUJBQXFCO01BQUUsR0FBRyxxQkFBcUIsbUJBQW1CO0lBQUM7SUFDbkUsd0VBQXdFO0lBQ3hFLG9EQUFvRDtJQUNwRCxvQkFBb0IsRUFBRTtJQUN0Qix3RUFBd0U7SUFDeEUsK0NBQStDO0lBQy9DLFdBQVc7SUFDWCx1RUFBdUU7SUFDdkUscUNBQXFDO0lBQ3JDLGNBQWM7TUFBRSxHQUFHLHFCQUFxQixZQUFZO0lBQUM7SUFDckQsR0FBRyxTQUFTO0VBQ2Q7QUFDRiJ9
// denoCacheMetadata=2583929967517781293,12885935273151464005