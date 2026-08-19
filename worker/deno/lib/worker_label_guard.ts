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
 * (Issue #13).
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
 */

import type { Result } from "../types.ts";

/**
 * Literal label names the worker may apply to an existing issue.
 *
 * Curated from every `addLabelToIssue` call site in `worker/deno/lib/` and
 * `worker/deno/setup/`:
 *   - `failed`, `failed-once` — failure tracking (`label_failure.ts`,
 *     `label_question_failure.ts`, `claim_issue.ts`).
 *   - `needs-human` — worker → human escalation
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
 */
export const WORKER_APPLIABLE_LABEL_LITERALS: ReadonlySet<string> = new Set([
  "failed",
  "failed-once",
  "needs-human",
  "needs-screenshot",
  "idle-task",
  "negative-result",
  "best-practices",
  "security",
  "test-audit",
  "github-actions-audit",
  "degraded-model",
]);

/**
 * Label name prefixes the worker may apply.
 *
 * Used by the four scan templates to attach derived classification
 * labels to filed finding issues:
 *   - `severity:` — `severity:high`/`medium`/`low` from every scan
 *     template (`best_practices_sync.ts`, security scan).
 *   - `lang:` — `lang:<bucket>` from the best-practices template
 *     (`lang:rust`, `lang:typescript`, …).
 *   - `supply-chain:` — `supply-chain:quarantine-missing` /
 *     `supply-chain:quarantine-misconfigured` from the security scan's
 *     Phase 2 dependency-update audit (Issue #1933 family).
 */
export const WORKER_APPLIABLE_LABEL_PREFIXES: readonly string[] = [
  "severity:",
  "lang:",
  "supply-chain:",
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
 * This list is **not** consulted at runtime — `isWorkerAppliableLabel`
 * uses the positive list above. The forbidden list is informational.
 */
export const WORKER_FORBIDDEN_LABEL_LITERALS: readonly string[] = [
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
  "quorum",
];

/**
 * Return true if the worker is allowed to apply `label` to an existing
 * issue. Pure — no side effects, no async — so callers can compose it
 * freely.
 */
export function isWorkerAppliableLabel(label: string): boolean {
  // Issue #3088: GitHub treats label names case-insensitively, so the guard
  // must match the same way (the literal set and prefixes are all lower-case).
  // Without this, a non-lower-case label slips past the literal allowlist —
  // either wrongly refused, or (for a reserved-name variant) honoured by the
  // dispatch gate while skipping the strip guards.
  const lower = label.toLowerCase();
  if (WORKER_APPLIABLE_LABEL_LITERALS.has(lower)) return true;
  for (const prefix of WORKER_APPLIABLE_LABEL_PREFIXES) {
    if (lower.startsWith(prefix) && lower.length > prefix.length) {
      return true;
    }
  }
  return false;
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
 */
export function assertWorkerCanApplyLabel(
  label: string,
  context: { caller?: string; logFn?: (line: string) => void } = {},
): Result<void> {
  if (isWorkerAppliableLabel(label)) {
    return { ok: true, value: undefined };
  }

  const log = context.logFn ?? ((line: string) => console.warn(line));
  const caller = context.caller ?? "unknown";
  log(
    `[SECURITY] [WORKER_LABEL_REFUSED] label=${label} caller=${caller} ` +
      `reason=not_in_worker_allowlist`,
  );

  return {
    ok: false,
    error: new Error(
      `Worker is not authorised to apply the '${label}' label — ` +
        `only failure-tracking, escalation, and scan-content labels are ` +
        `allowed (see worker/deno/lib/worker_label_guard.ts).`,
    ),
  };
}
