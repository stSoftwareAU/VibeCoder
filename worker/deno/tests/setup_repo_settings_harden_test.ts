/**
 * Setup's non-fatal repo-settings hardening step (Issue #2628).
 *
 * Every test drives the real `hardenRepo` (Issue #2626) through a stub `gh`
 * seam that behaves like a small GitHub: reads answer from per-repo state and
 * writes change it, so a second run sees what the first one wrote. The
 * CODEOWNERS writer (#2627) and the audit-issue closer (#2629) are injected
 * stubs, and every checkout lives under a temp `WORK_DIR`. Nothing touches
 * the network and nothing sleeps.
 *
 * Australian English throughout (behaviour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import {
  type CloseFixedFindingsFn,
  type CodeownersSyncResult,
  type RepoSettingsHardenDeps,
  runRepoSettingsHarden,
  type SyncCodeownersFn,
} from "../setup/repo_settings_harden_sync.ts";
import {
  hardenRepo,
  type HardenRepoOptions,
  SECRET_PROTECTION_SKIP_NOTE,
} from "../lib/repo_settings_harden.ts";
import { RUN_ALL_REPO_STEPS } from "../setup/setup_cli.ts";

// ---------------------------------------------------------------------------
// A stateful fake GitHub behind the gh seam
// ---------------------------------------------------------------------------

interface RecordedWrite {
  method: string;
  endpoint: string;
  body: Record<string, unknown>;
}

interface FakeRepo {
  visibility: "public" | "private";
  security: Record<string, { status: string }>;
  workflow: Record<string, unknown>;
  actions: Record<string, unknown>;
  selected: Record<string, unknown>;
  rulesets: Array<Record<string, unknown>>;
  /** Where CODEOWNERS sits on the default branch; an Error fails the read. */
  codeowners?: string | Error;
}

const NOT_FOUND = () => new Error("gh: Not Found (HTTP 404)");

/** A repo whose every surface has drifted from the hardened state. */
function driftedRepo(overrides: Partial<FakeRepo> = {}): FakeRepo {
  return {
    visibility: "public",
    security: {
      secret_scanning: { status: "disabled" },
      secret_scanning_push_protection: { status: "disabled" },
    },
    workflow: {
      default_workflow_permissions: "write",
      can_approve_pull_request_reviews: true,
    },
    actions: {
      enabled: true,
      allowed_actions: "selected",
      sha_pinning_required: false,
    },
    selected: {
      github_owned_allowed: true,
      verified_allowed: false,
      patterns_allowed: ["other/thing@*"],
    },
    rulesets: [{
      id: 7,
      name: "Vibe Coder default branch",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [
        {
          type: "pull_request",
          parameters: {
            require_code_owner_review: false,
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: true,
          },
        },
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "quality" }] },
        },
      ],
    }],
    codeowners: ".github/CODEOWNERS",
    ...overrides,
  };
}

/**
 * A gh seam over `repos`: each read answers from the repo's current state,
 * each write is recorded and applied, so the next run reads the result.
 */
function makeFakeGitHub(repos: Record<string, FakeRepo>) {
  const writes: RecordedWrite[] = [];
  const reads: string[] = [];

  const route = (endpoint: string): unknown => {
    for (const [slug, state] of Object.entries(repos)) {
      const base = `repos/${slug}`;
      if (endpoint === base) {
        return {
          visibility: state.visibility,
          private: state.visibility !== "public",
          security_and_analysis: state.security,
        };
      }
      if (endpoint === `${base}/actions/permissions/workflow`) {
        return state.workflow;
      }
      if (endpoint === `${base}/actions/permissions`) return state.actions;
      if (endpoint === `${base}/actions/permissions/selected-actions`) {
        return state.selected;
      }
      if (endpoint === `${base}/rules/branches/main`) {
        return state.rulesets
          .filter((r) => r["enforcement"] === "active")
          .flatMap((r) => r["rules"] as unknown[]);
      }
      if (endpoint === `${base}/rulesets`) {
        return state.rulesets.map((r) => ({
          id: r["id"],
          name: r["name"],
          target: r["target"],
          enforcement: r["enforcement"],
        }));
      }
      const ruleset = state.rulesets.find((r) =>
        endpoint === `${base}/rulesets/${r["id"]}`
      );
      if (ruleset) return ruleset;
      if (endpoint.startsWith(`${base}/contents/`)) {
        const path = endpoint.slice(`${base}/contents/`.length);
        if (state.codeowners instanceof Error) throw state.codeowners;
        if (path === state.codeowners) return { path };
      }
    }
    throw NOT_FOUND();
  };

  const apply = (
    method: string,
    endpoint: string,
    body: Record<string, unknown>,
  ) => {
    for (const [slug, state] of Object.entries(repos)) {
      const base = `repos/${slug}`;
      if (method === "PATCH" && endpoint === base) {
        const sec = body["security_and_analysis"] as FakeRepo["security"];
        state.security = { ...state.security, ...sec };
        return;
      }
      if (endpoint === `${base}/actions/permissions/workflow`) {
        state.workflow = { ...state.workflow, ...body };
        return;
      }
      if (endpoint === `${base}/actions/permissions`) {
        state.actions = { ...state.actions, ...body };
        return;
      }
      if (endpoint === `${base}/actions/permissions/selected-actions`) {
        state.selected = { ...state.selected, ...body };
        return;
      }
      const ruleset = state.rulesets.find((r) =>
        endpoint === `${base}/rulesets/${r["id"]}`
      );
      if (ruleset) {
        Object.assign(ruleset, body);
        return;
      }
    }
    throw new Error(`fake GitHub: unexpected write ${method} ${endpoint}`);
  };

  const gh = async (args: string[]): Promise<string> => {
    const m = args.indexOf("--method");
    if (m >= 0) {
      const method = args[m + 1] ?? "";
      const endpoint = args[m + 2] ?? "";
      const i = args.indexOf("--input");
      const body = i >= 0
        ? JSON.parse(await Deno.readTextFile(args[i + 1] ?? ""))
        : {};
      writes.push({ method, endpoint, body });
      apply(method, endpoint, body);
      return "{}";
    }
    if (args.includes("--jq") && args.includes(".default_branch")) {
      return "main";
    }
    const endpoint = args[1] ?? "";
    reads.push(endpoint);
    return JSON.stringify(route(endpoint));
  };
  return { gh, writes, reads };
}

// ---------------------------------------------------------------------------
// Temp WORK_DIR, unique repos, stubbed siblings
// ---------------------------------------------------------------------------

const TEMP_PATHS: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const path of TEMP_PATHS) {
    try {
      Deno.removeSync(path, { recursive: true });
    } catch { /* already gone */ }
  }
});

// Keeps the default-branch lookup off the worker's real disk cache.
const BRANCH_CACHE = await Deno.makeTempFile({ prefix: "vibe-harden-sync-" });
TEMP_PATHS.push(BRANCH_CACHE);

let counter = 0;
/** Unique per test: the default-branch lookup is memory-cached by repo. */
function uniqueRepo(): string {
  counter += 1;
  return `harden-sync/repo-${Date.now()}-${counter}`;
}

/** A temp WORK_DIR holding a checkout (one third-party action) per repo. */
async function makeWorkDir(repos: readonly string[]): Promise<string> {
  const workDir = await Deno.makeTempDir({ prefix: "vibe-harden-work-" });
  TEMP_PATHS.push(workDir);
  for (const repo of repos) {
    const dir = `${workDir}/${repo.split("/")[1]}`;
    await Deno.mkdir(`${dir}/.git`, { recursive: true });
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.github/workflows/ci.yml`,
      "jobs:\n  a:\n    steps:\n" +
        "      - uses: actions/checkout@0000000000000000000000000000000000000000\n" +
        "      - uses: acme/deploy-action@1111111111111111111111111111111111111111\n",
    );
  }
  return workDir;
}

interface Harness {
  deps: RepoSettingsHardenDeps;
  lines: string[];
  warnings: string[];
  events: string[];
  codeownersCalls: Array<{ repo: string; workDir: string }>;
  closerCalls: Array<{ repo: string; fleetLogins: readonly string[] }>;
}

function harness(
  gh: (args: string[]) => Promise<string>,
  workDir: string,
  overrides: Partial<RepoSettingsHardenDeps> = {},
  codeowners: CodeownersSyncResult = {
    status: "skipped",
    reason: "present at .github/CODEOWNERS",
  },
): Harness {
  const lines: string[] = [];
  const warnings: string[] = [];
  const events: string[] = [];
  const codeownersCalls: Harness["codeownersCalls"] = [];
  const closerCalls: Harness["closerCalls"] = [];
  const syncCodeowners: SyncCodeownersFn = async (opts) => {
    events.push(`codeowners ${opts.repo}`);
    codeownersCalls.push({ repo: opts.repo, workDir: opts.workDir });
    await opts.findOnDefaultBranch(opts.repo);
    return codeowners;
  };
  const closeFixedFindings: CloseFixedFindingsFn = (opts) => {
    events.push(`close ${opts.repo}`);
    closerCalls.push({ repo: opts.repo, fleetLogins: opts.fleetLogins });
    return Promise.resolve({ closed: [], warnings: [] });
  };
  const deps: RepoSettingsHardenDeps = {
    ghCommandFn: gh,
    workDir,
    owners: ["@nleck"],
    syncCodeowners,
    closeFixedFindings,
    hardenRepo: (repo: string, options: HardenRepoOptions) => {
      events.push(`harden ${repo}`);
      return hardenRepo(repo, options);
    },
    defaultBranchCachePath: BRANCH_CACHE,
    runLabel: "setup test run",
    log: (line) => lines.push(line),
    warn: (line) => warnings.push(line),
    ...overrides,
  };
  return { deps, lines, warnings, events, codeownersCalls, closerCalls };
}

/** Every key/value pair anywhere in a JSON value. */
function deepEntries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.flatMap(deepEntries);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap((
      [k, v],
    ) => [[k, v] as [string, unknown], ...deepEntries(v)]);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Drift: exactly the drifted writes, then none
// ---------------------------------------------------------------------------

Deno.test("runRepoSettingsHarden - a drifted repo gets exactly the drifted writes, and a second run makes none (Issue #2628)", async () => {
  const repo = uniqueRepo();
  const state = { [repo]: driftedRepo() };
  const { gh, writes } = makeFakeGitHub(state);
  const workDir = await makeWorkDir([repo]);
  const first = harness(gh, workDir);

  const ok = await runRepoSettingsHarden({ repos: [repo] }, first.deps);

  assertEquals(ok, true, [...first.lines, ...first.warnings].join("\n"));
  assertEquals(
    writes.map((w) => `${w.method} ${w.endpoint}`).sort(),
    [
      `PATCH repos/${repo}`,
      `PUT repos/${repo}/actions/permissions`,
      `PUT repos/${repo}/actions/permissions/selected-actions`,
      `PUT repos/${repo}/actions/permissions/workflow`,
      `PUT repos/${repo}/rulesets/7`,
    ],
  );
  // The allow-list is the existing list unioned with the workflow's action.
  assertEquals(state[repo]!.selected["patterns_allowed"], [
    "acme/deploy-action@*",
    "other/thing@*",
  ]);
  assertEquals(state[repo]!.workflow, {
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: false,
  });
  assertEquals(state[repo]!.actions["sha_pinning_required"], true);
  assertStringIncludes(
    first.lines.join("\n"),
    `${repo}: 5 applied, 0 unchanged, 0 skipped, 0 failed`,
  );

  writes.length = 0;
  const second = harness(gh, workDir);
  const again = await runRepoSettingsHarden({ repos: [repo] }, second.deps);

  assertEquals(again, true);
  assertEquals(writes, [], "a converged repo must see zero writes");
  assertStringIncludes(
    second.lines.join("\n"),
    `${repo}: 0 applied, 5 unchanged, 0 skipped, 0 failed`,
  );
});

Deno.test("runRepoSettingsHarden - a converged repo reads only, and the totals line follows the per-repo lines (Issue #2628)", async () => {
  const repo = uniqueRepo();
  const { gh, writes } = makeFakeGitHub({ [repo]: driftedRepo() });
  const workDir = await makeWorkDir([repo]);
  await runRepoSettingsHarden({ repos: [repo] }, harness(gh, workDir).deps);
  writes.length = 0;

  const h = harness(gh, workDir);
  await runRepoSettingsHarden({ repos: [repo] }, h.deps);

  assertEquals(writes.length, 0);
  const last = h.lines[h.lines.length - 1] ?? "";
  assertMatch(
    last,
    /^Repo-settings hardening: 0 applied, 5 unchanged, 0 skipped, 0 failed across 1 repo\(s\)/,
  );
});

// ---------------------------------------------------------------------------
// Never required approving reviews
// ---------------------------------------------------------------------------

Deno.test("runRepoSettingsHarden - no request ever sets required_approving_review_count above 0 (Issue #2628)", async () => {
  const repo = uniqueRepo();
  const { gh, writes } = makeFakeGitHub({ [repo]: driftedRepo() });
  const workDir = await makeWorkDir([repo]);
  const seen: HardenRepoOptions[] = [];
  const h = harness(gh, workDir, {
    hardenRepo: (r, options) => {
      seen.push(options);
      return hardenRepo(r, options);
    },
  });

  await runRepoSettingsHarden({ repos: [repo] }, h.deps);
  await runRepoSettingsHarden({ repos: [repo] }, h.deps);

  assert(writes.length > 0, "the drifted run must have written something");
  for (const write of writes) {
    for (const [key, value] of deepEntries(write.body)) {
      if (key !== "required_approving_review_count") continue;
      assert(
        typeof value === "number" && value <= 0,
        `${write.method} ${write.endpoint} sets ${key}=${value}`,
      );
    }
  }
  assertEquals(seen.map((o) => o.requireReviews === true), [false, false]);
  assertEquals(seen.map((o) => o.apply), [true, true]);
});

// ---------------------------------------------------------------------------
// Per-repo isolation
// ---------------------------------------------------------------------------

Deno.test("runRepoSettingsHarden - a repo whose hardenRepo throws never stops the next, and the step returns false (Issue #2628)", async () => {
  const broken = uniqueRepo();
  const healthy = uniqueRepo();
  const state = { [broken]: driftedRepo(), [healthy]: driftedRepo() };
  const { gh, writes } = makeFakeGitHub(state);
  const workDir = await makeWorkDir([broken, healthy]);
  const h = harness(gh, workDir, {
    hardenRepo: (repo, options) => {
      if (repo === broken) throw new Error("boom: rulesets unreachable");
      return hardenRepo(repo, options);
    },
  });

  const ok = await runRepoSettingsHarden({ repos: [broken, healthy] }, h.deps);

  assertEquals(ok, false);
  assert(writes.length > 0);
  assert(
    writes.every((w) => w.endpoint.startsWith(`repos/${healthy}`)),
    "only the healthy repo is written",
  );
  const out = [...h.lines, ...h.warnings].join("\n");
  assertStringIncludes(
    out,
    `${broken}: 0 applied, 0 unchanged, 0 skipped, 1 failed`,
  );
  assertStringIncludes(out, "boom: rulesets unreachable");
  assertStringIncludes(
    out,
    `${healthy}: 5 applied, 0 unchanged, 0 skipped, 0 failed`,
  );
  assertStringIncludes(out, "1 repo(s) failed");
});

Deno.test("runRepoSettingsHarden - a failed step inside hardenRepo is never swallowed into a true return (Issue #2628)", async () => {
  const repo = uniqueRepo();
  const { gh: inner } = makeFakeGitHub({ [repo]: driftedRepo() });
  const gh = (args: string[]) =>
    args.includes("--method") &&
      args.includes(`repos/${repo}/actions/permissions/workflow`)
      ? Promise.reject(new Error("HTTP 403: Resource not accessible"))
      : inner(args);
  const workDir = await makeWorkDir([repo]);
  const h = harness(gh, workDir);

  const ok = await runRepoSettingsHarden({ repos: [repo] }, h.deps);

  assertEquals(ok, false);
  const out = [...h.lines, ...h.warnings].join("\n");
  assertStringIncludes(
    out,
    `${repo}: 4 applied, 0 unchanged, 0 skipped, 1 failed`,
  );
  assertStringIncludes(out, "workflow-token");
  assertStringIncludes(out, "HTTP 403: Resource not accessible");
});

Deno.test("runRepoSettingsHarden - an invalid slug is a failed line, never a derived path (Issue #2628)", async () => {
  const good = uniqueRepo();
  const { gh } = makeFakeGitHub({ [good]: driftedRepo() });
  const workDir = await makeWorkDir([good]);
  const h = harness(gh, workDir);

  const ok = await runRepoSettingsHarden(
    { repos: ["../escape", good] },
    h.deps,
  );

  assertEquals(ok, false);
  assertEquals(h.codeownersCalls.map((c) => c.repo), [good]);
  assertStringIncludes(h.warnings.join("\n"), "invalid owner/repo slug");
});

// ---------------------------------------------------------------------------
// Private repositories
// ---------------------------------------------------------------------------

Deno.test("runRepoSettingsHarden - a private repo gets no secret-scanning write and its line reports the skip (Issue #2628)", async () => {
  const repo = uniqueRepo();
  const { gh, writes } = makeFakeGitHub({
    [repo]: driftedRepo({ visibility: "private" }),
  });
  const workDir = await makeWorkDir([repo]);
  const h = harness(gh, workDir);

  const ok = await runRepoSettingsHarden({ repos: [repo] }, h.deps);

  assertEquals(ok, true);
  assertEquals(
    writes.filter((w) =>
      w.method === "PATCH" || "security_and_analysis" in w.body
    ),
    [],
  );
  const line = h.lines.find((l) => l.startsWith(`${repo}:`)) ?? "";
  assertStringIncludes(line, "4 applied, 0 unchanged, 1 skipped, 0 failed");
  assertStringIncludes(line, SECRET_PROTECTION_SKIP_NOTE);
});

Deno.test("runRepoSettingsHarden - a public repo's secret-scanning write is made (Issue #2628)", async () => {
  const repo = uniqueRepo();
  const { gh, writes } = makeFakeGitHub({ [repo]: driftedRepo() });
  const workDir = await makeWorkDir([repo]);

  await runRepoSettingsHarden({ repos: [repo] }, harness(gh, workDir).deps);

  assertEquals(
    writes.filter((w) => w.method === "PATCH").map((w) => w.body),
    [{
      security_and_analysis: {
        secret_scanning: { status: "enabled" },
        secret_scanning_push_protection: { status: "enabled" },
      },
    }],
  );
});

// ---------------------------------------------------------------------------
// Code-owner review follows the default branch's CODEOWNERS
// ---------------------------------------------------------------------------

Deno.test("runRepoSettingsHarden - requireCodeOwnerReview is true only when the default branch has CODEOWNERS (Issue #2628)", async () => {
  const present = uniqueRepo();
  const docs = uniqueRepo();
  const absent = uniqueRepo();
  const unreadable = uniqueRepo();
  const { gh, reads } = makeFakeGitHub({
    [present]: driftedRepo({ codeowners: ".github/CODEOWNERS" }),
    [docs]: driftedRepo({ codeowners: "docs/CODEOWNERS" }),
    [absent]: driftedRepo({ codeowners: undefined }),
    [unreadable]: driftedRepo({
      codeowners: new Error("HTTP 502: Bad Gateway"),
    }),
  });
  const repos = [present, docs, absent, unreadable];
  const workDir = await makeWorkDir(repos);
  const seen: Record<string, boolean | undefined> = {};
  const h = harness(gh, workDir, {
    hardenRepo: (repo, options) => {
      seen[repo] = options.requireCodeOwnerReview;
      return hardenRepo(repo, options);
    },
  });

  await runRepoSettingsHarden({ repos }, h.deps);

  assertEquals(seen, {
    [present]: true,
    [docs]: true,
    [absent]: false,
    [unreadable]: false,
  });
  // The writer's lookup and the step's share one read per location.
  assertEquals(
    reads.filter((r) => r === `repos/${present}/contents/.github/CODEOWNERS`)
      .length,
    1,
  );
  const absentLine = h.lines.find((l) => l.startsWith(`${absent}:`)) ?? "";
  assertStringIncludes(absentLine, "1 skipped");
  assertStringIncludes(absentLine, "code-owner review: no CODEOWNERS");
});

Deno.test("runRepoSettingsHarden - a CODEOWNERS lookup that errors is reported, not taken as absent (Issue #2628)", async () => {
  const repo = uniqueRepo();
  const { gh } = makeFakeGitHub({
    [repo]: driftedRepo({ codeowners: new Error("HTTP 502: Bad Gateway") }),
  });
  const workDir = await makeWorkDir([repo]);
  const h = harness(gh, workDir);

  await runRepoSettingsHarden({ repos: [repo] }, h.deps);

  const line = h.lines.find((l) => l.startsWith(`${repo}:`)) ?? "";
  assertStringIncludes(line, "HTTP 502: Bad Gateway");
});

// ---------------------------------------------------------------------------
// Order and outcomes of the sibling steps
// ---------------------------------------------------------------------------

Deno.test("runRepoSettingsHarden - per repo: CODEOWNERS writer, then hardenRepo, then the audit closer (Issue #2628)", async () => {
  const a = uniqueRepo();
  const b = uniqueRepo();
  const { gh } = makeFakeGitHub({ [a]: driftedRepo(), [b]: driftedRepo() });
  const workDir = await makeWorkDir([a, b]);
  const h = harness(gh, workDir);

  await runRepoSettingsHarden(
    { repos: [a, b], service_accounts: ["fleet-bot"] },
    h.deps,
  );

  assertEquals(h.events, [
    `codeowners ${a}`,
    `harden ${a}`,
    `close ${a}`,
    `codeowners ${b}`,
    `harden ${b}`,
    `close ${b}`,
  ]);
  assertEquals(h.closerCalls.map((c) => c.fleetLogins), [
    ["fleet-bot"],
    ["fleet-bot"],
  ]);
  assertEquals(h.codeownersCalls.map((c) => c.workDir), [workDir, workDir]);
});

Deno.test("runRepoSettingsHarden - the CODEOWNERS outcome is on the repo's line (Issue #2628)", async () => {
  const repo = uniqueRepo();
  const { gh } = makeFakeGitHub({ [repo]: driftedRepo() });
  const workDir = await makeWorkDir([repo]);
  const h = harness(gh, workDir, {}, {
    status: "written",
    path: ".github/CODEOWNERS",
  });

  await runRepoSettingsHarden({ repos: [repo] }, h.deps);

  const line = h.lines.find((l) => l.startsWith(`${repo}:`)) ?? "";
  assertStringIncludes(line, "codeowners: written .github/CODEOWNERS");
});

Deno.test("runRepoSettingsHarden - a CODEOWNERS writer error fails the repo but still hardens it (Issue #2628)", async () => {
  const repo = uniqueRepo();
  const { gh, writes } = makeFakeGitHub({ [repo]: driftedRepo() });
  const workDir = await makeWorkDir([repo]);
  const h = harness(gh, workDir, {}, {
    status: "error",
    message: "EACCES writing .github/CODEOWNERS",
  });

  const ok = await runRepoSettingsHarden({ repos: [repo] }, h.deps);

  assertEquals(ok, false);
  assert(writes.length > 0, "hardening still runs");
  assertStringIncludes(
    [...h.lines, ...h.warnings].join("\n"),
    "codeowners: error EACCES writing .github/CODEOWNERS",
  );
});

Deno.test("runRepoSettingsHarden - the closer's warnings are printed and a closer throw never fails the step (Issue #2628)", async () => {
  const repo = uniqueRepo();
  const { gh } = makeFakeGitHub({ [repo]: driftedRepo() });
  const workDir = await makeWorkDir([repo]);
  const warned = harness(gh, workDir, {
    // The closer logs each warning as it goes and also returns it (#2629).
    closeFixedFindings: (opts) => {
      opts.log("could not close #13");
      return Promise.resolve({
        closed: [12],
        warnings: ["could not close #13"],
      });
    },
  });

  assertEquals(
    await runRepoSettingsHarden({ repos: [repo] }, warned.deps),
    true,
  );
  assertEquals(
    warned.warnings.filter((w) => w.includes("could not close #13")).length,
    1,
    "each closer warning is printed once, as a warning",
  );
  assertStringIncludes(warned.lines.join("\n"), "#12");

  const thrown = harness(gh, workDir, {
    closeFixedFindings: () => Promise.reject(new Error("search API down")),
  });
  assertEquals(
    await runRepoSettingsHarden({ repos: [repo] }, thrown.deps),
    true,
  );
  assertStringIncludes(thrown.warnings.join("\n"), "search API down");
});

Deno.test("runRepoSettingsHarden - no repos configured is a quiet success (Issue #2628)", async () => {
  const h = harness(() => Promise.reject(new Error("no gh")), "/nonexistent");
  assertEquals(await runRepoSettingsHarden({ repos: [] }, h.deps), true);
  assertEquals(h.events, []);
});

// ---------------------------------------------------------------------------
// runAll ordering
// ---------------------------------------------------------------------------

Deno.test("runAll - repo-settings-harden runs right after branch-protection-sync and before backfill-idle-task-labels (Issue #2628)", () => {
  const names = RUN_ALL_REPO_STEPS.map((s) => s.name);
  const harden = names.indexOf("repo-settings-harden");
  assert(harden > 0, `missing from runAll: ${names.join(", ")}`);
  assertEquals(names[harden - 1], "branch-protection-sync");
  assertEquals(names[harden + 1], "backfill-idle-task-labels");
});
