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

/** Extract the body of `field(<args>) { ... }` from an alias block. */
function selection(
  block: string,
  field: string,
): { args: string; body: string } | undefined {
  const open = new RegExp(`\\b${field}\\s*\\(([^)]*)\\)\\s*\\{`).exec(block);
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
