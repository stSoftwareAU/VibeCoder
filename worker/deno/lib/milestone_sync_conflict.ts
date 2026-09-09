/**
 * Reporting for a conflicting `main` → `milestone/*` sync merge (Issue #1558).
 *
 * The sync merges the default branch down and resolves whatever collides by
 * accepting the default branch's side. That keeps the branch moving, which is
 * the point — divergence cost grows superlinearly, and a week of drift is an
 * archaeology exercise. But a resolution that picks a side is a decision
 * nobody made deliberately: `IndirectSpawnRules` on the branch and
 * `scanContentForVariableBinarySpawn` on `main` solved the same problem twice,
 * and only a human could say which one should survive.
 *
 * So the merge lands, and the conflict is reported the same day — naming the
 * files that collided and the commit each side stood at, so whoever picks it
 * up sees what changed on each without reconstructing it days later.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GhCommandFn } from "./milestone_branch_sync.ts";
import type { FileDecision } from "./milestone_conflict_triage.ts";

/** What collided when the default branch was merged down, and how it landed. */
export interface MilestoneSyncConflict {
  /** Repository-relative paths git reported as conflicted. */
  files: string[];
  /** The milestone branch's tip before the merge. */
  milestoneSha: string;
  /** The default branch's tip that was merged in. */
  defaultSha: string;
  /**
   * Which resolution produced the merge that landed.
   *
   * `auto` is the triaged resolution of Issue #1559 — each file decided on its
   * own and verified before the push. `theirs` and `manual` are the older
   * whole-merge resolutions towards the default branch, kept because comments
   * carrying them are already in the wild.
   */
  resolution: "theirs" | "manual" | "auto";
  /**
   * What the triage decided, file by file (Issue #1559). Present only for an
   * `auto` resolution, and the reason each decision was safe to take.
   */
  decisions?: FileDecision[];
}

/** Outcome of a milestone sync merge. */
export interface MilestoneSyncOutcome {
  /** Human-readable summary, as the sync's log line has always carried. */
  message: string;
  /** Present only when git reported conflicting files (Issue #1558). */
  conflict?: MilestoneSyncConflict;
}

/** One side of the merge, as the escalation names it. */
export interface BranchTip {
  /** Branch name, for the reader. */
  branch: string;
  /** The commit that side stood at. */
  sha: string;
  /** First line of that commit's message; empty when it could not be read. */
  subject: string;
}

/**
 * Stands in for a commit that could not be read (Issue #1558). Named rather
 * than blank: a side the escalation could not resolve must say so, not read
 * as an empty field nobody notices.
 */
export const UNRESOLVED_SHA = "unknown";

/** Abbreviate a SHA for prose without losing the full one elsewhere. */
function short(sha: string): string {
  return sha.slice(0, 8);
}

/**
 * The "both sides" section every milestone-sync escalation carries.
 *
 * Named commits are the whole point (Issue #1558): an escalation that says
 * only "the branches diverged" makes the reader reconstruct what changed on
 * each, which is the forensic work this reporting exists to remove.
 */
export function describeBranchTips(tips: BranchTip[]): string {
  const lines = tips.map((tip) =>
    `- \`${tip.branch}\` — \`${tip.sha}\`${
      tip.subject ? ` — ${tip.subject}` : ""
    }`
  );
  return `Both sides at the time of the merge:\n\n${lines.join("\n")}`;
}

/**
 * Resolve both sides of a merge for an escalation, best-effort.
 *
 * SHAs the caller already holds are authoritative and used as-is; where it
 * holds none, the branch name is resolved through the API. Either way the
 * subject line is a nicety — a side whose lookup fails is still named.
 */
export async function resolveBranchTips(
  repo: string,
  sides: { branch: string; sha?: string }[],
  ghCommandFn: GhCommandFn,
  log?: (message: string) => void,
): Promise<BranchTip[]> {
  const tips: BranchTip[] = [];
  for (const side of sides) {
    const ref = side.sha ?? side.branch;
    let sha = side.sha ?? "";
    let subject = "";
    try {
      const out = await ghCommandFn([
        "api",
        `repos/${repo}/commits/${ref}`,
        "--jq",
        '"\\(.sha) \\(.commit.message)"',
      ]);
      // First line only: a commit body is not a subject, and taking it here
      // keeps the jq expression free of escaped newlines.
      const trimmed = (out.split("\n")[0] ?? "").trim();
      if (trimmed) {
        const space = trimmed.indexOf(" ");
        const resolved = space === -1 ? trimmed : trimmed.slice(0, space);
        if (!sha) sha = resolved;
        subject = space === -1 ? "" : trimmed.slice(space + 1).trim();
      }
    } catch (err) {
      // The SHA is what matters, so this does not fail the escalation — but
      // a degraded report says why it is degraded rather than going quiet.
      log?.(
        `Could not read commit '${ref}' in ${repo} for a milestone sync ` +
          `escalation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    tips.push({ branch: side.branch, sha: sha || UNRESOLVED_SHA, subject });
  }
  return tips;
}

/**
 * Title of a conflicting-sync diagnostic the fleet filed before Issue #1769.
 *
 * Keyed on the branch **and** the default-branch commit that conflicted with
 * it, so a branch that conflicted twice against different commits raised two
 * reports. Nothing files one any more — the title survives as the definition
 * the close-out searches by, so the two halves cannot drift.
 */
export function conflictDiagnosticTitle(
  milestoneBranch: string,
  defaultSha: string,
): string {
  return `${conflictDiagnosticTitlePrefix(milestoneBranch)}${
    defaultSha ? short(defaultSha) : UNRESOLVED_SHA
  }`;
}

/**
 * The branch half of {@link conflictDiagnosticTitle}, without the commit.
 *
 * The close-out that retires these diagnostics once the branch syncs
 * (Issue #1769) knows the branch but not which commit conflicted, so both
 * halves read the title from here rather than spelling it twice.
 */
export function conflictDiagnosticTitlePrefix(milestoneBranch: string): string {
  return `Milestone sync merged with conflicts: ${milestoneBranch} @ `;
}

/** Everything the conflict escalation names. */
export interface ConflictEscalation {
  repo: string;
  milestoneBranch: string;
  defaultBranch: string;
  conflict: MilestoneSyncConflict;
  tips: BranchTip[];
}

/**
 * Body of the comment posted the moment a sync merge conflicts.
 *
 * It says what landed, so nobody re-runs the merge to find out; it names the
 * files and both sides' commits, so the reader can diff each side; and it
 * says plainly what has to be checked — that the branch's own work survived
 * a resolution that favoured the default branch.
 */
export function buildConflictEscalationComment(
  e: ConflictEscalation,
): string {
  // A triaged resolution is a different report (Issue #1559): every file was
  // decided on its own and the merged tree was verified before the push, so
  // the reader is told what was decided and why, not asked to check what was
  // overwritten.
  if (e.conflict.resolution === "auto") {
    const decisions = (e.conflict.decisions ?? []).map((d) =>
      `- \`${d.path}\` — **${d.case}**, ${
        d.action === "union"
          ? "kept both sides' hunks"
          : `took the ${
            d.action === "ours"
              ? `\`${e.milestoneBranch}\``
              : `\`${e.defaultBranch}\``
          } side`
      }: ${d.reason}`
    ).join("\n");
    return `## Milestone sync resolved a conflict automatically\n\n` +
      `Merging \`${e.defaultBranch}\` into \`${e.milestoneBranch}\` in ` +
      `\`${e.repo}\` conflicted, and every conflicted file was decided by a ` +
      `rule that loses nothing (Issue #1559). The merged tree passed the ` +
      `repository's own check, its manifest check and its unit suite before ` +
      `it was pushed — a red tree would have been rolled back instead.\n\n` +
      `${decisions || "- (no decision was recorded)"}\n\n` +
      `${describeBranchTips(e.tips)}\n\n` +
      `No conflicted test file was resolved by taking a side that drops ` +
      `cases: a test file resolves only when one side keeps every case and ` +
      `every line of the other. Nothing here needs a human, but the reasoning ` +
      `is on the merge commit if you want to check it.`;
  }

  // A conflict git could not itself name still has to reach a human — an
  // empty list says exactly that rather than rendering as nothing.
  const files = e.conflict.files.length > 0
    ? e.conflict.files.map((f) => `- \`${f}\``).join("\n")
    : "- (git named no conflicting files — inspect the merge commit)";
  const how = e.conflict.resolution === "theirs"
    ? `resolved by favouring \`${e.defaultBranch}\` (\`-X theirs\`)`
    : `resolved file by file, accepting \`${e.defaultBranch}\`'s side`;

  return `## Milestone sync merged with conflicts — check what was overwritten\n\n` +
    `Merging \`${e.defaultBranch}\` into \`${e.milestoneBranch}\` in ` +
    `\`${e.repo}\` conflicted, and was ${how} so the branch keeps moving ` +
    `(Issue #1558). The merge **was pushed** — this is a report, not a ` +
    `blocked sync.\n\n` +
    `Conflicting files:\n\n${files}\n\n` +
    `${describeBranchTips(e.tips)}\n\n` +
    `Check each file above against the milestone side's commit: where both ` +
    `sides changed the same code, the branch's version was replaced by ` +
    `\`${e.defaultBranch}\`'s. Reconcile it now, while the divergence is one ` +
    `day wide — at rollup time the two sides will have solved the same ` +
    `problem twice and the merge becomes a research project.`;
}
