/**
 * Tests for the GitHub context layer for issue routing (Issue #3742, part of
 * #3691). The fake `gh` models the real CLI over an in-memory store, so the
 * tests assert what the worker decides (returned numbers, rejections, whether
 * a write was attempted), not the request text it sent. No network, no real
 * clock. Australian English spelling used throughout.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  type GhCommandFn,
  IssueRoutingPermissionError,
  normaliseRoutingTitle,
  requireWriteAccess,
} from "../lib/issue_routing_github.ts";
import { assertLinearGrowth } from "./support/growth.ts";

const REPO = "stSoftwareAU/VibeCoder";
const MISSING_REPO = "stSoftwareAU/NoSuchRepoZZ";

/**
 * The fake is built from observed gh output:
 * - `gh search issues ... --json number,title,state,closedAt,isPullRequest`
 *   returned `[{"closedAt":"2026-10-14T23:56:03Z","isPullRequest":true,
 *   "number":3762,"state":"merged","title":"feat(routing): pure issue-routing
 *   classifier with deterministic fixtures (#3741)"}]`, and a phrase search
 *   matched that punctuated title from its words.
 * - A search of a missing repository failed with `Invalid search query` and
 *   "cannot be searched either because the resources do not exist".
 * - `gh repo view R --json viewerPermission` returned `{"viewerPermission":"WRITE"}`
 *   (and "READ" on a public repository); a missing repository failed with
 *   "Could not resolve to a Repository with the name".
 */

const UNSEARCHABLE_MESSAGE =
  "The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them.";

interface StoredItem {
  repo: string;
  number: number;
  title: string;
  closedAt: string | null;
  isPullRequest: boolean;
  merged?: boolean;
}

interface Store {
  items: StoredItem[];
  viewerPermission: Record<string, string | null>;
}

interface FakeGh {
  ghCommandFn: GhCommandFn;
  calls: string[][];
}

function storeOf(
  items: StoredItem[] = [],
  viewerPermission: Record<string, string | null> = { [REPO]: "WRITE" },
): Store {
  return { items, viewerPermission };
}

/** Words of a phrase or title, folded the way gh tokenises them. */
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

const SEARCH_VALUE_FLAGS = new Set([
  "--repo",
  "--json",
  "--limit",
  "--state",
  "--closed",
]);

/** Answers `gh search issues`, modelling the phrase, state and day-granular rules. */
function searchIssues(store: Store, args: string[]): string {
  // args[0] is "issues"; args[1] is the query; flags follow.
  const query = args[1] ?? "";
  const flags = new Map<string, string>();
  let includePrs = false;
  for (let i = 2; i < args.length; i++) {
    const flag = args[i] ?? "";
    const value = args[i + 1];
    if (flag === "--include-prs") {
      includePrs = true;
    } else if (SEARCH_VALUE_FLAGS.has(flag) && value !== undefined) {
      flags.set(flag, value);
      i++;
    } else {
      throw new Error(`gh command failed (exit 1): unknown flag ${flag}`);
    }
  }
  const repo = flags.get("--repo") ?? "";
  if (!Object.hasOwn(store.viewerPermission, repo)) {
    throw new Error(
      `gh command failed (exit 1): Invalid search query "${query}".\n${UNSEARCHABLE_MESSAGE}`,
    );
  }
  const match = /^"([^"]*)" in:title$/.exec(query);
  if (!match) {
    throw new Error(
      `gh command failed (exit 1): Invalid search query "${query}".`,
    );
  }
  const phrase = words(match[1] ?? "");
  const state = flags.get("--state");
  if (state !== undefined && state !== "open" && state !== "closed") {
    throw new Error(`gh command failed (exit 1): invalid --state ${state}`);
  }
  let since: string | undefined;
  const closedQualifier = flags.get("--closed");
  if (closedQualifier !== undefined) {
    const m = /^>=(\d{4}-\d{2}-\d{2})$/.exec(closedQualifier);
    if (!m) {
      throw new Error(
        `gh command failed (exit 1): invalid --closed ${closedQualifier}`,
      );
    }
    since = m[1];
  }
  const limit = Number(flags.get("--limit"));
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("gh command failed (exit 1): invalid --limit");
  }
  const fields = (flags.get("--json") ?? "").split(",");

  const hits = store.items.filter((it) => {
    if (it.repo !== repo) return false;
    // Pull requests are only searched when asked for.
    if (it.isPullRequest && !includePrs) return false;
    if (!containsPhrase(it.title, phrase)) return false;
    if (state === "open" && it.closedAt !== null) return false;
    if (state === "closed" && it.closedAt === null) return false;
    // --closed is day-granular: it compares the UTC calendar date.
    if (since !== undefined) {
      if (it.closedAt === null || it.closedAt.slice(0, 10) < since) {
        return false;
      }
    }
    return true;
  }).slice(0, limit);

  return JSON.stringify(hits.map((it) => projectFields(it, fields)));
}

function projectFields(
  it: StoredItem,
  fields: string[],
): Record<string, unknown> {
  const all: Record<string, unknown> = {
    number: it.number,
    title: it.title,
    closedAt: it.closedAt,
    state: it.merged ? "merged" : it.closedAt === null ? "open" : "closed",
    isPullRequest: it.isPullRequest,
  };
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (!Object.hasOwn(all, field)) {
      throw new Error(`gh command failed (exit 1): unknown field ${field}`);
    }
    out[field] = all[field];
  }
  return out;
}

/** Answers `gh repo view R --json viewerPermission`. */
function repoView(store: Store, args: string[]): string {
  const repo = args[0] ?? "";
  if (
    args.length !== 3 || args[1] !== "--json" || args[2] !== "viewerPermission"
  ) {
    throw new Error("gh command failed (exit 1): unmodelled repo view flags");
  }
  if (!Object.hasOwn(store.viewerPermission, repo)) {
    throw new Error(
      `gh command failed (exit 1): GraphQL: Could not resolve to a Repository with the name '${repo}'. (repository)`,
    );
  }
  return JSON.stringify({
    viewerPermission: store.viewerPermission[repo] ?? null,
  });
}

/**
 * A fake `gh` over the store. It records every call and can be told to fail
 * particular calls through `failWhen`. Anything it does not model throws.
 */
function fakeGh(
  store: Store,
  failWhen?: (args: string[]) => Error | undefined,
): FakeGh {
  const calls: string[][] = [];
  const ghCommandFn: GhCommandFn = async (args) => {
    calls.push([...args]);
    const failure = failWhen?.(args);
    if (failure) throw failure;
    if (args[0] === "search" && args[1] === "issues") {
      return searchIssues(store, args.slice(1));
    }
    if (args[0] === "repo" && args[1] === "view") {
      return repoView(store, args.slice(2));
    }
    if (args[0] === "issue" && args[1] === "create") {
      return "https://github.com/stSoftwareAU/VibeCoder/issues/1";
    }
    throw new Error(`fake gh: unmodelled command: gh ${args.join(" ")}`);
  };
  return { ghCommandFn, calls };
}

/**
 * A raw fake for malformed output only: it answers with whatever `handler`
 * returns, to model a broken gh. Used for the malformed-response cases.
 */
function rawGh(handler: (args: string[]) => string): GhCommandFn {
  return async (args) => handler(args);
}

Deno.test("issue_routing_github - WRITE, MAINTAIN and ADMIN pass the write-access check", async () => {
  for (const permission of ["WRITE", "MAINTAIN", "ADMIN"]) {
    const gh = fakeGh(storeOf([], { [REPO]: permission }));
    await requireWriteAccess(REPO, { ghCommandFn: gh.ghCommandFn });
  }
});

Deno.test("issue_routing_github - READ and TRIAGE are refused with IssueRoutingPermissionError", async () => {
  for (const permission of ["READ", "TRIAGE"]) {
    const gh = fakeGh(storeOf([], { [REPO]: permission }));
    const err = await assertRejects(
      () => requireWriteAccess(REPO, { ghCommandFn: gh.ghCommandFn }),
      IssueRoutingPermissionError,
      "needs write access",
    );
    assertEquals(err.repository, REPO);
    assertEquals(err.permission, permission);
    assertStringIncludes(err.message, REPO);
    assertStringIncludes(err.message, permission);
  }
});

Deno.test("issue_routing_github - a null viewerPermission is reported as none", async () => {
  const gh = fakeGh(storeOf([], { [REPO]: null }));
  const err = await assertRejects(
    () => requireWriteAccess(REPO, { ghCommandFn: gh.ghCommandFn }),
    IssueRoutingPermissionError,
  );
  assertEquals(err.permission, "none");
});

Deno.test("issue_routing_github - read-only access attempts no issue create, write access does", async () => {
  // Stands in for a caller that checks access, then files an issue.
  const fileIfAllowed = async (gh: GhCommandFn) => {
    await requireWriteAccess(REPO, { ghCommandFn: gh });
    await gh([
      "issue",
      "create",
      "--repo",
      REPO,
      "--title",
      "t",
      "--body",
      "b",
    ]);
  };
  const isCreate = (c: string[]) => c[0] === "issue" && c[1] === "create";

  const readOnly = fakeGh(storeOf([], { [REPO]: "READ" }));
  await assertRejects(
    () => fileIfAllowed(readOnly.ghCommandFn),
    IssueRoutingPermissionError,
  );
  assertEquals(readOnly.calls.filter(isCreate).length, 0);

  // Positive control: with WRITE the create is attempted.
  const writer = fakeGh(storeOf([], { [REPO]: "WRITE" }));
  await fileIfAllowed(writer.ghCommandFn);
  assertEquals(writer.calls.filter(isCreate).length, 1);
});

Deno.test("issue_routing_github - a repository that does not exist fails the check with a plain Error", async () => {
  const gh = fakeGh(storeOf());
  const err = await assertRejects(
    () => requireWriteAccess(MISSING_REPO, { ghCommandFn: gh.ghCommandFn }),
    Error,
    "Could not resolve to a Repository",
  );
  assert(
    !(err instanceof IssueRoutingPermissionError),
    "a failed check must not look like a permission refusal",
  );
});

Deno.test("issue_routing_github - malformed write-access output is refused, and an invalid slug makes no call", async () => {
  for (const body of ["not json", "[]"]) {
    const gh = rawGh(() => body);
    await assertRejects(
      () => requireWriteAccess(REPO, { ghCommandFn: gh }),
      Error,
      REPO,
      body,
    );
  }

  const gh = fakeGh(storeOf());
  await assertRejects(
    () => requireWriteAccess("../x", { ghCommandFn: gh.ghCommandFn }),
    Error,
    "invalid repository",
  );
  assertEquals(gh.calls.length, 0);
});

Deno.test("issue_routing_github - non-object write-access output is refused as unexpected, not as a permission refusal", async () => {
  for (const body of ["[]", "null", "42"]) {
    const gh = rawGh(() => body);
    const err = await assertRejects(
      () => requireWriteAccess(REPO, { ghCommandFn: gh }),
      Error,
      "unexpected response",
      body,
    );
    assert(
      !(err instanceof IssueRoutingPermissionError),
      `${body} was read as a permission refusal`,
    );
  }
});

Deno.test("issue_routing_github - the title normaliser stays linear on hostile punctuation", () => {
  const folded = assertLinearGrowth(
    "normaliseRoutingTitle",
    (n) => " !".repeat(Math.floor(n / 2)) + "a",
    (input) => normaliseRoutingTitle(input),
    { baseChars: 20_000 },
  );
  assertEquals(folded, "a");
});
