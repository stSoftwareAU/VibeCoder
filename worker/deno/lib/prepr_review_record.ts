/**
 * Change-request record for a pre-PR review that survived the in-run
 * recovery (Issue #4236).
 *
 * The worker cannot formally request changes on its own pull request, so
 * this marker is that review. The latest marker wins: a later `resolved`
 * comment clears the hold, and an unresolved record blocks auto-merge the
 * same way a `CHANGES_REQUESTED` review does.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { isFleetAuthor } from "./fleet_authors.ts";

/** Marker states the record can carry. */
export type PreprReviewMarkerState = "changes_requested" | "resolved";

/** One file:line finding posted on the record. */
export interface PreprReviewFinding {
  file: string;
  line: number;
  problem: string;
}

const MARKER_RE =
  /<!-- vibe-prepr-review state="(changes_requested|resolved)" -->/g;

/** The HTML comment that opens a request or a resolution. */
export function preprReviewMarker(state: PreprReviewMarkerState): string {
  return `<!-- vibe-prepr-review state="${state}" -->`;
}

/**
 * The pull-request comment that asks for the findings to be answered.
 * The first line is the machine-readable marker; the sentence under it is
 * the same note the summary head carries.
 */
export function renderPreprReviewRequest(
  findings: readonly PreprReviewFinding[],
): string {
  const lines = findings.map((finding) =>
    `- \`${finding.file}:${finding.line}\` ${finding.problem}`
  );
  return [
    preprReviewMarker("changes_requested"),
    "",
    `pre-PR review requested changes: ${findings.length} findings`,
    "",
    ...lines,
  ].join("\n");
}

/** The comment that clears the hold once every finding has been answered. */
export function renderPreprReviewResolved(): string {
  return [
    preprReviewMarker("resolved"),
    "",
    "pre-PR review findings answered on this head.",
  ].join("\n");
}

/** The one-line note prepended to the pull-request summary head. */
export function renderPreprReviewHeadNote(count: number): string {
  return `pre-PR review requested changes: ${count} findings`;
}

/**
 * The latest marker across the comments, in comment order and then within
 * each body. No marker is `absent`.
 */
export function latestPreprReviewState(
  bodies: readonly string[],
): PreprReviewMarkerState | "absent" {
  let latest: PreprReviewMarkerState | "absent" = "absent";
  for (const body of bodies) {
    MARKER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MARKER_RE.exec(body)) !== null) {
      latest = match[1] as PreprReviewMarkerState;
    }
  }
  return latest;
}

/** True when the latest record still requests changes. */
export function preprReviewBlocksArm(bodies: readonly string[]): boolean {
  return latestPreprReviewState(bodies) === "changes_requested";
}

/** True when this one comment is an unresolved request, ignoring later ones. */
export function commentCarriesOpenPreprReview(body: string): boolean {
  return latestPreprReviewState([body]) === "changes_requested";
}

/**
 * Findings the claim check and the verifier contribute to one record.
 *
 * Claim findings have no line number of their own; they are cited at line 1
 * of the file the check named. Test-plan problems are cited on the test
 * file the check resolved.
 */
export function collectPreprReviewFindings(input: {
  claimFindings?: readonly { file: string; reason: string }[];
  docFindings?: readonly { file: string; reason: string }[];
  testPlanProblems?: readonly { testFile: string; quote: string }[];
  verifierFindings?: readonly {
    file: string;
    line: number;
    problem: string;
  }[];
}): PreprReviewFinding[] {
  const findings: PreprReviewFinding[] = [];
  for (const finding of input.claimFindings ?? []) {
    findings.push({ file: finding.file, line: 1, problem: finding.reason });
  }
  for (const finding of input.docFindings ?? []) {
    findings.push({ file: finding.file, line: 1, problem: finding.reason });
  }
  for (const problem of input.testPlanProblems ?? []) {
    findings.push({
      file: problem.testFile,
      line: 1,
      problem: problem.quote,
    });
  }
  for (const finding of input.verifierFindings ?? []) {
    findings.push({
      file: finding.file,
      line: finding.line,
      problem: finding.problem,
    });
  }
  return findings;
}

/** One issue comment, with the login GitHub authenticated. */
export interface IssueCommentRecord {
  author: string;
  body: string;
}

/**
 * Bodies whose author is this host or another fleet login.
 *
 * A marker from anyone else does not count: they can neither lift a hold
 * the worker placed nor place one of their own (Issue #4236).
 */
export function fleetMarkerBodies(
  comments: readonly IssueCommentRecord[],
  fleetAuthors: readonly string[],
): string[] {
  const fleet = [...fleetAuthors];
  return comments
    .filter((comment) => isFleetAuthor(comment.author, fleet))
    .map((comment) => comment.body);
}

/**
 * Read every issue comment on the pull request, with its author.
 *
 * `--paginate` is required. GitHub returns thirty comments per page, and
 * the resolved marker on a busy pull request sits past the first page.
 * A failed or unreadable read is an error. Callers must not arm when they
 * cannot tell whether a record is still open.
 */
export async function fetchIssueCommentBodies(
  repo: string,
  prNumber: number,
  gh: (args: string[]) => Promise<string>,
): Promise<Result<readonly IssueCommentRecord[]>> {
  try {
    const output = await gh([
      "api",
      "--paginate",
      `repos/${repo}/issues/${prNumber}/comments`,
      "--jq",
      "[.[] | {author: .user.login, body: .body}]",
    ]);
    return parseIssueCommentPages(output, prNumber);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * One JSON array per page. `gh api --paginate --jq` prints each page on
 * its own line; a single page is one JSON value and may contain newlines.
 */
function parseIssueCommentPages(
  output: string,
  prNumber: number,
): Result<IssueCommentRecord[]> {
  const trimmed = output.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error: new Error(`PR #${prNumber} comments came back empty`),
    };
  }
  let pages: unknown[];
  try {
    pages = [JSON.parse(trimmed)];
  } catch {
    pages = [];
    for (const line of trimmed.split("\n")) {
      const piece = line.trim();
      if (piece === "") continue;
      try {
        pages.push(JSON.parse(piece));
      } catch {
        return {
          ok: false,
          error: new Error(`PR #${prNumber} comments page was not JSON`),
        };
      }
    }
    if (pages.length === 0) {
      return {
        ok: false,
        error: new Error(`PR #${prNumber} comments came back empty`),
      };
    }
  }
  const comments: IssueCommentRecord[] = [];
  for (const page of pages) {
    if (!Array.isArray(page)) {
      return {
        ok: false,
        error: new Error(`PR #${prNumber} comments page was not a list`),
      };
    }
    for (const item of page) {
      if (typeof item !== "object" || item === null) {
        return {
          ok: false,
          error: new Error(
            `PR #${prNumber} comment was missing an author or body`,
          ),
        };
      }
      const record = item as { author?: unknown; body?: unknown };
      if (typeof record.body !== "string") {
        return {
          ok: false,
          error: new Error(
            `PR #${prNumber} comment was missing an author or body`,
          ),
        };
      }
      // A missing login cannot be a fleet account, so it cannot count.
      if (typeof record.author !== "string" || record.author.trim() === "") {
        continue;
      }
      comments.push({ author: record.author, body: record.body });
    }
  }
  return { ok: true, value: comments };
}
