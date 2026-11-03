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

// Lives here (not test_change_policy.ts) so the shared parser and the policy can import it without a cycle.
export type TestChangeKind =
  | "expected-value"
  | "removed-case"
  | "added-skip"
  | "weakened-assertion"
  | "removed-file"
  | "other"
  | "replaced" // Issue #4655: a brittle or live-data test replaced by a hermetic one
  | "threshold-reduced"; // Issue #4655: a limit lowered so a check passes; never accepted

// One test that covers the behaviour a removed or edited test used to check (Issue #4655).
export interface TestCoverageRef {
  role: "replacement" | "existing" | "gone";
  path: string;
  name?: string; // a test or symbol name that must appear in the file (absent for a gone file)
}

export interface TestChangeNote {
  file: string;
  line: number;
  change: string;
  kind?: TestChangeKind; // what sort of edit it is; a skip, weakened assertion or lowered threshold is never accepted (Issue #4655)
  // `criterionQuote` is the pre-#4655 alias of `requirementQuote`, read when no requirementQuote is given.
  criterionQuote?: string; // verbatim acceptance criterion of a linked issue that requires the change
  failsWithoutChange?: boolean | string; // whether the edited test fails without the code change
  verdict?: "justified" | "unjustified" | "owner"; // the reviewer's judgement of the test change (Issue #4655)
  obsolete?: string; // what old behaviour the removed or edited test checked, and why that is no longer required
  remaining?: string; // what behaviour still holds after the change
  coverage?: TestCoverageRef[]; // where the behaviour is covered at the head
  requirementQuote?: string; // verbatim text of a linked issue that requires the change
  verification?: string; // the command or mutation run and its observed result
  ownerQuestion?: string; // the material product-contract question the owner must decide
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
  autoReleased?: true; // written only by records before policy version 2 (Issue #4655), so old logs still parse; set when an opt-in auto-release (Issue #3397) happened
  autoReleaseHeld?: string[]; // written only by records before policy version 2 (Issue #4655), so old logs still parse; reasons an opted-in repo's hold was kept (Issue #3397)
  holdPolicy?: number; // HOLD_POLICY_VERSION the hold was made under; set only on a held record, absent on one written before the field = version 1 (Issue #4643)
  testPolicy?: { version: number; mode: string; holdAllRepos: string[] }; // the test-change policy the record was made under (Issue #4655)
  testChangesReviewed?: true; // set when an approval rested on a reviewed test change (Issue #4655)
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
