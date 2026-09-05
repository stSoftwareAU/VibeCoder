/**
 * The two-axis trust model (Issues #1066, #1068).
 *
 * There is no `author_source` mode switch any more, and the local
 * `allowed_authors` array grants nothing. Trust is two separate questions
 * with two separate answers:
 *
 * | Actor                                   | may direct work | may supply input |
 * | --------------------------------------- | --------------- | ---------------- |
 * | Human with write access, not a Vibe Coder | yes           | yes              |
 * | Vibe Coder (`VibeCoderST`, `stservice`) | no              | yes              |
 * | Known bot (`github-copilot[bot]`, …)    | no              | yes              |
 * | Anyone else — no write access, unknown bots | no           | no               |
 *
 * **Axis 1 — direct work** (raise, label, schedule):
 * `hasWriteAccess(repo, login) && !isVibeCoder(login) && !isBot(login)`,
 * derived from repository permissions every cycle.
 *
 * **Axis 2 — supply input** (test results, code reviews, PR comments): the
 * axis-1 set plus a *known* list — the Vibe Coder logins and the known bots.
 * "Known" is precisely the property that cannot be derived from repository
 * permissions, which is why `authorized_commenters` survives.
 *
 * The table below is the fixture, and every actor is asserted on **both**
 * axes from one declaration, so a new actor category cannot be added without
 * filling both cells. Each regression this area has shipped passed a suite
 * where every gate was tested alone.
 *
 * Australian English throughout (behaviour, authorised, normalise).
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  _resetRemovedTrustKeyWarning,
  loadConfig,
  validateConfig,
} from "../lib/config.ts";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { _resetDerivedAuthorsCache } from "../lib/derived_authors.ts";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  type GhSpawnResult,
} from "../lib/gh_spawn.ts";
import { wasLabelAddedByAllowedAuthor } from "../lib/issue_query.ts";
import { isAuthorisedCommenter } from "../lib/security.ts";
import { stripUntrustedWorkOnLabel } from "../lib/strip_untrusted_work_on.ts";
import {
  _resetSuppressionAuthorAllowlist,
  findSuppressions,
} from "../lib/suppression_comments.ts";
import {
  readLiveTrustedAuthors,
  recomputeDerivedTrust,
} from "../lib/trust_snapshot.ts";
import type { WorkerConfig } from "../types.ts";

const testLogger = createLogger({ write: () => {} });

/** The live fleet's own logins — the accounts that must never direct work. */
const VIBE_CODERS = ["VibeCoderST", "stservice"];

/** The monitored repos in the fixtures below. */
const REPO = "stSoftwareAU/VibeCoder";
const OTHER_REPO = "stSoftwareAU/other";

// ===========================================================================
// The table. One declaration, both axes, every actor.
// ===========================================================================

/** One row of the trust table, and what it is entitled to do. */
interface TrustActor {
  /** The table row this actor stands for. */
  category: string;
  /** GitHub login. */
  login: string;
  /** Whether GitHub reports write access on every monitored repo. */
  hasWriteAccess: boolean;
  /** Axis 1 — may raise, label and schedule work. */
  mayDirect: boolean;
  /** Axis 2 — may supply test results, reviews and PR comments. */
  mayInput: boolean;
}

const TRUST_TABLE: readonly TrustActor[] = [
  {
    category: "human with write access, not a Vibe Coder",
    login: "alice",
    hasWriteAccess: true,
    mayDirect: true,
    mayInput: true,
  },
  {
    category: "Vibe Coder",
    login: "stservice",
    hasWriteAccess: true,
    mayDirect: false,
    mayInput: true,
  },
  {
    category: "known bot",
    login: "github-copilot[bot]",
    hasWriteAccess: true,
    mayDirect: false,
    mayInput: true,
  },
  {
    category: "anyone else — no write access",
    login: "mallory",
    hasWriteAccess: false,
    mayDirect: false,
    mayInput: false,
  },
  {
    category: "anyone else — unknown bot, even with write access",
    login: "driveby-scanner[bot]",
    hasWriteAccess: true,
    mayDirect: false,
    mayInput: false,
  },
] as const;

// ===========================================================================
// Fixtures — the only stub is the `gh` process boundary.
// ===========================================================================

/** One collaborator entry in the shape the GitHub API returns. */
function collaborator(login: string, role: "push" | "pull" = "push") {
  return {
    login,
    permissions: {
      admin: false,
      maintain: false,
      push: role === "push",
      triage: false,
      pull: true,
    },
  };
}

function ok(stdout: string): GhSpawnResult {
  return { code: 0, success: true, stdout, stderr: "" };
}

/**
 * Stub the `gh` process boundary — and only that boundary — with a fixed
 * collaborator list per repo. Everything above it is production code.
 */
function stubCollaborators(byRepo: Record<string, unknown[]>): void {
  _setGhSpawnRunner((args) => {
    const path = args.find((a) => a.includes("/collaborators")) ?? "";
    for (const [repo, list] of Object.entries(byRepo)) {
      if (path.includes(`repos/${repo}/collaborators`)) {
        return Promise.resolve(ok(JSON.stringify(list)));
      }
    }
    return Promise.resolve({
      code: 1,
      success: false,
      stdout: "",
      stderr: `unexpected gh call: ${args.join(" ")}`,
    });
  });
}

/** Collaborators derived from the table: every actor with write access. */
function tableCollaborators(): unknown[] {
  return [
    collaborator("nleck"),
    ...TRUST_TABLE.filter((a) => a.hasWriteAccess).map((a) =>
      collaborator(a.login)
    ),
  ];
}

/** A timeline whose only `labeled` event for `label` was applied by `actor`. */
function timelineFor(label: string, actor: string): string {
  return JSON.stringify([
    {
      event: "labeled",
      label: { name: label },
      actor: { login: actor },
      created_at: "2026-09-05T00:00:00Z",
    },
  ]);
}

/** The live host's configuration shape, minus `author_source`. */
function liveShapedConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return buildDefaultWorkerConfig({
    repos: [REPO],
    // The live `.config.json` still carries these; they must direct nothing.
    allowedAuthors: ["nleck", ...VIBE_CODERS],
    serviceAccounts: [...VIBE_CODERS],
    fleetPrAuthors: [...VIBE_CODERS],
    ...overrides,
  });
}

/** The resolved trust sets after one full refresh through production deps. */
interface ResolvedTrust {
  /** Axis 1 — who may direct work. */
  allowedAuthors: string[];
  /** Axis 2 — whose input we act on. */
  authorisedCommenters: string[];
  /** The fleet logins the label gate treats as never-directing. */
  fleetWorkerLogins: string[];
}

async function refreshedTrust(
  config: WorkerConfig,
  // The host runs as a service account — the shape `setup.sh` produces since
  // Issue #4030, and the shape the identity guard (#3528) expects. The host's
  // own login is always excluded from directing work, so a host running as a
  // human's personal account cannot be directed by that human.
  githubUser = "VibeCoderST",
): Promise<ResolvedTrust> {
  _resetDerivedAuthorsCache();
  const { deps, cleanup } = await createProductionRunCoreDeps({
    repoDir: "/tmp/test-repo-1066",
    workDir: "/tmp/test-work-1066",
    githubUser,
    logger: testLogger,
    config,
  });
  try {
    const outcome = await deps.refreshTrustedAuthors!();
    assertEquals(
      outcome.ok,
      true,
      `refresh failed: ${outcome.ok ? "" : outcome.reason}`,
    );
    const live = readLiveTrustedAuthors();
    assert(live !== null, "a successful refresh must publish a live snapshot");
    return {
      allowedAuthors: [...live.allowedAuthors],
      authorisedCommenters: [...live.authorisedCommenters],
      fleetWorkerLogins: [githubUser, ...(config.fleetPrAuthors ?? [])],
    };
  } finally {
    cleanup();
  }
}

/**
 * Axis 1, exercised through the production gate rather than a predicate: can
 * this login's own `work-on` label make an issue claimable?
 */
function mayDirect(trust: ResolvedTrust, login: string): Promise<boolean> {
  return wasLabelAddedByAllowedAuthor(
    REPO,
    4242,
    "work-on",
    trust.allowedAuthors,
    () => Promise.resolve(timelineFor("work-on", login)),
    undefined,
    trust.fleetWorkerLogins,
  );
}

/** Axis 2, exercised through the production gate: is this login's input acted on? */
function mayInput(trust: ResolvedTrust, login: string): boolean {
  return isAuthorisedCommenter(login, trust.authorisedCommenters);
}

// ===========================================================================
// The eight (ten) cells — every actor, both axes, from one declaration.
// ===========================================================================

Deno.test("trust table - every actor is asserted on both axes (Issues #1066, #1068)", async () => {
  stubCollaborators({ [REPO]: tableCollaborators() });
  try {
    const trust = await refreshedTrust(liveShapedConfig());

    const actual: Array<[string, boolean, boolean]> = [];
    for (const actor of TRUST_TABLE) {
      actual.push([
        actor.login,
        await mayDirect(trust, actor.login),
        mayInput(trust, actor.login),
      ]);
    }

    const expected = TRUST_TABLE.map((
      a,
    ): [string, boolean, boolean] => [a.login, a.mayDirect, a.mayInput]);

    assertEquals(
      actual,
      expected,
      "each row is [login, may-direct, may-supply-input]; every table row " +
        "must hold on both axes",
    );
  } finally {
    _resetGhSpawnRunner();
    _resetDerivedAuthorsCache();
  }
});

Deno.test("trust table - the asymmetry holds for the same login in one run (Issues #1066, #1068)", async () => {
  // The point of the design: a Vibe Coder and a known bot are refused on
  // axis 1 and accepted on axis 2 *in the same refresh*. Asserting those two
  // facts in separate tests would let a future change satisfy one and break
  // the other with nothing going red.
  stubCollaborators({ [REPO]: tableCollaborators() });
  try {
    const trust = await refreshedTrust(liveShapedConfig());

    for (const login of ["stservice", "VibeCoderST", "github-copilot[bot]"]) {
      assertEquals(
        await mayDirect(trust, login),
        false,
        `${login} must not be able to direct work`,
      );
      assertEquals(
        mayInput(trust, login),
        true,
        `${login}'s review/test result must still be accepted as input`,
      );
    }
  } finally {
    _resetGhSpawnRunner();
    _resetDerivedAuthorsCache();
  }
});

Deno.test("trust - trust matching is case-insensitive, as GitHub logins are (Issues #1066, #1068)", async () => {
  // The derived set is normalised to lower case by `normaliseLogin`, while a
  // comment author or label actor arrives in the account's own casing. An
  // exact match would silently drop every login carrying a capital —
  // `VibeCoderST` among them — from the input axis.
  stubCollaborators({
    [REPO]: [collaborator("nleck"), collaborator("Alice-Smith")],
  });
  try {
    const trust = await refreshedTrust(liveShapedConfig());
    assertEquals(mayInput(trust, "Alice-Smith"), true);
    assertEquals(await mayDirect(trust, "Alice-Smith"), true);
    assertEquals(mayInput(trust, "VibeCoderST"), true);
  } finally {
    _resetGhSpawnRunner();
    _resetDerivedAuthorsCache();
  }
});

Deno.test("trust - a known bot's write access does not confer the right to direct (Issues #1066, #1068)", async () => {
  // The `!isBot` term standing on its own: `github-copilot[bot]` is a
  // collaborator with push in this fixture, and must still be refused axis 1.
  stubCollaborators({ [REPO]: tableCollaborators() });
  try {
    const trust = await refreshedTrust(liveShapedConfig());
    assert(
      !trust.allowedAuthors.some((a) => a.toLowerCase().endsWith("[bot]")),
      `no bot may hold the right to direct work; got ${
        JSON.stringify(trust.allowedAuthors)
      }`,
    );
  } finally {
    _resetGhSpawnRunner();
    _resetDerivedAuthorsCache();
  }
});

Deno.test("trust - a known bot's work-on label is stripped by the #3575 path (Issues #1066, #1068)", async () => {
  stubCollaborators({ [REPO]: tableCollaborators() });
  const calls: string[][] = [];
  try {
    const trust = await refreshedTrust(liveShapedConfig());
    const removed = await stripUntrustedWorkOnLabel({
      repo: REPO,
      issueNumber: 4242,
      workOnLabel: "work-on",
      allowedAuthors: trust.allowedAuthors,
      fleetWorkerLogins: trust.fleetWorkerLogins,
      logger: testLogger,
      ghFn: (args) => {
        calls.push([...args]);
        const path = args[1] ?? "";
        if (path.includes("/timeline")) {
          return Promise.resolve(
            timelineFor("work-on", "github-copilot[bot]"),
          );
        }
        if (path.includes("/comments")) return Promise.resolve("[]");
        return Promise.resolve("{}");
      },
    });
    assertEquals(
      removed,
      true,
      "a bot-applied work-on label must be stripped, not honoured",
    );
  } finally {
    _resetGhSpawnRunner();
    _resetDerivedAuthorsCache();
  }
});

Deno.test("trust - an unverifiable work-on adder is left alone (fail closed, Issues #1066, #1068)", async () => {
  // The strip path must never remove a human's genuine label because a
  // timeline read failed.
  stubCollaborators({ [REPO]: tableCollaborators() });
  try {
    const trust = await refreshedTrust(liveShapedConfig());
    const removed = await stripUntrustedWorkOnLabel({
      repo: REPO,
      issueNumber: 4242,
      workOnLabel: "work-on",
      allowedAuthors: trust.allowedAuthors,
      fleetWorkerLogins: trust.fleetWorkerLogins,
      logger: testLogger,
      ghFn: () => Promise.reject(new Error("gh: API rate limit exceeded")),
    });
    assertEquals(removed, false, "an unreadable timeline must strip nothing");
  } finally {
    _resetGhSpawnRunner();
    _resetDerivedAuthorsCache();
  }
});

// ===========================================================================
// A human collaborator absent from allowed_authors still works.
// ===========================================================================

Deno.test("trust - a write-access collaborator absent from allowed_authors may direct work (Issues #1066, #1068)", async () => {
  // The degenerate failure mode of this change is trusting nobody. `alice`
  // has write access and is NOT in the local array — no per-host config edit
  // is needed to add a colleague.
  stubCollaborators({ [REPO]: tableCollaborators() });
  try {
    const config = liveShapedConfig();
    assert(
      !config.allowedAuthors.includes("alice"),
      "alice must be absent from the local array for this test to mean anything",
    );
    const trust = await refreshedTrust(config);
    assertEquals(await mayDirect(trust, "alice"), true);
    assertEquals(mayInput(trust, "alice"), true);
  } finally {
    _resetGhSpawnRunner();
    _resetDerivedAuthorsCache();
  }
});

Deno.test("trust - the host's own login cannot direct work (Issues #1066, #1068)", async () => {
  // The worker must not be able to schedule itself, so its own resolved `gh`
  // login is excluded unconditionally. The consequence is worth stating: a
  // host that authenticates as a human's personal account removes that human
  // from the directing set *on that host*. The remedy is to run the worker as
  // a service account, which is what `setup.sh` configures.
  stubCollaborators({
    [REPO]: [collaborator("nleck"), collaborator("alice")],
  });
  try {
    const trust = await refreshedTrust(liveShapedConfig(), "nleck");
    assert(
      !trust.allowedAuthors.includes("nleck"),
      "the host's own login must never be able to direct its own work",
    );
    assert(
      trust.allowedAuthors.includes("alice"),
      "every other collaborator is unaffected",
    );
  } finally {
    _resetGhSpawnRunner();
    _resetDerivedAuthorsCache();
  }
});

Deno.test("trust - read-only access is not write access (Issues #1066, #1068)", async () => {
  stubCollaborators({
    [REPO]: [collaborator("nleck"), collaborator("readonly-bob", "pull")],
  });
  try {
    const trust = await refreshedTrust(liveShapedConfig());
    assert(
      !trust.allowedAuthors.includes("readonly-bob"),
      "a triage/read collaborator must not be able to direct work",
    );
    assertEquals(mayInput(trust, "readonly-bob"), false);
  } finally {
    _resetGhSpawnRunner();
    _resetDerivedAuthorsCache();
  }
});

Deno.test("trust - a login in allowed_authors with no write access is refused (Issues #1066, #1068)", async () => {
  // `allowed_authors` is what used to grant this. It must grant nothing now.
  stubCollaborators({ [REPO]: [collaborator("nleck")] });
  try {
    const trust = await refreshedTrust(
      liveShapedConfig({
        allowedAuthors: ["nleck", "mallory", ...VIBE_CODERS],
      }),
    );
    assert(
      !trust.allowedAuthors.includes("mallory"),
      `allowed_authors must not grant the right to direct work; got ${
        JSON.stringify(trust.allowedAuthors)
      }`,
    );
    assertEquals(await mayDirect(trust, "mallory"), false);
    assertEquals(mayInput(trust, "mallory"), false);
  } finally {
    _resetGhSpawnRunner();
    _resetDerivedAuthorsCache();
  }
});

// ===========================================================================
// The fleet exclusion needs no configuration, and fails loudly when empty.
// ===========================================================================

Deno.test("trust - the Vibe Coders are excluded with no exclusion_team configured (Issues #1066, #1068)", async () => {
  // The hazard: the fleet accounts MUST hold write to push branches, so
  // "trust = collaborators" would hand them the right to direct work.
  // `exclusion_team` is unset on the live deployment and must not be needed.
  stubCollaborators({
    [REPO]: [
      collaborator("nleck"),
      collaborator("VibeCoderST"),
      collaborator("stservice"),
    ],
  });
  try {
    const config = liveShapedConfig();
    assertEquals(
      config.exclusionTeam,
      undefined,
      "this test is only meaningful with exclusion_team unset",
    );
    const trust = await refreshedTrust(config);
    for (const fleet of VIBE_CODERS) {
      assert(
        !trust.allowedAuthors.some(
          (a) => a.toLowerCase() === fleet.toLowerCase(),
        ),
        `${fleet} holds write access but is a Vibe Coder — it must never ` +
          `direct work; got ${JSON.stringify(trust.allowedAuthors)}`,
      );
    }
  } finally {
    _resetGhSpawnRunner();
    _resetDerivedAuthorsCache();
  }
});

Deno.test("trust - an empty fleet login set is a hard configuration error (Issues #1066, #1068)", () => {
  // With no `service_accounts` and no `fleet_pr_authors` there is nothing to
  // subtract from the collaborator set, so the Vibe Coders — which hold write
  // access by necessity — would be trusted to direct their own work. That
  // must stop the worker, not run it open. `setup.sh` has defaulted
  // `service_accounts` to the resolved worker login since Issue #4030, so a
  // host reaching this state was hand-edited into it.
  const config = buildDefaultWorkerConfig({
    repos: [REPO],
    serviceAccounts: [],
    fleetPrAuthors: [],
  });
  const err = assertThrows(() => validateConfig(config), Error);
  assert(
    /service_accounts/.test(err.message) &&
      /fleet_pr_authors/.test(err.message),
    `the error must name both keys the operator can fix; got: ${err.message}`,
  );
});

Deno.test("trust - service_accounts alone satisfies the fleet login set (Issues #1066, #1068)", () => {
  // A single-host deployment naming only its own service account is
  // legitimate — the check must not also demand `fleet_pr_authors`.
  validateConfig(
    buildDefaultWorkerConfig({
      repos: [REPO],
      serviceAccounts: ["solo-worker"],
      fleetPrAuthors: [],
    }),
  );
});

Deno.test("trust - a trusted human never joins the fleet-identity set (Issues #1064, #1066)", async () => {
  // `fleetAuthors` gates heartbeat-marker adoption and stale-assignment
  // recovery — "is this one of us?", never "may this person instruct us".
  // Folding the derived collaborator set into it would make a colleague's
  // assignment read as fleet occupancy, which is the #1064 shape.
  stubCollaborators({ [REPO]: tableCollaborators() });
  try {
    const config = liveShapedConfig();
    _resetDerivedAuthorsCache();
    const { deps: _deps, cleanup } = await createProductionRunCoreDeps({
      repoDir: "/tmp/test-repo-1066",
      workDir: "/tmp/test-work-1066",
      githubUser: "VibeCoderST",
      logger: testLogger,
      config,
    });
    try {
      assertEquals((await _deps.refreshTrustedAuthors!()).ok, true);
      const snapshot = recomputeDerivedTrust(
        {
          allowedAuthors: config.allowedAuthors,
          authorisedCommenters: config.authorisedCommenters,
        },
        { githubUser: "VibeCoderST", fleetPrAuthors: config.fleetPrAuthors },
      );
      assert(
        config.allowedAuthors.includes("alice"),
        "alice must be a trusted human for this test to mean anything",
      );
      assert(
        !snapshot.fleetAuthors.some((a) => a.toLowerCase() === "alice"),
        `a trusted human must never be a fleet identity; got ${
          JSON.stringify(snapshot.fleetAuthors)
        }`,
      );
      assertEquals(snapshot.fleetAuthors, snapshot.maintenanceAuthors);
      // The defer-to set is different by design: a human's open PR still
      // blocks a duplicate, so it keeps the trusted humans.
      assertEquals(snapshot.fleetPrAuthorInput.allowedAuthors, [
        ...config.allowedAuthors,
      ]);
    } finally {
      cleanup();
    }
  } finally {
    _resetGhSpawnRunner();
    _resetDerivedAuthorsCache();
  }
});

// ===========================================================================
// Migration — a config still carrying `author_source`.
// ===========================================================================

Deno.test("migration - a config still carrying author_source is refused, naming the edit (Issues #1066, #1068)", async () => {
  // The repo's established convention for a removed key (Issue #805): refuse
  // it rather than ignore it, because a setting that reads as live and does
  // nothing is the silent failure the config load exists to prevent. Safe
  // here because setup never wrote the key (Issue #1068), so no deployed host
  // carries it — and `./setup.sh` strips it if one does.
  const dir = await Deno.makeTempDir({ prefix: "vibe-trust-migration-" });
  const path = `${dir}/.config.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      repos: [REPO],
      allowed_authors: ["nleck", ...VIBE_CODERS],
      authorized_commenters: ["nleck", "github-copilot[bot]"],
      service_accounts: VIBE_CODERS,
      fleet_pr_authors: VIBE_CODERS,
      author_source: "config",
    }),
  );
  try {
    const err = await assertRejects(() => loadConfig(path), Error);
    assert(
      /author_source/.test(err.message) &&
        /[Rr]emove the key/.test(err.message),
      `the rejection must name the key and the edit; got: ${err.message}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migration - a live host's allowed_authors still loads, warned but never refused (Issues #1066, #1068)", async () => {
  // `allowed_authors` survives with a narrower purpose, so refusing it would
  // strand every deployed host for no gain.
  const dir = await Deno.makeTempDir({ prefix: "vibe-trust-migration-" });
  const path = `${dir}/.config.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      repos: [REPO],
      allowed_authors: ["nleck", ...VIBE_CODERS],
      service_accounts: VIBE_CODERS,
      fleet_pr_authors: VIBE_CODERS,
    }),
  );
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  _resetRemovedTrustKeyWarning();
  try {
    const config = await loadConfig(path, { validate: true });
    const loaded = config as unknown as Record<string, unknown>;
    assert(
      !("authorSource" in loaded),
      "author_source must be gone from the loaded configuration entirely",
    );
    assertEquals(
      config.allowedAuthors,
      [],
      "the local allowed_authors array must grant no right to direct work",
    );
    const joined = warnings.join("\n");
    assert(
      /allowed_authors/.test(joined) && /no longer grants/.test(joined),
      "the operator must be told what the key no longer does; " +
        `got: ${joined || "(no warning)"}`,
    );
  } finally {
    console.warn = originalWarn;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migration - authorized_commenters survives as the known-input allowlist (Issues #1066, #1068)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-trust-migration-" });
  const path = `${dir}/.config.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      repos: [REPO],
      allowed_authors: ["nleck", ...VIBE_CODERS],
      authorized_commenters: ["cursor[bot]"],
      service_accounts: VIBE_CODERS,
      fleet_pr_authors: VIBE_CODERS,
    }),
  );
  try {
    const config = await loadConfig(path);
    assert(
      config.authorisedCommenters.includes("cursor[bot]"),
      "the operator's known-input allowlist must still be read from the file",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migration - a config with no repos still fails, but never for allowed_authors (Issues #1066, #1068)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-trust-migration-" });
  const path = `${dir}/.config.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({ repos: [], service_accounts: VIBE_CODERS }),
  );
  try {
    const err = await assertRejects(
      () => loadConfig(path, { validate: true }),
      Error,
    );
    assert(
      !/allowed_authors is required/.test(err.message),
      `allowed_authors must no longer be a required key; got: ${err.message}`,
    );
    assert(/repos is required/.test(err.message), err.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ===========================================================================
// Composition — the whole trust path, from the file on disk outwards.
// ===========================================================================

Deno.test("trust composition - .config.json to claim decision, with real collaborators (Issues #1066, #1068)", async () => {
  _resetSuppressionAuthorAllowlist();
  _resetDerivedAuthorsCache();
  const dir = await Deno.makeTempDir({ prefix: "vibe-trust-composition-" });
  const path = `${dir}/.config.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      repos: [REPO, OTHER_REPO],
      // Exactly the live shape: a human and both Vibe Coders, no
      // author_source, no exclusion_team.
      allowed_authors: ["nleck", ...VIBE_CODERS],
      authorized_commenters: ["nleck", "github-copilot[bot]"],
      service_accounts: VIBE_CODERS,
      fleet_pr_authors: VIBE_CODERS,
    }),
  );
  // `carol` holds write on one repo only; `mallory` on neither.
  stubCollaborators({
    [REPO]: [
      collaborator("nleck"),
      collaborator("alice"),
      collaborator("carol"),
      collaborator("VibeCoderST"),
      collaborator("stservice"),
    ],
    [OTHER_REPO]: [
      collaborator("nleck"),
      collaborator("alice"),
      collaborator("VibeCoderST"),
    ],
  });
  try {
    const config = await loadConfig(path, { validate: true });
    const { deps, cleanup } = await createProductionRunCoreDeps({
      repoDir: "/tmp/test-repo-comp",
      workDir: "/tmp/test-work-comp",
      githubUser: "VibeCoderST",
      logger: testLogger,
      config,
    });
    try {
      // Before any refresh, the right to direct work is closed — never
      // seeded from the local array.
      assertEquals(
        config.allowedAuthors,
        [],
        "the construction-time seed must be empty, never the local array",
      );

      assertEquals((await deps.refreshTrustedAuthors!()).ok, true);

      const fleetWorkerLogins = [...VIBE_CODERS];
      const decisions: Array<[string, boolean]> = [];
      for (
        const actor of [
          "alice",
          "nleck",
          "carol",
          "mallory",
          "VibeCoderST",
          "stservice",
        ]
      ) {
        decisions.push([
          actor,
          await wasLabelAddedByAllowedAuthor(
            REPO,
            777,
            "work-on",
            config.allowedAuthors,
            () => Promise.resolve(timelineFor("work-on", actor)),
            undefined,
            fleetWorkerLogins,
          ),
        ]);
      }

      assertEquals(decisions, [
        // Write on both monitored repos, not a Vibe Coder.
        ["alice", true],
        ["nleck", true],
        // Write on one repo only — the fold is an intersection (Issue #256).
        ["carol", false],
        // No repository permission at all.
        ["mallory", false],
        // Write access, but Vibe Coders.
        ["VibeCoderST", false],
        ["stservice", false],
      ]);

      // The same set reaches the process-wide suppression allowlist, so this
      // is the composed snapshot rather than one call site's local view.
      const marker =
        "// orphan-deps-ignore: BP-abcdef — author=alice expires=2999-01-01 x";
      const [record] = findSuppressions(marker, "ts", {
        commitAuthors: ["alice"],
      });
      assert(
        record !== undefined && record.valid === true,
        "the derived set must reach every consumer of the snapshot",
      );
    } finally {
      cleanup();
    }
  } finally {
    _resetGhSpawnRunner();
    _resetDerivedAuthorsCache();
    _resetSuppressionAuthorAllowlist();
    await Deno.remove(dir, { recursive: true });
  }
});
