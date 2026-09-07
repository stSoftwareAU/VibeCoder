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

/** What collided when the default branch was merged down, and how it landed. */
export interface MilestoneSyncConflict {
  /** Repository-relative paths git reported as conflicted. */
  files: string[];
  /** The milestone branch's tip before the merge. */
  milestoneSha: string;
  /** The default branch's tip that was merged in. */
  defaultSha: string;
  /** Which resolution produced the merge that landed. */
  resolution: "theirs" | "manual";
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
    } catch {
      // The SHA is what matters; a missing subject is not worth a failure.
    }
    tips.push({ branch: side.branch, sha: sha || "unknown", subject });
  }
  return tips;
}

/**
 * Title of the diagnostic filed for a conflicting sync with no tracking issue.
 *
 * Keyed on the branch **and** the default-branch commit that conflicted with
 * it, so a branch that conflicts twice against different commits raises two
 * reports while the same conflict seen twice raises one.
 */
export function conflictDiagnosticTitle(
  milestoneBranch: string,
  defaultSha: string,
): string {
  return `Milestone sync merged with conflicts: ${milestoneBranch} @ ${
    short(defaultSha)
  }`;
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
