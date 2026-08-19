/**
 * Tests for workflow_best_practices.ts — workflow best-practice auditor.
 *
 * Issue #2101: Workflow best-practice auditor (GITHUB_TOKEN anti-pattern).
 * Part of #2094.
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  auditWorkflowBestPractices,
  type BestPracticeCheck,
  type ParsedWorkflow,
} from "../lib/workflow_best_practices.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Workflow using peter-evans/create-pull-request with GITHUB_TOKEN — anti-pattern. */
const badWorkflowExplicitGithubToken = `name: Bad - GITHUB_TOKEN
on:
  schedule:
    - cron: "0 6 * * 1"
jobs:
  upgrade:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: peter-evans/create-pull-request@v7
        with:
          token: \${{ secrets.GITHUB_TOKEN }}
          commit-message: "chore: update"
          title: "chore: update"
          branch: chore/update
`;

/** Workflow using ACTIONS_PUSH fallback — best practice. */
const goodWorkflowActionsPush = `name: Good - ACTIONS_PUSH
on:
  schedule:
    - cron: "0 6 * * 1"
jobs:
  upgrade:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: peter-evans/create-pull-request@v7
        with:
          token: \${{ secrets.ACTIONS_PUSH || secrets.GITHUB_TOKEN }}
          commit-message: "chore: update"
          title: "chore: update"
          branch: chore/update
`;

/** Workflow using peter-evans/create-pull-request with no token: key — defaults to GITHUB_TOKEN, anti-pattern. */
const badWorkflowMissingToken = `name: Bad - Missing token
on:
  schedule:
    - cron: "0 6 * * 1"
jobs:
  upgrade:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: peter-evans/create-pull-request@v7
        with:
          commit-message: "chore: update"
          title: "chore: update"
          branch: chore/update
`;

/** Workflow with no peter-evans/create-pull-request step at all. */
const unrelatedWorkflow = `name: Unrelated
on:
  pull_request:
    branches: ["*"]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo hello
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeWorkflows(
  baseDir: string,
  files: Record<string, string>,
): Promise<void> {
  const workflowDir = `${baseDir}/.github/workflows`;
  await Deno.mkdir(workflowDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${workflowDir}/${name}`, content);
  }
}

async function withTempRepo(
  files: Record<string, string>,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "workflow_best_practices_" });
  try {
    await writeWorkflows(tmp, files);
    await fn(tmp);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// pr-creator-token check
// ---------------------------------------------------------------------------

Deno.test(
  "auditWorkflowBestPractices - peter-evans + GITHUB_TOKEN produces pr-creator-token finding",
  async () => {
    await withTempRepo(
      { "bad.yml": badWorkflowExplicitGithubToken },
      async (tmp) => {
        const result = await auditWorkflowBestPractices({
          repo: "owner/repo",
          localRepoPath: tmp,
        });
        assertEquals(result.ok, true);
        if (!result.ok) return;
        assertEquals(result.value.repo, "owner/repo");
        assertEquals(result.value.findings.length, 1);
        const finding = result.value.findings[0]!;
        assertEquals(finding.checkId, "pr-creator-token");
        assertEquals(finding.workflowFile, "bad.yml");
        assertEquals(finding.severity, "high");
        // lineNumber is best-effort; check it points at the uses: line.
        assertEquals(typeof finding.lineNumber, "number");
        assertExists(finding.suggestedFix);
        // suggested fix should reference the safe pattern
        assertEquals(
          /ACTIONS_PUSH/.test(finding.suggestedFix),
          true,
          "Suggested fix should reference ACTIONS_PUSH",
        );
      },
    );
  },
);

Deno.test(
  "auditWorkflowBestPractices - peter-evans + ACTIONS_PUSH fallback produces no finding",
  async () => {
    await withTempRepo(
      { "good.yml": goodWorkflowActionsPush },
      async (tmp) => {
        const result = await auditWorkflowBestPractices({
          repo: "owner/repo",
          localRepoPath: tmp,
        });
        assertEquals(result.ok, true);
        if (!result.ok) return;
        assertEquals(result.value.findings.length, 0);
      },
    );
  },
);

Deno.test(
  "auditWorkflowBestPractices - peter-evans with no token: key produces a finding (default is GITHUB_TOKEN)",
  async () => {
    await withTempRepo(
      { "bad-missing.yml": badWorkflowMissingToken },
      async (tmp) => {
        const result = await auditWorkflowBestPractices({
          repo: "owner/repo",
          localRepoPath: tmp,
        });
        assertEquals(result.ok, true);
        if (!result.ok) return;
        assertEquals(result.value.findings.length, 1);
        assertEquals(result.value.findings[0]!.checkId, "pr-creator-token");
        assertEquals(result.value.findings[0]!.workflowFile, "bad-missing.yml");
      },
    );
  },
);

Deno.test(
  "auditWorkflowBestPractices - workflow without peter-evans step produces no finding",
  async () => {
    await withTempRepo(
      { "unrelated.yml": unrelatedWorkflow },
      async (tmp) => {
        const result = await auditWorkflowBestPractices({
          repo: "owner/repo",
          localRepoPath: tmp,
        });
        assertEquals(result.ok, true);
        if (!result.ok) return;
        assertEquals(result.value.findings.length, 0);
      },
    );
  },
);

Deno.test(
  "auditWorkflowBestPractices - two anti-pattern workflows produce two findings",
  async () => {
    await withTempRepo(
      {
        "bad-1.yml": badWorkflowExplicitGithubToken,
        "bad-2.yml": badWorkflowMissingToken,
      },
      async (tmp) => {
        const result = await auditWorkflowBestPractices({
          repo: "owner/repo",
          localRepoPath: tmp,
        });
        assertEquals(result.ok, true);
        if (!result.ok) return;
        assertEquals(result.value.findings.length, 2);
        const files = result.value.findings.map((f) => f.workflowFile).sort();
        assertEquals(files, ["bad-1.yml", "bad-2.yml"]);
        for (const finding of result.value.findings) {
          assertEquals(finding.checkId, "pr-creator-token");
        }
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Extensibility — stub check can be added without touching the driver
// ---------------------------------------------------------------------------

Deno.test(
  "auditWorkflowBestPractices - injected stub check is invoked once per workflow file",
  async () => {
    const calls: string[] = [];
    const stubCheck: BestPracticeCheck = {
      id: "stub-check",
      title: "Stub check for extensibility test",
      severity: "low",
      description: "Test-only stub.",
      detect(workflow: ParsedWorkflow) {
        calls.push(workflow.filename);
        return {
          checkId: "stub-check",
          workflowFile: workflow.filename,
          lineNumber: 1,
          severity: "low",
          suggestedFix: "stub",
        };
      },
    };

    await withTempRepo(
      {
        "a.yml": unrelatedWorkflow,
        "b.yml": unrelatedWorkflow,
      },
      async (tmp) => {
        const result = await auditWorkflowBestPractices({
          repo: "owner/repo",
          localRepoPath: tmp,
          checks: [stubCheck],
        });
        assertEquals(result.ok, true);
        if (!result.ok) return;
        // Stub fired on every workflow file
        assertEquals(calls.sort(), ["a.yml", "b.yml"]);
        // Each invocation produced a finding
        assertEquals(result.value.findings.length, 2);
        for (const finding of result.value.findings) {
          assertEquals(finding.checkId, "stub-check");
        }
      },
    );
  },
);

Deno.test(
  "auditWorkflowBestPractices - no .github/workflows directory returns no findings",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "wbp_empty_" });
    try {
      const result = await auditWorkflowBestPractices({
        repo: "owner/repo",
        localRepoPath: tmp,
      });
      assertEquals(result.ok, true);
      if (!result.ok) return;
      assertEquals(result.value.findings.length, 0);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);
