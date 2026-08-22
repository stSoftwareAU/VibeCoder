/**
 * Detection of a "blocked on a dependency" agent outcome (Issue #222).
 *
 * The no-changes handler knew two shapes: *already complete* (close the issue)
 * and *analysis-only* (`needs-human` + release). A run that is neither — the
 * agent read the code, found the work genuinely blocked on another issue, and
 * said so — had nowhere to land. VibeCoder#222 records the result on
 * NEAT-AI-Backpropagation#94: the agent closed its own issue as `not planned`
 * and the worker then described a "## Blocked: …" answer as
 * "analysis-only / recommendation-only".
 *
 * A blocked run is a **deferral**, not a hand-off: the issue keeps its
 * discovery label, records `Depends on owner/repo#N`, and the dependency gate
 * (`isDependencyBlocked`) skips it until that dependency closes.
 *
 * This module holds the pure detection: given the agent's output, is it
 * blocked-shaped, and on what? The GitHub side lives in `blocked_deferral.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { stripCodeSpans } from "./issue_dependencies.ts";

/** One issue the run reported itself blocked on. */
export interface BlockedDependency {
  /** `owner/repo` when the reference names one; absent for a bare `#N`. */
  repo?: string;
  /** The dependency's issue number. */
  number: number;
}

/** A blocked-shaped agent outcome. */
export interface BlockedOutcome {
  /** The dependency to defer on — the first one named. */
  dependency: BlockedDependency;
  /** Every dependency named, in the order they appear. */
  dependencies: BlockedDependency[];
  /** The agent's own words: the blocked section, trimmed and bounded. */
  reason: string;
}

/**
 * A line that opens a blocked section.
 *
 * Deliberately anchored to the start of a line so a passing mention ("this is
 * not blocked by anything") cannot trigger a deferral. Markdown heading
 * markers, list bullets and bold markers are skipped, so `## Blocked: …`,
 * `**Blocked**`, `- Depends on x/y#5` and a bare `Blocked by #5` all match.
 */
const BLOCKED_SECTION_RE =
  /^[ \t]*(?:[-*+]\s+)?(?:#{1,6}\s*)?(?:\*\*|__)?(?:blocked|depends\s+on)\b/i;

/** A markdown heading — where a blocked section ends. */
const HEADING_RE = /^[ \t]*#{1,6}\s/;

/** `owner/repo#N` or `#N`, anywhere in a line. */
const ISSUE_REF_RE =
  /(?:^|[\s(<[])(?:([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+))?#(\d+)\b/g;

/** Longest reason quoted back into the deferral comment. */
const MAX_REASON_LENGTH = 1000;

/** How many lines after the opening line are read as part of the section. */
const MAX_SECTION_LINES = 20;

/** Case-insensitive `owner/repo` comparison. */
function sameRepo(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Issue references named in `text`, in order, de-duplicated. */
function referencesIn(text: string): BlockedDependency[] {
  const found: BlockedDependency[] = [];
  const seen = new Set<string>();
  ISSUE_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ISSUE_REF_RE.exec(text)) !== null) {
    const number = parseInt(match[2]!, 10);
    if (Number.isNaN(number)) continue;
    const repo = match[1];
    const key = `${(repo ?? "").toLowerCase()}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ ...(repo ? { repo } : {}), number });
  }
  return found;
}

/**
 * The blocked section of an agent's output: the opening line plus the lines
 * that follow it, up to the next heading or {@link MAX_SECTION_LINES}.
 */
function blockedSection(lines: readonly string[], start: number): string {
  const section: string[] = [lines[start] ?? ""];
  for (
    let i = start + 1;
    i < lines.length && section.length <= MAX_SECTION_LINES;
    i++
  ) {
    const line = lines[i]!;
    if (HEADING_RE.test(line)) break;
    section.push(line);
  }
  return section.join("\n").trim();
}

/**
 * Mark every line that is a fence or sits inside a fenced block.
 *
 * The section scan runs over the *original* lines so the reason can be quoted
 * verbatim (code spans and all), which means it must skip fenced content
 * itself — an example block containing `## Blocked:` is documentation. Mirrors
 * the fence rule in `stripCodeSpans`, including its fail-safe treatment of an
 * unclosed fence (everything after it is inside the block).
 */
function fencedLines(lines: readonly string[]): boolean[] {
  const fenced: boolean[] = [];
  let fenceChar: string | null = null;
  for (const line of lines) {
    const fence = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (fenceChar === null) {
      if (fence) {
        fenceChar = fence[1]![0]!;
        fenced.push(true);
        continue;
      }
      fenced.push(false);
      continue;
    }
    fenced.push(true);
    if (fence && fence[1]![0] === fenceChar) fenceChar = null;
  }
  return fenced;
}

/** Trim a reason to {@link MAX_REASON_LENGTH}, marking the cut. */
function boundReason(reason: string): string {
  return reason.length <= MAX_REASON_LENGTH
    ? reason
    : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

/**
 * Detect a blocked-on-a-dependency outcome in an agent's output.
 *
 * Requires **both** signals, so a passing mention of the word "blocked" never
 * defers an issue by itself:
 *   1. a line that opens a `Blocked` / `Depends on` section, and
 *   2. an issue reference (`owner/repo#N` or `#N`) naming something other than
 *      the issue being worked.
 *
 * Code spans and fenced blocks are stripped first (matching
 * `extractDependencyReferences`), so a `Depends on #5` quoted inside an
 * example is documentation, not a dependency.
 *
 * @param output - The agent's stdout for the run.
 * @param self - The issue being worked, so it is never its own dependency.
 * @returns The blocked outcome, or `undefined` when the output is not
 *   blocked-shaped.
 */
export function detectBlockedOutcome(
  output: string,
  self: { repo: string; issueNumber: number },
): BlockedOutcome | undefined {
  if (!output.trim()) return undefined;

  const lines = output.split("\n");
  const fenced = fencedLines(lines);
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    if (!BLOCKED_SECTION_RE.test(lines[i]!)) continue;
    const section = blockedSection(lines, i);
    // The section is quoted back verbatim, but references are read from the
    // code-stripped text: a `Depends on #5` inside a fenced example is
    // documentation, not a dependency (matching `extractDependencyReferences`).
    const dependencies = referencesIn(stripCodeSpans(section)).filter((dep) =>
      !(dep.number === self.issueNumber &&
        (dep.repo === undefined || sameRepo(dep.repo, self.repo)))
    );
    const first = dependencies[0];
    if (!first) continue;
    return {
      dependency: first,
      dependencies,
      reason: boundReason(section),
    };
  }
  return undefined;
}

/** Render a dependency as `owner/repo#N`, or `#N` for a same-repo reference. */
export function formatDependencyRef(dep: BlockedDependency): string {
  return `${dep.repo ?? ""}#${dep.number}`;
}

/**
 * The body line the dependency gate reads — `Depends on owner/repo#N`.
 *
 * `extractDependencyReferences` / `isDependencyBlocked` parse exactly this
 * form, so a deferred issue is skipped by the next claim until the dependency
 * closes.
 */
export function buildDependencyLine(dep: BlockedDependency): string {
  return `Depends on ${formatDependencyRef(dep)}`;
}
