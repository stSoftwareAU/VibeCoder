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
 * The path is {@link handoverFilePath} — `docs/archive/handover/issue-<N>.md`
 * — defined once in `preserved_wip_branch.ts` so the writer here, the release
 * comment that advertises it (#770) and the resuming prompt that reads it
 * (#771) can never point at different files. A `.vibe/…` note as the issue
 * sketched could never have been committed: `gitignore_enforcer.ts` ignores
 * every hidden path in a monitored repo and `pre_commit_safety.ts` refuses to
 * commit one, so `git add -A` would have dropped it silently — preserved
 * nowhere, reported as written. `docs/archive/` is excluded from the Jekyll
 * build, the markdownlint globs and the page-title manifest, so a note left
 * on a WIP branch cannot trip a docs gate and strand the very branch it
 * exists to rescue.
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
import { redactSecrets } from "./secret_redaction.ts";
import { handoverFilePath } from "./preserved_wip_branch.ts";

/**
 * Machine-readable marker identifying a note and its structure version.
 *
 * Deliberately NOT an HTML comment: the resuming run splices this file into
 * its prompt through `fenceUntrustedIssueText`, whose `neutraliseHtmlComments`
 * rewrites `<!--` (Issue #771). A marker mangled before its only consumer
 * reads it is not machine-readable, so it is a visible code span instead.
 */
export const HANDOVER_MARKER = "`vibe-handover version=1`";

/** How many earlier attempts the "previous attempts" tail keeps. */
export const MAX_PRIOR_ATTEMPTS = 3;

/** Most uncommitted files listed before the note summarises the rest. */
const MAX_LISTED_FILES = 20;

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
  /**
   * Repo-relative paths the interruption left uncommitted — `null` when git
   * could not be asked. An empty list means "the tree was clean", which is a
   * fact; `null` means the worker does not know, and the note says so rather
   * than writing a clean tree into a permanent record on a failed `git
   * status`.
   */
  dirtyFiles: readonly string[] | null;
  /**
   * Subjects of the commits this run added to the branch — `null` when the
   * log could not be read, distinguished from an empty list for the same
   * reason as {@link HandoverFacts.dirtyFiles}.
   */
  wipCommitSubjects: readonly string[] | null;
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

/**
 * Replace anything unportable in free text the worker copies verbatim — the
 * commit subjects the agent wrote.
 *
 * Two shapes matter, and both survive a "file exists" check while making the
 * note useless to a worker on another host: an absolute host path, and a
 * session id (a UUID, or a long opaque hex token) tying the note to one
 * conversation with one provider.
 */
function stripNonPortable(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s"'`]*/g, "<path>")
    .replace(
      /(^|[\s"'`(])~?\/[^\s"'`]+/g,
      (_m, lead: string) => `${lead}<path>`,
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "<session-id>",
    )
    .replace(/\b[0-9a-f]{32,}\b/gi, "<session-id>");
}

/**
 * Defuse Liquid tags in interpolated content.
 *
 * The note is committed into a repository whose `docs/` tree may be built by
 * GitHub Pages, and a stray `{%`/`{{` inside a commit subject or a path would
 * break that build. Only interpolated values are treated — the note's own
 * prose carries no braces.
 */
function defuseLiquid(text: string): string {
  return text.replace(/\{\{/g, "{ {").replace(/\{%/g, "{ %");
}

/** `"3"`, or `"an unknown number of"` when git could not be asked. */
function countOrUnknown(items: readonly string[] | null): string {
  return items === null ? "an unknown number of" : String(items.length);
}

/**
 * The one-line summary of an attempt, and the unit the tail is kept in.
 *
 * Counts the files the note actually lists — not the raw input — so the line
 * can never claim more preserved files than the body names.
 */
function buildAttemptLine(
  facts: HandoverFacts,
  listedFiles: readonly string[] | null,
): string {
  return `${facts.interruptedAtIso} — execute ${
    describeWipCause(facts.cause)
  } after ${facts.elapsedSeconds}s; ${
    countOrUnknown(listedFiles)
  } uncommitted file(s) preserved; ` +
    `${countOrUnknown(facts.wipCommitSubjects)} commit(s) added to the branch`;
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
  const files = (facts.dirtyFiles ?? []).filter(isPortablePath);
  const dropped = (facts.dirtyFiles ?? []).length - files.length;
  const listed = files.slice(0, MAX_LISTED_FILES);
  const commits = (facts.wipCommitSubjects ?? []).filter((s) =>
    s.trim().length > 0
  );
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
    `- ${buildAttemptLine(facts, facts.dirtyFiles === null ? null : files)}`,
    `- Branch: \`${defuseLiquid(facts.branch)}\``,
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
    for (const subject of commits) {
      lines.push(`- ${defuseLiquid(stripNonPortable(subject))}`);
    }
    lines.push("");
  } else if (facts.wipCommitSubjects === null) {
    // Never write "no commits" from a failed `git log` — an unreadable log is
    // not a fact about the run, and this note is a permanent record.
    lines.push(
      "The commit log could not be read at the interruption, so what this run",
      "committed is unknown here — read `git log` on this branch.",
      "",
    );
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
    for (const file of listed) lines.push(`- \`${defuseLiquid(file)}\``);
    const unlisted = files.length - listed.length;
    if (unlisted > 0) lines.push(`- …and ${unlisted} more file(s)`);
    lines.push("");
  } else if (facts.dirtyFiles === null) {
    lines.push(
      "The working tree could not be inspected at the interruption, so",
      "whether anything was left uncommitted is unknown here — run",
      "`git status` on this branch.",
      "",
    );
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
    `The run was interrupted after ${facts.elapsedSeconds}s, so it never ` +
      "reported completion: whatever the issue still asks for beyond the " +
      "changes above is outstanding.",
    "",
    `Diff \`${defuseLiquid(facts.branch)}\` against its base branch to see ` +
      `the ${countOrUnknown(facts.wipCommitSubjects)} commit(s) and ${
        countOrUnknown(facts.dirtyFiles === null ? null : files)
      } preserved ` +
      "file(s) named above, continue from them, and do not revert them " +
      "unless they are wrong.",
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

  // The note is committed and pushed, so it is an outbound sink like any
  // other: anything the run's own commit subjects or paths carried through
  // is redacted before it can reach the branch.
  return redactSecrets(lines.join("\n"));
}

/**
 * Read the note this write replaces, or `undefined` when there is none.
 *
 * "No note yet" and "the note could not be read" are different facts: the
 * first is the ordinary first interruption, the second is a fault and is
 * logged as one. Neither stops the new note being written — losing the tail
 * is better than losing the note.
 */
async function readExistingNote(
  path: string,
  logger?: { warn: (message: string) => void },
): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logger?.warn(
        `Existing handover note could not be read, so the previous-attempts ` +
          `tail is lost: ${
            err instanceof Error ? err.message : String(err)
          } (Issue #769)`,
      );
    }
    return undefined;
  }
}

/**
 * True when `path` exists. A stat fault other than "not found" is a real
 * failure and is raised, never reported as a benign absence.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
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
  const relativePath = handoverFilePath(facts.issueNumber);
  const absolutePath = `${repoPath}/${relativePath}`;
  const directory = absolutePath.slice(0, absolutePath.lastIndexOf("/"));
  try {
    // Only ever write into a real clone. Anywhere else the note could not be
    // committed, and creating the directory tree would invent a repo.
    if (!await pathExists(`${repoPath}/.git`)) {
      const reason = "the working directory is not a git clone";
      logger?.info(`Handover note skipped: ${reason} (Issue #769)`);
      return { kind: "skipped", reason };
    }

    const existing = await readExistingNote(absolutePath, logger);
    const windDownNoticeDelivered = facts.windDownNoticeDelivered ??
      await pathExists(`${repoPath}/${WIND_DOWN_NOTICE_FILENAME}`);
    const note = buildHandoverNote({
      ...facts,
      windDownNoticeDelivered,
      // Rewritten, never appended (Issue #769) — but a third claim must
      // still see that two prior runs were interrupted.
      priorAttempts: existing ? extractAttemptLines(existing) : [],
    });

    await Deno.mkdir(directory, { recursive: true });
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
