/**
 * Tests for derived_authors.ts (Issue #254, parent #234).
 *
 * Combines collaborator fetch and exclusion sources into one all-or-nothing
 * per-cycle resolver. Tests inject `gh` via `_setGhSpawnRunner` and call
 * the real `resolveDerivedAuthors` — no source-grep, no reimplementation
 * of the sibling fetchers.
 *
 * Australian English throughout (authorised, behaviour, normalise).
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  type GhSpawnResult,
} from "../lib/gh_spawn.ts";
import {
  _resetDerivedAuthorsCache,
  type DerivedAuthorsDeps,
  type DerivedAuthorsResult,
  resolveDerivedAuthors,
} from "../lib/derived_authors.ts";

const REPO_A = "owner/alpha";
const REPO_B = "owner/beta";
const TEAM_SLUG = "stSoftwareAU/vibe-workers";
const TEAM_PATH = "orgs/stSoftwareAU/teams/vibe-workers/members?per_page=100";

const HOST = "host-bot";

/** GitHub REST collaborator entry — role is driven by `permissions` only. */
function rawCollaborator(
  login: string,
  permissions: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    triage?: boolean;
    pull?: boolean;
  },
): Record<string, unknown> {
  return {
    login,
    permissions: {
      admin: permissions.admin ?? false,
      maintain: permissions.maintain ?? false,
      push: permissions.push ?? false,
      triage: permissions.triage ?? false,
      pull: permissions.pull ?? false,
    },
  };
}

function member(login: string): Record<string, unknown> {
  return { login, id: login.length };
}

function ok(stdout: string): GhSpawnResult {
  return { code: 0, success: true, stdout, stderr: "" };
}

function fail(stderr: string, code = 1): GhSpawnResult {
  return { code, success: false, stdout: "", stderr };
}

function restore(): void {
  _resetGhSpawnRunner();
  _resetDerivedAuthorsCache();
}

/**
 * Route `gh api` calls to collaborator or team payloads by path.
 * Records every spawn so call-count tests can assert team-once / cache.
 */
function installRouter(options: {
  collaborators: Record<string, GhSpawnResult | (() => GhSpawnResult)>;
  team?: GhSpawnResult | (() => GhSpawnResult);
}): { calls: string[][] } {
  const calls: string[][] = [];
  _setGhSpawnRunner((args) => {
    calls.push([...args]);
    const path = args.find((a) =>
      a.startsWith("repos/") || a.startsWith("orgs/")
    ) ?? "";
    if (path.includes("/collaborators")) {
      for (const [repo, result] of Object.entries(options.collaborators)) {
        if (path.includes(`repos/${repo}/collaborators`)) {
          return Promise.resolve(
            typeof result === "function" ? result() : result,
          );
        }
      }
      return Promise.resolve(
        fail(`unexpected collaborators path: ${path}`),
      );
    }
    if (path.includes("/teams/") && path.includes("/members")) {
      if (!options.team) {
        return Promise.resolve(fail(`unexpected team fetch: ${path}`));
      }
      return Promise.resolve(
        typeof options.team === "function" ? options.team() : options.team,
      );
    }
    return Promise.resolve(fail(`unexpected gh path: ${path}`));
  });
  return { calls };
}

function assertSuccess(
  result: DerivedAuthorsResult,
): Extract<DerivedAuthorsResult, { ok: true }> {
  assertEquals(
    result.ok,
    true,
    `expected success, got ${JSON.stringify(result)}`,
  );
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function assertFailure(
  result: DerivedAuthorsResult,
): Extract<DerivedAuthorsResult, { ok: false }> {
  assertEquals(result.ok, false, "expected fail-closed result");
  if (result.ok) throw new Error("unreachable");
  assertEquals(
    "byRepo" in result,
    false,
    "failure must not carry a partial byRepo map",
  );
  return result;
}

/**
 * Assert the *directing* set (axis 1) exactly, and that every one of its
 * members also carries input trust (Issue #1066).
 *
 * The two axes are no longer the same list: `authorisedCommenters` is axis 1
 * plus the known logins — the Vibe Coders and the operator's
 * `authorized_commenters` bots — so it is a superset by construction.
 */
function assertSameSet(
  authors: { allowedAuthors: string[]; authorisedCommenters: string[] },
  expected: string[],
): void {
  assertEquals(authors.allowedAuthors, expected);
  for (const login of expected) {
    assert(
      authors.authorisedCommenters.includes(login),
      `${login} may direct work, so its input must be accepted too`,
    );
  }
}

Deno.test("resolveDerivedAuthors - the input axis adds the Vibe Coders and the known bots (Issue #1066)", async () => {
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
        rawCollaborator("stsvcbot", { push: true }),
      ])),
    },
  });
  const result = assertSuccess(
    await resolve({
      cycleId: 1066.1,
      serviceAccounts: ["stsvcbot"],
      fleetPrAuthors: ["SiblingBot"],
      knownInputLogins: ["github-copilot[bot]"],
    }),
  );
  const authors = result.byRepo.get(REPO_A)!;
  // A Vibe Coder holds write access and is still refused the directing axis.
  assertEquals(authors.allowedAuthors, ["alice"]);
  // …and is accepted on the input axis, alongside the named bot.
  assertEquals(authors.authorisedCommenters, [
    "alice",
    "host-bot",
    "stsvcbot",
    "siblingbot",
    "github-copilot[bot]",
  ]);
});

Deno.test("resolveDerivedAuthors - an empty Vibe Coder login set fails closed (Issue #1066)", async () => {
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([rawCollaborator("Alice", { push: true })])),
    },
  });
  const result = await resolve({
    cycleId: 1066.2,
    githubUser: "",
    serviceAccounts: [],
    fleetPrAuthors: [],
  });
  assertEquals(result.ok, false, "nothing to subtract must not resolve");
  if (result.ok) throw new Error("unreachable");
  assertEquals(result.failedSource, "vibe-coder-logins");
});

function resolve(
  overrides: {
    repos?: readonly string[];
    serviceAccounts?: readonly string[];
    fleetPrAuthors?: readonly string[];
    knownInputLogins?: readonly string[];
    githubUser?: string;
    exclusionTeamSlug?: string;
    cycleId?: unknown;
    log?: (message: string) => void;
  } = {},
  deps: Partial<DerivedAuthorsDeps> = {},
): Promise<DerivedAuthorsResult> {
  return resolveDerivedAuthors(
    {
      repos: overrides.repos ?? [REPO_A],
      serviceAccounts: overrides.serviceAccounts ?? [],
      fleetPrAuthors: overrides.fleetPrAuthors ?? [],
      knownInputLogins: overrides.knownInputLogins ?? [],
      githubUser: overrides.githubUser ?? HOST,
      exclusionTeamSlug: overrides.exclusionTeamSlug,
    },
    {
      cycleId: deps.cycleId ?? overrides.cycleId ?? 1,
      log: deps.log ?? overrides.log,
      ...deps,
    },
  );
}

Deno.test("resolveDerivedAuthors - exclusion removes a write collaborator from both lists", async () => {
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
        rawCollaborator("Mallory", { push: true }),
      ])),
    },
  });
  try {
    const result = assertSuccess(
      await resolve({ serviceAccounts: ["mallory"] }),
    );
    const authors = result.byRepo.get(REPO_A);
    assert(authors, `expected an entry for ${REPO_A}`);
    assertSameSet(authors, ["alice"]);
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - a service account with write access is excluded", async () => {
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
        rawCollaborator("STSvcBot", { push: true, pull: true }),
      ])),
    },
  });
  try {
    const result = assertSuccess(
      await resolve({ serviceAccounts: ["stsvcbot"] }),
    );
    const authors = result.byRepo.get(REPO_A);
    assert(authors, `expected an entry for ${REPO_A}`);
    assertSameSet(authors, ["alice"]);
    assertEquals(authors.allowedAuthors.includes("stsvcbot"), false);
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - a [bot] collaborator is excluded", async () => {
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { maintain: true, push: true }),
        rawCollaborator("dependabot[bot]", { push: true, pull: true }),
      ])),
    },
  });
  try {
    const result = assertSuccess(await resolve());
    const authors = result.byRepo.get(REPO_A);
    assert(authors, `expected an entry for ${REPO_A}`);
    assertSameSet(authors, ["alice"]);
    assertEquals(authors.allowedAuthors.includes("dependabot[bot]"), false);
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - a team member with admin access is excluded", async () => {
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
        rawCollaborator("TeamAdmin", {
          admin: true,
          maintain: true,
          push: true,
        }),
      ])),
    },
    team: ok(JSON.stringify([member("TeamAdmin")])),
  });
  try {
    const result = assertSuccess(
      await resolve({ exclusionTeamSlug: TEAM_SLUG }),
    );
    const authors = result.byRepo.get(REPO_A);
    assert(authors, `expected an entry for ${REPO_A}`);
    assertSameSet(authors, ["alice"]);
    assertEquals(authors.allowedAuthors.includes("teamadmin"), false);
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - one repo failing transiently fails the whole resolve", async () => {
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
      ])),
      [REPO_B]: fail("gh: connect: network is unreachable", 1),
    },
  });
  try {
    const result = assertFailure(
      await resolve({ repos: [REPO_A, REPO_B] }),
    );
    assertEquals(result.failedSource, REPO_B);
    assertEquals(result.transient, true, "a network fault may clear");
    assert(
      result.reason.length > 0,
      "failure must name a reason",
    );
  } finally {
    restore();
  }
});

// ── Issue #1453: a repo this login cannot list is skipped, not fatal ──────

Deno.test("resolveDerivedAuthors - a repo the login cannot list (403 push access) is skipped and named once (Issue #1453)", async () => {
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
      ])),
      [REPO_B]: fail(
        "gh: Must have push access to view repository collaborators. (HTTP 403)",
      ),
    },
  });
  const warnings: string[] = [];
  try {
    const result = assertSuccess(
      await resolve({ repos: [REPO_A, REPO_B] }, {
        cycleId: "c1",
        warn: (m) => warnings.push(m),
      }),
    );
    assertEquals(
      [...result.byRepo.keys()],
      [REPO_A],
      "beta is left out of the fold",
    );
    assertEquals((result.skippedRepos ?? []).map((s) => s.repo), [REPO_B]);
    assert(
      (result.skippedRepos ?? [])[0]!.detail.includes("push access"),
      "GitHub's own words are kept",
    );
    assertEquals(warnings.length, 1, "the skip is said once");
    assert(warnings[0]!.includes(REPO_B), warnings[0]);
    assert(warnings[0]!.includes("not a trust source"), warnings[0]);
    assert(warnings[0]!.includes(HOST), "the login is named");

    // A second cycle with the same skipped set says nothing new.
    assertSuccess(
      await resolve({ repos: [REPO_A, REPO_B] }, {
        cycleId: "c2",
        warn: (m) => warnings.push(m),
      }),
    );
    assertEquals(warnings.length, 1, "an unchanged condition is not repeated");
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - a 404 (repo not visible to the login) is skipped the same way (Issue #1453)", async () => {
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
      ])),
      [REPO_B]: fail("gh: Not Found (HTTP 404)"),
    },
  });
  try {
    const result = assertSuccess(await resolve({ repos: [REPO_A, REPO_B] }));
    assertEquals((result.skippedRepos ?? []).map((s) => s.repo), [REPO_B]);
    assertSameSet(result.byRepo.get(REPO_A)!, ["alice"]);
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - a 403 that names a rate limit is transient, never a skip (Issue #1453)", async () => {
  // Skipping narrows the fold, so a busy hour must not read as "this login
  // cannot push here" — that would drop repos from the intersection and
  // could widen the fleet-wide set.
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
      ])),
      [REPO_B]: fail(
        "HTTP 403: API rate limit exceeded for user ID 283951956.",
      ),
    },
  });
  try {
    const result = assertFailure(await resolve({ repos: [REPO_A, REPO_B] }));
    assertEquals(result.failedSource, REPO_B);
    assertEquals(result.transient, true);
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - every repo unlistable fails closed, permanently (Issue #1453)", async () => {
  installRouter({
    collaborators: {
      [REPO_A]: fail("gh: Not Found (HTTP 404)"),
      [REPO_B]: fail(
        "gh: Must have push access to view repository collaborators. (HTTP 403)",
      ),
    },
  });
  try {
    const result = assertFailure(await resolve({ repos: [REPO_A, REPO_B] }));
    assertEquals(result.transient, false, "no retry will grant push");
    assert(
      result.reason.includes("no monitored repository is a trust source"),
      result.reason,
    );
    assert(result.reason.includes(REPO_A) && result.reason.includes(REPO_B));
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - the fold summary counts what was skipped (Issue #1453)", async () => {
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
      ])),
      [REPO_B]: fail("gh: Not Found (HTTP 404)"),
    },
  });
  const lines: string[] = [];
  try {
    assertSuccess(
      await resolve({ repos: [REPO_A, REPO_B] }, {
        cycleId: "c1",
        log: (m) => lines.push(m),
        warn: () => {},
      }),
    );
    const summary = lines.find((l) => l.includes("collaborators="));
    assert(summary?.includes("skipped=1"), summary);
    assert(summary?.includes(`repos=${REPO_A}`), summary);
  } finally {
    restore();
  }
});

// ── Issue #1453: the snapshot is reused across cycles ──────────────────

/** A stub clock the tests advance by hand. */
function clock(
  startMs = 1_000_000,
): { now: () => number; advance: (s: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (s) => (t += s * 1000) };
}

Deno.test("resolveDerivedAuthors - within the TTL a new cycle is served from the snapshot with no gh call (Issue #1453)", async () => {
  const { calls } = installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
      ])),
    },
  });
  const c = clock();
  try {
    const first = assertSuccess(
      await resolve({ repos: [REPO_A] }, {
        cycleId: "c1",
        snapshotTtlSeconds: 3600,
        now: c.now,
      }),
    );
    assertEquals(first.servedFrom, undefined, "the first answer is a fetch");
    const fetched = calls.length;
    assert(fetched > 0);

    c.advance(1800);
    const second = assertSuccess(
      await resolve({ repos: [REPO_A] }, {
        cycleId: "c2",
        snapshotTtlSeconds: 3600,
        now: c.now,
      }),
    );
    assertEquals(calls.length, fetched, "no gh call inside the window");
    assertEquals(second.servedFrom?.snapshot, "within-ttl");
    assertEquals(second.servedFrom?.ageSeconds, 1800);
    assertSameSet(second.byRepo.get(REPO_A)!, ["alice"]);

    c.advance(1801);
    assertSuccess(
      await resolve({ repos: [REPO_A] }, {
        cycleId: "c3",
        snapshotTtlSeconds: 3600,
        now: c.now,
      }),
    );
    assert(calls.length > fetched, "past the TTL the set is fetched again");
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - a TTL of 0 keeps the per-cycle refresh (Issue #1453)", async () => {
  const { calls } = installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
      ])),
    },
  });
  try {
    await resolve({ repos: [REPO_A] }, {
      cycleId: "c1",
      snapshotTtlSeconds: 0,
    });
    const fetched = calls.length;
    await resolve({ repos: [REPO_A] }, {
      cycleId: "c2",
      snapshotTtlSeconds: 0,
    });
    assert(calls.length > fetched, "every cycle fetches when the TTL is 0");
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - a changed input never reuses the snapshot (Issue #1453)", async () => {
  const { calls } = installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
      ])),
      [REPO_B]: ok(JSON.stringify([
        rawCollaborator("Bob", { push: true }),
      ])),
    },
  });
  const c = clock();
  try {
    await resolve({ repos: [REPO_A] }, {
      cycleId: "c1",
      snapshotTtlSeconds: 3600,
      now: c.now,
    });
    const fetched = calls.length;
    const result = assertSuccess(
      await resolve({ repos: [REPO_A, REPO_B] }, {
        cycleId: "c2",
        snapshotTtlSeconds: 3600,
        now: c.now,
      }),
    );
    assert(calls.length > fetched, "a new repo list is a new set");
    assertEquals(result.servedFrom, undefined);
    assertEquals([...result.byRepo.keys()], [REPO_A, REPO_B]);
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - a transient failure after the TTL serves the snapshot, with its age, until the ceiling (Issue #1453)", async () => {
  let healthy = true;
  installRouter({
    collaborators: {
      [REPO_A]: () =>
        healthy
          ? ok(JSON.stringify([rawCollaborator("Alice", { push: true })]))
          : fail("HTTP 403: API rate limit exceeded for user ID 1."),
    },
  });
  const c = clock();
  const warnings: string[] = [];
  const deps = (cycleId: string) => ({
    cycleId,
    snapshotTtlSeconds: 3600,
    snapshotMaxAgeSeconds: 6 * 3600,
    now: c.now,
    warn: (m: string) => warnings.push(m),
    log: () => {},
  });
  try {
    assertSuccess(await resolve({ repos: [REPO_A] }, deps("c1")));

    healthy = false;
    c.advance(4000);
    const served = assertSuccess(
      await resolve({ repos: [REPO_A] }, deps("c2")),
    );
    assertEquals(served.servedFrom?.snapshot, "after-transient-failure");
    assertEquals(served.servedFrom?.ageSeconds, 4000);
    assert(
      served.servedFrom?.reason?.includes("rate limit"),
      served.servedFrom?.reason,
    );
    assertSameSet(served.byRepo.get(REPO_A)!, ["alice"]);
    assertEquals(warnings.length, 1);
    assert(warnings[0]!.includes("4000s ago"), warnings[0]);

    c.advance(6 * 3600);
    const stood = assertFailure(await resolve({ repos: [REPO_A] }, deps("c3")));
    assertEquals(stood.transient, true);
    assertEquals(
      stood.failedSource,
      REPO_A,
      "past the ceiling the failure stands",
    );
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - a permanent failure is never covered by the snapshot (Issue #1453)", async () => {
  let empty = false;
  installRouter({
    collaborators: {
      [REPO_A]: () =>
        empty
          ? ok(JSON.stringify([rawCollaborator("Alice", { pull: true })]))
          : ok(JSON.stringify([rawCollaborator("Alice", { push: true })])),
    },
  });
  const c = clock();
  try {
    assertSuccess(
      await resolve({ repos: [REPO_A] }, {
        cycleId: "c1",
        snapshotTtlSeconds: 60,
        now: c.now,
      }),
    );
    // Every write collaborator removed: a data condition, not an outage.
    empty = true;
    c.advance(120);
    const result = assertFailure(
      await resolve({ repos: [REPO_A] }, {
        cycleId: "c2",
        snapshotTtlSeconds: 60,
        now: c.now,
      }),
    );
    assertEquals(result.transient, false);
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - a failed team fetch fails the whole resolve", async () => {
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
      ])),
    },
    team: fail("gh: Resource not accessible by integration (HTTP 403)"),
  });
  try {
    const result = assertFailure(
      await resolve({ exclusionTeamSlug: TEAM_SLUG }),
    );
    assert(
      result.failedSource === TEAM_SLUG ||
        result.failedSource.includes("exclusion"),
      `failedSource should name the team, got ${result.failedSource}`,
    );
    assert(
      result.reason.length > 0,
      "failure must name a reason",
    );
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - the team is fetched once for N repos", async () => {
  const payload = ok(JSON.stringify([
    rawCollaborator("Alice", { push: true }),
  ]));
  let teamFetches = 0;
  const { calls } = installRouter({
    collaborators: {
      [REPO_A]: payload,
      [REPO_B]: payload,
      "owner/gamma": payload,
    },
    team: () => {
      teamFetches++;
      return ok(JSON.stringify([member("someone")]));
    },
  });
  try {
    const result = assertSuccess(
      await resolve({
        repos: [REPO_A, REPO_B, "owner/gamma"],
        exclusionTeamSlug: TEAM_SLUG,
      }),
    );
    assertEquals(result.byRepo.size, 3);
    assertEquals(teamFetches, 1, "team membership must be fetched once");
    const teamCalls = calls.filter((args) => args.includes(TEAM_PATH));
    assertEquals(teamCalls.length, 1);
    const collabCalls = calls.filter((args) =>
      args.some((a) => a.includes("/collaborators"))
    );
    assertEquals(collabCalls.length, 3);
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - same cycle returns the cached object without re-fetching", async () => {
  let collabFetches = 0;
  installRouter({
    collaborators: {
      [REPO_A]: () => {
        collabFetches++;
        return ok(JSON.stringify([
          rawCollaborator("Alice", { push: true }),
        ]));
      },
    },
    team: ok(JSON.stringify([])),
  });
  try {
    const first = await resolve({
      exclusionTeamSlug: TEAM_SLUG,
      cycleId: "cycle-1",
    });
    const second = await resolve({
      exclusionTeamSlug: TEAM_SLUG,
      cycleId: "cycle-1",
    });
    assertSuccess(first);
    assertStrictEquals(
      second,
      first,
      "repeated calls within a cycle must return the same result object",
    );
    assertEquals(
      collabFetches,
      1,
      "cached cycle must not re-fetch collaborators",
    );
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - a new cycle re-fetches", async () => {
  let collabFetches = 0;
  installRouter({
    collaborators: {
      [REPO_A]: () => {
        collabFetches++;
        return ok(JSON.stringify([
          rawCollaborator("Alice", { push: true }),
        ]));
      },
    },
  });
  try {
    const first = assertSuccess(await resolve({ cycleId: 1 }));
    const second = assertSuccess(await resolve({ cycleId: 2 }));
    assertEquals(collabFetches, 2, "a new cycle must re-fetch");
    assert(
      first !== second,
      "a new cycle must not return the previous cycle's object",
    );
    assertSameSet(second.byRepo.get(REPO_A)!, ["alice"]);
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - summary log names collaborator, excluded and trusted counts", async () => {
  const logs: string[] = [];
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
        rawCollaborator("Mallory", { push: true }),
        rawCollaborator("dependabot[bot]", { push: true }),
      ])),
      [REPO_B]: ok(JSON.stringify([
        rawCollaborator("Bob", { admin: true }),
      ])),
    },
  });
  try {
    assertSuccess(
      await resolve({
        repos: [REPO_A, REPO_B],
        serviceAccounts: ["mallory"],
        log: (line) => logs.push(line),
      }),
    );
    assertEquals(logs.length, 1, "exactly one summary line per resolve");
    const line = logs[0] ?? "";
    assert(
      line.includes(REPO_A) && line.includes(REPO_B),
      `summary must name the fetched repos, got: ${line}`,
    );
    assert(
      /collaborators[=:]?\s*4/i.test(line),
      `summary must name collaborator count 4, got: ${line}`,
    );
    assert(
      /excluded[=:]?\s*2/i.test(line),
      `summary must name excluded count 2, got: ${line}`,
    );
    assert(
      /trusted[=:]?\s*2/i.test(line),
      `summary must name trusted count 2, got: ${line}`,
    );
  } finally {
    restore();
  }
});

Deno.test("resolveDerivedAuthors - cached cycle does not emit a second summary line", async () => {
  const logs: string[] = [];
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
      ])),
    },
  });
  try {
    const log = (line: string) => logs.push(line);
    await resolve({ cycleId: 7, log });
    await resolve({ cycleId: 7, log });
    assertEquals(logs.length, 1, "cache hits must not re-log the summary");
  } finally {
    restore();
  }
});
