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
import { describeDecisionRung } from "./milestone_conflict_triage.ts";
import type { FileDecision } from "./milestone_conflict_triage.ts";

/** One repair round the verification failure sent back to the agent rung. */
export interface GateRepairRound {
  /** Which round this was, 1-based. */
  round: number;
  /** Repository-relative paths the round changed. */
  files: string[];
}

/**
 * A resolution the verification refused and the agent rung then repaired
 * (Issue #1965).
 *
 * Recorded because a semantic resolution reads nothing like a textual one:
 * the files it touched are the ones the compiler named, which are routinely
 * files git never reported as conflicted at all.
 */
export interface GateRepairRecord {
  /** The gate command that refused the first resolution. */
  failingCommand: string;
  /** The rounds that ran, in order. */
  rounds: GateRepairRound[];
}

/**
 * List what each repair round touched, one line apiece (Issue #1965).
 *
 * One renderer, two sinks: the merge commit and the report comment want the
 * paths in backticks, the escalation's plain-text note does not, and writing
 * the list twice is how the two drift.
 *
 * @param rounds - The rounds that ran, in order
 * @param opts.code - Wrap each path in backticks (Markdown sinks)
 * @returns One bullet per round, or "" when no round ran
 */
export function listGateRepairRounds(
  rounds: readonly GateRepairRound[],
  opts: { code?: boolean } = {},
): string {
  return rounds.map((r) =>
    `- round ${r.round} — ${
      r.files.length > 0
        ? r.files.map((f) => opts.code ? `\`${f}\`` : f).join(", ")
        : "no file changed"
    }`
  ).join("\n");
}

/**
 * Name the repair on the merge commit and in the sync's report (Issue #1965).
 *
 * @param record - What the repair rounds touched
 * @returns The block, naming the failure, each round's files and the outcome
 */
export function describeGateRepair(record: GateRepairRecord): string {
  const rounds = listGateRepairRounds(record.rounds, { code: true });
  return `The verification refused the first resolution (${record.failingCommand}), ` +
    `so it went back to the resolution agent rather than to a human ` +
    `(Issue #1965) — a semantic conflict git never reported as one. ` +
    `Repaired in ${record.rounds.length} round(s):\n\n` +
    `${rounds || "- (no round recorded)"}\n\n` +
    `The verification passed after the repair.`;
}

/**
 * The one-line form of {@link describeGateRepair}, for the sync's log line.
 *
 * @param record - What the repair rounds touched
 * @returns One line naming the rounds and the files they touched
 */
export function summariseGateRepair(record: GateRepairRecord): string {
  const files = record.rounds.flatMap((r) => r.files);
  return `Issue #1965: the verification refused the resolution and the agent ` +
    `rung repaired it in ${record.rounds.length} round(s) — ${
      files.length > 0 ? files.join(", ") : "no file changed"
    }`;
}

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
  /**
   * Present when the verification refused the first resolution and the agent
   * rung repaired it (Issue #1965), so a reader can tell a textual resolution
   * from a semantic one.
   */
  repair?: GateRepairRecord;
  /**
   * The resolution agent's own reply (Issue #2306), naming each judgement
   * call file by file.
   *
   * There is no PR comment on this path, so the sync report is where those
   * `Judgement:` lines become auditable. Absent when no agent rung ran or it
   * wrote nothing.
   */
  agentReply?: string;
  /**
   * The attempt's stage timings and the host it ran on (Issue #2308), already
   * rendered by `formatStageTimings`.
   *
   * A sync merge routinely runs for twenty minutes or more; this line is what
   * says which rung spent them. Absent when nothing was timed.
   */
  timings?: string;
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
 *
 * Either report ends with the stage timings and the host (Issue #2308), so
 * the minutes the sync spent are accounted for wherever it is read.
 */
export function buildConflictEscalationComment(
  e: ConflictEscalation,
): string {
  // One suffix, both reports: the success notice above and the
  // check-what-was-overwritten report below must not drift apart.
  const timings = e.conflict.timings && e.conflict.timings.trim().length > 0
    ? `\n\n${e.conflict.timings.trim()}`
    : "";
  // A triaged resolution is a different report (Issue #1559): every file was
  // decided on its own and the merged tree was verified before the push, so
  // the reader is told what was decided and why, not asked to check what was
  // overwritten.
  if (e.conflict.resolution === "auto") {
    const decisions = (e.conflict.decisions ?? []).map((d) =>
      `- \`${d.path}\` — ${
        describeDecisionRung(d, {
          ours: `\`${e.milestoneBranch}\``,
          theirs: `\`${e.defaultBranch}\``,
        })
      }`
    ).join("\n");
    // A resolution the gate refused and the agent rung then repaired is a
    // different story again (Issue #1965): the reader is told which files the
    // compiler named, because they are rarely the conflicted ones.
    const repairNote = e.conflict.repair
      ? `\n\n${describeGateRepair(e.conflict.repair)}`
      : "";
    // Issue #2306: the agent names every judgement call file by file in its
    // reply, and this comment is the only place that record surfaces on the
    // milestone path. It is agent-authored text, so it is reproduced as a
    // quoted block rather than folded into the worker's own prose.
    const judgements = e.conflict.agentReply
      ? `\n\n**The resolution agent's own account:**\n\n${
        e.conflict.agentReply.split("\n").map((line) => `> ${line}`.trimEnd())
          .join("\n")
      }`
      : "";
    return `## Milestone sync resolved a conflict automatically\n\n` +
      `Merging \`${e.defaultBranch}\` into \`${e.milestoneBranch}\` in ` +
      `\`${e.repo}\` conflicted, and every conflicted file was settled by a ` +
      `rung of the ladder — the triage, the dependency rules, then the ` +
      `resolution agent (Issues #1559, #1777). The merged tree passed the ` +
      `repository's own check, its manifest check and its unit suite before ` +
      `it was pushed — a red tree would have been rolled back instead.\n\n` +
      `${
        decisions || "- (no decision was recorded)"
      }${judgements}${repairNote}\n\n` +
      `${describeBranchTips(e.tips)}\n\n` +
      `No conflicted test file was resolved by taking a side that drops ` +
      `cases: a test file resolves only when one side keeps every case and ` +
      `every line of the other. Nothing here needs a human, but the reasoning ` +
      `is on the merge commit if you want to check it.${timings}`;
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
    `problem twice and the merge becomes a research project.${timings}`;
}
