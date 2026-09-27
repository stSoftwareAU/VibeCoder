/**
 * Setup's non-fatal repo-settings hardening step (Issue #2628).
 *
 * Every test drives the real `hardenRepo` (Issue #2626) through a stub `gh`
 * seam that behaves like a small GitHub: reads answer from per-repo state and
 * writes change it, so a second run sees what the first one wrote. The
 * CODEOWNERS writer (#2627) and the audit-issue closer (#2629) are injected
 * stubs. The workflows are served through the contents API at the default
 * branch (Issue #2685), as GitHub does, so no checkout is involved. Nothing
 * touches the network and nothing sleeps.
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
import {
  DRY_RUN_SUBCOMMANDS,
  dryRunRefusal,
  reportFleetTokenScopes,
  RUN_ALL_REPO_STEPS,
} from "../setup/setup_cli.ts";

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
  /** Repository topics; `direct-push` opts the default branch out. */
  topics?: string[];
  /** Where CODEOWNERS sits on the default branch; an Error fails the read. */
  codeowners?: string | Error;
  /** Whether the gh identity holds admin (Issue #2685); default true. */
  admin?: boolean;
  /** Files on the default branch, by path (the workflows). */
  files?: Record<string, string>;
  /** `allow_merge_commit` (Issue #2690); absent from the read when unset. */
  allowMergeCommit?: boolean;
  /** Each account's repository role (Issue #2690). */
  collaborators?: Record<string, string>;
}

/** The login the fake GitHub says the gh identity is. */
const OPERATOR_LOGIN = "operator-admin";

/** One pinned workflow using one third-party action. */
const CI_WORKFLOW = "jobs:\n  a:\n    steps:\n" +
  "      - uses: actions/checkout@0000000000000000000000000000000000000000\n" +
  "      - uses: acme/deploy-action@1111111111111111111111111111111111111111\n";

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
    files: { ".github/workflows/ci.yml": CI_WORKFLOW },
    ...overrides,
  };
}

/** The contents-API answer for `path` on the default branch, if any. */
function contentsAt(state: FakeRepo, path: string): unknown {
  const files = state.files ?? {};
  if (path in files) return files[path];
  const entries = new Map<
    string,
    { name: string; path: string; type: string }
  >();
  for (const file of Object.keys(files)) {
    if (!file.startsWith(`${path}/`)) continue;
    const name = file.slice(path.length + 1).split("/")[0]!;
    const child = `${path}/${name}`;
    entries.set(child, {
      name,
      path: child,
      type: child === file ? "file" : "dir",
    });
  }
  if (entries.size === 0) throw NOT_FOUND();
  return [...entries.values()];
}

/**
 * A gh seam over `repos`: each read answers from the repo's current state,
 * each write is recorded and applied, so the next run reads the result.
 */
function makeFakeGitHub(
  repos: Record<string, FakeRepo>,
  orgOwners: readonly string[] = [],
) {
  const writes: RecordedWrite[] = [];
  const reads: string[] = [];

  const route = (endpoint: string): unknown => {
    if (endpoint === "user") return { login: OPERATOR_LOGIN };
    const membership = /^orgs\/[^/]+\/memberships\/([^/]+)$/.exec(endpoint);
    if (membership) {
      return orgOwners.includes(membership[1]!)
        ? { role: "admin", state: "active" }
        : { role: "member", state: "active" };
    }
    for (const [slug, state] of Object.entries(repos)) {
      const base = `repos/${slug}`;
      if (endpoint === base) {
        return {
          visibility: state.visibility,
          private: state.visibility !== "public",
          security_and_analysis: state.security,
          permissions: { admin: state.admin ?? true, push: true },
          ...(state.allowMergeCommit === undefined
            ? {}
            : { allow_merge_commit: state.allowMergeCommit }),
        };
      }
      const collaborator = new RegExp(
        `^${base}/collaborators/([^/]+)/permission$`,
      ).exec(endpoint);
      if (collaborator) {
        const role = state.collaborators?.[collaborator[1]!];
        if (role === undefined) throw NOT_FOUND();
        return { role_name: role };
      }
      if (
        endpoint.startsWith(`${base}/contents/`) &&
        endpoint.endsWith("?ref=main")
      ) {
        return contentsAt(
          state,
          endpoint.slice(`${base}/contents/`.length, -"?ref=main".length),
        );
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
          .flatMap((r) =>
            (r["rules"] as Array<Record<string, unknown>>).map((rule) => ({
              ...rule,
              ruleset_id: r["id"],
              ruleset_source_type: "Repository",
            }))
          );
      }
      if (endpoint === `${base}/topics`) return { names: state.topics ?? [] };
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
        if (sec) state.security = { ...state.security, ...sec };
        if (typeof body["allow_merge_commit"] === "boolean") {
          state.allowMergeCommit = body["allow_merge_commit"];
        }
        return;
      }
      const collaborator = endpoint.startsWith(`${base}/collaborators/`)
        ? endpoint.slice(`${base}/collaborators/`.length)
        : undefined;
      if (method === "PUT" && collaborator) {
        state.collaborators = {
          ...state.collaborators,
          [collaborator]: body["permission"] === "push" ? "write" : "?",
        };
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
      if (method === "POST" && endpoint === `${base}/rulesets`) {
        state.rulesets.push({ id: 100 + state.rulesets.length, ...body });
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
    const value = route(endpoint);
    // A string is a raw file body (`Accept: application/vnd.github.raw+json`).
    return typeof value === "string" ? value : JSON.stringify(value);
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

/**
 * A temp WORK_DIR for the CODEOWNERS writer. The allow-list no longer reads
 * it (Issue #2685), so it holds no workflows: an allow-list built from a
 * checkout would be missing `acme/deploy-action@*`.
 */
async function makeWorkDir(_repos: readonly string[]): Promise<string> {
  const workDir = await Deno.makeTempDir({ prefix: "vibe-harden-work-" });
  TEMP_PATHS.push(workDir);
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
    `${repo}: 6 applied, 0 unchanged, 0 skipped, 0 failed`,
  );

  writes.length = 0;
  const second = harness(gh, workDir);
  const again = await runRepoSettingsHarden({ repos: [repo] }, second.deps);

  assertEquals(again, true);
  assertEquals(writes, [], "a converged repo must see zero writes");
  assertStringIncludes(
    second.lines.join("\n"),
    `${repo}: 0 applied, 6 unchanged, 0 skipped, 0 failed`,
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
    /^Repo-settings hardening: 0 applied, 6 unchanged, 0 skipped, 0 failed across 1 repo\(s\)/,
  );
});

// ---------------------------------------------------------------------------
// One required approval on the default branch (Issue #2680)
// ---------------------------------------------------------------------------

Deno.test("runRepoSettingsHarden - the default branch ends requiring one approval, with code-owner review and the other pull_request parameters kept (Issue #2680)", async () => {
  const repo = uniqueRepo();
  const state = { [repo]: driftedRepo() };
  const { gh } = makeFakeGitHub(state);
  const workDir = await makeWorkDir([repo]);

  await runRepoSettingsHarden({ repos: [repo] }, harness(gh, workDir).deps);

  const rules = state[repo]!.rulesets[0]!["rules"] as Array<
    { type: string; parameters?: Record<string, unknown> }
  >;
  assertEquals(rules.find((r) => r.type === "pull_request")?.parameters, {
    require_code_owner_review: true,
    required_approving_review_count: 1,
    dismiss_stale_reviews_on_push: true,
  });
});

Deno.test("runRepoSettingsHarden - a direct-push default branch gets no ruleset write, and its line says why for the owner (Issue #2680)", async () => {
  const repo = uniqueRepo();
  const state = {
    [repo]: driftedRepo({
      rulesets: [],
      topics: ["direct-push"],
      codeowners: undefined,
    }),
  };
  const { gh, writes } = makeFakeGitHub(state);
  const workDir = await makeWorkDir([repo]);
  const h = harness(gh, workDir);

  await runRepoSettingsHarden({ repos: [repo] }, h.deps);

  assert(
    !writes.some((w) => w.endpoint.includes("/rulesets")),
    writes.map((w) => `${w.method} ${w.endpoint}`).join("\n"),
  );
  assertEquals(state[repo]!.rulesets, []);
  const line = h.lines.find((l) => l.startsWith(`${repo}:`)) ?? "";
  assertStringIncludes(line, "skipped: default-branch-approval: direct-push");
  assertStringIncludes(line, "the owner decides");
});

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
    `${healthy}: 6 applied, 0 unchanged, 0 skipped, 0 failed`,
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
    `${repo}: 5 applied, 0 unchanged, 0 skipped, 1 failed`,
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
  assertStringIncludes(line, "5 applied, 0 unchanged, 1 skipped, 0 failed");
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

// ---------------------------------------------------------------------------
// Admin identity, and a dry run that writes nothing (Issue #2685)
// ---------------------------------------------------------------------------

/** Any argv that would change something on GitHub. */
function isWrite(args: readonly string[]): boolean {
  const method = args.indexOf("--method");
  if (method >= 0 && args[method + 1] !== "GET") return true;
  if (args.includes("-X") || args.includes("--input")) return true;
  if (args.some((a) => /^-[fF]$|^--(raw-)?field$/.test(a))) return true;
  // Everything but `gh api <read>` (issue close, pr comment, label edit, …).
  return args[0] !== "api";
}

Deno.test("runRepoSettingsHarden - a dry run performs no write, runs no CODEOWNERS writer or closer, and reports what it would apply (Issue #2685)", async () => {
  const repo = uniqueRepo();
  const state = { [repo]: driftedRepo() };
  const before = structuredClone(state);
  const { gh: inner } = makeFakeGitHub(state);
  const attempted: string[] = [];
  const gh = (args: string[]): Promise<string> => {
    if (isWrite(args)) {
      attempted.push(args.join(" "));
      return Promise.reject(new Error(`dry run wrote: ${args.join(" ")}`));
    }
    return inner(args);
  };
  const h = harness(gh, await makeWorkDir([repo]), { dryRun: true });

  const ok = await runRepoSettingsHarden({ repos: [repo] }, h.deps);

  assertEquals(attempted, [], "a dry run must not attempt a single write");
  assertEquals(state, before);
  assertEquals(ok, true, [...h.lines, ...h.warnings].join("\n"));
  assertEquals(h.codeownersCalls, [], "the CODEOWNERS writer writes a file");
  assertEquals(h.closerCalls, [], "the closer comments on and closes issues");
  const line = h.lines.find((l) => l.startsWith(`${repo}:`)) ?? "";
  assertStringIncludes(line, "6 planned, 0 unchanged, 0 skipped, 0 failed");
  assertStringIncludes(line, "workflow-token");
  assertStringIncludes(line, "codeowners: skipped (dry run)");
  assertStringIncludes(h.lines.join("\n"), "dry run");
});

Deno.test("runRepoSettingsHarden - says which login it runs as, and that it is not the fleet account (Issue #2685)", async () => {
  const repo = uniqueRepo();
  const { gh } = makeFakeGitHub({ [repo]: driftedRepo() });
  const h = harness(gh, await makeWorkDir([repo]));

  await runRepoSettingsHarden({ repos: [repo] }, h.deps);

  const first = h.lines[0] ?? "";
  assertStringIncludes(first, OPERATOR_LOGIN);
  assertStringIncludes(first, "gh_config_dir");
});

Deno.test("runRepoSettingsHarden - without admin, repos are left alone and 'needs an admin login' is said once, with no raw 403 or 404 (Issue #2685)", async () => {
  const a = uniqueRepo();
  const b = uniqueRepo();
  const admin = uniqueRepo();
  const { gh, writes, reads } = makeFakeGitHub({
    [a]: driftedRepo({ admin: false }),
    [b]: driftedRepo({ admin: false }),
    [admin]: driftedRepo(),
  });
  const h = harness(gh, await makeWorkDir([a, b, admin]));

  const ok = await runRepoSettingsHarden({ repos: [a, b, admin] }, h.deps);

  assertEquals(ok, false);
  const out = [...h.lines, ...h.warnings].join("\n");
  assertEquals(out.split("needs an admin login").length - 1, 1, out);
  const notice = h.warnings.find((w) => w.includes("needs an admin login"));
  assertStringIncludes(notice ?? "", a);
  assertStringIncludes(notice ?? "", b);
  assertStringIncludes(notice ?? "", OPERATOR_LOGIN);
  assert(!/HTTP 40[34]/.test(out), out);
  // The non-admin repos are not touched past the one permission read.
  for (const repo of [a, b]) {
    assert(
      !reads.some((r) => r.startsWith(`repos/${repo}/`)),
      reads.filter((r) => r.startsWith(`repos/${repo}/`)).join("\n"),
    );
    assert(!writes.some((w) => w.endpoint.startsWith(`repos/${repo}`)));
  }
  assertEquals(h.codeownersCalls.map((c) => c.repo), [admin]);
  assert(writes.some((w) => w.endpoint.startsWith(`repos/${admin}`)));
});

// ---------------------------------------------------------------------------
// --dry-run is refused by a subcommand that cannot honour it (Issue #2685)
// ---------------------------------------------------------------------------

Deno.test("dryRunRefusal - a subcommand that would write for real refuses --dry-run; one that honours it runs (Issue #2685)", () => {
  for (
    const subcommand of [
      "all",
      "workflow-sync",
      "best-practices-sync",
      "gitignore-sync",
      "verify-monitored-collaborator",
      "branch-protection-sync",
      "backfill-idle-task-labels",
      "config",
      "hooks",
    ]
  ) {
    const refusal = dryRunRefusal(subcommand);
    assert(refusal, `${subcommand} must refuse --dry-run`);
    assertStringIncludes(refusal, subcommand);
    assertStringIncludes(refusal, "nothing was run");
  }
  for (const subcommand of DRY_RUN_SUBCOMMANDS) {
    assertEquals(dryRunRefusal(subcommand), undefined, subcommand);
  }
  assert(DRY_RUN_SUBCOMMANDS.includes("repo-settings-harden"));
});

// ---------------------------------------------------------------------------
// The fleet works without admin (Issue #2690)
// ---------------------------------------------------------------------------

Deno.test("reportFleetTokenScopes - a fleet token without workflow is reported with the exact refresh command for its config dir, and fails (Issue #2690)", async () => {
  const warnings: string[] = [];
  const asked: Array<{ args: string[]; dir?: string }> = [];
  const ok = await reportFleetTokenScopes("/h/.config/gh-vibe", {
    runGh: (args, dir) => {
      asked.push({ args, ...(dir ? { dir } : {}) });
      return Promise.resolve({
        success: true,
        output: "github.com\n  - Token: gho_****\n" +
          "  - Token scopes: 'read:org', 'repo'",
      });
    },
    log: () => {},
    warn: (line) => warnings.push(line),
  });
  assertEquals(ok, false);
  assertEquals(asked, [{
    args: ["auth", "status", "-h", "github.com"],
    dir: "/h/.config/gh-vibe",
  }]);
  const text = warnings.join("\n");
  assertStringIncludes(text, "workflow");
  assertStringIncludes(
    text,
    'GH_CONFIG_DIR="/h/.config/gh-vibe" gh auth refresh -h github.com -s workflow',
  );
});

Deno.test("reportFleetTokenScopes - a complete or fine-grained token passes without a warning (Issue #2690)", async () => {
  for (
    const output of [
      "  - Token: gho_****\n  - Token scopes: 'read:org', 'repo', 'workflow'",
      "  - Token: github_pat_****\n  - Token scopes: none",
    ]
  ) {
    const warnings: string[] = [];
    const ok = await reportFleetTokenScopes(undefined, {
      runGh: () => Promise.resolve({ success: true, output }),
      log: () => {},
      warn: (line) => warnings.push(line),
    });
    assertEquals([ok, warnings], [true, []], output);
  }
});

/** A squash-only repo (merge commits off) whose default rule allows all. */
function squashOnlyRepo(overrides: Partial<FakeRepo> = {}): FakeRepo {
  const repo = driftedRepo(overrides);
  const pr = (repo.rulesets[0]!["rules"] as Array<
    { type: string; parameters: Record<string, unknown> }
  >)[0]!;
  pr.parameters["allowed_merge_methods"] = ["merge", "squash", "rebase"];
  repo.rulesets.push({
    id: 8,
    name: "Vibe Coder milestone branches",
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: { include: ["refs/heads/milestone/**"], exclude: [] },
    },
    rules: [{ type: "deletion" }],
  });
  return { allowMergeCommit: false, ...repo, ...overrides };
}

function pullRequestRule(state: FakeRepo) {
  return (state.rulesets[0]!["rules"] as Array<
    { type: string; parameters: Record<string, unknown> }
  >).find((r) => r.type === "pull_request")!.parameters;
}

Deno.test("runRepoSettingsHarden - a squash-only repo ends with merge commits allowed, the default branch squash-only and the milestone ruleset untouched; a second run writes nothing (Issue #2690)", async () => {
  const repo = uniqueRepo();
  const state = { [repo]: squashOnlyRepo() };
  const milestoneBefore = structuredClone(state[repo]!.rulesets[1]);
  const { gh, writes } = makeFakeGitHub(state);
  const workDir = await makeWorkDir([repo]);

  const ok = await runRepoSettingsHarden(
    { repos: [repo] },
    harness(gh, workDir).deps,
  );

  assertEquals(ok, true);
  assertEquals(state[repo]!.allowMergeCommit, true);
  const rule = pullRequestRule(state[repo]!);
  assertEquals(rule["allowed_merge_methods"], ["squash"]);
  assertEquals(rule["required_approving_review_count"], 1);
  assertEquals(state[repo]!.rulesets[1], milestoneBefore);
  // The default branch is squash-only before merge commits are switched on.
  const order = writes.map((w) => `${w.method} ${w.endpoint}`);
  const merge = writes.findIndex((w) =>
    w.method === "PATCH" && "allow_merge_commit" in w.body
  );
  assert(
    merge > order.indexOf(`PUT repos/${repo}/rulesets/7`),
    order.join("\n"),
  );

  writes.length = 0;
  await runRepoSettingsHarden({ repos: [repo] }, harness(gh, workDir).deps);
  assertEquals(writes, [], "a converged repo must see zero writes");
});

Deno.test("runRepoSettingsHarden - fleet accounts end at write, and an organisation owner is reported once with the setting to change, never written (Issue #2690)", async () => {
  const [a, b] = [uniqueRepo(), uniqueRepo()];
  const collaborators = { VibeCoderST: "admin", stservice: "admin" };
  const state = {
    [a]: driftedRepo({ collaborators: { ...collaborators } }),
    [b]: driftedRepo({ collaborators: { ...collaborators } }),
  };
  const { gh, writes } = makeFakeGitHub(state, ["stservice"]);
  const h = harness(gh, await makeWorkDir([a, b]));

  await runRepoSettingsHarden({
    repos: [a, b],
    fleet_pr_authors: ["VibeCoderST", "stservice"],
    service_accounts: ["stservice"],
  }, h.deps);

  for (const repo of [a, b]) {
    assertEquals(state[repo]!.collaborators, {
      VibeCoderST: "write",
      stservice: "admin",
    });
  }
  assert(!writes.some((w) => w.endpoint.includes("stservice")));
  const owner = h.warnings.filter((w) => w.includes("stservice"));
  assertEquals(owner.length, 1, h.warnings.join("\n"));
  assertStringIncludes(
    owner[0]!,
    "https://github.com/orgs/harden-sync/people",
  );
  assertStringIncludes(owner[0]!, "Member");
});

Deno.test("runRepoSettingsHarden - a dry run plans the merge-commit, squash-only and fleet changes and writes none of them (Issue #2690)", async () => {
  const repo = uniqueRepo();
  const state = {
    [repo]: squashOnlyRepo({ collaborators: { VibeCoderST: "admin" } }),
  };
  const attempted: string[] = [];
  const { gh: real } = makeFakeGitHub(state);
  const gh = (args: string[]) => {
    if (args.includes("--method")) {
      attempted.push(args.join(" "));
      return Promise.reject(new Error(`dry run wrote: ${args.join(" ")}`));
    }
    return real(args);
  };
  const h = harness(gh, await makeWorkDir([repo]), { dryRun: true });

  await runRepoSettingsHarden({
    repos: [repo],
    service_accounts: ["VibeCoderST"],
  }, h.deps);

  assertEquals(attempted, []);
  const line = h.lines.find((l) => l.startsWith(`${repo}:`)) ?? "";
  for (
    const kind of [
      "default-branch-approval",
      "merge-commit-allowed",
      "fleet-account-write",
    ]
  ) {
    assertStringIncludes(line, kind);
  }
});
