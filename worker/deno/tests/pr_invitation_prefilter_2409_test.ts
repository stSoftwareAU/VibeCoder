/**
 * The invited-human-PR lookup asks GitHub only about humans who have an open
 * PR (Issue #2409).
 *
 * Live measurement, 2026-09-20: `pr list --author --json --repo --state` with
 * no `--limit` ran 40 times on every cache-expiry cycle of a 20-repository
 * host — one listing per trusted human per repository — to learn, nearly every
 * time, that the human has no open PR there. The cycle already holds the
 * repository's whole open-PR listing with each PR's author, so that answer is
 * known before the call is made.
 *
 * The listing is only ever used to **skip**. Whenever it cannot prove the human
 * has no open PR — it is absent, it may be truncated, or a row's author is
 * unknown — the lookup asks GitHub exactly as before.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import { listInvitedHumanPrs } from "../lib/pr_invitation_lookup.ts";

const REPO = "o/r-2409";
const HOST = "fleet-host";
const SIBLING = "fleet-sibling";
const ALICE = "alice";
const BOB = "bob";

/** A fake `gh`: Alice has one labelled open PR, everyone else has none. */
function fakeGh(calls: string[][]) {
  return (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      const author = args[args.indexOf("--author") + 1];
      if (author !== ALICE) return Promise.resolve("[]");
      return Promise.resolve(JSON.stringify([{
        number: 7,
        headRefName: "alice/fix",
        author: { login: ALICE },
        labels: [{ name: "work-on" }],
        comments: [],
        reviews: [],
      }]));
    }
    if (args.join(" ").includes("timeline")) {
      return Promise.resolve(JSON.stringify([{
        event: "labeled",
        label: { name: "work-on" },
        actor: { login: ALICE },
        created_at: "2026-09-01T00:00:00Z",
      }]));
    }
    return Promise.resolve("[]");
  };
}

/** Authors asked about, in call order. */
function authorsListed(calls: string[][]): string[] {
  return calls
    .filter((c) => c[0] === "pr" && c[1] === "list")
    .map((c) => c[c.indexOf("--author") + 1]!);
}

async function withCache<T>(
  openAll: unknown[] | undefined,
  body: (cache: IssueCache) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "invite-prefilter-2409-" });
  try {
    const cache = new IssueCache(dir);
    if (openAll !== undefined) await cache.write(REPO, "prs_open_all", openAll);
    return await body(cache);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function lookup(cache: IssueCache, calls: string[][]) {
  return listInvitedHumanPrs<{ number: number }>({
    repo: REPO,
    githubUser: HOST,
    allowedAuthors: [ALICE, BOB, SIBLING],
    fleetPrAuthors: [SIBLING],
    fields: "number,headRefName",
    ghCommandFn: fakeGh(calls),
    cache,
  });
}

Deno.test("invitation lookup - a human with no open PR in the repository is not asked about (Issue #2409)", async () => {
  const calls: string[][] = [];
  const admitted = await withCache(
    [{ number: 7, authorLogin: ALICE }, { number: 8, authorLogin: SIBLING }],
    (cache) => lookup(cache, calls),
  );
  assertEquals(authorsListed(calls), [ALICE], "Bob has no open PR here");
  assertEquals(admitted.map((pr) => pr.number), [7], "Alice's PR still admits");
});

Deno.test("invitation lookup - a repository with no human PR at all costs no listing (Issue #2409)", async () => {
  const calls: string[][] = [];
  const admitted = await withCache(
    [{ number: 8, authorLogin: SIBLING }],
    (cache) => lookup(cache, calls),
  );
  assertEquals(authorsListed(calls), []);
  assertEquals(admitted, []);
});

Deno.test("invitation lookup - the author match ignores case, as GitHub logins do (Issue #2409)", async () => {
  const calls: string[][] = [];
  await withCache(
    [{ number: 7, authorLogin: "Alice" }],
    (cache) => lookup(cache, calls),
  );
  assertEquals(authorsListed(calls), [ALICE]);
});

Deno.test("invitation lookup - whenever the listing cannot prove absence, every human is asked about (Issue #2409)", async () => {
  const unproven: Array<[string, unknown[] | undefined]> = [
    ["no open-PR listing is held", undefined],
    ["a row's author is unknown", [{ number: 9 }]],
    [
      "the listing may be truncated",
      Array.from({ length: 50 }, (_, i) => ({
        number: 100 + i,
        authorLogin: SIBLING,
      })),
    ],
    ["the cached value is not a listing", [null, 3]],
  ];
  for (const [why, openAll] of unproven) {
    const calls: string[][] = [];
    const admitted = await withCache(openAll, (cache) => lookup(cache, calls));
    assertEquals(authorsListed(calls).sort(), [ALICE, BOB], why);
    assertEquals(admitted.map((pr) => pr.number), [7], why);
  }
});
