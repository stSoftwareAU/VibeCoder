/**
 * The worker diagnostic a wedged milestone-sync gate files (Issue #2388).
 *
 * A conflict is the worker's to resolve end to end, so a conflict must never
 * produce a "needs a human" comment — and it certainly must not produce one on
 * an arbitrary sibling issue of the milestone, which is where the old
 * escalation landed and where nobody looks. What actually failed when the gate
 * refuses the same resolution twice is the **gate**: it could not verify a
 * tree the worker had already resolved correctly. That is a Vibe Coder bug,
 * so it is filed where Vibe Coder bugs are fixed, once, naming the repository,
 * the milestone, the gate's verdict and how many times it has repeated.
 *
 * Deduped on the title — one open diagnostic per repository and milestone
 * branch — and author-verified, so a same-titled issue somebody else opened is
 * left exactly as it is. A repeat appends a comment rather than filing again.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import { findFleetAuthoredIssuesTitled } from "./idle_task_wrapper_dedup.ts";
import { conflictEscalationKey } from "./milestone_conflict_dedup.ts";
import {
  buildConflictAnalysisComment,
  type MilestoneConflictEscalation,
} from "./milestone_conflict_triage.ts";
import { redactSecrets } from "./secret_redaction.ts";
import {
  type GateRefusalRecord,
  isGateWedged,
  markGateRefusalReported,
  recordGateRefusal,
  type SyncStreakEntry,
} from "./milestone_sync_streak.ts";

/** Callsite recorded in the label guard's audit line. */
const CALLER = "worker/deno/lib/milestone_gate_wedge.ts";

/**
 * Where a wedged gate is reported, whichever repository the milestone is in:
 * the gate is the worker's code, so the diagnostic belongs beside it.
 */
export const GATE_WEDGE_DIAGNOSTIC_REPO = "stSoftwareAU/VibeCoder";

/** The label the diagnostic carries — it reports a worker defect. */
export const GATE_WEDGE_DIAGNOSTIC_LABEL = "bug";

/** Injectable `gh` runner. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** One open diagnostic per repository and milestone branch. */
export function gateWedgeDiagnosticTitle(
  repo: string,
  milestoneBranch: string,
): string {
  return `Milestone sync gate cannot verify a resolution it keeps ` +
    `refusing: ${repo} ${milestoneBranch}`;
}

/** What the diagnostic reports. */
export interface GateWedgeReport {
  /** The monitored repository whose milestone is wedged. */
  repo: string;
  milestoneBranch: string;
  defaultBranch: string;
  /** The milestone's title, as GitHub reports it. */
  milestoneTitle: string;
  /** The refusal the ledger has been counting. */
  refusal: GateRefusalRecord;
  /**
   * The prepared both-sides analysis, when the sync produced one. It is the
   * part a reader cannot reconstruct later, so it rides along with the
   * verdict rather than being dropped.
   */
  analysis?: string;
}

/** Render the diagnostic body — the same text whether filed or appended. */
export function buildGateWedgeDiagnosticBody(report: GateWedgeReport): string {
  const { repo, milestoneBranch, defaultBranch, refusal } = report;
  const tips = [
    refusal.defaultSha
      ? `- \`${defaultBranch}\` tip merged from: \`${refusal.defaultSha}\``
      : `- \`${defaultBranch}\` tip: not recorded`,
    refusal.milestoneSha
      ? `- \`${milestoneBranch}\` tip: \`${refusal.milestoneSha}\``
      : `- \`${milestoneBranch}\` tip: not recorded`,
  ].join("\n");

  return `## The resolution gate refused the same resolution ${refusal.count} ` +
    `time(s)\n\n` +
    `Merging \`${defaultBranch}\` into \`${milestoneBranch}\` in \`${repo}\` ` +
    `(milestone **${report.milestoneTitle}**) conflicted, the worker resolved ` +
    `the conflict, and the verification gate then refused the resolution — ` +
    `with the same verdict, on the same conflict, from the same ` +
    `\`${defaultBranch}\` tip, ${refusal.count} time(s) in a row.\n\n` +
    `A gate refusal is deliberately **not charged** to the branch's conflict ` +
    `budget, so nothing concludes it: without this report the identical ` +
    `resolution is rebuilt and refused every cycle, for every issue of the ` +
    `milestone. The milestone's issues are now held back until either side's ` +
    `tip moves, and this is the record of why.\n\n` +
    `### What the gate said\n\n\`\`\`\n${refusal.reason}\n\`\`\`\n\n` +
    `### The merge it refused\n\n${tips}\n` +
    `- Conflict key: \`${refusal.conflictKey}\`\n` +
    `- Last refused at: ${refusal.at}\n\n` +
    (report.analysis ? `${report.analysis}\n\n` : "") +
    `### What to fix\n\n` +
    `Fix the **gate**, not the conflict: work out why ` +
    `\`milestone_resolution_gate.ts\` cannot verify this repository's merged ` +
    `tree, and teach it to. The conflict itself is the worker's to resolve ` +
    `and needs no human (Issue #2388).`;
}

/** Everything the filer needs beyond the report. */
export interface GateWedgeDiagnosticDeps {
  ghCommandFn: GhCommandFn;
  log: (message: string) => void;
  /** Fleet-identity inputs for the author check (tests state the fleet). */
  dedupAuthors?: AlertDedupAuthorOptions;
  /** Override the target repository (tests). */
  targetRepo?: string;
}

/**
 * File — or append to — the one worker diagnostic for a wedged gate.
 *
 * Best-effort: a search or a write that fails is said out loud and reported
 * as not filed, so the caller does not record it as done and the next cycle
 * tries again.
 *
 * @returns True only when the diagnostic was actually filed or appended to.
 */
export async function reportGateWedge(
  report: GateWedgeReport,
  deps: GateWedgeDiagnosticDeps,
): Promise<boolean> {
  const target = deps.targetRepo ?? GATE_WEDGE_DIAGNOSTIC_REPO;
  const title = gateWedgeDiagnosticTitle(report.repo, report.milestoneBranch);
  // Redacted on the way out, as every outbound sink must be: the body carries
  // raw gate output, which is whatever the repository's own tooling printed.
  const body = redactSecrets(buildGateWedgeDiagnosticBody(report));

  let existing: number | undefined;
  try {
    const rows = await findFleetAuthoredIssuesTitled({
      repo: target,
      title,
      context: `milestone sync gate wedge for ${report.milestoneBranch}`,
      ghCommand: deps.ghCommandFn,
      limit: 10,
      log: deps.log,
      ...(deps.dedupAuthors ?? {}),
    });
    existing = rows[0]?.number;
  } catch (err) {
    // Fail open on the search, not on the write: a duplicate diagnostic is
    // noise, a suppressed one leaves the gate unfixed.
    deps.log(
      `WARNING: Could not search ${target} for the milestone sync gate ` +
        `diagnostic titled '${title}': ${
          err instanceof Error ? err.message : String(err)
        } — filing it anyway (Issue #2388)`,
    );
  }

  try {
    if (existing !== undefined) {
      await deps.ghCommandFn([
        "issue",
        "comment",
        String(existing),
        "--repo",
        target,
        "--body",
        body,
      ]);
      // The append is how a *second* host reports the same wedge: each host
      // keeps its own ledger, so the `reported` flag on this one says nothing
      // about what the others have seen — the open issue is the shared record.
      deps.log(
        `Appended the milestone sync gate wedge for ` +
          `'${report.milestoneBranch}' in ${report.repo} to ` +
          `${target}#${existing} (Issue #2388)`,
      );
      return true;
    }
    await deps.ghCommandFn([
      "issue",
      "create",
      "--repo",
      target,
      "--title",
      title,
      "--body",
      body,
      ...guardedLabelArgs([GATE_WEDGE_DIAGNOSTIC_LABEL], CALLER),
    ]);
    deps.log(
      `Filed a milestone sync gate wedge diagnostic in ${target} for ` +
        `'${report.milestoneBranch}' in ${report.repo} (Issue #2388)`,
    );
    return true;
  } catch (err) {
    deps.log(
      `WARNING: Could not report the wedged milestone sync gate for ` +
        `'${report.milestoneBranch}' in ${report.repo} to ${target}: ${
          err instanceof Error ? err.message : String(err)
        } — the branch is still held back, nothing durable records why ` +
        `(Issue #2388)`,
    );
    return false;
  }
}

/** The branch a gate refusal was made against. */
export interface GateWedgeBranch {
  repo: string;
  milestoneBranch: string;
  defaultBranch: string;
  milestoneTitle: string;
}

/** What {@link concludeGateRefusal} decided. */
export interface GateRefusalConclusion {
  /** The entry with the refusal counted, and marked reported if it was. */
  entry: SyncStreakEntry;
  /** True once this refusal has repeated — the branch is wedged. */
  wedged: boolean;
}

/**
 * Count a gate refusal and, once it has repeated, report it — the single
 * implementation both the periodic sweep and a child run's pre-cut sync use
 * (Issue #2388).
 *
 * One function rather than two copies because the two halves must agree
 * byte for byte: the conflict key is what `isSameGateRefusal` compares, so a
 * key built differently in either caller would silently stop matching and the
 * wedge would never latch. It is also what stops the report depending on
 * which path happened to hit the refusal — the sweep does not visit every
 * milestone every cycle, and a wedge nobody filed is a gate nobody fixes.
 *
 * @param entry - The branch's streak entry
 * @param branch - Repository, branches and milestone title
 * @param conflict - The escalation carrying the gate's verdict
 * @param defaultSha - The default tip the refused merge was made from
 * @param nowMs - Conclusion time in epoch milliseconds
 * @param deps - The `gh` runner, log sink and fleet identity
 */
export async function concludeGateRefusal(
  entry: SyncStreakEntry,
  branch: GateWedgeBranch,
  conflict: MilestoneConflictEscalation & { gateFailure: string },
  defaultSha: string | undefined,
  nowMs: number,
  deps: GateWedgeDiagnosticDeps,
): Promise<GateRefusalConclusion> {
  const conflictKey = conflictEscalationKey({
    milestoneBranch: branch.milestoneBranch,
    ...(conflict.milestoneSha ? { milestoneSha: conflict.milestoneSha } : {}),
    files: [
      ...conflict.analyses.map((a) => a.path),
      ...conflict.resolved.map((d) => d.path),
    ],
  });

  let next = recordGateRefusal(entry, {
    conflictKey,
    reason: conflict.gateFailure,
    ...(defaultSha ? { defaultSha } : {}),
    ...(conflict.milestoneSha ? { milestoneSha: conflict.milestoneSha } : {}),
  }, nowMs);

  const wedge = next.gateRefusal!;
  if (!isGateWedged(next) || wedge.reported) {
    return { entry: next, wedged: isGateWedged(next) };
  }

  const reported = await reportGateWedge({
    repo: branch.repo,
    milestoneBranch: branch.milestoneBranch,
    defaultBranch: branch.defaultBranch,
    milestoneTitle: branch.milestoneTitle,
    refusal: wedge,
    // The both-sides preparation the deleted needs-human escalation carried:
    // it is the half a reader cannot reconstruct later, and a gate fixer
    // needs to see what the refused resolution actually was.
    analysis: buildConflictAnalysisComment({
      repo: branch.repo,
      milestoneBranch: branch.milestoneBranch,
      defaultBranch: branch.defaultBranch,
      analyses: conflict.analyses,
      resolved: conflict.resolved,
    }),
  }, deps);
  // Only a report that went out is remembered; one that failed is retried.
  if (reported) next = markGateRefusalReported(next);
  return { entry: next, wedged: true };
}
