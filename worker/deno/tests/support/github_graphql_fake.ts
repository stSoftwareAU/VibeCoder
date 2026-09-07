/**
 * A fake GitHub GraphQL endpoint that models the API's own rules (Issue #471).
 *
 * The batch fetchers (`timeline_batch`, `comment_batch`, `check_runs_batch`)
 * used to be covered by tests that asserted the *text* of the query they
 * generate. Such a test is written from the same mental model that produced
 * the query, so it cannot disagree with its author — Issue #470 shipped a
 * reversed `Ref.compare` for exactly that reason, with a green test pinning
 * the reversed text.
 *
 * This fake answers a query the way GitHub would instead of asserting how it
 * is spelled: it resolves the repository, resolves each alias, honours
 * `first:` (head of the connection) versus `last:` (tail), and returns `null`
 * for anything it cannot resolve. A query asked the wrong way round therefore
 * receives a truthfully wrong answer, and the assertion lands on the decision
 * the worker reaches.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

/** One comment, oldest first in {@link FakeIssue.comments}. */
export interface FakeComment {
  databaseId: number;
  author: string;
  body: string;
  createdAt: string;
}

/** One labelled event, oldest first in {@link FakeIssue.labelEvents}. */
export interface FakeLabelEvent {
  label: string;
  actor: string;
  createdAt: string;
}

/** Server-side state for one issue. */
export interface FakeIssue {
  comments?: FakeComment[];
  labelEvents?: FakeLabelEvent[];
}

/** One status-check context on a pull request's head commit. */
export type FakeCheckContext =
  | {
    kind: "checkRun";
    databaseId: number;
    name: string;
    status: string;
    conclusion: string | null;
  }
  | { kind: "statusContext"; context: string; state: string };

/** Server-side state for one pull request. */
export interface FakePullRequest {
  headOid: string;
  rollupState: string;
  contexts: FakeCheckContext[];
}

/** Everything the fake knows about one repository. */
export interface FakeRepoState {
  owner: string;
  name: string;
  issues?: Record<number, FakeIssue>;
  pullRequests?: Record<number, FakePullRequest>;
}

/** A `gh` stand-in plus the calls it received. */
export interface FakeGh {
  /** Drop-in replacement for `runGhCommand`. */
  gh: (args: string[]) => Promise<string>;
  /** Every GraphQL query body the code under test sent, in order. */
  queries: string[];
}

/** Connection arguments as GitHub interprets them. */
interface Slice {
  first?: number;
  last?: number;
}

function parseSlice(args: string): Slice {
  const first = /\bfirst:\s*(\d+)/.exec(args);
  const last = /\blast:\s*(\d+)/.exec(args);
  const slice: Slice = {};
  if (first) slice.first = Number(first[1]);
  if (last) slice.last = Number(last[1]);
  return slice;
}

/**
 * Apply a connection slice the way GitHub does: `first: n` returns the head of
 * the ordered set, `last: n` the tail. A connection with neither is an error
 * on the real API; here it yields nothing, which fails the caller loudly.
 */
function applySlice<T>(items: T[], slice: Slice): T[] {
  if (slice.first !== undefined) return items.slice(0, slice.first);
  if (slice.last !== undefined) return items.slice(-slice.last);
  return [];
}

/**
 * Extract the body of `field(<args>) { ... }` from an alias block.
 *
 * Scanned with a literal regex over each candidate rather than one built
 * from `field`: a dynamic `RegExp` is a ReDoS surface the security gate
 * refuses, and the field names here are fixed anyway.
 */
function selection(
  block: string,
  field: string,
): { args: string; body: string } | undefined {
  const open = findFieldOpening(block, field);
  if (!open) return undefined;
  const start = open.index + open[0].length;
  let depth = 1;
  let i = start;
  while (i < block.length && depth > 0) {
    if (block[i] === "{") depth++;
    else if (block[i] === "}") depth--;
    i++;
  }
  return { args: open[1] ?? "", body: block.slice(start, i - 1) };
}

/**
 * Locate `field(<args>) {` in `block`, mimicking a word-boundary match.
 *
 * Returns the matched text, its index and the captured argument list, in the
 * shape `RegExp.exec` would have produced.
 */
function findFieldOpening(
  block: string,
  field: string,
): { 0: string; 1: string; index: number } | undefined {
  const opening = /([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/g;
  for (const match of block.matchAll(opening)) {
    if (match[1] !== field) continue;
    return { 0: match[0], 1: match[2] ?? "", index: match.index ?? 0 };
  }
  return undefined;
}

/** Split `query { repository(...) { <aliases> } }` into its alias blocks. */
function aliasBlocks(
  query: string,
): Array<{ alias: string; kind: string; number: number; block: string }> {
  const out: Array<
    { alias: string; kind: string; number: number; block: string }
  > = [];
  const header =
    /(\w+):\s*(issue|pullRequest)\s*\(\s*number:\s*(\d+)\s*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = header.exec(query)) !== null) {
    let depth = 1;
    let i = header.lastIndex;
    while (i < query.length && depth > 0) {
      if (query[i] === "{") depth++;
      else if (query[i] === "}") depth--;
      i++;
    }
    out.push({
      alias: m[1] as string,
      kind: m[2] as string,
      number: Number(m[3]),
      block: query.slice(header.lastIndex, i - 1),
    });
  }
  return out;
}

function issueNode(issue: FakeIssue, block: string): Record<string, unknown> {
  const node: Record<string, unknown> = {};

  const comments = selection(block, "comments");
  if (comments) {
    const all = issue.comments ?? [];
    node.comments = {
      nodes: applySlice(all, parseSlice(comments.args)).map((c) => ({
        databaseId: c.databaseId,
        author: { login: c.author },
        body: c.body,
        createdAt: c.createdAt,
      })),
    };
  }

  const timeline = selection(block, "timelineItems");
  if (timeline) {
    // GitHub filters by `itemTypes` server-side; only LABELED_EVENT is modelled.
    const wanted = /itemTypes:\s*\[([^\]]*)\]/.exec(timeline.args)?.[1] ?? "";
    const all = wanted.includes("LABELED_EVENT") ? issue.labelEvents ?? [] : [];
    node.timelineItems = {
      nodes: applySlice(all, parseSlice(timeline.args)).map((e) => ({
        __typename: "LabeledEvent",
        createdAt: e.createdAt,
        label: { name: e.label },
        actor: { login: e.actor },
      })),
    };
  }

  return node;
}

function pullRequestNode(
  pr: FakePullRequest,
  block: string,
): Record<string, unknown> {
  const commits = selection(block, "commits");
  if (!commits) return {};
  const contexts = selection(commits.body, "contexts");
  const sliced = contexts
    ? applySlice(pr.contexts, parseSlice(contexts.args))
    : [];
  return {
    commits: {
      nodes: [{
        commit: {
          oid: pr.headOid,
          statusCheckRollup: {
            state: pr.rollupState,
            contexts: {
              nodes: sliced.map((c) =>
                c.kind === "checkRun"
                  ? {
                    __typename: "CheckRun",
                    databaseId: c.databaseId,
                    name: c.name,
                    status: c.status,
                    conclusion: c.conclusion,
                  }
                  : {
                    __typename: "StatusContext",
                    context: c.context,
                    state: c.state,
                  }
              ),
            },
          },
        },
      }],
    },
  };
}

/**
 * Build a `gh` stand-in that answers batch GraphQL queries from `state`.
 *
 * Anything the query asks for that the state does not hold resolves to `null`,
 * exactly as GitHub resolves a missing node — never to a plausible default.
 */
export function fakeGithubGraphQL(state: FakeRepoState): FakeGh {
  const queries: string[] = [];
  const gh = (args: string[]): Promise<string> => {
    if (args[0] !== "api" || args[1] !== "graphql") {
      throw new Error(`fake gh received a non-GraphQL call: ${args.join(" ")}`);
    }
    const field = args.find((a) => a.startsWith("query="));
    if (!field) throw new Error("fake gh received no query= field");
    const query = field.slice("query=".length);
    queries.push(query);

    const repo = /repository\(owner:\s*"([^"]*)",\s*name:\s*"([^"]*)"\)/.exec(
      query,
    );
    if (!repo || repo[1] !== state.owner || repo[2] !== state.name) {
      return Promise.resolve(JSON.stringify({
        data: { repository: null },
        errors: [{ message: "Could not resolve to a Repository" }],
      }));
    }

    const repository: Record<string, unknown> = {};
    for (const { alias, kind, number, block } of aliasBlocks(query)) {
      if (kind === "issue") {
        const issue = state.issues?.[number];
        repository[alias] = issue ? issueNode(issue, block) : null;
      } else {
        const pr = state.pullRequests?.[number];
        repository[alias] = pr ? pullRequestNode(pr, block) : null;
      }
    }
    return Promise.resolve(JSON.stringify({ data: { repository } }));
  };
  return { gh, queries };
}

// ---------------------------------------------------------------------------
// Cross-repo PR search (Issue #1486)
// ---------------------------------------------------------------------------

/** Server-side state for one pull request the search can return. */
export interface FakeSearchPr {
  /** Owning repository, "owner/name". */
  repo: string;
  number: number;
  /** Author login. Matched case-insensitively, as GitHub matches logins. */
  author: string;
  /** Defaults to open; a closed PR is invisible to an `is:open` query. */
  state?: "open" | "closed";
  title?: string;
  baseRefName?: string;
  headRefName?: string;
  headRefOid?: string;
  createdAt?: string;
  updatedAt?: string;
  isDraft?: boolean;
  mergeable?: string;
  labels?: string[];
  autoMergeRequest?: { enabledAt: string; mergeMethod: string } | null;
  comments?: { author: string; body: string }[];
  reviews?: { author: string; body: string }[];
  /** Entries beyond the page the query asked for, per connection. */
  extraLabels?: number;
  extraComments?: number;
  extraReviews?: number;
}

/** The qualifiers this fake understands, parsed from the `q` variable. */
interface SearchQuery {
  isPr: boolean;
  openOnly: boolean;
  owner: string | null;
  authors: string[];
}

function parseSearchQuery(q: string): SearchQuery {
  const parsed: SearchQuery = {
    isPr: false,
    openOnly: false,
    owner: null,
    authors: [],
  };
  for (const token of q.split(/\s+/).filter((t) => t.length > 0)) {
    if (token === "is:pr") parsed.isPr = true;
    else if (token === "is:open" || token === "state:open") {
      parsed.openOnly = true;
    } else if (token.startsWith("user:") || token.startsWith("org:")) {
      parsed.owner = token.slice(token.indexOf(":") + 1).toLowerCase();
    } else if (token.startsWith("author:")) {
      parsed.authors.push(token.slice("author:".length).toLowerCase());
    }
  }
  return parsed;
}

/** A connection payload, truncated to `first` with GitHub's `totalCount`. */
function connection<T>(
  items: T[],
  extra: number,
  first: number,
  project: (item: T) => unknown,
): { totalCount: number; nodes: unknown[] } {
  return {
    totalCount: items.length + extra,
    nodes: items.slice(0, first).map(project),
  };
}

/**
 * Build a `gh` stand-in that answers a cross-repo PR **search** the way
 * GitHub would (Issue #1486).
 *
 * It parses the `q` variable rather than trusting the query text: a PR is
 * returned only when the query really is `is:pr`, really names this repo's
 * owner, and really names the PR's author; `is:open` really excludes a
 * closed PR. Paging honours the `first` variable and the opaque `after`
 * cursor, and each node carries only the fields the selection set asks for —
 * so a query that drops a field, an author or the owner receives a
 * truthfully wrong answer instead of a convenient one.
 *
 * @param prs - Every PR the fake's GitHub holds.
 * @returns The runner plus the queries it received.
 */
export function fakeGithubPrSearch(prs: readonly FakeSearchPr[]): FakeGh {
  const queries: string[] = [];
  const gh = (args: string[]): Promise<string> => {
    if (args[0] !== "api" || args[1] !== "graphql") {
      throw new Error(`fake gh received a non-GraphQL call: ${args.join(" ")}`);
    }
    const queryArg = args.find((a) => a.startsWith("query="));
    const qArg = args.find((a) => a.startsWith("q="));
    if (!queryArg) throw new Error("fake gh received no query= field");
    if (!qArg) throw new Error("fake gh received no q= search variable");
    const query = queryArg.slice("query=".length);
    queries.push(query);
    if (!/\bsearch\s*\(/.test(query)) {
      throw new Error("fake gh received a non-search GraphQL query");
    }

    const wanted = parseSearchQuery(qArg.slice("q=".length));
    const firstArg = args.find((a) => a.startsWith("first="));
    const first = firstArg === undefined
      ? 0
      : Number(firstArg.slice("first=".length));
    const afterArg = args.find((a) => a.startsWith("after="));
    const offset = afterArg === undefined
      ? 0
      : Number(afterArg.slice("after=cursor:".length));

    const matched = wanted.isPr
      ? prs.filter((pr) => {
        const owner = pr.repo.slice(0, pr.repo.indexOf("/")).toLowerCase();
        if (wanted.owner !== owner) return false;
        if (!wanted.authors.includes(pr.author.toLowerCase())) return false;
        if (wanted.openOnly && (pr.state ?? "open") !== "open") return false;
        return true;
      })
      : [];

    // Conversation page size comes from the selection set, as it does on the
    // real API: `comments(first: N)`.
    const conversationFirst = Number(
      /comments\(first:\s*(\d+)/.exec(query)?.[1] ?? "0",
    );
    const labelFirst = Number(
      /labels\(first:\s*(\d+)/.exec(query)?.[1] ?? "0",
    );

    const page = matched.slice(offset, offset + Math.max(first, 0));
    // The identifiers the selection set names, so a field the query stopped
    // requesting is absent from the answer - as it would be on the real API.
    const selected = new Set(query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
    const has = (field: string) => selected.has(field);
    const nodes = page.map((pr) => {
      const node: Record<string, unknown> = {};
      if (has("number")) node.number = pr.number;
      if (has("title")) node.title = pr.title ?? `PR ${pr.number}`;
      if (has("baseRefName")) node.baseRefName = pr.baseRefName ?? "main";
      if (has("headRefName")) {
        node.headRefName = pr.headRefName ?? `branch-${pr.number}`;
      }
      if (has("headRefOid")) {
        node.headRefOid = pr.headRefOid ?? `oid-${pr.number}`;
      }
      if (has("createdAt")) {
        node.createdAt = pr.createdAt ?? "2026-01-01T00:00:00Z";
      }
      if (has("updatedAt")) {
        node.updatedAt = pr.updatedAt ?? "2026-01-02T00:00:00Z";
      }
      if (has("isDraft")) node.isDraft = pr.isDraft ?? false;
      if (has("mergeable")) node.mergeable = pr.mergeable ?? "MERGEABLE";
      if (has("author")) node.author = { login: pr.author };
      if (has("nameWithOwner")) node.repository = { nameWithOwner: pr.repo };
      if (has("labels")) {
        node.labels = connection(
          pr.labels ?? [],
          pr.extraLabels ?? 0,
          labelFirst,
          (name) => ({ name }),
        );
      }
      if (has("autoMergeRequest")) {
        node.autoMergeRequest = pr.autoMergeRequest ?? null;
      }
      if (has("comments")) {
        node.comments = connection(
          pr.comments ?? [],
          pr.extraComments ?? 0,
          conversationFirst,
          (c) => ({ author: { login: c.author }, body: c.body }),
        );
      }
      if (has("reviews")) {
        node.reviews = connection(
          pr.reviews ?? [],
          pr.extraReviews ?? 0,
          conversationFirst,
          (r) => ({ author: { login: r.author }, body: r.body }),
        );
      }
      return node;
    });

    const nextOffset = offset + page.length;
    const hasNextPage = nextOffset < matched.length;
    return Promise.resolve(JSON.stringify({
      data: {
        search: {
          issueCount: matched.length,
          pageInfo: {
            hasNextPage,
            endCursor: hasNextPage ? `cursor:${nextOffset}` : null,
          },
          nodes,
        },
      },
    }));
  };
  return { gh, queries };
}
