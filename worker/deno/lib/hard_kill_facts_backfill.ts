/**
 * Backfill the public facts of archived hard kills onto their open issue
 * (Issue #4815).
 *
 * This runs for every archived file not yet named `*.facts.json`, including
 * files archived by older worker versions after the fields were published, not
 * only issues filed before the fields existed. Issues filed before the "Last step logged", "Silent before capture", "Guest
 * probe", "Guest memory" and "Guest pressure" lines were published carry no
 * such facts. The evidence is still in `~/logs/hard-kill-archive/` on the host
 * that filed them, so an issue run on another host cannot diagnose them. On
 * each hard-kill reporting pass this module posts, once per archived file, ONE
 * comment on the open issue for the file's signature. The comment carries the
 * same fixed-shape facts the issue body uses (never log text), and the file is
 * then renamed to `*.facts.json` so it is never posted again. A file whose
 * post failed keeps its name and is retried on the next start.
 *
 * Nothing here throws for a per-file fault; a fault is logged and the file is
 * kept. No run callback fires and nothing is counted: the kill was reported
 * when it was first filed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { HardKillEvidence } from "./hard_kill_evidence.ts";
import {
  factsPostedName,
  HARD_KILL_ARCHIVE_DIR,
  HARD_KILL_ARCHIVE_SENTENCE,
  HARD_KILL_FACTS_POSTED_SUFFIX,
  HARD_KILL_FILE_PATTERN,
  hardKillFactLines,
  type HardKillSignature,
  hardKillSignature,
  parseHardKillEvidence,
} from "./hard_kill_report.ts";
import {
  findOpenRunFailureIssue,
  RUN_FAILURE_TARGET_REPO,
} from "./run_failure_issue.ts";

/** The marker that names the run whose facts a comment carries. */
export function hardKillFactsMarker(runId: string): string {
  return `<!-- vibe-hard-kill-facts run="${runId}" -->`;
}

/** The comment that adds the facts of an archived kill to its open issue. */
export function formatHardKillFactsComment(
  evidence: HardKillEvidence,
  sig: HardKillSignature,
): string {
  return [
    hardKillFactsMarker(evidence.runId),
    "",
    "**Facts for an archived kill** (Issue #4815): added once from the evidence archived on the host, so this issue carries them even when it was filed before these fields were published.",
    "",
    ...hardKillFactLines(evidence, sig),
    "",
    HARD_KILL_ARCHIVE_SENTENCE,
  ].join("\n");
}

/** Filesystem seams, so a test never touches the host's log directory. */
export interface HardKillFactsSeams {
  /** Paths of the archived files whose facts were not yet posted. */
  listArchivedFiles(archiveDir: string): Promise<string[]>;
  readTextFile(path: string): Promise<string>;
  /** Rename the file so the backfill never posts it again. */
  markFactsPosted(path: string): Promise<void>;
}

/** Production filesystem seams. */
export const defaultHardKillFactsSeams: HardKillFactsSeams = {
  async listArchivedFiles(archiveDir: string): Promise<string[]> {
    try {
      if (!(await Deno.lstat(archiveDir)).isDirectory) {
        throw new Error("hard-kill archive is not a plain directory");
      }
    } catch (err) {
      if (
        err instanceof Deno.errors.NotFound ||
        (err instanceof Error && err.name === "NotFound")
      ) {
        return [];
      }
      throw err;
    }
    const paths: string[] = [];
    for await (const entry of Deno.readDir(archiveDir)) {
      if (
        entry.isFile && HARD_KILL_FILE_PATTERN.test(entry.name) &&
        !entry.name.endsWith(HARD_KILL_FACTS_POSTED_SUFFIX)
      ) {
        paths.push(`${archiveDir}/${entry.name}`);
      }
    }
    return paths;
  },
  readTextFile: (path: string) => Deno.readTextFile(path),
  async markFactsPosted(path: string): Promise<void> {
    const cut = path.lastIndexOf("/");
    await Deno.rename(
      path,
      `${path.slice(0, cut)}/${factsPostedName(path.slice(cut + 1))}`,
    );
  },
};

export interface BackfillHardKillFactsOptions {
  /** Host log directory; the archive is inside it. */
  evidenceDir: string;
  /** gh runner: resolves stdout, rejects on failure. */
  ghFn: (args: string[]) => Promise<string>;
  /** Signature to open issue number, already known in this pass. */
  knownIssues?: Map<string, number>;
  fleetAuthors?: readonly string[];
  seams?: HardKillFactsSeams;
  log?: (message: string) => void;
  logWarn?: (message: string) => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLine(err: unknown): string {
  return errorText(err).split("\n")[0]?.trim() || "no message";
}

/**
 * Post the facts of each archived hard kill whose facts were never posted.
 * Never throws for a per-file fault.
 */
export async function backfillArchivedHardKillFacts(
  opts: BackfillHardKillFactsOptions,
): Promise<{ posted: number; marked: number; kept: number }> {
  const log = opts.log ?? (() => {});
  const logWarn = opts.logWarn ?? (() => {});
  const seams = opts.seams ?? defaultHardKillFactsSeams;
  const result = { posted: 0, marked: 0, kept: 0 };
  const archiveDir = `${opts.evidenceDir}/${HARD_KILL_ARCHIVE_DIR}`;

  let paths: string[];
  try {
    paths = await seams.listArchivedFiles(archiveDir);
  } catch (err) {
    logWarn(
      `hard-kill facts backfill could not list ${archiveDir}: ${
        errorText(err)
      }`,
    );
    return result;
  }
  const byName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  paths = [...paths].sort((a, b) =>
    byName(a) < byName(b) ? -1 : byName(a) > byName(b) ? 1 : 0
  );
  // Signature to open issue number, or null when it has none (this pass).
  const cache = new Map<string, number | null>();

  for (const path of paths) {
    const name = byName(path);
    let evidence: HardKillEvidence;
    try {
      evidence = parseHardKillEvidence(await seams.readTextFile(path));
    } catch (err) {
      logWarn(
        `hard-kill facts backfill: ${name} could not be read or parsed, kept: ${
          errorText(err)
        }`,
      );
      result.kept++;
      continue;
    }
    const sig = hardKillSignature(evidence);

    let issue: number | null | undefined = opts.knownIssues?.get(
      sig.failureClass,
    ) ?? cache.get(sig.failureClass);
    if (issue === undefined) {
      try {
        const match = await findOpenRunFailureIssue({
          ghFn: opts.ghFn,
          targetRepo: RUN_FAILURE_TARGET_REPO,
          failureClass: sig.failureClass,
          fleetAuthors: opts.fleetAuthors,
          log,
        });
        issue = match ? match.number : null;
        cache.set(sig.failureClass, issue);
      } catch (err) {
        logWarn(
          `hard-kill facts backfill: ${name}: issue lookup failed, kept: ${
            firstLine(err)
          }`,
        );
        result.kept++;
        continue;
      }
    }

    if (issue === null) {
      logWarn(
        `hard-kill facts backfill: ${name}: no verified open issue, kept for the next start`,
      );
      result.kept++;
      continue;
    }

    try {
      await opts.ghFn([
        "issue",
        "comment",
        String(issue),
        "--repo",
        RUN_FAILURE_TARGET_REPO,
        "--body",
        formatHardKillFactsComment(evidence, sig),
      ]);
    } catch (err) {
      logWarn(
        `hard-kill facts backfill: ${name}: comment on #${issue} failed, kept for the next start: ${
          firstLine(err)
        }`,
      );
      result.kept++;
      continue;
    }
    result.posted++;
    try {
      await seams.markFactsPosted(path);
    } catch (err) {
      logWarn(
        `hard-kill facts backfill: ${name} was posted to #${issue} but could not be marked, so the facts may be posted again next start: ${
          firstLine(err)
        }`,
      );
    }
  }
  return result;
}
