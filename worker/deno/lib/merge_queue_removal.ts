/**
 * Merge-queue removal reader (Issue #4424).
 *
 * When a GitHub merge queue removes a PR (a failed group check, or a merge
 * conflict), the worker must treat that removal as a red CI result on that
 * PR. This module reads the most recent `RemovedFromMergeQueueEvent` on a
 * PR's timeline and decides whether it still applies to the PR's current
 * head. A later step wires the result into the CI-failure scan.
 *
 * A removal belongs to the head it was recorded against. When GitHub names
 * the commit (`beforeCommit`), the removal applies only to that commit. When
 * it does not, the removal applies only if it was recorded at or after the
 * head commit's committed date, and an unparseable date never proves it. A
 * fix pushed after the removal therefore stops the removal applying.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { isValidRepoSlug } from "./repo_rulesets.ts";

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

/** A merge-queue removal of a PR, as recorded by GitHub. */
export interface QueueRemoval {
  /**
   * GitHub-supplied reason. Collapsed to one line and capped at 200
   * characters, because it is later written into a PR comment. Set to
   * "no reason recorded" when GitHub gave none.
   */
  reason: string;
  /** ISO timestamp of the removal (`createdAt`). */
  removedAt: string;
  /**
   * Commit the queue had built when it removed the PR (`beforeCommit.oid`),
   * or null when GitHub recorded none.
   */
  beforeCommitOid: string | null;
}

/** The synthetic check name used for a merge-queue removal. */
export const MERGE_QUEUE_CHECK_NAME = "merge queue";

const REASON_MAX_CHARS = 200;
const NO_REASON = "no reason recorded";

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: 1) { nodes { commit { committedDate } } }
      timelineItems(last: 1, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes { __typename ... on RemovedFromMergeQueueEvent { reason createdAt beforeCommit { oid } } }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function malformed(field: string): Error {
  return new Error(
    `malformed merge queue response: missing or invalid ${field}`,
  );
}

/** Collapse a GitHub-supplied reason to one capped line. */
function normaliseReason(raw: unknown): string {
  if (raw === null || raw === undefined) return NO_REASON;
  if (typeof raw !== "string") throw malformed("reason");
  const oneLine = raw.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
  if (oneLine === "") return NO_REASON;
  const chars = Array.from(oneLine);
  if (chars.length <= REASON_MAX_CHARS) return oneLine;
  return `${chars.slice(0, REASON_MAX_CHARS - 3).join("").trimEnd()}...`;
}

/** The head commit's committed date, or null when the response has none. */
function headCommittedDate(commitNodes: unknown[]): string | null {
  const last: unknown = commitNodes[commitNodes.length - 1];
  const commit = isRecord(last) ? last.commit : undefined;
  const date = isRecord(commit) ? commit.committedDate : undefined;
  return typeof date === "string" && date !== "" ? date : null;
}

/**
 * Parse a `gh api graphql` response for a PR's merge-queue removal.
 *
 * `nodes: []` is the documented empty state and yields `removal: null`.
 * A missing key is not the empty state: it throws, naming the field.
 *
 * @throws Error naming the missing or invalid field when the response is
 *   malformed.
 */
export function parseQueueRemovalResponse(raw: string): {
  removal: QueueRemoval | null;
  headSha: string;
  headCommittedAt: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("malformed merge queue response: not JSON");
  }
  const data = isRecord(parsed) ? parsed.data : undefined;
  const repository = isRecord(data) ? data.repository : undefined;
  const pr = isRecord(repository) ? repository.pullRequest : undefined;
  if (!isRecord(pr)) throw malformed("data.repository.pullRequest");

  const headSha = pr.headRefOid;
  if (typeof headSha !== "string" || headSha === "") {
    throw malformed("headRefOid");
  }

  const commits = isRecord(pr.commits) ? pr.commits : undefined;
  const commitNodes = commits?.nodes;
  if (!Array.isArray(commitNodes)) throw malformed("commits.nodes");
  const headCommittedAt = headCommittedDate(commitNodes);

  const timeline = isRecord(pr.timelineItems) ? pr.timelineItems : undefined;
  const timelineNodes = timeline?.nodes;
  if (!Array.isArray(timelineNodes)) throw malformed("timelineItems.nodes");
  if (timelineNodes.length === 0) {
    return { removal: null, headSha, headCommittedAt };
  }

  // The query asks for `last: 1`, so the final node is the most recent removal.
  const node: unknown = timelineNodes[timelineNodes.length - 1];
  if (!isRecord(node)) throw malformed("timelineItems.nodes entry");

  const removedAt = node.createdAt;
  if (typeof removedAt !== "string" || removedAt === "") {
    throw malformed("createdAt");
  }

  let beforeCommitOid: string | null = null;
  const beforeCommit = node.beforeCommit;
  if (beforeCommit !== null && beforeCommit !== undefined) {
    const oid = isRecord(beforeCommit) ? beforeCommit.oid : undefined;
    if (typeof oid !== "string" || oid === "") {
      throw malformed("beforeCommit.oid");
    }
    beforeCommitOid = oid;
  }

  return {
    removal: {
      reason: normaliseReason(node.reason),
      removedAt,
      beforeCommitOid,
    },
    headSha,
    headCommittedAt,
  };
}

// ---------------------------------------------------------------------------
// Applicability
// ---------------------------------------------------------------------------

/**
 * Whether a removal applies to the PR's current head.
 *
 * - With a `beforeCommitOid`, it applies only when that oid is the head
 *   (case-insensitive).
 * - Without one, it applies only when `removedAt` is at or after the head
 *   commit's committed date. An unparseable date on either side does not
 *   apply, so the removal fails toward "not proven".
 */
export function queueRemovalAppliesToHead(
  removal: QueueRemoval,
  headSha: string,
  headCommittedAt: string | null,
): boolean {
  if (removal.beforeCommitOid !== null) {
    return removal.beforeCommitOid.toLowerCase() === headSha.toLowerCase();
  }
  const removedMs = Date.parse(removal.removedAt);
  const headMs = headCommittedAt === null
    ? Number.NaN
    : Date.parse(headCommittedAt);
  if (Number.isNaN(removedMs) || Number.isNaN(headMs)) return false;
  return removedMs >= headMs;
}

// ---------------------------------------------------------------------------
// Public reader
// ---------------------------------------------------------------------------

/**
 * Read a PR's most recent merge-queue removal and return it only when it
 * applies to the PR's current head.
 *
 * The repo and PR number are validated before any `gh` call. Validation
 * failures, `gh` failures and malformed responses all return `ok: false`,
 * and never throw.
 */
export async function readQueueRemoval(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<
  { ok: true; value: QueueRemoval | null } | { ok: false; error: Error }
> {
  if (!isValidRepoSlug(repo)) {
    return { ok: false, error: new Error(`invalid repo slug '${repo}'`) };
  }
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return { ok: false, error: new Error(`invalid PR number ${prNumber}`) };
  }
  const [owner, name] = repo.split("/") as [string, string];

  let parsed: ReturnType<typeof parseQueueRemovalResponse>;
  try {
    const raw = await ghCommandFn([
      "api",
      "graphql",
      "-f",
      `query=${QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${prNumber}`,
    ]);
    parsed = parseQueueRemovalResponse(raw);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  const { removal, headSha, headCommittedAt } = parsed;
  const applies = removal !== null &&
    queueRemovalAppliesToHead(removal, headSha, headCommittedAt);
  return { ok: true, value: applies ? removal : null };
}

/** One human line describing a removal, for annotations and comments. */
export function describeQueueRemoval(removal: QueueRemoval): string {
  return `Removed from the merge queue (${removal.reason}) at ${removal.removedAt}; treated as a failed CI check for this head.`;
}
