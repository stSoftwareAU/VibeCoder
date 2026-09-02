/**
 * The portable handover note (Issue #769, part of #764).
 *
 * An interrupted run already preserves its *code*: the WIP checkpoints
 * (#4170) and the one-shot preservation (#47) commit and push whatever the
 * agent produced onto the claim-locked issue branch. What it lost was its
 * *intent* — what was done, what was deliberately left, and what comes next
 * lived only in the dead session's own transcript, which is host-local and
 * provider-specific. A worker on another host, or a non-Claude worker, could
 * read none of it.
 *
 * This module writes that intent down as a file committed on the same
 * branch, because git plus GitHub is the only resume contract that holds on
 * any fleet host under any provider. Everything in the note comes from what
 * the worker already knows at the moment of the interruption — cause,
 * elapsed time, the WIP commit subjects, the uncommitted-file list, and
 * whether a wind-down notice was delivered — so it costs no agent call and
 * does not need the agent to still be alive. On the timeout path it is not.
 *
 * The path is deliberately NOT hidden. `gitignore_enforcer.ts` ignores every
 * hidden path in a monitored repo and `pre_commit_safety.ts` refuses to
 * commit one, so a `.vibe/…` note would have been silently dropped by
 * `git add -A` — preserved nowhere, reported as written. `docs/handover/`
 * is tracked, committable, and discoverable by a human or any provider.
 *
 * Every failure here is non-fatal and logged, exactly as a failed WIP
 * checkpoint is: losing the note must never cost the code.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  describeWipCause,
  type WipPreservationCause,
} from "./wip_checkpoint.ts";
import { WIND_DOWN_NOTICE_FILENAME } from "./wind_down_notice.ts";

/** Directory holding one handover note per issue, relative to the clone. */
export const HANDOVER_DIR = "docs/handover";

/** Machine-readable marker identifying a note and its structure version. */
export const HANDOVER_MARKER = '<!-- vibe-handover version="1" -->';

/** How many earlier attempts the "previous attempts" tail keeps. */
export const MAX_PRIOR_ATTEMPTS = 3;

/** Most uncommitted files listed before the note summarises the rest. */
const MAX_LISTED_FILES = 20;

/** Repo-relative path of one issue's handover note. */
export function handoverNotePath(issueNumber: number): string {
  return `${HANDOVER_DIR}/issue-${issueNumber}.md`;
}

/** What the worker knows about the interruption, with no billed call. */
export interface HandoverFacts {
  /** The issue the interrupted run was working. */
  issueNumber: number;
  /** The claim-locked branch the work was preserved onto. */
  branch: string;
  /** What stopped the run. */
  cause: WipPreservationCause;
  /** Seconds the execute ran before it was stopped. */
  elapsedSeconds: number;
  /** UTC instant of the interruption, ISO-8601 with seconds precision. */
  interruptedAtIso: string;
  /** Repo-relative paths the interruption left uncommitted. */
  dirtyFiles: readonly string[];
  /** Subjects of the commits this run added to the branch. */
  wipCommitSubjects: readonly string[];
  /**
   * Whether the run was handed a wind-down notice before it stopped
   * (Issue #508). Left undefined by callers that do not know; the writer
   * probes the checkout for the notice file instead.
   */
  windDownNoticeDelivered?: boolean;
  /** Attempt lines carried over from the note this one replaces. */
  priorAttempts?: readonly string[];
}

/** What one write attempt did. */
export interface HandoverNoteOutcome {
  kind: "written" | "skipped" | "failed";
  /** Repo-relative path written, when the write succeeded. */
  path?: string;
  /** Why the note was skipped or could not be written. */
  reason?: string;
}

/**
 * True when a path is repo-relative and therefore portable.
 *
 * A host path in the note is exactly the failure this issue exists to
 * prevent: it survives a "file exists" check while being useless to a
 * worker on another host.
 */
function isPortablePath(path: string): boolean {
  return path.length > 0 &&
    !path.startsWith("/") &&
    !path.startsWith("~") &&
    !/^[A-Za-z]:[\\/]/.test(path) &&
    !path.includes("\\");
}

/** The one-line summary of an attempt, and the unit the tail is kept in. */
function buildAttemptLine(facts: HandoverFacts): string {
  const files = facts.dirtyFiles.length;
  const commits = facts.wipCommitSubjects.length;
  return `${facts.interruptedAtIso} — execute ${
    describeWipCause(facts.cause)
  } after ${facts.elapsedSeconds}s; ${files} uncommitted file(s) preserved; ` +
    `${commits} commit(s) added to the branch`;
}

/**
 * Every attempt line a note records, newest first, in the order written.
 *
 * The line format is the note's only parsed structure, so a later claim can
 * see that earlier runs were interrupted without re-reading the whole file.
 */
export function extractAttemptLines(note: string): string[] {
  return note.split("\n")
    .map((line) => line.trim())
    .filter((line) => /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z — /.test(line))
    .map((line) => line.slice(2).trim());
}

/** Render the note a later claim (or a human) reads. */
export function buildHandoverNote(facts: HandoverFacts): string {
  const files = facts.dirtyFiles.filter(isPortablePath);
  const dropped = facts.dirtyFiles.length - files.length;
  const listed = files.slice(0, MAX_LISTED_FILES);
  const commits = facts.wipCommitSubjects.filter((s) => s.trim().length > 0);
  const priorAttempts = (facts.priorAttempts ?? []).slice(
    0,
    MAX_PRIOR_ATTEMPTS,
  );

  const lines: string[] = [
    `# Handover — issue #${facts.issueNumber}`,
    "",
    HANDOVER_MARKER,
    "",
    "An earlier run working this issue was interrupted before it finished.",
    "The worker wrote this note — not the agent — so any host and any tooling",
    "can pick the work up from this branch. It carries nothing tied to one",
    "host, one conversation or one agent provider.",
    "",
    "## This attempt",
    "",
    `- ${buildAttemptLine(facts)}`,
    `- Branch: \`${facts.branch}\``,
    `- Wind-down notice: ${
      facts.windDownNoticeDelivered
        ? "delivered — the run was warned it was running out of budget"
        : "not delivered — the interruption arrived without warning"
    }`,
    "",
    "## What was done",
    "",
  ];

  if (commits.length > 0) {
    lines.push("Commits this run added to the branch, newest first:", "");
    for (const subject of commits) lines.push(`- ${subject}`);
    lines.push("");
  } else {
    lines.push(
      "No commit was recorded for this run beyond the preservation below.",
      "",
    );
  }

  if (listed.length > 0) {
    lines.push(
      "Files the run left uncommitted, preserved onto this branch by the",
      "same interruption:",
      "",
    );
    for (const file of listed) lines.push(`- \`${file}\``);
    const unlisted = files.length - listed.length;
    if (unlisted > 0) lines.push(`- …and ${unlisted} more file(s)`);
    lines.push("");
  } else {
    lines.push(
      "The working tree was clean at the interruption — the work above is",
      "already committed on this branch.",
      "",
    );
  }
  if (dropped > 0) {
    lines.push(
      `${dropped} path(s) were omitted because they were not repo-relative.`,
      "",
    );
  }

  lines.push(
    "## What remains",
    "",
    "The run was interrupted, so it never reported completion: whatever the",
    "issue still asks for beyond the changes above is outstanding. Review the",
    "diff against the base branch, continue from it, and do not revert it",
    "unless it is wrong.",
    "",
    "## Known blockers",
    "",
    "None were recorded. The run was stopped by the interruption named above,",
    "not by a blocker it reported.",
    "",
  );

  if (priorAttempts.length > 0) {
    lines.push(
      "## Previous attempts",
      "",
      "Earlier runs on this issue were interrupted too:",
      "",
    );
    for (const attempt of priorAttempts) lines.push(`- ${attempt}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Read the note this write replaces, or `undefined` when there is none. */
async function readExistingNote(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return undefined;
  }
}

/** True when `path` exists. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Options for {@link writeHandoverNote}. */
export interface WriteHandoverNoteOptions {
  /** The issue clone the agent was working in. */
  repoPath: string;
  /** What the worker knows about the interruption. */
  facts: HandoverFacts;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}

/**
 * Write (or rewrite) the handover note in the clone, ready to be committed
 * by the preservation that follows.
 *
 * Never throws: a failure is returned and logged, exactly as a failed WIP
 * checkpoint is, so losing the note can never cost the code.
 */
export async function writeHandoverNote(
  options: WriteHandoverNoteOptions,
): Promise<HandoverNoteOutcome> {
  const { repoPath, facts, logger } = options;
  const relativePath = handoverNotePath(facts.issueNumber);
  const absolutePath = `${repoPath}/${relativePath}`;
  try {
    // Only ever write into a real clone. Anywhere else the note could not be
    // committed, and creating the directory tree would invent a repo.
    if (!await pathExists(`${repoPath}/.git`)) {
      const reason = "the working directory is not a git clone";
      logger?.info(`Handover note skipped: ${reason} (Issue #769)`);
      return { kind: "skipped", reason };
    }

    const existing = await readExistingNote(absolutePath);
    const windDownNoticeDelivered = facts.windDownNoticeDelivered ??
      await pathExists(`${repoPath}/${WIND_DOWN_NOTICE_FILENAME}`);
    const note = buildHandoverNote({
      ...facts,
      windDownNoticeDelivered,
      // Rewritten, never appended (Issue #769) — but a third claim must
      // still see that two prior runs were interrupted.
      priorAttempts: existing ? extractAttemptLines(existing) : [],
    });

    await Deno.mkdir(`${repoPath}/${HANDOVER_DIR}`, { recursive: true });
    await Deno.writeTextFile(absolutePath, note);
    logger?.info(
      `Handover note written to '${relativePath}' for the next claim ` +
        `(Issue #769)`,
    );
    return { kind: "written", path: relativePath };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger?.warn(
      `Handover note could not be written (non-fatal): ${reason} ` +
        `(Issue #769)`,
    );
    return { kind: "failed", reason };
  }
}
