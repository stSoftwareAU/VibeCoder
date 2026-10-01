/**
 * Shared `gh issue list` / `gh issue view` JSON parsing for the label-release
 * sweeps, plus the shared failure-record heading pattern both sweeps judge a
 * comment against.
 *
 * `lib/milestone_branch_refusal_release.ts` (Issue #2220) and
 * `lib/host_fault_release.ts` (Issue #2890) both list labelled issues and
 * then read each issue's comments the same way, so the parsing lives here
 * once rather than twice.
 */

/**
 * Every heading a fleet path writes when it applies a failure-flavoured
 * label. Any of them makes a comment a failure record, so a label another
 * path applied is never mistaken for — or shadowed by — a different sweep's
 * record: `label_failure.ts` (Automated Processing Failed / Paused), the
 * milestone-branch refusal (Milestone branch unavailable), `claim_issue.ts`
 * (Claim Churn Detected), `label_question_failure.ts` (Question Answering
 * Failed) and `label_planning_escalation.ts` (Automatic Escalation to
 * Planning Mode). Single source of truth for both sweeps (Issues #2890,
 * #2943).
 */
export const FAILURE_RECORD_HEADING_PATTERN = String
  .raw`^##\s+(?:Automated Processing (?:Failed|Paused)|Milestone branch unavailable|Claim Churn Detected|Question Answering Failed|Automatic Escalation to Planning Mode)`;

/** One labelled issue as read from `gh issue list`. */
export interface LabelledIssue {
  number: number;
  labels: Set<string>;
}

/** Parse `gh issue list --json number,labels` output, or throw. */
export function parseLabelledIssues(raw: string): LabelledIssue[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("expected an array of issues");
  }
  const out: LabelledIssue[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { number?: unknown; labels?: unknown };
    if (typeof record.number !== "number") continue;
    const labels = new Set<string>();
    if (Array.isArray(record.labels)) {
      for (const label of record.labels) {
        const name = (label as { name?: unknown })?.name;
        if (typeof name === "string") labels.add(name);
      }
    }
    out.push({ number: record.number, labels });
  }
  return out;
}

/** One comment as read from `gh issue view --json comments`. */
export interface CommentRow {
  /** Login of whoever wrote it — the only authenticated part of a comment. */
  author?: string | null;
  body: string;
}

/**
 * Parse `gh issue view --json comments` output, oldest first, or throw.
 *
 * `author` is rendered as `{ login }` by `gh` and as a bare login by the
 * worker's own `GitHubComment`, so both shapes are accepted — the same
 * normalisation `idle_task_freshness.ts` does at its own comment read.
 */
export function parseCommentRows(raw: string): CommentRow[] {
  const parsed = JSON.parse(raw) as { comments?: unknown };
  if (!Array.isArray(parsed?.comments)) {
    throw new Error("expected a 'comments' array");
  }
  const rows: CommentRow[] = [];
  for (const entry of parsed.comments) {
    const record = entry as { body?: unknown; author?: unknown };
    if (typeof record?.body !== "string") continue;
    const author = record.author;
    const login = typeof author === "string"
      ? author
      : typeof (author as { login?: unknown })?.login === "string"
      ? (author as { login: string }).login
      : null;
    rows.push({ author: login, body: record.body });
  }
  return rows;
}
