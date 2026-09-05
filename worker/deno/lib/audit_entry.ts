/**
 * Audit journal entry shape and chain hashing (Issue #2380).
 *
 * Extracted from `audit_journal.ts` (Issue #1074) so the crash-recovery
 * module can re-derive an entry's hash without importing the writer that
 * depends on it. An import cycle inside the module that carries the
 * worker's own tamper evidence is not a thing to introduce for the sake of
 * one function. `audit_journal.ts` re-exports every name here, so no
 * caller changes.
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */

/** Outcome of the underlying network call. */
export type AuditOutcome = "success" | "error";

/** A GitHub mutation to record (caller-supplied fields). */
export interface AuditMutation {
  /** ISO 8601 timestamp. Filled in by `recordMutation` when absent. */
  timestamp?: string;
  /** Run-correlation id (joins to #2381). */
  runId: string;
  /** owner/repo target, when known. */
  repo?: string;
  /** Target ref / issue / PR / endpoint identifier, when known. */
  target?: string;
  /** Action verb, e.g. "issue-comment", "pr-merge", "git-push". */
  verb: string;
  /** Outcome of the underlying network call. */
  outcome: AuditOutcome;
  /** `gh`/`git` exit code where available. */
  exitCode?: number;
  /** Caller code path, e.g. "worker/deno/lib/pr_comments.ts". */
  caller?: string;
}

/** A persisted journal entry (mutation fields plus chain fields). */
export interface AuditEntry extends AuditMutation {
  timestamp: string;
  /** Hash of the previous entry in the chain ("" for the first entry). */
  prevHash: string;
  /** SHA-256 hex digest over prevHash + canonical payload. */
  hash: string;
}

/** Field order used for the canonical payload (chain fields excluded). */
const PAYLOAD_FIELDS: ReadonlyArray<keyof AuditMutation> = [
  "timestamp",
  "runId",
  "repo",
  "target",
  "verb",
  "outcome",
  "exitCode",
  "caller",
];

/** Compute the lowercase hex SHA-256 digest of a string. */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Produce the deterministic canonical payload for hashing.
 *
 * Only the mutation fields (never the chain fields) are included, in a
 * fixed key order, with undefined values omitted — so the same logical
 * entry always hashes to the same value regardless of object key order.
 */
function canonicalPayload(
  entry: AuditMutation & { timestamp: string },
): string {
  const ordered: Record<string, unknown> = {};
  for (const key of PAYLOAD_FIELDS) {
    const value = entry[key];
    if (value !== undefined) {
      ordered[key] = value;
    }
  }
  return JSON.stringify(ordered);
}

/**
 * Compute the chain hash for an entry given the previous hash.
 *
 * @param entry - Mutation fields, with the timestamp already resolved
 * @param prevHash - Hash of the preceding entry ("" for the first)
 * @returns Lowercase hex SHA-256 digest
 */
export async function computeEntryHash(
  entry: AuditMutation & { timestamp: string },
  prevHash: string,
): Promise<string> {
  return await sha256Hex(`${prevHash}\n${canonicalPayload(entry)}`);
}
