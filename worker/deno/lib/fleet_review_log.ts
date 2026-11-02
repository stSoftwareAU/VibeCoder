/** Shared review log contract and JSONL parser. */

export type Outcome = "approved" | "changes_requested" | "held";

export interface Finding {
  file: string;
  line: number;
  problem: string;
  fix?: string;
  // A gap for an earlier finding also carries that finding (#4446).
  earlier?: Finding;
}

// Lives here (not auto_release.ts) so auto_release.ts can import it without a cycle.
export type TestChangeKind =
  | "expected-value"
  | "removed-case"
  | "added-skip"
  | "weakened-assertion"
  | "removed-file"
  | "other";

export interface TestChangeNote {
  file: string;
  line: number;
  change: string;
  kind?: TestChangeKind; // what sort of edit it is; only "expected-value" can auto-release (Issue #3397)
  criterionQuote?: string; // verbatim acceptance criterion of a linked issue that requires the change
  failsWithoutChange?: boolean | string; // whether the edited test fails without the code change
}

export interface FiledIssue {
  number: number;
  url: string;
  title: string;
  /** The instance was added to this existing issue, not filed (Issue #3598). */
  addedTo?: true;
}

export interface LogRecord {
  at: string; // ISO time the review was posted
  repo: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  outcome: Outcome;
  summary: string;
  findings: Finding[];
  testChangeNotes: TestChangeNote[];
  removedTests: string[];
  filedIssues?: FiledIssue[];
  addedNeedsHuman?: boolean; // the skill's own needs-human label is on the PR after this review (Issue #2927)
  autoReleased?: true; // set only when an issue-required test-change hold was auto-released (Issue #3397)
  autoReleaseHeld?: string[]; // reasons an opted-in repo's hold was kept; set only on a held PR (Issue #3397)
  holdPolicy?: number; // HOLD_POLICY_VERSION the hold was made under; set only on a held record, absent on one written before the field = version 1 (Issue #4643)
}

export function parseLog(text: string): LogRecord[] {
  return text.split("\n").filter((l) => l.trim() !== "").flatMap((l) => {
    try {
      return [JSON.parse(l) as LogRecord];
    } catch {
      return []; // a torn last line from an interrupted write
    }
  });
}
