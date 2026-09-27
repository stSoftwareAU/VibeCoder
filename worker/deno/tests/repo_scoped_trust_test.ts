/**
 * Repository-scoped trust (Issue #2734).
 *
 * A host monitoring two organisations whose writers share nobody folds the
 * fleet-wide trusted set to nothing. Each repository must still honour its own
 * writers' `work-on`, a writer on the other organisation must stay untrusted,
 * a genuinely untrusted adder must still be flagged `needs-human`, and a repository the
 * resolve never listed falls back to the fleet-wide intersection.
 *
 * Drives the real collectors end to end with a mocked `gh`.
 *
 * Uses Australian English spelling (behaviour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { collectWorkOnCandidates } from "../lib/collect_work_on_candidates.ts";
import { findIssuesByLabel } from "../lib/find_issues_by_label.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  createIssueFetcher,
  type FindIssuesOptions,
} from "../lib/issue_finder_common.ts";
import {
  allowedAuthorsByRepoFrom,
  trustedAuthorsFor,
} from "../lib/trust_snapshot.ts";
import {
  formatDisjointTrustWarning,
  intersectDerivedAuthors,
  type TrustedAuthors,
} from "../lib/derived_authors.ts";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import type { WorkerConfig } from "../types.ts";

const REPO_A = "orgA/repoA";
const REPO_B = "orgB/repoB";
/** Monitored, but absent from the per-repo map (skipped as unlistable). */
const REPO_C = "orgC/repoC";

function trusted(...logins: string[]): TrustedAuthors {
  return { allowedAuthors: logins, authorisedCommenters: logins };
}

/** alice writes only on A, carol only on B; dave is the fleet-wide floor. */
function twoOrgConfig(fleetWide: string[] = []): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: [REPO_A, REPO_B, REPO_C],
    allowedAuthors: fleetWide,
    allowedAuthorsByRepo: allowedAuthorsByRepoFrom(
      new Map([[REPO_A, trusted("alice")], [REPO_B, trusted("carol")]]),
    ),
    workOnLabel: "work-on",
    workDir: Deno.makeTempDirSync({ prefix: "repo-scoped-trust-workdir-" }),
  };
}

interface Recorder {
  /** `work-on` removed, or the issue handed to a human as untrusted. */
  flagged: Array<{ repo: string; issue: number }>;
}

/** One open `work-on` issue #50 in `repo`, labelled by `adder`. */
function mockGh(
  repo: string,
  adder: string,
  recorder: Recorder,
): (args: string[]) => Promise<string> {
  const listEntry = {
    number: 50,
    title: "Scoped trust issue",
    url: `https://github.com/${repo}/issues/50`,
    assignees: [],
    labels: [{ name: "work-on" }],
    createdAt: "2026-09-27T00:00:00Z",
    author: { login: "outsider" },
    milestone: null,
    body: "Some body",
  };
  const timeline = [{
    event: "labeled",
    label: { name: "work-on" },
    actor: { login: adder },
    created_at: "2026-09-27T00:00:00Z",
  }];
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify([listEntry]));
    }
    if (command.includes("timeline") || command.includes("timelineItems")) {
      return Promise.resolve(JSON.stringify(timeline));
    }
    if (command.includes("/comments")) return Promise.resolve("[]");
    if (
      args[0] === "issue" && args[1] === "edit" &&
      (args.includes("--remove-label") ||
        args[args.indexOf("--add-label") + 1] === "needs-human")
    ) {
      const repoIdx = args.indexOf("--repo");
      recorder.flagged.push({
        repo: repoIdx >= 0 ? args[repoIdx + 1]! : repo,
        issue: Number(args[2]),
      });
      return Promise.resolve("");
    }
    return Promise.resolve("[]");
  };
}

async function collect(
  config: WorkerConfig,
  repo: string,
  adder: string,
): Promise<{ selected: number; flagged: Recorder["flagged"] }> {
  const recorder: Recorder = { flagged: [] };
  const gh = mockGh(repo, adder, recorder);
  const options: FindIssuesOptions = {
    githubUser: "bot",
    ghCommandFn: gh,
    cache: new IssueCache(
      Deno.makeTempDirSync({ prefix: "repo-scoped-trust-cache-" }),
      600,
    ),
  };
  const result = await collectWorkOnCandidates(
    repo,
    config,
    options,
    [],
    [],
    createIssueFetcher(gh),
    [],
  );
  return { selected: result.candidates.length, flagged: recorder.flagged };
}

Deno.test("repo-scoped trust - each organisation's own writer's work-on is honoured and not flagged, though the intersection is empty (Issue #2734)", async () => {
  for (const [repo, adder] of [[REPO_A, "alice"], [REPO_B, "carol"]]) {
    const { selected, flagged } = await collect(twoOrgConfig(), repo!, adder!);
    assertEquals(selected, 1, `${adder} on ${repo} must be honoured`);
    assertEquals(
      flagged,
      [],
      `${adder}'s work-on on ${repo} must not be flagged`,
    );
  }
});

Deno.test("repo-scoped trust - a writer on repo B only is still untrusted on repo A (Issue #2734)", async () => {
  const { selected, flagged } = await collect(twoOrgConfig(), REPO_A, "carol");
  assertEquals(selected, 0);
  assertEquals(flagged.length, 1, "flagged needs-human as untrusted");
});

Deno.test("repo-scoped trust - a genuinely untrusted adder is still flagged needs-human (Issue #2734)", async () => {
  const { selected, flagged } = await collect(
    twoOrgConfig(),
    REPO_B,
    "mallory",
  );
  assertEquals(selected, 0);
  assertEquals(flagged.length, 1, "flagged needs-human as untrusted");
});

Deno.test("repo-scoped trust - a repo missing from the per-repo map falls back to the fleet-wide intersection (Issue #2734)", async () => {
  const floor = await collect(twoOrgConfig(["dave"]), REPO_C, "dave");
  assertEquals(floor.selected, 1, "the intersection's login is trusted");
  assertEquals(floor.flagged, []);

  const other = await collect(twoOrgConfig(["dave"]), REPO_C, "alice");
  assertEquals(other.selected, 0, "a writer elsewhere is not widened onto C");
});

Deno.test("repo-scoped trust - findIssuesByLabel honours each repo's own label adder only (Issue #2734)", async () => {
  const found = async (repo: string, adder: string) => {
    const gh = mockGh(repo, adder, { flagged: [] });
    const result = await findIssuesByLabel(
      { ...twoOrgConfig(), repos: [repo] },
      "work-on",
      false,
      {
        githubUser: "bot",
        ghCommandFn: gh,
        cache: new IssueCache(
          Deno.makeTempDirSync({ prefix: "repo-scoped-trust-find-" }),
          600,
        ),
      },
    );
    return result.found;
  };
  assertEquals(await found(REPO_A, "alice"), true);
  assertEquals(await found(REPO_B, "carol"), true);
  assertEquals(await found(REPO_A, "carol"), false);
  assertEquals(await found(REPO_B, "mallory"), false);
});

Deno.test("trustedAuthorsFor - the repo's own set, case-insensitively, else the intersection (Issue #2734)", () => {
  const config = twoOrgConfig(["dave"]);
  assertEquals(trustedAuthorsFor(config, "ORGA/REPOA"), ["alice"]);
  assertEquals(trustedAuthorsFor(config, REPO_B), ["carol"]);
  assertEquals(trustedAuthorsFor(config, REPO_C), ["dave"]);
  assertEquals(
    trustedAuthorsFor({ allowedAuthors: ["dave"] }, REPO_A),
    ["dave"],
  );
});

Deno.test("formatDisjointTrustWarning - names the organisations that share no writer when the intersection is empty (Issue #2734)", () => {
  const byRepo = new Map([
    [REPO_A, trusted("alice")],
    ["orgA/other", trusted("alice", "bob")],
    [REPO_B, trusted("carol")],
  ]);
  const warning = formatDisjointTrustWarning(
    byRepo,
    intersectDerivedAuthors(byRepo),
  );
  assertEquals(typeof warning, "string");
  for (const org of ["orgA", "orgB"]) {
    assertEquals(warning!.includes(org), true, `names ${org}: ${warning}`);
  }
});

Deno.test("formatDisjointTrustWarning - silent when a writer is shared, or no repo trusts anyone (Issue #2734)", () => {
  const shared = new Map([
    [REPO_A, trusted("alice")],
    [REPO_B, trusted("alice", "carol")],
  ]);
  assertEquals(
    formatDisjointTrustWarning(shared, intersectDerivedAuthors(shared)),
    null,
  );
  const nobody = new Map([[REPO_A, trusted()], [REPO_B, trusted()]]);
  assertEquals(
    formatDisjointTrustWarning(nobody, intersectDerivedAuthors(nobody)),
    null,
  );
});

/** Production deps whose resolver returns `byRepo`; captures the log lines. */
async function refreshedDeps(byRepo: Map<string, TrustedAuthors>) {
  const lines: string[] = [];
  const config = buildDefaultWorkerConfig({
    repos: [...byRepo.keys()],
    serviceAccounts: ["host-bot"],
  });
  const { deps, cleanup } = await createProductionRunCoreDeps({
    repoDir: "/tmp/test-repo-2734",
    workDir: "/tmp/test-work-2734",
    githubUser: "host-bot",
    logger: createLogger({ write: (line) => lines.push(line) }),
    config,
    resolveTrustedAuthors: () => Promise.resolve({ ok: true, byRepo }),
  });
  return { deps, cleanup, config, lines };
}

Deno.test("production deps - disjoint organisations keep working each repo with its own set, and WARN once (Issue #2734)", async () => {
  const { deps, cleanup, config, lines } = await refreshedDeps(
    new Map([[REPO_A, trusted("alice")], [REPO_B, trusted("carol")]]),
  );
  try {
    assertEquals((await deps.refreshTrustedAuthors!()).ok, true);
    assertEquals((await deps.refreshTrustedAuthors!()).ok, true);

    assertEquals(config.allowedAuthors, [], "fleet-wide stays the floor");
    assertEquals(trustedAuthorsFor(config, REPO_A), ["alice"]);
    assertEquals(trustedAuthorsFor(config, REPO_B), ["carol"]);

    const warnings = lines.filter((l) =>
      l.includes("WARN") && l.includes("share no writer")
    );
    assertEquals(warnings.length, 1, `one WARNING, got: ${warnings}`);
    assertEquals(warnings[0]!.includes("orgA and orgB"), true, warnings[0]);
  } finally {
    cleanup();
  }
});

Deno.test("production deps - a shared writer raises no disjoint-writers WARNING (Issue #2734)", async () => {
  const { deps, cleanup, config, lines } = await refreshedDeps(
    new Map([[REPO_A, trusted("alice")], [REPO_B, trusted("alice", "carol")]]),
  );
  try {
    assertEquals((await deps.refreshTrustedAuthors!()).ok, true);
    assertEquals(config.allowedAuthors, ["alice"]);
    assertEquals(trustedAuthorsFor(config, REPO_A), ["alice"]);
    assertEquals(
      lines.filter((l) => l.includes("share no writer")).length,
      0,
    );
  } finally {
    cleanup();
  }
});
