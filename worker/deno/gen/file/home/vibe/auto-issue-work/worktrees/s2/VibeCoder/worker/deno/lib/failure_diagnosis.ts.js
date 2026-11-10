/**
 * Context-aware failure diagnosis for issue failure comments (Issue #398, #909).
 *
 * Replaces generic "Why this might be happening" with category-specific advice
 * based on the actual failure message content.
 *
 * Migrated from worker/shared/failure_diagnosis.sh (Issue #909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { assertNever } from "./assert_never.ts";
import { isWorkflowScopePushRefusal } from "./workflow_scope.ts";
import { isRepoLevelMilestoneBranchRefusal } from "./milestone_branch_rejection.ts";
import { formatTimeoutExtensionSummary } from "./timeout_extension_telemetry.ts";
/**
 * Out-of-credit / billing signals — account state, not a worker or repository
 * fault. `API Error: 402` is the agent CLI's own line when the API refuses a
 * run for payment (Issue #2590); anchored to a line start so prose quoting a
 * 402 does not match.
 */ const OUT_OF_CREDIT_RE = /out of credit|credit balance|insufficient (?:balance|credit|funds|quota)|payment required|billing (?:hard )?limit|quota exceeded|^\s*api error:\s*402\b/im;
/** Whether `message` reports an out-of-credit / billing refusal. */ export function isOutOfCreditMessage(message) {
  return OUT_OF_CREDIT_RE.test(message);
}
/**
 * Phrase that opens a scheduled-release failure reason (Issue #424).
 *
 * The kill path is the only place that knows a release was scheduled, so it
 * writes this marker into the reason and every downstream reader — the
 * category detector, the cooldown classifier, the failure ladder — keys off
 * it rather than re-deriving the answer from an exit status a genuine
 * timeout shares.
 */ export const SCHEDULED_RELEASE_MARKER = "Released on schedule:";
/**
 * Phrase the changed-workflow gate opens its refusal with (Issue #2044).
 *
 * The gate is the worker's own, so the reason it fails a run with is one the
 * worker wrote — and a worker-authored refusal must never be diagnosed
 * `unknown`. The message builder in `changed_workflow_gate.ts` and the
 * category detector below therefore share this one phrase rather than each
 * carrying its own copy, which is what let the wording drift apart from the
 * diagnosis in the first place.
 */ export const WORKFLOW_GATE_MARKER = "did not pass the GitHub Actions file checks";
/**
 * Phrase the worker opens a `Prompt is too long` failure reason with (Issue
 * #2682). Worker-authored, like {@link WORKFLOW_GATE_MARKER}: the detector
 * keys off the worker's own words, never the agent's prose.
 */ export const PROMPT_TOO_LONG_MARKER = "The agent CLI refused the run: Prompt is too long";
/**
 * Phrase the setup phase opens a broken-shared-clone failure reason with
 * (Issue #2884). Worker-authored, like {@link WORKFLOW_GATE_MARKER}: the
 * setup phase (`lib/phases/setup_branch_phase.ts`) puts this in its failure
 * reason when branch creation fails because the host's shared clone has
 * broken refs or a corrupt object store, and the detector keys off the
 * worker's own words rather than sniffing raw git error text.
 */ export const CLONE_CORRUPT_MARKER = "the host's shared clone of this repository is damaged";
/**
 * Phrase the completion phase opens a PR-summary gate refusal with (Issue
 * #3431). Worker-authored, like {@link WORKFLOW_GATE_MARKER}: the gates' own
 * text quotes the agent's summary (a Rust `AppError::X` path once tripped the
 * catch-all `Error:` rule), so the detector keys off this worker phrase. The
 * agent's quoted text cannot forge a worse category because the marker is a
 * prefix the detector matches with `startsWith`, ahead of every other rule —
 * scheduled_release, killed, timeout, rate_limit and interrupted included
 * (unlike the workflow gate, which is matched after them). The failure
 * ladder and the host-fault detector honour the same prefix, so the quoted
 * text decides neither the disposition nor a host-fault note.
 */ export const SUMMARY_RULE_GATE_MARKER = "the PR summary did not pass the worker's completion gates";
/**
 * Phrase the security-fix gate retry opens a run-ending security-fix gate
 * refusal with (Issue #3454): only the twice-blocked report (`reportBlock` with
 * `countsAsBlockedRun` true) is marked; the completion phase's first-block
 * reason is always replaced by the retry, so it is not. Worker-authored prefix
 * put ahead of the gate's refusal text, which quotes agent-authored test declarations (e.g.
 * `Deno.test("rejects a forged token with TypeError: invalid signature after
 * timeout", ...)`) that tripped the catch-all `Error:`, timeout, killed and
 * rate-limit rules. Matched with `startsWith` ahead of every other rule, so a
 * quotation cannot forge or outrank it. The failure ladder and the host-fault
 * detector honour the same prefix.
 */ export const SECURITY_FIX_GATE_MARKER = "the security fix did not pass the worker's security-fix gate";
/**
 * Phrase the completion phase opens a pre-push gate block with (PR #3716
 * review of Issue #3689). Worker-authored prefix put ahead of the gate's own
 * output, which is the changed-file and pre-flight tools' raw stdout/stderr:
 * `cargo fmt --check` and `deno fmt --check` diff hunks, markdownlint
 * `[Context: ...]` excerpts and quoted test names. A source comment such as
 * `// back off when the exchange rate limit is hit` in a hunk was read as a
 * rate limit, so the run was released uncounted and re-claimed every cycle.
 * Matched with `startsWith` ahead of every other rule, so a quotation cannot
 * forge or outrank it. The failure ladder, the run-failure classifier and the
 * host-fault detector honour the same prefix.
 */ export const PRE_PUSH_GATE_MARKER = "the branch did not pass the worker's pre-push gate";
/**
 * Phrase the completion phase opens an unmet-criteria refusal with (Issue
 * #4146). Worker-authored prefix put ahead of the gate's reason, which quotes
 * the issue's criteria and the agent's summary; matched with `startsWith`
 * ahead of every other rule, so a quoted criterion ("retry on a rate limit")
 * cannot forge or outrank it.
 */ export const CRITERIA_UNMET_GATE_MARKER = "the run did not meet every acceptance criterion";
/**
 * Every worker-written gate refusal, keyed by the prefix its failure reason
 * opens with (Issue #3735). A failure reason that quotes text the worker did
 * not write (tool output, agent text, issue or comment text) opens with one of
 * these markers, so the quoted text cannot forge a worse category.
 * `detectFailureCategory` and `detectHostFault` read it with `startsWith` on
 * the message (`workerGateCategoryOf`) before their free-text rules;
 * `classifyRunFailure` and `classifyCodingFailure` first test the category they
 * are given (`isWorkerGateCategory`); the host-fault and milestone-refusal
 * label-release sweeps skip a posted record whose head category is registered
 * (`isWorkerGateFailureRecord`). `shouldRetryInfrastructureFailure` follows
 * through `detectFailureCategory`. A new gate refusal is one entry here.
 *
 * `PRE_PUSH_LOOKUP_FAILED_MARKER` is deliberately NOT registered: it maps to
 * `push_failure` (infrastructure, retried in-run), not an agent outcome.
 */ export const WORKER_GATE_MARKERS = [
  {
    marker: SUMMARY_RULE_GATE_MARKER,
    category: "summary_incomplete"
  },
  {
    marker: SECURITY_FIX_GATE_MARKER,
    category: "security_fix_gate"
  },
  {
    marker: PRE_PUSH_GATE_MARKER,
    category: "pre_push_gate"
  },
  {
    marker: CRITERIA_UNMET_GATE_MARKER,
    category: "criteria_unmet"
  }
];
/** The gate category `message` opens with, or `null` when it opens with none. */ export function workerGateCategoryOf(message) {
  for (const entry of WORKER_GATE_MARKERS){
    if (message.startsWith(entry.marker)) return entry.category;
  }
  return null;
}
/** Whether `category` is one of the registered worker gate categories. */ export function isWorkerGateCategory(category) {
  return WORKER_GATE_MARKERS.some((entry)=>entry.category === category);
}
/**
 * The four categories authorised for the one-off label cleanup (Issue #4132).
 * This historical release scope is distinct from current failure classification:
 * quality checks are included, while unmet acceptance criteria stay labelled.
 */ export const WORKER_GATE_LABEL_CLEANUP_CATEGORIES = [
  "summary_incomplete",
  "quality_check",
  "pre_push_gate",
  "security_fix_gate"
];
/** Whether a posted display category is within Issue #4132's cleanup scope. */ export function isWorkerGateLabelCleanupDisplay(display) {
  return WORKER_GATE_LABEL_CLEANUP_CATEGORIES.some((category)=>getFailureCategoryDisplay(category) === display);
}
/**
 * The worker-written prefix of the completion phase's reason when the pre-push
 * gate could not read the branch state (a failed or timed-out git or remote
 * lookup, PR #3716 review). The branch was not judged, so it is a
 * `push_failure` (infrastructure, retried in-run). Matched with `startsWith`
 * ahead of the timeout rule, because the quoted git text legitimately says
 * `timed out` (`TIMEOUT: git rev-list … timed out after 30s`) or
 * `Connection timed out`, which would otherwise make it a `timeout`.
 */ export const PRE_PUSH_LOOKUP_FAILED_MARKER = "Git push failed: the pre-push gate could not read the branch state";
/**
 * The worker-written head of a posted failure record: the `## …` heading line
 * followed by the `**Category:** \`…\`` line `markIssueAsFailedOnce` writes
 * straight after it. Anchored to the start of the
 * comment, ahead of the quoted agent text, so a quoted category line further
 * down cannot forge it. `[^\n]*` and `\s*` are separated by a literal `\n`,
 * and the captured category is a bounded `[a-z-]+` run, so the pattern stays
 * linear.
 */ const WORKER_GATE_RECORD_HEAD_RE = /^##[^\n]*\n\s*\*\*Category:\*\* `([a-z-]+)`/;
/**
 * Whether a posted failure-record comment body records a worker gate refusal:
 * any {@link WORKER_GATE_MARKERS} category (summary, security-fix or pre-push
 * gate; Issues #3431, #3454, PR #3716; Issue #3735). The record embeds the
 * reason under a heading, so the gate marker is no longer at the start of the
 * body. The sweeps that re-classify posted bodies (`host_fault_release.ts`,
 * `milestone_branch_refusal_release.ts`) use this to leave such a record
 * alone, because the text it quotes is the agent's, the tools' or the
 * branch's own, not host or repository output.
 */ export function isWorkerGateFailureRecord(body) {
  const head = WORKER_GATE_RECORD_HEAD_RE.exec(body.trimStart());
  if (head === null) return false;
  const display = head[1];
  return WORKER_GATE_MARKERS.some((entry)=>getFailureCategoryDisplay(entry.category) === display);
}
/**
 * The worker-written head of a summary or substantive quality failure record.
 * The Category line immediately follows the heading, before quoted agent text;
 * a category line deeper in the reason cannot forge this provenance.
 * The literal newline separates the bounded heading scan from whitespace.
 */ const SUMMARY_OR_QUALITY_RECORD_RE = /^##[^\n]*\n\s*\*\*Category:\*\* `(?:summary-incomplete|quality-failure)`/;
/**
 * Whether a posted failure record declares a summary or quality verdict.
 * Release sweeps preserve that cause rather than reclassifying quoted text
 * as a host fault or a repository refusal (Issues #3431 and #3738).
 */ export function isSummaryOrQualityFailureRecord(body) {
  return SUMMARY_OR_QUALITY_RECORD_RE.test(body.trimStart());
}
/**
 * The catch-all `Error:` rule of {@link detectFailureCategory}. A Rust/C++
 * path such as `AppError::X` is not an `Error:` line, so `Error::` is excluded
 * (Issue #3431). The lookahead is a single-character check, so it stays linear.
 */ const ERROR_COLON_RE = /Error:(?!:)/;
/**
 * The operator-facing reason line for a scheduled release (Issue #424).
 *
 * `preservedNote` is the note preservation itself wrote (Issue #770) — it
 * names the branch the push actually targeted, and the handover file on it
 * when one exists. Folded in here rather than appended by the caller so the
 * reason states where the work is exactly once. Without it the wording is
 * unchanged: a release that preserved nothing must not name a branch no push
 * ever reached.
 */ export function buildScheduledReleaseReason(reason, preservedNote) {
  const cause = reason === "hard-cap" ? "the supervisor's run hard cap was reached" : reason === "finish-deadline" ? "the finish deadline was reached" : "the cycle ended";
  return `${SCHEDULED_RELEASE_MARKER} ${cause} — ` + (preservedNote ?? "WIP preserved, resumes next cycle");
}
/**
 * Analyse a failure message and return a category.
 *
 * Examines the failure message text for known patterns and returns a category
 * string that can be used to select appropriate diagnosis messaging.
 *
 * Order matters: more specific patterns are checked before general ones.
 * The leading worker-written gate markers (every entry of
 * {@link WORKER_GATE_MARKERS}, Issues #3431, #3454 and PR #3716 review), then
 * {@link PRE_PUSH_LOOKUP_FAILED_MARKER}, are `startsWith` rules checked ahead
 * of every other rule.
 */ export function detectFailureCategory(failureMessage) {
  if (!failureMessage) return "unknown";
  // The worker's own gate refusals, read from WORKER_GATE_MARKERS (Issue
  // #3735). Anchored
  // to the START of the message and checked before every other rule, the
  // scheduled-release one included: the refusal quotes the agent's, the tools'
  // or the branch's own text, so a quoted "Released on schedule:", "timeout",
  // "SIGTERM", "rate limit" or `TypeError:` must not outrank it. Safe ahead of
  // the scheduled-release rule because every reason
  // {@link buildScheduledReleaseReason} writes opens with
  // {@link SCHEDULED_RELEASE_MARKER}, so none can open with a gate marker.
  const gateCategory = workerGateCategoryOf(failureMessage);
  if (gateCategory !== null) return gateCategory;
  // The gate could not read the branch state: an infrastructure fault, never
  // a timeout or rate limit the quoted git text happens to mention.
  if (failureMessage.startsWith(PRE_PUSH_LOOKUP_FAILED_MARKER)) {
    return "push_failure";
  }
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
  if (failureMessage.includes("timed out") || failureMessage.includes("timeout")) {
    if (failureMessage.includes("zero output") || failureMessage.includes("No output captured")) {
      return "zero_output";
    }
    return "timeout";
  }
  // Case-insensitive, and the subscription usage window counts too (Issue
  // #4315): "Rate limit …" / "Claude usage limit reached" escaping here
  // landed in `unknown`, which is not infrastructure — the issue was then
  // blamed and labelled failed for an account-level cap.
  const lowered = failureMessage.toLowerCase();
  if (lowered.includes("rate limit") || lowered.includes("rate-limited") || lowered.includes("usage limit") || // Out of credit is an account state too (Issue #2590): counted as
  // internal_error it backed off a healthy repository as a fast failure.
  isOutOfCreditMessage(failureMessage)) {
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
  if (failureMessage.includes("zero output") || failureMessage.includes("No output captured")) {
    return "zero_output";
  }
  if (failureMessage.includes("not available in the worker environment") || failureMessage.includes("not installed or not in PATH") || failureMessage.includes("command not found")) {
    return "missing_tools";
  }
  if (failureMessage.includes("quality.sh") || failureMessage.includes("quality checks") || failureMessage.includes("Quality checks")) {
    return "quality_check";
  }
  // Issue #1475: checked before the push-failure phrases, and before the
  // push itself — the message names the scope and the workflow paths.
  //
  // Issue #1952: GitHub's own refusal counts too. When the pre-push check
  // could not answer, the raw remote text is all the record has, and it
  // otherwise matched the generic "Git push failed" rule below — losing the
  // one diagnosis an operator can act on.
  if (failureMessage.includes("lacks the 'workflow' scope") || isWorkflowScopePushRefusal(failureMessage)) {
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
  if (failureMessage.includes("Git push failed") || failureMessage.includes("git push failed")) {
    return "push_failure";
  }
  if (failureMessage.includes("screenshot evidence") || failureMessage.includes("Screenshot")) {
    return "evidence_missing";
  }
  if (failureMessage.includes("without making any changes")) {
    return "no_changes";
  }
  // Internal/CLI errors: check for error patterns, stack traces
  if (ERROR_COLON_RE.test(failureMessage) || failureMessage.includes("at Object.") || failureMessage.includes("at Module.") || failureMessage.includes("ENOENT") || failureMessage.includes("SIGABRT")) {
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
 */ export function watchdogFiredIn(failureMessage) {
  return /\bWatchdog: (?:hard-timeout|no-output|call-storm)\b/.test(failureMessage);
}
/**
 * Marker the execute phase puts in a timeout reason when the run's budget was
 * bound by the cycle deadline rather than `claude_timeout` (VibeCoder#174).
 * A deadline-bound timeout is the cycle ending, not the issue defeating a full
 * budget, so it must not feed the escalating timeout cooldown (Issue #4304)
 * — the next cycle should simply resume the preserved WIP.
 */ export const DEADLINE_BOUND_TIMEOUT_MARKER = "at the cycle deadline";
/**
 * Does this failure reason describe a timeout-class failure for the
 * escalating re-claim cooldown (Issue #4304)? A run that burned its whole
 * configured budget and produced nothing does; a deadline-bound timeout
 * (VibeCoder#174) does not.
 */ export function isTimeoutClassFailureReason(reason) {
  // A scheduled release is never timeout-class (Issue #424): the run was
  // stopped by the cycle ending or the hard cap with its WIP preserved, so
  // the next cycle should resume it rather than serve a 2 h cooldown. The
  // diagnostics it carries do mention the timeout budget, hence the check
  // must come before the pattern below.
  if (reason.includes(SCHEDULED_RELEASE_MARKER)) return false;
  if (!/\btim(?:ed[ -]?out|eout)\b/i.test(reason)) return false;
  return !reason.includes(DEADLINE_BOUND_TIMEOUT_MARKER);
}
/** Every valid {@link FailureCategory} value — the source of truth for {@link normaliseFailureCategory}. */ const VALID_FAILURE_CATEGORIES = new Set([
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
  "security_fix_gate",
  "pre_push_gate",
  "criteria_unmet",
  "unknown"
]);
/**
 * Normalise an arbitrary string into a known {@link FailureCategory}.
 *
 * Callers that receive an un-validated category string (e.g. a CLI argument)
 * must pass it through here before handing it to the now-exhaustive
 * {@link getFailureDiagnosis} / {@link getFailureDiagnosisOneliner}. Any value
 * outside the union maps to `"unknown"`, preserving the previous graceful
 * fallback rather than throwing (Issue #2794).
 */ export function normaliseFailureCategory(value) {
  return VALID_FAILURE_CATEGORIES.has(value) ? value : "unknown";
}
/**
 * Check if a failure category is an infrastructure/transient issue.
 *
 * Infrastructure failures are caused by environment/tooling problems, NOT by
 * the issue being too hard or unclear. These should be retried more aggressively
 * rather than permanently failing the issue.
 *
 * Issue #387 — Self-healing for transient infrastructure failures.
 */ export function isInfrastructureFailure(category) {
  switch(category){
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
    // Not infrastructure (Issue #3454): the agent did not deliver the
    // security-fix evidence; retrying is governed by the normal retry rules.
    case "security_fix_gate":
      return false;
    // Not infrastructure (PR #3716 review): the branch itself failed the
    // checks; a retry of the same content would be blocked identically.
    case "pre_push_gate":
      return false;
    // Not infrastructure (Issue #4146): the run already spent its in-run
    // rounds on the unmet criteria; the next run resumes the branch.
    case "criteria_unmet":
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
 */ export function getFailureCategoryDisplay(category) {
  switch(category){
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
    case "security_fix_gate":
      return "security-fix-gate";
    case "pre_push_gate":
      return "pre-push-gate";
    case "criteria_unmet":
      return "criteria-unmet";
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
 */ function clarityWasAssessed(clarityStatus) {
  return clarityStatus === "assessed_clear" || clarityStatus === "skipped";
}
/**
 * Parse semicolon-separated key=value diagnostic context string.
 *
 * Issue #533 — Embed diagnostic context in zero-output failure comments.
 */ export function parseDiagnosticContext(contextStr) {
  const result = {};
  if (!contextStr) return result;
  for (const pair of contextStr.split(";")){
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 0) continue;
    const key = pair.substring(0, eqIdx);
    const value = pair.substring(eqIdx + 1);
    switch(key){
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
 */ /**
 * Render the re-armable deadline's history for the diagnosis (Issue #4298).
 *
 * Returns `""` when the run carried no extension telemetry, so a run with the
 * feature disabled produces the pre-#4290 wording byte for byte.
 */ function formatExtensionHistory(ctx) {
  if (ctx.extensionsGranted === undefined) return "";
  const granted = Number(ctx.extensionsGranted);
  const history = Number.isFinite(granted) && granted > 0 ? `, extended ${granted}× by ${ctx.extendedSeconds ?? "?"}s to a final ` + `deadline of ${ctx.finalDeadlineSeconds ?? "?"}s` : ", no extension granted";
  return ctx.extensionRefused ? `${history}; last extension refused: ${ctx.extensionRefused}` : history;
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
 */ function resolveExtensionTelemetry(diagnosticContext) {
  if (!diagnosticContext) return undefined;
  const ctx = parseDiagnosticContext(diagnosticContext);
  const seconds = (value)=>{
    if (value === undefined || value.trim() === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const granted = seconds(ctx.extensionsGranted);
  const extendedSeconds = seconds(ctx.extendedSeconds);
  const baseTimeoutSeconds = seconds(ctx.claudeTimeout);
  const finalDeadlineSeconds = seconds(ctx.finalDeadlineSeconds);
  const elapsedSeconds = seconds(ctx.elapsedSeconds);
  if (granted === undefined || extendedSeconds === undefined || baseTimeoutSeconds === undefined || finalDeadlineSeconds === undefined || elapsedSeconds === undefined) {
    return undefined;
  }
  return {
    granted,
    extendedSeconds,
    baseTimeoutSeconds,
    finalDeadlineSeconds,
    elapsedSeconds,
    ...ctx.extensionRefused ? {
      refusalReason: ctx.extensionRefused
    } : {}
  };
}
export function formatZeroOutputDiagnostics(diagnosticContext) {
  if (!diagnosticContext) return "";
  const ctx = parseDiagnosticContext(diagnosticContext);
  const lines = [];
  // Format health check and clarity status line
  const parts = [];
  if (ctx.healthCheck) {
    const healthDisplay = ctx.healthCheck === "passed" ? "passed \u2713" : ctx.healthCheck;
    parts.push(`Health check: ${healthDisplay}`);
  }
  if (ctx.clarity) {
    let clarityDisplay;
    switch(ctx.clarity){
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
      timeoutInfo = ` (no-output timeout: ${ctx.noOutputTimeout}s, hard ` + `timeout: ${ctx.claudeTimeout}s${formatExtensionHistory(ctx)})`;
    }
    lines.push(`- Claude ran for ${ctx.elapsedSeconds}s with zero output before being terminated${timeoutInfo}`);
  }
  // Format retry count line
  if (ctx.retryCount && ctx.maxRetries) {
    lines.push(`- This has happened ${ctx.retryCount}/${ctx.maxRetries} times \u2014 likely a transient environment issue`);
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
 */ export function getFailureDiagnosis(category, clarityStatus = "not_assessed", diagnosticContext = "") {
  switch(category){
    case "timeout":
      {
        const telemetry = resolveExtensionTelemetry(diagnosticContext);
        const summary = telemetry ? `\n- ${formatTimeoutExtensionSummary(telemetry)}` : "";
        return `- Claude ran out of time before completing the task
- The task may need to be broken into smaller pieces
- Consider simplifying the issue scope or splitting it into sub-issues${summary}`;
      }
    case "scheduled_release":
      return `- The run was released on schedule — the cycle ended, the finish deadline was reached, or the supervisor's run hard cap was reached — while the agent was still progressing
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
    case "zero_output":
      {
        const baseLine = "- Claude produced no output, which typically indicates a startup failure or environment issue\n- This is not related to the issue complexity or description quality";
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
- GitHub rejects such a push from any OAuth token without that scope, so the run stopped **before** pushing
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
      return `- A workflow file this run added or changed carries a GitHub Actions finding the base commit did not, so the changed-workflow gate refused the run
- The finding is a defect in the change, not a documentation shortfall: it stops the run whether or not a pull request already exists
- Fix the named file \u2014 a finding that genuinely does not apply cannot be cleared by the run (the gate honours no in-file suppression marker), so it needs a human to review it, or a fix to the scanner
- When the run had already raised its pull request, that PR stays open and carries the outstanding finding \u2014 the work is delivered, the finding is not`;
    case "repo_config":
      return `- The repository refused the milestone branch this run had to base its work on — a ruleset, a branch protection, or a permission the fleet account lacks
- This is a **repository configuration** fault, not a property of this issue: the same refusal meets every sibling issue in the milestone
- No \`failed-once\` or \`failed\` label was applied, and the issue stays claimable — once the repository is fixed, the next scan picks it up with no human action
- The most common cause is a \`milestone/**\` ruleset whose \`required_status_checks\` rule has \`do_not_enforce_on_create: false\`, which refuses the very push that would create the branch`;
    case "prompt_too_long":
      return `- The agent CLI refused the run with \`Prompt is too long\` — the conversation no longer fits the model's context window
- This is a **worker fault**, not a property of the issue: a resumed session that overflows is discarded and retried once on a fresh session without counting against the issue
- This failure is counted because the fresh session overflowed too, so the issue's own context (body, comments, prompt) is likely too large for one run
- Consider trimming the issue body or splitting the task into smaller sub-issues`;
    case "clone_corrupt":
      return `- Branch creation failed because the host's shared clone of this repository is damaged — broken refs or a corrupt object store
- This is a **host infrastructure** fault, not a property of this issue: every issue claimed on this host hits the same damaged clone
- No \`failed-once\` or \`failed\` label was applied, but the setup-phase repair ladder's escalation already put \`needs-human\` on this issue — either its repair attempt did not clear the fault, or this run's one repair attempt was already spent by an earlier issue — and it stays parked until a human removes that label
- An operator should check the host's shared clone (e.g. \`git fsck\`) and re-clone or repair it if refs or objects are missing or corrupt, then remove the \`needs-human\` label so the issue is claimable again`;
    case "summary_incomplete":
      return `- The PR summary did not pass the worker's completion gates
- The gate's comment on the issue names each gap in the summary
- This is the agent's deliverable falling short, not a worker defect
- The normal retry and \`failed-once\` rules apply`;
    case "security_fix_gate":
      return `- The security fix did not pass the worker's security-fix gate
- The agent did not deliver the vulnerability-fix verification evidence the gate requires
- This is the agent's deliverable falling short, not a worker defect
- The normal retry and \`failed-once\` rules apply`;
    case "pre_push_gate":
      return `- The branch did not pass the worker's pre-push gate
- The gate's comment on the issue quotes the failing check's output, which names each file and finding
- This is the branch's content failing the repository's own checks, not a worker defect
- The normal retry and \`failed-once\` rules apply`;
    case "criteria_unmet":
      return `- The run did not meet every acceptance criterion, even after its in-run rounds
- The gate's comment on the issue names each unmet criterion
- No PR was raised and no follow-up issue was filed: the branch stays pushed, and the next run resumes it to finish the job
- The normal retry and \`failed-once\` rules apply`;
    case "evidence_missing":
      return `- The PR was blocked because screenshot evidence is required for UI changes
- This is a process requirement, not related to issue complexity
- Every run is given the headless browser unless the repository sets \`skip_screenshot_check\`; if the agent reported a browser error, it is quoted in the PR summary or the run log
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
 */ export function getFailureDiagnosisOneliner(category, clarityStatus = "not_assessed", extensions) {
  switch(category){
    case "timeout":
      return extensions ? `Likely cause: Claude ran out of time. ${formatTimeoutExtensionSummary(extensions)}.` : "Likely cause: Claude ran out of time.";
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
      return "Likely cause: the worker's token lacks the 'workflow' scope and the change touches .github/workflows/.";
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
      return "Likely cause: the agent CLI refused the run as 'Prompt is too long' even on a fresh session.";
    // Deliberately not "Likely cause": nothing was guessed. The setup phase
    // detected the host's shared clone was damaged and said so (Issue #2884).
    case "clone_corrupt":
      return "Host's shared clone of this repository is damaged (broken refs or corrupt object store) — the same fault meets every issue on this host; no failed-once/failed was applied, but this issue was escalated to needs-human (its repair attempt failed, or this run's one repair attempt was already spent) and stays parked until a human removes that label.";
    // Deliberately not "Likely cause": nothing was guessed. The worker's own
    // completion gates refused the summary and named each gap (Issue #3431).
    case "summary_incomplete":
      return "The PR summary did not pass the worker's completion gates — see the gate comment for each gap.";
    // Deliberately not "Likely cause": the worker's own security-fix gate
    // refused the run (Issue #3454).
    case "security_fix_gate":
      return "The agent did not deliver the vulnerability-fix verification evidence the worker's security-fix gate requires — not a worker defect.";
    // Deliberately not "Likely cause": the worker's own pre-push gate blocked
    // the branch and quoted the failing check (PR #3716 review).
    case "pre_push_gate":
      return "The branch did not pass the worker's pre-push gate (changed-file checks or the repository's pre-flight commands) — see the quoted check output, not a worker defect.";
    // Deliberately not "Likely cause": the worker's own unmet-criteria gate
    // refused the run and named each criterion (Issue #4146).
    case "criteria_unmet":
      return "The run did not meet every acceptance criterion — no PR was raised; the next run resumes the branch to finish the job.";
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
 */ export function extractKeyErrorLines(text) {
  if (!text) return "";
  const errorPattern = /(^|\s)(Error:|error:|fatal:|FAIL\s|FAILED|not ok \d)|\d+ tests? failed|error TS\d+/;
  const lines = text.split("\n");
  const matches = [];
  for (const line of lines){
    if (matches.length >= 10) break;
    if (errorPattern.test(line)) {
      matches.push(line);
    }
  }
  return matches.join("\n");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9mYWlsdXJlX2RpYWdub3Npcy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENvbnRleHQtYXdhcmUgZmFpbHVyZSBkaWFnbm9zaXMgZm9yIGlzc3VlIGZhaWx1cmUgY29tbWVudHMgKElzc3VlICMzOTgsICM5MDkpLlxuICpcbiAqIFJlcGxhY2VzIGdlbmVyaWMgXCJXaHkgdGhpcyBtaWdodCBiZSBoYXBwZW5pbmdcIiB3aXRoIGNhdGVnb3J5LXNwZWNpZmljIGFkdmljZVxuICogYmFzZWQgb24gdGhlIGFjdHVhbCBmYWlsdXJlIG1lc3NhZ2UgY29udGVudC5cbiAqXG4gKiBNaWdyYXRlZCBmcm9tIHdvcmtlci9zaGFyZWQvZmFpbHVyZV9kaWFnbm9zaXMuc2ggKElzc3VlICM5MDkpLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IGFzc2VydE5ldmVyIH0gZnJvbSBcIi4vYXNzZXJ0X25ldmVyLnRzXCI7XG5pbXBvcnQgeyBpc1dvcmtmbG93U2NvcGVQdXNoUmVmdXNhbCB9IGZyb20gXCIuL3dvcmtmbG93X3Njb3BlLnRzXCI7XG5pbXBvcnQgeyBpc1JlcG9MZXZlbE1pbGVzdG9uZUJyYW5jaFJlZnVzYWwgfSBmcm9tIFwiLi9taWxlc3RvbmVfYnJhbmNoX3JlamVjdGlvbi50c1wiO1xuaW1wb3J0IHtcbiAgdHlwZSBFeHRlbnNpb25UZWxlbWV0cnksXG4gIGZvcm1hdFRpbWVvdXRFeHRlbnNpb25TdW1tYXJ5LFxufSBmcm9tIFwiLi90aW1lb3V0X2V4dGVuc2lvbl90ZWxlbWV0cnkudHNcIjtcblxuLyoqXG4gKiBPdXQtb2YtY3JlZGl0IC8gYmlsbGluZyBzaWduYWxzIOKAlCBhY2NvdW50IHN0YXRlLCBub3QgYSB3b3JrZXIgb3IgcmVwb3NpdG9yeVxuICogZmF1bHQuIGBBUEkgRXJyb3I6IDQwMmAgaXMgdGhlIGFnZW50IENMSSdzIG93biBsaW5lIHdoZW4gdGhlIEFQSSByZWZ1c2VzIGFcbiAqIHJ1biBmb3IgcGF5bWVudCAoSXNzdWUgIzI1OTApOyBhbmNob3JlZCB0byBhIGxpbmUgc3RhcnQgc28gcHJvc2UgcXVvdGluZyBhXG4gKiA0MDIgZG9lcyBub3QgbWF0Y2guXG4gKi9cbmNvbnN0IE9VVF9PRl9DUkVESVRfUkUgPVxuICAvb3V0IG9mIGNyZWRpdHxjcmVkaXQgYmFsYW5jZXxpbnN1ZmZpY2llbnQgKD86YmFsYW5jZXxjcmVkaXR8ZnVuZHN8cXVvdGEpfHBheW1lbnQgcmVxdWlyZWR8YmlsbGluZyAoPzpoYXJkICk/bGltaXR8cXVvdGEgZXhjZWVkZWR8XlxccyphcGkgZXJyb3I6XFxzKjQwMlxcYi9pbTtcblxuLyoqIFdoZXRoZXIgYG1lc3NhZ2VgIHJlcG9ydHMgYW4gb3V0LW9mLWNyZWRpdCAvIGJpbGxpbmcgcmVmdXNhbC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc091dE9mQ3JlZGl0TWVzc2FnZShtZXNzYWdlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIE9VVF9PRl9DUkVESVRfUkUudGVzdChtZXNzYWdlKTtcbn1cblxuLyoqIEZhaWx1cmUgY2F0ZWdvcnkgc3RyaW5nIOKAlCByZXR1cm5lZCBieSBkZXRlY3RGYWlsdXJlQ2F0ZWdvcnkoKS4gKi9cbmV4cG9ydCB0eXBlIEZhaWx1cmVDYXRlZ29yeSA9XG4gIHwgXCJ0aW1lb3V0XCJcbiAgfCBcInJhdGVfbGltaXRcIlxuICB8IFwiemVyb19vdXRwdXRcIlxuICAvKiogU0lHS0lMTGVkIHdpdGhvdXQgYSB3YXRjaGRvZyBmaXJpbmcg4oCUIHBvc3NpYmxlIFZNIE9PTSAoSXNzdWUgIzQyMDIpLiAqL1xuICB8IFwia2lsbGVkXCJcbiAgfCBcInF1YWxpdHlfY2hlY2tcIlxuICB8IFwicHVzaF9mYWlsdXJlXCJcbiAgLyoqXG4gICAqIFRoZSB3b3JrZXIncyB0b2tlbiBsYWNrcyB0aGUgYHdvcmtmbG93YCBPQXV0aCBzY29wZSBhbmQgdGhlIHJ1bidzIGRpZmZcbiAgICogdG91Y2hlcyBgLmdpdGh1Yi93b3JrZmxvd3MvYCwgc28gdGhlIHB1c2ggd291bGQgYmUgcmVqZWN0ZWQgKElzc3VlXG4gICAqICMxNDc1KS4gQSBwcm9wZXJ0eSBvZiB0aGUgaG9zdCdzIGNyZWRlbnRpYWwsIG5vdCBvZiB0aGUgaXNzdWUuXG4gICAqL1xuICB8IFwidG9rZW5fc2NvcGVcIlxuICB8IFwibm9fY2hhbmdlc1wiXG4gIHwgXCJldmlkZW5jZV9taXNzaW5nXCJcbiAgLyoqXG4gICAqIEEgcHJlLVBSIGdhdGUgdGhlIHdvcmtlciBpdHNlbGYgYXBwbGllZCByZWZ1c2VkIHRoZSBydW4gKElzc3VlICMyMDQ0KSDigJRcbiAgICogdG9kYXkgdGhlIGNoYW5nZWQtd29ya2Zsb3cgZmlsZSBjaGVja3MuIFRoZSB3b3JrZXIgd3JvdGUgdGhlIHJlZnVzYWwsIHNvXG4gICAqIGl0cyBjYXVzZSBpcyBrbm93bjogcmVjb3JkaW5nIGl0IGFzIGB1bmtub3duYCBibGFtZWQgYW4gdW5leHBsYWluZWRcbiAgICogZmFpbHVyZSBmb3IgYSBibG9jayB0aGUgd29ya2VyIGhhZCBhbHJlYWR5IGV4cGxhaW5lZC5cbiAgICovXG4gIHwgXCJ3b3JrZmxvd19nYXRlXCJcbiAgfCBcImludGVybmFsX2Vycm9yXCJcbiAgfCBcIm1pc3NpbmdfdG9vbHNcIlxuICAvKipcbiAgICogVGhlIHJ1biB3YXMgY3V0IG9mZiBiZWZvcmUgaXQgY291bGQgZmluaXNoIOKAlCB0aGUgYWdlbnQncyBvd24gb3V0cHV0IHNob3dzXG4gICAqIGl0IHdhcyBzdGlsbCB3b3JraW5nIChibG9ja2VkIG9uIGEgc2xvdyBxdWFsaXR5IGdhdGUsIG91dCBvZiB0dXJuIGJ1ZGdldClcbiAgICogcmF0aGVyIHRoYW4gY29uY2x1ZGluZy4gSW5mcmFzdHJ1Y3R1cmUvdHJhbnNpZW50LCBub3QgYW4gaXNzdWUgcHJvcGVydHk6XG4gICAqIHJldHJpZWQsIG5ldmVyIGVzY2FsYXRlZCB0byBhIGh1bWFuIGFzIGFuYWx5c2lzLW9ubHkgKElzc3VlICMxMDgpLlxuICAgKi9cbiAgfCBcImludGVycnVwdGVkXCJcbiAgLyoqXG4gICAqIFRoZSBydW4gd2FzIHJlbGVhc2VkIG9uIHNjaGVkdWxlIChJc3N1ZSAjNDI0LCBwYXJlbnQgIzM5Nykg4oCUIHRoZSBjeWNsZVxuICAgKiBlbmRlZCwgb3IgdGhlIHN1cGVydmlzb3IncyB3YWxsLWNsb2NrIGhhcmQgY2FwIChJc3N1ZSAjNDIxKSBsZWZ0IG5vXG4gICAqIHJ1bndheSDigJQgd2l0aCB0aGUgYWdlbnQncyB3b3JrIGluIHByb2dyZXNzIGNvbW1pdHRlZCBhbmQgcHVzaGVkIHRvIHRoZVxuICAgKiBpc3N1ZSBicmFuY2guIEEgaGFuZG92ZXIsIG5vdCB0aGUgaXNzdWUgZGVmZWF0aW5nIGEgZnVsbCBidWRnZXQ6IHRoZVxuICAgKiBuZXh0IGNsYWltIHJlc3VtZXMgdGhlIGJyYW5jaC5cbiAgICovXG4gIHwgXCJzY2hlZHVsZWRfcmVsZWFzZVwiXG4gIC8qKlxuICAgKiBUaGUgcmVwb3NpdG9yeSByZWZ1c2VkIHRoZSBtaWxlc3RvbmUgYnJhbmNoIHRoaXMgcnVuIG5lZWRlZCDigJQgYSBydWxlc2V0LFxuICAgKiBhIGJyYW5jaCBwcm90ZWN0aW9uLCBvciBhIHBlcm1pc3Npb24gdGhlIGZsZWV0IGFjY291bnQgbGFja3MgKElzc3VlXG4gICAqICMyMjIwKS4gQSBwcm9wZXJ0eSBvZiB0aGUgUkVQT1NJVE9SWSwgbm90IG9mIHRoZSBpc3N1ZTogdGhlIHNhbWUgcmVmdXNhbFxuICAgKiBtZWV0cyBldmVyeSBzaWJsaW5nIGlzc3VlIGluIHRoZSBtaWxlc3RvbmUsIHNvIGl0IG11c3Qgbm90IGJlIHJlY29yZGVkXG4gICAqIGFnYWluc3QgYW55IG9mIHRoZW0uIENhdGVnb3Jpc2VkIGB1bmtub3duYCB1bnRpbCBub3csIHdoaWNoIHNlbnQgc2l4dGVlblxuICAgKiBHUlEtRlgtdmFsaWRhdGlvbiBzdWItaXNzdWVzIHVwIHRoZSBgZmFpbGVkLW9uY2VgIOKGkiBgZmFpbGVkYCBsYWRkZXIgZm9yXG4gICAqIG9uZSBgZG9fbm90X2VuZm9yY2Vfb25fY3JlYXRlOiBmYWxzZWAgZmxhZy5cbiAgICovXG4gIHwgXCJyZXBvX2NvbmZpZ1wiXG4gIC8qKlxuICAgKiBUaGUgYWdlbnQgQ0xJIHJlZnVzZWQgdGhlIHJ1biB3aXRoIGBQcm9tcHQgaXMgdG9vIGxvbmdgIChJc3N1ZSAjMjY4Mikg4oCUIHRoZVxuICAgKiB0cmFuc2NyaXB0IG5vIGxvbmdlciBmaXRzIHRoZSBtb2RlbCdzIGNvbnRleHQgd2luZG93LiBBIHdvcmtlciBmYXVsdDogdGhlXG4gICAqIGZpcnN0IG9uIGEgcmVzdW1lZCBzZXNzaW9uIGlzIHJldHJpZWQgb24gYSBmcmVzaCBzZXNzaW9uIHVuY291bnRlZCwgc28gYVxuICAgKiBmYWlsdXJlIHJlY29yZGVkIGhlcmUgaXMgb25lIGEgZnJlc2ggc2Vzc2lvbiBjb3VsZCBub3QgY2xlYXIgZWl0aGVyLlxuICAgKi9cbiAgfCBcInByb21wdF90b29fbG9uZ1wiXG4gIC8qKlxuICAgKiBCcmFuY2ggY3JlYXRpb24gZmFpbGVkIGJlY2F1c2UgdGhlIGhvc3QncyBzaGFyZWQgY2xvbmUgb2YgdGhlIHJlcG9zaXRvcnlcbiAgICogaXMgZGFtYWdlZCDigJQgYnJva2VuIHJlZnMgb3IgYSBjb3JydXB0IG9iamVjdCBzdG9yZSAoSXNzdWUgIzI4ODQpLiBBIGZhdWx0XG4gICAqIG9mIHRoZSBIT1NULCBub3Qgb2YgdGhlIGlzc3VlOiBhbiBpbi1wcm9jZXNzIHJldHJ5IGFnYWluc3QgdGhlIHNhbWVcbiAgICogZGFtYWdlZCBjbG9uZSB3b3VsZCBmYWlsIGlkZW50aWNhbGx5LCBzbyBpdCBtdXN0IG5ldmVyIGNvdW50IGFnYWluc3QgdGhlXG4gICAqIGlzc3VlJ3MgcmV0cnkgYnVkZ2V0LlxuICAgKi9cbiAgfCBcImNsb25lX2NvcnJ1cHRcIlxuICAvKipcbiAgICogVGhlIFBSLXN1bW1hcnkgZ2F0ZXMgcmVmdXNlZCB0aGUgcnVuIChJc3N1ZSAjMzQzMSkuIFRoZSBhZ2VudCdzIGRlbGl2ZXJhYmxlXG4gICAqIGZlbGwgc2hvcnQ7IHRoZSB3b3JrZXIgZGlkIG5vdCBtYWxmdW5jdGlvbi5cbiAgICovXG4gIHwgXCJzdW1tYXJ5X2luY29tcGxldGVcIlxuICAvKipcbiAgICogVGhlIHNlY3VyaXR5LWZpeCBnYXRlIHJlZnVzZWQgdGhlIHJ1biAoSXNzdWUgIzM0NTQpLiBUaGUgYWdlbnQgZGlkIG5vdFxuICAgKiBkZWxpdmVyIHRoZSB2dWxuZXJhYmlsaXR5LWZpeCB2ZXJpZmljYXRpb24gZXZpZGVuY2UgdGhlIGdhdGUgcmVxdWlyZXM7XG4gICAqIHRoZSB3b3JrZXIgZGlkIG5vdCBtYWxmdW5jdGlvbi5cbiAgICovXG4gIHwgXCJzZWN1cml0eV9maXhfZ2F0ZVwiXG4gIC8qKlxuICAgKiBUaGUgY29tcGxldGlvbiBwaGFzZSdzIHByZS1wdXNoIGdhdGUgYmxvY2tlZCB0aGUgYnJhbmNoIChQUiAjMzcxNiByZXZpZXcpLlxuICAgKiBUaGUgY2hhbmdlZC1maWxlIGNoZWNrcyBhbmQgdGhlIHJlcG9zaXRvcnkncyBwcmUtZmxpZ2h0IGNvbW1hbmRzIHJlZnVzZWRcbiAgICogaXQ7IHRoZSB3b3JrZXIgZGlkIG5vdCBtYWxmdW5jdGlvbi5cbiAgICovXG4gIHwgXCJwcmVfcHVzaF9nYXRlXCJcbiAgLyoqXG4gICAqIFRoZSBydW4gZGlkIG5vdCBtZWV0IGV2ZXJ5IGFjY2VwdGFuY2UgY3JpdGVyaW9uLCBldmVuIGFmdGVyIGl0cyBpbi1ydW5cbiAgICogcm91bmRzIChJc3N1ZSAjNDE0NikuIE5vIFBSIHdhcyByYWlzZWQgYW5kIG5vIGZvbGxvdy11cCBmaWxlZDogdGhlIGJyYW5jaFxuICAgKiBzdGF5cyBwdXNoZWQgYW5kIHRoZSBuZXh0IHJ1biByZXN1bWVzIGl0LiBUaGUgYWdlbnQncyBkZWxpdmVyYWJsZSBmZWxsXG4gICAqIHNob3J0OyB0aGUgd29ya2VyIGRpZCBub3QgbWFsZnVuY3Rpb24uXG4gICAqL1xuICB8IFwiY3JpdGVyaWFfdW5tZXRcIlxuICB8IFwidW5rbm93blwiO1xuXG4vKiogQ2xhcml0eSBzdGF0dXMg4oCUIHdoZXRoZXIgdGhlIGlzc3VlIHdhcyBhc3Nlc3NlZCBmb3IgY2xhcml0eSBiZWZvcmUgZmFpbHVyZS4gKi9cbmV4cG9ydCB0eXBlIENsYXJpdHlTdGF0dXMgPSBcImFzc2Vzc2VkX2NsZWFyXCIgfCBcInNraXBwZWRcIiB8IFwibm90X2Fzc2Vzc2VkXCI7XG5cbi8qKiBVc2VyLWZhY2luZyBkaXNwbGF5IG5hbWUgZm9yIGEgZmFpbHVyZSBjYXRlZ29yeSAoa2ViYWItY2FzZSkuICovXG5leHBvcnQgdHlwZSBDYXRlZ29yeURpc3BsYXkgPVxuICB8IFwidGltZW91dFwiXG4gIHwgXCJyYXRlLWxpbWl0XCJcbiAgfCBcIm5vLW91dHB1dFwiXG4gIHwgXCJraWxsZWRcIlxuICB8IFwicXVhbGl0eS1mYWlsdXJlXCJcbiAgfCBcIm1pc3NpbmctdG9vbHNcIlxuICAvKiogSXNzdWUgIzE0NzU6IHRoZSBob3N0J3MgdG9rZW4gbGFja3MgdGhlIGB3b3JrZmxvd2Agc2NvcGUuICovXG4gIHwgXCJ0b2tlbi1zY29wZVwiXG4gIC8qKiBJc3N1ZSAjMjA0NDogYSBwcmUtUFIgZ2F0ZSB0aGUgd29ya2VyIGFwcGxpZWQgcmVmdXNlZCB0aGUgcnVuLiAqL1xuICB8IFwid29ya2Zsb3ctZ2F0ZVwiXG4gIHwgXCJpbmZyYXN0cnVjdHVyZS1lcnJvclwiXG4gIHwgXCJ0YXNrLW5vdC11bmRlcnN0b29kXCJcbiAgfCBcInNjaGVkdWxlZC1yZWxlYXNlXCJcbiAgLyoqIElzc3VlICMyMjIwOiB0aGUgcmVwb3NpdG9yeSByZWZ1c2VkIHRoZSBtaWxlc3RvbmUgYnJhbmNoLiAqL1xuICB8IFwicmVwby1jb25maWdcIlxuICAvKiogSXNzdWUgIzI2ODI6IHRoZSBhZ2VudCBDTEkgcmVmdXNlZCB0aGUgcnVuIGFzIGBQcm9tcHQgaXMgdG9vIGxvbmdgLiAqL1xuICB8IFwicHJvbXB0LXRvby1sb25nXCJcbiAgLyoqIElzc3VlICMyODg0OiB0aGUgaG9zdCdzIHNoYXJlZCBjbG9uZSBpcyBkYW1hZ2VkIChicm9rZW4gcmVmcyAvIGNvcnJ1cHQgb2JqZWN0IHN0b3JlKS4gKi9cbiAgfCBcImNsb25lLWNvcnJ1cHRcIlxuICAvKiogSXNzdWUgIzM0MzE6IHRoZSBQUi1zdW1tYXJ5IGdhdGVzIHJlZnVzZWQgdGhlIHJ1bi4gKi9cbiAgfCBcInN1bW1hcnktaW5jb21wbGV0ZVwiXG4gIC8qKiBJc3N1ZSAjMzQ1NDogdGhlIHNlY3VyaXR5LWZpeCBnYXRlIHJlZnVzZWQgdGhlIHJ1bi4gKi9cbiAgfCBcInNlY3VyaXR5LWZpeC1nYXRlXCJcbiAgLyoqIFBSICMzNzE2IHJldmlldzogdGhlIGNvbXBsZXRpb24gcGhhc2UncyBwcmUtcHVzaCBnYXRlIGJsb2NrZWQgdGhlIGJyYW5jaC4gKi9cbiAgfCBcInByZS1wdXNoLWdhdGVcIlxuICAvKiogSXNzdWUgIzQxNDY6IHRoZSBydW4gZGlkIG5vdCBtZWV0IGV2ZXJ5IGFjY2VwdGFuY2UgY3JpdGVyaW9uLiAqL1xuICB8IFwiY3JpdGVyaWEtdW5tZXRcIlxuICB8IFwidW5rbm93blwiO1xuXG4vKiogUGFyc2VkIGRpYWdub3N0aWMgY29udGV4dCBmb3IgemVyby1vdXRwdXQgZmFpbHVyZXMgKElzc3VlICM1MzMpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBEaWFnbm9zdGljQ29udGV4dCB7XG4gIGhlYWx0aENoZWNrPzogc3RyaW5nO1xuICBjbGFyaXR5Pzogc3RyaW5nO1xuICBlbGFwc2VkU2Vjb25kcz86IHN0cmluZztcbiAgbm9PdXRwdXRUaW1lb3V0Pzogc3RyaW5nO1xuICBjbGF1ZGVUaW1lb3V0Pzogc3RyaW5nO1xuICByZXRyeUNvdW50Pzogc3RyaW5nO1xuICBtYXhSZXRyaWVzPzogc3RyaW5nO1xuICAvKipcbiAgICogRXh0ZW5zaW9uIGhpc3RvcnkgZnJvbSB0aGUgcmUtYXJtYWJsZSBoYXJkIGRlYWRsaW5lIChJc3N1ZSAjNDI5OCkuIFByZXNlbnRcbiAgICogb25seSB3aGVuIHRoZSBmZWF0dXJlIHdhcyBhY3RpdmUgZm9yIHRoZSBydW47IHdpdGhvdXQgaXQgdGhlIGRpYWdub3Npc1xuICAgKiByZWFkcyBleGFjdGx5IGFzIGl0IGRpZCBiZWZvcmUgIzQyOTAuXG4gICAqL1xuICBleHRlbnNpb25zR3JhbnRlZD86IHN0cmluZztcbiAgZXh0ZW5kZWRTZWNvbmRzPzogc3RyaW5nO1xuICBmaW5hbERlYWRsaW5lU2Vjb25kcz86IHN0cmluZztcbiAgZXh0ZW5zaW9uUmVmdXNlZD86IHN0cmluZztcbn1cblxuLyoqXG4gKiBXaHkgYSBydW4gc3RvcHBlZCBvbiBzY2hlZHVsZSByYXRoZXIgdGhhbiBmYWlsaW5nIChJc3N1ZSAjNDI0LCBwYXJlbnQgIzM5NykuXG4gKlxuICogLSBgXCJjeWNsZS1lbmRlZFwiYCDigJQgdGhlIHdvcmtlcidzIG93biBzaHV0ZG93biBlbmRlZCB0aGUgYWdlbnQgcnVuLlxuICogLSBgXCJoYXJkLWNhcFwiYCDigJQgdGhlIHN1cGVydmlzb3IncyB3YWxsLWNsb2NrIGNhcCBsZWZ0IG5vIHJ1bndheSwgc28gdGhlXG4gKiAgIHdvcmtlciBzdG9wcGVkIGl0c2VsZiBmaXJzdCB0byBwcmVzZXJ2ZSB0aGUgd29yayAoSXNzdWUgIzQyMSkuXG4gKiAtIGBcImZpbmlzaC1kZWFkbGluZVwiYCDigJQgdGhlIHR3by1ob3VyIGZpbmlzaCBkZWFkbGluZSB3YXMgcmVhY2hlZCAoSXNzdWVcbiAqICAgIzQyNDUpLiBUaGUgYXR0ZW1wdCBpcyBub3QgYSBmYWlsdXJlOiBubyBgZmFpbGVkLW9uY2VgLCBubyB0aW1lb3V0XG4gKiAgIGNvb2xkb3duLCBubyB3b3JrZXItZmF1bHQgZmlsaW5nLlxuICovXG5leHBvcnQgdHlwZSBTY2hlZHVsZWRSZWxlYXNlUmVhc29uID1cbiAgfCBcImN5Y2xlLWVuZGVkXCJcbiAgfCBcImhhcmQtY2FwXCJcbiAgfCBcImZpbmlzaC1kZWFkbGluZVwiO1xuXG4vKipcbiAqIFBocmFzZSB0aGF0IG9wZW5zIGEgc2NoZWR1bGVkLXJlbGVhc2UgZmFpbHVyZSByZWFzb24gKElzc3VlICM0MjQpLlxuICpcbiAqIFRoZSBraWxsIHBhdGggaXMgdGhlIG9ubHkgcGxhY2UgdGhhdCBrbm93cyBhIHJlbGVhc2Ugd2FzIHNjaGVkdWxlZCwgc28gaXRcbiAqIHdyaXRlcyB0aGlzIG1hcmtlciBpbnRvIHRoZSByZWFzb24gYW5kIGV2ZXJ5IGRvd25zdHJlYW0gcmVhZGVyIOKAlCB0aGVcbiAqIGNhdGVnb3J5IGRldGVjdG9yLCB0aGUgY29vbGRvd24gY2xhc3NpZmllciwgdGhlIGZhaWx1cmUgbGFkZGVyIOKAlCBrZXlzIG9mZlxuICogaXQgcmF0aGVyIHRoYW4gcmUtZGVyaXZpbmcgdGhlIGFuc3dlciBmcm9tIGFuIGV4aXQgc3RhdHVzIGEgZ2VudWluZVxuICogdGltZW91dCBzaGFyZXMuXG4gKi9cbmV4cG9ydCBjb25zdCBTQ0hFRFVMRURfUkVMRUFTRV9NQVJLRVIgPSBcIlJlbGVhc2VkIG9uIHNjaGVkdWxlOlwiO1xuXG4vKipcbiAqIFBocmFzZSB0aGUgY2hhbmdlZC13b3JrZmxvdyBnYXRlIG9wZW5zIGl0cyByZWZ1c2FsIHdpdGggKElzc3VlICMyMDQ0KS5cbiAqXG4gKiBUaGUgZ2F0ZSBpcyB0aGUgd29ya2VyJ3Mgb3duLCBzbyB0aGUgcmVhc29uIGl0IGZhaWxzIGEgcnVuIHdpdGggaXMgb25lIHRoZVxuICogd29ya2VyIHdyb3RlIOKAlCBhbmQgYSB3b3JrZXItYXV0aG9yZWQgcmVmdXNhbCBtdXN0IG5ldmVyIGJlIGRpYWdub3NlZFxuICogYHVua25vd25gLiBUaGUgbWVzc2FnZSBidWlsZGVyIGluIGBjaGFuZ2VkX3dvcmtmbG93X2dhdGUudHNgIGFuZCB0aGVcbiAqIGNhdGVnb3J5IGRldGVjdG9yIGJlbG93IHRoZXJlZm9yZSBzaGFyZSB0aGlzIG9uZSBwaHJhc2UgcmF0aGVyIHRoYW4gZWFjaFxuICogY2FycnlpbmcgaXRzIG93biBjb3B5LCB3aGljaCBpcyB3aGF0IGxldCB0aGUgd29yZGluZyBkcmlmdCBhcGFydCBmcm9tIHRoZVxuICogZGlhZ25vc2lzIGluIHRoZSBmaXJzdCBwbGFjZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFdPUktGTE9XX0dBVEVfTUFSS0VSID1cbiAgXCJkaWQgbm90IHBhc3MgdGhlIEdpdEh1YiBBY3Rpb25zIGZpbGUgY2hlY2tzXCI7XG5cbi8qKlxuICogUGhyYXNlIHRoZSB3b3JrZXIgb3BlbnMgYSBgUHJvbXB0IGlzIHRvbyBsb25nYCBmYWlsdXJlIHJlYXNvbiB3aXRoIChJc3N1ZVxuICogIzI2ODIpLiBXb3JrZXItYXV0aG9yZWQsIGxpa2Uge0BsaW5rIFdPUktGTE9XX0dBVEVfTUFSS0VSfTogdGhlIGRldGVjdG9yXG4gKiBrZXlzIG9mZiB0aGUgd29ya2VyJ3Mgb3duIHdvcmRzLCBuZXZlciB0aGUgYWdlbnQncyBwcm9zZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFBST01QVF9UT09fTE9OR19NQVJLRVIgPVxuICBcIlRoZSBhZ2VudCBDTEkgcmVmdXNlZCB0aGUgcnVuOiBQcm9tcHQgaXMgdG9vIGxvbmdcIjtcblxuLyoqXG4gKiBQaHJhc2UgdGhlIHNldHVwIHBoYXNlIG9wZW5zIGEgYnJva2VuLXNoYXJlZC1jbG9uZSBmYWlsdXJlIHJlYXNvbiB3aXRoXG4gKiAoSXNzdWUgIzI4ODQpLiBXb3JrZXItYXV0aG9yZWQsIGxpa2Uge0BsaW5rIFdPUktGTE9XX0dBVEVfTUFSS0VSfTogdGhlXG4gKiBzZXR1cCBwaGFzZSAoYGxpYi9waGFzZXMvc2V0dXBfYnJhbmNoX3BoYXNlLnRzYCkgcHV0cyB0aGlzIGluIGl0cyBmYWlsdXJlXG4gKiByZWFzb24gd2hlbiBicmFuY2ggY3JlYXRpb24gZmFpbHMgYmVjYXVzZSB0aGUgaG9zdCdzIHNoYXJlZCBjbG9uZSBoYXNcbiAqIGJyb2tlbiByZWZzIG9yIGEgY29ycnVwdCBvYmplY3Qgc3RvcmUsIGFuZCB0aGUgZGV0ZWN0b3Iga2V5cyBvZmYgdGhlXG4gKiB3b3JrZXIncyBvd24gd29yZHMgcmF0aGVyIHRoYW4gc25pZmZpbmcgcmF3IGdpdCBlcnJvciB0ZXh0LlxuICovXG5leHBvcnQgY29uc3QgQ0xPTkVfQ09SUlVQVF9NQVJLRVIgPVxuICBcInRoZSBob3N0J3Mgc2hhcmVkIGNsb25lIG9mIHRoaXMgcmVwb3NpdG9yeSBpcyBkYW1hZ2VkXCI7XG5cbi8qKlxuICogUGhyYXNlIHRoZSBjb21wbGV0aW9uIHBoYXNlIG9wZW5zIGEgUFItc3VtbWFyeSBnYXRlIHJlZnVzYWwgd2l0aCAoSXNzdWVcbiAqICMzNDMxKS4gV29ya2VyLWF1dGhvcmVkLCBsaWtlIHtAbGluayBXT1JLRkxPV19HQVRFX01BUktFUn06IHRoZSBnYXRlcycgb3duXG4gKiB0ZXh0IHF1b3RlcyB0aGUgYWdlbnQncyBzdW1tYXJ5IChhIFJ1c3QgYEFwcEVycm9yOjpYYCBwYXRoIG9uY2UgdHJpcHBlZCB0aGVcbiAqIGNhdGNoLWFsbCBgRXJyb3I6YCBydWxlKSwgc28gdGhlIGRldGVjdG9yIGtleXMgb2ZmIHRoaXMgd29ya2VyIHBocmFzZS4gVGhlXG4gKiBhZ2VudCdzIHF1b3RlZCB0ZXh0IGNhbm5vdCBmb3JnZSBhIHdvcnNlIGNhdGVnb3J5IGJlY2F1c2UgdGhlIG1hcmtlciBpcyBhXG4gKiBwcmVmaXggdGhlIGRldGVjdG9yIG1hdGNoZXMgd2l0aCBgc3RhcnRzV2l0aGAsIGFoZWFkIG9mIGV2ZXJ5IG90aGVyIHJ1bGUg4oCUXG4gKiBzY2hlZHVsZWRfcmVsZWFzZSwga2lsbGVkLCB0aW1lb3V0LCByYXRlX2xpbWl0IGFuZCBpbnRlcnJ1cHRlZCBpbmNsdWRlZFxuICogKHVubGlrZSB0aGUgd29ya2Zsb3cgZ2F0ZSwgd2hpY2ggaXMgbWF0Y2hlZCBhZnRlciB0aGVtKS4gVGhlIGZhaWx1cmVcbiAqIGxhZGRlciBhbmQgdGhlIGhvc3QtZmF1bHQgZGV0ZWN0b3IgaG9ub3VyIHRoZSBzYW1lIHByZWZpeCwgc28gdGhlIHF1b3RlZFxuICogdGV4dCBkZWNpZGVzIG5laXRoZXIgdGhlIGRpc3Bvc2l0aW9uIG5vciBhIGhvc3QtZmF1bHQgbm90ZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNVTU1BUllfUlVMRV9HQVRFX01BUktFUiA9XG4gIFwidGhlIFBSIHN1bW1hcnkgZGlkIG5vdCBwYXNzIHRoZSB3b3JrZXIncyBjb21wbGV0aW9uIGdhdGVzXCI7XG5cbi8qKlxuICogUGhyYXNlIHRoZSBzZWN1cml0eS1maXggZ2F0ZSByZXRyeSBvcGVucyBhIHJ1bi1lbmRpbmcgc2VjdXJpdHktZml4IGdhdGVcbiAqIHJlZnVzYWwgd2l0aCAoSXNzdWUgIzM0NTQpOiBvbmx5IHRoZSB0d2ljZS1ibG9ja2VkIHJlcG9ydCAoYHJlcG9ydEJsb2NrYCB3aXRoXG4gKiBgY291bnRzQXNCbG9ja2VkUnVuYCB0cnVlKSBpcyBtYXJrZWQ7IHRoZSBjb21wbGV0aW9uIHBoYXNlJ3MgZmlyc3QtYmxvY2tcbiAqIHJlYXNvbiBpcyBhbHdheXMgcmVwbGFjZWQgYnkgdGhlIHJldHJ5LCBzbyBpdCBpcyBub3QuIFdvcmtlci1hdXRob3JlZCBwcmVmaXhcbiAqIHB1dCBhaGVhZCBvZiB0aGUgZ2F0ZSdzIHJlZnVzYWwgdGV4dCwgd2hpY2ggcXVvdGVzIGFnZW50LWF1dGhvcmVkIHRlc3QgZGVjbGFyYXRpb25zIChlLmcuXG4gKiBgRGVuby50ZXN0KFwicmVqZWN0cyBhIGZvcmdlZCB0b2tlbiB3aXRoIFR5cGVFcnJvcjogaW52YWxpZCBzaWduYXR1cmUgYWZ0ZXJcbiAqIHRpbWVvdXRcIiwgLi4uKWApIHRoYXQgdHJpcHBlZCB0aGUgY2F0Y2gtYWxsIGBFcnJvcjpgLCB0aW1lb3V0LCBraWxsZWQgYW5kXG4gKiByYXRlLWxpbWl0IHJ1bGVzLiBNYXRjaGVkIHdpdGggYHN0YXJ0c1dpdGhgIGFoZWFkIG9mIGV2ZXJ5IG90aGVyIHJ1bGUsIHNvIGFcbiAqIHF1b3RhdGlvbiBjYW5ub3QgZm9yZ2Ugb3Igb3V0cmFuayBpdC4gVGhlIGZhaWx1cmUgbGFkZGVyIGFuZCB0aGUgaG9zdC1mYXVsdFxuICogZGV0ZWN0b3IgaG9ub3VyIHRoZSBzYW1lIHByZWZpeC5cbiAqL1xuZXhwb3J0IGNvbnN0IFNFQ1VSSVRZX0ZJWF9HQVRFX01BUktFUiA9XG4gIFwidGhlIHNlY3VyaXR5IGZpeCBkaWQgbm90IHBhc3MgdGhlIHdvcmtlcidzIHNlY3VyaXR5LWZpeCBnYXRlXCI7XG5cbi8qKlxuICogUGhyYXNlIHRoZSBjb21wbGV0aW9uIHBoYXNlIG9wZW5zIGEgcHJlLXB1c2ggZ2F0ZSBibG9jayB3aXRoIChQUiAjMzcxNlxuICogcmV2aWV3IG9mIElzc3VlICMzNjg5KS4gV29ya2VyLWF1dGhvcmVkIHByZWZpeCBwdXQgYWhlYWQgb2YgdGhlIGdhdGUncyBvd25cbiAqIG91dHB1dCwgd2hpY2ggaXMgdGhlIGNoYW5nZWQtZmlsZSBhbmQgcHJlLWZsaWdodCB0b29scycgcmF3IHN0ZG91dC9zdGRlcnI6XG4gKiBgY2FyZ28gZm10IC0tY2hlY2tgIGFuZCBgZGVubyBmbXQgLS1jaGVja2AgZGlmZiBodW5rcywgbWFya2Rvd25saW50XG4gKiBgW0NvbnRleHQ6IC4uLl1gIGV4Y2VycHRzIGFuZCBxdW90ZWQgdGVzdCBuYW1lcy4gQSBzb3VyY2UgY29tbWVudCBzdWNoIGFzXG4gKiBgLy8gYmFjayBvZmYgd2hlbiB0aGUgZXhjaGFuZ2UgcmF0ZSBsaW1pdCBpcyBoaXRgIGluIGEgaHVuayB3YXMgcmVhZCBhcyBhXG4gKiByYXRlIGxpbWl0LCBzbyB0aGUgcnVuIHdhcyByZWxlYXNlZCB1bmNvdW50ZWQgYW5kIHJlLWNsYWltZWQgZXZlcnkgY3ljbGUuXG4gKiBNYXRjaGVkIHdpdGggYHN0YXJ0c1dpdGhgIGFoZWFkIG9mIGV2ZXJ5IG90aGVyIHJ1bGUsIHNvIGEgcXVvdGF0aW9uIGNhbm5vdFxuICogZm9yZ2Ugb3Igb3V0cmFuayBpdC4gVGhlIGZhaWx1cmUgbGFkZGVyLCB0aGUgcnVuLWZhaWx1cmUgY2xhc3NpZmllciBhbmQgdGhlXG4gKiBob3N0LWZhdWx0IGRldGVjdG9yIGhvbm91ciB0aGUgc2FtZSBwcmVmaXguXG4gKi9cbmV4cG9ydCBjb25zdCBQUkVfUFVTSF9HQVRFX01BUktFUiA9XG4gIFwidGhlIGJyYW5jaCBkaWQgbm90IHBhc3MgdGhlIHdvcmtlcidzIHByZS1wdXNoIGdhdGVcIjtcblxuLyoqXG4gKiBQaHJhc2UgdGhlIGNvbXBsZXRpb24gcGhhc2Ugb3BlbnMgYW4gdW5tZXQtY3JpdGVyaWEgcmVmdXNhbCB3aXRoIChJc3N1ZVxuICogIzQxNDYpLiBXb3JrZXItYXV0aG9yZWQgcHJlZml4IHB1dCBhaGVhZCBvZiB0aGUgZ2F0ZSdzIHJlYXNvbiwgd2hpY2ggcXVvdGVzXG4gKiB0aGUgaXNzdWUncyBjcml0ZXJpYSBhbmQgdGhlIGFnZW50J3Mgc3VtbWFyeTsgbWF0Y2hlZCB3aXRoIGBzdGFydHNXaXRoYFxuICogYWhlYWQgb2YgZXZlcnkgb3RoZXIgcnVsZSwgc28gYSBxdW90ZWQgY3JpdGVyaW9uIChcInJldHJ5IG9uIGEgcmF0ZSBsaW1pdFwiKVxuICogY2Fubm90IGZvcmdlIG9yIG91dHJhbmsgaXQuXG4gKi9cbmV4cG9ydCBjb25zdCBDUklURVJJQV9VTk1FVF9HQVRFX01BUktFUiA9XG4gIFwidGhlIHJ1biBkaWQgbm90IG1lZXQgZXZlcnkgYWNjZXB0YW5jZSBjcml0ZXJpb25cIjtcblxuLyoqIFRoZSBmYWlsdXJlIGNhdGVnb3JpZXMgYSByZWdpc3RlcmVkIHdvcmtlciBnYXRlIG1hcmtlciBjYXJyaWVzLiAqL1xuZXhwb3J0IHR5cGUgV29ya2VyR2F0ZUNhdGVnb3J5ID1cbiAgfCBcInN1bW1hcnlfaW5jb21wbGV0ZVwiXG4gIHwgXCJzZWN1cml0eV9maXhfZ2F0ZVwiXG4gIHwgXCJwcmVfcHVzaF9nYXRlXCJcbiAgfCBcImNyaXRlcmlhX3VubWV0XCI7XG5cbi8qKiBBIHdvcmtlci13cml0dGVuIGdhdGUgbWFya2VyIGFuZCB0aGUgZmFpbHVyZSBjYXRlZ29yeSBpdHMgcmVmdXNhbCBjYXJyaWVzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3JrZXJHYXRlTWFya2VyIHtcbiAgcmVhZG9ubHkgbWFya2VyOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNhdGVnb3J5OiBXb3JrZXJHYXRlQ2F0ZWdvcnk7XG59XG5cbi8qKlxuICogRXZlcnkgd29ya2VyLXdyaXR0ZW4gZ2F0ZSByZWZ1c2FsLCBrZXllZCBieSB0aGUgcHJlZml4IGl0cyBmYWlsdXJlIHJlYXNvblxuICogb3BlbnMgd2l0aCAoSXNzdWUgIzM3MzUpLiBBIGZhaWx1cmUgcmVhc29uIHRoYXQgcXVvdGVzIHRleHQgdGhlIHdvcmtlciBkaWRcbiAqIG5vdCB3cml0ZSAodG9vbCBvdXRwdXQsIGFnZW50IHRleHQsIGlzc3VlIG9yIGNvbW1lbnQgdGV4dCkgb3BlbnMgd2l0aCBvbmUgb2ZcbiAqIHRoZXNlIG1hcmtlcnMsIHNvIHRoZSBxdW90ZWQgdGV4dCBjYW5ub3QgZm9yZ2UgYSB3b3JzZSBjYXRlZ29yeS5cbiAqIGBkZXRlY3RGYWlsdXJlQ2F0ZWdvcnlgIGFuZCBgZGV0ZWN0SG9zdEZhdWx0YCByZWFkIGl0IHdpdGggYHN0YXJ0c1dpdGhgIG9uXG4gKiB0aGUgbWVzc2FnZSAoYHdvcmtlckdhdGVDYXRlZ29yeU9mYCkgYmVmb3JlIHRoZWlyIGZyZWUtdGV4dCBydWxlcztcbiAqIGBjbGFzc2lmeVJ1bkZhaWx1cmVgIGFuZCBgY2xhc3NpZnlDb2RpbmdGYWlsdXJlYCBmaXJzdCB0ZXN0IHRoZSBjYXRlZ29yeSB0aGV5XG4gKiBhcmUgZ2l2ZW4gKGBpc1dvcmtlckdhdGVDYXRlZ29yeWApOyB0aGUgaG9zdC1mYXVsdCBhbmQgbWlsZXN0b25lLXJlZnVzYWxcbiAqIGxhYmVsLXJlbGVhc2Ugc3dlZXBzIHNraXAgYSBwb3N0ZWQgcmVjb3JkIHdob3NlIGhlYWQgY2F0ZWdvcnkgaXMgcmVnaXN0ZXJlZFxuICogKGBpc1dvcmtlckdhdGVGYWlsdXJlUmVjb3JkYCkuIGBzaG91bGRSZXRyeUluZnJhc3RydWN0dXJlRmFpbHVyZWAgZm9sbG93c1xuICogdGhyb3VnaCBgZGV0ZWN0RmFpbHVyZUNhdGVnb3J5YC4gQSBuZXcgZ2F0ZSByZWZ1c2FsIGlzIG9uZSBlbnRyeSBoZXJlLlxuICpcbiAqIGBQUkVfUFVTSF9MT09LVVBfRkFJTEVEX01BUktFUmAgaXMgZGVsaWJlcmF0ZWx5IE5PVCByZWdpc3RlcmVkOiBpdCBtYXBzIHRvXG4gKiBgcHVzaF9mYWlsdXJlYCAoaW5mcmFzdHJ1Y3R1cmUsIHJldHJpZWQgaW4tcnVuKSwgbm90IGFuIGFnZW50IG91dGNvbWUuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLRVJfR0FURV9NQVJLRVJTOiByZWFkb25seSBXb3JrZXJHYXRlTWFya2VyW10gPSBbXG4gIHsgbWFya2VyOiBTVU1NQVJZX1JVTEVfR0FURV9NQVJLRVIsIGNhdGVnb3J5OiBcInN1bW1hcnlfaW5jb21wbGV0ZVwiIH0sXG4gIHsgbWFya2VyOiBTRUNVUklUWV9GSVhfR0FURV9NQVJLRVIsIGNhdGVnb3J5OiBcInNlY3VyaXR5X2ZpeF9nYXRlXCIgfSxcbiAgeyBtYXJrZXI6IFBSRV9QVVNIX0dBVEVfTUFSS0VSLCBjYXRlZ29yeTogXCJwcmVfcHVzaF9nYXRlXCIgfSxcbiAgeyBtYXJrZXI6IENSSVRFUklBX1VOTUVUX0dBVEVfTUFSS0VSLCBjYXRlZ29yeTogXCJjcml0ZXJpYV91bm1ldFwiIH0sXG5dO1xuXG4vKiogVGhlIGdhdGUgY2F0ZWdvcnkgYG1lc3NhZ2VgIG9wZW5zIHdpdGgsIG9yIGBudWxsYCB3aGVuIGl0IG9wZW5zIHdpdGggbm9uZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3b3JrZXJHYXRlQ2F0ZWdvcnlPZihcbiAgbWVzc2FnZTogc3RyaW5nLFxuKTogV29ya2VyR2F0ZUNhdGVnb3J5IHwgbnVsbCB7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgV09SS0VSX0dBVEVfTUFSS0VSUykge1xuICAgIGlmIChtZXNzYWdlLnN0YXJ0c1dpdGgoZW50cnkubWFya2VyKSkgcmV0dXJuIGVudHJ5LmNhdGVnb3J5O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKiogV2hldGhlciBgY2F0ZWdvcnlgIGlzIG9uZSBvZiB0aGUgcmVnaXN0ZXJlZCB3b3JrZXIgZ2F0ZSBjYXRlZ29yaWVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzV29ya2VyR2F0ZUNhdGVnb3J5KFxuICBjYXRlZ29yeTogRmFpbHVyZUNhdGVnb3J5LFxuKTogY2F0ZWdvcnkgaXMgV29ya2VyR2F0ZUNhdGVnb3J5IHtcbiAgcmV0dXJuIFdPUktFUl9HQVRFX01BUktFUlMuc29tZSgoZW50cnkpID0+IGVudHJ5LmNhdGVnb3J5ID09PSBjYXRlZ29yeSk7XG59XG5cbi8qKlxuICogVGhlIGZvdXIgY2F0ZWdvcmllcyBhdXRob3Jpc2VkIGZvciB0aGUgb25lLW9mZiBsYWJlbCBjbGVhbnVwIChJc3N1ZSAjNDEzMikuXG4gKiBUaGlzIGhpc3RvcmljYWwgcmVsZWFzZSBzY29wZSBpcyBkaXN0aW5jdCBmcm9tIGN1cnJlbnQgZmFpbHVyZSBjbGFzc2lmaWNhdGlvbjpcbiAqIHF1YWxpdHkgY2hlY2tzIGFyZSBpbmNsdWRlZCwgd2hpbGUgdW5tZXQgYWNjZXB0YW5jZSBjcml0ZXJpYSBzdGF5IGxhYmVsbGVkLlxuICovXG5leHBvcnQgY29uc3QgV09SS0VSX0dBVEVfTEFCRUxfQ0xFQU5VUF9DQVRFR09SSUVTOiByZWFkb25seSBGYWlsdXJlQ2F0ZWdvcnlbXSA9XG4gIFtcbiAgICBcInN1bW1hcnlfaW5jb21wbGV0ZVwiLFxuICAgIFwicXVhbGl0eV9jaGVja1wiLFxuICAgIFwicHJlX3B1c2hfZ2F0ZVwiLFxuICAgIFwic2VjdXJpdHlfZml4X2dhdGVcIixcbiAgXTtcblxuLyoqIFdoZXRoZXIgYSBwb3N0ZWQgZGlzcGxheSBjYXRlZ29yeSBpcyB3aXRoaW4gSXNzdWUgIzQxMzIncyBjbGVhbnVwIHNjb3BlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzV29ya2VyR2F0ZUxhYmVsQ2xlYW51cERpc3BsYXkoZGlzcGxheTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBXT1JLRVJfR0FURV9MQUJFTF9DTEVBTlVQX0NBVEVHT1JJRVMuc29tZShcbiAgICAoY2F0ZWdvcnkpID0+IGdldEZhaWx1cmVDYXRlZ29yeURpc3BsYXkoY2F0ZWdvcnkpID09PSBkaXNwbGF5LFxuICApO1xufVxuXG4vKipcbiAqIFRoZSB3b3JrZXItd3JpdHRlbiBwcmVmaXggb2YgdGhlIGNvbXBsZXRpb24gcGhhc2UncyByZWFzb24gd2hlbiB0aGUgcHJlLXB1c2hcbiAqIGdhdGUgY291bGQgbm90IHJlYWQgdGhlIGJyYW5jaCBzdGF0ZSAoYSBmYWlsZWQgb3IgdGltZWQtb3V0IGdpdCBvciByZW1vdGVcbiAqIGxvb2t1cCwgUFIgIzM3MTYgcmV2aWV3KS4gVGhlIGJyYW5jaCB3YXMgbm90IGp1ZGdlZCwgc28gaXQgaXMgYVxuICogYHB1c2hfZmFpbHVyZWAgKGluZnJhc3RydWN0dXJlLCByZXRyaWVkIGluLXJ1bikuIE1hdGNoZWQgd2l0aCBgc3RhcnRzV2l0aGBcbiAqIGFoZWFkIG9mIHRoZSB0aW1lb3V0IHJ1bGUsIGJlY2F1c2UgdGhlIHF1b3RlZCBnaXQgdGV4dCBsZWdpdGltYXRlbHkgc2F5c1xuICogYHRpbWVkIG91dGAgKGBUSU1FT1VUOiBnaXQgcmV2LWxpc3Qg4oCmIHRpbWVkIG91dCBhZnRlciAzMHNgKSBvclxuICogYENvbm5lY3Rpb24gdGltZWQgb3V0YCwgd2hpY2ggd291bGQgb3RoZXJ3aXNlIG1ha2UgaXQgYSBgdGltZW91dGAuXG4gKi9cbmV4cG9ydCBjb25zdCBQUkVfUFVTSF9MT09LVVBfRkFJTEVEX01BUktFUiA9XG4gIFwiR2l0IHB1c2ggZmFpbGVkOiB0aGUgcHJlLXB1c2ggZ2F0ZSBjb3VsZCBub3QgcmVhZCB0aGUgYnJhbmNoIHN0YXRlXCI7XG5cbi8qKlxuICogVGhlIHdvcmtlci13cml0dGVuIGhlYWQgb2YgYSBwb3N0ZWQgZmFpbHVyZSByZWNvcmQ6IHRoZSBgIyMg4oCmYCBoZWFkaW5nIGxpbmVcbiAqIGZvbGxvd2VkIGJ5IHRoZSBgKipDYXRlZ29yeToqKiBcXGDigKZcXGBgIGxpbmUgYG1hcmtJc3N1ZUFzRmFpbGVkT25jZWAgd3JpdGVzXG4gKiBzdHJhaWdodCBhZnRlciBpdC4gQW5jaG9yZWQgdG8gdGhlIHN0YXJ0IG9mIHRoZVxuICogY29tbWVudCwgYWhlYWQgb2YgdGhlIHF1b3RlZCBhZ2VudCB0ZXh0LCBzbyBhIHF1b3RlZCBjYXRlZ29yeSBsaW5lIGZ1cnRoZXJcbiAqIGRvd24gY2Fubm90IGZvcmdlIGl0LiBgW15cXG5dKmAgYW5kIGBcXHMqYCBhcmUgc2VwYXJhdGVkIGJ5IGEgbGl0ZXJhbCBgXFxuYCxcbiAqIGFuZCB0aGUgY2FwdHVyZWQgY2F0ZWdvcnkgaXMgYSBib3VuZGVkIGBbYS16LV0rYCBydW4sIHNvIHRoZSBwYXR0ZXJuIHN0YXlzXG4gKiBsaW5lYXIuXG4gKi9cbmNvbnN0IFdPUktFUl9HQVRFX1JFQ09SRF9IRUFEX1JFID1cbiAgL14jI1teXFxuXSpcXG5cXHMqXFwqXFwqQ2F0ZWdvcnk6XFwqXFwqIGAoW2Etei1dKylgLztcblxuLyoqXG4gKiBXaGV0aGVyIGEgcG9zdGVkIGZhaWx1cmUtcmVjb3JkIGNvbW1lbnQgYm9keSByZWNvcmRzIGEgd29ya2VyIGdhdGUgcmVmdXNhbDpcbiAqIGFueSB7QGxpbmsgV09SS0VSX0dBVEVfTUFSS0VSU30gY2F0ZWdvcnkgKHN1bW1hcnksIHNlY3VyaXR5LWZpeCBvciBwcmUtcHVzaFxuICogZ2F0ZTsgSXNzdWVzICMzNDMxLCAjMzQ1NCwgUFIgIzM3MTY7IElzc3VlICMzNzM1KS4gVGhlIHJlY29yZCBlbWJlZHMgdGhlXG4gKiByZWFzb24gdW5kZXIgYSBoZWFkaW5nLCBzbyB0aGUgZ2F0ZSBtYXJrZXIgaXMgbm8gbG9uZ2VyIGF0IHRoZSBzdGFydCBvZiB0aGVcbiAqIGJvZHkuIFRoZSBzd2VlcHMgdGhhdCByZS1jbGFzc2lmeSBwb3N0ZWQgYm9kaWVzIChgaG9zdF9mYXVsdF9yZWxlYXNlLnRzYCxcbiAqIGBtaWxlc3RvbmVfYnJhbmNoX3JlZnVzYWxfcmVsZWFzZS50c2ApIHVzZSB0aGlzIHRvIGxlYXZlIHN1Y2ggYSByZWNvcmRcbiAqIGFsb25lLCBiZWNhdXNlIHRoZSB0ZXh0IGl0IHF1b3RlcyBpcyB0aGUgYWdlbnQncywgdGhlIHRvb2xzJyBvciB0aGVcbiAqIGJyYW5jaCdzIG93biwgbm90IGhvc3Qgb3IgcmVwb3NpdG9yeSBvdXRwdXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1dvcmtlckdhdGVGYWlsdXJlUmVjb3JkKGJvZHk6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBoZWFkID0gV09SS0VSX0dBVEVfUkVDT1JEX0hFQURfUkUuZXhlYyhib2R5LnRyaW1TdGFydCgpKTtcbiAgaWYgKGhlYWQgPT09IG51bGwpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgZGlzcGxheSA9IGhlYWRbMV07XG4gIHJldHVybiBXT1JLRVJfR0FURV9NQVJLRVJTLnNvbWUoKGVudHJ5KSA9PlxuICAgIGdldEZhaWx1cmVDYXRlZ29yeURpc3BsYXkoZW50cnkuY2F0ZWdvcnkpID09PSBkaXNwbGF5XG4gICk7XG59XG5cbi8qKlxuICogVGhlIHdvcmtlci13cml0dGVuIGhlYWQgb2YgYSBzdW1tYXJ5IG9yIHN1YnN0YW50aXZlIHF1YWxpdHkgZmFpbHVyZSByZWNvcmQuXG4gKiBUaGUgQ2F0ZWdvcnkgbGluZSBpbW1lZGlhdGVseSBmb2xsb3dzIHRoZSBoZWFkaW5nLCBiZWZvcmUgcXVvdGVkIGFnZW50IHRleHQ7XG4gKiBhIGNhdGVnb3J5IGxpbmUgZGVlcGVyIGluIHRoZSByZWFzb24gY2Fubm90IGZvcmdlIHRoaXMgcHJvdmVuYW5jZS5cbiAqIFRoZSBsaXRlcmFsIG5ld2xpbmUgc2VwYXJhdGVzIHRoZSBib3VuZGVkIGhlYWRpbmcgc2NhbiBmcm9tIHdoaXRlc3BhY2UuXG4gKi9cbmNvbnN0IFNVTU1BUllfT1JfUVVBTElUWV9SRUNPUkRfUkUgPVxuICAvXiMjW15cXG5dKlxcblxccypcXCpcXCpDYXRlZ29yeTpcXCpcXCogYCg/OnN1bW1hcnktaW5jb21wbGV0ZXxxdWFsaXR5LWZhaWx1cmUpYC87XG5cbi8qKlxuICogV2hldGhlciBhIHBvc3RlZCBmYWlsdXJlIHJlY29yZCBkZWNsYXJlcyBhIHN1bW1hcnkgb3IgcXVhbGl0eSB2ZXJkaWN0LlxuICogUmVsZWFzZSBzd2VlcHMgcHJlc2VydmUgdGhhdCBjYXVzZSByYXRoZXIgdGhhbiByZWNsYXNzaWZ5aW5nIHF1b3RlZCB0ZXh0XG4gKiBhcyBhIGhvc3QgZmF1bHQgb3IgYSByZXBvc2l0b3J5IHJlZnVzYWwgKElzc3VlcyAjMzQzMSBhbmQgIzM3MzgpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTdW1tYXJ5T3JRdWFsaXR5RmFpbHVyZVJlY29yZChib2R5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIFNVTU1BUllfT1JfUVVBTElUWV9SRUNPUkRfUkUudGVzdChib2R5LnRyaW1TdGFydCgpKTtcbn1cblxuLyoqXG4gKiBUaGUgY2F0Y2gtYWxsIGBFcnJvcjpgIHJ1bGUgb2Yge0BsaW5rIGRldGVjdEZhaWx1cmVDYXRlZ29yeX0uIEEgUnVzdC9DKytcbiAqIHBhdGggc3VjaCBhcyBgQXBwRXJyb3I6OlhgIGlzIG5vdCBhbiBgRXJyb3I6YCBsaW5lLCBzbyBgRXJyb3I6OmAgaXMgZXhjbHVkZWRcbiAqIChJc3N1ZSAjMzQzMSkuIFRoZSBsb29rYWhlYWQgaXMgYSBzaW5nbGUtY2hhcmFjdGVyIGNoZWNrLCBzbyBpdCBzdGF5cyBsaW5lYXIuXG4gKi9cbmNvbnN0IEVSUk9SX0NPTE9OX1JFID0gL0Vycm9yOig/ITopLztcblxuLyoqXG4gKiBUaGUgb3BlcmF0b3ItZmFjaW5nIHJlYXNvbiBsaW5lIGZvciBhIHNjaGVkdWxlZCByZWxlYXNlIChJc3N1ZSAjNDI0KS5cbiAqXG4gKiBgcHJlc2VydmVkTm90ZWAgaXMgdGhlIG5vdGUgcHJlc2VydmF0aW9uIGl0c2VsZiB3cm90ZSAoSXNzdWUgIzc3MCkg4oCUIGl0XG4gKiBuYW1lcyB0aGUgYnJhbmNoIHRoZSBwdXNoIGFjdHVhbGx5IHRhcmdldGVkLCBhbmQgdGhlIGhhbmRvdmVyIGZpbGUgb24gaXRcbiAqIHdoZW4gb25lIGV4aXN0cy4gRm9sZGVkIGluIGhlcmUgcmF0aGVyIHRoYW4gYXBwZW5kZWQgYnkgdGhlIGNhbGxlciBzbyB0aGVcbiAqIHJlYXNvbiBzdGF0ZXMgd2hlcmUgdGhlIHdvcmsgaXMgZXhhY3RseSBvbmNlLiBXaXRob3V0IGl0IHRoZSB3b3JkaW5nIGlzXG4gKiB1bmNoYW5nZWQ6IGEgcmVsZWFzZSB0aGF0IHByZXNlcnZlZCBub3RoaW5nIG11c3Qgbm90IG5hbWUgYSBicmFuY2ggbm8gcHVzaFxuICogZXZlciByZWFjaGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTY2hlZHVsZWRSZWxlYXNlUmVhc29uKFxuICByZWFzb246IFNjaGVkdWxlZFJlbGVhc2VSZWFzb24sXG4gIHByZXNlcnZlZE5vdGU/OiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICBjb25zdCBjYXVzZSA9IHJlYXNvbiA9PT0gXCJoYXJkLWNhcFwiXG4gICAgPyBcInRoZSBzdXBlcnZpc29yJ3MgcnVuIGhhcmQgY2FwIHdhcyByZWFjaGVkXCJcbiAgICA6IHJlYXNvbiA9PT0gXCJmaW5pc2gtZGVhZGxpbmVcIlxuICAgID8gXCJ0aGUgZmluaXNoIGRlYWRsaW5lIHdhcyByZWFjaGVkXCJcbiAgICA6IFwidGhlIGN5Y2xlIGVuZGVkXCI7XG4gIHJldHVybiBgJHtTQ0hFRFVMRURfUkVMRUFTRV9NQVJLRVJ9ICR7Y2F1c2V9IOKAlCBgICtcbiAgICAocHJlc2VydmVkTm90ZSA/PyBcIldJUCBwcmVzZXJ2ZWQsIHJlc3VtZXMgbmV4dCBjeWNsZVwiKTtcbn1cblxuLyoqXG4gKiBBbmFseXNlIGEgZmFpbHVyZSBtZXNzYWdlIGFuZCByZXR1cm4gYSBjYXRlZ29yeS5cbiAqXG4gKiBFeGFtaW5lcyB0aGUgZmFpbHVyZSBtZXNzYWdlIHRleHQgZm9yIGtub3duIHBhdHRlcm5zIGFuZCByZXR1cm5zIGEgY2F0ZWdvcnlcbiAqIHN0cmluZyB0aGF0IGNhbiBiZSB1c2VkIHRvIHNlbGVjdCBhcHByb3ByaWF0ZSBkaWFnbm9zaXMgbWVzc2FnaW5nLlxuICpcbiAqIE9yZGVyIG1hdHRlcnM6IG1vcmUgc3BlY2lmaWMgcGF0dGVybnMgYXJlIGNoZWNrZWQgYmVmb3JlIGdlbmVyYWwgb25lcy5cbiAqIFRoZSBsZWFkaW5nIHdvcmtlci13cml0dGVuIGdhdGUgbWFya2VycyAoZXZlcnkgZW50cnkgb2ZcbiAqIHtAbGluayBXT1JLRVJfR0FURV9NQVJLRVJTfSwgSXNzdWVzICMzNDMxLCAjMzQ1NCBhbmQgUFIgIzM3MTYgcmV2aWV3KSwgdGhlblxuICoge0BsaW5rIFBSRV9QVVNIX0xPT0tVUF9GQUlMRURfTUFSS0VSfSwgYXJlIGBzdGFydHNXaXRoYCBydWxlcyBjaGVja2VkIGFoZWFkXG4gKiBvZiBldmVyeSBvdGhlciBydWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0RmFpbHVyZUNhdGVnb3J5KGZhaWx1cmVNZXNzYWdlOiBzdHJpbmcpOiBGYWlsdXJlQ2F0ZWdvcnkge1xuICBpZiAoIWZhaWx1cmVNZXNzYWdlKSByZXR1cm4gXCJ1bmtub3duXCI7XG5cbiAgLy8gVGhlIHdvcmtlcidzIG93biBnYXRlIHJlZnVzYWxzLCByZWFkIGZyb20gV09SS0VSX0dBVEVfTUFSS0VSUyAoSXNzdWVcbiAgLy8gIzM3MzUpLiBBbmNob3JlZFxuICAvLyB0byB0aGUgU1RBUlQgb2YgdGhlIG1lc3NhZ2UgYW5kIGNoZWNrZWQgYmVmb3JlIGV2ZXJ5IG90aGVyIHJ1bGUsIHRoZVxuICAvLyBzY2hlZHVsZWQtcmVsZWFzZSBvbmUgaW5jbHVkZWQ6IHRoZSByZWZ1c2FsIHF1b3RlcyB0aGUgYWdlbnQncywgdGhlIHRvb2xzJ1xuICAvLyBvciB0aGUgYnJhbmNoJ3Mgb3duIHRleHQsIHNvIGEgcXVvdGVkIFwiUmVsZWFzZWQgb24gc2NoZWR1bGU6XCIsIFwidGltZW91dFwiLFxuICAvLyBcIlNJR1RFUk1cIiwgXCJyYXRlIGxpbWl0XCIgb3IgYFR5cGVFcnJvcjpgIG11c3Qgbm90IG91dHJhbmsgaXQuIFNhZmUgYWhlYWQgb2ZcbiAgLy8gdGhlIHNjaGVkdWxlZC1yZWxlYXNlIHJ1bGUgYmVjYXVzZSBldmVyeSByZWFzb25cbiAgLy8ge0BsaW5rIGJ1aWxkU2NoZWR1bGVkUmVsZWFzZVJlYXNvbn0gd3JpdGVzIG9wZW5zIHdpdGhcbiAgLy8ge0BsaW5rIFNDSEVEVUxFRF9SRUxFQVNFX01BUktFUn0sIHNvIG5vbmUgY2FuIG9wZW4gd2l0aCBhIGdhdGUgbWFya2VyLlxuICBjb25zdCBnYXRlQ2F0ZWdvcnkgPSB3b3JrZXJHYXRlQ2F0ZWdvcnlPZihmYWlsdXJlTWVzc2FnZSk7XG4gIGlmIChnYXRlQ2F0ZWdvcnkgIT09IG51bGwpIHJldHVybiBnYXRlQ2F0ZWdvcnk7XG5cbiAgLy8gVGhlIGdhdGUgY291bGQgbm90IHJlYWQgdGhlIGJyYW5jaCBzdGF0ZTogYW4gaW5mcmFzdHJ1Y3R1cmUgZmF1bHQsIG5ldmVyXG4gIC8vIGEgdGltZW91dCBvciByYXRlIGxpbWl0IHRoZSBxdW90ZWQgZ2l0IHRleHQgaGFwcGVucyB0byBtZW50aW9uLlxuICBpZiAoZmFpbHVyZU1lc3NhZ2Uuc3RhcnRzV2l0aChQUkVfUFVTSF9MT09LVVBfRkFJTEVEX01BUktFUikpIHtcbiAgICByZXR1cm4gXCJwdXNoX2ZhaWx1cmVcIjtcbiAgfVxuXG4gIC8vIEEgc2NoZWR1bGVkIHJlbGVhc2Ugb3V0cmFua3MgZXZlcnkgb3RoZXIgcGF0dGVybiAoSXNzdWUgIzQyNCwgcGFyZW50XG4gIC8vICMzOTcpLiBTdWNoIGEgbWVzc2FnZSBsZWdpdGltYXRlbHkgY2FycmllcyB0aGUgd2F0Y2hkb2cgbGluZSwgYVxuICAvLyBgVGltZW91dDogTnNgIGZpZ3VyZSBhbmQgYSBTSUdURVJNIGV4aXQg4oCUIHRoZSBydW4gV0FTIHN0b3BwZWQgYnkgdGhlXG4gIC8vIHdvcmtlcidzIG93biBraWxsIOKAlCBzbyBpbmZlcnJpbmcgZnJvbSB0aGUgZXhpdCBzdGF0dXMgYWxvbmUgd291bGRcbiAgLy8gY2xhc3NpZnkgYSBoYW5kb3ZlciBhcyB0aGUgaXNzdWUgcnVubmluZyBvdXQgb2YgdGltZS4gVGhlIGtpbGwgcGF0aFxuICAvLyBrbm93cyB3aGljaCByZWxlYXNlIGl0IHRvb2sgYW5kIHNheXMgc28gaW4gdGhlIHJlYXNvbjsgdGhhdCBtYXJrZXIgaXNcbiAgLy8gdGhlIGRpc2NyaW1pbmF0b3IuXG4gIGlmIChmYWlsdXJlTWVzc2FnZS5pbmNsdWRlcyhTQ0hFRFVMRURfUkVMRUFTRV9NQVJLRVIpKSB7XG4gICAgcmV0dXJuIFwic2NoZWR1bGVkX3JlbGVhc2VcIjtcbiAgfVxuXG4gIC8vIFRoZSB3b3JrZXIncyBPV04gd2F0Y2hkb2cgZW5kcyBhIHRpbWVkLW91dCBhZ2VudCB3aXRoIFNJR1RFUk0gKHRoZW5cbiAgLy8gU0lHS0lMTCksIHNvIGEgZ2VudWluZSB0aW1lb3V0J3MgZGlhZ25vc3RpY3MgbGVnaXRpbWF0ZWx5IHJlYWRcbiAgLy8gYFJhdyBleGl0IGNvZGU6IDE0MyAoU0lHVEVSTSlgIG9yIGAxMzcgKFNJR0tJTEwpYC4gVGhhdCBldmlkZW5jZSBtdXN0IG5vdFxuICAvLyBiZSBtaXN0YWtlbiBmb3IgYW4gZXh0ZXJuYWwga2lsbCAoVmliZUNvZGVyIzE3NDogZXZlcnkgaGFyZCB0aW1lb3V0IHdhc1xuICAvLyBjbGFzc2lmaWVkIGBraWxsZWRgLCByZXRyaWVkIGluLXByb2Nlc3Mgd2l0aCA2MCBzIG9mIHJ1bndheSwgYW5kIGJsYW1lZFxuICAvLyBvbiB0aGUgT09NIGtpbGxlcikuIGBXYXRjaGRvZzpgIG9ubHkgYXBwZWFycyBpbiBtZXNzYWdlcyB0aGUgdGltZW91dFxuICAvLyBwYXRoIGJ1aWxkcywgc28gaXQgaXMgdGhlIGRpc2NyaW1pbmF0b3IuXG4gIGNvbnN0IG93bldhdGNoZG9nRmlyZWQgPSB3YXRjaGRvZ0ZpcmVkSW4oZmFpbHVyZU1lc3NhZ2UpO1xuXG4gIC8vIFNJR0tJTEwgZmlyc3QgKElzc3VlICM0MjAyKTogYSBraWxsZWQgcnVuJ3MgbWVzc2FnZSBtdXN0IG5ldmVyIGJlIHJlYWQgYXNcbiAgLy8gYSB0aW1lb3V0IOKAlCB0aGF0IG1pc2xhYmVsbGluZyBpcyBwcmVjaXNlbHkgd2hhdCB0aGlzIGNhdGVnb3J5IGV4aXN0cyB0b1xuICAvLyBlbmQuIFRoZSBzaWduYWwgbmFtZSBpcyB0aGUgZGlzY3JpbWluYXRvciBiZWNhdXNlIGl0IG9ubHkgYXBwZWFycyB3aGVuXG4gIC8vIHRoZSBydW5uZXIgY2xhc3NpZmllZCBhIGdlbnVpbmUga2lsbC5cbiAgaWYgKCFvd25XYXRjaGRvZ0ZpcmVkICYmIGZhaWx1cmVNZXNzYWdlLmluY2x1ZGVzKFwiU0lHS0lMTFwiKSkge1xuICAgIHJldHVybiBcImtpbGxlZFwiO1xuICB9XG5cbiAgLy8gSXNzdWUgIzQ2OiBhbiBleHRlcm5hbCBTSUdURVJNIHRoZSB3b3JrZXIgbmV2ZXIgcmVxdWVzdGVkIGlzIGFuXG4gIC8vIGVudmlyb25tZW50IGtpbGwgdG9vIOKAlCBub3QgYSBwcm9wZXJ0eSBvZiB0aGUgaXNzdWUuIENsYXNzaWZ5IGl0IGFzXG4gIC8vIGBraWxsZWRgIChpbmZyYXN0cnVjdHVyZSkgc28gaXQgaXMgcmV0cmllZCBhbmQgbm90IGJsYW1lZCBvbiB0aGUgaXNzdWUuXG4gIGlmICghb3duV2F0Y2hkb2dGaXJlZCAmJiBmYWlsdXJlTWVzc2FnZS5pbmNsdWRlcyhcIlNJR1RFUk1cIikpIHtcbiAgICByZXR1cm4gXCJraWxsZWRcIjtcbiAgfVxuXG4gIC8vIFRpbWVvdXQgd2l0aCB6ZXJvIG91dHB1dCBpcyB6ZXJvX291dHB1dCwgbm90IHRpbWVvdXRcbiAgaWYgKFxuICAgIGZhaWx1cmVNZXNzYWdlLmluY2x1ZGVzKFwidGltZWQgb3V0XCIpIHx8IGZhaWx1cmVNZXNzYWdlLmluY2x1ZGVzKFwidGltZW91dFwiKVxuICApIHtcbiAgICBpZiAoXG4gICAgICBmYWlsdXJlTWVzc2FnZS5pbmNsdWRlcyhcInplcm8gb3V0cHV0XCIpIHx8XG4gICAgICBmYWlsdXJlTWVzc2FnZS5pbmNsdWRlcyhcIk5vIG91dHB1dCBjYXB0dXJlZFwiKVxuICAgICkge1xuICAgICAgcmV0dXJuIFwiemVyb19vdXRwdXRcIjtcbiAgICB9XG4gICAgcmV0dXJuIFwidGltZW91dFwiO1xuICB9XG5cbiAgLy8gQ2FzZS1pbnNlbnNpdGl2ZSwgYW5kIHRoZSBzdWJzY3JpcHRpb24gdXNhZ2Ugd2luZG93IGNvdW50cyB0b28gKElzc3VlXG4gIC8vICM0MzE1KTogXCJSYXRlIGxpbWl0IOKAplwiIC8gXCJDbGF1ZGUgdXNhZ2UgbGltaXQgcmVhY2hlZFwiIGVzY2FwaW5nIGhlcmVcbiAgLy8gbGFuZGVkIGluIGB1bmtub3duYCwgd2hpY2ggaXMgbm90IGluZnJhc3RydWN0dXJlIOKAlCB0aGUgaXNzdWUgd2FzIHRoZW5cbiAgLy8gYmxhbWVkIGFuZCBsYWJlbGxlZCBmYWlsZWQgZm9yIGFuIGFjY291bnQtbGV2ZWwgY2FwLlxuICBjb25zdCBsb3dlcmVkID0gZmFpbHVyZU1lc3NhZ2UudG9Mb3dlckNhc2UoKTtcbiAgaWYgKFxuICAgIGxvd2VyZWQuaW5jbHVkZXMoXCJyYXRlIGxpbWl0XCIpIHx8XG4gICAgbG93ZXJlZC5pbmNsdWRlcyhcInJhdGUtbGltaXRlZFwiKSB8fFxuICAgIGxvd2VyZWQuaW5jbHVkZXMoXCJ1c2FnZSBsaW1pdFwiKSB8fFxuICAgIC8vIE91dCBvZiBjcmVkaXQgaXMgYW4gYWNjb3VudCBzdGF0ZSB0b28gKElzc3VlICMyNTkwKTogY291bnRlZCBhc1xuICAgIC8vIGludGVybmFsX2Vycm9yIGl0IGJhY2tlZCBvZmYgYSBoZWFsdGh5IHJlcG9zaXRvcnkgYXMgYSBmYXN0IGZhaWx1cmUuXG4gICAgaXNPdXRPZkNyZWRpdE1lc3NhZ2UoZmFpbHVyZU1lc3NhZ2UpXG4gICkge1xuICAgIHJldHVybiBcInJhdGVfbGltaXRcIjtcbiAgfVxuXG4gIC8vIEEgcnVuIGN1dCBvZmYgYmVmb3JlIGZpbmlzaGluZyAoSXNzdWUgIzEwOCkuIFRoZSBtZXNzYWdlIGlzIG9uZSB0aGUgd29ya2VyXG4gIC8vIGNvbnN0cnVjdHMgKGhhbmRsZV9ub19jaGFuZ2VzX3BoYXNlKSB3aXRoIHRoaXMgc3RhYmxlIG1hcmtlciwgc28gdGhlIG1hdGNoXG4gIC8vIGlzIGV4YWN0IHJhdGhlciB0aGFuIHNuaWZmaW5nIGFyYml0cmFyeSBhZ2VudCBwcm9zZS5cbiAgaWYgKGxvd2VyZWQuaW5jbHVkZXMoXCJpbnRlcnJ1cHRlZCBiZWZvcmUgY29tcGxldGluZ1wiKSkge1xuICAgIHJldHVybiBcImludGVycnVwdGVkXCI7XG4gIH1cblxuICAvLyBBIGdhdGUgdGhlIHdvcmtlciBpdHNlbGYgYXBwbGllZCAoSXNzdWUgIzIwNDQpLiBEZWxpYmVyYXRlbHkgY2hlY2tlZFxuICAvLyBBRlRFUiB0aGUga2lsbCwgdGltZW91dCwgcmF0ZS1saW1pdCBhbmQgaW50ZXJydXB0ZWQgcnVsZXM6IHRob3NlIG1lc3NhZ2VzXG4gIC8vIHF1b3RlIHRoZSB0YWlsIG9mIHRoZSBhZ2VudCdzIG91dHB1dCwgYW5kIGFuIGFnZW50IHdyaXRpbmcgKmFib3V0KiB0aGlzXG4gIC8vIGdhdGUgbXVzdCBub3QgdHVybiBpdHMgdGltZW91dCBpbnRvIGEgZ2F0ZSBibG9jayAodGhlICMyNDkgbGVzc29uKS4gQnlcbiAgLy8gaGVyZSB0aGUgbWVzc2FnZSBpcyB0aGUgd29ya2VyJ3Mgb3duIHJlZnVzYWwuXG4gIGlmIChmYWlsdXJlTWVzc2FnZS5pbmNsdWRlcyhXT1JLRkxPV19HQVRFX01BUktFUikpIHtcbiAgICByZXR1cm4gXCJ3b3JrZmxvd19nYXRlXCI7XG4gIH1cblxuICAvLyBUaGUgd29ya2VyJ3Mgb3duIGBQcm9tcHQgaXMgdG9vIGxvbmdgIHJlYXNvbiAoSXNzdWUgIzI2ODIpIOKAlCBjaGVja2VkXG4gIC8vIGFmdGVyIHRoZSBzYW1lIHJ1bGVzIGFzIHRoZSBnYXRlIGFib3ZlLCBmb3IgdGhlIHNhbWUgcmVhc29uLlxuICBpZiAoZmFpbHVyZU1lc3NhZ2UuaW5jbHVkZXMoUFJPTVBUX1RPT19MT05HX01BUktFUikpIHtcbiAgICByZXR1cm4gXCJwcm9tcHRfdG9vX2xvbmdcIjtcbiAgfVxuXG4gIC8vIFRoZSBzZXR1cCBwaGFzZSdzIG93biBicm9rZW4tc2hhcmVkLWNsb25lIHJlYXNvbiAoSXNzdWUgIzI4ODQpIOKAlCBjaGVja2VkXG4gIC8vIGJlZm9yZSB0aGUgZ2VuZXJpYyBwYXR0ZXJucyBiZWxvdyBzbyBhIHdvcmtlci1hdXRob3JlZCBkaWFnbm9zaXMgd2luc1xuICAvLyBvdmVyIGFueSByYXcgZ2l0IGVycm9yIHRleHQgdGhlIHNhbWUgbWVzc2FnZSBoYXBwZW5zIHRvIHF1b3RlLlxuICBpZiAoZmFpbHVyZU1lc3NhZ2UuaW5jbHVkZXMoQ0xPTkVfQ09SUlVQVF9NQVJLRVIpKSB7XG4gICAgcmV0dXJuIFwiY2xvbmVfY29ycnVwdFwiO1xuICB9XG5cbiAgaWYgKFxuICAgIGZhaWx1cmVNZXNzYWdlLmluY2x1ZGVzKFwiemVybyBvdXRwdXRcIikgfHxcbiAgICBmYWlsdXJlTWVzc2FnZS5pbmNsdWRlcyhcIk5vIG91dHB1dCBjYXB0dXJlZFwiKVxuICApIHtcbiAgICByZXR1cm4gXCJ6ZXJvX291dHB1dFwiO1xuICB9XG5cbiAgaWYgKFxuICAgIGZhaWx1cmVNZXNzYWdlLmluY2x1ZGVzKFwibm90IGF2YWlsYWJsZSBpbiB0aGUgd29ya2VyIGVudmlyb25tZW50XCIpIHx8XG4gICAgZmFpbHVyZU1lc3NhZ2UuaW5jbHVkZXMoXCJub3QgaW5zdGFsbGVkIG9yIG5vdCBpbiBQQVRIXCIpIHx8XG4gICAgZmFpbHVyZU1lc3NhZ2UuaW5jbHVkZXMoXCJjb21tYW5kIG5vdCBmb3VuZFwiKVxuICApIHtcbiAgICByZXR1cm4gXCJtaXNzaW5nX3Rvb2xzXCI7XG4gIH1cblxuICBpZiAoXG4gICAgZmFpbHVyZU1lc3NhZ2UuaW5jbHVkZXMoXCJxdWFsaXR5LnNoXCIpIHx8XG4gICAgZmFpbHVyZU1lc3NhZ2UuaW5jbHVkZXMoXCJxdWFsaXR5IGNoZWNrc1wiKSB8fFxuICAgIGZhaWx1cmVNZXNzYWdlLmluY2x1ZGVzKFwiUXVhbGl0eSBjaGVja3NcIilcbiAgKSB7XG4gICAgcmV0dXJuIFwicXVhbGl0eV9jaGVja1wiO1xuICB9XG5cbiAgLy8gSXNzdWUgIzE0NzU6IGNoZWNrZWQgYmVmb3JlIHRoZSBwdXNoLWZhaWx1cmUgcGhyYXNlcywgYW5kIGJlZm9yZSB0aGVcbiAgLy8gcHVzaCBpdHNlbGYg4oCUIHRoZSBtZXNzYWdlIG5hbWVzIHRoZSBzY29wZSBhbmQgdGhlIHdvcmtmbG93IHBhdGhzLlxuICAvL1xuICAvLyBJc3N1ZSAjMTk1MjogR2l0SHViJ3Mgb3duIHJlZnVzYWwgY291bnRzIHRvby4gV2hlbiB0aGUgcHJlLXB1c2ggY2hlY2tcbiAgLy8gY291bGQgbm90IGFuc3dlciwgdGhlIHJhdyByZW1vdGUgdGV4dCBpcyBhbGwgdGhlIHJlY29yZCBoYXMsIGFuZCBpdFxuICAvLyBvdGhlcndpc2UgbWF0Y2hlZCB0aGUgZ2VuZXJpYyBcIkdpdCBwdXNoIGZhaWxlZFwiIHJ1bGUgYmVsb3cg4oCUIGxvc2luZyB0aGVcbiAgLy8gb25lIGRpYWdub3NpcyBhbiBvcGVyYXRvciBjYW4gYWN0IG9uLlxuICBpZiAoXG4gICAgZmFpbHVyZU1lc3NhZ2UuaW5jbHVkZXMoXCJsYWNrcyB0aGUgJ3dvcmtmbG93JyBzY29wZVwiKSB8fFxuICAgIGlzV29ya2Zsb3dTY29wZVB1c2hSZWZ1c2FsKGZhaWx1cmVNZXNzYWdlKVxuICApIHtcbiAgICByZXR1cm4gXCJ0b2tlbl9zY29wZVwiO1xuICB9XG5cbiAgLy8gSXNzdWUgIzIyMjA6IGEgcmVwb3NpdG9yeS1sZXZlbCByZWZ1c2FsIG9mIHRoZSBNSUxFU1RPTkUgYnJhbmNoLiBDaGVja2VkXG4gIC8vIGJlZm9yZSB0aGUgZ2VuZXJpYyBwdXNoIHJ1bGUsIHdoaWNoIGlzIHdoYXQgc3dhbGxvd2VkIGl0OiB0aGUgcmVmdXNhbFxuICAvLyB0ZXh0IHNheXMgYEdIMDEzYCAvIGBSZXBvc2l0b3J5IHJ1bGUgdmlvbGF0aW9uc2AgLyBgcmVtb3RlIHJlamVjdGVkYCBhbmRcbiAgLy8gYEZhaWxlZCB0byBwdXNoIG1pbGVzdG9uZSBicmFuY2hgLCBub25lIG9mIHdoaWNoIHRoZSBwdXNoIHBhdHRlcm5zXG4gIC8vIG1hdGNoLCBzbyB0aGUgY2F0ZWdvcnkgY2FtZSBvdXQgYHVua25vd25gIGFuZCB0aGUgaXNzdWUgd2FzIGJsYW1lZCBmb3JcbiAgLy8gdGhlIHJlcG9zaXRvcnkncyBydWxlc2V0LiBOYXJyb3cgb24gcHVycG9zZSAoc2VlXG4gIC8vIGBpc1JlcG9MZXZlbE1pbGVzdG9uZUJyYW5jaFJlZnVzYWxgKTogYW4gb3JkaW5hcnkgZmVhdHVyZS1icmFuY2hcbiAgLy8gcHJvdGVjdGlvbiByZWZ1c2FsIHN0YXlzIGBwdXNoX2ZhaWx1cmVgIGFuZCBrZWVwcyBpdHMgYm91bmRlZCByZXRyeS5cbiAgaWYgKGlzUmVwb0xldmVsTWlsZXN0b25lQnJhbmNoUmVmdXNhbChmYWlsdXJlTWVzc2FnZSkpIHtcbiAgICByZXR1cm4gXCJyZXBvX2NvbmZpZ1wiO1xuICB9XG5cbiAgaWYgKFxuICAgIGZhaWx1cmVNZXNzYWdlLmluY2x1ZGVzKFwiR2l0IHB1c2ggZmFpbGVkXCIpIHx8XG4gICAgZmFpbHVyZU1lc3NhZ2UuaW5jbHVkZXMoXCJnaXQgcHVzaCBmYWlsZWRcIilcbiAgKSB7XG4gICAgcmV0dXJuIFwicHVzaF9mYWlsdXJlXCI7XG4gIH1cblxuICBpZiAoXG4gICAgZmFpbHVyZU1lc3NhZ2UuaW5jbHVkZXMoXCJzY3JlZW5zaG90IGV2aWRlbmNlXCIpIHx8XG4gICAgZmFpbHVyZU1lc3NhZ2UuaW5jbHVkZXMoXCJTY3JlZW5zaG90XCIpXG4gICkge1xuICAgIHJldHVybiBcImV2aWRlbmNlX21pc3NpbmdcIjtcbiAgfVxuXG4gIGlmIChmYWlsdXJlTWVzc2FnZS5pbmNsdWRlcyhcIndpdGhvdXQgbWFraW5nIGFueSBjaGFuZ2VzXCIpKSB7XG4gICAgcmV0dXJuIFwibm9fY2hhbmdlc1wiO1xuICB9XG5cbiAgLy8gSW50ZXJuYWwvQ0xJIGVycm9yczogY2hlY2sgZm9yIGVycm9yIHBhdHRlcm5zLCBzdGFjayB0cmFjZXNcbiAgaWYgKFxuICAgIEVSUk9SX0NPTE9OX1JFLnRlc3QoZmFpbHVyZU1lc3NhZ2UpIHx8XG4gICAgZmFpbHVyZU1lc3NhZ2UuaW5jbHVkZXMoXCJhdCBPYmplY3QuXCIpIHx8XG4gICAgZmFpbHVyZU1lc3NhZ2UuaW5jbHVkZXMoXCJhdCBNb2R1bGUuXCIpIHx8XG4gICAgZmFpbHVyZU1lc3NhZ2UuaW5jbHVkZXMoXCJFTk9FTlRcIikgfHxcbiAgICBmYWlsdXJlTWVzc2FnZS5pbmNsdWRlcyhcIlNJR0FCUlRcIilcbiAgKSB7XG4gICAgcmV0dXJuIFwiaW50ZXJuYWxfZXJyb3JcIjtcbiAgfVxuXG4gIHJldHVybiBcInVua25vd25cIjtcbn1cblxuLyoqXG4gKiBUcnVlIHdoZW4gdGhlIG1lc3NhZ2UgY2FycmllcyB0aGUgd29ya2VyIHdhdGNoZG9nJ3Mgb3duIGV2aWRlbmNlIGxpbmVcbiAqIChgV2F0Y2hkb2c6IGhhcmQtdGltZW91dGAgLyBgV2F0Y2hkb2c6IG5vLW91dHB1dGAgLyBgV2F0Y2hkb2c6IGNhbGwtc3Rvcm1gLFxuICogd3JpdHRlbiBieSBgZm9ybWF0RGV0YWlsZWRGYWlsdXJlTWVzc2FnZWAgZm9yIGEgcnVuIHRoZSB3b3JrZXIgc3RvcHBlZCkuXG4gKiBTdWNoIGEgcnVuIHdhcyBlbmRlZCBieSB0aGUgd29ya2VyLCBzbyBhbnkgc2lnbmFsIG5hbWVkIGluIGl0cyByYXctZXhpdFxuICogZGlhZ25vc3RpY3MgaXMgdGhlIHdhdGNoZG9nJ3MgZG9pbmcsIG5vdCBhbiBleHRlcm5hbCBraWxsIChWaWJlQ29kZXIjMTc0KS5cbiAqXG4gKiBgY2FsbC1zdG9ybWAgam9pbnMgdGhlIGxpc3Qgd2l0aCBJc3N1ZSAjMjIzMDogdGhlIGd1YXJkIFNJR1RFUk1zIHRoZSBhZ2VudFxuICogZXhhY3RseSBhcyB0aGUgb3RoZXIgdHdvIGRvLCBzbyB3aXRob3V0IGl0IGEgc3RvcHBlZCBjYWxsIHN0b3JtIHJlYWQgYXMgYW5cbiAqIGV4dGVybmFsIGBraWxsZWRgIOKAlCBpbmZyYXN0cnVjdHVyZSDigJQgYW5kIHdhcyByZXRyaWVkIGluIHByb2Nlc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3YXRjaGRvZ0ZpcmVkSW4oZmFpbHVyZU1lc3NhZ2U6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gL1xcYldhdGNoZG9nOiAoPzpoYXJkLXRpbWVvdXR8bm8tb3V0cHV0fGNhbGwtc3Rvcm0pXFxiLy50ZXN0KFxuICAgIGZhaWx1cmVNZXNzYWdlLFxuICApO1xufVxuXG4vKipcbiAqIE1hcmtlciB0aGUgZXhlY3V0ZSBwaGFzZSBwdXRzIGluIGEgdGltZW91dCByZWFzb24gd2hlbiB0aGUgcnVuJ3MgYnVkZ2V0IHdhc1xuICogYm91bmQgYnkgdGhlIGN5Y2xlIGRlYWRsaW5lIHJhdGhlciB0aGFuIGBjbGF1ZGVfdGltZW91dGAgKFZpYmVDb2RlciMxNzQpLlxuICogQSBkZWFkbGluZS1ib3VuZCB0aW1lb3V0IGlzIHRoZSBjeWNsZSBlbmRpbmcsIG5vdCB0aGUgaXNzdWUgZGVmZWF0aW5nIGEgZnVsbFxuICogYnVkZ2V0LCBzbyBpdCBtdXN0IG5vdCBmZWVkIHRoZSBlc2NhbGF0aW5nIHRpbWVvdXQgY29vbGRvd24gKElzc3VlICM0MzA0KVxuICog4oCUIHRoZSBuZXh0IGN5Y2xlIHNob3VsZCBzaW1wbHkgcmVzdW1lIHRoZSBwcmVzZXJ2ZWQgV0lQLlxuICovXG5leHBvcnQgY29uc3QgREVBRExJTkVfQk9VTkRfVElNRU9VVF9NQVJLRVIgPSBcImF0IHRoZSBjeWNsZSBkZWFkbGluZVwiO1xuXG4vKipcbiAqIERvZXMgdGhpcyBmYWlsdXJlIHJlYXNvbiBkZXNjcmliZSBhIHRpbWVvdXQtY2xhc3MgZmFpbHVyZSBmb3IgdGhlXG4gKiBlc2NhbGF0aW5nIHJlLWNsYWltIGNvb2xkb3duIChJc3N1ZSAjNDMwNCk/IEEgcnVuIHRoYXQgYnVybmVkIGl0cyB3aG9sZVxuICogY29uZmlndXJlZCBidWRnZXQgYW5kIHByb2R1Y2VkIG5vdGhpbmcgZG9lczsgYSBkZWFkbGluZS1ib3VuZCB0aW1lb3V0XG4gKiAoVmliZUNvZGVyIzE3NCkgZG9lcyBub3QuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1RpbWVvdXRDbGFzc0ZhaWx1cmVSZWFzb24ocmVhc29uOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgLy8gQSBzY2hlZHVsZWQgcmVsZWFzZSBpcyBuZXZlciB0aW1lb3V0LWNsYXNzIChJc3N1ZSAjNDI0KTogdGhlIHJ1biB3YXNcbiAgLy8gc3RvcHBlZCBieSB0aGUgY3ljbGUgZW5kaW5nIG9yIHRoZSBoYXJkIGNhcCB3aXRoIGl0cyBXSVAgcHJlc2VydmVkLCBzb1xuICAvLyB0aGUgbmV4dCBjeWNsZSBzaG91bGQgcmVzdW1lIGl0IHJhdGhlciB0aGFuIHNlcnZlIGEgMiBoIGNvb2xkb3duLiBUaGVcbiAgLy8gZGlhZ25vc3RpY3MgaXQgY2FycmllcyBkbyBtZW50aW9uIHRoZSB0aW1lb3V0IGJ1ZGdldCwgaGVuY2UgdGhlIGNoZWNrXG4gIC8vIG11c3QgY29tZSBiZWZvcmUgdGhlIHBhdHRlcm4gYmVsb3cuXG4gIGlmIChyZWFzb24uaW5jbHVkZXMoU0NIRURVTEVEX1JFTEVBU0VfTUFSS0VSKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIS9cXGJ0aW0oPzplZFsgLV0/b3V0fGVvdXQpXFxiL2kudGVzdChyZWFzb24pKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiAhcmVhc29uLmluY2x1ZGVzKERFQURMSU5FX0JPVU5EX1RJTUVPVVRfTUFSS0VSKTtcbn1cblxuLyoqIEV2ZXJ5IHZhbGlkIHtAbGluayBGYWlsdXJlQ2F0ZWdvcnl9IHZhbHVlIOKAlCB0aGUgc291cmNlIG9mIHRydXRoIGZvciB7QGxpbmsgbm9ybWFsaXNlRmFpbHVyZUNhdGVnb3J5fS4gKi9cbmNvbnN0IFZBTElEX0ZBSUxVUkVfQ0FURUdPUklFUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQ8RmFpbHVyZUNhdGVnb3J5PihbXG4gIFwia2lsbGVkXCIsXG4gIFwidGltZW91dFwiLFxuICBcInJhdGVfbGltaXRcIixcbiAgXCJ6ZXJvX291dHB1dFwiLFxuICBcInF1YWxpdHlfY2hlY2tcIixcbiAgXCJwdXNoX2ZhaWx1cmVcIixcbiAgXCJ0b2tlbl9zY29wZVwiLFxuICBcIm5vX2NoYW5nZXNcIixcbiAgXCJldmlkZW5jZV9taXNzaW5nXCIsXG4gIFwiaW50ZXJuYWxfZXJyb3JcIixcbiAgXCJtaXNzaW5nX3Rvb2xzXCIsXG4gIFwiaW50ZXJydXB0ZWRcIixcbiAgXCJzY2hlZHVsZWRfcmVsZWFzZVwiLFxuICBcIndvcmtmbG93X2dhdGVcIixcbiAgXCJyZXBvX2NvbmZpZ1wiLFxuICBcInByb21wdF90b29fbG9uZ1wiLFxuICBcImNsb25lX2NvcnJ1cHRcIixcbiAgXCJzdW1tYXJ5X2luY29tcGxldGVcIixcbiAgXCJzZWN1cml0eV9maXhfZ2F0ZVwiLFxuICBcInByZV9wdXNoX2dhdGVcIixcbiAgXCJjcml0ZXJpYV91bm1ldFwiLFxuICBcInVua25vd25cIixcbl0pO1xuXG4vKipcbiAqIE5vcm1hbGlzZSBhbiBhcmJpdHJhcnkgc3RyaW5nIGludG8gYSBrbm93biB7QGxpbmsgRmFpbHVyZUNhdGVnb3J5fS5cbiAqXG4gKiBDYWxsZXJzIHRoYXQgcmVjZWl2ZSBhbiB1bi12YWxpZGF0ZWQgY2F0ZWdvcnkgc3RyaW5nIChlLmcuIGEgQ0xJIGFyZ3VtZW50KVxuICogbXVzdCBwYXNzIGl0IHRocm91Z2ggaGVyZSBiZWZvcmUgaGFuZGluZyBpdCB0byB0aGUgbm93LWV4aGF1c3RpdmVcbiAqIHtAbGluayBnZXRGYWlsdXJlRGlhZ25vc2lzfSAvIHtAbGluayBnZXRGYWlsdXJlRGlhZ25vc2lzT25lbGluZXJ9LiBBbnkgdmFsdWVcbiAqIG91dHNpZGUgdGhlIHVuaW9uIG1hcHMgdG8gYFwidW5rbm93blwiYCwgcHJlc2VydmluZyB0aGUgcHJldmlvdXMgZ3JhY2VmdWxcbiAqIGZhbGxiYWNrIHJhdGhlciB0aGFuIHRocm93aW5nIChJc3N1ZSAjMjc5NCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpc2VGYWlsdXJlQ2F0ZWdvcnkodmFsdWU6IHN0cmluZyk6IEZhaWx1cmVDYXRlZ29yeSB7XG4gIHJldHVybiBWQUxJRF9GQUlMVVJFX0NBVEVHT1JJRVMuaGFzKHZhbHVlKVxuICAgID8gdmFsdWUgYXMgRmFpbHVyZUNhdGVnb3J5XG4gICAgOiBcInVua25vd25cIjtcbn1cblxuLyoqXG4gKiBDaGVjayBpZiBhIGZhaWx1cmUgY2F0ZWdvcnkgaXMgYW4gaW5mcmFzdHJ1Y3R1cmUvdHJhbnNpZW50IGlzc3VlLlxuICpcbiAqIEluZnJhc3RydWN0dXJlIGZhaWx1cmVzIGFyZSBjYXVzZWQgYnkgZW52aXJvbm1lbnQvdG9vbGluZyBwcm9ibGVtcywgTk9UIGJ5XG4gKiB0aGUgaXNzdWUgYmVpbmcgdG9vIGhhcmQgb3IgdW5jbGVhci4gVGhlc2Ugc2hvdWxkIGJlIHJldHJpZWQgbW9yZSBhZ2dyZXNzaXZlbHlcbiAqIHJhdGhlciB0aGFuIHBlcm1hbmVudGx5IGZhaWxpbmcgdGhlIGlzc3VlLlxuICpcbiAqIElzc3VlICMzODcg4oCUIFNlbGYtaGVhbGluZyBmb3IgdHJhbnNpZW50IGluZnJhc3RydWN0dXJlIGZhaWx1cmVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNJbmZyYXN0cnVjdHVyZUZhaWx1cmUoY2F0ZWdvcnk6IEZhaWx1cmVDYXRlZ29yeSk6IGJvb2xlYW4ge1xuICBzd2l0Y2ggKGNhdGVnb3J5KSB7XG4gICAgY2FzZSBcInplcm9fb3V0cHV0XCI6XG4gICAgY2FzZSBcInJhdGVfbGltaXRcIjpcbiAgICBjYXNlIFwiaW50ZXJuYWxfZXJyb3JcIjpcbiAgICBjYXNlIFwicHVzaF9mYWlsdXJlXCI6XG4gICAgY2FzZSBcIm1pc3NpbmdfdG9vbHNcIjpcbiAgICAvLyBBIGhvc3QgY3JlZGVudGlhbCB3aXRob3V0IGEgc2NvcGUgaXMgdGhlIGVudmlyb25tZW50LCBub3QgdGhlIGlzc3VlXG4gICAgLy8gKElzc3VlICMxNDc1KTogcmVsZWFzZSBpdCBmb3IgYSBob3N0IHdob3NlIHRva2VuIGNhbiBwdXNoIGl0LlxuICAgIGNhc2UgXCJ0b2tlbl9zY29wZVwiOlxuICAgIC8vIEEgcnVuIGN1dCBvZmYgYmVmb3JlIGZpbmlzaGluZyBpcyB0cmFuc2llbnQg4oCUIHJldHJ5LCBkbyBub3QgYmxhbWUgdGhlXG4gICAgLy8gaXNzdWUgb3IgZXNjYWxhdGUgaXQgdG8gYSBodW1hbiAoSXNzdWUgIzEwOCkuXG4gICAgY2FzZSBcImludGVycnVwdGVkXCI6XG4gICAgLy8gQSBraWxsIChTSUdLSUxMLCB0eXBpY2FsbHkgdGhlIFZNJ3MgT09NIGtpbGxlciB1bmRlciB0cmFuc2llbnQgbWVtb3J5XG4gICAgLy8gcHJlc3N1cmUpIGlzIGFuIGVudmlyb25tZW50IGZhaWx1cmUsIG5vdCBhIHByb3BlcnR5IG9mIHRoZSBpc3N1ZSDigJRcbiAgICAvLyBvbmUgYm91bmRlZCByZXRyeSBpcyBhbGxvd2VkIChJc3N1ZSAjNDIwMikuXG4gICAgY2FzZSBcImtpbGxlZFwiOlxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgLy8gQSBzY2hlZHVsZWQgcmVsZWFzZSBpcyBOT1QgaW5mcmFzdHJ1Y3R1cmUgKElzc3VlICM0MjQpLiBUaGVcbiAgICAvLyBpbmZyYXN0cnVjdHVyZSBhcm0gZXhpc3RzIHRvIHRyaWdnZXIgdGhlIGJvdW5kZWQgaW4tcHJvY2VzcyByZXRyeVxuICAgIC8vICgjMTU1MCkgYW5kIHRoZSBzZWxmLWhlYWxpbmcgcmUtYXR0ZW1wdCwgYW5kIGEgcnVuIHJlbGVhc2VkIGJlY2F1c2VcbiAgICAvLyB0aGUgY3ljbGUgZW5kZWQgb3IgdGhlIGhhcmQgY2FwIHdhcyByZWFjaGVkIGhhcyBubyBydW53YXkgbGVmdCB0b1xuICAgIC8vIHJldHJ5IGludG8g4oCUIHRoZSBuZXh0IGNsYWltIHJlc3VtZXMgdGhlIHByZXNlcnZlZCBXSVAgaW5zdGVhZC5cbiAgICBjYXNlIFwic2NoZWR1bGVkX3JlbGVhc2VcIjpcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICAvLyBBIHJlcG9zaXRvcnkgcmVmdXNpbmcgdGhlIG1pbGVzdG9uZSBicmFuY2ggaXMgbm90IGluZnJhc3RydWN0dXJlXG4gICAgLy8gZWl0aGVyIChJc3N1ZSAjMjIyMCkuIFRoZSBpbmZyYXN0cnVjdHVyZSBhcm0gZXhpc3RzIHRvIHJldHJ5IGFcbiAgICAvLyB0cmFuc2llbnQgZmF1bHQ7IHRoaXMgb25lIGlzIGEgcGVyc2lzdGVkIHJlcG9zaXRvcnkgc2V0dGluZywgc28gdGhlXG4gICAgLy8gYm91bmRlZCByZXRyeSBjb3VsZCBvbmx5IGJ1cm4gZml2ZSBjbGFpbXMgb24gYSByZWZ1c2FsIHRoYXQgd2lsbCBiZVxuICAgIC8vIGlkZW50aWNhbCBldmVyeSB0aW1lLiBgaGFuZGxlSXNzdWVGYWlsdXJlYCBzaG9ydC1jaXJjdWl0cyBpdCBiZWZvcmVcbiAgICAvLyB0aGUgbGFkZGVyIGlzIHJlYWNoZWQuXG4gICAgY2FzZSBcInJlcG9fY29uZmlnXCI6XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgLy8gTm90IGluZnJhc3RydWN0dXJlIChJc3N1ZSAjMjY4Mik6IHRoZSBvbmUgdW5jb3VudGVkIGZyZXNoLXNlc3Npb24gcmV0cnlcbiAgICAvLyBoYXMgYWxyZWFkeSBiZWVuIHNwZW50IGJ5IHRoZSB0aW1lIHRoaXMgY2F0ZWdvcnkgaXMgcmVjb3JkZWQsIHNvIGFcbiAgICAvLyBzZWNvbmQgaW4tcHJvY2VzcyByZXRyeSB3b3VsZCBvbmx5IHJlc2VuZCB0aGUgc2FtZSBvdmVyc2l6ZWQgcHJvbXB0LlxuICAgIGNhc2UgXCJwcm9tcHRfdG9vX2xvbmdcIjpcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICAvLyBOb3QgaW5mcmFzdHJ1Y3R1cmUgKElzc3VlICMyODg0KTogYW4gaW4tcHJvY2VzcyByZXRyeSB3b3VsZCBydW5cbiAgICAvLyBhZ2FpbnN0IHRoZSBzYW1lIGRhbWFnZWQgY2xvbmUgYW5kIGZhaWwgaWRlbnRpY2FsbHkg4oCUIHRoZSBzZXR1cCBwaGFzZVxuICAgIC8vIGFscmVhZHkgcmVwYWlyZWQgaXQgb25jZSBiZWZvcmUgZ2l2aW5nIHVwLCBzbyBhIGJvdW5kZWQgcmV0cnkgaGVyZSBjYW5cbiAgICAvLyBvbmx5IGJ1cm4gY2xhaW1zIG9uIGEgZmF1bHQgbm8gaW4tcHJvY2VzcyBhdHRlbXB0IGNhbiBjbGVhci5cbiAgICBjYXNlIFwiY2xvbmVfY29ycnVwdFwiOlxuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIC8vIE5vdCBpbmZyYXN0cnVjdHVyZSAoSXNzdWUgIzM0MzEpOiB0aGUgYWdlbnQncyBzdW1tYXJ5IGZlbGwgc2hvcnQgb2YgdGhlXG4gICAgLy8gY29tcGxldGlvbiBnYXRlczsgcmV0cnlpbmcgaXMgZ292ZXJuZWQgYnkgdGhlIG5vcm1hbCByZXRyeSBydWxlcy5cbiAgICBjYXNlIFwic3VtbWFyeV9pbmNvbXBsZXRlXCI6XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgLy8gTm90IGluZnJhc3RydWN0dXJlIChJc3N1ZSAjMzQ1NCk6IHRoZSBhZ2VudCBkaWQgbm90IGRlbGl2ZXIgdGhlXG4gICAgLy8gc2VjdXJpdHktZml4IGV2aWRlbmNlOyByZXRyeWluZyBpcyBnb3Zlcm5lZCBieSB0aGUgbm9ybWFsIHJldHJ5IHJ1bGVzLlxuICAgIGNhc2UgXCJzZWN1cml0eV9maXhfZ2F0ZVwiOlxuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIC8vIE5vdCBpbmZyYXN0cnVjdHVyZSAoUFIgIzM3MTYgcmV2aWV3KTogdGhlIGJyYW5jaCBpdHNlbGYgZmFpbGVkIHRoZVxuICAgIC8vIGNoZWNrczsgYSByZXRyeSBvZiB0aGUgc2FtZSBjb250ZW50IHdvdWxkIGJlIGJsb2NrZWQgaWRlbnRpY2FsbHkuXG4gICAgY2FzZSBcInByZV9wdXNoX2dhdGVcIjpcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICAvLyBOb3QgaW5mcmFzdHJ1Y3R1cmUgKElzc3VlICM0MTQ2KTogdGhlIHJ1biBhbHJlYWR5IHNwZW50IGl0cyBpbi1ydW5cbiAgICAvLyByb3VuZHMgb24gdGhlIHVubWV0IGNyaXRlcmlhOyB0aGUgbmV4dCBydW4gcmVzdW1lcyB0aGUgYnJhbmNoLlxuICAgIGNhc2UgXCJjcml0ZXJpYV91bm1ldFwiOlxuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqXG4gKiBNYXAgaW50ZXJuYWwgY2F0ZWdvcnkgdG8gdXNlci1mYWNpbmcgZGlzcGxheSBuYW1lLlxuICpcbiAqIENvbnZlcnRzIGludGVybmFsIGNhdGVnb3J5IGlkZW50aWZpZXJzIChlLmcuIHplcm9fb3V0cHV0KSB0byBodW1hbi1yZWFkYWJsZVxuICogZGlzcGxheSBuYW1lcyAoZS5nLiBuby1vdXRwdXQpIGZvciB1c2UgaW4gZmFpbHVyZSBjb21tZW50IGNhdGVnb3J5IHRhZ3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRGYWlsdXJlQ2F0ZWdvcnlEaXNwbGF5KFxuICBjYXRlZ29yeTogRmFpbHVyZUNhdGVnb3J5LFxuKTogQ2F0ZWdvcnlEaXNwbGF5IHtcbiAgc3dpdGNoIChjYXRlZ29yeSkge1xuICAgIGNhc2UgXCJ0aW1lb3V0XCI6XG4gICAgICByZXR1cm4gXCJ0aW1lb3V0XCI7XG4gICAgY2FzZSBcInJhdGVfbGltaXRcIjpcbiAgICAgIHJldHVybiBcInJhdGUtbGltaXRcIjtcbiAgICBjYXNlIFwiemVyb19vdXRwdXRcIjpcbiAgICAgIHJldHVybiBcIm5vLW91dHB1dFwiO1xuICAgIGNhc2UgXCJraWxsZWRcIjpcbiAgICAgIHJldHVybiBcImtpbGxlZFwiO1xuICAgIGNhc2UgXCJxdWFsaXR5X2NoZWNrXCI6XG4gICAgICByZXR1cm4gXCJxdWFsaXR5LWZhaWx1cmVcIjtcbiAgICBjYXNlIFwibWlzc2luZ190b29sc1wiOlxuICAgICAgcmV0dXJuIFwibWlzc2luZy10b29sc1wiO1xuICAgIGNhc2UgXCJ0b2tlbl9zY29wZVwiOlxuICAgICAgcmV0dXJuIFwidG9rZW4tc2NvcGVcIjtcbiAgICBjYXNlIFwid29ya2Zsb3dfZ2F0ZVwiOlxuICAgICAgcmV0dXJuIFwid29ya2Zsb3ctZ2F0ZVwiO1xuICAgIGNhc2UgXCJwdXNoX2ZhaWx1cmVcIjpcbiAgICBjYXNlIFwiZXZpZGVuY2VfbWlzc2luZ1wiOlxuICAgIGNhc2UgXCJpbnRlcm5hbF9lcnJvclwiOlxuICAgIGNhc2UgXCJpbnRlcnJ1cHRlZFwiOlxuICAgICAgcmV0dXJuIFwiaW5mcmFzdHJ1Y3R1cmUtZXJyb3JcIjtcbiAgICBjYXNlIFwibm9fY2hhbmdlc1wiOlxuICAgICAgcmV0dXJuIFwidGFzay1ub3QtdW5kZXJzdG9vZFwiO1xuICAgIGNhc2UgXCJzY2hlZHVsZWRfcmVsZWFzZVwiOlxuICAgICAgcmV0dXJuIFwic2NoZWR1bGVkLXJlbGVhc2VcIjtcbiAgICBjYXNlIFwicmVwb19jb25maWdcIjpcbiAgICAgIHJldHVybiBcInJlcG8tY29uZmlnXCI7XG4gICAgY2FzZSBcInByb21wdF90b29fbG9uZ1wiOlxuICAgICAgcmV0dXJuIFwicHJvbXB0LXRvby1sb25nXCI7XG4gICAgY2FzZSBcImNsb25lX2NvcnJ1cHRcIjpcbiAgICAgIHJldHVybiBcImNsb25lLWNvcnJ1cHRcIjtcbiAgICBjYXNlIFwic3VtbWFyeV9pbmNvbXBsZXRlXCI6XG4gICAgICByZXR1cm4gXCJzdW1tYXJ5LWluY29tcGxldGVcIjtcbiAgICBjYXNlIFwic2VjdXJpdHlfZml4X2dhdGVcIjpcbiAgICAgIHJldHVybiBcInNlY3VyaXR5LWZpeC1nYXRlXCI7XG4gICAgY2FzZSBcInByZV9wdXNoX2dhdGVcIjpcbiAgICAgIHJldHVybiBcInByZS1wdXNoLWdhdGVcIjtcbiAgICBjYXNlIFwiY3JpdGVyaWFfdW5tZXRcIjpcbiAgICAgIHJldHVybiBcImNyaXRlcmlhLXVubWV0XCI7XG4gICAgY2FzZSBcInVua25vd25cIjpcbiAgICAgIHJldHVybiBcInVua25vd25cIjtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIGFzc2VydE5ldmVyKGNhdGVnb3J5KTtcbiAgfVxufVxuXG4vKipcbiAqIENoZWNrIGlmIGNsYXJpdHkgd2FzIGFzc2Vzc2VkIG9yIHNraXBwZWQgKGkuZS4gbm90IFwibm90X2Fzc2Vzc2VkXCIpLlxuICpcbiAqIFJldHVybnMgdHJ1ZSBpZiBjbGFyaXR5IHdhcyBhc3Nlc3NlZCBhcyBDTEVBUiBvciBza2lwcGVkIChtZWFuaW5nIHRoZVxuICogXCJtYXkgbmVlZCBtb3JlIGRldGFpbFwiIHN1Z2dlc3Rpb24gaXMgaW5hcHByb3ByaWF0ZSkuXG4gKi9cbmZ1bmN0aW9uIGNsYXJpdHlXYXNBc3Nlc3NlZChjbGFyaXR5U3RhdHVzOiBDbGFyaXR5U3RhdHVzKTogYm9vbGVhbiB7XG4gIHJldHVybiBjbGFyaXR5U3RhdHVzID09PSBcImFzc2Vzc2VkX2NsZWFyXCIgfHwgY2xhcml0eVN0YXR1cyA9PT0gXCJza2lwcGVkXCI7XG59XG5cbi8qKlxuICogUGFyc2Ugc2VtaWNvbG9uLXNlcGFyYXRlZCBrZXk9dmFsdWUgZGlhZ25vc3RpYyBjb250ZXh0IHN0cmluZy5cbiAqXG4gKiBJc3N1ZSAjNTMzIOKAlCBFbWJlZCBkaWFnbm9zdGljIGNvbnRleHQgaW4gemVyby1vdXRwdXQgZmFpbHVyZSBjb21tZW50cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlRGlhZ25vc3RpY0NvbnRleHQoY29udGV4dFN0cjogc3RyaW5nKTogRGlhZ25vc3RpY0NvbnRleHQge1xuICBjb25zdCByZXN1bHQ6IERpYWdub3N0aWNDb250ZXh0ID0ge307XG4gIGlmICghY29udGV4dFN0cikgcmV0dXJuIHJlc3VsdDtcblxuICBmb3IgKGNvbnN0IHBhaXIgb2YgY29udGV4dFN0ci5zcGxpdChcIjtcIikpIHtcbiAgICBjb25zdCBlcUlkeCA9IHBhaXIuaW5kZXhPZihcIj1cIik7XG4gICAgaWYgKGVxSWR4IDwgMCkgY29udGludWU7XG4gICAgY29uc3Qga2V5ID0gcGFpci5zdWJzdHJpbmcoMCwgZXFJZHgpO1xuICAgIGNvbnN0IHZhbHVlID0gcGFpci5zdWJzdHJpbmcoZXFJZHggKyAxKTtcbiAgICBzd2l0Y2ggKGtleSkge1xuICAgICAgY2FzZSBcImhlYWx0aF9jaGVja1wiOlxuICAgICAgICByZXN1bHQuaGVhbHRoQ2hlY2sgPSB2YWx1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiY2xhcml0eVwiOlxuICAgICAgICByZXN1bHQuY2xhcml0eSA9IHZhbHVlO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJlbGFwc2VkX3NlY29uZHNcIjpcbiAgICAgICAgcmVzdWx0LmVsYXBzZWRTZWNvbmRzID0gdmFsdWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm5vX291dHB1dF90aW1lb3V0XCI6XG4gICAgICAgIHJlc3VsdC5ub091dHB1dFRpbWVvdXQgPSB2YWx1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiY2xhdWRlX3RpbWVvdXRcIjpcbiAgICAgICAgcmVzdWx0LmNsYXVkZVRpbWVvdXQgPSB2YWx1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwicmV0cnlfY291bnRcIjpcbiAgICAgICAgcmVzdWx0LnJldHJ5Q291bnQgPSB2YWx1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibWF4X3JldHJpZXNcIjpcbiAgICAgICAgcmVzdWx0Lm1heFJldHJpZXMgPSB2YWx1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICAvLyBFeHRlbnNpb24gaGlzdG9yeSAoSXNzdWUgIzQyOTgpLlxuICAgICAgY2FzZSBcImV4dGVuc2lvbnNfZ3JhbnRlZFwiOlxuICAgICAgICByZXN1bHQuZXh0ZW5zaW9uc0dyYW50ZWQgPSB2YWx1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiZXh0ZW5kZWRfc2Vjb25kc1wiOlxuICAgICAgICByZXN1bHQuZXh0ZW5kZWRTZWNvbmRzID0gdmFsdWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImZpbmFsX2RlYWRsaW5lX3NlY29uZHNcIjpcbiAgICAgICAgcmVzdWx0LmZpbmFsRGVhZGxpbmVTZWNvbmRzID0gdmFsdWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImV4dGVuc2lvbl9yZWZ1c2VkXCI6XG4gICAgICAgIHJlc3VsdC5leHRlbnNpb25SZWZ1c2VkID0gdmFsdWU7XG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIEZvcm1hdCBkaWFnbm9zdGljIGNvbnRleHQgZm9yIHplcm8tb3V0cHV0IGZhaWx1cmVzLlxuICpcbiAqIFJldHVybnMgaHVtYW4tcmVhZGFibGUgZGlhZ25vc3RpYyBsaW5lcyBmb3IgaW5jbHVzaW9uIGluIGZhaWx1cmUgY29tbWVudHMuXG4gKlxuICogSXNzdWUgIzUzMyDigJQgRW1iZWQgZGlhZ25vc3RpYyBjb250ZXh0IGluIHplcm8tb3V0cHV0IGZhaWx1cmUgY29tbWVudHMuXG4gKi9cbi8qKlxuICogUmVuZGVyIHRoZSByZS1hcm1hYmxlIGRlYWRsaW5lJ3MgaGlzdG9yeSBmb3IgdGhlIGRpYWdub3NpcyAoSXNzdWUgIzQyOTgpLlxuICpcbiAqIFJldHVybnMgYFwiXCJgIHdoZW4gdGhlIHJ1biBjYXJyaWVkIG5vIGV4dGVuc2lvbiB0ZWxlbWV0cnksIHNvIGEgcnVuIHdpdGggdGhlXG4gKiBmZWF0dXJlIGRpc2FibGVkIHByb2R1Y2VzIHRoZSBwcmUtIzQyOTAgd29yZGluZyBieXRlIGZvciBieXRlLlxuICovXG5mdW5jdGlvbiBmb3JtYXRFeHRlbnNpb25IaXN0b3J5KGN0eDogRGlhZ25vc3RpY0NvbnRleHQpOiBzdHJpbmcge1xuICBpZiAoY3R4LmV4dGVuc2lvbnNHcmFudGVkID09PSB1bmRlZmluZWQpIHJldHVybiBcIlwiO1xuICBjb25zdCBncmFudGVkID0gTnVtYmVyKGN0eC5leHRlbnNpb25zR3JhbnRlZCk7XG4gIGNvbnN0IGhpc3RvcnkgPSBOdW1iZXIuaXNGaW5pdGUoZ3JhbnRlZCkgJiYgZ3JhbnRlZCA+IDBcbiAgICA/IGAsIGV4dGVuZGVkICR7Z3JhbnRlZH3DlyBieSAke2N0eC5leHRlbmRlZFNlY29uZHMgPz8gXCI/XCJ9cyB0byBhIGZpbmFsIGAgK1xuICAgICAgYGRlYWRsaW5lIG9mICR7Y3R4LmZpbmFsRGVhZGxpbmVTZWNvbmRzID8/IFwiP1wifXNgXG4gICAgOiBcIiwgbm8gZXh0ZW5zaW9uIGdyYW50ZWRcIjtcbiAgcmV0dXJuIGN0eC5leHRlbnNpb25SZWZ1c2VkXG4gICAgPyBgJHtoaXN0b3J5fTsgbGFzdCBleHRlbnNpb24gcmVmdXNlZDogJHtjdHguZXh0ZW5zaW9uUmVmdXNlZH1gXG4gICAgOiBoaXN0b3J5O1xufVxuXG4vKipcbiAqIERlY29kZSB0aGUgZXh0ZW5zaW9uIHRlbGVtZXRyeSBhIHRpbWVvdXQgZGlhZ25vc2lzIHNob3VsZCBzdGF0ZSAoSXNzdWVcbiAqICM3NjgpIGZyb20gdGhlIGBrZXk9dmFsdWVgIGRpYWdub3N0aWMgY29udGV4dCwgd2hpY2ggaXMgdGhlIG9ubHkgZm9ybSB0aGVcbiAqIG11bHRpLWxpbmUgZGlhZ25vc2lzJyBjYWxsZXJzIGhvbGQuXG4gKlxuICogRXZlcnkgZmlndXJlIG11c3QgcGFyc2UuIGBidWlsZERpYWdub3N0aWNDb250ZXh0YCB3cml0ZXMgdGhlbSBhcyBvbmUgc2V0LFxuICogc28gYSBwYXJ0aWFsIG9yIHVucmVhZGFibGUgc2V0IGlzIG5vdCBhIHJ1biB3aXRob3V0IGV4dGVuc2lvbnMg4oCUIGFuZFxuICogcmVuZGVyaW5nIGEgbWlzc2luZyBmaWd1cmUgYXMgYDBzYCB3b3VsZCBwdXQgYSBtZWFzdXJlZC1sb29raW5nIGxpZSBpbiBhblxuICogb3BlcmF0b3IgYXJ0ZWZhY3QuIFN1Y2ggYSBjb250ZXh0IHlpZWxkcyBgdW5kZWZpbmVkYCwgd2hpY2ggc3RhdGVzIG5vdGhpbmdcbiAqIGFib3V0IGV4dGVuc2lvbnMgcmF0aGVyIHRoYW4gc3RhdGluZyBzb21ldGhpbmcgZmFsc2UuXG4gKlxuICogYHVuZGVmaW5lZGAgdGhlcmVmb3JlIGNvdmVycyBib3RoIFwidGhlIGZlYXR1cmUgd2FzIG5vdCBhY3RpdmVcIiBhbmQgXCJ0aGVcbiAqIGNvbnRleHQgZGlkIG5vdCBjYXJyeSBhIHJlYWRhYmxlIHNuYXBzaG90XCIsIGFuZCBpbiBlYWNoIGNhc2UgdGhlIHdvcmRpbmdcbiAqIHN0YXlzIHRoZSBwcmUtIzc2NCB0ZXh0IGJ5dGUgZm9yIGJ5dGUuXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVFeHRlbnNpb25UZWxlbWV0cnkoXG4gIGRpYWdub3N0aWNDb250ZXh0OiBzdHJpbmcsXG4pOiBFeHRlbnNpb25UZWxlbWV0cnkgfCB1bmRlZmluZWQge1xuICBpZiAoIWRpYWdub3N0aWNDb250ZXh0KSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBjdHggPSBwYXJzZURpYWdub3N0aWNDb250ZXh0KGRpYWdub3N0aWNDb250ZXh0KTtcbiAgY29uc3Qgc2Vjb25kcyA9ICh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogbnVtYmVyIHwgdW5kZWZpbmVkID0+IHtcbiAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZS50cmltKCkgPT09IFwiXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3QgcGFyc2VkID0gTnVtYmVyKHZhbHVlKTtcbiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHBhcnNlZCkgPyBwYXJzZWQgOiB1bmRlZmluZWQ7XG4gIH07XG4gIGNvbnN0IGdyYW50ZWQgPSBzZWNvbmRzKGN0eC5leHRlbnNpb25zR3JhbnRlZCk7XG4gIGNvbnN0IGV4dGVuZGVkU2Vjb25kcyA9IHNlY29uZHMoY3R4LmV4dGVuZGVkU2Vjb25kcyk7XG4gIGNvbnN0IGJhc2VUaW1lb3V0U2Vjb25kcyA9IHNlY29uZHMoY3R4LmNsYXVkZVRpbWVvdXQpO1xuICBjb25zdCBmaW5hbERlYWRsaW5lU2Vjb25kcyA9IHNlY29uZHMoY3R4LmZpbmFsRGVhZGxpbmVTZWNvbmRzKTtcbiAgY29uc3QgZWxhcHNlZFNlY29uZHMgPSBzZWNvbmRzKGN0eC5lbGFwc2VkU2Vjb25kcyk7XG4gIGlmIChcbiAgICBncmFudGVkID09PSB1bmRlZmluZWQgfHwgZXh0ZW5kZWRTZWNvbmRzID09PSB1bmRlZmluZWQgfHxcbiAgICBiYXNlVGltZW91dFNlY29uZHMgPT09IHVuZGVmaW5lZCB8fCBmaW5hbERlYWRsaW5lU2Vjb25kcyA9PT0gdW5kZWZpbmVkIHx8XG4gICAgZWxhcHNlZFNlY29uZHMgPT09IHVuZGVmaW5lZFxuICApIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIHJldHVybiB7XG4gICAgZ3JhbnRlZCxcbiAgICBleHRlbmRlZFNlY29uZHMsXG4gICAgYmFzZVRpbWVvdXRTZWNvbmRzLFxuICAgIGZpbmFsRGVhZGxpbmVTZWNvbmRzLFxuICAgIGVsYXBzZWRTZWNvbmRzLFxuICAgIC4uLihjdHguZXh0ZW5zaW9uUmVmdXNlZCA/IHsgcmVmdXNhbFJlYXNvbjogY3R4LmV4dGVuc2lvblJlZnVzZWQgfSA6IHt9KSxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFplcm9PdXRwdXREaWFnbm9zdGljcyhkaWFnbm9zdGljQ29udGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFkaWFnbm9zdGljQ29udGV4dCkgcmV0dXJuIFwiXCI7XG5cbiAgY29uc3QgY3R4ID0gcGFyc2VEaWFnbm9zdGljQ29udGV4dChkaWFnbm9zdGljQ29udGV4dCk7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIC8vIEZvcm1hdCBoZWFsdGggY2hlY2sgYW5kIGNsYXJpdHkgc3RhdHVzIGxpbmVcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGlmIChjdHguaGVhbHRoQ2hlY2spIHtcbiAgICBjb25zdCBoZWFsdGhEaXNwbGF5ID0gY3R4LmhlYWx0aENoZWNrID09PSBcInBhc3NlZFwiXG4gICAgICA/IFwicGFzc2VkIFxcdTI3MTNcIlxuICAgICAgOiBjdHguaGVhbHRoQ2hlY2s7XG4gICAgcGFydHMucHVzaChgSGVhbHRoIGNoZWNrOiAke2hlYWx0aERpc3BsYXl9YCk7XG4gIH1cbiAgaWYgKGN0eC5jbGFyaXR5KSB7XG4gICAgbGV0IGNsYXJpdHlEaXNwbGF5OiBzdHJpbmc7XG4gICAgc3dpdGNoIChjdHguY2xhcml0eSkge1xuICAgICAgY2FzZSBcImFzc2Vzc2VkX2NsZWFyXCI6XG4gICAgICAgIGNsYXJpdHlEaXNwbGF5ID0gXCJDTEVBUiBcXHUyNzEzXCI7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInNraXBwZWRcIjpcbiAgICAgICAgY2xhcml0eURpc3BsYXkgPSBcInNraXBwZWQgKHNpbXBsZSB0YXNrKVwiO1xuICAgICAgICBicmVhaztcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIGNsYXJpdHlEaXNwbGF5ID0gY3R4LmNsYXJpdHk7XG4gICAgfVxuICAgIHBhcnRzLnB1c2goYENsYXJpdHkgYXNzZXNzbWVudDogJHtjbGFyaXR5RGlzcGxheX1gKTtcbiAgfVxuICBpZiAocGFydHMubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goYC0gJHtwYXJ0cy5qb2luKFwiIHwgXCIpfWApO1xuICB9XG5cbiAgLy8gRm9ybWF0IHJ1bnRpbWUgbGluZVxuICBpZiAoY3R4LmVsYXBzZWRTZWNvbmRzKSB7XG4gICAgbGV0IHRpbWVvdXRJbmZvID0gXCJcIjtcbiAgICBpZiAoY3R4Lm5vT3V0cHV0VGltZW91dCAmJiBjdHguY2xhdWRlVGltZW91dCkge1xuICAgICAgLy8gRXhwbGFpbiB0aGUgZGVhZGxpbmUgdGhlIHJ1biBhY3R1YWxseSBkaWVkIG9uIChJc3N1ZSAjNDI5OCk6IHF1b3RpbmdcbiAgICAgIC8vIHRoZSBjb25maWd1cmVkIGBjbGF1ZGVUaW1lb3V0YCBhbG9uZSBpcyBhIGxpZSBvbmNlIHRoZSByZS1hcm1hYmxlXG4gICAgICAvLyBkZWFkbGluZSAoIzQyOTApIGhhcyBtb3ZlZCBpdC5cbiAgICAgIHRpbWVvdXRJbmZvID0gYCAobm8tb3V0cHV0IHRpbWVvdXQ6ICR7Y3R4Lm5vT3V0cHV0VGltZW91dH1zLCBoYXJkIGAgK1xuICAgICAgICBgdGltZW91dDogJHtjdHguY2xhdWRlVGltZW91dH1zJHtmb3JtYXRFeHRlbnNpb25IaXN0b3J5KGN0eCl9KWA7XG4gICAgfVxuICAgIGxpbmVzLnB1c2goXG4gICAgICBgLSBDbGF1ZGUgcmFuIGZvciAke2N0eC5lbGFwc2VkU2Vjb25kc31zIHdpdGggemVybyBvdXRwdXQgYmVmb3JlIGJlaW5nIHRlcm1pbmF0ZWQke3RpbWVvdXRJbmZvfWAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIEZvcm1hdCByZXRyeSBjb3VudCBsaW5lXG4gIGlmIChjdHgucmV0cnlDb3VudCAmJiBjdHgubWF4UmV0cmllcykge1xuICAgIGxpbmVzLnB1c2goXG4gICAgICBgLSBUaGlzIGhhcyBoYXBwZW5lZCAke2N0eC5yZXRyeUNvdW50fS8ke2N0eC5tYXhSZXRyaWVzfSB0aW1lcyBcXHUyMDE0IGxpa2VseSBhIHRyYW5zaWVudCBlbnZpcm9ubWVudCBpc3N1ZWAsXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIFJldHVybiBjYXRlZ29yeS1zcGVjaWZpYyBkaWFnbm9zaXMgdGV4dC5cbiAqXG4gKiBHaXZlbiBhIGZhaWx1cmUgY2F0ZWdvcnkgKGZyb20gZGV0ZWN0RmFpbHVyZUNhdGVnb3J5KSwgcmV0dXJucyBhXG4gKiBodW1hbi1yZWFkYWJsZSBkaWFnbm9zaXMgZXhwbGFpbmluZyB3aHkgdGhlIGZhaWx1cmUgbGlrZWx5IG9jY3VycmVkLlxuICpcbiAqIFdoZW4gY2xhcml0eVN0YXR1cyBpbmRpY2F0ZXMgdGhlIGlzc3VlIHdhcyBhbHJlYWR5IGFzc2Vzc2VkIGFzIENMRUFSIG9yXG4gKiBza2lwcGVkIChzaW1wbGUgaXNzdWUpLCBzdWdnZXN0aW9ucyBhYm91dCBuZWVkaW5nIFwibW9yZSBkZXRhaWxcIiBhcmUgb21pdHRlZFxuICogYmVjYXVzZSB0aGUgY2xhcml0eSBwaXBlbGluZSBhbHJlYWR5IHZhbGlkYXRlZCB0aGUgZGVzY3JpcHRpb24gKElzc3VlICM0MDApLlxuICpcbiAqIEZvciB6ZXJvX291dHB1dCBmYWlsdXJlcywgaWYgZGlhZ25vc3RpY0NvbnRleHQgaXMgcHJvdmlkZWQsIGl0IGlzIGZvcm1hdHRlZFxuICogaW50byBhY3Rpb25hYmxlIGRpYWdub3N0aWMgbGluZXMgaW5zdGVhZCBvZiBnZW5lcmljIGFkdmljZSAoSXNzdWUgIzUzMykuXG4gKlxuICogRm9yIHRpbWVvdXQgZmFpbHVyZXMgdGhlIGV4dGVuc2lvbiB0ZWxlbWV0cnkgdGhlIGRpYWdub3N0aWMgY29udGV4dCBjYXJyaWVzXG4gKiBhZGRzIHRoZSBsaW5lIHRoYXQgbWFrZXMgdGhlIGtpbGwgcmVhZGFibGUgKElzc3VlICM3NjgpLiBBYnNlbnQsIHRoZVxuICogd29yZGluZyBpcyB0aGUgcHJlLSM3NjQgdGV4dCBieXRlIGZvciBieXRlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0RmFpbHVyZURpYWdub3NpcyhcbiAgY2F0ZWdvcnk6IEZhaWx1cmVDYXRlZ29yeSxcbiAgY2xhcml0eVN0YXR1czogQ2xhcml0eVN0YXR1cyA9IFwibm90X2Fzc2Vzc2VkXCIsXG4gIGRpYWdub3N0aWNDb250ZXh0OiBzdHJpbmcgPSBcIlwiLFxuKTogc3RyaW5nIHtcbiAgc3dpdGNoIChjYXRlZ29yeSkge1xuICAgIGNhc2UgXCJ0aW1lb3V0XCI6IHtcbiAgICAgIGNvbnN0IHRlbGVtZXRyeSA9IHJlc29sdmVFeHRlbnNpb25UZWxlbWV0cnkoZGlhZ25vc3RpY0NvbnRleHQpO1xuICAgICAgY29uc3Qgc3VtbWFyeSA9IHRlbGVtZXRyeVxuICAgICAgICA/IGBcXG4tICR7Zm9ybWF0VGltZW91dEV4dGVuc2lvblN1bW1hcnkodGVsZW1ldHJ5KX1gXG4gICAgICAgIDogXCJcIjtcbiAgICAgIHJldHVybiBgLSBDbGF1ZGUgcmFuIG91dCBvZiB0aW1lIGJlZm9yZSBjb21wbGV0aW5nIHRoZSB0YXNrXG4tIFRoZSB0YXNrIG1heSBuZWVkIHRvIGJlIGJyb2tlbiBpbnRvIHNtYWxsZXIgcGllY2VzXG4tIENvbnNpZGVyIHNpbXBsaWZ5aW5nIHRoZSBpc3N1ZSBzY29wZSBvciBzcGxpdHRpbmcgaXQgaW50byBzdWItaXNzdWVzJHtzdW1tYXJ5fWA7XG4gICAgfVxuXG4gICAgY2FzZSBcInNjaGVkdWxlZF9yZWxlYXNlXCI6XG4gICAgICByZXR1cm4gYC0gVGhlIHJ1biB3YXMgcmVsZWFzZWQgb24gc2NoZWR1bGUg4oCUIHRoZSBjeWNsZSBlbmRlZCwgdGhlIGZpbmlzaCBkZWFkbGluZSB3YXMgcmVhY2hlZCwgb3IgdGhlIHN1cGVydmlzb3IncyBydW4gaGFyZCBjYXAgd2FzIHJlYWNoZWQg4oCUIHdoaWxlIHRoZSBhZ2VudCB3YXMgc3RpbGwgcHJvZ3Jlc3Npbmdcbi0gV0lQIHByZXNlcnZlZDogdGhlIHdvcmsgaW4gcHJvZ3Jlc3Mgd2FzIGNvbW1pdHRlZCBhbmQgcHVzaGVkIHRvIHRoZSBpc3N1ZSBicmFuY2gg4oCUIHRoZSBjbGFpbS1yZWxlYXNlIGNvbW1lbnQncyAqKldvcmsgaW4gcHJvZ3Jlc3MqKiBsaW5lIG5hbWVzIHRoYXQgYnJhbmNoIOKAlCBhbmQgdGhlIG5leHQgY2xhaW0gcmVzdW1lcyBmcm9tIHRoZXJlXG4tIE5vdGhpbmcgaGVyZSByZWZsZWN0cyBvbiB0aGUgaXNzdWU6IGl0IGRvZXMgbm90IG5lZWQgcmUtc2NvcGluZywgc2ltcGxpZnlpbmcgb3Igc3BsaXR0aW5nYDtcblxuICAgIGNhc2UgXCJyYXRlX2xpbWl0XCI6XG4gICAgICByZXR1cm4gYC0gQ2xhdWRlIHdhcyByYXRlLWxpbWl0ZWQgZHVyaW5nIHByb2Nlc3Npbmdcbi0gVGhpcyBpcyBhIHRyYW5zaWVudCBpbmZyYXN0cnVjdHVyZSBpc3N1ZSwgbm90IHJlbGF0ZWQgdG8gaXNzdWUgY29tcGxleGl0eVxuLSBUaGUgaXNzdWUgd2lsbCBiZSByZXRyaWVkIGF1dG9tYXRpY2FsbHkgb24gdGhlIG5leHQgc2NhbmA7XG5cbiAgICBjYXNlIFwia2lsbGVkXCI6XG4gICAgICByZXR1cm4gYC0gVGhlIGFnZW50IHByb2Nlc3Mgd2FzIGtpbGxlZCAoU0lHS0lMTCkgd2l0aG91dCBhbnkgd29ya2VyIHdhdGNoZG9nIGZpcmluZ1xuLSBUaGUgbW9zdCBjb21tb24gY2F1c2UgaXMgdGhlIFZNJ3Mgb3V0LW9mLW1lbW9yeSBraWxsZXIgdW5kZXIgbWVtb3J5IHByZXNzdXJlIOKAlCBhIFNJR0tJTExlZCBwcm9jZXNzIHByaW50cyBub3RoaW5nLCBzbyBubyBtZW1vcnkgZXZpZGVuY2UgYXBwZWFycyBpbiB0aGUgb3V0cHV0XG4tIFRoaXMgaXMgYW4gaW5mcmFzdHJ1Y3R1cmUgZmFpbHVyZSwgbm90IHJlbGF0ZWQgdG8gdGhlIGlzc3VlIGNvbnRlbnQ7IHRoZSB3b3JrZXIgcmV0cmllcyBvbmNlIGF1dG9tYXRpY2FsbHlcbi0gSWYgaXQgcmVjdXJzLCByYWlzZSB0aGUgY29udGFpbmVyIFZNIG1lbW9yeSAoVklCRV9DT05UQUlORVJfTUVNT1JZKSBvciByZWR1Y2UgY29uY3VycmVudCBsb2FkIG9uIHRoZSBob3N0YDtcblxuICAgIGNhc2UgXCJpbnRlcnJ1cHRlZFwiOlxuICAgICAgcmV0dXJuIGAtIFRoZSBydW4gd2FzIGN1dCBvZmYgYmVmb3JlIGl0IGNvdWxkIGZpbmlzaCDigJQgdGhlIGFnZW50IHdhcyBzdGlsbCB3b3JraW5nIChjb21tb25seSBhIHNsb3cgZmlyc3QgcXVhbGl0eS1nYXRlIHBhc3Mgb3IgYW4gZXhoYXVzdGVkIHR1cm4gYnVkZ2V0KSwgbm90IGNvbmNsdWRpbmdcbi0gVGhpcyBpcyBhIHRyYW5zaWVudCBpbmZyYXN0cnVjdHVyZSBpc3N1ZSwgbm90IHJlbGF0ZWQgdG8gaXNzdWUgY29tcGxleGl0eSBvciBjbGFyaXR5XG4tIFRoZSBpc3N1ZSBpcyByZXRyaWVkIGF1dG9tYXRpY2FsbHkgb24gdGhlIG5leHQgc2Nhbiwgbm90IGVzY2FsYXRlZCB0byBhIGh1bWFuYDtcblxuICAgIGNhc2UgXCJ6ZXJvX291dHB1dFwiOiB7XG4gICAgICBjb25zdCBiYXNlTGluZSA9XG4gICAgICAgIFwiLSBDbGF1ZGUgcHJvZHVjZWQgbm8gb3V0cHV0LCB3aGljaCB0eXBpY2FsbHkgaW5kaWNhdGVzIGEgc3RhcnR1cCBmYWlsdXJlIG9yIGVudmlyb25tZW50IGlzc3VlXFxuLSBUaGlzIGlzIG5vdCByZWxhdGVkIHRvIHRoZSBpc3N1ZSBjb21wbGV4aXR5IG9yIGRlc2NyaXB0aW9uIHF1YWxpdHlcIjtcbiAgICAgIGNvbnN0IGRpYWdMaW5lcyA9IGZvcm1hdFplcm9PdXRwdXREaWFnbm9zdGljcyhkaWFnbm9zdGljQ29udGV4dCk7XG4gICAgICBpZiAoZGlhZ0xpbmVzKSB7XG4gICAgICAgIHJldHVybiBgJHtiYXNlTGluZX1cXG4ke2RpYWdMaW5lc31gO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGAke2Jhc2VMaW5lfVxcbi0gVGhpcyBpcyBhIHRyYW5zaWVudCBpbmZyYXN0cnVjdHVyZSBpc3N1ZSBcXHUyMDE0IHRoZSB3b3JrZXIgd2lsbCByZXRyeSBhdXRvbWF0aWNhbGx5YDtcbiAgICB9XG5cbiAgICBjYXNlIFwicXVhbGl0eV9jaGVja1wiOlxuICAgICAgcmV0dXJuIGAtIENoYW5nZXMgd2VyZSBtYWRlIGJ1dCBmYWlsZWQgdGhlIHF1YWxpdHkgZ2F0ZSAoXFxgLi9xdWFsaXR5LnNoXFxgKVxuLSBPbmUgb3IgbW9yZSB0ZXN0cywgbGludCBjaGVja3MsIG9yIHR5cGUgY2hlY2tzIGRpZCBub3QgcGFzc1xuLSBSZXZpZXcgdGhlIGZhaWx1cmUgZGV0YWlscyBhYm92ZSBmb3Igc3BlY2lmaWMgcXVhbGl0eSBjaGVjayBvdXRwdXRgO1xuXG4gICAgY2FzZSBcIm1pc3NpbmdfdG9vbHNcIjpcbiAgICAgIHJldHVybiBgLSBUaGUgcXVhbGl0eSBnYXRlIChcXGAuL3F1YWxpdHkuc2hcXGApIHJlcXVpcmVzIHRvb2xzIHRoYXQgYXJlIG5vdCBpbnN0YWxsZWQgb24gdGhlIHdvcmtlciBtYWNoaW5lXG4tIFRoaXMgaXMgYW4gKiplbnZpcm9ubWVudCBpc3N1ZSoqIFxcdTIwMTQgQ2xhdWRlIGNhbm5vdCBpbnN0YWxsIHN5c3RlbS1sZXZlbCB0b29sc1xuLSBBIGRldmVsb3BlciBtdXN0IGVpdGhlciBpbnN0YWxsIHRoZSBtaXNzaW5nIHRvb2xzIG9uIHRoZSB3b3JrZXIsIG9yIHVwZGF0ZSBcXGBxdWFsaXR5LnNoXFxgIHRvIGdyYWNlZnVsbHkgc2tpcCBjaGVja3Mgd2hlbiB0b29scyBhcmUgdW5hdmFpbGFibGVcbi0gUmV0cnlpbmcgd2lsbCBwcm9kdWNlIHRoZSBzYW1lIHJlc3VsdCB1bnRpbCB0aGUgZW52aXJvbm1lbnQgaXMgZml4ZWRgO1xuXG4gICAgY2FzZSBcInB1c2hfZmFpbHVyZVwiOlxuICAgICAgcmV0dXJuIGAtIEdpdCBwdXNoIGZhaWxlZCBkdWUgdG8gYSBwZXJtaXNzaW9ucywgbmV0d29yaywgb3IgYnJhbmNoIHByb3RlY3Rpb24gaXNzdWVcbi0gVGhpcyBpcyBub3QgcmVsYXRlZCB0byB0aGUgaXNzdWUgY29udGVudCBvciBjb21wbGV4aXR5XG4tIENoZWNrIHJlcG9zaXRvcnkgYWNjZXNzIHBlcm1pc3Npb25zIGFuZCBuZXR3b3JrIGNvbm5lY3Rpdml0eWA7XG5cbiAgICBjYXNlIFwidG9rZW5fc2NvcGVcIjpcbiAgICAgIHJldHVybiBgLSBUaGUgd29ya2VyJ3MgR2l0SHViIHRva2VuIGxhY2tzIHRoZSBcXGB3b3JrZmxvd1xcYCBPQXV0aCBzY29wZSwgYW5kIHRoaXMgY2hhbmdlIGNyZWF0ZXMgb3IgdXBkYXRlcyBhIGZpbGUgdW5kZXIgXFxgLmdpdGh1Yi93b3JrZmxvd3MvXFxgXG4tIEdpdEh1YiByZWplY3RzIHN1Y2ggYSBwdXNoIGZyb20gYW55IE9BdXRoIHRva2VuIHdpdGhvdXQgdGhhdCBzY29wZSwgc28gdGhlIHJ1biBzdG9wcGVkICoqYmVmb3JlKiogcHVzaGluZ1xuLSBUaGlzIGlzIGEgKipob3N0IGNyZWRlbnRpYWwgaXNzdWUqKiwgbm90IHJlbGF0ZWQgdG8gdGhlIGlzc3VlIGNvbnRlbnQg4oCUIG5vIGF0dGVtcHQgd2FzIG1hZGUgdG8gcHVzaFxuLSBBbiBvcGVyYXRvciBtdXN0IGdyYW50IHRoZSBzY29wZSB0byB0aGUgd29ya2VyIGFjY291bnQgKFxcYGdoIGF1dGggcmVmcmVzaCAtcyB3b3JrZmxvd1xcYCksIHJlLXByb3Zpc2lvbiBcXGBnaC9ob3N0cy55bWxcXGAgYW5kIHJlc3RhcnQgdGhlIHdvcmtlcjsgYSBob3N0IHdob3NlIHRva2VuIGhhcyB0aGUgc2NvcGUgY2FuIHBpY2sgdGhlIGlzc3VlIHVwIGFzIGl0IGlzYDtcblxuICAgIGNhc2UgXCJub19jaGFuZ2VzXCI6XG4gICAgICBpZiAoY2xhcml0eVdhc0Fzc2Vzc2VkKGNsYXJpdHlTdGF0dXMpKSB7XG4gICAgICAgIHJldHVybiBgLSBDbGF1ZGUgY29tcGxldGVkIGJ1dCBtYWRlIG5vIGNoYW5nZXMgdG8gdGhlIGNvZGViYXNlXG4tIFRoZSBpc3N1ZSB3YXMgYXNzZXNzZWQgYXMgY2xlYXIsIHNvIHRoaXMgaXMgbGlrZWx5IGEgdG9vbGluZyBvciBjb21wcmVoZW5zaW9uIGlzc3VlIHJhdGhlciB0aGFuIGEgZGVzY3JpcHRpb24gcHJvYmxlbVxuLSBDb25zaWRlciBicmVha2luZyB0aGUgdGFzayBpbnRvIHNtYWxsZXIgcGllY2VzIG9yIGFkZGluZyBzcGVjaWZpYyBmaWxlIHBhdGhzIGFuZCBhY2NlcHRhbmNlIGNyaXRlcmlhYDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBgLSBDbGF1ZGUgY29tcGxldGVkIGJ1dCBtYWRlIG5vIGNoYW5nZXMgdG8gdGhlIGNvZGViYXNlXG4tIFRoZSBpc3N1ZSBkZXNjcmlwdGlvbiBtYXkgbmVlZCBtb3JlIGRldGFpbCBhYm91dCB3aGF0IGNoYW5nZXMgYXJlIGV4cGVjdGVkXG4tIENvbnNpZGVyIGFkZGluZyBzcGVjaWZpYyBmaWxlIHBhdGhzLCBleHBlY3RlZCBiZWhhdmlvdXIsIG9yIGFjY2VwdGFuY2UgY3JpdGVyaWFgO1xuXG4gICAgY2FzZSBcIndvcmtmbG93X2dhdGVcIjpcbiAgICAgIHJldHVybiBgLSBBIHdvcmtmbG93IGZpbGUgdGhpcyBydW4gYWRkZWQgb3IgY2hhbmdlZCBjYXJyaWVzIGEgR2l0SHViIEFjdGlvbnMgZmluZGluZyB0aGUgYmFzZSBjb21taXQgZGlkIG5vdCwgc28gdGhlIGNoYW5nZWQtd29ya2Zsb3cgZ2F0ZSByZWZ1c2VkIHRoZSBydW5cbi0gVGhlIGZpbmRpbmcgaXMgYSBkZWZlY3QgaW4gdGhlIGNoYW5nZSwgbm90IGEgZG9jdW1lbnRhdGlvbiBzaG9ydGZhbGw6IGl0IHN0b3BzIHRoZSBydW4gd2hldGhlciBvciBub3QgYSBwdWxsIHJlcXVlc3QgYWxyZWFkeSBleGlzdHNcbi0gRml4IHRoZSBuYW1lZCBmaWxlIFxcdTIwMTQgYSBmaW5kaW5nIHRoYXQgZ2VudWluZWx5IGRvZXMgbm90IGFwcGx5IGNhbm5vdCBiZSBjbGVhcmVkIGJ5IHRoZSBydW4gKHRoZSBnYXRlIGhvbm91cnMgbm8gaW4tZmlsZSBzdXBwcmVzc2lvbiBtYXJrZXIpLCBzbyBpdCBuZWVkcyBhIGh1bWFuIHRvIHJldmlldyBpdCwgb3IgYSBmaXggdG8gdGhlIHNjYW5uZXJcbi0gV2hlbiB0aGUgcnVuIGhhZCBhbHJlYWR5IHJhaXNlZCBpdHMgcHVsbCByZXF1ZXN0LCB0aGF0IFBSIHN0YXlzIG9wZW4gYW5kIGNhcnJpZXMgdGhlIG91dHN0YW5kaW5nIGZpbmRpbmcgXFx1MjAxNCB0aGUgd29yayBpcyBkZWxpdmVyZWQsIHRoZSBmaW5kaW5nIGlzIG5vdGA7XG5cbiAgICBjYXNlIFwicmVwb19jb25maWdcIjpcbiAgICAgIHJldHVybiBgLSBUaGUgcmVwb3NpdG9yeSByZWZ1c2VkIHRoZSBtaWxlc3RvbmUgYnJhbmNoIHRoaXMgcnVuIGhhZCB0byBiYXNlIGl0cyB3b3JrIG9uIOKAlCBhIHJ1bGVzZXQsIGEgYnJhbmNoIHByb3RlY3Rpb24sIG9yIGEgcGVybWlzc2lvbiB0aGUgZmxlZXQgYWNjb3VudCBsYWNrc1xuLSBUaGlzIGlzIGEgKipyZXBvc2l0b3J5IGNvbmZpZ3VyYXRpb24qKiBmYXVsdCwgbm90IGEgcHJvcGVydHkgb2YgdGhpcyBpc3N1ZTogdGhlIHNhbWUgcmVmdXNhbCBtZWV0cyBldmVyeSBzaWJsaW5nIGlzc3VlIGluIHRoZSBtaWxlc3RvbmVcbi0gTm8gXFxgZmFpbGVkLW9uY2VcXGAgb3IgXFxgZmFpbGVkXFxgIGxhYmVsIHdhcyBhcHBsaWVkLCBhbmQgdGhlIGlzc3VlIHN0YXlzIGNsYWltYWJsZSDigJQgb25jZSB0aGUgcmVwb3NpdG9yeSBpcyBmaXhlZCwgdGhlIG5leHQgc2NhbiBwaWNrcyBpdCB1cCB3aXRoIG5vIGh1bWFuIGFjdGlvblxuLSBUaGUgbW9zdCBjb21tb24gY2F1c2UgaXMgYSBcXGBtaWxlc3RvbmUvKipcXGAgcnVsZXNldCB3aG9zZSBcXGByZXF1aXJlZF9zdGF0dXNfY2hlY2tzXFxgIHJ1bGUgaGFzIFxcYGRvX25vdF9lbmZvcmNlX29uX2NyZWF0ZTogZmFsc2VcXGAsIHdoaWNoIHJlZnVzZXMgdGhlIHZlcnkgcHVzaCB0aGF0IHdvdWxkIGNyZWF0ZSB0aGUgYnJhbmNoYDtcblxuICAgIGNhc2UgXCJwcm9tcHRfdG9vX2xvbmdcIjpcbiAgICAgIHJldHVybiBgLSBUaGUgYWdlbnQgQ0xJIHJlZnVzZWQgdGhlIHJ1biB3aXRoIFxcYFByb21wdCBpcyB0b28gbG9uZ1xcYCDigJQgdGhlIGNvbnZlcnNhdGlvbiBubyBsb25nZXIgZml0cyB0aGUgbW9kZWwncyBjb250ZXh0IHdpbmRvd1xuLSBUaGlzIGlzIGEgKip3b3JrZXIgZmF1bHQqKiwgbm90IGEgcHJvcGVydHkgb2YgdGhlIGlzc3VlOiBhIHJlc3VtZWQgc2Vzc2lvbiB0aGF0IG92ZXJmbG93cyBpcyBkaXNjYXJkZWQgYW5kIHJldHJpZWQgb25jZSBvbiBhIGZyZXNoIHNlc3Npb24gd2l0aG91dCBjb3VudGluZyBhZ2FpbnN0IHRoZSBpc3N1ZVxuLSBUaGlzIGZhaWx1cmUgaXMgY291bnRlZCBiZWNhdXNlIHRoZSBmcmVzaCBzZXNzaW9uIG92ZXJmbG93ZWQgdG9vLCBzbyB0aGUgaXNzdWUncyBvd24gY29udGV4dCAoYm9keSwgY29tbWVudHMsIHByb21wdCkgaXMgbGlrZWx5IHRvbyBsYXJnZSBmb3Igb25lIHJ1blxuLSBDb25zaWRlciB0cmltbWluZyB0aGUgaXNzdWUgYm9keSBvciBzcGxpdHRpbmcgdGhlIHRhc2sgaW50byBzbWFsbGVyIHN1Yi1pc3N1ZXNgO1xuXG4gICAgY2FzZSBcImNsb25lX2NvcnJ1cHRcIjpcbiAgICAgIHJldHVybiBgLSBCcmFuY2ggY3JlYXRpb24gZmFpbGVkIGJlY2F1c2UgdGhlIGhvc3QncyBzaGFyZWQgY2xvbmUgb2YgdGhpcyByZXBvc2l0b3J5IGlzIGRhbWFnZWQg4oCUIGJyb2tlbiByZWZzIG9yIGEgY29ycnVwdCBvYmplY3Qgc3RvcmVcbi0gVGhpcyBpcyBhICoqaG9zdCBpbmZyYXN0cnVjdHVyZSoqIGZhdWx0LCBub3QgYSBwcm9wZXJ0eSBvZiB0aGlzIGlzc3VlOiBldmVyeSBpc3N1ZSBjbGFpbWVkIG9uIHRoaXMgaG9zdCBoaXRzIHRoZSBzYW1lIGRhbWFnZWQgY2xvbmVcbi0gTm8gXFxgZmFpbGVkLW9uY2VcXGAgb3IgXFxgZmFpbGVkXFxgIGxhYmVsIHdhcyBhcHBsaWVkLCBidXQgdGhlIHNldHVwLXBoYXNlIHJlcGFpciBsYWRkZXIncyBlc2NhbGF0aW9uIGFscmVhZHkgcHV0IFxcYG5lZWRzLWh1bWFuXFxgIG9uIHRoaXMgaXNzdWUg4oCUIGVpdGhlciBpdHMgcmVwYWlyIGF0dGVtcHQgZGlkIG5vdCBjbGVhciB0aGUgZmF1bHQsIG9yIHRoaXMgcnVuJ3Mgb25lIHJlcGFpciBhdHRlbXB0IHdhcyBhbHJlYWR5IHNwZW50IGJ5IGFuIGVhcmxpZXIgaXNzdWUg4oCUIGFuZCBpdCBzdGF5cyBwYXJrZWQgdW50aWwgYSBodW1hbiByZW1vdmVzIHRoYXQgbGFiZWxcbi0gQW4gb3BlcmF0b3Igc2hvdWxkIGNoZWNrIHRoZSBob3N0J3Mgc2hhcmVkIGNsb25lIChlLmcuIFxcYGdpdCBmc2NrXFxgKSBhbmQgcmUtY2xvbmUgb3IgcmVwYWlyIGl0IGlmIHJlZnMgb3Igb2JqZWN0cyBhcmUgbWlzc2luZyBvciBjb3JydXB0LCB0aGVuIHJlbW92ZSB0aGUgXFxgbmVlZHMtaHVtYW5cXGAgbGFiZWwgc28gdGhlIGlzc3VlIGlzIGNsYWltYWJsZSBhZ2FpbmA7XG5cbiAgICBjYXNlIFwic3VtbWFyeV9pbmNvbXBsZXRlXCI6XG4gICAgICByZXR1cm4gYC0gVGhlIFBSIHN1bW1hcnkgZGlkIG5vdCBwYXNzIHRoZSB3b3JrZXIncyBjb21wbGV0aW9uIGdhdGVzXG4tIFRoZSBnYXRlJ3MgY29tbWVudCBvbiB0aGUgaXNzdWUgbmFtZXMgZWFjaCBnYXAgaW4gdGhlIHN1bW1hcnlcbi0gVGhpcyBpcyB0aGUgYWdlbnQncyBkZWxpdmVyYWJsZSBmYWxsaW5nIHNob3J0LCBub3QgYSB3b3JrZXIgZGVmZWN0XG4tIFRoZSBub3JtYWwgcmV0cnkgYW5kIFxcYGZhaWxlZC1vbmNlXFxgIHJ1bGVzIGFwcGx5YDtcblxuICAgIGNhc2UgXCJzZWN1cml0eV9maXhfZ2F0ZVwiOlxuICAgICAgcmV0dXJuIGAtIFRoZSBzZWN1cml0eSBmaXggZGlkIG5vdCBwYXNzIHRoZSB3b3JrZXIncyBzZWN1cml0eS1maXggZ2F0ZVxuLSBUaGUgYWdlbnQgZGlkIG5vdCBkZWxpdmVyIHRoZSB2dWxuZXJhYmlsaXR5LWZpeCB2ZXJpZmljYXRpb24gZXZpZGVuY2UgdGhlIGdhdGUgcmVxdWlyZXNcbi0gVGhpcyBpcyB0aGUgYWdlbnQncyBkZWxpdmVyYWJsZSBmYWxsaW5nIHNob3J0LCBub3QgYSB3b3JrZXIgZGVmZWN0XG4tIFRoZSBub3JtYWwgcmV0cnkgYW5kIFxcYGZhaWxlZC1vbmNlXFxgIHJ1bGVzIGFwcGx5YDtcblxuICAgIGNhc2UgXCJwcmVfcHVzaF9nYXRlXCI6XG4gICAgICByZXR1cm4gYC0gVGhlIGJyYW5jaCBkaWQgbm90IHBhc3MgdGhlIHdvcmtlcidzIHByZS1wdXNoIGdhdGVcbi0gVGhlIGdhdGUncyBjb21tZW50IG9uIHRoZSBpc3N1ZSBxdW90ZXMgdGhlIGZhaWxpbmcgY2hlY2sncyBvdXRwdXQsIHdoaWNoIG5hbWVzIGVhY2ggZmlsZSBhbmQgZmluZGluZ1xuLSBUaGlzIGlzIHRoZSBicmFuY2gncyBjb250ZW50IGZhaWxpbmcgdGhlIHJlcG9zaXRvcnkncyBvd24gY2hlY2tzLCBub3QgYSB3b3JrZXIgZGVmZWN0XG4tIFRoZSBub3JtYWwgcmV0cnkgYW5kIFxcYGZhaWxlZC1vbmNlXFxgIHJ1bGVzIGFwcGx5YDtcblxuICAgIGNhc2UgXCJjcml0ZXJpYV91bm1ldFwiOlxuICAgICAgcmV0dXJuIGAtIFRoZSBydW4gZGlkIG5vdCBtZWV0IGV2ZXJ5IGFjY2VwdGFuY2UgY3JpdGVyaW9uLCBldmVuIGFmdGVyIGl0cyBpbi1ydW4gcm91bmRzXG4tIFRoZSBnYXRlJ3MgY29tbWVudCBvbiB0aGUgaXNzdWUgbmFtZXMgZWFjaCB1bm1ldCBjcml0ZXJpb25cbi0gTm8gUFIgd2FzIHJhaXNlZCBhbmQgbm8gZm9sbG93LXVwIGlzc3VlIHdhcyBmaWxlZDogdGhlIGJyYW5jaCBzdGF5cyBwdXNoZWQsIGFuZCB0aGUgbmV4dCBydW4gcmVzdW1lcyBpdCB0byBmaW5pc2ggdGhlIGpvYlxuLSBUaGUgbm9ybWFsIHJldHJ5IGFuZCBcXGBmYWlsZWQtb25jZVxcYCBydWxlcyBhcHBseWA7XG5cbiAgICBjYXNlIFwiZXZpZGVuY2VfbWlzc2luZ1wiOlxuICAgICAgcmV0dXJuIGAtIFRoZSBQUiB3YXMgYmxvY2tlZCBiZWNhdXNlIHNjcmVlbnNob3QgZXZpZGVuY2UgaXMgcmVxdWlyZWQgZm9yIFVJIGNoYW5nZXNcbi0gVGhpcyBpcyBhIHByb2Nlc3MgcmVxdWlyZW1lbnQsIG5vdCByZWxhdGVkIHRvIGlzc3VlIGNvbXBsZXhpdHlcbi0gRXZlcnkgcnVuIGlzIGdpdmVuIHRoZSBoZWFkbGVzcyBicm93c2VyIHVubGVzcyB0aGUgcmVwb3NpdG9yeSBzZXRzIFxcYHNraXBfc2NyZWVuc2hvdF9jaGVja1xcYDsgaWYgdGhlIGFnZW50IHJlcG9ydGVkIGEgYnJvd3NlciBlcnJvciwgaXQgaXMgcXVvdGVkIGluIHRoZSBQUiBzdW1tYXJ5IG9yIHRoZSBydW4gbG9nXG4tIEEgcmV0cnkgaGFwcGVucyBvbmx5IHdoaWxlIHRoZSBpc3N1ZSBpcyBub3QgbGFiZWxsZWQgXFxgZmFpbGVkXFxgOyBvbmNlIGl0IGlzLCB0aGUgaXNzdWUgaXMgcmV0cmllZCBvbmx5IGFmdGVyIGEgaHVtYW4gcmVtb3ZlcyB0aGF0IGxhYmVsYDtcblxuICAgIGNhc2UgXCJpbnRlcm5hbF9lcnJvclwiOlxuICAgICAgcmV0dXJuIGAtIEFuIGludGVybmFsIGVycm9yIG9jY3VycmVkIGluIHRoZSB3b3JrZXIgdG9vbGluZyBvciBDbGF1ZGUgQ0xJXG4tIFRoaXMgaXMgbm90IHJlbGF0ZWQgdG8gdGhlIGlzc3VlIGNvbXBsZXhpdHkgb3IgZGVzY3JpcHRpb24gcXVhbGl0eVxuLSBUaGlzIGlzIGEgdHJhbnNpZW50IGluZnJhc3RydWN0dXJlIGlzc3VlIFxcdTIwMTQgdGhlIHdvcmtlciB3aWxsIHJldHJ5IGF1dG9tYXRpY2FsbHlgO1xuXG4gICAgY2FzZSBcInVua25vd25cIjpcbiAgICAgIGlmIChjbGFyaXR5V2FzQXNzZXNzZWQoY2xhcml0eVN0YXR1cykpIHtcbiAgICAgICAgcmV0dXJuIGAtIFRoZSBmYWlsdXJlIGNhdXNlIGNvdWxkIG5vdCBiZSBhdXRvbWF0aWNhbGx5IGRldGVybWluZWRcbi0gVGhlIGlzc3VlIHdhcyBhc3Nlc3NlZCBhcyBjbGVhciwgc28gdGhlIGRlc2NyaXB0aW9uIGlzIHVubGlrZWx5IHRvIGJlIHRoZSBwcm9ibGVtXG4tIFJldmlldyB0aGUgZmFpbHVyZSBkZXRhaWxzIGFib3ZlIGZvciBtb3JlIGNvbnRleHRgO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGAtIFRoZSBmYWlsdXJlIGNhdXNlIGNvdWxkIG5vdCBiZSBhdXRvbWF0aWNhbGx5IGRldGVybWluZWRcbi0gUmV2aWV3IHRoZSBmYWlsdXJlIGRldGFpbHMgYWJvdmUgZm9yIG1vcmUgY29udGV4dFxuLSBDb25zaWRlciBzaW1wbGlmeWluZyB0aGUgaXNzdWUgb3IgYWRkaW5nIG1vcmUgZGV0YWlsIHRvIHRoZSBkZXNjcmlwdGlvbmA7XG5cbiAgICBkZWZhdWx0OlxuICAgICAgLy8gRXhoYXVzdGl2ZW5lc3MgZ3VhcmQ6IGEgbmV3IEZhaWx1cmVDYXRlZ29yeSBtdXN0IGdldCBpdHMgb3duIGFybVxuICAgICAgLy8gcmF0aGVyIHRoYW4gc2lsZW50bHkgbWFwcGluZyB0byB0aGUgXCJ1bmtub3duXCIgcGF0aCAoSXNzdWUgIzI3OTQpLlxuICAgICAgLy8gQ2FsbGVycyBwYXNzaW5nIHVuLXZhbGlkYXRlZCBpbnB1dCBtdXN0IG5vcm1hbGlzZSB2aWFcbiAgICAgIC8vIG5vcm1hbGlzZUZhaWx1cmVDYXRlZ29yeSgpIGZpcnN0LlxuICAgICAgcmV0dXJuIGFzc2VydE5ldmVyKGNhdGVnb3J5KTtcbiAgfVxufVxuXG4vKipcbiAqIFJldHVybiBhIGJyaWVmIG9uZS1saW5lIGNhdXNlIHN1bW1hcnkuXG4gKlxuICogVXNlZCBieSBtYXJrX2lzc3VlX2FzX2ZhaWxlZF9vbmNlKCkgdG8gYWRkIGEgYnJpZWYgaW5kaWNhdGlvbiBvZiB0aGVcbiAqIGxpa2VseSBjYXVzZSB3aXRob3V0IHRoZSBmdWxsIG11bHRpLWxpbmUgZGlhZ25vc2lzLCBhbmQgYnkgdGhlIGNsYWltLXJlbGVhc2VcbiAqIGNvbW1lbnQgKGByZW5kZXJSdW5PdXRjb21lQ2xhdXNlYCkuXG4gKlxuICogQSB0aW1lb3V0IHN0YXRlcyB0aGUgZXh0ZW5zaW9uIHRlbGVtZXRyeSB0aGUgY2FsbGVyIGhvbGRzIChJc3N1ZSAjNzY4KSDigJRcbiAqIGhvdyBtYW55IGdyYW50cyB0aGUgZGVhZGxpbmUgbWFkZSBhbmQgd2h5IHRoZSBsYXN0IGNoZWNrIHdhcyByZWZ1c2VkIOKAlCBzb1xuICogdGhlIHJlbGVhc2UgY29tbWVudCBleHBsYWlucyB0aGUga2lsbCBpbnN0ZWFkIG9mIGxlYXZpbmcgaXQgdG8gYSBjb2RlXG4gKiBhcmNoYWVvbG9neSBkaWcuIFdpdGhvdXQgdGVsZW1ldHJ5IHRoZSB3b3JkaW5nIGlzIHVuY2hhbmdlZC5cbiAqXG4gKiBAcGFyYW0gZXh0ZW5zaW9ucyAtIFRoZSBraWxsJ3Mgc25hcHNob3QsIHdoZW4gdGhlIGNhbGxlciBoYXMgb25lLiBUaGVcbiAqIHJlbGVhc2UgY29tbWVudCBkb2VzOyBgbWFya0lzc3VlQXNGYWlsZWRPbmNlYCBkb2VzIG5vdCwgYW5kIGl0cyBjb21tZW50XG4gKiBhbHJlYWR5IGNhcnJpZXMgdGhlIHNhbWUgaGlzdG9yeSBpbnNpZGUgdGhlIHJhdyBmYWlsdXJlIG1lc3NhZ2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRGYWlsdXJlRGlhZ25vc2lzT25lbGluZXIoXG4gIGNhdGVnb3J5OiBGYWlsdXJlQ2F0ZWdvcnksXG4gIGNsYXJpdHlTdGF0dXM6IENsYXJpdHlTdGF0dXMgPSBcIm5vdF9hc3Nlc3NlZFwiLFxuICBleHRlbnNpb25zPzogRXh0ZW5zaW9uVGVsZW1ldHJ5LFxuKTogc3RyaW5nIHtcbiAgc3dpdGNoIChjYXRlZ29yeSkge1xuICAgIGNhc2UgXCJ0aW1lb3V0XCI6XG4gICAgICByZXR1cm4gZXh0ZW5zaW9uc1xuICAgICAgICA/IGBMaWtlbHkgY2F1c2U6IENsYXVkZSByYW4gb3V0IG9mIHRpbWUuICR7XG4gICAgICAgICAgZm9ybWF0VGltZW91dEV4dGVuc2lvblN1bW1hcnkoZXh0ZW5zaW9ucylcbiAgICAgICAgfS5gXG4gICAgICAgIDogXCJMaWtlbHkgY2F1c2U6IENsYXVkZSByYW4gb3V0IG9mIHRpbWUuXCI7XG4gICAgLy8gRGVsaWJlcmF0ZWx5IG5vdCBcIkxpa2VseSBjYXVzZVwiOiBub3RoaW5nIHdhcyBkaWFnbm9zZWQuIFRoZSBjeWNsZVxuICAgIC8vIGVuZGVkIG9yIHRoZSBoYXJkIGNhcCB3YXMgcmVhY2hlZCBhbmQgdGhlIHdvcmsgd2FzIHBhcmtlZCAoSXNzdWUgIzQyNCkuXG4gICAgY2FzZSBcInNjaGVkdWxlZF9yZWxlYXNlXCI6XG4gICAgICByZXR1cm4gXCJTY2hlZHVsZWQgcmVsZWFzZTogdGhlIGN5Y2xlIGVuZGVkIG9yIHRoZSBydW4gaGFyZCBjYXAgd2FzIHJlYWNoZWQg4oCUIFdJUCBwcmVzZXJ2ZWQsIHJlc3VtZXMgbmV4dCBjeWNsZS5cIjtcbiAgICBjYXNlIFwicmF0ZV9saW1pdFwiOlxuICAgICAgcmV0dXJuIFwiTGlrZWx5IGNhdXNlOiBDbGF1ZGUgd2FzIHJhdGUtbGltaXRlZCAodHJhbnNpZW50IGluZnJhc3RydWN0dXJlIGlzc3VlKS5cIjtcbiAgICBjYXNlIFwiemVyb19vdXRwdXRcIjpcbiAgICAgIHJldHVybiBcIkxpa2VseSBjYXVzZTogQ2xhdWRlIHByb2R1Y2VkIG5vIG91dHB1dCAoc3RhcnR1cCBvciBlbnZpcm9ubWVudCBpc3N1ZSkuXCI7XG4gICAgY2FzZSBcImtpbGxlZFwiOlxuICAgICAgcmV0dXJuIFwiTGlrZWx5IGNhdXNlOiB0aGUgYWdlbnQgd2FzIGtpbGxlZCAoU0lHS0lMTCkg4oCUIHBvc3NpYmx5IHRoZSBWTSdzIG91dC1vZi1tZW1vcnkga2lsbGVyLlwiO1xuICAgIGNhc2UgXCJpbnRlcnJ1cHRlZFwiOlxuICAgICAgcmV0dXJuIFwiTGlrZWx5IGNhdXNlOiB0aGUgcnVuIHdhcyBjdXQgb2ZmIGJlZm9yZSBmaW5pc2hpbmcgKHNsb3cgcXVhbGl0eSBnYXRlIG9yIGV4aGF1c3RlZCB0dXJuIGJ1ZGdldCkg4oCUIHRyYW5zaWVudCwgcmV0cmllZCBhdXRvbWF0aWNhbGx5LlwiO1xuICAgIGNhc2UgXCJxdWFsaXR5X2NoZWNrXCI6XG4gICAgICByZXR1cm4gXCJMaWtlbHkgY2F1c2U6IGNoYW5nZXMgZmFpbGVkIHF1YWxpdHkgY2hlY2tzLlwiO1xuICAgIGNhc2UgXCJtaXNzaW5nX3Rvb2xzXCI6XG4gICAgICByZXR1cm4gXCJMaWtlbHkgY2F1c2U6IHJlcXVpcmVkIHRvb2xzIChlLmcuLCBucG0sIG5vZGUpIG5vdCBpbnN0YWxsZWQgb24gd29ya2VyIG1hY2hpbmUuXCI7XG4gICAgY2FzZSBcInB1c2hfZmFpbHVyZVwiOlxuICAgICAgcmV0dXJuIFwiTGlrZWx5IGNhdXNlOiBnaXQgcHVzaCBmYWlsZWQgKHBlcm1pc3Npb25zIG9yIG5ldHdvcmsgaXNzdWUpLlwiO1xuICAgIGNhc2UgXCJ0b2tlbl9zY29wZVwiOlxuICAgICAgcmV0dXJuIFwiTGlrZWx5IGNhdXNlOiB0aGUgd29ya2VyJ3MgdG9rZW4gbGFja3MgdGhlICd3b3JrZmxvdycgc2NvcGUgYW5kIHRoZSBjaGFuZ2UgdG91Y2hlcyAuZ2l0aHViL3dvcmtmbG93cy8uXCI7XG4gICAgY2FzZSBcIm5vX2NoYW5nZXNcIjpcbiAgICAgIGlmIChjbGFyaXR5V2FzQXNzZXNzZWQoY2xhcml0eVN0YXR1cykpIHtcbiAgICAgICAgcmV0dXJuIFwiTGlrZWx5IGNhdXNlOiBDbGF1ZGUgY291bGQgbm90IGRldGVybWluZSB3aGF0IGNoYW5nZXMgdG8gbWFrZSAoaXNzdWUgd2FzIGFzc2Vzc2VkIGFzIGNsZWFyKS5cIjtcbiAgICAgIH1cbiAgICAgIHJldHVybiBcIkxpa2VseSBjYXVzZTogQ2xhdWRlIGNvdWxkIG5vdCBkZXRlcm1pbmUgd2hhdCBjaGFuZ2VzIHRvIG1ha2UuXCI7XG4gICAgY2FzZSBcImV2aWRlbmNlX21pc3NpbmdcIjpcbiAgICAgIHJldHVybiBcIkxpa2VseSBjYXVzZTogc2NyZWVuc2hvdCBldmlkZW5jZSByZXF1aXJlZCBidXQgbm90IHByb3ZpZGVkLlwiO1xuICAgIC8vIERlbGliZXJhdGVseSBub3QgXCJMaWtlbHkgY2F1c2VcIjogbm90aGluZyB3YXMgZ3Vlc3NlZC4gVGhlIHJlcG9zaXRvcnlcbiAgICAvLyByZWZ1c2VkIHRoZSBicmFuY2ggYW5kIHNhaWQgc28gKElzc3VlICMyMjIwKS5cbiAgICBjYXNlIFwicmVwb19jb25maWdcIjpcbiAgICAgIHJldHVybiBcIlJlcG9zaXRvcnkgY29uZmlndXJhdGlvbiByZWZ1c2VkIHRoZSBtaWxlc3RvbmUgYnJhbmNoIOKAlCB0aGUgc2FtZSByZWZ1c2FsIG1lZXRzIGV2ZXJ5IGlzc3VlIGluIHRoZSBtaWxlc3RvbmUsIHNvIHRoaXMgaXNzdWUgaXMgbGVmdCB1bmxhYmVsbGVkIGFuZCBjbGFpbWFibGUuXCI7XG4gICAgLy8gRGVsaWJlcmF0ZWx5IG5vdCBcIkxpa2VseSBjYXVzZVwiOiBub3RoaW5nIHdhcyBndWVzc2VkLiBUaGUgd29ya2VyJ3Mgb3duXG4gICAgLy8gZ2F0ZSByZWZ1c2VkIHRoZSBydW4gYW5kIG5hbWVkIHRoZSBmaW5kaW5nIChJc3N1ZSAjMjA0NCkuXG4gICAgY2FzZSBcIndvcmtmbG93X2dhdGVcIjpcbiAgICAgIHJldHVybiBcIkJsb2NrZWQgYnkgdGhlIGNoYW5nZWQtd29ya2Zsb3cgZmlsZSBjaGVja3M6IGEgd29ya2Zsb3cgZmlsZSB0aGlzIHJ1biB0b3VjaGVkIGNhcnJpZXMgYSBmaW5kaW5nIHRoZSBiYXNlIGNvbW1pdCBkaWQgbm90LlwiO1xuICAgIGNhc2UgXCJwcm9tcHRfdG9vX2xvbmdcIjpcbiAgICAgIHJldHVybiBcIkxpa2VseSBjYXVzZTogdGhlIGFnZW50IENMSSByZWZ1c2VkIHRoZSBydW4gYXMgJ1Byb21wdCBpcyB0b28gbG9uZycgZXZlbiBvbiBhIGZyZXNoIHNlc3Npb24uXCI7XG4gICAgLy8gRGVsaWJlcmF0ZWx5IG5vdCBcIkxpa2VseSBjYXVzZVwiOiBub3RoaW5nIHdhcyBndWVzc2VkLiBUaGUgc2V0dXAgcGhhc2VcbiAgICAvLyBkZXRlY3RlZCB0aGUgaG9zdCdzIHNoYXJlZCBjbG9uZSB3YXMgZGFtYWdlZCBhbmQgc2FpZCBzbyAoSXNzdWUgIzI4ODQpLlxuICAgIGNhc2UgXCJjbG9uZV9jb3JydXB0XCI6XG4gICAgICByZXR1cm4gXCJIb3N0J3Mgc2hhcmVkIGNsb25lIG9mIHRoaXMgcmVwb3NpdG9yeSBpcyBkYW1hZ2VkIChicm9rZW4gcmVmcyBvciBjb3JydXB0IG9iamVjdCBzdG9yZSkg4oCUIHRoZSBzYW1lIGZhdWx0IG1lZXRzIGV2ZXJ5IGlzc3VlIG9uIHRoaXMgaG9zdDsgbm8gZmFpbGVkLW9uY2UvZmFpbGVkIHdhcyBhcHBsaWVkLCBidXQgdGhpcyBpc3N1ZSB3YXMgZXNjYWxhdGVkIHRvIG5lZWRzLWh1bWFuIChpdHMgcmVwYWlyIGF0dGVtcHQgZmFpbGVkLCBvciB0aGlzIHJ1bidzIG9uZSByZXBhaXIgYXR0ZW1wdCB3YXMgYWxyZWFkeSBzcGVudCkgYW5kIHN0YXlzIHBhcmtlZCB1bnRpbCBhIGh1bWFuIHJlbW92ZXMgdGhhdCBsYWJlbC5cIjtcbiAgICAvLyBEZWxpYmVyYXRlbHkgbm90IFwiTGlrZWx5IGNhdXNlXCI6IG5vdGhpbmcgd2FzIGd1ZXNzZWQuIFRoZSB3b3JrZXIncyBvd25cbiAgICAvLyBjb21wbGV0aW9uIGdhdGVzIHJlZnVzZWQgdGhlIHN1bW1hcnkgYW5kIG5hbWVkIGVhY2ggZ2FwIChJc3N1ZSAjMzQzMSkuXG4gICAgY2FzZSBcInN1bW1hcnlfaW5jb21wbGV0ZVwiOlxuICAgICAgcmV0dXJuIFwiVGhlIFBSIHN1bW1hcnkgZGlkIG5vdCBwYXNzIHRoZSB3b3JrZXIncyBjb21wbGV0aW9uIGdhdGVzIOKAlCBzZWUgdGhlIGdhdGUgY29tbWVudCBmb3IgZWFjaCBnYXAuXCI7XG4gICAgLy8gRGVsaWJlcmF0ZWx5IG5vdCBcIkxpa2VseSBjYXVzZVwiOiB0aGUgd29ya2VyJ3Mgb3duIHNlY3VyaXR5LWZpeCBnYXRlXG4gICAgLy8gcmVmdXNlZCB0aGUgcnVuIChJc3N1ZSAjMzQ1NCkuXG4gICAgY2FzZSBcInNlY3VyaXR5X2ZpeF9nYXRlXCI6XG4gICAgICByZXR1cm4gXCJUaGUgYWdlbnQgZGlkIG5vdCBkZWxpdmVyIHRoZSB2dWxuZXJhYmlsaXR5LWZpeCB2ZXJpZmljYXRpb24gZXZpZGVuY2UgdGhlIHdvcmtlcidzIHNlY3VyaXR5LWZpeCBnYXRlIHJlcXVpcmVzIOKAlCBub3QgYSB3b3JrZXIgZGVmZWN0LlwiO1xuICAgIC8vIERlbGliZXJhdGVseSBub3QgXCJMaWtlbHkgY2F1c2VcIjogdGhlIHdvcmtlcidzIG93biBwcmUtcHVzaCBnYXRlIGJsb2NrZWRcbiAgICAvLyB0aGUgYnJhbmNoIGFuZCBxdW90ZWQgdGhlIGZhaWxpbmcgY2hlY2sgKFBSICMzNzE2IHJldmlldykuXG4gICAgY2FzZSBcInByZV9wdXNoX2dhdGVcIjpcbiAgICAgIHJldHVybiBcIlRoZSBicmFuY2ggZGlkIG5vdCBwYXNzIHRoZSB3b3JrZXIncyBwcmUtcHVzaCBnYXRlIChjaGFuZ2VkLWZpbGUgY2hlY2tzIG9yIHRoZSByZXBvc2l0b3J5J3MgcHJlLWZsaWdodCBjb21tYW5kcykg4oCUIHNlZSB0aGUgcXVvdGVkIGNoZWNrIG91dHB1dCwgbm90IGEgd29ya2VyIGRlZmVjdC5cIjtcbiAgICAvLyBEZWxpYmVyYXRlbHkgbm90IFwiTGlrZWx5IGNhdXNlXCI6IHRoZSB3b3JrZXIncyBvd24gdW5tZXQtY3JpdGVyaWEgZ2F0ZVxuICAgIC8vIHJlZnVzZWQgdGhlIHJ1biBhbmQgbmFtZWQgZWFjaCBjcml0ZXJpb24gKElzc3VlICM0MTQ2KS5cbiAgICBjYXNlIFwiY3JpdGVyaWFfdW5tZXRcIjpcbiAgICAgIHJldHVybiBcIlRoZSBydW4gZGlkIG5vdCBtZWV0IGV2ZXJ5IGFjY2VwdGFuY2UgY3JpdGVyaW9uIOKAlCBubyBQUiB3YXMgcmFpc2VkOyB0aGUgbmV4dCBydW4gcmVzdW1lcyB0aGUgYnJhbmNoIHRvIGZpbmlzaCB0aGUgam9iLlwiO1xuICAgIGNhc2UgXCJpbnRlcm5hbF9lcnJvclwiOlxuICAgICAgcmV0dXJuIFwiTGlrZWx5IGNhdXNlOiBpbnRlcm5hbCB0b29saW5nIG9yIENMSSBlcnJvciAobm90IHJlbGF0ZWQgdG8gaXNzdWUgY29tcGxleGl0eSkuXCI7XG4gICAgY2FzZSBcInVua25vd25cIjpcbiAgICAgIHJldHVybiBcIkxpa2VseSBjYXVzZTogY291bGQgbm90IGJlIGF1dG9tYXRpY2FsbHkgZGV0ZXJtaW5lZCBcXHUyMDE0IHNlZSBkZXRhaWxzIGFib3ZlLlwiO1xuICAgIGRlZmF1bHQ6XG4gICAgICAvLyBFeGhhdXN0aXZlbmVzcyBndWFyZCAoSXNzdWUgIzI3OTQpOiBhIG5ldyBGYWlsdXJlQ2F0ZWdvcnkgbXVzdCBiZVxuICAgICAgLy8gaGFuZGxlZCBleHBsaWNpdGx5LiBDYWxsZXJzIHBhc3NpbmcgdW4tdmFsaWRhdGVkIGlucHV0IG11c3RcbiAgICAgIC8vIG5vcm1hbGlzZSB2aWEgbm9ybWFsaXNlRmFpbHVyZUNhdGVnb3J5KCkgZmlyc3QuXG4gICAgICByZXR1cm4gYXNzZXJ0TmV2ZXIoY2F0ZWdvcnkpO1xuICB9XG59XG5cbi8qKlxuICogRXh0cmFjdCB0aGUgbW9zdCByZWxldmFudCBlcnJvciBsaW5lcyBmcm9tIGZhaWx1cmUgb3V0cHV0LlxuICpcbiAqIFNjYW5zIHRoZSBpbnB1dCB0ZXh0IGZvciBsaW5lcyBtYXRjaGluZyBjb21tb24gZXJyb3IgcGF0dGVybnMgYW5kIHJldHVybnNcbiAqIHVwIHRvIDEwIGtleSBsaW5lcyBmb3IgcHJvbWluZW50IGRpc3BsYXkgaW4gZmFpbHVyZSBjb21tZW50cy5cbiAqXG4gKiBJc3N1ZSAjNzMzIOKAlCBTdXJmYWNlIGVycm9yIGRldGFpbHMgcHJvbWluZW50bHkgaW4gZmFpbHVyZSBjb21tZW50cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RLZXlFcnJvckxpbmVzKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghdGV4dCkgcmV0dXJuIFwiXCI7XG5cbiAgY29uc3QgZXJyb3JQYXR0ZXJuID1cbiAgICAvKF58XFxzKShFcnJvcjp8ZXJyb3I6fGZhdGFsOnxGQUlMXFxzfEZBSUxFRHxub3Qgb2sgXFxkKXxcXGQrIHRlc3RzPyBmYWlsZWR8ZXJyb3IgVFNcXGQrLztcblxuICBjb25zdCBsaW5lcyA9IHRleHQuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IG1hdGNoZXM6IHN0cmluZ1tdID0gW107XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgaWYgKG1hdGNoZXMubGVuZ3RoID49IDEwKSBicmVhaztcbiAgICBpZiAoZXJyb3JQYXR0ZXJuLnRlc3QobGluZSkpIHtcbiAgICAgIG1hdGNoZXMucHVzaChsaW5lKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gbWF0Y2hlcy5qb2luKFwiXFxuXCIpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Q0FTQyxHQUVELFNBQVMsV0FBVyxRQUFRLG9CQUFvQjtBQUNoRCxTQUFTLDBCQUEwQixRQUFRLHNCQUFzQjtBQUNqRSxTQUFTLGlDQUFpQyxRQUFRLGtDQUFrQztBQUNwRixTQUVFLDZCQUE2QixRQUN4QixtQ0FBbUM7QUFFMUM7Ozs7O0NBS0MsR0FD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
// denoCacheMetadata=5195716010578773989,5580745904191987321