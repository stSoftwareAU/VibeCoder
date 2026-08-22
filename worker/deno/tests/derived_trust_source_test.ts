/**
 * Tests for flipping the production trust source to GitHub (Issue #256,
 * parent #234).
 *
 * This is the sub-issue that changes who the worker trusts, so the tests
 * are aimed at the parent issue's two review questions and nothing else:
 *
 *   1. Does a fetch failure ever widen trust?
 *   2. Does write access on one repo confer trust on another?
 *
 * Everything mechanical — the collaborator fetch, the exclusion sources,
 * the snapshot holder — is covered by #250/#251/#253/#254.
 *
 * Uses Australian English throughout (behaviour, authorised, normalise).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type DerivedAuthorsResult,
  formatDerivedAuthorsFoldSummary,
  intersectDerivedAuthors,
  type TrustedAuthors,
} from "../lib/derived_authors.ts";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { validateFleetConfig } from "../lib/fleet_config_validation.ts";
import { createLogger } from "../lib/logger.ts";
import {
  _resetSuppressionAuthorAllowlist,
  findSuppressions,
} from "../lib/suppression_comments.ts";
import type { WorkerConfig } from "../types.ts";

const testLogger = createLogger({ write: () => {} });

function authors(...logins: string[]): TrustedAuthors {
  return { allowedAuthors: [...logins], authorisedCommenters: [...logins] };
}

function byRepo(
  entries: Record<string, string[]>,
): Map<string, TrustedAuthors> {
  return new Map(
    Object.entries(entries).map(([repo, logins]) => [repo, authors(...logins)]),
  );
}

// ===========================================================================
// Question 2: does write access on one repo confer trust on another?
// ===========================================================================

Deno.test("intersect - a login with write on every repo is fleet-wide trusted", () => {
  const folded = intersectDerivedAuthors(
    byRepo({ "org/a": ["alice", "bob"], "org/b": ["alice", "bob"] }),
  );
  assertEquals(folded.allowedAuthors, ["alice", "bob"]);
  assertEquals(folded.authorisedCommenters, ["alice", "bob"]);
});

Deno.test("intersect - write on ONE repo does not confer fleet-wide trust (Issue #256)", () => {
  // The whole point. A contractor added to a single low-stakes repo must not
  // become an authorised author across the fleet. A union would return
  // ["alice", "mallory"] here.
  const folded = intersectDerivedAuthors(
    byRepo({
      "org/low-stakes": ["alice", "mallory"],
      "org/critical": ["alice"],
    }),
  );
  assertEquals(folded.allowedAuthors, ["alice"]);
  assert(!folded.allowedAuthors.includes("mallory"));
});

Deno.test("intersect - a login missing from one of many repos is dropped", () => {
  const folded = intersectDerivedAuthors(
    byRepo({
      "org/a": ["alice", "bob", "carol"],
      "org/b": ["alice", "bob", "carol"],
      "org/c": ["alice", "carol"],
      "org/d": ["alice", "bob", "carol"],
    }),
  );
  assertEquals(folded.allowedAuthors, ["alice", "carol"]);
});

Deno.test("intersect - disjoint repos trust nobody rather than everybody", () => {
  const folded = intersectDerivedAuthors(
    byRepo({ "org/a": ["alice"], "org/b": ["bob"] }),
  );
  assertEquals(folded.allowedAuthors, []);
});

Deno.test("intersect - no repos yields an empty set, never an open one", () => {
  assertEquals(intersectDerivedAuthors(new Map()).allowedAuthors, []);
});

Deno.test("intersect - a single repo passes its own set through", () => {
  const folded = intersectDerivedAuthors(byRepo({ "org/a": ["alice", "bob"] }));
  assertEquals(folded.allowedAuthors, ["alice", "bob"]);
});

Deno.test("intersect - the result is deduplicated and order-stable", () => {
  const folded = intersectDerivedAuthors(
    byRepo({ "org/a": ["alice", "alice", "bob"], "org/b": ["bob", "alice"] }),
  );
  assertEquals(folded.allowedAuthors, ["alice", "bob"]);
});

Deno.test("fold summary - names the per-repo sizes so a narrowing is visible", () => {
  const map = byRepo({ "org/a": ["alice", "mallory"], "org/b": ["alice"] });
  const line = formatDerivedAuthorsFoldSummary(
    map,
    intersectDerivedAuthors(map),
  );
  assert(line.includes("fleet-wide=1"));
  assert(line.includes("org/a=2"));
  assert(line.includes("org/b=1"));
});

// ===========================================================================
// Question 1: does a fetch failure ever widen trust?
// ===========================================================================

/** Production deps with `author_source` and a stubbed resolver. */
async function depsWith(
  authorSource: "config" | "github",
  resolver: () => Promise<DerivedAuthorsResult>,
  configOverrides: Partial<WorkerConfig> = {},
) {
  const config = buildDefaultWorkerConfig({
    repos: ["org/a", "org/b"],
    ...configOverrides,
  });
  config.authorSource = authorSource;
  return await createProductionRunCoreDeps({
    repoDir: "/tmp/test-repo-256",
    workDir: "/tmp/test-work-256",
    githubUser: "host-bot",
    logger: testLogger,
    config,
    resolveTrustedAuthors: resolver,
  });
}

Deno.test("refreshTrustedAuthors - a resolver failure never falls back to populated local arrays (Issue #256)", async () => {
  // The acceptance criterion that matters most: `allowed_authors` is
  // populated, and a GitHub outage must still stand the cycle down rather
  // than quietly restoring that stale list.
  const { deps, cleanup } = await depsWith(
    "github",
    () =>
      Promise.resolve({
        ok: false,
        reason: "gh: could not reach api.github.com",
        failedSource: "org/b",
      }),
    { allowedAuthors: ["stale-human"], authorisedCommenters: ["stale-human"] },
  );
  try {
    const outcome = await deps.refreshTrustedAuthors!();
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assert(
      outcome.reason.includes("refusing to fall back"),
      `reason must say the fallback was refused; got: ${outcome.reason}`,
    );
    assert(outcome.reason.includes("org/b"), "the failed source is named");
  } finally {
    cleanup();
  }
});

/**
 * Observe the applied snapshot from outside the closure.
 *
 * `applyTrustSnapshot` pushes the trusted set into
 * `setSuppressionAuthorAllowlist`, and `findSuppressions` checks a
 * marker's `author=` against exactly that process-wide allowlist. So a
 * marker that is honoured names a login the snapshot trusts, and one
 * rejected as "not authorised" names a login it does not. That gives a
 * real assertion on snapshot *contents* rather than on the refresh's
 * return value.
 *
 * The probed login is supplied as the policy's verified commit identity
 * (Issue #269) so that orthogonal gate never decides the outcome — the
 * trust snapshot stays the only variable under test.
 */
function suppressionHonoured(author: string): boolean {
  const marker =
    `// orphan-deps-ignore: BP-abcdef — author=${author} expires=2999-01-01 x`;
  const [record] = findSuppressions(marker, "ts", { commitAuthors: [author] });
  return record !== undefined && record.valid === true;
}

Deno.test("refreshTrustedAuthors - github source populates the snapshot from the resolver, and a populated local allowed_authors has no effect (Issue #256)", async () => {
  // Two acceptance criteria in one test, because they are the same fact seen
  // from two sides: the derived login is trusted and the local one is not,
  // even though `allowed_authors` names the local one and not the derived.
  _resetSuppressionAuthorAllowlist();
  const { deps, cleanup } = await depsWith(
    "github",
    () =>
      Promise.resolve({
        ok: true,
        byRepo: byRepo({
          "org/a": ["alice", "bob"],
          "org/b": ["alice"],
        }),
      }),
    {
      allowedAuthors: ["ignored-human"],
      authorisedCommenters: ["ignored-human"],
    },
  );
  try {
    assertEquals((await deps.refreshTrustedAuthors!()).ok, true);

    assert(
      suppressionHonoured("alice"),
      "alice holds write on every monitored repo — the derived set must " +
        "reach the snapshot",
    );
    assert(
      !suppressionHonoured("ignored-human"),
      "allowed_authors is populated with ignored-human and must have NO " +
        "effect under author_source=github",
    );
    assert(
      !suppressionHonoured("bob"),
      "bob holds write on org/a only — the fold is an intersection, so one " +
        "repo must not confer fleet-wide trust",
    );
  } finally {
    cleanup();
    _resetSuppressionAuthorAllowlist();
  }
});

Deno.test("refreshTrustedAuthors - config source still applies the static arrays (Issue #256)", async () => {
  _resetSuppressionAuthorAllowlist();
  const { deps, cleanup } = await depsWith(
    "config",
    () => Promise.resolve({ ok: true, byRepo: new Map() }),
    {
      allowedAuthors: ["static-human"],
      authorisedCommenters: ["static-human"],
    },
  );
  try {
    assertEquals((await deps.refreshTrustedAuthors!()).ok, true);
    assert(
      suppressionHonoured("static-human"),
      "the default source must be unchanged by this issue",
    );
  } finally {
    cleanup();
    _resetSuppressionAuthorAllowlist();
  }
});

Deno.test("refreshTrustedAuthors - a failed resolve leaves the previous snapshot rather than widening to the local arrays (Issue #256)", async () => {
  // Belt and braces on the no-fallback rule: not only does the hook report
  // failure, the stale local array never becomes trusted as a side effect.
  _resetSuppressionAuthorAllowlist();
  const { deps, cleanup } = await depsWith(
    "github",
    () =>
      Promise.resolve({
        ok: false,
        reason: "gh: could not reach api.github.com",
        failedSource: "org/a",
      }),
    { allowedAuthors: ["stale-human"], authorisedCommenters: ["stale-human"] },
  );
  try {
    assertEquals((await deps.refreshTrustedAuthors!()).ok, false);
    assert(
      !suppressionHonoured("stale-human"),
      "a GitHub outage must never restore the local allowed_authors list",
    );
  } finally {
    cleanup();
    _resetSuppressionAuthorAllowlist();
  }
});

Deno.test("refreshTrustedAuthors - config source never calls the resolver (Issue #256)", async () => {
  let called = 0;
  const { deps, cleanup } = await depsWith("config", () => {
    called++;
    return Promise.resolve({ ok: true, byRepo: new Map() });
  }, { allowedAuthors: ["alice"] });
  try {
    assertEquals((await deps.refreshTrustedAuthors!()).ok, true);
    assertEquals(called, 0, "the static source must not reach GitHub");
  } finally {
    cleanup();
  }
});

Deno.test("refreshTrustedAuthors - an all-repos-fail resolve is a failure, not an empty success", async () => {
  const { deps, cleanup } = await depsWith("github", () =>
    Promise.resolve({
      ok: false,
      reason: "HTTP 403: Forbidden",
      failedSource: "exclusion-team",
    }));
  try {
    const outcome = await deps.refreshTrustedAuthors!();
    assertEquals(outcome.ok, false);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Start-up validation under the derived source
// ===========================================================================

Deno.test("validateFleetConfig - empty allowed_authors is not a warning under github (Issue #256)", () => {
  const result = validateFleetConfig({
    githubUser: "host-bot",
    allowedAuthors: [],
    fleetPrAuthors: ["host-bot"],
    serviceAccounts: [],
    authorSource: "github",
  });
  assert(
    !result.messages.some((m) => m.includes("allowed_authors is empty")),
    `a warning that fires on every healthy start-up trains operators to ` +
      `ignore the validator; got: ${JSON.stringify(result.messages)}`,
  );
});

Deno.test("validateFleetConfig - empty allowed_authors still warns under config (Issue #256)", () => {
  const result = validateFleetConfig({
    githubUser: "host-bot",
    allowedAuthors: [],
    fleetPrAuthors: ["host-bot"],
    serviceAccounts: [],
    authorSource: "config",
  });
  assert(result.messages.some((m) => m.includes("allowed_authors is empty")));
});

Deno.test("validateFleetConfig - an absent authorSource behaves as config (Issue #256)", () => {
  const result = validateFleetConfig({
    githubUser: "host-bot",
    allowedAuthors: [],
    fleetPrAuthors: ["host-bot"],
  });
  assert(result.messages.some((m) => m.includes("allowed_authors is empty")));
});

Deno.test("production deps - the github source seeds trust CLOSED, before any refresh (Issue #256)", async () => {
  // The construction-time snapshot is live until the first refresh lands.
  // Seeding it from the local arrays would make a populated allowed_authors
  // genuinely trusted for that window — the exact thing the derived source
  // exists to prevent. Trust starts empty and is opened only by a
  // successful resolve.
  _resetSuppressionAuthorAllowlist();
  const { cleanup } = await depsWith(
    "github",
    () => Promise.resolve({ ok: true, byRepo: new Map() }),
    { allowedAuthors: ["stale-human"], authorisedCommenters: ["stale-human"] },
  );
  try {
    assert(
      !suppressionHonoured("stale-human"),
      "no refresh has run yet, so nobody is trusted under author_source=github",
    );
  } finally {
    cleanup();
    _resetSuppressionAuthorAllowlist();
  }
});

Deno.test("production deps - the config source still seeds from the static arrays (Issue #256)", async () => {
  _resetSuppressionAuthorAllowlist();
  const { cleanup } = await depsWith(
    "config",
    () => Promise.resolve({ ok: true, byRepo: new Map() }),
    {
      allowedAuthors: ["static-human"],
      authorisedCommenters: ["static-human"],
    },
  );
  try {
    assert(
      suppressionHonoured("static-human"),
      "the default source must keep its construction-time behaviour",
    );
  } finally {
    cleanup();
    _resetSuppressionAuthorAllowlist();
  }
});
