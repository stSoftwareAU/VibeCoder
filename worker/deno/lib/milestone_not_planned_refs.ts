/**
 * Milestone not-planned doc references (Issue #3223).
 *
 * Milestone sub-PRs merge into the milestone branch on green CI with no
 * review (that review happens once, on the summary PR into the default
 * branch). A sibling sub-issue can be closed as **not planned** after other
 * sub-issues already documented its intended work — a Markdown line added on
 * the milestone branch can still describe that dropped work as present, and
 * nothing on the merge path previously said so.
 *
 * This module scans the milestone's issues (and their declared forward
 * dependencies) for ones closed as not planned, then scans the
 * default…milestone compare diff for added Markdown lines that name one of
 * those issues, so the summary-PR reviewer can see every forward reference to
 * dropped work. It never blocks PR creation — a lookup or diff failure only
 * swaps in a "could not check" note.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";
import { isValidRepoSlug } from "./repo_slug.ts";
import { isValidBranchName } from "./repo_rulesets.ts";
import { parseJsonArrayPages } from "./json_array_pages.ts";
import { extractDependencyReferences } from "./issue_dependencies.ts";
import { scrubUntrustedText } from "./prompt_delimiter.ts";

/** Injectable `gh` runner (same shape as the other milestone helpers). */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** A Markdown line, added on the milestone branch, that names a not-planned issue. */
export interface NotPlannedDocReference {
  /** The issue number closed as not planned. */
  issueNumber: number;
  /** The issue's title. */
  title: string;
  /** The Markdown file the line was added to. */
  file: string;
  /** New-file line numbers the issue is named on, ascending. */
  lines: number[];
}

/** Result of scanning the milestone branch for not-planned doc references. */
export interface NotPlannedDocScan {
  /** Every (issue, file) hit found, sorted by issue number then file. */
  references: NotPlannedDocReference[];
  /**
   * Human-readable notes about Markdown the scan could not check — a file
   * the compare API returned without diff text, or the 300-file cap.
   */
  unchecked: string[];
}

/** Options for {@link findNotPlannedDocReferences}. */
export interface NotPlannedDocOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The milestone being summarised. */
  milestoneNumber: number;
  /** The repository's default branch. */
  defaultBranch: string;
  /** The milestone branch being compared against the default branch. */
  milestoneBranch: string;
  ghCommandFn: GhCommandFn;
}

interface RawMember {
  number: number;
  title: string;
  body?: string;
  state?: unknown;
  state_reason?: unknown;
  pull_request?: unknown;
}

/** A candidate issue closed as not planned. */
interface NotPlannedCandidate {
  number: number;
  title: string;
}

/** Parse a `gh api --paginate` issues-list response, skipping PRs and junk. */
function parseMemberIssues(raw: string): RawMember[] {
  const out: RawMember[] = [];
  for (const item of parseJsonArrayPages(raw)) {
    if (!item || typeof item !== "object") continue;
    const record = item as RawMember;
    if (!Number.isInteger(record.number)) continue;
    if ((record as { pull_request?: unknown }).pull_request !== undefined) {
      continue;
    }
    out.push({
      number: record.number,
      title: typeof record.title === "string" ? record.title : "",
      body: typeof record.body === "string" ? record.body : "",
      state: record.state,
      state_reason: record.state_reason,
    });
  }
  return out;
}

function isClosedNotPlanned(
  state: unknown,
  stateReason: unknown,
): boolean {
  return state === "closed" && stateReason === "not_planned";
}

interface RawLookupIssue {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  state_reason?: unknown;
}

/**
 * Lines a unified-diff `patch` added, in new-file line order.
 *
 * @param patch - The hunk text from a GitHub compare API file entry.
 * @returns Each added line's new-file line number and text (without the
 *   leading `+`).
 */
export function addedLines(
  patch: string,
): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let newLine: number | null = null;
  const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  for (const rawLine of patch.split("\n")) {
    const header = hunkHeader.exec(rawLine);
    if (header) {
      newLine = Number.parseInt(header[1]!, 10);
      continue;
    }
    if (newLine === null) continue;

    if (rawLine.startsWith("+")) {
      out.push({ line: newLine, text: rawLine.slice(1) });
      newLine++;
    } else if (rawLine.startsWith(" ")) {
      newLine++;
    }
    // "-" and "\" lines do not advance the new-file counter.
  }

  return out;
}

/**
 * Issue numbers a line of text names as `#N` or `owner/repo#N` for this repo
 * (Issue #3223).
 *
 * Rejects a hex colour (`#2303ff` — a word character directly after the
 * digits) and an HTML entity (`&#8212;` — an `&` directly before the `#`).
 * Otherwise walks backwards from before the `#` over characters valid in a
 * repo slug, at most 141 of them, to decide whether the reference is bare
 * (same-repo), this repo spelt out, or another repo/garbage (rejected).
 *
 * @param text - The line of text to scan.
 * @param repo - This repository, in `owner/repo` form, for the spelt-out form.
 * @returns Referenced issue numbers, de-duplicated, in first-seen order.
 */
export function findIssueReferences(text: string, repo: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const pattern = /#(\d+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const digits = match[1]!;
    const afterIndex = match.index + match[0].length;
    const after = text[afterIndex];
    if (after !== undefined && /[A-Za-z0-9_]/.test(after)) continue; // #2303ff

    const hashIndex = match.index;
    const before = text[hashIndex - 1];
    if (before === "&") continue; // &#8212;

    // Walk backwards over a repo-slug alphabet, bounded, no backtracking regex.
    let start = hashIndex;
    let steps = 0;
    while (
      start > 0 &&
      steps < 141 &&
      /[A-Za-z0-9._/-]/.test(text[start - 1]!)
    ) {
      start--;
      steps++;
    }
    const token = text.slice(start, hashIndex);

    let accept: boolean;
    if (token === "") {
      accept = true; // bare "#N" — same-repo
    } else if (token.includes("/")) {
      accept = token.toLowerCase() === repo.toLowerCase();
    } else {
      accept = false; // "foo#5" — not a repo reference
    }

    if (!accept) continue;
    const num = Number.parseInt(digits, 10);
    if (!Number.isInteger(num)) continue;
    if (seen.has(num)) continue;
    seen.add(num);
    out.push(num);
  }

  return out;
}

interface RawCompareFile {
  filename?: unknown;
  status?: unknown;
  patch?: unknown;
}

const MARKDOWN_FILE_PATTERN = /\.(md|markdown|mdx)$/i;
const MAX_COMPARE_FILES = 300;

/**
 * Find every Markdown line added on the milestone branch that names an issue
 * closed as not planned (Issue #3223).
 *
 * Never blocks the caller from raising the summary PR — a failure is
 * returned as `{ok:false}` so the caller can fall back to an "unverified"
 * note rather than silently reporting a clean scan.
 */
export async function findNotPlannedDocReferences(
  options: NotPlannedDocOptions,
): Promise<Result<NotPlannedDocScan>> {
  const { repo, milestoneNumber, defaultBranch, milestoneBranch, ghCommandFn } =
    options;

  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: new Error(`Invalid repo: ${repo}`) };
  }
  if (!Number.isInteger(milestoneNumber) || milestoneNumber <= 0) {
    return {
      ok: false,
      error: new Error(`Invalid milestone number: ${milestoneNumber}`),
    };
  }
  if (!isValidBranchName(defaultBranch)) {
    return {
      ok: false,
      error: new Error(`Invalid default branch name: ${defaultBranch}`),
    };
  }
  if (!isValidBranchName(milestoneBranch)) {
    return {
      ok: false,
      error: new Error(`Invalid milestone branch name: ${milestoneBranch}`),
    };
  }

  let members: RawMember[];
  try {
    const raw = await ghCommandFn([
      "api",
      "--paginate",
      `repos/${repo}/issues?milestone=${milestoneNumber}&state=all&per_page=100`,
    ]);
    members = parseMemberIssues(raw);
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Failed to read the issues of milestone #${milestoneNumber} in ` +
          `${repo}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }

  const memberNumbers = new Set(members.map((m) => m.number));
  const candidates = new Map<number, NotPlannedCandidate>();

  for (const member of members) {
    if (isClosedNotPlanned(member.state, member.state_reason)) {
      candidates.set(member.number, {
        number: member.number,
        title: member.title,
      });
    }
  }

  const lookupCache = new Map<number, NotPlannedCandidate | null>();
  const sortedMembers = [...members].sort((a, b) => a.number - b.number);
  for (const member of sortedMembers) {
    const deps = extractDependencyReferences(member.body ?? "");
    for (const dep of deps) {
      if (dep === member.number) continue;
      if (memberNumbers.has(dep)) continue;
      if (candidates.has(dep)) continue;

      let looked = lookupCache.get(dep);
      if (looked === undefined) {
        try {
          const raw = await ghCommandFn([
            "api",
            `repos/${repo}/issues/${dep}`,
          ]);
          const parsed = JSON.parse(raw) as RawLookupIssue;
          if (isClosedNotPlanned(parsed.state, parsed.state_reason)) {
            looked = {
              number: dep,
              title: typeof parsed.title === "string" ? parsed.title : "",
            };
          } else {
            looked = null;
          }
        } catch (err) {
          return {
            ok: false,
            error: new Error(
              `Failed to read declared dependency #${dep} of milestone ` +
                `#${milestoneNumber} in ${repo}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
            ),
          };
        }
        lookupCache.set(dep, looked);
      }

      if (looked) {
        candidates.set(dep, looked);
      }
    }
  }

  if (candidates.size === 0) {
    return { ok: true, value: { references: [], unchecked: [] } };
  }

  let files: RawCompareFile[];
  try {
    const raw = await ghCommandFn([
      "api",
      `repos/${repo}/compare/${defaultBranch}...${milestoneBranch}`,
    ]);
    const parsed = JSON.parse(raw) as { files?: unknown };
    if (!Array.isArray(parsed.files)) {
      return {
        ok: false,
        error: new Error(
          `compare/${defaultBranch}...${milestoneBranch} in ${repo} ` +
            "returned no usable 'files' array",
        ),
      };
    }
    files = parsed.files as RawCompareFile[];
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Failed to read the ${defaultBranch}...${milestoneBranch} compare ` +
          `diff in ${repo}: ${
            err instanceof Error ? err.message : String(err)
          }`,
      ),
    };
  }

  const unchecked: string[] = [];
  if (files.length >= MAX_COMPARE_FILES) {
    unchecked.push("files beyond the first 300 the compare API returns");
  }

  // (issueNumber, file) -> sorted line numbers.
  const hits = new Map<
    string,
    { candidate: NotPlannedCandidate; file: string; lines: Set<number> }
  >();

  for (const file of files) {
    const filename = typeof file.filename === "string" ? file.filename : "";
    if (!filename || !MARKDOWN_FILE_PATTERN.test(filename)) continue;
    if (file.status === "removed") continue;

    if (typeof file.patch !== "string") {
      unchecked.push(filename);
      continue;
    }

    for (const added of addedLines(file.patch)) {
      const refs = findIssueReferences(added.text, repo);
      for (const ref of refs) {
        const candidate = candidates.get(ref);
        if (!candidate) continue;
        const key = `${candidate.number}\u0000${filename}`;
        let entry = hits.get(key);
        if (!entry) {
          entry = { candidate, file: filename, lines: new Set<number>() };
          hits.set(key, entry);
        }
        entry.lines.add(added.line);
      }
    }
  }

  const references: NotPlannedDocReference[] = [...hits.values()].map(
    (entry) => ({
      issueNumber: entry.candidate.number,
      title: entry.candidate.title,
      file: entry.file,
      lines: [...entry.lines].sort((a, b) => a - b),
    }),
  );
  references.sort((a, b) =>
    a.issueNumber - b.issueNumber || a.file.localeCompare(b.file)
  );

  return { ok: true, value: { references, unchecked } };
}

/**
 * Markdown section for the summary-PR body. Returns "" when the scan found
 * nothing to report.
 */
export function renderNotPlannedDocSection(scan: NotPlannedDocScan): string {
  if (scan.references.length === 0 && scan.unchecked.length === 0) return "";

  const heading = scan.references.length > 0
    ? "### ⚠️ Docs cite issues closed as not planned"
    : "### ⚠️ Docs not checked for issues closed as not planned";

  const lines: string[] = [heading, ""];

  if (scan.references.length > 0) {
    lines.push(
      "The Markdown lines below were added on this milestone branch and " +
        "name an issue that was closed as **not planned**, so the work " +
        "they describe may never land; before merging, reword each to " +
        "describe what ships today, or confirm the cited code is on this " +
        "branch.",
      "",
    );
    for (const ref of scan.references) {
      const title = scrubUntrustedText(ref.title);
      const file = scrubUntrustedText(ref.file);
      lines.push(
        `- #${ref.issueNumber} ${title} — \`${file}\` line(s) ${
          ref.lines.join(", ")
        }`,
      );
    }
  }

  if (scan.unchecked.length > 0) {
    if (scan.references.length > 0) lines.push("");
    const scrubbedUnchecked = scan.unchecked.map((entry) =>
      scrubUntrustedText(entry)
    );
    lines.push(
      "Not checked (no diff text from the compare API, or past its " +
        "300-file cap): " + scrubbedUnchecked.join(", "),
    );
  }

  return lines.join("\n");
}

/**
 * The note used when the scan itself could not be run (Issue #3223). Never
 * blocks PR creation — it only tells the reviewer to check by hand.
 */
export const NOT_PLANNED_DOCS_UNVERIFIED_NOTE =
  "### ⚠️ Docs not checked for issues closed as not planned\n\n" +
  "The worker could not read this milestone's issues or diff when raising " +
  "this PR, so check by hand that no doc describes a dropped issue's work " +
  "as present.";
