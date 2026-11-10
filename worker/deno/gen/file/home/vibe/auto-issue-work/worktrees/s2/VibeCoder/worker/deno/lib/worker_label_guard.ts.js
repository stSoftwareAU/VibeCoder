/**
 * Worker label allowlist guard (Issue #2382 — Rule of Two).
 *
 * Defence-in-depth complement to `label_security.ts`. Where
 * `label_security.ts` strips operational labels added by untrusted actors
 * on the *next* scan, this guard runs *in-process before* the worker
 * itself ever calls the labels API — refusing the mutation up front and
 * emitting a `[SECURITY]` audit line. Even if a prompt regression or a
 * compromised dependency tried to add `top-priority` / `work-on` /
 * `planning` / `best-model` / `question` to an issue, the call would
 * never reach GitHub.
 *
 * Call sites: `addLabelToIssue` (`label_operations.ts`) and
 * `escalateToHuman` (`needs_human_escalation.ts`) both assert through this
 * guard before any label mutation, so the invariant holds for every
 * worker-applied label rather than only for callers who opted in
 * (Issue #13). The planning hand-off (`planning_handoff.ts`, Issue #2688)
 * asserts through {@link assertWorkerCanHandOffToPlanning} instead — a
 * separate, audited check that admits `planning` and nothing else.
 *
 * Issue #1276 closed the other half of that invariant. Those two call sites
 * only cover labels applied to an **existing** issue; the scan and idle-task
 * templates apply theirs at *creation* time via `gh issue create --label`,
 * which never reached this guard. Those creation paths now build their label
 * arguments with `guardedLabelArgs` (`guarded_issue_labels.ts`), which
 * asserts through this module, and the `issue-create label guard` quality
 * check fails the build on any new `--label` argument that skips it.
 *
 * Scope: this guard runs **in the worker's own process**. The agent
 * subprocess has its own `gh` and its own credentials, so it is covered
 * separately by the PATH shim in `gh_guard_shim.ts` (Issue #3643), which
 * enforces {@link WORKER_FORBIDDEN_LABEL_LITERALS} as a denylist on agent
 * `gh` mutations — a denylist rather than the positive list below, because
 * the agent legitimately files scan findings with content labels this
 * module's call-site-derived allowlist does not enumerate.
 *
 * The allowlist is a positive list: literal label names the worker may
 * apply, plus a small set of prefixes covering the security-scan,
 * best-practices, test-audit and github-actions-audit pipelines. Anything
 * else is rejected.
 *
 * The acceptance criteria for #2382 require runtime guards (with unit
 * tests) for the highest-blast-radius operations the worker must never
 * perform; self-applying an operational workflow label is the
 * blast-radius case this guard covers.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { recordMutation, resolveRunId } from "./audit_journal.ts";
import { isAuditJournalEnabled } from "./audit_hook.ts";
import { processEnvLookup } from "./env_lookup.ts";
import { PLANNING_HANDOFF_LABEL } from "./planning_handoff_trust.ts";
/**
 * Literal label names the worker may apply to an existing issue.
 *
 * Curated from every `addLabelToIssue` call site in `worker/deno/lib/` and
 * `worker/deno/setup/`:
 *   - `failed`, `failed-once` — failure tracking (`label_failure.ts`,
 *     `label_question_failure.ts`, `claim_issue.ts`).
 *   - `needs-human` — worker → human escalation, for a DECISION a person must
 *     make (a policy call, a credential, confirming intent)
 *   - `escalated` — the fleet filed this PR's blockage as work and is still
 *     the actor (Issue #569). Deliberately distinct from `needs-human`, which
 *     other lanes treat as "hands off": a mechanical stall must not remove a
 *     PR from the queue of the lane that could fix it
 *     (`needs_human_escalation.ts`, `gh_escalation_client.ts`).
 *   - `needs-screenshot` — screenshot-gate signal (UI changes).
 *   - `idle-task` — the only operational label the worker self-applies
 *     (Issue #1959 framework requirement).
 *   - `negative-result` — performance-task close-out (no measurable
 *     gain — coding-guidelines workflow).
 *   - `best-practices`, `security`, `test-audit`,
 *     `github-actions-audit` — content tags for scan-template findings
 *     and the wrapper issues those templates file.
 *   - `degraded-model` — non-reserved signal the planning flow applies to
 *     the parent issue and every sub-issue when a planning run was served
 *     by a model other than the configured planning model (Issue #2650).
 *   - `merge-conflict` — visible queue marker the conflict-resolution pass
 *     applies to a PR stuck at `mergeable == CONFLICTING`, so the stuck
 *     set is readable at a glance instead of buried in per-pass log noise
 *     (Issue #84).
 *   - `needs-failure-detection-repair` — the resumable marker the planning
 *     flow raises on a parent whose published sub-issues still lack their
 *     `## Failure Detection` criterion, and the Priority 1.81 resume pass
 *     clears once the repairs are finished (Issues #59, #60).
 *   - `blocked` — the visible fallback `deferBlockedIssue` applies when the
 *     `Depends on owner/repo#N` line cannot be written to the issue body, so
 *     a deferral stays legible (Issue #222). Listed here by Issue #1219: the
 *     worker already applied it, but through a direct `ghClient.addLabel`
 *     that skipped this guard entirely, so the allowlist did not describe
 *     what the worker actually did. Same class as `merge-conflict` — a
 *     worker-owned queue marker, not a pickup-priority label.
 */ export const WORKER_APPLIABLE_LABEL_LITERALS = new Set([
  "failed",
  "failed-once",
  "needs-human",
  "escalated",
  "needs-screenshot",
  "idle-task",
  "negative-result",
  "best-practices",
  "security",
  "test-audit",
  "github-actions-audit",
  "degraded-model",
  "merge-conflict",
  "needs-failure-detection-repair",
  "blocked"
]);
/**
 * Content labels the worker may apply — the descriptive tag each scan or
 * idle-task template attaches to the finding issue it files (Issue #1276).
 *
 * These are applied at `gh issue create --label` time rather than to an
 * existing issue, so before #1276 none of them passed this guard at all.
 * They are deliberately kept in their own set: they classify *what the
 * finding is about*, whereas {@link WORKER_APPLIABLE_LABEL_LITERALS}
 * carries the worker's operational signals. Both are accepted by
 * {@link isWorkerAppliableLabel}.
 *
 * One entry per template `outputLabel` (`lib/idle_task_templates/`), plus
 * the two non-template filers (`alert_feeds/alert_feed_enable_issue.ts`,
 * `security_tree_sweep.ts`) and the two generic issue-type tags the run
 * failure filer and the planning carrier apply.
 */ export const WORKER_APPLIABLE_CONTENT_LABELS = new Set([
  "alert-feed",
  "bash-missing-script",
  "bash-syntax-audit",
  "bug",
  "dead-code",
  "deprecated-api",
  "doc-coverage",
  "documentation-audit",
  "duplicated-knowledge",
  "enable-feed",
  "enhancement",
  "format-drift",
  "gate-skip-drift",
  "ponytail-debt",
  // Issue #2304: the flag every merge-conflict fallback files, so a closed
  // PR or a reverted child is a record rather than a silence.
  "merge-fallback",
  "orphan-deps",
  "private-repo-reference",
  "retro",
  "security-tree-sweep",
  "supply-chain-readiness",
  "workflow-annotation-scan"
]);
/**
 * Label name prefixes the worker may apply.
 *
 * Used by the scan templates to attach derived classification labels to
 * filed finding issues:
 *   - `severity:` — `severity:high`/`medium`/`low` from every scan
 *     template (`best_practices_sync.ts`, security scan).
 *   - `lang:` — `lang:<bucket>` from the best-practices template
 *     (`lang:rust`, `lang:typescript`, …).
 *   - `supply-chain:` — `supply-chain:quarantine-missing` /
 *     `supply-chain:quarantine-misconfigured` from the security scan's
 *     Phase 2 dependency-update audit (Issue #1933 family).
 *   - `confidence:` — `confidence:high`/`medium`/`low` from the security
 *     tree sweep's filed clusters (Issue #1276).
 */ export const WORKER_APPLIABLE_LABEL_PREFIXES = [
  "severity:",
  "lang:",
  "supply-chain:",
  "confidence:"
];
/**
 * Labels the worker is **explicitly forbidden** from applying — listed
 * here for documentation and so tests can exhaustively assert the guard
 * rejects them. These are the canonical pickup-priority and workflow
 * labels managed by trusted humans; any of these added by the worker is
 * silently stripped on the next scan — the operational labels by
 * `label_security.ts` (`verifyOperationalLabels`, Issue #3225) and the
 * reserved discovery labels (`top-priority`/`work-on`/`low-priority`) by the
 * discovery collectors' `wasLabelAddedByAllowedAuthor` gate (Issue #3416).
 *
 * Both gates treat every `fleetWorkerLogins` login as untrusted, so the
 * strip holds even in a multi-account fleet where the worker's own login is
 * required in `allowed_authors` for PR-dedup (Issue #3138) — the earlier
 * "the worker account is not on the allowlist" assumption is false there.
 *
 * This list IS consulted at runtime, and the claim that it is not was wrong
 * (Issue #1422). `isWorkerAppliableLabel` — the worker's own positive check —
 * does not read it, which is what the old wording meant. But
 * `gh_guard_decision.ts` builds the agent subprocess's `FORBIDDEN_LABELS`
 * denylist from it, and the `gh` PATH shim re-enters that check for every
 * label mutation the agent issues directly. Calling it "informational" is
 * plausibly why it was allowed to drift from `RESERVED_LABELS` while the
 * agent guard depended on it.
 *
 * Adding an entry here therefore changes what the agent may do. The guard
 * takes the UNION of this list and `RESERVED_LABELS`, so this list is the
 * place for a label that is forbidden to the agent but not otherwise
 * reserved — `best-model` is the current example.
 *
 * `planning` stays here (Issue #2688). The worker's one audited way to apply
 * it is {@link assertWorkerCanHandOffToPlanning}, used only when a `work-on`
 * issue proves too large for one PR; `isWorkerPlanningHandoff` then trusts
 * that add only while a trusted human's `work-on` still anchors it.
 */ export const WORKER_FORBIDDEN_LABEL_LITERALS = [
  "top-priority",
  "work-on",
  "low-priority",
  "planning",
  "refine-issue",
  "question",
  "answered",
  "needs-revision",
  "best-model",
  // Issue #4112: `quorum` starts a three-agent plan-off — human-applied only.
  "quorum"
];
/**
 * Return true if the worker is allowed to apply `label` — whether to an
 * existing issue or at `gh issue create` time (Issue #1276). Pure — no side
 * effects, no async — so callers can compose it freely.
 */ export function isWorkerAppliableLabel(label) {
  // Issue #3088: GitHub treats label names case-insensitively, so the guard
  // must match the same way (the literal set and prefixes are all lower-case).
  // Without this, a non-lower-case label slips past the literal allowlist —
  // either wrongly refused, or (for a reserved-name variant) honoured by the
  // dispatch gate while skipping the strip guards.
  const lower = label.toLowerCase();
  if (WORKER_APPLIABLE_LABEL_LITERALS.has(lower)) return true;
  if (WORKER_APPLIABLE_CONTENT_LABELS.has(lower)) return true;
  for (const prefix of WORKER_APPLIABLE_LABEL_PREFIXES){
    if (lower.startsWith(prefix) && lower.length > prefix.length) {
      return true;
    }
  }
  return false;
}
/** Audit-journal verb for a label the worker refused to apply (Issue #1604). */ export const WORKER_LABEL_REFUSAL_AUDIT_VERB = "worker-label-refused";
/**
 * Default audit sink for a refused label (Issue #1604): append to the
 * worker's journal when it is on, and report nothing to do when it is off —
 * unit tests without `WORK_DIR` therefore incur no journalling side effect,
 * exactly as the `gh`/`git` chokepoint hooks behave.
 */ export function journalLabelRefusal(mutation, env = processEnvLookup) {
  if (!isAuditJournalEnabled(env)) {
    return Promise.resolve({
      ok: true,
      value: undefined
    });
  }
  return recordMutation(mutation, {
    env
  });
}
/** Record a guard decision without blocking; a failed append is logged. */ function journalGuardDecision(verb, outcome, target, record, log) {
  const refused = (message)=>log(`[SECURITY] [AUDIT_JOURNAL_REFUSED] ${verb}: ${message}`);
  void record({
    runId: resolveRunId(),
    verb,
    outcome,
    target,
    caller: "worker/deno/lib/worker_label_guard.ts"
  }).then((result)=>{
    if (!result.ok) refused(result.error.message);
  }, (err)=>refused(err instanceof Error ? err.message : String(err)));
}
/**
 * Assert that the worker may apply `label`. Returns a `Result`:
 *   - `ok: true` when allowed (no log line emitted).
 *   - `ok: false, error: ...` when refused, after emitting a
 *     `[SECURITY] [WORKER_LABEL_REFUSED]` line to stderr so a reviewer
 *     can grep production logs for blocked self-application attempts.
 *
 * Optional `context` (callsite hint such as the calling file path) is
 * included in the audit line. Optional `logFn` lets tests capture the
 * line without inheriting the real `console.warn` plumbing.
 */ export function assertWorkerCanApplyLabel(label, context = {}) {
  if (isWorkerAppliableLabel(label)) {
    return {
      ok: true,
      value: undefined
    };
  }
  const log = context.logFn ?? ((line)=>console.warn(line));
  const caller = context.caller ?? "unknown";
  log(`[SECURITY] [WORKER_LABEL_REFUSED] label=${label} caller=${caller} ` + `reason=not_in_worker_allowlist`);
  // Issue #1604: the stderr line above is transient; the journal is the
  // durable, tamper-evident record control C16 promises for a blocked
  // mutation. Best-effort and off the caller's critical path — this function
  // stays synchronous — but a failed append is said out loud, never hidden.
  journalGuardDecision(WORKER_LABEL_REFUSAL_AUDIT_VERB, "error", `label=${label} caller=${caller}`, context.record ?? journalLabelRefusal, log);
  return {
    ok: false,
    error: new Error(`Worker is not authorised to apply the '${label}' label — ` + `only failure-tracking, escalation, and scan-content labels are ` + `allowed (see worker/deno/lib/worker_label_guard.ts).`)
  };
}
/** Audit-journal verb for the worker's planning hand-off (Issue #2688). */ export const WORKER_PLANNING_HANDOFF_AUDIT_VERB = "worker-planning-handoff";
/**
 * Assert that the worker may hand its own `work-on` issue to `planning`
 * (Issue #2688) — the single, audited exception to the reserved-label ban.
 *
 * `planning` stays out of {@link isWorkerAppliableLabel}, so no general
 * label path can apply it; only the hand-off flow (`planning_handoff.ts`)
 * calls this. Every allowed hand-off emits a
 * `[SECURITY] [WORKER_PLANNING_HANDOFF]` line and a `success` journal entry;
 * any other label is refused exactly as {@link assertWorkerCanApplyLabel}
 * refuses it. `label_security.ts` honours the resulting label only while a
 * trusted, non-worker `work-on` add still anchors it
 * (`planning_handoff_trust.ts`).
 */ export function assertWorkerCanHandOffToPlanning(label, context = {}) {
  const log = context.logFn ?? ((line)=>console.warn(line));
  const caller = context.caller ?? "unknown";
  if (label.toLowerCase() !== PLANNING_HANDOFF_LABEL) {
    log(`[SECURITY] [WORKER_LABEL_REFUSED] label=${label} caller=${caller} ` + `reason=not_the_planning_handoff_label`);
    journalGuardDecision(WORKER_LABEL_REFUSAL_AUDIT_VERB, "error", `label=${label} caller=${caller}`, context.record ?? journalLabelRefusal, log);
    return {
      ok: false,
      error: new Error(`The planning hand-off may only apply 'planning', not '${label}'.`)
    };
  }
  const target = context.target ?? "unknown";
  log(`[SECURITY] [WORKER_PLANNING_HANDOFF] label=${label} target=${target} ` + `caller=${caller}`);
  journalGuardDecision(WORKER_PLANNING_HANDOFF_AUDIT_VERB, "success", `label=${label} target=${target} caller=${caller}`, context.record ?? journalLabelRefusal, log);
  return {
    ok: true,
    value: undefined
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi93b3JrZXJfbGFiZWxfZ3VhcmQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBXb3JrZXIgbGFiZWwgYWxsb3dsaXN0IGd1YXJkIChJc3N1ZSAjMjM4MiDigJQgUnVsZSBvZiBUd28pLlxuICpcbiAqIERlZmVuY2UtaW4tZGVwdGggY29tcGxlbWVudCB0byBgbGFiZWxfc2VjdXJpdHkudHNgLiBXaGVyZVxuICogYGxhYmVsX3NlY3VyaXR5LnRzYCBzdHJpcHMgb3BlcmF0aW9uYWwgbGFiZWxzIGFkZGVkIGJ5IHVudHJ1c3RlZCBhY3RvcnNcbiAqIG9uIHRoZSAqbmV4dCogc2NhbiwgdGhpcyBndWFyZCBydW5zICppbi1wcm9jZXNzIGJlZm9yZSogdGhlIHdvcmtlclxuICogaXRzZWxmIGV2ZXIgY2FsbHMgdGhlIGxhYmVscyBBUEkg4oCUIHJlZnVzaW5nIHRoZSBtdXRhdGlvbiB1cCBmcm9udCBhbmRcbiAqIGVtaXR0aW5nIGEgYFtTRUNVUklUWV1gIGF1ZGl0IGxpbmUuIEV2ZW4gaWYgYSBwcm9tcHQgcmVncmVzc2lvbiBvciBhXG4gKiBjb21wcm9taXNlZCBkZXBlbmRlbmN5IHRyaWVkIHRvIGFkZCBgdG9wLXByaW9yaXR5YCAvIGB3b3JrLW9uYCAvXG4gKiBgcGxhbm5pbmdgIC8gYGJlc3QtbW9kZWxgIC8gYHF1ZXN0aW9uYCB0byBhbiBpc3N1ZSwgdGhlIGNhbGwgd291bGRcbiAqIG5ldmVyIHJlYWNoIEdpdEh1Yi5cbiAqXG4gKiBDYWxsIHNpdGVzOiBgYWRkTGFiZWxUb0lzc3VlYCAoYGxhYmVsX29wZXJhdGlvbnMudHNgKSBhbmRcbiAqIGBlc2NhbGF0ZVRvSHVtYW5gIChgbmVlZHNfaHVtYW5fZXNjYWxhdGlvbi50c2ApIGJvdGggYXNzZXJ0IHRocm91Z2ggdGhpc1xuICogZ3VhcmQgYmVmb3JlIGFueSBsYWJlbCBtdXRhdGlvbiwgc28gdGhlIGludmFyaWFudCBob2xkcyBmb3IgZXZlcnlcbiAqIHdvcmtlci1hcHBsaWVkIGxhYmVsIHJhdGhlciB0aGFuIG9ubHkgZm9yIGNhbGxlcnMgd2hvIG9wdGVkIGluXG4gKiAoSXNzdWUgIzEzKS4gVGhlIHBsYW5uaW5nIGhhbmQtb2ZmIChgcGxhbm5pbmdfaGFuZG9mZi50c2AsIElzc3VlICMyNjg4KVxuICogYXNzZXJ0cyB0aHJvdWdoIHtAbGluayBhc3NlcnRXb3JrZXJDYW5IYW5kT2ZmVG9QbGFubmluZ30gaW5zdGVhZCDigJQgYVxuICogc2VwYXJhdGUsIGF1ZGl0ZWQgY2hlY2sgdGhhdCBhZG1pdHMgYHBsYW5uaW5nYCBhbmQgbm90aGluZyBlbHNlLlxuICpcbiAqIElzc3VlICMxMjc2IGNsb3NlZCB0aGUgb3RoZXIgaGFsZiBvZiB0aGF0IGludmFyaWFudC4gVGhvc2UgdHdvIGNhbGwgc2l0ZXNcbiAqIG9ubHkgY292ZXIgbGFiZWxzIGFwcGxpZWQgdG8gYW4gKipleGlzdGluZyoqIGlzc3VlOyB0aGUgc2NhbiBhbmQgaWRsZS10YXNrXG4gKiB0ZW1wbGF0ZXMgYXBwbHkgdGhlaXJzIGF0ICpjcmVhdGlvbiogdGltZSB2aWEgYGdoIGlzc3VlIGNyZWF0ZSAtLWxhYmVsYCxcbiAqIHdoaWNoIG5ldmVyIHJlYWNoZWQgdGhpcyBndWFyZC4gVGhvc2UgY3JlYXRpb24gcGF0aHMgbm93IGJ1aWxkIHRoZWlyIGxhYmVsXG4gKiBhcmd1bWVudHMgd2l0aCBgZ3VhcmRlZExhYmVsQXJnc2AgKGBndWFyZGVkX2lzc3VlX2xhYmVscy50c2ApLCB3aGljaFxuICogYXNzZXJ0cyB0aHJvdWdoIHRoaXMgbW9kdWxlLCBhbmQgdGhlIGBpc3N1ZS1jcmVhdGUgbGFiZWwgZ3VhcmRgIHF1YWxpdHlcbiAqIGNoZWNrIGZhaWxzIHRoZSBidWlsZCBvbiBhbnkgbmV3IGAtLWxhYmVsYCBhcmd1bWVudCB0aGF0IHNraXBzIGl0LlxuICpcbiAqIFNjb3BlOiB0aGlzIGd1YXJkIHJ1bnMgKippbiB0aGUgd29ya2VyJ3Mgb3duIHByb2Nlc3MqKi4gVGhlIGFnZW50XG4gKiBzdWJwcm9jZXNzIGhhcyBpdHMgb3duIGBnaGAgYW5kIGl0cyBvd24gY3JlZGVudGlhbHMsIHNvIGl0IGlzIGNvdmVyZWRcbiAqIHNlcGFyYXRlbHkgYnkgdGhlIFBBVEggc2hpbSBpbiBgZ2hfZ3VhcmRfc2hpbS50c2AgKElzc3VlICMzNjQzKSwgd2hpY2hcbiAqIGVuZm9yY2VzIHtAbGluayBXT1JLRVJfRk9SQklEREVOX0xBQkVMX0xJVEVSQUxTfSBhcyBhIGRlbnlsaXN0IG9uIGFnZW50XG4gKiBgZ2hgIG11dGF0aW9ucyDigJQgYSBkZW55bGlzdCByYXRoZXIgdGhhbiB0aGUgcG9zaXRpdmUgbGlzdCBiZWxvdywgYmVjYXVzZVxuICogdGhlIGFnZW50IGxlZ2l0aW1hdGVseSBmaWxlcyBzY2FuIGZpbmRpbmdzIHdpdGggY29udGVudCBsYWJlbHMgdGhpc1xuICogbW9kdWxlJ3MgY2FsbC1zaXRlLWRlcml2ZWQgYWxsb3dsaXN0IGRvZXMgbm90IGVudW1lcmF0ZS5cbiAqXG4gKiBUaGUgYWxsb3dsaXN0IGlzIGEgcG9zaXRpdmUgbGlzdDogbGl0ZXJhbCBsYWJlbCBuYW1lcyB0aGUgd29ya2VyIG1heVxuICogYXBwbHksIHBsdXMgYSBzbWFsbCBzZXQgb2YgcHJlZml4ZXMgY292ZXJpbmcgdGhlIHNlY3VyaXR5LXNjYW4sXG4gKiBiZXN0LXByYWN0aWNlcywgdGVzdC1hdWRpdCBhbmQgZ2l0aHViLWFjdGlvbnMtYXVkaXQgcGlwZWxpbmVzLiBBbnl0aGluZ1xuICogZWxzZSBpcyByZWplY3RlZC5cbiAqXG4gKiBUaGUgYWNjZXB0YW5jZSBjcml0ZXJpYSBmb3IgIzIzODIgcmVxdWlyZSBydW50aW1lIGd1YXJkcyAod2l0aCB1bml0XG4gKiB0ZXN0cykgZm9yIHRoZSBoaWdoZXN0LWJsYXN0LXJhZGl1cyBvcGVyYXRpb25zIHRoZSB3b3JrZXIgbXVzdCBuZXZlclxuICogcGVyZm9ybTsgc2VsZi1hcHBseWluZyBhbiBvcGVyYXRpb25hbCB3b3JrZmxvdyBsYWJlbCBpcyB0aGVcbiAqIGJsYXN0LXJhZGl1cyBjYXNlIHRoaXMgZ3VhcmQgY292ZXJzLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHR5cGUgeyBBdWRpdE11dGF0aW9uIH0gZnJvbSBcIi4vYXVkaXRfZW50cnkudHNcIjtcbmltcG9ydCB7IHJlY29yZE11dGF0aW9uLCByZXNvbHZlUnVuSWQgfSBmcm9tIFwiLi9hdWRpdF9qb3VybmFsLnRzXCI7XG5pbXBvcnQgeyBpc0F1ZGl0Sm91cm5hbEVuYWJsZWQgfSBmcm9tIFwiLi9hdWRpdF9ob29rLnRzXCI7XG5pbXBvcnQgeyB0eXBlIEVudkxvb2t1cCwgcHJvY2Vzc0Vudkxvb2t1cCB9IGZyb20gXCIuL2Vudl9sb29rdXAudHNcIjtcbmltcG9ydCB7IFBMQU5OSU5HX0hBTkRPRkZfTEFCRUwgfSBmcm9tIFwiLi9wbGFubmluZ19oYW5kb2ZmX3RydXN0LnRzXCI7XG5cbi8qKlxuICogTGl0ZXJhbCBsYWJlbCBuYW1lcyB0aGUgd29ya2VyIG1heSBhcHBseSB0byBhbiBleGlzdGluZyBpc3N1ZS5cbiAqXG4gKiBDdXJhdGVkIGZyb20gZXZlcnkgYGFkZExhYmVsVG9Jc3N1ZWAgY2FsbCBzaXRlIGluIGB3b3JrZXIvZGVuby9saWIvYCBhbmRcbiAqIGB3b3JrZXIvZGVuby9zZXR1cC9gOlxuICogICAtIGBmYWlsZWRgLCBgZmFpbGVkLW9uY2VgIOKAlCBmYWlsdXJlIHRyYWNraW5nIChgbGFiZWxfZmFpbHVyZS50c2AsXG4gKiAgICAgYGxhYmVsX3F1ZXN0aW9uX2ZhaWx1cmUudHNgLCBgY2xhaW1faXNzdWUudHNgKS5cbiAqICAgLSBgbmVlZHMtaHVtYW5gIOKAlCB3b3JrZXIg4oaSIGh1bWFuIGVzY2FsYXRpb24sIGZvciBhIERFQ0lTSU9OIGEgcGVyc29uIG11c3RcbiAqICAgICBtYWtlIChhIHBvbGljeSBjYWxsLCBhIGNyZWRlbnRpYWwsIGNvbmZpcm1pbmcgaW50ZW50KVxuICogICAtIGBlc2NhbGF0ZWRgIOKAlCB0aGUgZmxlZXQgZmlsZWQgdGhpcyBQUidzIGJsb2NrYWdlIGFzIHdvcmsgYW5kIGlzIHN0aWxsXG4gKiAgICAgdGhlIGFjdG9yIChJc3N1ZSAjNTY5KS4gRGVsaWJlcmF0ZWx5IGRpc3RpbmN0IGZyb20gYG5lZWRzLWh1bWFuYCwgd2hpY2hcbiAqICAgICBvdGhlciBsYW5lcyB0cmVhdCBhcyBcImhhbmRzIG9mZlwiOiBhIG1lY2hhbmljYWwgc3RhbGwgbXVzdCBub3QgcmVtb3ZlIGFcbiAqICAgICBQUiBmcm9tIHRoZSBxdWV1ZSBvZiB0aGUgbGFuZSB0aGF0IGNvdWxkIGZpeCBpdFxuICogICAgIChgbmVlZHNfaHVtYW5fZXNjYWxhdGlvbi50c2AsIGBnaF9lc2NhbGF0aW9uX2NsaWVudC50c2ApLlxuICogICAtIGBuZWVkcy1zY3JlZW5zaG90YCDigJQgc2NyZWVuc2hvdC1nYXRlIHNpZ25hbCAoVUkgY2hhbmdlcykuXG4gKiAgIC0gYGlkbGUtdGFza2Ag4oCUIHRoZSBvbmx5IG9wZXJhdGlvbmFsIGxhYmVsIHRoZSB3b3JrZXIgc2VsZi1hcHBsaWVzXG4gKiAgICAgKElzc3VlICMxOTU5IGZyYW1ld29yayByZXF1aXJlbWVudCkuXG4gKiAgIC0gYG5lZ2F0aXZlLXJlc3VsdGAg4oCUIHBlcmZvcm1hbmNlLXRhc2sgY2xvc2Utb3V0IChubyBtZWFzdXJhYmxlXG4gKiAgICAgZ2FpbiDigJQgY29kaW5nLWd1aWRlbGluZXMgd29ya2Zsb3cpLlxuICogICAtIGBiZXN0LXByYWN0aWNlc2AsIGBzZWN1cml0eWAsIGB0ZXN0LWF1ZGl0YCxcbiAqICAgICBgZ2l0aHViLWFjdGlvbnMtYXVkaXRgIOKAlCBjb250ZW50IHRhZ3MgZm9yIHNjYW4tdGVtcGxhdGUgZmluZGluZ3NcbiAqICAgICBhbmQgdGhlIHdyYXBwZXIgaXNzdWVzIHRob3NlIHRlbXBsYXRlcyBmaWxlLlxuICogICAtIGBkZWdyYWRlZC1tb2RlbGAg4oCUIG5vbi1yZXNlcnZlZCBzaWduYWwgdGhlIHBsYW5uaW5nIGZsb3cgYXBwbGllcyB0b1xuICogICAgIHRoZSBwYXJlbnQgaXNzdWUgYW5kIGV2ZXJ5IHN1Yi1pc3N1ZSB3aGVuIGEgcGxhbm5pbmcgcnVuIHdhcyBzZXJ2ZWRcbiAqICAgICBieSBhIG1vZGVsIG90aGVyIHRoYW4gdGhlIGNvbmZpZ3VyZWQgcGxhbm5pbmcgbW9kZWwgKElzc3VlICMyNjUwKS5cbiAqICAgLSBgbWVyZ2UtY29uZmxpY3RgIOKAlCB2aXNpYmxlIHF1ZXVlIG1hcmtlciB0aGUgY29uZmxpY3QtcmVzb2x1dGlvbiBwYXNzXG4gKiAgICAgYXBwbGllcyB0byBhIFBSIHN0dWNrIGF0IGBtZXJnZWFibGUgPT0gQ09ORkxJQ1RJTkdgLCBzbyB0aGUgc3R1Y2tcbiAqICAgICBzZXQgaXMgcmVhZGFibGUgYXQgYSBnbGFuY2UgaW5zdGVhZCBvZiBidXJpZWQgaW4gcGVyLXBhc3MgbG9nIG5vaXNlXG4gKiAgICAgKElzc3VlICM4NCkuXG4gKiAgIC0gYG5lZWRzLWZhaWx1cmUtZGV0ZWN0aW9uLXJlcGFpcmAg4oCUIHRoZSByZXN1bWFibGUgbWFya2VyIHRoZSBwbGFubmluZ1xuICogICAgIGZsb3cgcmFpc2VzIG9uIGEgcGFyZW50IHdob3NlIHB1Ymxpc2hlZCBzdWItaXNzdWVzIHN0aWxsIGxhY2sgdGhlaXJcbiAqICAgICBgIyMgRmFpbHVyZSBEZXRlY3Rpb25gIGNyaXRlcmlvbiwgYW5kIHRoZSBQcmlvcml0eSAxLjgxIHJlc3VtZSBwYXNzXG4gKiAgICAgY2xlYXJzIG9uY2UgdGhlIHJlcGFpcnMgYXJlIGZpbmlzaGVkIChJc3N1ZXMgIzU5LCAjNjApLlxuICogICAtIGBibG9ja2VkYCDigJQgdGhlIHZpc2libGUgZmFsbGJhY2sgYGRlZmVyQmxvY2tlZElzc3VlYCBhcHBsaWVzIHdoZW4gdGhlXG4gKiAgICAgYERlcGVuZHMgb24gb3duZXIvcmVwbyNOYCBsaW5lIGNhbm5vdCBiZSB3cml0dGVuIHRvIHRoZSBpc3N1ZSBib2R5LCBzb1xuICogICAgIGEgZGVmZXJyYWwgc3RheXMgbGVnaWJsZSAoSXNzdWUgIzIyMikuIExpc3RlZCBoZXJlIGJ5IElzc3VlICMxMjE5OiB0aGVcbiAqICAgICB3b3JrZXIgYWxyZWFkeSBhcHBsaWVkIGl0LCBidXQgdGhyb3VnaCBhIGRpcmVjdCBgZ2hDbGllbnQuYWRkTGFiZWxgXG4gKiAgICAgdGhhdCBza2lwcGVkIHRoaXMgZ3VhcmQgZW50aXJlbHksIHNvIHRoZSBhbGxvd2xpc3QgZGlkIG5vdCBkZXNjcmliZVxuICogICAgIHdoYXQgdGhlIHdvcmtlciBhY3R1YWxseSBkaWQuIFNhbWUgY2xhc3MgYXMgYG1lcmdlLWNvbmZsaWN0YCDigJQgYVxuICogICAgIHdvcmtlci1vd25lZCBxdWV1ZSBtYXJrZXIsIG5vdCBhIHBpY2t1cC1wcmlvcml0eSBsYWJlbC5cbiAqL1xuZXhwb3J0IGNvbnN0IFdPUktFUl9BUFBMSUFCTEVfTEFCRUxfTElURVJBTFM6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcbiAgXCJmYWlsZWRcIixcbiAgXCJmYWlsZWQtb25jZVwiLFxuICBcIm5lZWRzLWh1bWFuXCIsXG4gIFwiZXNjYWxhdGVkXCIsXG4gIFwibmVlZHMtc2NyZWVuc2hvdFwiLFxuICBcImlkbGUtdGFza1wiLFxuICBcIm5lZ2F0aXZlLXJlc3VsdFwiLFxuICBcImJlc3QtcHJhY3RpY2VzXCIsXG4gIFwic2VjdXJpdHlcIixcbiAgXCJ0ZXN0LWF1ZGl0XCIsXG4gIFwiZ2l0aHViLWFjdGlvbnMtYXVkaXRcIixcbiAgXCJkZWdyYWRlZC1tb2RlbFwiLFxuICBcIm1lcmdlLWNvbmZsaWN0XCIsXG4gIFwibmVlZHMtZmFpbHVyZS1kZXRlY3Rpb24tcmVwYWlyXCIsXG4gIFwiYmxvY2tlZFwiLFxuXSk7XG5cbi8qKlxuICogQ29udGVudCBsYWJlbHMgdGhlIHdvcmtlciBtYXkgYXBwbHkg4oCUIHRoZSBkZXNjcmlwdGl2ZSB0YWcgZWFjaCBzY2FuIG9yXG4gKiBpZGxlLXRhc2sgdGVtcGxhdGUgYXR0YWNoZXMgdG8gdGhlIGZpbmRpbmcgaXNzdWUgaXQgZmlsZXMgKElzc3VlICMxMjc2KS5cbiAqXG4gKiBUaGVzZSBhcmUgYXBwbGllZCBhdCBgZ2ggaXNzdWUgY3JlYXRlIC0tbGFiZWxgIHRpbWUgcmF0aGVyIHRoYW4gdG8gYW5cbiAqIGV4aXN0aW5nIGlzc3VlLCBzbyBiZWZvcmUgIzEyNzYgbm9uZSBvZiB0aGVtIHBhc3NlZCB0aGlzIGd1YXJkIGF0IGFsbC5cbiAqIFRoZXkgYXJlIGRlbGliZXJhdGVseSBrZXB0IGluIHRoZWlyIG93biBzZXQ6IHRoZXkgY2xhc3NpZnkgKndoYXQgdGhlXG4gKiBmaW5kaW5nIGlzIGFib3V0Kiwgd2hlcmVhcyB7QGxpbmsgV09SS0VSX0FQUExJQUJMRV9MQUJFTF9MSVRFUkFMU31cbiAqIGNhcnJpZXMgdGhlIHdvcmtlcidzIG9wZXJhdGlvbmFsIHNpZ25hbHMuIEJvdGggYXJlIGFjY2VwdGVkIGJ5XG4gKiB7QGxpbmsgaXNXb3JrZXJBcHBsaWFibGVMYWJlbH0uXG4gKlxuICogT25lIGVudHJ5IHBlciB0ZW1wbGF0ZSBgb3V0cHV0TGFiZWxgIChgbGliL2lkbGVfdGFza190ZW1wbGF0ZXMvYCksIHBsdXNcbiAqIHRoZSB0d28gbm9uLXRlbXBsYXRlIGZpbGVycyAoYGFsZXJ0X2ZlZWRzL2FsZXJ0X2ZlZWRfZW5hYmxlX2lzc3VlLnRzYCxcbiAqIGBzZWN1cml0eV90cmVlX3N3ZWVwLnRzYCkgYW5kIHRoZSB0d28gZ2VuZXJpYyBpc3N1ZS10eXBlIHRhZ3MgdGhlIHJ1blxuICogZmFpbHVyZSBmaWxlciBhbmQgdGhlIHBsYW5uaW5nIGNhcnJpZXIgYXBwbHkuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLRVJfQVBQTElBQkxFX0NPTlRFTlRfTEFCRUxTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwiYWxlcnQtZmVlZFwiLFxuICBcImJhc2gtbWlzc2luZy1zY3JpcHRcIixcbiAgXCJiYXNoLXN5bnRheC1hdWRpdFwiLFxuICBcImJ1Z1wiLFxuICBcImRlYWQtY29kZVwiLFxuICBcImRlcHJlY2F0ZWQtYXBpXCIsXG4gIFwiZG9jLWNvdmVyYWdlXCIsXG4gIFwiZG9jdW1lbnRhdGlvbi1hdWRpdFwiLFxuICBcImR1cGxpY2F0ZWQta25vd2xlZGdlXCIsXG4gIFwiZW5hYmxlLWZlZWRcIixcbiAgXCJlbmhhbmNlbWVudFwiLFxuICBcImZvcm1hdC1kcmlmdFwiLFxuICBcImdhdGUtc2tpcC1kcmlmdFwiLFxuICBcInBvbnl0YWlsLWRlYnRcIixcbiAgLy8gSXNzdWUgIzIzMDQ6IHRoZSBmbGFnIGV2ZXJ5IG1lcmdlLWNvbmZsaWN0IGZhbGxiYWNrIGZpbGVzLCBzbyBhIGNsb3NlZFxuICAvLyBQUiBvciBhIHJldmVydGVkIGNoaWxkIGlzIGEgcmVjb3JkIHJhdGhlciB0aGFuIGEgc2lsZW5jZS5cbiAgXCJtZXJnZS1mYWxsYmFja1wiLFxuICBcIm9ycGhhbi1kZXBzXCIsXG4gIFwicHJpdmF0ZS1yZXBvLXJlZmVyZW5jZVwiLFxuICBcInJldHJvXCIsXG4gIFwic2VjdXJpdHktdHJlZS1zd2VlcFwiLFxuICBcInN1cHBseS1jaGFpbi1yZWFkaW5lc3NcIixcbiAgXCJ3b3JrZmxvdy1hbm5vdGF0aW9uLXNjYW5cIixcbl0pO1xuXG4vKipcbiAqIExhYmVsIG5hbWUgcHJlZml4ZXMgdGhlIHdvcmtlciBtYXkgYXBwbHkuXG4gKlxuICogVXNlZCBieSB0aGUgc2NhbiB0ZW1wbGF0ZXMgdG8gYXR0YWNoIGRlcml2ZWQgY2xhc3NpZmljYXRpb24gbGFiZWxzIHRvXG4gKiBmaWxlZCBmaW5kaW5nIGlzc3VlczpcbiAqICAgLSBgc2V2ZXJpdHk6YCDigJQgYHNldmVyaXR5OmhpZ2hgL2BtZWRpdW1gL2Bsb3dgIGZyb20gZXZlcnkgc2NhblxuICogICAgIHRlbXBsYXRlIChgYmVzdF9wcmFjdGljZXNfc3luYy50c2AsIHNlY3VyaXR5IHNjYW4pLlxuICogICAtIGBsYW5nOmAg4oCUIGBsYW5nOjxidWNrZXQ+YCBmcm9tIHRoZSBiZXN0LXByYWN0aWNlcyB0ZW1wbGF0ZVxuICogICAgIChgbGFuZzpydXN0YCwgYGxhbmc6dHlwZXNjcmlwdGAsIOKApikuXG4gKiAgIC0gYHN1cHBseS1jaGFpbjpgIOKAlCBgc3VwcGx5LWNoYWluOnF1YXJhbnRpbmUtbWlzc2luZ2AgL1xuICogICAgIGBzdXBwbHktY2hhaW46cXVhcmFudGluZS1taXNjb25maWd1cmVkYCBmcm9tIHRoZSBzZWN1cml0eSBzY2FuJ3NcbiAqICAgICBQaGFzZSAyIGRlcGVuZGVuY3ktdXBkYXRlIGF1ZGl0IChJc3N1ZSAjMTkzMyBmYW1pbHkpLlxuICogICAtIGBjb25maWRlbmNlOmAg4oCUIGBjb25maWRlbmNlOmhpZ2hgL2BtZWRpdW1gL2Bsb3dgIGZyb20gdGhlIHNlY3VyaXR5XG4gKiAgICAgdHJlZSBzd2VlcCdzIGZpbGVkIGNsdXN0ZXJzIChJc3N1ZSAjMTI3NikuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLRVJfQVBQTElBQkxFX0xBQkVMX1BSRUZJWEVTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgXCJzZXZlcml0eTpcIixcbiAgXCJsYW5nOlwiLFxuICBcInN1cHBseS1jaGFpbjpcIixcbiAgXCJjb25maWRlbmNlOlwiLFxuXTtcblxuLyoqXG4gKiBMYWJlbHMgdGhlIHdvcmtlciBpcyAqKmV4cGxpY2l0bHkgZm9yYmlkZGVuKiogZnJvbSBhcHBseWluZyDigJQgbGlzdGVkXG4gKiBoZXJlIGZvciBkb2N1bWVudGF0aW9uIGFuZCBzbyB0ZXN0cyBjYW4gZXhoYXVzdGl2ZWx5IGFzc2VydCB0aGUgZ3VhcmRcbiAqIHJlamVjdHMgdGhlbS4gVGhlc2UgYXJlIHRoZSBjYW5vbmljYWwgcGlja3VwLXByaW9yaXR5IGFuZCB3b3JrZmxvd1xuICogbGFiZWxzIG1hbmFnZWQgYnkgdHJ1c3RlZCBodW1hbnM7IGFueSBvZiB0aGVzZSBhZGRlZCBieSB0aGUgd29ya2VyIGlzXG4gKiBzaWxlbnRseSBzdHJpcHBlZCBvbiB0aGUgbmV4dCBzY2FuIOKAlCB0aGUgb3BlcmF0aW9uYWwgbGFiZWxzIGJ5XG4gKiBgbGFiZWxfc2VjdXJpdHkudHNgIChgdmVyaWZ5T3BlcmF0aW9uYWxMYWJlbHNgLCBJc3N1ZSAjMzIyNSkgYW5kIHRoZVxuICogcmVzZXJ2ZWQgZGlzY292ZXJ5IGxhYmVscyAoYHRvcC1wcmlvcml0eWAvYHdvcmstb25gL2Bsb3ctcHJpb3JpdHlgKSBieSB0aGVcbiAqIGRpc2NvdmVyeSBjb2xsZWN0b3JzJyBgd2FzTGFiZWxBZGRlZEJ5QWxsb3dlZEF1dGhvcmAgZ2F0ZSAoSXNzdWUgIzM0MTYpLlxuICpcbiAqIEJvdGggZ2F0ZXMgdHJlYXQgZXZlcnkgYGZsZWV0V29ya2VyTG9naW5zYCBsb2dpbiBhcyB1bnRydXN0ZWQsIHNvIHRoZVxuICogc3RyaXAgaG9sZHMgZXZlbiBpbiBhIG11bHRpLWFjY291bnQgZmxlZXQgd2hlcmUgdGhlIHdvcmtlcidzIG93biBsb2dpbiBpc1xuICogcmVxdWlyZWQgaW4gYGFsbG93ZWRfYXV0aG9yc2AgZm9yIFBSLWRlZHVwIChJc3N1ZSAjMzEzOCkg4oCUIHRoZSBlYXJsaWVyXG4gKiBcInRoZSB3b3JrZXIgYWNjb3VudCBpcyBub3Qgb24gdGhlIGFsbG93bGlzdFwiIGFzc3VtcHRpb24gaXMgZmFsc2UgdGhlcmUuXG4gKlxuICogVGhpcyBsaXN0IElTIGNvbnN1bHRlZCBhdCBydW50aW1lLCBhbmQgdGhlIGNsYWltIHRoYXQgaXQgaXMgbm90IHdhcyB3cm9uZ1xuICogKElzc3VlICMxNDIyKS4gYGlzV29ya2VyQXBwbGlhYmxlTGFiZWxgIOKAlCB0aGUgd29ya2VyJ3Mgb3duIHBvc2l0aXZlIGNoZWNrIOKAlFxuICogZG9lcyBub3QgcmVhZCBpdCwgd2hpY2ggaXMgd2hhdCB0aGUgb2xkIHdvcmRpbmcgbWVhbnQuIEJ1dFxuICogYGdoX2d1YXJkX2RlY2lzaW9uLnRzYCBidWlsZHMgdGhlIGFnZW50IHN1YnByb2Nlc3MncyBgRk9SQklEREVOX0xBQkVMU2BcbiAqIGRlbnlsaXN0IGZyb20gaXQsIGFuZCB0aGUgYGdoYCBQQVRIIHNoaW0gcmUtZW50ZXJzIHRoYXQgY2hlY2sgZm9yIGV2ZXJ5XG4gKiBsYWJlbCBtdXRhdGlvbiB0aGUgYWdlbnQgaXNzdWVzIGRpcmVjdGx5LiBDYWxsaW5nIGl0IFwiaW5mb3JtYXRpb25hbFwiIGlzXG4gKiBwbGF1c2libHkgd2h5IGl0IHdhcyBhbGxvd2VkIHRvIGRyaWZ0IGZyb20gYFJFU0VSVkVEX0xBQkVMU2Agd2hpbGUgdGhlXG4gKiBhZ2VudCBndWFyZCBkZXBlbmRlZCBvbiBpdC5cbiAqXG4gKiBBZGRpbmcgYW4gZW50cnkgaGVyZSB0aGVyZWZvcmUgY2hhbmdlcyB3aGF0IHRoZSBhZ2VudCBtYXkgZG8uIFRoZSBndWFyZFxuICogdGFrZXMgdGhlIFVOSU9OIG9mIHRoaXMgbGlzdCBhbmQgYFJFU0VSVkVEX0xBQkVMU2AsIHNvIHRoaXMgbGlzdCBpcyB0aGVcbiAqIHBsYWNlIGZvciBhIGxhYmVsIHRoYXQgaXMgZm9yYmlkZGVuIHRvIHRoZSBhZ2VudCBidXQgbm90IG90aGVyd2lzZVxuICogcmVzZXJ2ZWQg4oCUIGBiZXN0LW1vZGVsYCBpcyB0aGUgY3VycmVudCBleGFtcGxlLlxuICpcbiAqIGBwbGFubmluZ2Agc3RheXMgaGVyZSAoSXNzdWUgIzI2ODgpLiBUaGUgd29ya2VyJ3Mgb25lIGF1ZGl0ZWQgd2F5IHRvIGFwcGx5XG4gKiBpdCBpcyB7QGxpbmsgYXNzZXJ0V29ya2VyQ2FuSGFuZE9mZlRvUGxhbm5pbmd9LCB1c2VkIG9ubHkgd2hlbiBhIGB3b3JrLW9uYFxuICogaXNzdWUgcHJvdmVzIHRvbyBsYXJnZSBmb3Igb25lIFBSOyBgaXNXb3JrZXJQbGFubmluZ0hhbmRvZmZgIHRoZW4gdHJ1c3RzXG4gKiB0aGF0IGFkZCBvbmx5IHdoaWxlIGEgdHJ1c3RlZCBodW1hbidzIGB3b3JrLW9uYCBzdGlsbCBhbmNob3JzIGl0LlxuICovXG5leHBvcnQgY29uc3QgV09SS0VSX0ZPUkJJRERFTl9MQUJFTF9MSVRFUkFMUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIFwidG9wLXByaW9yaXR5XCIsXG4gIFwid29yay1vblwiLFxuICBcImxvdy1wcmlvcml0eVwiLFxuICBcInBsYW5uaW5nXCIsXG4gIFwicmVmaW5lLWlzc3VlXCIsXG4gIFwicXVlc3Rpb25cIixcbiAgXCJhbnN3ZXJlZFwiLFxuICBcIm5lZWRzLXJldmlzaW9uXCIsXG4gIFwiYmVzdC1tb2RlbFwiLFxuICAvLyBJc3N1ZSAjNDExMjogYHF1b3J1bWAgc3RhcnRzIGEgdGhyZWUtYWdlbnQgcGxhbi1vZmYg4oCUIGh1bWFuLWFwcGxpZWQgb25seS5cbiAgXCJxdW9ydW1cIixcbl07XG5cbi8qKlxuICogUmV0dXJuIHRydWUgaWYgdGhlIHdvcmtlciBpcyBhbGxvd2VkIHRvIGFwcGx5IGBsYWJlbGAg4oCUIHdoZXRoZXIgdG8gYW5cbiAqIGV4aXN0aW5nIGlzc3VlIG9yIGF0IGBnaCBpc3N1ZSBjcmVhdGVgIHRpbWUgKElzc3VlICMxMjc2KS4gUHVyZSDigJQgbm8gc2lkZVxuICogZWZmZWN0cywgbm8gYXN5bmMg4oCUIHNvIGNhbGxlcnMgY2FuIGNvbXBvc2UgaXQgZnJlZWx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNXb3JrZXJBcHBsaWFibGVMYWJlbChsYWJlbDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIC8vIElzc3VlICMzMDg4OiBHaXRIdWIgdHJlYXRzIGxhYmVsIG5hbWVzIGNhc2UtaW5zZW5zaXRpdmVseSwgc28gdGhlIGd1YXJkXG4gIC8vIG11c3QgbWF0Y2ggdGhlIHNhbWUgd2F5ICh0aGUgbGl0ZXJhbCBzZXQgYW5kIHByZWZpeGVzIGFyZSBhbGwgbG93ZXItY2FzZSkuXG4gIC8vIFdpdGhvdXQgdGhpcywgYSBub24tbG93ZXItY2FzZSBsYWJlbCBzbGlwcyBwYXN0IHRoZSBsaXRlcmFsIGFsbG93bGlzdCDigJRcbiAgLy8gZWl0aGVyIHdyb25nbHkgcmVmdXNlZCwgb3IgKGZvciBhIHJlc2VydmVkLW5hbWUgdmFyaWFudCkgaG9ub3VyZWQgYnkgdGhlXG4gIC8vIGRpc3BhdGNoIGdhdGUgd2hpbGUgc2tpcHBpbmcgdGhlIHN0cmlwIGd1YXJkcy5cbiAgY29uc3QgbG93ZXIgPSBsYWJlbC50b0xvd2VyQ2FzZSgpO1xuICBpZiAoV09SS0VSX0FQUExJQUJMRV9MQUJFTF9MSVRFUkFMUy5oYXMobG93ZXIpKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKFdPUktFUl9BUFBMSUFCTEVfQ09OVEVOVF9MQUJFTFMuaGFzKGxvd2VyKSkgcmV0dXJuIHRydWU7XG4gIGZvciAoY29uc3QgcHJlZml4IG9mIFdPUktFUl9BUFBMSUFCTEVfTEFCRUxfUFJFRklYRVMpIHtcbiAgICBpZiAobG93ZXIuc3RhcnRzV2l0aChwcmVmaXgpICYmIGxvd2VyLmxlbmd0aCA+IHByZWZpeC5sZW5ndGgpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKiBBdWRpdC1qb3VybmFsIHZlcmIgZm9yIGEgbGFiZWwgdGhlIHdvcmtlciByZWZ1c2VkIHRvIGFwcGx5IChJc3N1ZSAjMTYwNCkuICovXG5leHBvcnQgY29uc3QgV09SS0VSX0xBQkVMX1JFRlVTQUxfQVVESVRfVkVSQiA9IFwid29ya2VyLWxhYmVsLXJlZnVzZWRcIjtcblxuLyoqXG4gKiBEZWZhdWx0IGF1ZGl0IHNpbmsgZm9yIGEgcmVmdXNlZCBsYWJlbCAoSXNzdWUgIzE2MDQpOiBhcHBlbmQgdG8gdGhlXG4gKiB3b3JrZXIncyBqb3VybmFsIHdoZW4gaXQgaXMgb24sIGFuZCByZXBvcnQgbm90aGluZyB0byBkbyB3aGVuIGl0IGlzIG9mZiDigJRcbiAqIHVuaXQgdGVzdHMgd2l0aG91dCBgV09SS19ESVJgIHRoZXJlZm9yZSBpbmN1ciBubyBqb3VybmFsbGluZyBzaWRlIGVmZmVjdCxcbiAqIGV4YWN0bHkgYXMgdGhlIGBnaGAvYGdpdGAgY2hva2Vwb2ludCBob29rcyBiZWhhdmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBqb3VybmFsTGFiZWxSZWZ1c2FsKFxuICBtdXRhdGlvbjogQXVkaXRNdXRhdGlvbixcbiAgZW52OiBFbnZMb29rdXAgPSBwcm9jZXNzRW52TG9va3VwLFxuKTogUHJvbWlzZTxSZXN1bHQ8dW5rbm93bj4+IHtcbiAgaWYgKCFpc0F1ZGl0Sm91cm5hbEVuYWJsZWQoZW52KSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9KTtcbiAgfVxuICByZXR1cm4gcmVjb3JkTXV0YXRpb24obXV0YXRpb24sIHsgZW52IH0pO1xufVxuXG4vKiogUmVjb3JkIGEgZ3VhcmQgZGVjaXNpb24gd2l0aG91dCBibG9ja2luZzsgYSBmYWlsZWQgYXBwZW5kIGlzIGxvZ2dlZC4gKi9cbmZ1bmN0aW9uIGpvdXJuYWxHdWFyZERlY2lzaW9uKFxuICB2ZXJiOiBzdHJpbmcsXG4gIG91dGNvbWU6IFwic3VjY2Vzc1wiIHwgXCJlcnJvclwiLFxuICB0YXJnZXQ6IHN0cmluZyxcbiAgcmVjb3JkOiAobXV0YXRpb246IEF1ZGl0TXV0YXRpb24pID0+IFByb21pc2U8UmVzdWx0PHVua25vd24+PixcbiAgbG9nOiAobGluZTogc3RyaW5nKSA9PiB2b2lkLFxuKTogdm9pZCB7XG4gIGNvbnN0IHJlZnVzZWQgPSAobWVzc2FnZTogc3RyaW5nKSA9PlxuICAgIGxvZyhgW1NFQ1VSSVRZXSBbQVVESVRfSk9VUk5BTF9SRUZVU0VEXSAke3ZlcmJ9OiAke21lc3NhZ2V9YCk7XG4gIHZvaWQgcmVjb3JkKHtcbiAgICBydW5JZDogcmVzb2x2ZVJ1bklkKCksXG4gICAgdmVyYixcbiAgICBvdXRjb21lLFxuICAgIHRhcmdldCxcbiAgICBjYWxsZXI6IFwid29ya2VyL2Rlbm8vbGliL3dvcmtlcl9sYWJlbF9ndWFyZC50c1wiLFxuICB9KS50aGVuKFxuICAgIChyZXN1bHQpID0+IHtcbiAgICAgIGlmICghcmVzdWx0Lm9rKSByZWZ1c2VkKHJlc3VsdC5lcnJvci5tZXNzYWdlKTtcbiAgICB9LFxuICAgIChlcnI6IHVua25vd24pID0+IHJlZnVzZWQoZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpKSxcbiAgKTtcbn1cblxuLyoqXG4gKiBBc3NlcnQgdGhhdCB0aGUgd29ya2VyIG1heSBhcHBseSBgbGFiZWxgLiBSZXR1cm5zIGEgYFJlc3VsdGA6XG4gKiAgIC0gYG9rOiB0cnVlYCB3aGVuIGFsbG93ZWQgKG5vIGxvZyBsaW5lIGVtaXR0ZWQpLlxuICogICAtIGBvazogZmFsc2UsIGVycm9yOiAuLi5gIHdoZW4gcmVmdXNlZCwgYWZ0ZXIgZW1pdHRpbmcgYVxuICogICAgIGBbU0VDVVJJVFldIFtXT1JLRVJfTEFCRUxfUkVGVVNFRF1gIGxpbmUgdG8gc3RkZXJyIHNvIGEgcmV2aWV3ZXJcbiAqICAgICBjYW4gZ3JlcCBwcm9kdWN0aW9uIGxvZ3MgZm9yIGJsb2NrZWQgc2VsZi1hcHBsaWNhdGlvbiBhdHRlbXB0cy5cbiAqXG4gKiBPcHRpb25hbCBgY29udGV4dGAgKGNhbGxzaXRlIGhpbnQgc3VjaCBhcyB0aGUgY2FsbGluZyBmaWxlIHBhdGgpIGlzXG4gKiBpbmNsdWRlZCBpbiB0aGUgYXVkaXQgbGluZS4gT3B0aW9uYWwgYGxvZ0ZuYCBsZXRzIHRlc3RzIGNhcHR1cmUgdGhlXG4gKiBsaW5lIHdpdGhvdXQgaW5oZXJpdGluZyB0aGUgcmVhbCBgY29uc29sZS53YXJuYCBwbHVtYmluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydFdvcmtlckNhbkFwcGx5TGFiZWwoXG4gIGxhYmVsOiBzdHJpbmcsXG4gIGNvbnRleHQ6IHtcbiAgICBjYWxsZXI/OiBzdHJpbmc7XG4gICAgbG9nRm4/OiAobGluZTogc3RyaW5nKSA9PiB2b2lkO1xuICAgIC8qKlxuICAgICAqIEF1ZGl0LWpvdXJuYWwgc2luayBmb3IgdGhlIHJlZnVzYWwgKElzc3VlICMxNjA0OyB0ZXN0IHNlYW0pLiBEZWZhdWx0c1xuICAgICAqIHRvIHtAbGluayBqb3VybmFsTGFiZWxSZWZ1c2FsfSwgd2hpY2ggYXBwZW5kcyB0byB0aGUgd29ya2VyJ3Mgam91cm5hbFxuICAgICAqIHdoZW5ldmVyIGl0IGlzIG9uLlxuICAgICAqL1xuICAgIHJlY29yZD86IChtdXRhdGlvbjogQXVkaXRNdXRhdGlvbikgPT4gUHJvbWlzZTxSZXN1bHQ8dW5rbm93bj4+O1xuICB9ID0ge30sXG4pOiBSZXN1bHQ8dm9pZD4ge1xuICBpZiAoaXNXb3JrZXJBcHBsaWFibGVMYWJlbChsYWJlbCkpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICB9XG5cbiAgY29uc3QgbG9nID0gY29udGV4dC5sb2dGbiA/PyAoKGxpbmU6IHN0cmluZykgPT4gY29uc29sZS53YXJuKGxpbmUpKTtcbiAgY29uc3QgY2FsbGVyID0gY29udGV4dC5jYWxsZXIgPz8gXCJ1bmtub3duXCI7XG4gIGxvZyhcbiAgICBgW1NFQ1VSSVRZXSBbV09SS0VSX0xBQkVMX1JFRlVTRURdIGxhYmVsPSR7bGFiZWx9IGNhbGxlcj0ke2NhbGxlcn0gYCArXG4gICAgICBgcmVhc29uPW5vdF9pbl93b3JrZXJfYWxsb3dsaXN0YCxcbiAgKTtcbiAgLy8gSXNzdWUgIzE2MDQ6IHRoZSBzdGRlcnIgbGluZSBhYm92ZSBpcyB0cmFuc2llbnQ7IHRoZSBqb3VybmFsIGlzIHRoZVxuICAvLyBkdXJhYmxlLCB0YW1wZXItZXZpZGVudCByZWNvcmQgY29udHJvbCBDMTYgcHJvbWlzZXMgZm9yIGEgYmxvY2tlZFxuICAvLyBtdXRhdGlvbi4gQmVzdC1lZmZvcnQgYW5kIG9mZiB0aGUgY2FsbGVyJ3MgY3JpdGljYWwgcGF0aCDigJQgdGhpcyBmdW5jdGlvblxuICAvLyBzdGF5cyBzeW5jaHJvbm91cyDigJQgYnV0IGEgZmFpbGVkIGFwcGVuZCBpcyBzYWlkIG91dCBsb3VkLCBuZXZlciBoaWRkZW4uXG4gIGpvdXJuYWxHdWFyZERlY2lzaW9uKFxuICAgIFdPUktFUl9MQUJFTF9SRUZVU0FMX0FVRElUX1ZFUkIsXG4gICAgXCJlcnJvclwiLFxuICAgIGBsYWJlbD0ke2xhYmVsfSBjYWxsZXI9JHtjYWxsZXJ9YCxcbiAgICBjb250ZXh0LnJlY29yZCA/PyBqb3VybmFsTGFiZWxSZWZ1c2FsLFxuICAgIGxvZyxcbiAgKTtcblxuICByZXR1cm4ge1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgYFdvcmtlciBpcyBub3QgYXV0aG9yaXNlZCB0byBhcHBseSB0aGUgJyR7bGFiZWx9JyBsYWJlbCDigJQgYCArXG4gICAgICAgIGBvbmx5IGZhaWx1cmUtdHJhY2tpbmcsIGVzY2FsYXRpb24sIGFuZCBzY2FuLWNvbnRlbnQgbGFiZWxzIGFyZSBgICtcbiAgICAgICAgYGFsbG93ZWQgKHNlZSB3b3JrZXIvZGVuby9saWIvd29ya2VyX2xhYmVsX2d1YXJkLnRzKS5gLFxuICAgICksXG4gIH07XG59XG5cbi8qKiBBdWRpdC1qb3VybmFsIHZlcmIgZm9yIHRoZSB3b3JrZXIncyBwbGFubmluZyBoYW5kLW9mZiAoSXNzdWUgIzI2ODgpLiAqL1xuZXhwb3J0IGNvbnN0IFdPUktFUl9QTEFOTklOR19IQU5ET0ZGX0FVRElUX1ZFUkIgPSBcIndvcmtlci1wbGFubmluZy1oYW5kb2ZmXCI7XG5cbi8qKlxuICogQXNzZXJ0IHRoYXQgdGhlIHdvcmtlciBtYXkgaGFuZCBpdHMgb3duIGB3b3JrLW9uYCBpc3N1ZSB0byBgcGxhbm5pbmdgXG4gKiAoSXNzdWUgIzI2ODgpIOKAlCB0aGUgc2luZ2xlLCBhdWRpdGVkIGV4Y2VwdGlvbiB0byB0aGUgcmVzZXJ2ZWQtbGFiZWwgYmFuLlxuICpcbiAqIGBwbGFubmluZ2Agc3RheXMgb3V0IG9mIHtAbGluayBpc1dvcmtlckFwcGxpYWJsZUxhYmVsfSwgc28gbm8gZ2VuZXJhbFxuICogbGFiZWwgcGF0aCBjYW4gYXBwbHkgaXQ7IG9ubHkgdGhlIGhhbmQtb2ZmIGZsb3cgKGBwbGFubmluZ19oYW5kb2ZmLnRzYClcbiAqIGNhbGxzIHRoaXMuIEV2ZXJ5IGFsbG93ZWQgaGFuZC1vZmYgZW1pdHMgYVxuICogYFtTRUNVUklUWV0gW1dPUktFUl9QTEFOTklOR19IQU5ET0ZGXWAgbGluZSBhbmQgYSBgc3VjY2Vzc2Agam91cm5hbCBlbnRyeTtcbiAqIGFueSBvdGhlciBsYWJlbCBpcyByZWZ1c2VkIGV4YWN0bHkgYXMge0BsaW5rIGFzc2VydFdvcmtlckNhbkFwcGx5TGFiZWx9XG4gKiByZWZ1c2VzIGl0LiBgbGFiZWxfc2VjdXJpdHkudHNgIGhvbm91cnMgdGhlIHJlc3VsdGluZyBsYWJlbCBvbmx5IHdoaWxlIGFcbiAqIHRydXN0ZWQsIG5vbi13b3JrZXIgYHdvcmstb25gIGFkZCBzdGlsbCBhbmNob3JzIGl0XG4gKiAoYHBsYW5uaW5nX2hhbmRvZmZfdHJ1c3QudHNgKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydFdvcmtlckNhbkhhbmRPZmZUb1BsYW5uaW5nKFxuICBsYWJlbDogc3RyaW5nLFxuICBjb250ZXh0OiB7XG4gICAgY2FsbGVyPzogc3RyaW5nO1xuICAgIC8qKiBUaGUgaXNzdWUgYmVpbmcgaGFuZGVkIG9mZiwgZS5nLiBgb3duZXIvcmVwbyMxMmAuICovXG4gICAgdGFyZ2V0Pzogc3RyaW5nO1xuICAgIGxvZ0ZuPzogKGxpbmU6IHN0cmluZykgPT4gdm9pZDtcbiAgICByZWNvcmQ/OiAobXV0YXRpb246IEF1ZGl0TXV0YXRpb24pID0+IFByb21pc2U8UmVzdWx0PHVua25vd24+PjtcbiAgfSA9IHt9LFxuKTogUmVzdWx0PHZvaWQ+IHtcbiAgY29uc3QgbG9nID0gY29udGV4dC5sb2dGbiA/PyAoKGxpbmU6IHN0cmluZykgPT4gY29uc29sZS53YXJuKGxpbmUpKTtcbiAgY29uc3QgY2FsbGVyID0gY29udGV4dC5jYWxsZXIgPz8gXCJ1bmtub3duXCI7XG4gIGlmIChsYWJlbC50b0xvd2VyQ2FzZSgpICE9PSBQTEFOTklOR19IQU5ET0ZGX0xBQkVMKSB7XG4gICAgbG9nKFxuICAgICAgYFtTRUNVUklUWV0gW1dPUktFUl9MQUJFTF9SRUZVU0VEXSBsYWJlbD0ke2xhYmVsfSBjYWxsZXI9JHtjYWxsZXJ9IGAgK1xuICAgICAgICBgcmVhc29uPW5vdF90aGVfcGxhbm5pbmdfaGFuZG9mZl9sYWJlbGAsXG4gICAgKTtcbiAgICBqb3VybmFsR3VhcmREZWNpc2lvbihcbiAgICAgIFdPUktFUl9MQUJFTF9SRUZVU0FMX0FVRElUX1ZFUkIsXG4gICAgICBcImVycm9yXCIsXG4gICAgICBgbGFiZWw9JHtsYWJlbH0gY2FsbGVyPSR7Y2FsbGVyfWAsXG4gICAgICBjb250ZXh0LnJlY29yZCA/PyBqb3VybmFsTGFiZWxSZWZ1c2FsLFxuICAgICAgbG9nLFxuICAgICk7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBUaGUgcGxhbm5pbmcgaGFuZC1vZmYgbWF5IG9ubHkgYXBwbHkgJ3BsYW5uaW5nJywgbm90ICcke2xhYmVsfScuYCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHRhcmdldCA9IGNvbnRleHQudGFyZ2V0ID8/IFwidW5rbm93blwiO1xuICBsb2coXG4gICAgYFtTRUNVUklUWV0gW1dPUktFUl9QTEFOTklOR19IQU5ET0ZGXSBsYWJlbD0ke2xhYmVsfSB0YXJnZXQ9JHt0YXJnZXR9IGAgK1xuICAgICAgYGNhbGxlcj0ke2NhbGxlcn1gLFxuICApO1xuICBqb3VybmFsR3VhcmREZWNpc2lvbihcbiAgICBXT1JLRVJfUExBTk5JTkdfSEFORE9GRl9BVURJVF9WRVJCLFxuICAgIFwic3VjY2Vzc1wiLFxuICAgIGBsYWJlbD0ke2xhYmVsfSB0YXJnZXQ9JHt0YXJnZXR9IGNhbGxlcj0ke2NhbGxlcn1gLFxuICAgIGNvbnRleHQucmVjb3JkID8/IGpvdXJuYWxMYWJlbFJlZnVzYWwsXG4gICAgbG9nLFxuICApO1xuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7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
// denoCacheMetadata=9786431875283569924,2213326439394504948