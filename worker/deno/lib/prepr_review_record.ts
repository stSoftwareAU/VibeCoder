/**
 * Change-request record for a pre-PR review that survived the in-run
 * recovery (Issue #4236).
 *
 * The worker cannot formally request changes on its own pull request, so
 * this marker is that review. The latest marker wins: a later `resolved`
 * comment closes the record. An open record routes the next PR-feedback pass
 * to answer the findings. It never withholds or disarms auto-merge: PRs do
 * not merge until they have a review approval and CI is green, and GitHub
 * enforces both (Issue #4291).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

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

/** The comment that closes the record once every finding has been answered. */
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
export function preprReviewIsOpen(bodies: readonly string[]): boolean {
  return latestPreprReviewState(bodies) === "changes_requested";
}

/** True when this one comment is an unresolved request, ignoring later ones. */
export function commentCarriesOpenPreprReview(body: string): boolean {
  return latestPreprReviewState([body]) === "changes_requested";
}

/**
 * Findings a caller passes in. The summary claim check that used to supply
 * `claimFindings` was removed (Issue #4234).
 *
 * A claim-shaped finding has no line number of its own; it is cited at line 1
 * of the file the caller named. Test-plan problems are cited on the test
 * file the caller resolved.
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
