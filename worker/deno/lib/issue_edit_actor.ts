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
 * Both are read in one GraphQL round-trip and returned as the **full edit
 * history**, newest first (Issue #3879). Reducing the two records to a single
 * newest actor destroyed the provenance a trust decision needs: an untrusted
 * body edit followed by any later trusted edit — a maintainer fixing a typo in
 * the title is enough — reported only the trusted actor, and the untrusted body
 * inherited that trust. Trust is a property of the whole set of editors, not of
 * its maximum, so callers get the set and decide over all of it.
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
 * `ok: true` carries `actors`: every recorded edit, ordered newest first. An
 * empty array means GitHub has no edit record at all (`actor` is then `null`).
 * `ok: false` means the lookup itself could not be completed, and callers
 * that gate on trust must fail closed rather than guess (Issue #3234).
 *
 * `actor` is the head of `actors`, kept for messaging and for ordering an
 * approval against the most recent edit. A **trust** decision must read
 * `actors`, never `actor` alone (Issue #3879).
 */
export type IssueEditActorLookup =
  | { ok: true; actor: IssueEditActor | null; actors: IssueEditActor[] }
  | { ok: false; error: Error };

/**
 * Both edit records in one round-trip. `last: 100` is the maximum page size:
 * for any issue with 100 or fewer edits it returns every edit regardless of
 * connection ordering, and the newest is then chosen by timestamp below.
 */
const EDIT_ACTOR_QUERY =
  `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){userContentEdits(last:100){nodes{editedAt editor{login}}} timelineItems(last:100,itemTypes:[RENAMED_TITLE_EVENT]){nodes{... on RenamedTitleEvent{createdAt actor{login}}}}}}}`;

/** {@link EDIT_ACTOR_QUERY} plus each body edit's `diff` (Issue #4763). */
const EDIT_ACTOR_DIFF_QUERY = EDIT_ACTOR_QUERY.replace(
  "nodes{editedAt editor{login}}",
  "nodes{editedAt diff editor{login}}",
);

/** Shape of the GraphQL response consumed here. */
interface EditActorResponse {
  errors?: unknown[];
  data?: {
    repository?: {
      issue?: {
        userContentEdits?: {
          nodes?: Array<
            {
              editedAt?: string | null;
              diff?: string | null;
              editor?: { login?: string } | null;
            }
          >;
        };
        timelineItems?: {
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
 * @returns Every recorded edit actor newest first (with `actor` as the newest
 *   and `null` when the issue has never been edited), or an error when the
 *   lookup could not be completed
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

  const bodyNodes = [...(issue.userContentEdits?.nodes ?? [])].sort((a, b) =>
    Date.parse(a?.editedAt ?? "") - Date.parse(b?.editedAt ?? "")
  );
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

  for (const node of issue.timelineItems?.nodes ?? []) {
    const editedAt = toUnixSeconds(node?.createdAt);
    if (editedAt === null) continue;
    candidates.push({
      login: node?.actor?.login ?? "",
      editedAt,
      source: "rename",
    });
  }

  if (candidates.length === 0) return { ok: true, actor: null, actors: [] };

  // Issue #3879: return the whole history rather than reducing it. Callers that
  // gate on trust must see every editor; collapsing to the newest let a trusted
  // rename bless an untrusted body edit made before it.
  candidates.sort(byNewestFirst);
  return { ok: true, actor: candidates[0] ?? null, actors: candidates };
}
