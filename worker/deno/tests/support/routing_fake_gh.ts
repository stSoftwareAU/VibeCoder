/**
 * A fake `gh` over an in-memory store of issues, shared by the routed-filing
 * and `route-issue` tests (Issues #3743, #3744, #3747, #3748).
 *
 * It models the commands issue routing runs, with the output shapes the real
 * CLI prints: `search issues` (phrase in title, open/closed state, the
 * day-granular `--closed` qualifier), `issue list --state open --search
 * --json` (the owned-artefact lookup), `repo view --json viewerPermission`,
 * `issue create` (prints the new issue's URL), `issue view --json` (with the
 * author's login), `issue comment`, `issue close` and `issue edit --body`.
 * Anything it does not model throws, so a test cannot pass on an unmodelled
 * call.
 *
 * Australian English spelling used throughout.
 */

import type { GhCommandFn } from "../../lib/issue_routing_github.ts";

/** The login every stored issue is authored by unless a test says otherwise. */
export const FLEET_LOGIN = "fleet-bot";

/** A stored issue or pull request. */
export interface FakeIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  /** The author's login, as `gh --json author` reports it. */
  author: string;
  closedAt: string | null;
  isPullRequest: boolean;
  labels: string[];
  comments: string[];
  stateReason?: string;
}

/** The fake's state; tests read it to assert outcomes. */
export interface FakeStore {
  issues: FakeIssue[];
  /** `viewerPermission` per repository; a missing key is a missing repo. */
  viewerPermission: Record<string, string | null>;
  /** The time `issue close` stamps on `closedAt`. */
  now: string;
}

/** A fake `gh` and the record of every call it answered. */
export interface FakeGh {
  ghCommandFn: GhCommandFn;
  calls: string[][];
  store: FakeStore;
}

/** Hooks a test uses to fail a call or race another filer. */
export interface FakeGhHooks {
  /** Return an error to fail this call before it touches the store. */
  failWhen?: (args: string[]) => Error | undefined;
  /** Runs before an `issue create` is stored (to model a concurrent filer). */
  beforeCreate?: (store: FakeStore, args: string[]) => void;
}

const WRITE_VERBS = new Set(["create", "comment", "close", "edit", "reopen"]);

/** Whether a recorded call writes to GitHub. */
export function isWriteCall(args: readonly string[]): boolean {
  return args[0] === "issue" && WRITE_VERBS.has(args[1] ?? "");
}

/** A store holding `issues`, with WRITE access to each repo named. */
export function fakeStore(
  issues: Partial<FakeIssue>[] = [],
  viewerPermission: Record<string, string | null> = {},
): FakeStore {
  const full = issues.map((i) => ({
    repo: "stSoftwareAU/VibeCoder",
    number: 1,
    title: "",
    body: "",
    author: FLEET_LOGIN,
    closedAt: null,
    isPullRequest: false,
    labels: [],
    comments: [],
    ...i,
  }));
  const perms: Record<string, string | null> = {};
  for (const issue of full) perms[issue.repo] = "WRITE";
  return {
    issues: full,
    viewerPermission: { ...perms, ...viewerPermission },
    now: "2026-10-15T00:00:00Z",
  };
}

/** Add an issue to the store, numbered after the repo's highest. */
export function addIssue(
  store: FakeStore,
  repo: string,
  title: string,
  body = "",
): FakeIssue {
  const highest = Math.max(
    0,
    ...store.issues.filter((i) => i.repo === repo).map((i) => i.number),
  );
  const issue: FakeIssue = {
    repo,
    number: highest + 1,
    title,
    body,
    author: FLEET_LOGIN,
    closedAt: null,
    isPullRequest: false,
    labels: [],
    comments: [],
  };
  store.issues.push(issue);
  return issue;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");
}

function containsPhrase(title: string, phrase: string[]): boolean {
  if (phrase.length === 0) return false;
  const tokens = words(title);
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((w, j) => tokens[i + j] === w)) return true;
  }
  return false;
}

function fail(message: string): never {
  throw new Error(`gh command failed (exit 1): ${message}`);
}

/** Parse `--flag value` pairs after `start`; bare flags map to "true". */
function flagsOf(
  args: string[],
  start: number,
  bare: ReadonlySet<string>,
): { positional: string[]; flags: Map<string, string[]> } {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = start; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    if (bare.has(a)) {
      flags.set(a, ["true"]);
      continue;
    }
    const value = args[i + 1];
    if (value === undefined) fail(`flag needs an argument: ${a}`);
    flags.set(a, [...(flags.get(a) ?? []), value]);
    i++;
  }
  return { positional, flags };
}

function one(flags: Map<string, string[]>, flag: string): string | undefined {
  return flags.get(flag)?.[0];
}

function requireRepo(store: FakeStore, repo: string | undefined): string {
  if (repo === undefined || !Object.hasOwn(store.viewerPermission, repo)) {
    fail(
      `GraphQL: Could not resolve to a Repository with the name '${repo}'.`,
    );
  }
  return repo;
}

function findIssue(store: FakeStore, repo: string, n: string): FakeIssue {
  const issue = store.issues.find((i) =>
    i.repo === repo && String(i.number) === n
  );
  if (!issue) {
    fail(
      `GraphQL: Could not resolve to an issue or pull request with the number of ${n}. (repository.issue)`,
    );
  }
  return issue;
}

function requireWrite(store: FakeStore, repo: string): void {
  const perm = store.viewerPermission[repo] ?? null;
  if (perm !== "WRITE" && perm !== "MAINTAIN" && perm !== "ADMIN") {
    fail(`HTTP 403: Resource not accessible by integration (${repo})`);
  }
}

/** The phrase of a `"<phrase>" in:title` query; any other query is refused. */
function titlePhrase(query: string): string[] {
  const match = /^"([^"]*)" in:title$/.exec(query);
  if (!match) fail(`Invalid search query "${query}".`);
  return words(match[1] ?? "");
}

function search(store: FakeStore, args: string[]): string {
  const { positional, flags } = flagsOf(args, 2, new Set(["--include-prs"]));
  const query = positional[0] ?? "";
  const repo = requireRepo(store, one(flags, "--repo"));
  const phrase = titlePhrase(query);
  const state = one(flags, "--state");
  const closed = one(flags, "--closed");
  const since = closed === undefined
    ? undefined
    : /^>=(\d{4}-\d{2}-\d{2})$/.exec(closed)?.[1] ??
      fail(`invalid --closed ${closed}`);
  const includePrs = flags.has("--include-prs");
  const hits = store.issues.filter((it) =>
    it.repo === repo &&
    (includePrs || !it.isPullRequest) &&
    containsPhrase(it.title, phrase) &&
    (state !== "open" || it.closedAt === null) &&
    (state !== "closed" || it.closedAt !== null) &&
    (since === undefined ||
      (it.closedAt !== null && it.closedAt.slice(0, 10) >= since))
  );
  return JSON.stringify(
    hits.map((it) => ({
      number: it.number,
      title: it.title,
      closedAt: it.closedAt,
    })),
  );
}

/** Every JSON field of an issue, as `gh --json` names them. */
function issueFields(issue: FakeIssue): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.closedAt === null ? "OPEN" : "CLOSED",
    url: `https://github.com/${issue.repo}/issues/${issue.number}`,
    author: { login: issue.author },
    comments: issue.comments.map((body) => ({ body })),
  };
}

/** The fields a `--json` list names, refusing an unmodelled one. */
function pick(
  all: Record<string, unknown>,
  json: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of json.split(",")) {
    if (!Object.hasOwn(all, field)) fail(`Unknown JSON field: "${field}"`);
    out[field] = all[field];
  }
  return out;
}

function issueView(store: FakeStore, args: string[]): string {
  const { positional, flags } = flagsOf(args, 2, new Set());
  const repo = requireRepo(store, one(flags, "--repo"));
  const issue = findIssue(store, repo, positional[0] ?? "");
  return JSON.stringify(pick(issueFields(issue), one(flags, "--json") ?? ""));
}

/** `gh issue list --state open [--search] --json … --limit N`, open issues only. */
function issueList(store: FakeStore, args: string[]): string {
  const { positional, flags } = flagsOf(args, 2, new Set());
  if (positional.length > 0) {
    fail(`unmodelled issue list argument ${positional[0]}`);
  }
  const repo = requireRepo(store, one(flags, "--repo"));
  if (one(flags, "--state") !== "open") {
    fail("fake gh models only `issue list --state open`");
  }
  const search = one(flags, "--search");
  const phrase = search === undefined ? null : titlePhrase(search);
  const limit = Number(one(flags, "--limit") ?? "30");
  const hits = store.issues.filter((it) =>
    it.repo === repo &&
    !it.isPullRequest &&
    it.closedAt === null &&
    (phrase === null || containsPhrase(it.title, phrase))
  ).slice(0, limit);
  const json = one(flags, "--json") ?? "";
  return JSON.stringify(hits.map((it) => pick(issueFields(it), json)));
}

function issueWrite(store: FakeStore, args: string[], hooks: FakeGhHooks) {
  const verb = args[1];
  const { positional, flags } = flagsOf(args, 2, new Set());
  const repo = requireRepo(store, one(flags, "--repo"));
  requireWrite(store, repo);
  if (verb === "create") {
    const title = one(flags, "--title") ?? fail("--title required");
    hooks.beforeCreate?.(store, args);
    const issue = addIssue(store, repo, title, one(flags, "--body") ?? "");
    issue.labels = flags.get("--label") ?? [];
    return `https://github.com/${repo}/issues/${issue.number}\n`;
  }
  const issue = findIssue(store, repo, positional[0] ?? "");
  if (verb === "comment") {
    issue.comments.push(one(flags, "--body") ?? fail("--body required"));
    return `https://github.com/${repo}/issues/${issue.number}#issuecomment-1\n`;
  }
  if (verb === "close") {
    if (issue.closedAt !== null) return "";
    const comment = one(flags, "--comment");
    if (comment !== undefined) issue.comments.push(comment);
    issue.closedAt = store.now;
    issue.stateReason = one(flags, "--reason");
    return "";
  }
  if (verb === "edit") {
    issue.body = one(flags, "--body") ?? fail("--body required");
    return `https://github.com/${repo}/issues/${issue.number}\n`;
  }
  return fail(`unmodelled issue verb ${verb}`);
}

/** A fake `gh` over `store`. */
export function routingFakeGh(
  store: FakeStore,
  hooks: FakeGhHooks = {},
): FakeGh {
  const calls: string[][] = [];
  const ghCommandFn: GhCommandFn = async (args) => {
    calls.push([...args]);
    const failure = hooks.failWhen?.(args);
    if (failure) throw failure;
    if (args[0] === "search" && args[1] === "issues") {
      return search(store, args);
    }
    if (args[0] === "repo" && args[1] === "view") {
      const repo = requireRepo(store, args[2]);
      return JSON.stringify({
        viewerPermission: store.viewerPermission[repo] ?? null,
      });
    }
    if (args[0] === "issue" && args[1] === "view") {
      return issueView(store, args);
    }
    if (args[0] === "issue" && args[1] === "list") {
      return issueList(store, args);
    }
    if (args[0] === "issue" && WRITE_VERBS.has(args[1] ?? "")) {
      return issueWrite(store, args, hooks);
    }
    return fail(`fake gh: unmodelled command: gh ${args.join(" ")}`);
  };
  return { ghCommandFn, calls, store };
}
