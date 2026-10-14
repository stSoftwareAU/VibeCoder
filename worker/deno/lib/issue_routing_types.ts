export type IssueKind = "implementation" | "diagnostic" | "cross-repo";

export interface IssueRoutingPart {
  repo: string;
  title: string;
  body: string;
  dependsOnRepos?: readonly string[];
}

export interface IssueRoutingDraft {
  title: string;
  body: string;
  labels: readonly string[];
  parts?: readonly IssueRoutingPart[];
}

export interface IssueRoutingContext {
  /** The worker's own repository, e.g. `stSoftwareAU/VibeCoder`. */
  vibeCoderRepo: string;
  /**
   * Full `owner/repo` names the worker may file in. A write to a repository
   * other than the target needs it listed here.
   */
  allowedRepos: readonly string[];
  dryRun: boolean;
  recentlyClosedDays: number;
  /** Injected clock (epoch milliseconds). */
  nowMs: number;
}

export interface RoutingDecision {
  owner_repository: string;
  subject_repository: string;
  issue_kind: IssueKind;
  reason: string;
  wrong_repo: boolean;
  ambiguous: boolean;
}

export type RoutingAction =
  | "created"
  | "reused"
  | "dry-run"
  | "filed-ambiguous"
  | "split";

export interface RoutedIssueRef {
  repo: string;
  number: number | null;
  url: string | null;
  state: "open" | "closed" | "dry-run";
}

export interface IssueRoutingAudit extends RoutingDecision {
  action: RoutingAction;
  issues: RoutedIssueRef[];
  labels_not_migrated: string[];
}

/** Raised when a write is not permitted. Never swallowed. */
export class IssueRoutingPermissionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IssueRoutingPermissionError";
  }
}

export type Gh = (args: string[]) => Promise<string>;
