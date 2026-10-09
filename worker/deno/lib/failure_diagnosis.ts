/**
 * Context-aware failure diagnosis for issue failure comments (Issue #398, #909).
 *
 * Replaces generic "Why this might be happening" with category-specific advice
 * based on the actual failure message content.
 *
 * Migrated from worker/shared/failure_diagnosis.sh (Issue #909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertNever } from "./assert_never.ts";
import { isWorkflowScopePushRefusal } from "./workflow_scope.ts";
import { isRepoLevelMilestoneBranchRefusal } from "./milestone_branch_rejection.ts";
import {
  type ExtensionTelemetry,
  formatTimeoutExtensionSummary,
} from "./timeout_extension_telemetry.ts";

/**
 * Out-of-credit / billing signals — account state, not a worker or repository
 * fault. `API Error: 402` is the agent CLI's own line when the API refuses a
 * run for payment (Issue #2590); anchored to a line start so prose quoting a
 * 402 does not match.
 */
const OUT_OF_CREDIT_RE =
  /out of credit|credit balance|insufficient (?:balance|credit|funds|quota)|payment required|billing (?:hard )?limit|quota exceeded|^\s*api error:\s*402\b/im;

/** Whether `message` reports an out-of-credit / billing refusal. */
export function isOutOfCreditMessage(message: string): boolean {
  return OUT_OF_CREDIT_RE.test(message);
}

/** Failure category string — returned by detectFailureCategory(). */
export type FailureCategory =
  | "timeout"
  | "rate_limit"
  | "zero_output"
  /** SIGKILLed without a watchdog firing — possible VM OOM (Issue #4202). */
  | "killed"
  | "quality_check"
  | "push_failure"
  /**
   * The worker's token lacks the `workflow` OAuth scope and the run's diff
   * touches `.github/workflows/`, so the push would be rejected (Issue
   * #1475). A property of the host's credential, not of the issue.
   */
  | "token_scope"
  | "no_changes"
  | "evidence_missing"
  /**
   * A pre-PR gate the worker itself applied refused the run (Issue #2044) —
   * today the changed-workflow file checks. The worker wrote the refusal, so
   * its cause is known: recording it as `unknown` blamed an unexplained
   * failure for a block the worker had already explained.
   */
  | "workflow_gate"
  | "internal_error"
  | "missing_tools"
  /**
   * The run was cut off before it could finish — the agent's own output shows
   * it was still working (blocked on a slow quality gate, out of turn budget)
   * rather than concluding. Infrastructure/transient, not an issue property:
   * retried, never escalated to a human as analysis-only (Issue #108).
   */
  | "interrupted"
  /**
   * The run was released on schedule (Issue #424, parent #397) — the cycle
   * ended, or the supervisor's wall-clock hard cap (Issue #421) left no
   * runway — with the agent's work in progress committed and pushed to the
   * issue branch. A handover, not the issue defeating a full budget: the
   * next claim resumes the branch.
   */
  | "scheduled_release"
  /**
   * The repository refused the milestone branch this run needed — a ruleset,
   * a branch protection, or a permission the fleet account lacks (Issue
   * #2220). A property of the REPOSITORY, not of the issue: the same refusal
   * meets every sibling issue in the milestone, so it must not be recorded
   * against any of them. Categorised `unknown` until now, which sent sixteen
   * GRQ-FX-validation sub-issues up the `failed-once` → `failed` ladder for
   * one `do_not_enforce_on_create: false` flag.
   */
  | "repo_config"
  /**
   * The agent CLI refused the run with `Prompt is too long` (Issue #2682) — the
   * transcript no longer fits the model's context window. A worker fault: the
   * first on a resumed session is retried on a fresh session uncounted, so a
   * failure recorded here is one a fresh session could not clear either.
   */
  | "prompt_too_long"
  /**
   * Branch creation failed because the host's shared clone of the repository
   * is damaged — broken refs or a corrupt object store (Issue #2884). A fault
   * of the HOST, not of the issue: an in-process retry against the same
   * damaged clone would fail identically, so it must never count against the
   * issue's retry budget.
   */
  | "clone_corrupt"
  /**
   * The PR-summary gates refused the run (Issue #3431). The agent's deliverable
   * fell short; the worker did not malfunction.
   */
  | "summary_incomplete"
  | "unknown";

/** Clarity status — whether the issue was assessed for clarity before failure. */
export type ClarityStatus = "assessed_clear" | "skipped" | "not_assessed";

/** User-facing display name for a failure category (kebab-case). */
export type CategoryDisplay =
  | "timeout"
  | "rate-limit"
  | "no-output"
  | "killed"
  | "quality-failure"
  | "missing-tools"
  /** Issue #1475: the host's token lacks the `workflow` scope. */
  | "token-scope"
  /** Issue #2044: a pre-PR gate the worker applied refused the run. */
  | "workflow-gate"
  | "infrastructure-error"
  | "task-not-understood"
  | "scheduled-release"
  /** Issue #2220: the repository refused the milestone branch. */
  | "repo-config"
  /** Issue #2682: the agent CLI refused the run as `Prompt is too long`. */
  | "prompt-too-long"
  /** Issue #2884: the host's shared clone is damaged (broken refs / corrupt object store). */
  | "clone-corrupt"
  /** Issue #3431: the PR-summary gates refused the run. */
  | "summary-incomplete"
  | "unknown";

/** Parsed diagnostic context for zero-output failures (Issue #533). */
export interface DiagnosticContext {
  healthCheck?: string;
  clarity?: string;
  elapsedSeconds?: string;
  noOutputTimeout?: string;
  claudeTimeout?: string;
  retryCount?: string;
  maxRetries?: string;
  /**
   * Extension history from the re-armable hard deadline (Issue #4298). Present
   * only when the feature was active for the run; without it the diagnosis
   * reads exactly as it did before #4290.
   */
  extensionsGranted?: string;
  extendedSeconds?: string;
  finalDeadlineSeconds?: string;
  extensionRefused?: string;
}

/**
 * Why a run stopped on schedule rather than failing (Issue #424, parent #397).
 *
 * - `"cycle-ended"` — the worker's own shutdown ended the agent run.
 * - `"hard-cap"` — the supervisor's wall-clock cap left no runway, so the
 *   worker stopped itself first to preserve the work (Issue #421).
 */
export type ScheduledReleaseReason = "cycle-ended" | "hard-cap";

/**
 * Phrase that opens a scheduled-release failure reason (Issue #424).
 *
 * The kill path is the only place that knows a release was scheduled, so it
 * writes this marker into the reason and every downstream reader — the
 * category detector, the cooldown classifier, the failure ladder — keys off
 * it rather than re-deriving the answer from an exit status a genuine
 * timeout shares.
 */
export const SCHEDULED_RELEASE_MARKER = "Released on schedule:";

/**
 * Phrase the changed-workflow gate opens its refusal with (Issue #2044).
 *
 * The gate is the worker's own, so the reason it fails a run with is one the
 * worker wrote — and a worker-authored refusal must never be diagnosed
 * `unknown`. The message builder in `changed_workflow_gate.ts` and the
 * category detector below therefore share this one phrase rather than each
 * carrying its own copy, which is what let the wording drift apart from the
 * diagnosis in the first place.
 */
export const WORKFLOW_GATE_MARKER =
  "did not pass the GitHub Actions file checks";

/**
 * Phrase the worker opens a `Prompt is too long` failure reason with (Issue
 * #2682). Worker-authored, like {@link WORKFLOW_GATE_MARKER}: the detector
 * keys off the worker's own words, never the agent's prose.
 */
export const PROMPT_TOO_LONG_MARKER =
  "The agent CLI refused the run: Prompt is too long";

/**
 * Phrase the setup phase opens a broken-shared-clone failure reason with
 * (Issue #2884). Worker-authored, like {@link WORKFLOW_GATE_MARKER}: the
 * setup phase (`lib/phases/setup_branch_phase.ts`) puts this in its failure
 * reason when branch creation fails because the host's shared clone has
 * broken refs or a corrupt object store, and the detector keys off the
 * worker's own words rather than sniffing raw git error text.
 */
export const CLONE_CORRUPT_MARKER =
  "the host's shared clone of this repository is damaged";

/**
 * Phrase the completion phase opens a PR-summary gate refusal with (Issue
 * #3431). Worker-authored, like {@link WORKFLOW_GATE_MARKER}: the gates' own
 * text quotes the agent's summary (a Rust `AppError::X` path once tripped the
 * catch-all `Error:` rule), so the detector keys off this worker phrase. The
 * agent's quoted text cannot forge a worse category because the marker is a
 * prefix the detector matches with `startsWith`, ahead of the killed, timeout,
 * rate_limit and interrupted rules (unlike the workflow gate, which is
 * matched after them).
 */
export const SUMMARY_RULE_GATE_MARKER =
  "the PR summary did not pass the worker's completion gates";

/**
 * The catch-all `Error:` rule of {@link detectFailureCategory}. A Rust/C++
 * path such as `AppError::X` is not an `Error:` line, so `Error::` is excluded
 * (Issue #3431). The lookahead is a single-character check, so it stays linear.
 */
const ERROR_COLON_RE = /Error:(?!:)/;

/**
 * The operator-facing reason line for a scheduled release (Issue #424).
 *
 * `preservedNote` is the note preservation itself wrote (Issue #770) — it
 * names the branch the push actually targeted, and the handover file on it
 * when one exists. Folded in here rather than appended by the caller so the
 * reason states where the work is exactly once. Without it the wording is
 * unchanged: a release that preserved nothing must not name a branch no push
 * ever reached.
 */
export function buildScheduledReleaseReason(
  reason: ScheduledReleaseReason,
  preservedNote?: string,
): string {
  const cause = reason === "hard-cap"
    ? "the supervisor's run hard cap was reached"
    : "the cycle ended";
  return `${SCHEDULED_RELEASE_MARKER} ${cause} — ` +
    (preservedNote ?? "WIP preserved, resumes next cycle");
}

/**
 * Analyse a failure message and return a category.
 *
 * Examines the failure message text for known patterns and returns a category
 * string that can be used to select appropriate diagnosis messaging.
 *
 * Order matters: more specific patterns are checked before general ones.
 */
export function detectFailureCategory(failureMessage: string): FailureCategory {
  if (!failureMessage) return "unknown";

  // A scheduled release outranks every other pattern (Issue #424, parent
  // #397). Such a message legitimately carries the watchdog line, a
  // `Timeout: Ns` figure and a SIGTERM exit — the run WAS stopped by the
  // worker's own kill — so inferring from the exit status alone would
  // classify a handover as the issue running out of time. The kill path
  // knows which release it took and says so in the reason; that marker is
  // the discriminator.
  if (failureMessage.includes(SCHEDULED_RELEASE_MARKER)) {
    return "scheduled_release";
  }

  // The completion phase's own PR-summary gate refusal (Issue #3431; PR #3440
  // review). Anchored to the START of the message and checked before every
  // free-text rule below: the refusal quotes the agent's own summary, so a
  // quoted "timeout", "SIGTERM", "rate limit" or `TypeError:` must not outrank
  // it. The marker is a prefix the worker writes, so a message that merely
  // quotes the marker later (a timeout or kill that began with the worker's
  // own text) is not a gate refusal.
  if (failureMessage.startsWith(SUMMARY_RULE_GATE_MARKER)) {
    return "summary_incomplete";
  }

  // The worker's OWN watchdog ends a timed-out agent with SIGTERM (then
  // SIGKILL), so a genuine timeout's diagnostics legitimately read
  // `Raw exit code: 143 (SIGTERM)` or `137 (SIGKILL)`. That evidence must not
  // be mistaken for an external kill (VibeCoder#174: every hard timeout was
  // classified `killed`, retried in-process with 60 s of runway, and blamed
  // on the OOM killer). `Watchdog:` only appears in messages the timeout
  // path builds, so it is the discriminator.
  const ownWatchdogFired = watchdogFiredIn(failureMessage);

  // SIGKILL first (Issue #4202): a killed run's message must never be read as
  // a timeout — that mislabelling is precisely what this category exists to
  // end. The signal name is the discriminator because it only appears when
  // the runner classified a genuine kill.
  if (!ownWatchdogFired && failureMessage.includes("SIGKILL")) {
    return "killed";
  }

  // Issue #46: an external SIGTERM the worker never requested is an
  // environment kill too — not a property of the issue. Classify it as
  // `killed` (infrastructure) so it is retried and not blamed on the issue.
  if (!ownWatchdogFired && failureMessage.includes("SIGTERM")) {
    return "killed";
  }

  // Timeout with zero output is zero_output, not timeout
  if (
    failureMessage.includes("timed out") || failureMessage.includes("timeout")
  ) {
    if (
      failureMessage.includes("zero output") ||
      failureMessage.includes("No output captured")
    ) {
      return "zero_output";
    }
    return "timeout";
  }

  // Case-insensitive, and the subscription usage window counts too (Issue
  // #4315): "Rate limit …" / "Claude usage limit reached" escaping here
  // landed in `unknown`, which is not infrastructure — the issue was then
  // blamed and labelled failed for an account-level cap.
  const lowered = failureMessage.toLowerCase();
  if (
    lowered.includes("rate limit") ||
    lowered.includes("rate-limited") ||
    lowered.includes("usage limit") ||
    // Out of credit is an account state too (Issue #2590): counted as
    // internal_error it backed off a healthy repository as a fast failure.
    isOutOfCreditMessage(failureMessage)
  ) {
    return "rate_limit";
  }

  // A run cut off before finishing (Issue #108). The message is one the worker
  // constructs (handle_no_changes_phase) with this stable marker, so the match
  // is exact rather than sniffing arbitrary agent prose.
  if (lowered.includes("interrupted before completing")) {
    return "interrupted";
  }

  // A gate the worker itself applied (Issue #2044). Deliberately checked
  // AFTER the kill, timeout, rate-limit and interrupted rules: those messages
  // quote the tail of the agent's output, and an agent writing *about* this
  // gate must not turn its timeout into a gate block (the #249 lesson). By
  // here the message is the worker's own refusal.
  if (failureMessage.includes(WORKFLOW_GATE_MARKER)) {
    return "workflow_gate";
  }

  // The worker's own `Prompt is too long` reason (Issue #2682) — checked
  // after the same rules as the gate above, for the same reason.
  if (failureMessage.includes(PROMPT_TOO_LONG_MARKER)) {
    return "prompt_too_long";
  }

  // The setup phase's own broken-shared-clone reason (Issue #2884) — checked
  // before the generic patterns below so a worker-authored diagnosis wins
  // over any raw git error text the same message happens to quote.
  if (failureMessage.includes(CLONE_CORRUPT_MARKER)) {
    return "clone_corrupt";
  }

  if (
    failureMessage.includes("zero output") ||
    failureMessage.includes("No output captured")
  ) {
    return "zero_output";
  }

  if (
    failureMessage.includes("not available in the worker environment") ||
    failureMessage.includes("not installed or not in PATH") ||
    failureMessage.includes("command not found")
  ) {
    return "missing_tools";
  }

  if (
    failureMessage.includes("quality.sh") ||
    failureMessage.includes("quality checks") ||
    failureMessage.includes("Quality checks")
  ) {
    return "quality_check";
  }

  // Issue #1475: checked before the push-failure phrases, and before the
  // push itself — the message names the scope and the workflow paths.
  //
  // Issue #1952: GitHub's own refusal counts too. When the pre-push check
  // could not answer, the raw remote text is all the record has, and it
  // otherwise matched the generic "Git push failed" rule below — losing the
  // one diagnosis an operator can act on.
  if (
    failureMessage.includes("lacks the 'workflow' scope") ||
    isWorkflowScopePushRefusal(failureMessage)
  ) {
    return "token_scope";
  }

  // Issue #2220: a repository-level refusal of the MILESTONE branch. Checked
  // before the generic push rule, which is what swallowed it: the refusal
  // text says `GH013` / `Repository rule violations` / `remote rejected` and
  // `Failed to push milestone branch`, none of which the push patterns
  // match, so the category came out `unknown` and the issue was blamed for
  // the repository's ruleset. Narrow on purpose (see
  // `isRepoLevelMilestoneBranchRefusal`): an ordinary feature-branch
  // protection refusal stays `push_failure` and keeps its bounded retry.
  if (isRepoLevelMilestoneBranchRefusal(failureMessage)) {
    return "repo_config";
  }

  if (
    failureMessage.includes("Git push failed") ||
    failureMessage.includes("git push failed")
  ) {
    return "push_failure";
  }

  if (
    failureMessage.includes("screenshot evidence") ||
    failureMessage.includes("Screenshot")
  ) {
    return "evidence_missing";
  }

  if (failureMessage.includes("without making any changes")) {
    return "no_changes";
  }

  // Internal/CLI errors: check for error patterns, stack traces
  if (
    ERROR_COLON_RE.test(failureMessage) ||
    failureMessage.includes("at Object.") ||
    failureMessage.includes("at Module.") ||
    failureMessage.includes("ENOENT") ||
    failureMessage.includes("SIGABRT")
  ) {
    return "internal_error";
  }

  return "unknown";
}

/**
 * True when the message carries the worker watchdog's own evidence line
 * (`Watchdog: hard-timeout` / `Watchdog: no-output` / `Watchdog: call-storm`,
 * written by `formatDetailedFailureMessage` for a run the worker stopped).
 * Such a run was ended by the worker, so any signal named in its raw-exit
 * diagnostics is the watchdog's doing, not an external kill (VibeCoder#174).
 *
 * `call-storm` joins the list with Issue #2230: the guard SIGTERMs the agent
 * exactly as the other two do, so without it a stopped call storm read as an
 * external `killed` — infrastructure — and was retried in process.
 */
export function watchdogFiredIn(failureMessage: string): boolean {
  return /\bWatchdog: (?:hard-timeout|no-output|call-storm)\b/.test(
    failureMessage,
  );
}

/**
 * Marker the execute phase puts in a timeout reason when the run's budget was
 * bound by the cycle deadline rather than `claude_timeout` (VibeCoder#174).
 * A deadline-bound timeout is the cycle ending, not the issue defeating a full
 * budget, so it must not feed the escalating timeout cooldown (Issue #4304)
 * — the next cycle should simply resume the preserved WIP.
 */
export const DEADLINE_BOUND_TIMEOUT_MARKER = "at the cycle deadline";

/**
 * Does this failure reason describe a timeout-class failure for the
 * escalating re-claim cooldown (Issue #4304)? A run that burned its whole
 * configured budget and produced nothing does; a deadline-bound timeout
 * (VibeCoder#174) does not.
 */
export function isTimeoutClassFailureReason(reason: string): boolean {
  // A scheduled release is never timeout-class (Issue #424): the run was
  // stopped by the cycle ending or the hard cap with its WIP preserved, so
  // the next cycle should resume it rather than serve a 2 h cooldown. The
  // diagnostics it carries do mention the timeout budget, hence the check
  // must come before the pattern below.
  if (reason.includes(SCHEDULED_RELEASE_MARKER)) return false;
  if (!/\btim(?:ed[ -]?out|eout)\b/i.test(reason)) return false;
  return !reason.includes(DEADLINE_BOUND_TIMEOUT_MARKER);
}

/** Every valid {@link FailureCategory} value — the source of truth for {@link normaliseFailureCategory}. */
const VALID_FAILURE_CATEGORIES: ReadonlySet<string> = new Set<FailureCategory>([
  "killed",
  "timeout",
  "rate_limit",
  "zero_output",
  "quality_check",
  "push_failure",
  "token_scope",
  "no_changes",
  "evidence_missing",
  "internal_error",
  "missing_tools",
  "interrupted",
  "scheduled_release",
  "workflow_gate",
  "repo_config",
  "prompt_too_long",
  "clone_corrupt",
  "summary_incomplete",
  "unknown",
]);

/**
 * Normalise an arbitrary string into a known {@link FailureCategory}.
 *
 * Callers that receive an un-validated category string (e.g. a CLI argument)
 * must pass it through here before handing it to the now-exhaustive
 * {@link getFailureDiagnosis} / {@link getFailureDiagnosisOneliner}. Any value
 * outside the union maps to `"unknown"`, preserving the previous graceful
 * fallback rather than throwing (Issue #2794).
 */
export function normaliseFailureCategory(value: string): FailureCategory {
  return VALID_FAILURE_CATEGORIES.has(value)
    ? value as FailureCategory
    : "unknown";
}

/**
 * Check if a failure category is an infrastructure/transient issue.
 *
 * Infrastructure failures are caused by environment/tooling problems, NOT by
 * the issue being too hard or unclear. These should be retried more aggressively
 * rather than permanently failing the issue.
 *
 * Issue #387 — Self-healing for transient infrastructure failures.
 */
export function isInfrastructureFailure(category: FailureCategory): boolean {
  switch (category) {
    case "zero_output":
    case "rate_limit":
    case "internal_error":
    case "push_failure":
    case "missing_tools":
    // A host credential without a scope is the environment, not the issue
    // (Issue #1475): release it for a host whose token can push it.
    case "token_scope":
    // A run cut off before finishing is transient — retry, do not blame the
    // issue or escalate it to a human (Issue #108).
    case "interrupted":
    // A kill (SIGKILL, typically the VM's OOM killer under transient memory
    // pressure) is an environment failure, not a property of the issue —
    // one bounded retry is allowed (Issue #4202).
    case "killed":
      return true;
    // A scheduled release is NOT infrastructure (Issue #424). The
    // infrastructure arm exists to trigger the bounded in-process retry
    // (#1550) and the self-healing re-attempt, and a run released because
    // the cycle ended or the hard cap was reached has no runway left to
    // retry into — the next claim resumes the preserved WIP instead.
    case "scheduled_release":
      return false;
    // A repository refusing the milestone branch is not infrastructure
    // either (Issue #2220). The infrastructure arm exists to retry a
    // transient fault; this one is a persisted repository setting, so the
    // bounded retry could only burn five claims on a refusal that will be
    // identical every time. `handleIssueFailure` short-circuits it before
    // the ladder is reached.
    case "repo_config":
      return false;
    // Not infrastructure (Issue #2682): the one uncounted fresh-session retry
    // has already been spent by the time this category is recorded, so a
    // second in-process retry would only resend the same oversized prompt.
    case "prompt_too_long":
      return false;
    // Not infrastructure (Issue #2884): an in-process retry would run
    // against the same damaged clone and fail identically — the setup phase
    // already repaired it once before giving up, so a bounded retry here can
    // only burn claims on a fault no in-process attempt can clear.
    case "clone_corrupt":
      return false;
    // Not infrastructure (Issue #3431): the agent's summary fell short of the
    // completion gates; retrying is governed by the normal retry rules.
    case "summary_incomplete":
      return false;
    default:
      return false;
  }
}

/**
 * Map internal category to user-facing display name.
 *
 * Converts internal category identifiers (e.g. zero_output) to human-readable
 * display names (e.g. no-output) for use in failure comment category tags.
 */
export function getFailureCategoryDisplay(
  category: FailureCategory,
): CategoryDisplay {
  switch (category) {
    case "timeout":
      return "timeout";
    case "rate_limit":
      return "rate-limit";
    case "zero_output":
      return "no-output";
    case "killed":
      return "killed";
    case "quality_check":
      return "quality-failure";
    case "missing_tools":
      return "missing-tools";
    case "token_scope":
      return "token-scope";
    case "workflow_gate":
      return "workflow-gate";
    case "push_failure":
    case "evidence_missing":
    case "internal_error":
    case "interrupted":
      return "infrastructure-error";
    case "no_changes":
      return "task-not-understood";
    case "scheduled_release":
      return "scheduled-release";
    case "repo_config":
      return "repo-config";
    case "prompt_too_long":
      return "prompt-too-long";
    case "clone_corrupt":
      return "clone-corrupt";
    case "summary_incomplete":
      return "summary-incomplete";
    case "unknown":
      return "unknown";
    default:
      return assertNever(category);
  }
}

/**
 * Check if clarity was assessed or skipped (i.e. not "not_assessed").
 *
 * Returns true if clarity was assessed as CLEAR or skipped (meaning the
 * "may need more detail" suggestion is inappropriate).
 */
function clarityWasAssessed(clarityStatus: ClarityStatus): boolean {
  return clarityStatus === "assessed_clear" || clarityStatus === "skipped";
}

/**
 * Parse semicolon-separated key=value diagnostic context string.
 *
 * Issue #533 — Embed diagnostic context in zero-output failure comments.
 */
export function parseDiagnosticContext(contextStr: string): DiagnosticContext {
  const result: DiagnosticContext = {};
  if (!contextStr) return result;

  for (const pair of contextStr.split(";")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 0) continue;
    const key = pair.substring(0, eqIdx);
    const value = pair.substring(eqIdx + 1);
    switch (key) {
      case "health_check":
        result.healthCheck = value;
        break;
      case "clarity":
        result.clarity = value;
        break;
      case "elapsed_seconds":
        result.elapsedSeconds = value;
        break;
      case "no_output_timeout":
        result.noOutputTimeout = value;
        break;
      case "claude_timeout":
        result.claudeTimeout = value;
        break;
      case "retry_count":
        result.retryCount = value;
        break;
      case "max_retries":
        result.maxRetries = value;
        break;
      // Extension history (Issue #4298).
      case "extensions_granted":
        result.extensionsGranted = value;
        break;
      case "extended_seconds":
        result.extendedSeconds = value;
        break;
      case "final_deadline_seconds":
        result.finalDeadlineSeconds = value;
        break;
      case "extension_refused":
        result.extensionRefused = value;
        break;
    }
  }
  return result;
}

/**
 * Format diagnostic context for zero-output failures.
 *
 * Returns human-readable diagnostic lines for inclusion in failure comments.
 *
 * Issue #533 — Embed diagnostic context in zero-output failure comments.
 */
/**
 * Render the re-armable deadline's history for the diagnosis (Issue #4298).
 *
 * Returns `""` when the run carried no extension telemetry, so a run with the
 * feature disabled produces the pre-#4290 wording byte for byte.
 */
function formatExtensionHistory(ctx: DiagnosticContext): string {
  if (ctx.extensionsGranted === undefined) return "";
  const granted = Number(ctx.extensionsGranted);
  const history = Number.isFinite(granted) && granted > 0
    ? `, extended ${granted}× by ${ctx.extendedSeconds ?? "?"}s to a final ` +
      `deadline of ${ctx.finalDeadlineSeconds ?? "?"}s`
    : ", no extension granted";
  return ctx.extensionRefused
    ? `${history}; last extension refused: ${ctx.extensionRefused}`
    : history;
}

/**
 * Decode the extension telemetry a timeout diagnosis should state (Issue
 * #768) from the `key=value` diagnostic context, which is the only form the
 * multi-line diagnosis' callers hold.
 *
 * Every figure must parse. `buildDiagnosticContext` writes them as one set,
 * so a partial or unreadable set is not a run without extensions — and
 * rendering a missing figure as `0s` would put a measured-looking lie in an
 * operator artefact. Such a context yields `undefined`, which states nothing
 * about extensions rather than stating something false.
 *
 * `undefined` therefore covers both "the feature was not active" and "the
 * context did not carry a readable snapshot", and in each case the wording
 * stays the pre-#764 text byte for byte.
 */
function resolveExtensionTelemetry(
  diagnosticContext: string,
): ExtensionTelemetry | undefined {
  if (!diagnosticContext) return undefined;
  const ctx = parseDiagnosticContext(diagnosticContext);
  const seconds = (value: string | undefined): number | undefined => {
    if (value === undefined || value.trim() === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const granted = seconds(ctx.extensionsGranted);
  const extendedSeconds = seconds(ctx.extendedSeconds);
  const baseTimeoutSeconds = seconds(ctx.claudeTimeout);
  const finalDeadlineSeconds = seconds(ctx.finalDeadlineSeconds);
  const elapsedSeconds = seconds(ctx.elapsedSeconds);
  if (
    granted === undefined || extendedSeconds === undefined ||
    baseTimeoutSeconds === undefined || finalDeadlineSeconds === undefined ||
    elapsedSeconds === undefined
  ) {
    return undefined;
  }
  return {
    granted,
    extendedSeconds,
    baseTimeoutSeconds,
    finalDeadlineSeconds,
    elapsedSeconds,
    ...(ctx.extensionRefused ? { refusalReason: ctx.extensionRefused } : {}),
  };
}

export function formatZeroOutputDiagnostics(diagnosticContext: string): string {
  if (!diagnosticContext) return "";

  const ctx = parseDiagnosticContext(diagnosticContext);
  const lines: string[] = [];

  // Format health check and clarity status line
  const parts: string[] = [];
  if (ctx.healthCheck) {
    const healthDisplay = ctx.healthCheck === "passed"
      ? "passed \u2713"
      : ctx.healthCheck;
    parts.push(`Health check: ${healthDisplay}`);
  }
  if (ctx.clarity) {
    let clarityDisplay: string;
    switch (ctx.clarity) {
      case "assessed_clear":
        clarityDisplay = "CLEAR \u2713";
        break;
      case "skipped":
        clarityDisplay = "skipped (simple task)";
        break;
      default:
        clarityDisplay = ctx.clarity;
    }
    parts.push(`Clarity assessment: ${clarityDisplay}`);
  }
  if (parts.length > 0) {
    lines.push(`- ${parts.join(" | ")}`);
  }

  // Format runtime line
  if (ctx.elapsedSeconds) {
    let timeoutInfo = "";
    if (ctx.noOutputTimeout && ctx.claudeTimeout) {
      // Explain the deadline the run actually died on (Issue #4298): quoting
      // the configured `claudeTimeout` alone is a lie once the re-armable
      // deadline (#4290) has moved it.
      timeoutInfo = ` (no-output timeout: ${ctx.noOutputTimeout}s, hard ` +
        `timeout: ${ctx.claudeTimeout}s${formatExtensionHistory(ctx)})`;
    }
    lines.push(
      `- Claude ran for ${ctx.elapsedSeconds}s with zero output before being terminated${timeoutInfo}`,
    );
  }

  // Format retry count line
  if (ctx.retryCount && ctx.maxRetries) {
    lines.push(
      `- This has happened ${ctx.retryCount}/${ctx.maxRetries} times \u2014 likely a transient environment issue`,
    );
  }

  return lines.join("\n");
}

/**
 * Return category-specific diagnosis text.
 *
 * Given a failure category (from detectFailureCategory), returns a
 * human-readable diagnosis explaining why the failure likely occurred.
 *
 * When clarityStatus indicates the issue was already assessed as CLEAR or
 * skipped (simple issue), suggestions about needing "more detail" are omitted
 * because the clarity pipeline already validated the description (Issue #400).
 *
 * For zero_output failures, if diagnosticContext is provided, it is formatted
 * into actionable diagnostic lines instead of generic advice (Issue #533).
 *
 * For timeout failures the extension telemetry the diagnostic context carries
 * adds the line that makes the kill readable (Issue #768). Absent, the
 * wording is the pre-#764 text byte for byte.
 */
export function getFailureDiagnosis(
  category: FailureCategory,
  clarityStatus: ClarityStatus = "not_assessed",
  diagnosticContext: string = "",
): string {
  switch (category) {
    case "timeout": {
      const telemetry = resolveExtensionTelemetry(diagnosticContext);
      const summary = telemetry
        ? `\n- ${formatTimeoutExtensionSummary(telemetry)}`
        : "";
      return `- Claude ran out of time before completing the task
- The task may need to be broken into smaller pieces
- Consider simplifying the issue scope or splitting it into sub-issues${summary}`;
    }

    case "scheduled_release":
      return `- The run was released on schedule — the cycle ended, or the supervisor's run hard cap was reached — while the agent was still progressing
- WIP preserved: the work in progress was committed and pushed to the issue branch — the claim-release comment's **Work in progress** line names that branch — and the next claim resumes from there
- Nothing here reflects on the issue: it does not need re-scoping, simplifying or splitting`;

    case "rate_limit":
      return `- Claude was rate-limited during processing
- This is a transient infrastructure issue, not related to issue complexity
- The issue will be retried automatically on the next scan`;

    case "killed":
      return `- The agent process was killed (SIGKILL) without any worker watchdog firing
- The most common cause is the VM's out-of-memory killer under memory pressure — a SIGKILLed process prints nothing, so no memory evidence appears in the output
- This is an infrastructure failure, not related to the issue content; the worker retries once automatically
- If it recurs, raise the container VM memory (VIBE_CONTAINER_MEMORY) or reduce concurrent load on the host`;

    case "interrupted":
      return `- The run was cut off before it could finish — the agent was still working (commonly a slow first quality-gate pass or an exhausted turn budget), not concluding
- This is a transient infrastructure issue, not related to issue complexity or clarity
- The issue is retried automatically on the next scan, not escalated to a human`;

    case "zero_output": {
      const baseLine =
        "- Claude produced no output, which typically indicates a startup failure or environment issue\n- This is not related to the issue complexity or description quality";
      const diagLines = formatZeroOutputDiagnostics(diagnosticContext);
      if (diagLines) {
        return `${baseLine}\n${diagLines}`;
      }
      return `${baseLine}\n- This is a transient infrastructure issue \u2014 the worker will retry automatically`;
    }

    case "quality_check":
      return `- Changes were made but failed the quality gate (\`./quality.sh\`)
- One or more tests, lint checks, or type checks did not pass
- Review the failure details above for specific quality check output`;

    case "missing_tools":
      return `- The quality gate (\`./quality.sh\`) requires tools that are not installed on the worker machine
- This is an **environment issue** \u2014 Claude cannot install system-level tools
- A developer must either install the missing tools on the worker, or update \`quality.sh\` to gracefully skip checks when tools are unavailable
- Retrying will produce the same result until the environment is fixed`;

    case "push_failure":
      return `- Git push failed due to a permissions, network, or branch protection issue
- This is not related to the issue content or complexity
- Check repository access permissions and network connectivity`;

    case "token_scope":
      return `- The worker's GitHub token lacks the \`workflow\` OAuth scope, and this change creates or updates a file under \`.github/workflows/\`
- GitHub rejects such a push from any OAuth token without that scope, so the run stopped **before** pushing (Issue #1475)
- This is a **host credential issue**, not related to the issue content — no attempt was made to push
- An operator must grant the scope to the worker account (\`gh auth refresh -s workflow\`), re-provision \`gh/hosts.yml\` and restart the worker; a host whose token has the scope can pick the issue up as it is`;

    case "no_changes":
      if (clarityWasAssessed(clarityStatus)) {
        return `- Claude completed but made no changes to the codebase
- The issue was assessed as clear, so this is likely a tooling or comprehension issue rather than a description problem
- Consider breaking the task into smaller pieces or adding specific file paths and acceptance criteria`;
      }
      return `- Claude completed but made no changes to the codebase
- The issue description may need more detail about what changes are expected
- Consider adding specific file paths, expected behaviour, or acceptance criteria`;

    case "workflow_gate":
      return `- A workflow file this run added or changed carries a GitHub Actions finding the base commit did not, so the changed-workflow gate refused the run (Issue #1859)
- The finding is a defect in the change, not a documentation shortfall: it stops the run whether or not a pull request already exists
- Fix the named file \u2014 or, for a scanner finding that genuinely does not apply, add a \`# best-practice-ignore: <finding-id>\` comment beside the offending line
- When the run had already raised its pull request, that PR stays open and carries the outstanding finding \u2014 the work is delivered, the finding is not`;

    case "repo_config":
      return `- The repository refused the milestone branch this run had to base its work on — a ruleset, a branch protection, or a permission the fleet account lacks
- This is a **repository configuration** fault, not a property of this issue: the same refusal meets every sibling issue in the milestone
- No \`failed-once\` or \`failed\` label was applied, and the issue stays claimable — once the repository is fixed, the next scan picks it up with no human action
- The most common cause is a \`milestone/**\` ruleset whose \`required_status_checks\` rule has \`do_not_enforce_on_create: false\`, which refuses the very push that would create the branch`;

    case "prompt_too_long":
      return `- The agent CLI refused the run with \`Prompt is too long\` — the conversation no longer fits the model's context window
- This is a **worker fault**, not a property of the issue: a resumed session that overflows is discarded and retried once on a fresh session without counting against the issue (Issue #2682)
- This failure is counted because the fresh session overflowed too, so the issue's own context (body, comments, prompt) is likely too large for one run
- Consider trimming the issue body or splitting the task into smaller sub-issues`;

    case "clone_corrupt":
      return `- Branch creation failed because the host's shared clone of this repository is damaged — broken refs or a corrupt object store
- This is a **host infrastructure** fault, not a property of this issue: every issue claimed on this host hits the same damaged clone
- No \`failed-once\` or \`failed\` label was applied, but the setup-phase repair ladder's escalation already put \`needs-human\` on this issue — either its repair attempt did not clear the fault, or this run's one repair attempt was already spent by an earlier issue — and it stays parked until a human removes that label
- An operator should check the host's shared clone (e.g. \`git fsck\`) and re-clone or repair it if refs or objects are missing or corrupt, then remove the \`needs-human\` label so the issue is claimable again`;

    case "summary_incomplete":
      return `- The PR summary did not pass the worker's completion gates (Issue #3431)
- The gate's comment on the issue names each gap in the summary
- This is the agent's deliverable falling short, not a worker defect
- The normal retry and \`failed-once\` rules apply`;

    case "evidence_missing":
      return `- The PR was blocked because screenshot evidence is required for UI changes
- This is a process requirement, not related to issue complexity
- Every run is given the headless browser unless the repository sets \`skip_screenshot_check\` (Issue #2925); if the agent reported a browser error, it is quoted in the PR summary or the run log
- A retry happens only while the issue is not labelled \`failed\`; once it is, the issue is retried only after a human removes that label`;

    case "internal_error":
      return `- An internal error occurred in the worker tooling or Claude CLI
- This is not related to the issue complexity or description quality
- This is a transient infrastructure issue \u2014 the worker will retry automatically`;

    case "unknown":
      if (clarityWasAssessed(clarityStatus)) {
        return `- The failure cause could not be automatically determined
- The issue was assessed as clear, so the description is unlikely to be the problem
- Review the failure details above for more context`;
      }
      return `- The failure cause could not be automatically determined
- Review the failure details above for more context
- Consider simplifying the issue or adding more detail to the description`;

    default:
      // Exhaustiveness guard: a new FailureCategory must get its own arm
      // rather than silently mapping to the "unknown" path (Issue #2794).
      // Callers passing un-validated input must normalise via
      // normaliseFailureCategory() first.
      return assertNever(category);
  }
}

/**
 * Return a brief one-line cause summary.
 *
 * Used by mark_issue_as_failed_once() to add a brief indication of the
 * likely cause without the full multi-line diagnosis, and by the claim-release
 * comment (`renderRunOutcomeClause`).
 *
 * A timeout states the extension telemetry the caller holds (Issue #768) —
 * how many grants the deadline made and why the last check was refused — so
 * the release comment explains the kill instead of leaving it to a code
 * archaeology dig. Without telemetry the wording is unchanged.
 *
 * @param extensions - The kill's snapshot, when the caller has one. The
 * release comment does; `markIssueAsFailedOnce` does not, and its comment
 * already carries the same history inside the raw failure message.
 */
export function getFailureDiagnosisOneliner(
  category: FailureCategory,
  clarityStatus: ClarityStatus = "not_assessed",
  extensions?: ExtensionTelemetry,
): string {
  switch (category) {
    case "timeout":
      return extensions
        ? `Likely cause: Claude ran out of time. ${
          formatTimeoutExtensionSummary(extensions)
        }.`
        : "Likely cause: Claude ran out of time.";
    // Deliberately not "Likely cause": nothing was diagnosed. The cycle
    // ended or the hard cap was reached and the work was parked (Issue #424).
    case "scheduled_release":
      return "Scheduled release: the cycle ended or the run hard cap was reached — WIP preserved, resumes next cycle.";
    case "rate_limit":
      return "Likely cause: Claude was rate-limited (transient infrastructure issue).";
    case "zero_output":
      return "Likely cause: Claude produced no output (startup or environment issue).";
    case "killed":
      return "Likely cause: the agent was killed (SIGKILL) — possibly the VM's out-of-memory killer.";
    case "interrupted":
      return "Likely cause: the run was cut off before finishing (slow quality gate or exhausted turn budget) — transient, retried automatically.";
    case "quality_check":
      return "Likely cause: changes failed quality checks.";
    case "missing_tools":
      return "Likely cause: required tools (e.g., npm, node) not installed on worker machine.";
    case "push_failure":
      return "Likely cause: git push failed (permissions or network issue).";
    case "token_scope":
      return "Likely cause: the worker's token lacks the 'workflow' scope and the change touches .github/workflows/ (Issue #1475).";
    case "no_changes":
      if (clarityWasAssessed(clarityStatus)) {
        return "Likely cause: Claude could not determine what changes to make (issue was assessed as clear).";
      }
      return "Likely cause: Claude could not determine what changes to make.";
    case "evidence_missing":
      return "Likely cause: screenshot evidence required but not provided.";
    // Deliberately not "Likely cause": nothing was guessed. The repository
    // refused the branch and said so (Issue #2220).
    case "repo_config":
      return "Repository configuration refused the milestone branch — the same refusal meets every issue in the milestone, so this issue is left unlabelled and claimable.";
    // Deliberately not "Likely cause": nothing was guessed. The worker's own
    // gate refused the run and named the finding (Issue #2044).
    case "workflow_gate":
      return "Blocked by the changed-workflow file checks: a workflow file this run touched carries a finding the base commit did not.";
    case "prompt_too_long":
      return "Likely cause: the agent CLI refused the run as 'Prompt is too long' even on a fresh session (Issue #2682).";
    // Deliberately not "Likely cause": nothing was guessed. The setup phase
    // detected the host's shared clone was damaged and said so (Issue #2884).
    case "clone_corrupt":
      return "Host's shared clone of this repository is damaged (broken refs or corrupt object store) — the same fault meets every issue on this host; no failed-once/failed was applied, but this issue was escalated to needs-human (its repair attempt failed, or this run's one repair attempt was already spent) and stays parked until a human removes that label.";
    // Deliberately not "Likely cause": nothing was guessed. The worker's own
    // completion gates refused the summary and named each gap (Issue #3431).
    case "summary_incomplete":
      return "The PR summary did not pass the worker's completion gates — see the gate comment for each gap.";
    case "internal_error":
      return "Likely cause: internal tooling or CLI error (not related to issue complexity).";
    case "unknown":
      return "Likely cause: could not be automatically determined \u2014 see details above.";
    default:
      // Exhaustiveness guard (Issue #2794): a new FailureCategory must be
      // handled explicitly. Callers passing un-validated input must
      // normalise via normaliseFailureCategory() first.
      return assertNever(category);
  }
}

/**
 * Extract the most relevant error lines from failure output.
 *
 * Scans the input text for lines matching common error patterns and returns
 * up to 10 key lines for prominent display in failure comments.
 *
 * Issue #733 — Surface error details prominently in failure comments.
 */
export function extractKeyErrorLines(text: string): string {
  if (!text) return "";

  const errorPattern =
    /(^|\s)(Error:|error:|fatal:|FAIL\s|FAILED|not ok \d)|\d+ tests? failed|error TS\d+/;

  const lines = text.split("\n");
  const matches: string[] = [];

  for (const line of lines) {
    if (matches.length >= 10) break;
    if (errorPattern.test(line)) {
      matches.push(line);
    }
  }

  return matches.join("\n");
}
