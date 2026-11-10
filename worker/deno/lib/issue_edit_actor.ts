/**
 * Resolve who actually edited an issue's title or body (Issue #3715).
 *
 * The content-integrity gate (Issue #1341) re-baselines on the trust of an
 * identity, so that identity must be *whoever made the edit* — not the author
 * recorded when the snapshot was captured. Any collaborator with write access
 * can edit a trusted author's issue, and attributing that edit to the issue
 * author hands the editor the author's trust (CWE-863).
 *
 * GitHub records the two halves of "the content changed" in different places:
 *
 * - a **body** edit appears in `Issue.userContentEdits` (editor + `editedAt`);
 * - a **title** edit appears as a `RenamedTitleEvent` timeline item
 *   (actor + `createdAt`).
 *
 * Both are read in one GraphQL round-trip and returned as the **edit history**,
 * newest first (Issue #3879). Reducing the two records to a single newest actor
 * destroyed the provenance a trust decision needs: an untrusted body edit
 * followed by any later trusted edit — a maintainer fixing a typo in the title
 * is enough — reported only the trusted actor, and the untrusted body inherited
 * that trust. Trust is a property of the whole set of editors, not of its
 * maximum, so callers get the set and decide over all of it.
 *
 * GitHub lists `userContentEdits` newest first, so the body half asks for
 * `first: 100`: the newest 100 body edits (Issue #4804). An issue with more
 * body edits than that reports `bodyHistoryTruncated`, and its older edits are
 * absent from `actors`. The rename half reads the newest 100 title renames
 * (`timelineItems(last: 100)`, Issue #4947) and reports `renameHistoryTruncated`
 * in the same way, using the connection's `totalCount`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { withGraphQLSource } from "./gh_call_metrics.ts";

/** The actor behind the most recent title or body edit. */
export interface IssueEditActor {
  /**
   * GitHub login of the editor. Empty when GitHub records the edit but not
   * the actor (e.g. a deleted or anonymised account) — an unattributable
   * edit must never be treated as trusted.
   */
  login: string;
  /** Unix seconds at which the edit was made. */
  editedAt: number;
  /** Which record identified the actor. */
  source: "content-edit" | "rename";
  /**
   * GitHub's `diff` body snapshot. Present only when the caller asked
   * for it with `includeDiff`; absent for renames and for the default query.
   */
  diff?: string;
  /** Previous body snapshot, when available and ordered before this edit. */
  previousDiff?: string;
}

/**
 * Outcome of an editor lookup.
 *
 * `ok: true` carries `actors`: every recorded edit in the window, ordered
 * newest first — the newest 100 renames and the newest 100 body edits, each
 * window flagged by its own truncation flag (`renameHistoryTruncated`,
 * `bodyHistoryTruncated`). An empty array means no edit
 * record was returned (`actor` is then `null`). `ok: false` means the lookup
 * itself could not be completed, and callers that gate on trust must fail
 * closed rather than guess (Issue #3234).
 *
 * `actor` is the head of `actors`, kept for messaging and for ordering an
 * approval against the most recent edit. A **trust** decision must read
 * `actors`, never `actor` alone (Issue #3879).
 */
export type IssueEditActorLookup =
  | {
    ok: true;
    actor: IssueEditActor | null;
    actors: IssueEditActor[];
    /**
     * True when older body edits exist beyond the newest-100 window, so
     * `actors` lacks them (Issue #4804). A trust decision must not read their
     * absence as "nobody edited".
     */
    bodyHistoryTruncated: boolean;
    /**
     * True when older title renames exist beyond the newest-100 window, so
     * `actors` lacks them (Issue #4947). A trust decision must not read their
     * absence as "nobody renamed".
     */
    renameHistoryTruncated: boolean;
  }
  | { ok: false; error: Error };

/** A truncated edit-history window, and whether its returned edits settle it. */
export interface UnsettledHistoryWindow {
  /** Which record the truncated window belongs to. */
  source: "content-edit" | "rename";
  /** Unix seconds of the oldest returned edit in the window, or null when none is returned. */
  oldestAt: number | null;
}

/**
 * The truncated windows that do not yet settle a snapshot (Issues #4804, #4947).
 *
 * GitHub lists the newest edits first, so a truncated window hides older edits
 * that could post-date the snapshot. The window is settled only when its oldest
 * returned edit predates the snapshot: then every edit at or after the snapshot
 * is inside the window. A window with no returned edit, or whose oldest edit
 * post-dates the snapshot, is unsettled. The body window is listed first.
 *
 * @param lookup - A successful editor lookup
 * @param snapshotAt - Unix seconds of the snapshot the edits are judged against
 * @returns each unsettled truncated window; empty when every window is settled
 */
export function unsettledHistoryWindows(
  lookup: Extract<IssueEditActorLookup, { ok: true }>,
  snapshotAt: number,
): UnsettledHistoryWindow[] {
  const oldestOf = (
    source: UnsettledHistoryWindow["source"],
  ): number | null => {
    const times = lookup.actors
      .filter((e) => e.source === source)
      .map((e) => e.editedAt);
    return times.length === 0 ? null : Math.min(...times);
  };
  const windows: UnsettledHistoryWindow[] = [];
  if (lookup.bodyHistoryTruncated) {
    windows.push({
      source: "content-edit",
      oldestAt: oldestOf("content-edit"),
    });
  }
  if (lookup.renameHistoryTruncated) {
    windows.push({ source: "rename", oldestAt: oldestOf("rename") });
  }
  return windows.filter((w) => w.oldestAt === null || w.oldestAt >= snapshotAt);
}

/**
 * Both edit records in one round-trip. GitHub lists `userContentEdits` newest
 * first, so `first: 100` is the newest 100 body edits (Issue #4804); the
 * `totalCount` reports any older edits beyond that window. The timeline is
 * chronological, so `last: 100` with `itemTypes:[RENAMED_TITLE_EVENT]` is its
 * newest 100 rename events (Issue #4947); with that filter `totalCount` counts
 * only renames, so a count above the returned nodes marks older renames as
 * hidden. The newest edit is chosen by timestamp below, never by connection
 * order.
 */
const EDIT_ACTOR_QUERY =
  `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){userContentEdits(first:100){totalCount nodes{editedAt editor{login}}} timelineItems(last:100,itemTypes:[RENAMED_TITLE_EVENT]){totalCount nodes{... on RenamedTitleEvent{createdAt actor{login}}}}}}}`;

/** The claim check needs the newest body snapshots, in GitHub's newest-first connection. */
const EDIT_ACTOR_DIFF_QUERY = EDIT_ACTOR_QUERY.replace(
  "userContentEdits(first:100){totalCount nodes{editedAt editor{login}}}",
  "userContentEdits(first:100){totalCount nodes{editedAt diff editor{login}}}",
);

/** Shape of the GraphQL response consumed here. */
interface EditActorResponse {
  errors?: unknown[];
  data?: {
    repository?: {
      issue?: {
        userContentEdits?: {
          totalCount?: number;
          nodes?: Array<
            {
              editedAt?: string | null;
              diff?: string | null;
              editor?: { login?: string } | null;
            }
          >;
        };
        timelineItems?: {
          totalCount?: number;
          nodes?: Array<
            { createdAt?: string | null; actor?: { login?: string } | null }
          >;
        };
      } | null;
    } | null;
  };
}

/** Split "owner/repo" into its two halves, or null when malformed. */
function splitRepo(repo: string): { owner: string; name: string } | null {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) return null;
  return { owner: repo.substring(0, slash), name: repo.substring(slash + 1) };
}

/** Parse an ISO-8601 timestamp to unix seconds, or null when unusable. */
function toUnixSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * Compare two edits for a newest-first ordering (Issue #3879).
 *
 * Ties used to fall through to GraphQL node order — an implicit dependency on
 * how GitHub happened to page the two connections. The order is now explicit:
 *
 * 1. later `editedAt` first;
 * 2. on the same second, `content-edit` before `rename`, because the body is
 *    the text that reaches the model and is the more security-relevant
 *    attribution to report;
 * 3. then by login, so the ordering is total and reproducible.
 */
function byNewestFirst(a: IssueEditActor, b: IssueEditActor): number {
  if (a.editedAt !== b.editedAt) return b.editedAt - a.editedAt;
  if (a.source !== b.source) return a.source === "content-edit" ? -1 : 1;
  return a.login.localeCompare(b.login);
}

/**
 * Resolve the full title/body edit history of an issue.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - Issue number
 * @param ghFn - Injected `gh` CLI runner
 * @param options - `includeDiff` also reads each body edit's `diff` text. Off
 *   by default so the content-integrity gate's query stays small.
 * @returns Every recorded edit actor in the newest-100 body and rename windows,
 *   newest first (with `actor` as the newest and `null` when the issue has
 *   never been edited), flagged `bodyHistoryTruncated` when older body edits
 *   lie beyond their window and `renameHistoryTruncated` when older renames do,
 *   or an error when the lookup could not be completed
 */
export async function resolveLastIssueEditor(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
  options?: { includeDiff?: boolean },
): Promise<IssueEditActorLookup> {
  const parts = splitRepo(repo);
  if (parts === null) {
    return { ok: false, error: new Error(`Malformed repository: "${repo}"`) };
  }

  let raw: string;
  try {
    raw = await withGraphQLSource("issue-edit-actor", () =>
      ghFn([
        "api",
        "graphql",
        "-f",
        `query=${
          options?.includeDiff ? EDIT_ACTOR_DIFF_QUERY : EDIT_ACTOR_QUERY
        }`,
        "-F",
        `owner=${parts.owner}`,
        "-F",
        `name=${parts.name}`,
        "-F",
        `number=${issueNumber}`,
      ]));
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Edit-actor query failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }

  if (!raw.trim()) {
    return { ok: false, error: new Error("Edit-actor query returned no data") };
  }

  let parsed: EditActorResponse;
  try {
    parsed = JSON.parse(raw) as EditActorResponse;
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Edit-actor query returned unparseable JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }

  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    return {
      ok: false,
      error: new Error(
        `Edit-actor query reported errors: ${JSON.stringify(parsed.errors)}`,
      ),
    };
  }

  const issue = parsed.data?.repository?.issue;
  if (!issue || typeof issue !== "object") {
    return {
      ok: false,
      error: new Error(
        `Edit-actor query returned no issue for #${issueNumber}`,
      ),
    };
  }

  const candidates: IssueEditActor[] = [];

  // Issue #4804: `totalCount` is what tells a truncated window from a complete
  // one, so a response without a usable count is malformed and is rejected.
  const totalCount = issue.userContentEdits?.totalCount;
  const bodyCount = issue.userContentEdits?.nodes?.length ?? 0;
  if (!Number.isInteger(totalCount) || totalCount! < bodyCount) {
    return {
      ok: false,
      error: new Error(
        "Edit-actor query returned invalid userContentEdits totalCount",
      ),
    };
  }
  const bodyHistoryTruncated = totalCount! > bodyCount;

  const bodyNodes = [...(issue.userContentEdits?.nodes ?? [])].sort((a, b) =>
    Date.parse(a?.editedAt ?? "") - Date.parse(b?.editedAt ?? "")
  );
  // A truncated window with an unreadable timestamp cannot be placed against
  // the snapshot, and the older edits it hides cannot be ruled out: fail closed.
  if (
    bodyHistoryTruncated &&
    bodyNodes.some((node) => !Number.isFinite(Date.parse(node?.editedAt ?? "")))
  ) {
    return {
      ok: false,
      error: new Error(
        "Edit-actor query returned truncated userContentEdits history with an unparseable editedAt",
      ),
    };
  }
  // A malformed timestamp makes adjacency uncertain; never exempt an edit.
  const orderedBodies = bodyNodes.every((node) =>
    Number.isFinite(Date.parse(node?.editedAt ?? ""))
  );
  for (const [index, node] of bodyNodes.entries()) {
    const editedAt = toUnixSeconds(node?.editedAt);
    if (editedAt === null) continue;
    const previous = bodyNodes[index - 1];
    const previousTime = previous?.editedAt
      ? Date.parse(previous.editedAt)
      : NaN;
    const currentTime = node?.editedAt ? Date.parse(node.editedAt) : NaN;
    candidates.push({
      login: node?.editor?.login ?? "",
      editedAt,
      source: "content-edit",
      ...(options?.includeDiff && typeof node?.diff === "string"
        ? { diff: node.diff }
        : {}),
      ...(options?.includeDiff && orderedBodies &&
          typeof previous?.diff === "string" &&
          previousTime < currentTime
        ? { previousDiff: previous.diff }
        : {}),
    });
  }

  // Issue #4947: `totalCount` is what tells a truncated rename window from a
  // complete one, so a response without a usable count is malformed and is
  // rejected, exactly as for body edits.
  const renameTotal = issue.timelineItems?.totalCount;
  const renameNodes = issue.timelineItems?.nodes ?? [];
  const renameCount = renameNodes.length;
  if (!Number.isInteger(renameTotal) || renameTotal! < renameCount) {
    return {
      ok: false,
      error: new Error(
        "Edit-actor query returned invalid timelineItems totalCount",
      ),
    };
  }
  const renameHistoryTruncated = renameTotal! > renameCount;
  // A truncated window with an unreadable timestamp cannot be placed against
  // the snapshot, and the older renames it hides cannot be ruled out: fail closed.
  if (
    renameHistoryTruncated &&
    renameNodes.some((node) => toUnixSeconds(node?.createdAt) === null)
  ) {
    return {
      ok: false,
      error: new Error(
        "Edit-actor query returned truncated timelineItems history with an unparseable createdAt",
      ),
    };
  }

  for (const node of renameNodes) {
    const editedAt = toUnixSeconds(node?.createdAt);
    if (editedAt === null) continue;
    candidates.push({
      login: node?.actor?.login ?? "",
      editedAt,
      source: "rename",
    });
  }

  if (candidates.length === 0) {
    return {
      ok: true,
      actor: null,
      actors: [],
      bodyHistoryTruncated,
      renameHistoryTruncated,
    };
  }

  // Issue #3879: return the whole history rather than reducing it. Callers that
  // gate on trust must see every editor; collapsing to the newest let a trusted
  // rename bless an untrusted body edit made before it.
  candidates.sort(byNewestFirst);
  return {
    ok: true,
    actor: candidates[0] ?? null,
    actors: candidates,
    bodyHistoryTruncated,
    renameHistoryTruncated,
  };
}
