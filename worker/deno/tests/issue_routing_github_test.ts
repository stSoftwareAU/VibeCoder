/**
 * Tests for the GitHub context layer for issue routing (Issue #3742, part of
 * #3691). Every `gh` call goes through a fake that records its arguments, so
 * no test touches the network or the clock. Australian English spelling used
 * throughout.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  findRoutingDuplicates,
  type GhCommandFn,
  IssueRoutingPermissionError,
  normaliseRoutingTitle,
  requireWriteAccess,
  ROUTING_DUPLICATE_SEARCH_LIMIT,
} from "../lib/issue_routing_github.ts";
import { assertLinearGrowth } from "./support/growth.ts";

const REPO = "stSoftwareAU/VibeCoder";
const NOW = () => new Date("2026-10-15T00:00:00Z");
const NO_SUCH_REPO_STDERR =
  "GraphQL: Could not resolve to a Repository with the name 'stSoftwareAU/NoSuchRepoZZ'. (repository)";
const MISSING_SEARCH_STDERR =
  'gh command failed (exit 1): Invalid search query "( x ) repo:stSoftwareAU/NoSuchRepoZZ".\n' +
  "The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them.";

type Handler = (args: string[]) => string;

interface FakeGh {
  ghCommandFn: GhCommandFn;
  calls: string[][];
}

/** A fake `gh` that records every args array and answers through `handler`. */
function fakeGh(handler: Handler): FakeGh {
  const calls: string[][] = [];
  const ghCommandFn: GhCommandFn = async (args) => {
    calls.push([...args]);
    return handler(args);
  };
  return { ghCommandFn, calls };
}

/** The `--state` value of a search call, or undefined for other calls. */
function stateOf(args: string[]): string | undefined {
  const i = args.indexOf("--state");
  return i === -1 ? undefined : args[i + 1];
}

function hit(
  number: number,
  title: string,
  state = "open",
  closedAt: string | null = null,
): Record<string, unknown> {
  return { number, title, state, closedAt };
}

/** A handler that answers the open search with `open` and the closed one with `closed`. */
function searchReplies(open: unknown, closed: unknown): Handler {
  return (args) => JSON.stringify(stateOf(args) === "open" ? open : closed);
}

function searchCalls(calls: string[][]): string[][] {
  return calls.filter((c) => c[0] === "search");
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function permissionHandler(permission: unknown): Handler {
  return (args) => {
    assertEquals(args[0], "repo");
    return JSON.stringify({ viewerPermission: permission });
  };
}

Deno.test("issue_routing_github - an open issue with a matching title is returned", async () => {
  const fake = fakeGh(
    searchReplies([hit(7, "Duplicate search for routing")], []),
  );
  const found = await findRoutingDuplicates(
    REPO,
    "Duplicate search for routing",
    {
      ghCommandFn: fake.ghCommandFn,
      now: NOW,
    },
  );
  assertEquals(found, [7]);
  const open = searchCalls(fake.calls).find((c) => stateOf(c) === "open");
  assert(open, "no open search recorded");
  assertEquals(open[open.indexOf("--state") + 1], "open");
  assertEquals(open[2], `"duplicate search for routing" in:title`);
});

Deno.test("issue_routing_github - an issue closed within 30 days is returned", async () => {
  const fake = fakeGh(
    searchReplies([], [
      hit(9, "Duplicate search for routing", "closed", "2026-10-01T00:00:00Z"),
    ]),
  );
  const found = await findRoutingDuplicates(
    REPO,
    "Duplicate search for routing",
    {
      ghCommandFn: fake.ghCommandFn,
      now: NOW,
    },
  );
  assertEquals(found, [9]);
  const closed = searchCalls(fake.calls).find((c) => stateOf(c) === "closed");
  assert(closed, "no closed search recorded");
  assertEquals(valueAfter(closed, "--closed"), ">=2026-09-15");
});

Deno.test("issue_routing_github - an issue closed more than 30 days ago is ignored", async () => {
  const fake = fakeGh(
    searchReplies([], [
      hit(20, "Duplicate search for routing", "closed", "2026-09-14T12:00:00Z"),
      hit(21, "Duplicate search for routing", "closed", "2026-09-15T00:00:00Z"),
    ]),
  );
  const found = await findRoutingDuplicates(
    REPO,
    "Duplicate search for routing",
    {
      ghCommandFn: fake.ghCommandFn,
      now: NOW,
    },
  );
  // 21 sits exactly on the cutoff, which counts as inside the window.
  assertEquals(found, [21]);
});

Deno.test("issue_routing_github - a merged PR with a matching title is returned", async () => {
  const fake = fakeGh(
    searchReplies([], [
      hit(
        3762,
        "FEAT(routing): Pure issue-routing classifier!",
        "merged",
        "2026-10-14T23:56:03Z",
      ),
    ]),
  );
  const found = await findRoutingDuplicates(
    REPO,
    "feat routing pure issue routing classifier",
    { ghCommandFn: fake.ghCommandFn, now: NOW },
  );
  assertEquals(found, [3762]);
  const searches = searchCalls(fake.calls);
  assertEquals(searches.length, 2);
  for (const call of searches) {
    assert(call.includes("--include-prs"), `missing --include-prs: ${call}`);
  }
});

Deno.test("issue_routing_github - titles match after case and punctuation are folded", async () => {
  const fake = fakeGh(
    searchReplies(
      [
        hit(1, "Fix: the Parser!"),
        hit(2, "FIX — THE PARSER"),
        hit(3, "Fix the parser and formatter"),
      ],
      [],
    ),
  );
  const found = await findRoutingDuplicates(REPO, "Fix the parser", {
    ghCommandFn: fake.ghCommandFn,
    now: NOW,
  });
  assertEquals(found, [1, 2]);
});

Deno.test("issue_routing_github - results are unique and sorted ascending", async () => {
  const fake = fakeGh(
    searchReplies(
      [hit(40, "Same title"), hit(3, "Same title")],
      [
        hit(12, "Same title", "closed", "2026-10-01T00:00:00Z"),
        hit(3, "Same title", "closed", "2026-10-01T00:00:00Z"),
      ],
    ),
  );
  const found = await findRoutingDuplicates(REPO, "Same title", {
    ghCommandFn: fake.ghCommandFn,
    now: NOW,
  });
  assertEquals(found, [3, 12, 40]);
});

Deno.test("issue_routing_github - a title cannot inject search qualifiers", async () => {
  const fake = fakeGh(searchReplies([], []));
  await findRoutingDuplicates(REPO, `foo" is:closed repo:other/x`, {
    ghCommandFn: fake.ghCommandFn,
    now: NOW,
  });
  for (const call of searchCalls(fake.calls)) {
    assertEquals(call[2], `"foo is closed repo other x" in:title`);
    assertEquals(valueAfter(call, "--repo"), REPO);
  }
});

Deno.test("issue_routing_github - a failed open search rejects and never returns an empty list", async () => {
  const fake = fakeGh((args) => {
    if (stateOf(args) === "open") throw new Error(MISSING_SEARCH_STDERR);
    return "[]";
  });
  const err = await assertRejects(
    () =>
      findRoutingDuplicates("stSoftwareAU/NoSuchRepoZZ", "Some title", {
        ghCommandFn: fake.ghCommandFn,
        now: NOW,
      }),
    Error,
    "cannot be searched either because the resources do not exist",
  );
  assertStringIncludes(err.message, "stSoftwareAU/NoSuchRepoZZ");
});

Deno.test("issue_routing_github - a failed closed search rejects with no partial list", async () => {
  const fake = fakeGh((args) => {
    if (stateOf(args) === "open") {
      return JSON.stringify([hit(1, "Same title")]);
    }
    throw new Error("gh command failed (exit 1): HTTP 502: boom");
  });
  const err = await assertRejects(
    () =>
      findRoutingDuplicates(REPO, "Same title", {
        ghCommandFn: fake.ghCommandFn,
        now: NOW,
      }),
    Error,
    "boom",
  );
  assertStringIncludes(err.message, REPO);
});

Deno.test("issue_routing_github - a malformed search response rejects", async () => {
  const cases: [string, unknown][] = [
    ["not an array", { number: 1 }],
    ["item missing number", [{
      title: "Same title",
      state: "open",
      closedAt: null,
    }]],
  ];
  for (const [label, body] of cases) {
    const fake = fakeGh(() => JSON.stringify(body));
    await assertRejects(
      () =>
        findRoutingDuplicates(REPO, "Same title", {
          ghCommandFn: fake.ghCommandFn,
          now: NOW,
        }),
      Error,
      "unexpected search response",
      label,
    );
  }
});

Deno.test("issue_routing_github - a closed hit with closedAt null rejects", async () => {
  const fake = fakeGh(
    searchReplies([], [hit(5, "Same title", "closed", null)]),
  );
  await assertRejects(
    () =>
      findRoutingDuplicates(REPO, "Same title", {
        ghCommandFn: fake.ghCommandFn,
        now: NOW,
      }),
    Error,
    "closedAt",
  );
});

Deno.test("issue_routing_github - a search at the result limit rejects, one below it resolves", async () => {
  const full = Array.from(
    { length: ROUTING_DUPLICATE_SEARCH_LIMIT },
    (_, i) => hit(i + 1, "Same title"),
  );
  const atLimit = fakeGh(searchReplies(full, []));
  await assertRejects(
    () =>
      findRoutingDuplicates(REPO, "Same title", {
        ghCommandFn: atLimit.ghCommandFn,
        now: NOW,
      }),
    Error,
    "would be missed",
  );

  // Positive control: one hit below the limit, none matching, is a clean empty result.
  const below = Array.from(
    { length: ROUTING_DUPLICATE_SEARCH_LIMIT - 1 },
    (_, i) => hit(i + 1, `unrelated ${i}`),
  );
  const belowFake = fakeGh(searchReplies(below, []));
  const found = await findRoutingDuplicates(REPO, "Same title", {
    ghCommandFn: belowFake.ghCommandFn,
    now: NOW,
  });
  assertEquals(found, []);
});

Deno.test("issue_routing_github - an invalid slug or an empty title is refused before any gh call", async () => {
  for (const repo of ["../x", "noslash"]) {
    const fake = fakeGh(() => "[]");
    await assertRejects(
      () =>
        findRoutingDuplicates(repo, "Same title", {
          ghCommandFn: fake.ghCommandFn,
          now: NOW,
        }),
      Error,
      "invalid repository",
    );
    assertEquals(fake.calls.length, 0, `gh called for ${repo}`);
  }

  const fake = fakeGh(() => "[]");
  await assertRejects(
    () =>
      findRoutingDuplicates(REPO, "!!! ", {
        ghCommandFn: fake.ghCommandFn,
        now: NOW,
      }),
    Error,
    "empty after normalisation",
  );
  assertEquals(fake.calls.length, 0);
});

Deno.test("issue_routing_github - WRITE, MAINTAIN and ADMIN pass the write-access check", async () => {
  for (const permission of ["WRITE", "MAINTAIN", "ADMIN"]) {
    const fake = fakeGh(permissionHandler(permission));
    await requireWriteAccess(REPO, { ghCommandFn: fake.ghCommandFn });
    assertEquals(fake.calls, [
      ["repo", "view", REPO, "--json", "viewerPermission"],
    ]);
  }
});

Deno.test("issue_routing_github - READ and TRIAGE are refused with IssueRoutingPermissionError", async () => {
  for (const permission of ["READ", "TRIAGE"]) {
    const fake = fakeGh(permissionHandler(permission));
    const err = await assertRejects(
      () => requireWriteAccess(REPO, { ghCommandFn: fake.ghCommandFn }),
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
  const fake = fakeGh(permissionHandler(null));
  const err = await assertRejects(
    () => requireWriteAccess(REPO, { ghCommandFn: fake.ghCommandFn }),
    IssueRoutingPermissionError,
  );
  assertEquals(err.permission, "none");
});

Deno.test("issue_routing_github - read-only access makes no write call", async () => {
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

  const readOnly = fakeGh(permissionHandler("READ"));
  await assertRejects(
    () => fileIfAllowed(readOnly.ghCommandFn),
    IssueRoutingPermissionError,
  );
  assert(
    !readOnly.calls.some((c) => c.includes("create")),
    "a create call was made with READ access",
  );

  // Positive control: with WRITE the create call is made.
  const writer = fakeGh((args) =>
    args[0] === "repo"
      ? JSON.stringify({ viewerPermission: "WRITE" })
      : "https://github.com/stSoftwareAU/VibeCoder/issues/1"
  );
  await fileIfAllowed(writer.ghCommandFn);
  assert(
    writer.calls.some((c) => c.includes("create")),
    "the create call was not made with WRITE access",
  );
});

Deno.test("issue_routing_github - a failed write-access check is a plain Error, not a permission refusal", async () => {
  const repo = "stSoftwareAU/NoSuchRepoZZ";
  const fake = fakeGh(() => {
    throw new Error(`gh command failed (exit 1): ${NO_SUCH_REPO_STDERR}`);
  });
  const err = await assertRejects(
    () => requireWriteAccess(repo, { ghCommandFn: fake.ghCommandFn }),
    Error,
    "Could not resolve to a Repository",
  );
  assert(
    !(err instanceof IssueRoutingPermissionError),
    "a failed check must not look like a permission refusal",
  );
  assertStringIncludes(err.message, NO_SUCH_REPO_STDERR);
});

Deno.test("issue_routing_github - malformed write-access responses and invalid slugs are refused", async () => {
  for (const body of ["not json", "[]"]) {
    const fake = fakeGh(() => body);
    await assertRejects(
      () => requireWriteAccess(REPO, { ghCommandFn: fake.ghCommandFn }),
      Error,
      REPO,
      body,
    );
  }

  const fake = fakeGh(() => "{}");
  await assertRejects(
    () => requireWriteAccess("../x", { ghCommandFn: fake.ghCommandFn }),
    Error,
    "invalid repository",
  );
  assertEquals(fake.calls.length, 0);
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
