/**
 * Tests for lib/default_branch_ruleset.ts — ruleset-only default-branch
 * enforcement (Issue #4163) and the direct-push guard (Issue #4356).
 *
 * Every test drives the real `ensureDefaultBranchRuleset` through an injected
 * `gh` executor and asserts on the returned result and the recorded calls.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  ensureDefaultBranchRuleset,
  planDefaultBranchRuleset,
  VIBE_RULESET_NAME,
} from "../lib/default_branch_ruleset.ts";
import {
  DIRECT_PUSH_SAMPLE_SIZE,
  NO_RULESET_MARKER_PATH,
} from "../lib/branch_push_policy.ts";
import type { GhExec } from "../lib/repo_rulesets.ts";

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

interface GhCall {
  method: string;
  endpoint: string;
  body?: string;
}

/** One sampled default-branch commit. */
interface FakeCommit {
  sha: string;
  subject: string;
  /** PRs `GET /commits/{sha}/pulls` returns; `merged` marks `merged_at`. */
  pulls?: Array<{ number: number; merged: boolean }>;
}

/** A squash-merged commit — the ordinary shape of a PR-driven branch. */
const PR_COMMIT: FakeCommit = {
  sha: "aaaaaaa1",
  subject: "fix: something useful (#12)",
};

interface RepoState {
  /** Repository rulesets as the list endpoint returns them. */
  rulesets?: Array<{ id: number; name: string; source_type?: string }>;
  /** Rules applying to the default branch. */
  branchRules?: Array<Record<string, unknown>>;
  /** True when a legacy classic protection rule still exists. */
  classic?: boolean;
  /** Check-run names keyed by ref (branch name or SHA). */
  checkRuns?: Record<string, string[]>;
  /** Legacy commit-status contexts keyed by ref. */
  statuses?: Record<string, string[]>;
  /** Head SHA of the latest closed PR, when there is one. */
  latestPrSha?: string;
  /** Recent default-branch commits, newest first (default: PR-only). */
  commits?: FakeCommit[];
  /** Repository topics. */
  topics?: string[];
  /** True when `.vibe/no-default-branch-ruleset` exists at the branch head. */
  marker?: boolean;
  /** When set, the commit-list read fails with this message. */
  commitsError?: string;
}

function makeGh(state: RepoState): { gh: GhExec; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const gh: GhExec = (args, stdin) => {
    const isVerb = args[1] === "-X";
    const method = isVerb ? String(args[2]) : "GET";
    const endpoint = String(isVerb ? args[3] : args[1]);
    calls.push({ method, endpoint, body: stdin });

    if (method !== "GET") return Promise.resolve("");

    if (/\/topics$/.test(endpoint)) {
      return Promise.resolve(JSON.stringify({ names: state.topics ?? [] }));
    }
    if (endpoint.includes(`/contents/${NO_RULESET_MARKER_PATH}`)) {
      return state.marker
        ? Promise.resolve(JSON.stringify({ path: NO_RULESET_MARKER_PATH }))
        : Promise.reject(new Error("gh failed: Not Found (HTTP 404)"));
    }
    if (/\/commits\?sha=/.test(endpoint)) {
      if (state.commitsError) {
        return Promise.reject(new Error(state.commitsError));
      }
      const commits = state.commits ?? [PR_COMMIT];
      return Promise.resolve(
        JSON.stringify(
          commits.map((c) => ({ sha: c.sha, commit: { message: c.subject } })),
        ),
      );
    }
    const pullsMatch = endpoint.match(/\/commits\/([^/]+)\/pulls$/);
    if (pullsMatch) {
      const commit = (state.commits ?? [PR_COMMIT]).find((c) =>
        c.sha === pullsMatch[1]
      );
      return Promise.resolve(
        JSON.stringify(
          (commit?.pulls ?? []).map((pr) => ({
            number: pr.number,
            state: "closed",
            merged_at: pr.merged ? "2026-08-01T00:00:00Z" : null,
          })),
        ),
      );
    }
    if (/\/rules\/branches\//.test(endpoint)) {
      return Promise.resolve(JSON.stringify(state.branchRules ?? []));
    }
    if (/\/rulesets$/.test(endpoint)) {
      return Promise.resolve(JSON.stringify(state.rulesets ?? []));
    }
    if (/\/branches\/[^/]+\/protection$/.test(endpoint)) {
      return state.classic ? Promise.resolve("{}") : Promise.reject(
        new Error("gh failed: Branch not protected (HTTP 404)"),
      );
    }
    if (/\/pulls\?/.test(endpoint)) {
      return Promise.resolve(
        JSON.stringify(
          state.latestPrSha ? [{ head: { sha: state.latestPrSha } }] : [],
        ),
      );
    }
    const checkRunsMatch = endpoint.match(/\/commits\/(.+)\/check-runs/);
    if (checkRunsMatch) {
      const ref = checkRunsMatch[1]!;
      const names = state.checkRuns?.[ref] ?? [];
      return Promise.resolve(
        JSON.stringify({ check_runs: names.map((name) => ({ name })) }),
      );
    }
    const statusMatch = endpoint.match(/\/commits\/(.+)\/status$/);
    if (statusMatch) {
      const ref = statusMatch[1]!;
      const contexts = state.statuses?.[ref] ?? [];
      return Promise.resolve(
        JSON.stringify({ statuses: contexts.map((context) => ({ context })) }),
      );
    }
    return Promise.reject(new Error(`unexpected endpoint: ${endpoint}`));
  };
  return { gh, calls };
}

/** Every classic-protection write attempted this run (must always be zero). */
function classicWrites(calls: GhCall[]): GhCall[] {
  return calls.filter((c) =>
    c.method !== "GET" && /\/branches\/[^/]+\/protection$/.test(c.endpoint)
  );
}

function rulesetWrites(calls: GhCall[]): GhCall[] {
  return calls.filter((c) =>
    c.method !== "GET" && /\/rulesets/.test(c.endpoint)
  );
}

function rulesetDeletes(calls: GhCall[]): GhCall[] {
  return calls.filter((c) =>
    c.method === "DELETE" && /\/rulesets\/\d+$/.test(c.endpoint)
  );
}

// ---------------------------------------------------------------------------
// Acceptance: classic protection is never written
// ---------------------------------------------------------------------------

Deno.test("ruleset - never writes classic branch protection, even on an unprotected repo", async () => {
  const { gh, calls } = makeGh({
    checkRuns: { main: ["gitleaks", "semgrep", "markdownlint"] },
  });

  const result = await ensureDefaultBranchRuleset(
    "org/fresh",
    { branch: "main", visibility: "public" },
    gh,
  );

  assert(result.ok);
  assertEquals(classicWrites(calls).length, 0);
  assertEquals(rulesetWrites(calls).length, 1);
  assertEquals(rulesetWrites(calls)[0]?.method, "POST");
});

Deno.test("ruleset - a repo already covered by a foreign ruleset is a no-op", async () => {
  const { gh, calls } = makeGh({
    // A human-managed ruleset (e.g. `Develop`) already covers the branch.
    rulesets: [{ id: 20827306, name: "Develop" }],
    branchRules: [
      {
        type: "required_status_checks",
        ruleset_id: 20827306,
        parameters: {
          required_status_checks: [{ context: "quality" }],
        },
      },
    ],
  });

  const result = await ensureDefaultBranchRuleset(
    "org/has-ruleset",
    { branch: "main", visibility: "public" },
    gh,
  );

  assert(result.ok);
  assertFalse(result.changed);
  assertEquals(result.skipped, "existing-ruleset");
  assertEquals(result.preserved, ["quality"]);
  assertEquals(classicWrites(calls).length, 0);
  assertEquals(rulesetWrites(calls).length, 0);
});

Deno.test("ruleset - leftover classic protection is reported, never rewritten or deleted", async () => {
  const { gh, calls } = makeGh({
    classic: true,
    rulesets: [{ id: 7, name: "Develop" }],
    branchRules: [{ type: "required_status_checks", ruleset_id: 7 }],
  });

  const result = await ensureDefaultBranchRuleset(
    "org/legacy",
    { branch: "main", visibility: "public" },
    gh,
  );

  assert(result.ok);
  assert(result.legacyClassicProtection);
  assertEquals(
    calls.filter((c) => c.method === "DELETE").length,
    0,
    "deleting classic protection is a deliberate human action",
  );
  assertEquals(classicWrites(calls).length, 0);
});

// ---------------------------------------------------------------------------
// Acceptance: ghost contexts are never required
// ---------------------------------------------------------------------------

Deno.test("ruleset - only reported check names are required (no ghost contexts)", async () => {
  // The repo reports `quality` and `Semgrep SAST scan`; it never reports
  // `gitleaks` or `semgrep`, so neither may be required (Issue #4163).
  const { gh, calls } = makeGh({
    latestPrSha: "abc1234",
    checkRuns: { abc1234: ["quality", "Semgrep SAST scan"] },
  });

  const result = await ensureDefaultBranchRuleset(
    "org/bespoke",
    { branch: "main", visibility: "private" },
    gh,
  );

  assert(result.ok);
  assert(result.changed);
  const body = JSON.parse(rulesetWrites(calls)[0]!.body!);
  const contexts = body.rules[0].parameters.required_status_checks
    .map((c: { context: string }) => c.context);
  assertEquals(contexts.sort(), ["Semgrep SAST scan", "quality"]);
  assertFalse(contexts.includes("gitleaks"));
  assertFalse(contexts.includes("semgrep"));
});

Deno.test("ruleset - no ruleset is created when nothing reportable matches", async () => {
  const { gh, calls } = makeGh({ checkRuns: { main: ["unrelated-job"] } });

  const result = await ensureDefaultBranchRuleset(
    "org/quiet",
    { branch: "main", visibility: "public" },
    gh,
  );

  assert(result.ok);
  assertFalse(result.changed);
  assertEquals(result.skipped, "no-reported-checks");
  assertEquals(rulesetWrites(calls).length, 0);
});

Deno.test("ruleset - a failed check-name discovery requires nothing (fail-safe)", async () => {
  const gh: GhExec = (args) => {
    const endpoint = String(args[1] === "-X" ? args[3] : args[1]);
    if (/\/rules\/branches\//.test(endpoint)) return Promise.resolve("[]");
    if (/\/rulesets$/.test(endpoint)) return Promise.resolve("[]");
    // The direct-push guard reads succeed and show a PR-only branch; only the
    // check-name discovery is unreadable.
    if (/\/topics$/.test(endpoint)) return Promise.resolve('{"names":[]}');
    if (/\/contents\//.test(endpoint)) {
      return Promise.reject(new Error("gh failed: Not Found (HTTP 404)"));
    }
    if (/\/commits\?sha=/.test(endpoint)) {
      return Promise.resolve(
        JSON.stringify([{ sha: "abc1234", commit: { message: "x (#1)" } }]),
      );
    }
    return Promise.reject(new Error("gh failed: server error (HTTP 500)"));
  };

  const result = await ensureDefaultBranchRuleset(
    "org/unreadable",
    { branch: "main", visibility: "public" },
    gh,
  );

  assert(result.ok);
  assertEquals(result.skipped, "no-reported-checks");
});

// ---------------------------------------------------------------------------
// Idempotence and additive convergence
// ---------------------------------------------------------------------------

Deno.test("ruleset - a second run with no drift is a genuine no-op", async () => {
  const state: RepoState = {
    rulesets: [{ id: 42, name: VIBE_RULESET_NAME }],
    branchRules: [
      {
        type: "required_status_checks",
        ruleset_id: 42,
        parameters: {
          required_status_checks: [
            { context: "gitleaks" },
            { context: "semgrep" },
            { context: "markdownlint" },
          ],
        },
      },
    ],
    checkRuns: { main: ["gitleaks", "semgrep", "markdownlint"] },
  };
  const { gh, calls } = makeGh(state);

  const result = await ensureDefaultBranchRuleset(
    "org/steady",
    { branch: "main", visibility: "private" },
    gh,
  );

  assert(result.ok);
  assertFalse(result.changed);
  assertEquals(rulesetWrites(calls).length, 0);
});

Deno.test("ruleset - convergence is additive: a foreign context in our ruleset survives", async () => {
  const { gh, calls } = makeGh({
    rulesets: [{ id: 42, name: VIBE_RULESET_NAME }],
    branchRules: [
      {
        type: "required_status_checks",
        ruleset_id: 42,
        parameters: {
          required_status_checks: [{ context: "org/compliance-gate" }],
        },
      },
    ],
    checkRuns: { main: ["gitleaks"] },
  });

  const result = await ensureDefaultBranchRuleset(
    "org/extra",
    { branch: "main", visibility: "private" },
    gh,
  );

  assert(result.ok);
  assert(result.changed);
  assertEquals(result.added, ["gitleaks"]);
  assertEquals(result.preserved, ["org/compliance-gate"]);
  const write = rulesetWrites(calls)[0]!;
  assertEquals(write.method, "PUT");
  const contexts = JSON.parse(write.body!).rules[0].parameters
    .required_status_checks.map((c: { context: string }) => c.context);
  assertEquals(contexts, ["org/compliance-gate", "gitleaks"]);
});

// ---------------------------------------------------------------------------
// Input validation and error paths
// ---------------------------------------------------------------------------

Deno.test("ruleset - an invalid repo slug is rejected without any gh call", async () => {
  const { gh, calls } = makeGh({});
  const result = await ensureDefaultBranchRuleset(
    "bad ; rm -rf /",
    { branch: "main", visibility: "public" },
    gh,
  );
  assertFalse(result.ok);
  assertEquals(calls.length, 0);
});

Deno.test("ruleset - an invalid branch name is rejected without any gh call", async () => {
  const { gh, calls } = makeGh({});
  const result = await ensureDefaultBranchRuleset(
    "org/repo",
    { branch: "main; curl evil", visibility: "public" },
    gh,
  );
  assertFalse(result.ok);
  assertEquals(calls.length, 0);
});

Deno.test("ruleset - a missing branch name is rejected", async () => {
  const { gh } = makeGh({});
  const result = await ensureDefaultBranchRuleset(
    "org/repo",
    { branch: "   ", visibility: "public" },
    gh,
  );
  assertFalse(result.ok);
});

Deno.test("ruleset - an unreadable ruleset list surfaces as a failure, not a silent pass", async () => {
  const gh: GhExec = () =>
    Promise.reject(new Error("gh failed: Bad credentials (HTTP 401)"));
  const result = await ensureDefaultBranchRuleset(
    "org/denied",
    { branch: "main", visibility: "public" },
    gh,
  );
  assertFalse(result.ok);
});

Deno.test("ruleset - a failed ruleset write is reported as an error", async () => {
  const gh: GhExec = (args) => {
    const isVerb = args[1] === "-X";
    const endpoint = String(isVerb ? args[3] : args[1]);
    if (isVerb) return Promise.reject(new Error("gh failed: HTTP 422"));
    if (/\/rules\/branches\//.test(endpoint)) return Promise.resolve("[]");
    if (/\/rulesets$/.test(endpoint)) return Promise.resolve("[]");
    if (/\/protection$/.test(endpoint)) {
      return Promise.reject(new Error("Not Found (HTTP 404)"));
    }
    if (/\/pulls\?/.test(endpoint)) return Promise.resolve("[]");
    if (/\/topics$/.test(endpoint)) return Promise.resolve('{"names":[]}');
    if (/\/contents\//.test(endpoint)) {
      return Promise.reject(new Error("gh failed: Not Found (HTTP 404)"));
    }
    if (/\/commits\?sha=/.test(endpoint)) {
      return Promise.resolve(
        JSON.stringify([{ sha: "abc1234", commit: { message: "x (#1)" } }]),
      );
    }
    if (/check-runs/.test(endpoint)) {
      return Promise.resolve(
        JSON.stringify({ check_runs: [{ name: "gitleaks" }] }),
      );
    }
    return Promise.resolve(JSON.stringify({ statuses: [] }));
  };

  const result = await ensureDefaultBranchRuleset(
    "org/rejects",
    { branch: "main", visibility: "public" },
    gh,
  );
  assertFalse(result.ok);
});

// ---------------------------------------------------------------------------
// Direct-push guard (Issue #4356)
// ---------------------------------------------------------------------------

/** The private-repo-4 shape: fleet refreshes pushed straight to `Develop`, no PR. */
const DIRECT_HISTORY: FakeCommit[] = [
  { sha: "3493677d", subject: "Refresh of history for 2026-08-15 on host-11" },
  { sha: "194e8c0d", subject: "Refresh of history for 2026-08-15 on host-11" },
];

Deno.test("ruleset - a direct-push branch is skipped and nothing is created (regression: GH013)", async () => {
  const { gh, calls } = makeGh({
    commits: DIRECT_HISTORY,
    checkRuns: { Develop: ["gitleaks", "markdownlint"] },
  });

  const result = await ensureDefaultBranchRuleset(
    "stSoftwareAU/private-repo-4",
    { branch: "Develop", visibility: "private" },
    gh,
  );

  assert(result.ok);
  assertFalse(result.changed);
  assertFalse(result.deleted);
  assertEquals(result.skipped, "direct-push-branch");
  assert(
    result.detail?.includes("3493677"),
    `detail names the sha: ${result.detail}`,
  );
  assert(
    result.detail?.includes("Refresh of history for 2026-08-15 on host-11"),
    "detail names the subject",
  );
  assertEquals(rulesetWrites(calls).length, 0);
  assertEquals(rulesetDeletes(calls).length, 0);
});

Deno.test("ruleset - a direct-push branch loses the worker's own stale ruleset", async () => {
  const { gh, calls } = makeGh({
    rulesets: [{ id: 99, name: VIBE_RULESET_NAME }],
    branchRules: [
      {
        type: "required_status_checks",
        ruleset_id: 99,
        parameters: {
          required_status_checks: [{ context: "gitleaks" }],
        },
      },
    ],
    commits: DIRECT_HISTORY,
    checkRuns: { Develop: ["gitleaks", "markdownlint"] },
  });

  const result = await ensureDefaultBranchRuleset(
    "stSoftwareAU/private-repo-3",
    { branch: "Develop", visibility: "private" },
    gh,
  );

  assert(result.ok);
  assertFalse(result.changed);
  assert(result.deleted);
  assertEquals(result.skipped, "direct-push-branch");
  assertEquals(result.preserved, ["gitleaks"]);
  const deletes = rulesetDeletes(calls);
  assertEquals(deletes.length, 1);
  assertEquals(
    deletes[0]?.endpoint,
    "repos/stSoftwareAU/private-repo-3/rulesets/99",
  );
  // Only the delete — never a create/update alongside it.
  assertEquals(rulesetWrites(calls).length, 1);
});

Deno.test("ruleset - only the ruleset named exactly like ours is ever deleted", async () => {
  // Human-managed ruleset present but NOT covering the branch (e.g. it
  // targets release/*), plus a direct-push default branch: nothing to delete.
  const { gh, calls } = makeGh({
    rulesets: [{ id: 5, name: "Release branches" }],
    commits: DIRECT_HISTORY,
  });

  const result = await ensureDefaultBranchRuleset(
    "org/data",
    { branch: "main", visibility: "private" },
    gh,
  );

  assert(result.ok);
  assertEquals(result.skipped, "direct-push-branch");
  assertFalse(result.deleted);
  assertEquals(rulesetDeletes(calls).length, 0);
});

Deno.test("ruleset - an organisation ruleset that shares our name is never ours to delete", async () => {
  const { gh, calls } = makeGh({
    rulesets: [{
      id: 777,
      name: VIBE_RULESET_NAME,
      source_type: "Organization",
    }],
    commits: DIRECT_HISTORY,
  });

  const result = await ensureDefaultBranchRuleset(
    "org/data",
    { branch: "main", visibility: "private" },
    gh,
  );

  assert(result.ok);
  assertFalse(result.deleted);
  assertEquals(rulesetDeletes(calls).length, 0);
});

Deno.test("ruleset - a human-managed ruleset still wins on a direct-push branch (no delete)", async () => {
  const { gh, calls } = makeGh({
    rulesets: [
      { id: 20827306, name: "Develop" },
      { id: 42, name: VIBE_RULESET_NAME },
    ],
    branchRules: [
      {
        type: "required_status_checks",
        ruleset_id: 20827306,
        parameters: { required_status_checks: [{ context: "quality" }] },
      },
      {
        type: "required_status_checks",
        ruleset_id: 42,
        parameters: { required_status_checks: [{ context: "gitleaks" }] },
      },
    ],
    commits: DIRECT_HISTORY,
  });

  const result = await ensureDefaultBranchRuleset(
    "org/human-managed",
    { branch: "main", visibility: "public" },
    gh,
  );

  assert(result.ok);
  assertEquals(result.skipped, "existing-ruleset");
  assertFalse(result.deleted);
  assertEquals(rulesetDeletes(calls).length, 0);
  assertEquals(rulesetWrites(calls).length, 0);
  // Deferring short-circuits before the history is even read.
  assertEquals(
    calls.filter((c) => /\/commits\?sha=/.test(c.endpoint)).length,
    0,
  );
});

Deno.test("ruleset - an all-PR history keeps the ordinary create behaviour", async () => {
  const { gh, calls } = makeGh({
    commits: [
      { sha: "aaaaaaa1", subject: "feat: squash-merged change (#101)" },
      { sha: "aaaaaaa2", subject: "Merge pull request #100 from org/topic" },
      // A rebase-merged commit: no marker in the subject, but the pulls
      // endpoint names its merged PR.
      {
        sha: "aaaaaaa3",
        subject: "chore: rebased commit",
        pulls: [{ number: 99, merged: true }],
      },
    ],
    checkRuns: { main: ["gitleaks", "markdownlint"] },
  });

  const result = await ensureDefaultBranchRuleset(
    "org/code",
    { branch: "main", visibility: "private" },
    gh,
  );

  assert(result.ok);
  assert(result.changed);
  assertFalse(result.deleted);
  assertEquals(result.skipped, undefined);
  assertEquals(rulesetWrites(calls).length, 1);
  assertEquals(rulesetWrites(calls)[0]?.method, "POST");
  // The pulls endpoint was only consulted for the commit without a marker.
  const pullsReads = calls.filter((c) =>
    /\/commits\/[^/]+\/pulls$/.test(c.endpoint)
  );
  assertEquals(pullsReads.map((c) => c.endpoint), [
    "repos/org/code/commits/aaaaaaa3/pulls",
  ]);
});

Deno.test("ruleset - an all-PR history keeps the ordinary update behaviour", async () => {
  const { gh, calls } = makeGh({
    rulesets: [{ id: 42, name: VIBE_RULESET_NAME }],
    branchRules: [
      {
        type: "required_status_checks",
        ruleset_id: 42,
        parameters: { required_status_checks: [{ context: "gitleaks" }] },
      },
    ],
    checkRuns: { main: ["gitleaks", "markdownlint"] },
  });

  const result = await ensureDefaultBranchRuleset(
    "org/code",
    { branch: "main", visibility: "private" },
    gh,
  );

  assert(result.ok);
  assert(result.changed);
  assertEquals(result.added, ["markdownlint"]);
  assertEquals(rulesetWrites(calls)[0]?.method, "PUT");
  assertEquals(rulesetDeletes(calls).length, 0);
});

Deno.test("ruleset - a commit not tied to a merged PR (open PR only) counts as direct", async () => {
  const { gh, calls } = makeGh({
    commits: [{
      sha: "bbbbbbb1",
      subject: "wip: pushed straight to main",
      pulls: [{ number: 7, merged: false }],
    }],
    checkRuns: { main: ["gitleaks"] },
  });

  const result = await ensureDefaultBranchRuleset(
    "org/code",
    { branch: "main", visibility: "private" },
    gh,
  );

  assert(result.ok);
  assertEquals(result.skipped, "direct-push-branch");
  assertEquals(rulesetWrites(calls).length, 0);
});

Deno.test("ruleset - the topic opt-out skips and deletes the worker's own ruleset", async () => {
  const { gh, calls } = makeGh({
    topics: ["data", "direct-push"],
    rulesets: [{ id: 42, name: VIBE_RULESET_NAME }],
    branchRules: [
      {
        type: "required_status_checks",
        ruleset_id: 42,
        parameters: { required_status_checks: [{ context: "gitleaks" }] },
      },
    ],
    // Even a PR-only history does not override an explicit opt-out.
    checkRuns: { main: ["gitleaks", "markdownlint"] },
  });

  const result = await ensureDefaultBranchRuleset(
    "org/opted",
    { branch: "main", visibility: "private" },
    gh,
  );

  assert(result.ok);
  assertEquals(result.skipped, "opted-out");
  assert(result.deleted);
  assert(result.detail?.includes("direct-push"), result.detail);
  assertEquals(rulesetDeletes(calls).length, 1);
  assertEquals(rulesetWrites(calls).length, 1);
});

Deno.test("ruleset - the marker-file opt-out skips creation", async () => {
  const { gh, calls } = makeGh({
    marker: true,
    checkRuns: { main: ["gitleaks", "markdownlint"] },
  });

  const result = await ensureDefaultBranchRuleset(
    "org/marked",
    { branch: "main", visibility: "private" },
    gh,
  );

  assert(result.ok);
  assertEquals(result.skipped, "opted-out");
  assertFalse(result.deleted);
  assert(result.detail?.includes(NO_RULESET_MARKER_PATH), result.detail);
  assertEquals(rulesetWrites(calls).length, 0);
});

Deno.test("ruleset - an unreadable commit history skips creation and deletes nothing", async () => {
  const { gh, calls } = makeGh({
    commitsError: "gh failed: server error (HTTP 500)",
    rulesets: [{ id: 42, name: VIBE_RULESET_NAME }],
    branchRules: [
      {
        type: "required_status_checks",
        ruleset_id: 42,
        parameters: { required_status_checks: [{ context: "gitleaks" }] },
      },
    ],
    checkRuns: { main: ["gitleaks", "markdownlint"] },
  });

  const result = await ensureDefaultBranchRuleset(
    "org/unreadable-history",
    { branch: "main", visibility: "private" },
    gh,
  );

  assert(result.ok);
  assertFalse(result.changed);
  assertFalse(result.deleted);
  assertEquals(result.skipped, "direct-push-branch");
  assert(result.detail?.includes("unreadable"), result.detail);
  // Nothing written, nothing deleted — the worker never acts on uncertainty.
  assertEquals(rulesetWrites(calls).length, 0);
});

Deno.test("ruleset - the history sample asks for the documented commit count", async () => {
  const { gh, calls } = makeGh({ commits: DIRECT_HISTORY });
  await ensureDefaultBranchRuleset(
    "org/data",
    { branch: "main", visibility: "private" },
    gh,
  );
  const listRead = calls.find((c) => /\/commits\?sha=/.test(c.endpoint));
  assertEquals(
    listRead?.endpoint,
    `repos/org/data/commits?sha=main&per_page=${DIRECT_PUSH_SAMPLE_SIZE}`,
  );
});

Deno.test("ruleset - a failed delete of our stale ruleset is reported as an error", async () => {
  const base = makeGh({
    rulesets: [{ id: 42, name: VIBE_RULESET_NAME }],
    branchRules: [{ type: "required_status_checks", ruleset_id: 42 }],
    commits: DIRECT_HISTORY,
  });
  const gh: GhExec = (args, stdin) => {
    if (args[1] === "-X" && args[2] === "DELETE") {
      return Promise.reject(new Error("gh failed: HTTP 403"));
    }
    return base.gh(args, stdin);
  };

  const result = await ensureDefaultBranchRuleset(
    "org/data",
    { branch: "main", visibility: "private" },
    gh,
  );
  assertFalse(result.ok);
});

// ---------------------------------------------------------------------------
// Read-only plan
// ---------------------------------------------------------------------------

Deno.test("plan - reports the decision without writing or deleting anything", async () => {
  const direct = makeGh({
    rulesets: [{ id: 42, name: VIBE_RULESET_NAME }],
    branchRules: [{ type: "required_status_checks", ruleset_id: 42 }],
    commits: DIRECT_HISTORY,
  });
  const planned = await planDefaultBranchRuleset(
    "org/data",
    { branch: "main", visibility: "private" },
    direct.gh,
  );
  assert(planned.ok);
  assertEquals(planned.plan.action, "delete");
  assertEquals(planned.plan.skipped, "direct-push-branch");
  assertEquals(planned.plan.rulesetId, 42);
  assertEquals(direct.calls.filter((c) => c.method !== "GET").length, 0);

  const fresh = makeGh({ checkRuns: { main: ["gitleaks"] } });
  const create = await planDefaultBranchRuleset(
    "org/code",
    { branch: "main", visibility: "private" },
    fresh.gh,
  );
  assert(create.ok);
  assertEquals(create.plan.action, "create");
  assertEquals(create.plan.added, ["gitleaks"]);
  assertEquals(create.plan.body?.name, VIBE_RULESET_NAME);
  assertEquals(fresh.calls.filter((c) => c.method !== "GET").length, 0);
});
