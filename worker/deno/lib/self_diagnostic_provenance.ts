/**
 * Provenance for auto-filed worker diagnostics (Issue #505).
 *
 * The worker detects its own faults, files them accurately, states the
 * remedy — and then stops, because the one action that would schedule the
 * fix (`work-on`) is reserved for humans. On an unattended host nobody
 * applies it, so the alarm accumulates: `NEAT-AI-Rebase#39` sat for two
 * days, and the fix took 79 minutes once a human finally scheduled it.
 *
 * The reserved-label guard (`worker_label_guard.ts`,
 * `wasLabelAddedByAllowedAuthor`, `verifyOperationalLabels`) is correct and
 * is **not** relaxed here. Nothing in this path applies a label. Instead the
 * claim scan gains a narrow tier — `collect_self_diagnostic_candidates.ts` —
 * that makes an *auto-filed worker diagnostic* claimable on its provenance
 * alone. `top-priority` and `work-on` remain human-only, unconditionally.
 *
 * **Provenance, not author.** An injected agent can file issues too, so
 * four independent signals must agree before an issue is self-schedulable:
 *
 *   1. **repo** — it is in {@link SELF_DIAGNOSTIC_REPO}, the worker's own
 *      repo, where the deciding code lives;
 *   2. **marker** — its body carries a recognised machine-written marker
 *      from {@link SELF_DIAGNOSTIC_FAMILIES}, matched as a whole HTML
 *      comment rather than as a substring;
 *   3. **author** — it was filed by a fleet worker login; and
 *   4. **filing attestation** (Issue #1277) — the worker's own filer
 *      recorded this issue number, and a digest of the body it posted, in
 *      the tamper-evident audit chain (`self_diagnostic_attestation.ts`).
 *
 * Signals 1–3 are all things the agent subprocess can produce: it holds the
 * run's `gh` credential, its writes are allowed in the claimed repo, and it
 * writes the body the marker lives in. Signal 4 is the one it cannot mint —
 * the journal lives outside every working tree, its own `gh` calls are
 * journalled under the classifier's verb rather than this one, and a line
 * appended by hand breaks the hash chain and its anchor.
 *
 * Marker forgery through a filed body is also closed at the source: the
 * filers escape `<!--`/`-->` out of every interpolated field before the
 * body is written (`bodySafe` in `idle_inversion_streak.ts`), so a marker in
 * a filed body can only have come from the template.
 *
 * Residual risk, deliberately accepted: an actor with write access to this
 * repo can edit a worker-filed body. Editing it no longer makes the issue
 * self-schedulable — the attested body digest stops matching, so the
 * diagnostic falls back to waiting for a human `work-on` — and that actor
 * can already apply `work-on` directly, so self-scheduling grants them
 * nothing new. Issue content reaches the agent inside the
 * untrusted-content boundary either way.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  IDLE_INVERSION_FAMILY_ID,
  IDLE_INVERSION_MARKER_PREFIX,
  IDLE_INVERSION_TARGET_REPO,
} from "./idle_inversion_streak.ts";
import {
  RUN_FAILURE_FAMILY_ID,
  RUN_FAILURE_MARKER_PREFIX,
} from "./run_failure_issue.ts";
import type { UnworkableEscalation } from "./escalate_unworkable_work_on.ts";

/**
 * Where auto-filed worker diagnostics land, and the only repo whose issues
 * may be self-scheduled. Derived from the filer's own constant so the two
 * cannot drift.
 */
export const SELF_DIAGNOSTIC_REPO = IDLE_INVERSION_TARGET_REPO;

/** Audit-chain verb for a self-scheduling decision (Issue #505). */
export const SELF_SCHEDULE_AUDIT_VERB = "self-schedule-diagnostic";

/** Prefix of the marker that dedups the announcement comment. */
export const SELF_SCHEDULE_ANNOUNCE_MARKER_PREFIX = "VIBE_SELF_SCHEDULED";

/** One recognised family of auto-filed worker diagnostics. */
export interface SelfDiagnosticFamily {
  /** Stable id used in logs, the announcement and the audit entry. */
  id: string;
  /** Body marker prefix the filer stamps, e.g. `VIBE_IDLE_INVERSION`. */
  markerPrefix: string;
  /** Module that files this family, named in the announcement. */
  filedBy: string;
}

/**
 * The recognised families — auto-filed, from a template, about the worker,
 * into the worker's own repo.
 *
 * Deliberately **not** every `VIBE_*` marker in the codebase. The
 * bump-script and PR-branch streak filers file into the *product* repo the
 * fault is about, so they are out of scope by construction (and the repo
 * gate rejects them anyway); the heartbeat and claim-lock markers ride
 * comments, not issue bodies.
 */
export const SELF_DIAGNOSTIC_FAMILIES: readonly SelfDiagnosticFamily[] = [
  {
    // Ids are owned by the filers (Issue #1277) so the family a candidate is
    // recognised under and the family its filing attestation records cannot
    // drift apart.
    id: IDLE_INVERSION_FAMILY_ID,
    markerPrefix: IDLE_INVERSION_MARKER_PREFIX,
    filedBy: "idle_inversion_streak.ts",
  },
  {
    id: RUN_FAILURE_FAMILY_ID,
    markerPrefix: RUN_FAILURE_MARKER_PREFIX,
    filedBy: "run_failure_issue.ts",
  },
];

/**
 * Match any marker written as a whole HTML comment — `<!-- PREFIX:value -->`
 * — so prose that merely names a prefix is not mistaken for provenance.
 *
 * Hardcoded rather than built per family from `markerPrefix`: a regex
 * compiled from a variable is a ReDoS hazard (semgrep
 * `detect-non-literal-regexp`). The prefix is captured and compared as a
 * plain string instead, which is both safe and exact — `VIBE_RUN_FAILURE`
 * no longer needs the `:` to stay distinct from
 * `VIBE_RUN_FAILURE_FOLLOWUP`, since the capture must equal the family
 * prefix in full.
 */
const MARKER_COMMENT_PATTERN = /<!--\s*([A-Za-z0-9_]+):[^\s<>]+\s*-->/g;

/** Every marker prefix carried as a whole HTML comment in `text`. */
function markerPrefixesIn(text: string): Set<string> {
  const prefixes = new Set<string>();
  for (const match of text.matchAll(MARKER_COMMENT_PATTERN)) {
    const prefix = match[1];
    if (prefix !== undefined) prefixes.add(prefix);
  }
  return prefixes;
}

/**
 * The diagnostic family an issue body was filed under, or null when the
 * body carries no recognised marker.
 */
export function recogniseSelfDiagnostic(
  body: string | undefined,
): SelfDiagnosticFamily | null {
  const text = body ?? "";
  if (text === "") return null;
  const prefixes = markerPrefixesIn(text);
  if (prefixes.size === 0) return null;
  for (const family of SELF_DIAGNOSTIC_FAMILIES) {
    if (prefixes.has(family.markerPrefix)) return family;
  }
  return null;
}

/** True when `repo` is the repo auto-filed diagnostics land in. */
export function isSelfDiagnosticRepo(repo: string): boolean {
  return repo.toLowerCase() === SELF_DIAGNOSTIC_REPO.toLowerCase();
}

/** The marker that dedups the announcement comment for one issue. */
export function formatSelfScheduleMarker(familyId: string): string {
  return `<!-- ${SELF_SCHEDULE_ANNOUNCE_MARKER_PREFIX}:${familyId} -->`;
}

/**
 * The announcement posted on a diagnostic the moment it is self-scheduled,
 * so "who scheduled this" is answerable from the issue itself and not only
 * from the audit chain.
 */
export function buildSelfScheduleAnnouncement(opts: {
  family: SelfDiagnosticFamily;
  maxInFlight: number;
  /** Login of the host taking the decision, when known. */
  githubUser?: string;
}): string {
  const host = opts.githubUser ? ` by \`${opts.githubUser}\`` : "";
  return [
    formatSelfScheduleMarker(opts.family.id),
    "",
    `**Self-scheduled**${host} — this is an auto-filed worker diagnostic ` +
    `(family \`${opts.family.id}\`, filed by \`${opts.family.filedBy}\`), so ` +
    `the worker has queued it for pickup without waiting for a human to ` +
    `apply \`work-on\` (Issue #505).`,
    "",
    `Self-scheduling is limited to diagnostics the worker filed about ` +
    `itself, in this repo, carrying a recognised provenance marker. ` +
    `\`top-priority\` and \`work-on\` remain human-only, and at most ` +
    `**${opts.maxInFlight}** self-scheduled diagnostic(s) may be in flight ` +
    `at once. The decision is recorded in the audit chain under the ` +
    `\`${SELF_SCHEDULE_AUDIT_VERB}\` verb.`,
    "",
    "Set `self_schedule_diagnostics_enabled: false` in `.config.json` to " +
    "turn this off — the diagnostic then waits for a human `work-on` as " +
    "before.",
  ].join("\n");
}

/**
 * Escalation for a recognised diagnostic the worker cannot self-schedule
 * and never will: the fault is real, the fix is blocked for good, and
 * leaving it open with no label is the "alarm nobody is obliged to read"
 * failure this issue exists to end.
 */
export function buildUnschedulableDiagnosticEscalation(opts: {
  issueNumber: number;
  family: SelfDiagnosticFamily;
  /** Why the block is permanent, in one clause. */
  reason: string;
}): UnworkableEscalation {
  return {
    reason: `this auto-filed worker diagnostic (family ` +
      `\`${opts.family.id}\`) cannot be self-scheduled: ${opts.reason}. ` +
      `The block does not clear on its own, so without a human the ` +
      `diagnostic would stay open and unworked indefinitely.`,
    nextStep: "Re-schedule it by hand — apply `work-on` (a trusted re-label " +
      "dated after the merge also lifts the merged-PR block) or close the " +
      "diagnostic if it is stale — then remove `needs-human`.",
    dedupKey: `self-diagnostic-unschedulable-${opts.issueNumber}`,
  };
}

/** Heading used on the escalation comment for an unschedulable diagnostic. */
export const UNSCHEDULABLE_DIAGNOSTIC_HEADING =
  "Auto-filed worker diagnostic cannot be scheduled — needs human attention";
