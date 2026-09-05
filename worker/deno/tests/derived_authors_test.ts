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
      cycleId: overrides.cycleId ?? 1,
      log: overrides.log,
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

Deno.test("resolveDerivedAuthors - one repo failing fails the whole resolve", async () => {
  installRouter({
    collaborators: {
      [REPO_A]: ok(JSON.stringify([
        rawCollaborator("Alice", { push: true }),
      ])),
      [REPO_B]: fail(
        "HTTP 403: Must have push access to view repository collaborators.",
      ),
    },
  });
  try {
    const result = assertFailure(
      await resolve({ repos: [REPO_A, REPO_B] }),
    );
    assertEquals(result.failedSource, REPO_B);
    assert(
      result.reason.length > 0,
      "failure must name a reason",
    );
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
