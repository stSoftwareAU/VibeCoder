/**
 * Report-only ledger of `SIMPLE-ON-PURPOSE` markers (Issue #4027).
 *
 * Lists every marker in the tracked non-Markdown text files for review.
 * Deterministic and native (no LLM, network or script execution). Fail-loud: a
 * failed list or read returns `ok: false`. Markdown files, binary files (those
 * holding a NUL byte) and oversized (over 1 MiB) files are skipped; non-regular
 * entries (submodule gitlinks, symlinks) are not read.
 */

import { runGitCommand } from "./git_timeout.ts";

/** One `SIMPLE-ON-PURPOSE:` marker found in a file. */
export interface SimpleOnPurposeMarker {
  /** Repository-relative path of the file holding the marker. */
  path: string;
  /** 1-based line of the marker (its first line when it wraps). */
  line: number;
  /** Text before the upgrade clause, trimmed; `""` when there is none. */
  ceiling: string;
  /** Text after `upgrade when`, trimmed; `null` when absent or empty. */
  upgradeWhen: string | null;
}

/** The ledger a scan produces. */
export interface SimpleOnPurposeLedger {
  /** Every marker, sorted by path then line. */
  markers: SimpleOnPurposeMarker[];
  /** The subset whose `upgradeWhen` is `null`. */
  missingUpgradeWhen: SimpleOnPurposeMarker[];
}

export interface ScanSimpleOnPurposeOptions {
  /** Absolute path of the repository checkout to scan. */
  repoPath: string;
  /** Lists tracked files as repo-relative paths. Defaults to `git ls-files -z`. */
  listFiles?: (repoPath: string) => Promise<string[]>;
  /** Reads a file as text. Defaults to a binary- and size-aware reader. */
  readFile?: (absPath: string) => Promise<string>;
}

export type SimpleOnPurposeScanResult =
  | { ok: true; value: SimpleOnPurposeLedger }
  | { ok: false; error: string };

const KEYWORD = "SIMPLE-ON-PURPOSE:";

/** Comment openers, longest first where one is a prefix of another. */
const OPENERS: readonly string[] = ["<!--", "/*", "//", "--", "#", ";", "*"];

/** Block-comment closers that can end a single-line marker. */
const CLOSERS: readonly string[] = ["*/", "-->"];

/** Dashes that may separate the ceiling from the clause: em, en, hyphen. */
const DASHES = "—–-";

/** The upgrade clause. A literal with no quantifier, so it cannot backtrack. */
const UPGRADE_CLAUSE = /upgrade when\b/i;

/** Files larger than this are skipped rather than scanned. */
const MAX_SCAN_BYTES = 1024 * 1024;

/** Most same-opener comment lines one marker may join. */
const MAX_CONTINUATION_LINES = 5;

/** Longest cell rendered in the report before it is truncated. */
const CELL_LIMIT = 300;

/** Splits a line into its comment opener and the text after it, or `null`. */
function commentLine(line: string): { opener: string; rest: string } | null {
  const trimmed = line.trimStart();
  const opener = OPENERS.find((o) => trimmed.startsWith(o));
  if (opener === undefined) return null;
  return { opener, rest: trimmed.slice(opener.length).trimStart() };
}

/** The marker's opener and body when the line is a marker line, else `null`. */
function markerLine(line: string): { opener: string; body: string } | null {
  const comment = commentLine(line);
  if (comment === null || !comment.rest.startsWith(KEYWORD)) return null;
  return { opener: comment.opener, body: comment.rest.slice(KEYWORD.length) };
}

/** Text a wrapped marker continues onto, or `null` if the line does not. */
function continuationText(line: string, opener: string): string | null {
  const continuationOpener = opener === "/*" ? "*" : opener;
  const comment = commentLine(line);
  if (
    comment === null || comment.opener !== continuationOpener ||
    line.includes(KEYWORD)
  ) {
    return null;
  }
  // A `*/` line closes the block rather than continuing the marker.
  if (continuationOpener === "*" && comment.rest.startsWith("/")) return null;
  return comment.rest.length > 0 ? comment.rest : null;
}

/** Drops one trailing block-comment closer from a single-line marker body. */
function stripCloser(body: string): string {
  for (const closer of CLOSERS) {
    if (body.endsWith(closer)) return body.slice(0, -closer.length).trim();
  }
  return body;
}

/** Trims whitespace and dash characters from the end of a ceiling. */
function trimCeiling(text: string): string {
  let end = text.length;
  while (end > 0) {
    const ch = text.charAt(end - 1);
    if (!DASHES.includes(ch) && !/\s/.test(ch)) break;
    end--;
  }
  return text.slice(0, end);
}

/**
 * The condition after `upgrade when`, or `null` when it is empty. The clause
 * is matched in `body`, which must already have its closer stripped.
 */
function clauseCondition(
  body: string,
  clause: RegExpExecArray,
): string | null {
  let condition = body.slice(clause.index + clause[0].length).trim();
  if (condition.startsWith(":") || condition.startsWith(",")) {
    condition = condition.slice(1).trim();
  }
  return condition === "" ? null : condition;
}

/** Splits a joined marker body at the upgrade clause. */
function toMarker(
  path: string,
  line: number,
  rawBody: string,
): SimpleOnPurposeMarker {
  const body = stripCloser(rawBody.trim());
  const clause = UPGRADE_CLAUSE.exec(body);
  if (clause === null) {
    return { path, line, ceiling: trimCeiling(body), upgradeWhen: null };
  }
  return {
    path,
    line,
    ceiling: trimCeiling(body.slice(0, clause.index)),
    upgradeWhen: clauseCondition(body, clause),
  };
}

/**
 * Whether the next continuation line joins a marker whose body so far is
 * `body`. Joins when the `upgrade when` clause has an empty condition, or when
 * there is no clause and the body ends in a dash or comma (after any closer is
 * stripped) or the next line starts with `upgrade when`. Otherwise stops.
 */
function joinsNext(body: string, next: string): boolean {
  const text = stripCloser(body.trim());
  const clause = UPGRADE_CLAUSE.exec(text);
  if (clause !== null) return clauseCondition(text, clause) === null;
  const last = text.slice(-1);
  const endsOpen = last !== "" && (DASHES.includes(last) || last === ",");
  return endsOpen || /^upgrade when\b/i.test(next);
}

/**
 * Every marker in one file's text, in line order. A marker may join up to
 * `MAX_CONTINUATION_LINES` following same-opener comment lines, one at a time,
 * under the rule in `joinsNext`; the marker reports its first line.
 */
export function parseSimpleOnPurposeMarkers(
  path: string,
  text: string,
): SimpleOnPurposeMarker[] {
  const lines = text.split("\n");
  const markers: SimpleOnPurposeMarker[] = [];
  for (const [i, line] of lines.entries()) {
    const found = markerLine(line);
    if (found === null) continue;
    let body = found.body;
    let joined = 0;
    for (
      let j = i + 1;
      j < lines.length && joined < MAX_CONTINUATION_LINES;
      j++
    ) {
      const more = continuationText(lines[j] ?? "", found.opener);
      if (more === null || !joinsNext(body, more)) break;
      body = `${body} ${more}`;
      joined++;
    }
    markers.push(toMarker(path, i + 1, body));
  }
  return markers;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tracked files from `git ls-files -z`, run in the repository. */
async function listTrackedFiles(repoPath: string): Promise<string[]> {
  const result = await runGitCommand(["ls-files", "-z"], { cwd: repoPath });
  if (!result.ok) throw result.error;
  const out = result.value;
  if (out.code !== 0) {
    throw new Error(`git ls-files exited ${out.code}: ${out.stderr.trim()}`);
  }
  return out.stdout.split("\0").filter((p) => p.length > 0);
}

/** Default reader: regular files only; binary or oversized files read as "". */
async function readScannableFile(absPath: string): Promise<string> {
  const info = await Deno.lstat(absPath);
  if (!info.isFile || info.size > MAX_SCAN_BYTES) return "";
  const bytes = await Deno.readFile(absPath);
  if (bytes.includes(0)) return "";
  return new TextDecoder().decode(bytes);
}

/**
 * Collects every marker in the tracked non-Markdown text files. Markdown files
 * are skipped, so a `SIMPLE-ON-PURPOSE:` marker in a `.md` file is not listed.
 */
export async function scanSimpleOnPurpose(
  opts: ScanSimpleOnPurposeOptions,
): Promise<SimpleOnPurposeScanResult> {
  const listFiles = opts.listFiles ?? listTrackedFiles;
  const readFile = opts.readFile ?? readScannableFile;

  let files: string[];
  try {
    files = await listFiles(opts.repoPath);
  } catch (error) {
    return {
      ok: false,
      error: `could not list tracked files in ${opts.repoPath}: ${
        describe(error)
      }`,
    };
  }

  const markers: SimpleOnPurposeMarker[] = [];
  for (const path of files) {
    if (path.toLowerCase().endsWith(".md")) continue;
    let text: string;
    try {
      text = await readFile(`${opts.repoPath}/${path}`);
    } catch (error) {
      return {
        ok: false,
        error: `${path} could not be read: ${describe(error)}`,
      };
    }
    if (text.length > MAX_SCAN_BYTES || text.includes("\u0000")) continue;
    markers.push(...parseSimpleOnPurposeMarkers(path, text));
  }

  markers.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
  return {
    ok: true,
    value: {
      markers,
      missingUpgradeWhen: markers.filter((m) => m.upgradeWhen === null),
    },
  };
}

/** Makes text safe for one table cell: flatten, truncate, then escape. */
function cell(text: string): string {
  const flat = text.replaceAll("\r", " ").replaceAll("\n", " ");
  const chars = Array.from(flat);
  const shown = chars.length > CELL_LIMIT
    ? `${chars.slice(0, CELL_LIMIT - 1).join("")}…`
    : flat;
  return shown
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("`", "\\`");
}

/** Renders the ledger as a report-only Markdown document. */
export function renderSimpleOnPurposeReport(
  ledger: SimpleOnPurposeLedger,
  footer?: string,
): string {
  const total = ledger.markers.length;
  const flagged = ledger.missingUpgradeWhen.length;
  const lines: string[] = [
    "# SIMPLE-ON-PURPOSE ledger",
    "",
    "This is a report-only ledger of every `SIMPLE-ON-PURPOSE` marker in the tracked non-Markdown text files. It lists the known limits of deliberately simple code for review; it does not fail a gate or change any file.",
    "",
    `Markers: ${total}. Missing an \`upgrade when\` clause: ${flagged}.`,
  ];

  if (total === 0) {
    lines.push(
      "",
      "No `SIMPLE-ON-PURPOSE` markers were found in the scanned files.",
    );
  } else {
    if (flagged > 0) {
      lines.push("", "## Markers missing an `upgrade when` clause", "");
      for (const m of ledger.missingUpgradeWhen) {
        lines.push(
          `- ${cell(`${m.path}:${m.line}`)}: ${
            cell(m.ceiling || "(no ceiling text)")
          }`,
        );
      }
    }
    lines.push(
      "",
      "## All markers",
      "",
      "| Location | Ceiling | Upgrade when |",
      "| --- | --- | --- |",
    );
    for (const m of ledger.markers) {
      const when = m.upgradeWhen === null ? "(missing)" : cell(m.upgradeWhen);
      lines.push(
        `| ${cell(`${m.path}:${m.line}`)} | ${
          cell(m.ceiling || "(none)")
        } | ${when} |`,
      );
    }
  }

  if (footer !== undefined && footer !== "") lines.push("", footer);
  return `${lines.join("\n")}\n`;
}
