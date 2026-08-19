/**
 * Tests for lib/purge_stale_workflow_issues.ts — closes stale false-positive
 * workflow-sync issues whose underlying workflow now classifies as present.
 *
 * Issue #1582: Add command to close stale false-positive workflow-sync
 * partial-match issues.
 */

import { assertEquals } from "@std/assert";
import {
  type CommandOutput,
  extractSpecIdFromIssueBody,
  type PurgeOptions,
  purgeStaleWorkflowIssuesForRepo,
} from "../lib/purge_stale_workflow_issues.ts";
import {
  deduplicationTag,
  partialDeduplicationTag,
} from "../setup/workflow_sync.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(stdout: string): CommandOutput {
  return { success: true, stdout, stderr: "" };
}

function fail(stderr: string): CommandOutput {
  return { success: false, stdout: "", stderr };
}

interface MockIssue {
  number: number;
  body: string;
}

interface MockState {
  closedIssues: { repo: string; number: number; comment?: string }[];
  closeCalls: number;
}

interface MockOptions {
  /** Issues returned by `gh issue list`. */
  issues: MockIssue[];
  /** Workflow filenames present in the repo. */
  workflowFiles?: string[];
  /** Map of workflow filename → YAML content. */
  workflowContents?: Record<string, string>;
  /** Languages API response. */
  languagesApi?: Record<string, number>;
  /** Root files for language detection. */
  rootFiles?: string[];
  /** When true, the gh issue close call returns a failure. */
  closeFails?: boolean;
  /** When true, the audit listing fails. */
  auditFails?: boolean;
  /** When true, gh issue list fails. */
  listFails?: boolean;
  /**
   * Repo visibility reported by `gh api repos/{owner}/{repo} --jq .visibility`.
   * Defaults to `"public"` so existing tests retain their original behaviour.
   */
  visibility?: "public" | "private";
}

const repo = "owner/repo";

const gitleaksYaml = `name: Gitleaks
on:
  pull_request:
    branches: ["*"]
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gitleaks/gitleaks-action@v2
`;

const semgrepYaml = `name: Semgrep
on:
  pull_request:
jobs:
  semgrep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: semgrep/semgrep-action@v1
`;

const dependencyReviewYaml = `name: Dependency Review
on:
  pull_request:
jobs:
  dependency-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/dependency-review-action@v4
`;

function buildMockRunner(opts: MockOptions): {
  runner: PurgeOptions["runCommand"];
  state: MockState;
} {
  const state: MockState = { closedIssues: [], closeCalls: 0 };

  const runner = (cmd: string[]): Promise<CommandOutput> => {
    const joined = cmd.join(" ");

    // gh issue list
    if (joined.includes("gh issue list")) {
      if (opts.listFails) return Promise.resolve(fail("rate limited"));
      // Echo back the configured issues filtered by the search tag.
      const searchIdx = cmd.indexOf("--search");
      const searchQuery = searchIdx >= 0 ? cmd[searchIdx + 1]! : "";
      const matched = opts.issues.filter((i) => {
        // Mimic GitHub's body search by checking substring.
        // Strip surrounding quotes and " in:body" suffix, plus any leading prefix.
        const stripped = searchQuery
          .replace(/"/g, "")
          .replace(/\s*in:body$/, "")
          .trim();
        return i.body.includes(stripped);
      });
      const json = matched.map((i) => ({ number: i.number, body: i.body }));
      return Promise.resolve(ok(JSON.stringify(json)));
    }

    // gh issue close
    if (joined.includes("gh issue close")) {
      state.closeCalls++;
      if (opts.closeFails) return Promise.resolve(fail("network error"));
      const repoIdx = cmd.indexOf("--repo");
      const commentIdx = cmd.indexOf("--comment");
      // The number is the third positional after "issue close".
      const issueIdx = cmd.indexOf("close") + 1;
      state.closedIssues.push({
        repo: repoIdx >= 0 ? cmd[repoIdx + 1]! : "",
        number: parseInt(cmd[issueIdx]!, 10),
        comment: commentIdx >= 0 ? cmd[commentIdx + 1] : undefined,
      });
      return Promise.resolve(ok(""));
    }

    // Repo visibility lookup: gh api repos/{owner}/{repo} --jq .visibility
    if (
      joined.includes(`repos/${repo}`) &&
      !joined.includes("/contents") &&
      !joined.includes("/languages") &&
      cmd.includes("--jq") &&
      cmd[cmd.indexOf("--jq") + 1] === ".visibility"
    ) {
      return Promise.resolve(ok(opts.visibility ?? "public"));
    }

    // Language detection: root contents
    if (
      joined.includes(`repos/${repo}/contents/`) && !joined.includes(".github")
    ) {
      const items = (opts.rootFiles ?? []).map((n) => ({
        name: n,
        type: "file",
      }));
      return Promise.resolve(ok(JSON.stringify(items)));
    }

    // Language detection: languages API
    if (joined.includes(`repos/${repo}/languages`)) {
      return Promise.resolve(ok(JSON.stringify(opts.languagesApi ?? {})));
    }

    // Workflow audit: directory listing
    if (
      joined.includes(`repos/${repo}/contents/.github/workflows`) &&
      !joined.includes("Accept:")
    ) {
      if (opts.auditFails) return Promise.resolve(fail("audit error"));
      const items = (opts.workflowFiles ?? []).map((n) => ({
        name: n,
        type: "file",
      }));
      return Promise.resolve(ok(JSON.stringify(items)));
    }

    // Workflow audit: file content
    if (
      joined.includes(`repos/${repo}/contents/.github/workflows/`) &&
      joined.includes("Accept:")
    ) {
      const filename = cmd.find((c) =>
        c.startsWith(`repos/${repo}/contents/.github/workflows/`) &&
        c !== `repos/${repo}/contents/.github/workflows`
      );
      if (filename) {
        const name = filename.split("/").pop()!;
        const content = opts.workflowContents?.[name];
        if (content) return Promise.resolve(ok(content));
      }
      return Promise.resolve(fail("not found"));
    }

    return Promise.resolve(ok(""));
  };

  return { runner, state };
}

// ---------------------------------------------------------------------------
// extractSpecIdFromIssueBody
// ---------------------------------------------------------------------------

Deno.test("extractSpecIdFromIssueBody - parses partial-match tag", () => {
  const body = `Some prose...\n${partialDeduplicationTag("gitleaks")}`;
  const result = extractSpecIdFromIssueBody(body);
  assertEquals(result, { specId: "gitleaks", kind: "partial" });
});

Deno.test("extractSpecIdFromIssueBody - parses missing-workflow tag", () => {
  const body = `Some prose...\n${deduplicationTag("semgrep")}`;
  const result = extractSpecIdFromIssueBody(body);
  assertEquals(result, { specId: "semgrep", kind: "missing" });
});

Deno.test("extractSpecIdFromIssueBody - prefers partial over missing when both appear", () => {
  // Partial tag is strictly more specific so it must take precedence.
  const body = `${deduplicationTag("gitleaks")}\n${
    partialDeduplicationTag("gitleaks")
  }`;
  const result = extractSpecIdFromIssueBody(body);
  assertEquals(result, { specId: "gitleaks", kind: "partial" });
});

Deno.test("extractSpecIdFromIssueBody - returns null when no tag present", () => {
  assertEquals(extractSpecIdFromIssueBody("nothing to see here"), null);
});

// ---------------------------------------------------------------------------
// purgeStaleWorkflowIssuesForRepo
// ---------------------------------------------------------------------------

Deno.test("purgeStaleWorkflowIssuesForRepo - closes partial-match issue when audit now classifies as present", async () => {
  // Workflow now contains all three universal protections, so the gitleaks
  // partial-match issue should be closed.
  const { runner, state } = buildMockRunner({
    issues: [
      {
        number: 46,
        body: `Partial body...\n${partialDeduplicationTag("gitleaks")}`,
      },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: ["gitleaks.yml", "semgrep.yml", "dependency-review.yml"],
    workflowContents: {
      "gitleaks.yml": gitleaksYaml,
      "semgrep.yml": semgrepYaml,
      "dependency-review.yml": dependencyReviewYaml,
    },
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.closed.length, 1);
  assertEquals(result.value.closed[0]!.number, 46);
  assertEquals(result.value.kept.length, 0);
  assertEquals(state.closedIssues.length, 1);
  assertEquals(state.closedIssues[0]!.number, 46);
  assertEquals(state.closedIssues[0]!.repo, repo);
  // Comment must reference the umbrella issue #1577.
  assertEquals(state.closedIssues[0]!.comment?.includes("#1577"), true);
});

Deno.test("purgeStaleWorkflowIssuesForRepo - leaves issue open when audit still classifies as partial", async () => {
  // Repo has only gitleaks.yml — semgrep and dependency-review are missing.
  // The semgrep partial-match issue should remain open.
  const { runner, state } = buildMockRunner({
    issues: [
      {
        number: 47,
        body: `Partial body...\n${partialDeduplicationTag("semgrep")}`,
      },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: ["gitleaks.yml"],
    workflowContents: {
      "gitleaks.yml": gitleaksYaml,
    },
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.closed.length, 0);
  assertEquals(result.value.kept.length, 1);
  assertEquals(result.value.kept[0]!.number, 47);
  assertEquals(state.closedIssues.length, 0);
});

Deno.test("purgeStaleWorkflowIssuesForRepo - closes missing-workflow issue when spec is now present", async () => {
  // Issue tagged as a "missing" workflow, but the workflow file is now there.
  const { runner, state } = buildMockRunner({
    issues: [
      {
        number: 1461,
        body: `Add Gitleaks workflow body...\n${deduplicationTag("gitleaks")}`,
      },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: ["gitleaks.yml", "semgrep.yml", "dependency-review.yml"],
    workflowContents: {
      "gitleaks.yml": gitleaksYaml,
      "semgrep.yml": semgrepYaml,
      "dependency-review.yml": dependencyReviewYaml,
    },
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.closed.length, 1);
  assertEquals(result.value.closed[0]!.kind, "missing");
  assertEquals(state.closedIssues.length, 1);
});

Deno.test("purgeStaleWorkflowIssuesForRepo - dry-run does not call gh issue close", async () => {
  const { runner, state } = buildMockRunner({
    issues: [
      {
        number: 46,
        body: `${partialDeduplicationTag("gitleaks")}`,
      },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: ["gitleaks.yml", "semgrep.yml", "dependency-review.yml"],
    workflowContents: {
      "gitleaks.yml": gitleaksYaml,
      "semgrep.yml": semgrepYaml,
      "dependency-review.yml": dependencyReviewYaml,
    },
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
    dryRun: true,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.closed.length, 1);
  assertEquals(result.value.closed[0]!.number, 46);
  // No real close call should have been made in dry-run mode.
  assertEquals(state.closeCalls, 0);
  assertEquals(state.closedIssues.length, 0);
});

Deno.test("purgeStaleWorkflowIssuesForRepo - surfaces audit errors via Result type", async () => {
  const { runner } = buildMockRunner({
    issues: [
      {
        number: 46,
        body: `${partialDeduplicationTag("gitleaks")}`,
      },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    auditFails: true,
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
  });

  // Audit failures must surface as Result.error rather than thrown.
  // Issue #1829: the workflow auditor used to silently swallow ANY
  // listing failure and return an empty file list, which made transient
  // API failures invisible (and caused workflow-sync to raise duplicate
  // "Add … workflow" issues against repos where the workflows were in
  // fact present). The auditor now propagates non-404 listing failures
  // as Result.error, and the purge function surfaces that as its own
  // Result.error rather than silently doing nothing — but it still must
  // not throw.
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(typeof result.error, "string");
  assertEquals(result.error.includes("audit"), true);
});

Deno.test("purgeStaleWorkflowIssuesForRepo - surfaces gh issue list errors via Result type", async () => {
  const { runner } = buildMockRunner({
    issues: [],
    listFails: true,
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
  });

  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(
    result.error.includes("issue list") || result.error.length > 0,
    true,
  );
});

Deno.test("purgeStaleWorkflowIssuesForRepo - records close failures without throwing", async () => {
  const { runner, state } = buildMockRunner({
    issues: [
      {
        number: 46,
        body: `${partialDeduplicationTag("gitleaks")}`,
      },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: ["gitleaks.yml", "semgrep.yml", "dependency-review.yml"],
    workflowContents: {
      "gitleaks.yml": gitleaksYaml,
      "semgrep.yml": semgrepYaml,
      "dependency-review.yml": dependencyReviewYaml,
    },
    closeFails: true,
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  // Failed closes are reported in the failures array, not the closed array.
  assertEquals(result.value.closed.length, 0);
  assertEquals(result.value.failures.length, 1);
  assertEquals(result.value.failures[0]!.number, 46);
  assertEquals(state.closeCalls, 1);
});

// ---------------------------------------------------------------------------
// Visibility-aware behaviour (Issue #1755)
// ---------------------------------------------------------------------------

Deno.test("purgeStaleWorkflowIssuesForRepo - private repo: closes public-only spec issue as not applicable", async () => {
  const { runner, state } = buildMockRunner({
    visibility: "private",
    issues: [
      {
        number: 1750,
        body: `Add Dependency Review workflow body...\n${
          deduplicationTag("dependency-review")
        }`,
      },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: [],
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.notApplicable.length, 1);
  assertEquals(result.value.notApplicable[0]!.number, 1750);
  assertEquals(result.value.notApplicable[0]!.specId, "dependency-review");
  assertEquals(result.value.closed.length, 0);
  assertEquals(result.value.kept.length, 0);
  assertEquals(result.value.failures.length, 0);

  // Verify the close call posted the not-applicable comment.
  assertEquals(state.closedIssues.length, 1);
  assertEquals(state.closedIssues[0]!.number, 1750);
  const comment = state.closedIssues[0]!.comment ?? "";
  assertEquals(comment.includes("not applicable"), true);
  assertEquals(comment.includes("#1750"), true);
  // Idempotency marker carries the spec ID.
  assertEquals(
    comment.includes(
      "<!-- vibe-coder:purge-not-applicable:dependency-review -->",
    ),
    true,
  );
});

Deno.test("purgeStaleWorkflowIssuesForRepo - private repo: partial-match public-only spec issue also closed as not applicable", async () => {
  // Even a partial-match dependency-review issue on a private repo should be
  // closed as not applicable — the spec does not apply at all on a private
  // repo, so the partial-vs-missing distinction does not matter.
  const { runner, state } = buildMockRunner({
    visibility: "private",
    issues: [
      {
        number: 1751,
        body: `Partial body...\n${
          partialDeduplicationTag("dependency-review")
        }`,
      },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: [],
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.notApplicable.length, 1);
  assertEquals(result.value.notApplicable[0]!.kind, "partial");
  assertEquals(state.closedIssues.length, 1);
});

Deno.test("purgeStaleWorkflowIssuesForRepo - public repo: dependency-review issue treated normally (closed when present)", async () => {
  const { runner, state } = buildMockRunner({
    visibility: "public",
    issues: [
      {
        number: 1760,
        body: `Add Dependency Review workflow body...\n${
          deduplicationTag("dependency-review")
        }`,
      },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: ["gitleaks.yml", "semgrep.yml", "dependency-review.yml"],
    workflowContents: {
      "gitleaks.yml": gitleaksYaml,
      "semgrep.yml": semgrepYaml,
      "dependency-review.yml": dependencyReviewYaml,
    },
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  // Public repo: behaviour is unchanged — the candidate is closed because
  // the workflow is now present, not because it is "not applicable".
  assertEquals(result.value.notApplicable.length, 0);
  assertEquals(result.value.closed.length, 1);
  assertEquals(result.value.closed[0]!.number, 1760);
  assertEquals(state.closedIssues.length, 1);
  // The closing comment must NOT carry the not-applicable marker.
  const comment = state.closedIssues[0]!.comment ?? "";
  assertEquals(comment.includes("vibe-coder:purge-not-applicable"), false);
});

Deno.test("purgeStaleWorkflowIssuesForRepo - public repo: dependency-review issue kept when workflow still missing", async () => {
  const { runner, state } = buildMockRunner({
    visibility: "public",
    issues: [
      {
        number: 1761,
        body: `Add Dependency Review workflow body...\n${
          deduplicationTag("dependency-review")
        }`,
      },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: [],
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.notApplicable.length, 0);
  assertEquals(result.value.closed.length, 0);
  assertEquals(result.value.kept.length, 1);
  assertEquals(result.value.kept[0]!.number, 1761);
  assertEquals(state.closedIssues.length, 0);
});

Deno.test("purgeStaleWorkflowIssuesForRepo - dry-run on private repo: lists not applicable but does not close", async () => {
  const { runner, state } = buildMockRunner({
    visibility: "private",
    issues: [
      {
        number: 1762,
        body: `${deduplicationTag("dependency-review")}`,
      },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: [],
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
    dryRun: true,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.notApplicable.length, 1);
  assertEquals(result.value.notApplicable[0]!.number, 1762);
  // No real close call should have been made in dry-run mode.
  assertEquals(state.closeCalls, 0);
  assertEquals(state.closedIssues.length, 0);
});

Deno.test("purgeStaleWorkflowIssuesForRepo - private repo: close failure for not-applicable issue is recorded", async () => {
  const { runner, state } = buildMockRunner({
    visibility: "private",
    issues: [
      {
        number: 1763,
        body: `${deduplicationTag("dependency-review")}`,
      },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: [],
    closeFails: true,
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.notApplicable.length, 0);
  assertEquals(result.value.failures.length, 1);
  assertEquals(result.value.failures[0]!.number, 1763);
  assertEquals(state.closeCalls, 1);
});

Deno.test("purgeStaleWorkflowIssuesForRepo - private repo: non-public-only candidate still goes through audit", async () => {
  // gitleaks is universal (not public-only). On a private repo, the visibility
  // filter must NOT short-circuit it — the audit still runs and the present
  // gitleaks workflow closes the partial-match issue under the "now present"
  // path, not the "not applicable" path.
  const { runner, state } = buildMockRunner({
    visibility: "private",
    issues: [
      {
        number: 200,
        body: `${partialDeduplicationTag("gitleaks")}`,
      },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: ["gitleaks.yml", "semgrep.yml"],
    workflowContents: {
      "gitleaks.yml": gitleaksYaml,
      "semgrep.yml": semgrepYaml,
    },
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.notApplicable.length, 0);
  assertEquals(result.value.closed.length, 1);
  assertEquals(result.value.closed[0]!.number, 200);
  assertEquals(state.closedIssues.length, 1);
});

Deno.test("purgeStaleWorkflowIssuesForRepo - issue with no recognisable tag is ignored", async () => {
  const { runner, state } = buildMockRunner({
    issues: [
      { number: 99, body: "issue without any workflow-sync tag" },
    ],
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: [],
  });

  const result = await purgeStaleWorkflowIssuesForRepo(repo, {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.closed.length, 0);
  assertEquals(result.value.kept.length, 0);
  assertEquals(state.closedIssues.length, 0);
});
