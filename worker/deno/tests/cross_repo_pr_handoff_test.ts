/**
 * Tests for cross_repo_pr_handoff.ts — the worker-side bridge that opens the
 * dependency PR an agent run cannot open itself (Issue #182).
 *
 * The agent's `gh` guard only ever allows writes to the claim repo, so
 * `gh pr create --repo stSoftwareAU/<dep>` from the agent subprocess is
 * refused. The agent instead pushes the branch (git is unguarded) and declares
 * the intended PR with a marker; the worker validates the target and opens the
 * PR through its own `spawnGh` chokepoint. These tests drive that flow with an
 * injected `gh` runner — no real network.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CROSS_REPO_PR_MARKER_NAME,
  detectCrossRepoPrDeclaration,
  handOffCrossRepoPr,
  openDeclaredCrossRepoPr,
} from "../lib/cross_repo_pr_handoff.ts";
import type { CommandOutput, RunCommand } from "../lib/cross_repo_fix.ts";
import { _resetGhSpawnRunner, _setGhSpawnRunner } from "../lib/gh_spawn.ts";
import {
  _resetWriteRepoAllowlistSinks,
  _setWriteRepoAllowlistSinks,
  isWriteRepoAllowed,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
} from "../lib/write_repo_allowlist.ts";
import type { GitHubClient, Logger } from "../types.ts";

const DEP_REPO = "stSoftwareAU/NEAT-AI-Discovery";
const BRANCH = "fix/4140-lock-free-kept-candidate-signal";
const CONSUMING_REPO = "stSoftwareAU/GRQ";

function marker(attrs: string): string {
  return `<!-- ${CROSS_REPO_PR_MARKER_NAME} ${attrs} -->`;
}

function ok(stdout = ""): CommandOutput {
  return { success: true, stdout, stderr: "" };
}

function fail(stderr: string): CommandOutput {
  return { success: false, stdout: "", stderr };
}

/** Repo metadata the probe reads: reachable, pushable, default `Develop`. */
function repoMeta(
  overrides: { push?: boolean; defaultBranch?: string } = {},
): string {
  return JSON.stringify({
    full_name: DEP_REPO,
    default_branch: overrides.defaultBranch ?? "Develop",
    permissions: { push: overrides.push ?? true },
  });
}

/**
 * A scripted `gh` runner. Each entry is matched against the joined argv by
 * substring, first match wins; unmatched commands fail loudly so a missing
 * script entry shows up as a test failure rather than a silent pass.
 */
function scriptedRunner(
  script: Array<[match: string, output: CommandOutput]>,
): { runner: RunCommand; calls: string[][] } {
  const calls: string[][] = [];
  const runner: RunCommand = (cmd) => {
    calls.push([...cmd]);
    const joined = cmd.join(" ");
    for (const [match, output] of script) {
      if (joined.includes(match)) return Promise.resolve(output);
    }
    return Promise.resolve(fail(`unscripted command: ${joined}`));
  };
  return { runner, calls };
}

/** The default happy-path script: reachable repo, branch pushed, no PR yet. */
function happyScript(
  prUrl = "https://github.com/stSoftwareAU/NEAT-AI-Discovery/pull/7",
): Array<[string, CommandOutput]> {
  return [
    [`gh api repos/${DEP_REPO}/branches/${BRANCH}`, ok('{"name":"branch"}')],
    [`gh api repos/${DEP_REPO}`, ok(repoMeta())],
    ["gh pr list", ok("")],
    ["gh pr create", ok(`${prUrl}\n`)],
  ];
}

function silentLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

// ---------------------------------------------------------------------------
// detectCrossRepoPrDeclaration
// ---------------------------------------------------------------------------

Deno.test("detectCrossRepoPrDeclaration - no marker is not a declaration", () => {
  const detection = detectCrossRepoPrDeclaration(
    "I fixed the parser and raised a PR in this repo.",
  );
  assertEquals(detection.status, "none");
});

Deno.test("detectCrossRepoPrDeclaration - full marker yields every field", () => {
  const detection = detectCrossRepoPrDeclaration(
    "Pushed the fix.\n" +
      marker(
        `repo="${DEP_REPO}" branch="${BRANCH}" base="Develop" ` +
          `title="Fix lock-free kept-candidate signal" ` +
          `summary="Root cause of GRQ#4140 lives here."`,
      ),
  );
  assertEquals(detection.status, "declared");
  if (detection.status !== "declared") return;
  assertEquals(detection.declaration.repo, DEP_REPO);
  assertEquals(detection.declaration.branch, BRANCH);
  assertEquals(detection.declaration.base, "Develop");
  assertEquals(
    detection.declaration.title,
    "Fix lock-free kept-candidate signal",
  );
  assertStringIncludes(detection.declaration.summary ?? "", "GRQ#4140");
});

Deno.test("detectCrossRepoPrDeclaration - base and summary are optional", () => {
  const detection = detectCrossRepoPrDeclaration(
    marker(`repo="${DEP_REPO}" branch="${BRANCH}" title="Fix the signal"`),
  );
  assertEquals(detection.status, "declared");
  if (detection.status !== "declared") return;
  assertEquals(detection.declaration.base, undefined);
  assertEquals(detection.declaration.summary, undefined);
});

Deno.test("detectCrossRepoPrDeclaration - single-quoted attributes are accepted", () => {
  const detection = detectCrossRepoPrDeclaration(
    marker(`repo='${DEP_REPO}' branch='${BRANCH}' title='Fix the signal'`),
  );
  assertEquals(detection.status, "declared");
});

Deno.test("detectCrossRepoPrDeclaration - an attribute whose name merely ends with a field name is not that field", () => {
  const detection = detectCrossRepoPrDeclaration(
    marker(
      `repo="${DEP_REPO}" branch="${BRANCH}" title="Fix the signal" ` +
        `not-base="evil-base" x_summary="injected"`,
    ),
  );
  assertEquals(detection.status, "declared");
  if (detection.status !== "declared") return;
  assertEquals(detection.declaration.base, undefined);
  assertEquals(detection.declaration.summary, undefined);
});

Deno.test("detectCrossRepoPrDeclaration - a missing required field is malformed, not ignored", () => {
  const detection = detectCrossRepoPrDeclaration(
    marker(`repo="${DEP_REPO}" title="Fix the signal"`),
  );
  assertEquals(detection.status, "malformed");
  if (detection.status !== "malformed") return;
  assertStringIncludes(detection.reason, "branch");
});

Deno.test("detectCrossRepoPrDeclaration - a flag-shaped branch is malformed", () => {
  const detection = detectCrossRepoPrDeclaration(
    marker(
      `repo="${DEP_REPO}" branch="--repo other/evil" title="Fix the signal"`,
    ),
  );
  assertEquals(detection.status, "malformed");
});

Deno.test("detectCrossRepoPrDeclaration - a traversal branch is malformed", () => {
  const detection = detectCrossRepoPrDeclaration(
    marker(`repo="${DEP_REPO}" branch="fix/../../evil" title="Fix"`),
  );
  assertEquals(detection.status, "malformed");
});

Deno.test("detectCrossRepoPrDeclaration - a flag-shaped title is malformed", () => {
  const detection = detectCrossRepoPrDeclaration(
    marker(
      `repo="${DEP_REPO}" branch="${BRANCH}" title="--body-file /etc/passwd"`,
    ),
  );
  assertEquals(detection.status, "malformed");
});

Deno.test("detectCrossRepoPrDeclaration - summary is length-capped", () => {
  const detection = detectCrossRepoPrDeclaration(
    marker(
      `repo="${DEP_REPO}" branch="${BRANCH}" title="Fix" ` +
        `summary="${"x".repeat(3000)}"`,
    ),
  );
  assertEquals(detection.status, "declared");
  if (detection.status !== "declared") return;
  const summary = detection.declaration.summary ?? "";
  assert(summary.length <= 1501, `summary was ${summary.length} chars`);
});

Deno.test("detectCrossRepoPrDeclaration - summary is sanitised before it reaches a PR body", () => {
  const detection = detectCrossRepoPrDeclaration(
    marker(
      `repo="${DEP_REPO}" branch="${BRANCH}" title="Fix" ` +
        `summary="line one\n\tline two <!-- smuggled"`,
    ),
  );
  assertEquals(detection.status, "declared");
  if (detection.status !== "declared") return;
  const summary = detection.declaration.summary ?? "";
  assertEquals(summary.includes("\n"), false);
  assertEquals(summary.includes("\t"), false);
  assertEquals(summary.includes("<!--"), false);
  assertStringIncludes(summary, "line one line two");
});

// ---------------------------------------------------------------------------
// openDeclaredCrossRepoPr — validation
// ---------------------------------------------------------------------------

Deno.test("openDeclaredCrossRepoPr - refuses a repo outside the internal owner without any gh call", async () => {
  const { runner, calls } = scriptedRunner(happyScript());
  const result = await openDeclaredCrossRepoPr({
    declaration: { repo: "attacker/evil", branch: BRANCH, title: "Fix" },
    consumingRepo: CONSUMING_REPO,
    issueNumber: 4206,
    runner,
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "stSoftwareAU");
  assertEquals(calls.length, 0);
});

Deno.test("openDeclaredCrossRepoPr - refuses an unreachable dependency repo", async () => {
  const { runner, calls } = scriptedRunner([
    [`gh api repos/${DEP_REPO}`, fail("gh: Not Found (HTTP 404)")],
  ]);
  const result = await openDeclaredCrossRepoPr({
    declaration: { repo: DEP_REPO, branch: BRANCH, title: "Fix" },
    consumingRepo: CONSUMING_REPO,
    issueNumber: 4206,
    runner,
  });
  assertEquals(result.ok, false);
  assertEquals(calls.some((c) => c.includes("create")), false);
});

Deno.test("openDeclaredCrossRepoPr - refuses when the worker cannot push to the dependency repo", async () => {
  const { runner, calls } = scriptedRunner([
    [`gh api repos/${DEP_REPO}`, ok(repoMeta({ push: false }))],
  ]);
  const result = await openDeclaredCrossRepoPr({
    declaration: { repo: DEP_REPO, branch: BRANCH, title: "Fix" },
    consumingRepo: CONSUMING_REPO,
    issueNumber: 4206,
    runner,
  });
  assertEquals(result.ok, false);
  assertEquals(calls.some((c) => c.includes("create")), false);
});

Deno.test("openDeclaredCrossRepoPr - refuses a branch that was never pushed", async () => {
  const { runner, calls } = scriptedRunner([
    [
      `gh api repos/${DEP_REPO}/branches/${BRANCH}`,
      fail("gh: Branch not found (HTTP 404)"),
    ],
    [`gh api repos/${DEP_REPO}`, ok(repoMeta())],
  ]);
  const result = await openDeclaredCrossRepoPr({
    declaration: { repo: DEP_REPO, branch: BRANCH, title: "Fix" },
    consumingRepo: CONSUMING_REPO,
    issueNumber: 4206,
    runner,
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, BRANCH);
  assertEquals(calls.some((c) => c.includes("create")), false);
});

Deno.test("openDeclaredCrossRepoPr - refuses when the head branch is the default branch", async () => {
  const { runner, calls } = scriptedRunner([
    [`gh api repos/${DEP_REPO}/branches/Develop`, ok('{"name":"Develop"}')],
    [`gh api repos/${DEP_REPO}`, ok(repoMeta())],
  ]);
  const result = await openDeclaredCrossRepoPr({
    declaration: { repo: DEP_REPO, branch: "Develop", title: "Fix" },
    consumingRepo: CONSUMING_REPO,
    issueNumber: 4206,
    runner,
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "default branch");
  assertEquals(calls.some((c) => c.includes("create")), false);
});

// ---------------------------------------------------------------------------
// openDeclaredCrossRepoPr — the PR itself
// ---------------------------------------------------------------------------

Deno.test("openDeclaredCrossRepoPr - opens the dependency PR and returns its URL", async () => {
  const prUrl = "https://github.com/stSoftwareAU/NEAT-AI-Discovery/pull/7";
  const { runner, calls } = scriptedRunner(happyScript(prUrl));
  const result = await openDeclaredCrossRepoPr({
    declaration: {
      repo: DEP_REPO,
      branch: BRANCH,
      base: "Develop",
      title: "Fix lock-free kept-candidate signal",
      summary: "Root cause of GRQ#4140 lives here.",
    },
    consumingRepo: CONSUMING_REPO,
    issueNumber: 4206,
    runner,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.status, "opened");
  assertEquals(result.value.prUrl, prUrl);
  assertEquals(result.value.repo, DEP_REPO);

  const create = calls.find((c) => c.includes("create"));
  assert(create, "expected a gh pr create call");
  const joined = create.join(" ");
  assertStringIncludes(joined, `--repo ${DEP_REPO}`);
  assertStringIncludes(joined, `--head ${BRANCH}`);
  assertStringIncludes(joined, "--base Develop");
  assertStringIncludes(joined, "Fix lock-free kept-candidate signal");
  // The PR body cross-links the consuming issue so the two stay traceable.
  const body = create[create.indexOf("--body") + 1] ?? "";
  assertStringIncludes(body, `${CONSUMING_REPO}#4206`);
  assertStringIncludes(body, "Root cause of GRQ#4140 lives here.");
});

Deno.test("openDeclaredCrossRepoPr - defaults the base to the dependency's default branch", async () => {
  const { runner, calls } = scriptedRunner(happyScript());
  const result = await openDeclaredCrossRepoPr({
    declaration: { repo: DEP_REPO, branch: BRANCH, title: "Fix" },
    consumingRepo: CONSUMING_REPO,
    issueNumber: 4206,
    runner,
  });
  assertEquals(result.ok, true);
  const create = calls.find((c) => c.includes("create"));
  assertStringIncludes((create ?? []).join(" "), "--base Develop");
});

Deno.test("openDeclaredCrossRepoPr - an existing open PR is reused, never duplicated", async () => {
  const existing = "https://github.com/stSoftwareAU/NEAT-AI-Discovery/pull/3";
  const { runner, calls } = scriptedRunner([
    [`gh api repos/${DEP_REPO}/branches/${BRANCH}`, ok('{"name":"b"}')],
    [`gh api repos/${DEP_REPO}`, ok(repoMeta())],
    ["gh pr list", ok(`${existing}\n`)],
  ]);
  const result = await openDeclaredCrossRepoPr({
    declaration: { repo: DEP_REPO, branch: BRANCH, title: "Fix" },
    consumingRepo: CONSUMING_REPO,
    issueNumber: 4206,
    runner,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.status, "existing");
  assertEquals(result.value.prUrl, existing);
  assertEquals(calls.some((c) => c.includes("create")), false);
});

Deno.test("openDeclaredCrossRepoPr - a failed gh pr create fails loud with the stderr", async () => {
  const { runner } = scriptedRunner([
    [`gh api repos/${DEP_REPO}/branches/${BRANCH}`, ok('{"name":"b"}')],
    [`gh api repos/${DEP_REPO}`, ok(repoMeta())],
    ["gh pr list", ok("")],
    ["gh pr create", fail("pull request create failed: no commits between")],
  ]);
  const result = await openDeclaredCrossRepoPr({
    declaration: { repo: DEP_REPO, branch: BRANCH, title: "Fix" },
    consumingRepo: CONSUMING_REPO,
    issueNumber: 4206,
    runner,
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "no commits between");
});

// ---------------------------------------------------------------------------
// Egress boundary — the scoped grant lets the validated PR through and is
// released afterwards (Issue #3311 boundary preserved).
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "openDeclaredCrossRepoPr - the validated dependency PR passes the write-repo allowlist, which re-closes afterwards",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const logs: string[] = [];
    _setWriteRepoAllowlistSinks({
      record: () => Promise.resolve({ ok: true, value: {} as never }),
      log: (line) => logs.push(line),
    });
    const seen: string[][] = [];
    _setGhSpawnRunner((args) => {
      seen.push([...args]);
      const joined = args.join(" ");
      if (joined.includes("pr create")) {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: "https://github.com/stSoftwareAU/NEAT-AI-Discovery/pull/9\n",
          stderr: "",
        });
      }
      if (joined.includes("pr list")) {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: "",
          stderr: "",
        });
      }
      if (joined.includes("/branches/")) {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: '{"name":"b"}',
          stderr: "",
        });
      }
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: repoMeta(),
        stderr: "",
      });
    });
    // The run's allowlist contains ONLY the consuming repo — the exact state
    // that refused `gh pr create` from the agent subprocess.
    seedWriteRepoAllowlist(CONSUMING_REPO);
    try {
      assertEquals(isWriteRepoAllowed(DEP_REPO), false);

      const result = await openDeclaredCrossRepoPr({
        declaration: { repo: DEP_REPO, branch: BRANCH, title: "Fix" },
        consumingRepo: CONSUMING_REPO,
        issueNumber: 4206,
      });

      assertEquals(result.ok, true);
      assert(
        seen.some((c) => c.join(" ").includes("pr create")),
        "the worker must have reached gh pr create",
      );
      // The grant is scoped to that one call — the boundary is closed again.
      assertEquals(isWriteRepoAllowed(DEP_REPO), false);
      assert(
        logs.some((l) => l.includes("[SECURITY]") && l.includes(DEP_REPO)),
        "the scoped grant must be announced on the security log",
      );
    } finally {
      resetWriteRepoAllowlist();
      _resetWriteRepoAllowlistSinks();
      _resetGhSpawnRunner();
    }
  },
});

// ---------------------------------------------------------------------------
// handOffCrossRepoPr — cross-link on success, escalate on failure
// ---------------------------------------------------------------------------

interface StubCalls {
  comments: Array<{ repo: string; issueNumber: number; body: string }>;
  labels: Array<{ repo: string; issueNumber: number; label: string }>;
}

function stubGhClient(calls: StubCalls): GitHubClient {
  return {
    getIssue: () => Promise.resolve({} as never),
    getIssueComments: () => Promise.resolve([]),
    addLabel: (repo, issueNumber, label) => {
      calls.labels.push({ repo, issueNumber, label });
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (repo, issueNumber, body) => {
      calls.comments.push({ repo, issueNumber, body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

Deno.test("handOffCrossRepoPr - a successful dependency PR is cross-linked on the consuming issue", async () => {
  const calls: StubCalls = { comments: [], labels: [] };
  const prUrl = "https://github.com/stSoftwareAU/NEAT-AI-Discovery/pull/7";
  const { runner } = scriptedRunner(happyScript(prUrl));

  const result = await handOffCrossRepoPr({
    ghClient: stubGhClient(calls),
    repo: CONSUMING_REPO,
    issueNumber: 4206,
    needsHumanLabel: "needs-human",
    githubUser: "stservice",
    detection: {
      status: "declared",
      declaration: { repo: DEP_REPO, branch: BRANCH, title: "Fix the signal" },
    },
    logger: silentLogger(),
    runner,
    deps: {
      ensureLabelExists: () => Promise.resolve({ ok: true, value: undefined }),
    },
  });

  assertEquals(result.status, "opened");
  assertEquals(calls.comments.length, 1);
  assertStringIncludes(calls.comments[0]!.body, prUrl);
  // A successful bridge is not an escalation.
  assertEquals(calls.labels.length, 0);
});

Deno.test("handOffCrossRepoPr - a refused declaration escalates to a human with the branch details", async () => {
  const calls: StubCalls = { comments: [], labels: [] };
  const { runner } = scriptedRunner([
    [`gh api repos/${DEP_REPO}`, fail("gh: Not Found (HTTP 404)")],
  ]);

  const result = await handOffCrossRepoPr({
    ghClient: stubGhClient(calls),
    repo: CONSUMING_REPO,
    issueNumber: 4206,
    needsHumanLabel: "needs-human",
    githubUser: "stservice",
    detection: {
      status: "declared",
      declaration: { repo: DEP_REPO, branch: BRANCH, title: "Fix the signal" },
    },
    logger: silentLogger(),
    runner,
    deps: {
      ensureLabelExists: () => Promise.resolve({ ok: true, value: undefined }),
    },
  });

  assertEquals(result.status, "escalated");
  assertEquals(
    calls.labels.some((l) => l.label === "needs-human"),
    true,
  );
  assertEquals(calls.comments.length, 1);
  assertStringIncludes(calls.comments[0]!.body, BRANCH);
  assertStringIncludes(calls.comments[0]!.body, DEP_REPO);
});

Deno.test("handOffCrossRepoPr - a malformed marker escalates rather than failing silently", async () => {
  const calls: StubCalls = { comments: [], labels: [] };
  const { runner, calls: ghCalls } = scriptedRunner(happyScript());

  const result = await handOffCrossRepoPr({
    ghClient: stubGhClient(calls),
    repo: CONSUMING_REPO,
    issueNumber: 4206,
    needsHumanLabel: "needs-human",
    githubUser: "stservice",
    detection: { status: "malformed", reason: "missing branch" },
    logger: silentLogger(),
    runner,
    deps: {
      ensureLabelExists: () => Promise.resolve({ ok: true, value: undefined }),
    },
  });

  assertEquals(result.status, "escalated");
  assertEquals(
    calls.labels.some((l) => l.label === "needs-human"),
    true,
  );
  // Nothing was attempted against GitHub with an unusable declaration.
  assertEquals(ghCalls.length, 0);
});
