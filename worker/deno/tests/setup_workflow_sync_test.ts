/**
 * Tests for setup/workflow_sync.ts — workflow synchronisation.
 *
 * Issue #1395: Add workflow-sync subcommand to setup CLI.
 */

import { assertEquals } from "@std/assert";
import {
  type CommandOutput,
  deduplicationTag,
  issueBodyPartial,
  partialDeduplicationTag,
  syncWorkflowsForAllRepos,
  syncWorkflowsForRepo,
  type WorkflowSyncOptions,
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

/** Build a root contents API response with the given filenames. */
function rootContentsResponse(files: string[]): CommandOutput {
  const items = files.map((n) => ({ name: n, type: "file" }));
  return ok(JSON.stringify(items));
}

/** Build a workflow directory listing response. */
function workflowDirResponse(filenames: string[]): CommandOutput {
  const items = filenames.map((n) => ({
    name: n,
    type: "file",
    download_url:
      `https://raw.githubusercontent.com/owner/repo/main/.github/workflows/${n}`,
  }));
  return ok(JSON.stringify(items));
}

/** Track issue creation calls. */
interface MockState {
  issuesCreated: { repo: string; title: string; body: string }[];
  issueSearches: { repo: string; query: string }[];
}

/**
 * Build a mock runner that handles language detection, workflow audit,
 * issue search, and issue creation.
 */
function buildMockRunner(config: {
  /** Root file listing (for language detection). */
  rootFiles?: string[];
  /** Languages API response. */
  languagesApi?: Record<string, number>;
  /** Workflow directory files. */
  workflowFiles?: string[];
  /** Map of workflow filename → YAML content. */
  workflowContents?: Record<string, string>;
  /** Set of spec IDs for which a missing-workflow issue already exists. */
  existingIssues?: Set<string>;
  /** Set of spec IDs for which a partial-workflow issue already exists. */
  existingPartialIssues?: Set<string>;
  /** Whether issue creation should fail. */
  issueCreationFails?: boolean;
  /** Whether language detection should fail. */
  langDetectionFails?: boolean;
  /** Whether workflow audit should fail. */
  auditFails?: boolean;
}): { runner: WorkflowSyncOptions["runCommand"]; state: MockState } {
  const state: MockState = { issuesCreated: [], issueSearches: [] };
  const repo = "owner/repo";

  const runner = (cmd: string[]): Promise<CommandOutput> => {
    const joined = cmd.join(" ");

    // Language detection: root contents
    if (
      joined.includes(`repos/${repo}/contents/`) && !joined.includes(".github")
    ) {
      if (config.langDetectionFails) {
        return Promise.resolve(fail("Network error"));
      }
      return Promise.resolve(rootContentsResponse(config.rootFiles ?? []));
    }

    // Language detection: languages API
    if (joined.includes(`repos/${repo}/languages`)) {
      if (config.langDetectionFails) {
        return Promise.resolve(fail("Network error"));
      }
      return Promise.resolve(ok(JSON.stringify(config.languagesApi ?? {})));
    }

    // Workflow audit: directory listing
    if (
      joined.includes(`repos/${repo}/contents/.github/workflows`) &&
      !joined.includes("Accept:")
    ) {
      if (config.auditFails) {
        return Promise.resolve(fail("Audit error"));
      }
      return Promise.resolve(workflowDirResponse(config.workflowFiles ?? []));
    }

    // Workflow audit: individual file content
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
        const content = config.workflowContents?.[name];
        if (content) {
          return Promise.resolve(ok(content));
        }
      }
      return Promise.resolve(fail("Not found"));
    }

    // Issue search
    if (joined.includes("gh issue list")) {
      const repoIdx = cmd.indexOf("--repo");
      const searchIdx = cmd.indexOf("--search");
      const issueRepo = repoIdx >= 0 ? cmd[repoIdx + 1]! : "";
      const searchQuery = searchIdx >= 0 ? cmd[searchIdx + 1]! : "";
      state.issueSearches.push({ repo: issueRepo, query: searchQuery });

      // Check if any existing issue tag matches the search query.
      // Partial tags are checked first since they are longer and strictly
      // more specific than missing-workflow tags.
      if (config.existingPartialIssues) {
        for (const specId of config.existingPartialIssues) {
          const tag = partialDeduplicationTag(specId);
          if (searchQuery.includes(tag)) {
            return Promise.resolve(ok(JSON.stringify([{ number: 43 }])));
          }
        }
      }
      if (config.existingIssues) {
        for (const specId of config.existingIssues) {
          const tag = deduplicationTag(specId);
          if (searchQuery.includes(tag)) {
            return Promise.resolve(ok(JSON.stringify([{ number: 42 }])));
          }
        }
      }
      return Promise.resolve(ok("[]"));
    }

    // Issue creation
    if (joined.includes("gh issue create")) {
      if (config.issueCreationFails) {
        return Promise.resolve(fail("Permission denied"));
      }
      const repoIdx = cmd.indexOf("--repo");
      const titleIdx = cmd.indexOf("--title");
      const bodyIdx = cmd.indexOf("--body");
      state.issuesCreated.push({
        repo: repoIdx >= 0 ? cmd[repoIdx + 1]! : "",
        title: titleIdx >= 0 ? cmd[titleIdx + 1]! : "",
        body: bodyIdx >= 0 ? cmd[bodyIdx + 1]! : "",
      });
      return Promise.resolve(ok("https://github.com/owner/repo/issues/1"));
    }

    return Promise.resolve(ok(""));
  };

  return { runner, state };
}

// Gitleaks workflow content for testing
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

// Markdown-lint workflow content for testing (Issue #1686).
// Detection patterns for markdown-lint require markdownlint-cli2 OR
// markdownlint to appear in the workflow body.
const markdownLintYaml = `name: Markdown Lint
on:
  pull_request:
    branches: ["*"]
jobs:
  markdownlint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: markdownlint-cli2
`;

// ---------------------------------------------------------------------------
// deduplicationTag
// ---------------------------------------------------------------------------

Deno.test("deduplicationTag - produces correct HTML comment tag", () => {
  assertEquals(
    deduplicationTag("gitleaks"),
    "<!-- vibe-coder:workflow-sync:gitleaks -->",
  );
  assertEquals(
    deduplicationTag("cargo-audit"),
    "<!-- vibe-coder:workflow-sync:cargo-audit -->",
  );
});

// ---------------------------------------------------------------------------
// syncWorkflowsForRepo — full orchestration
// ---------------------------------------------------------------------------

Deno.test("syncWorkflowsForRepo - detects missing workflows and raises issues", async () => {
  // Repo with Bash (Cargo.toml absent, .sh file present), no workflows.
  // Expected: 3 universal (gitleaks, semgrep, markdown-lint) + 1 shellcheck
  // = 4 missing → 4 issues raised. Issue #1686 added markdown-lint as a
  // universal workflow.
  const { runner, state } = buildMockRunner({
    rootFiles: ["README.md", "setup.sh"],
    languagesApi: { Shell: 5000 },
    workflowFiles: [],
  });

  const result = await syncWorkflowsForRepo("owner/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  assertEquals(result.repo, "owner/repo");
  assertEquals(result.present, 0);
  assertEquals(result.partial, 0);
  // 3 universal + 1 shellcheck = 4 issues
  assertEquals(result.issuesRaised, 4);
  assertEquals(result.issuesSkipped, 0);
  assertEquals(state.issuesCreated.length, 4);

  // Verify issues target the correct repo
  for (const issue of state.issuesCreated) {
    assertEquals(issue.repo, "owner/repo");
  }
});

Deno.test("syncWorkflowsForRepo - all workflows present raises no issues", async () => {
  // Repo with all universal workflows present, no language-specific ones needed.
  // Issue #1686 added markdown-lint as a third universal spec.
  const { runner, state } = buildMockRunner({
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: ["gitleaks.yml", "semgrep.yml", "markdown-lint.yml"],
    workflowContents: {
      "gitleaks.yml": gitleaksYaml,
      "semgrep.yml": semgrepYaml,
      "markdown-lint.yml": markdownLintYaml,
    },
  });

  const result = await syncWorkflowsForRepo("owner/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  assertEquals(result.present, 3);
  assertEquals(result.issuesRaised, 0);
  assertEquals(result.issuesSkipped, 0);
  assertEquals(state.issuesCreated.length, 0);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

Deno.test("syncWorkflowsForRepo - idempotent: skips issues that already exist", async () => {
  // Repo with no workflows, but issues already exist for all 3 universal
  // workflows (gitleaks, semgrep, markdown-lint — Issue #1686).
  const { runner, state } = buildMockRunner({
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: [],
    existingIssues: new Set(["gitleaks", "semgrep", "markdown-lint"]),
  });

  const result = await syncWorkflowsForRepo("owner/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  // 3 universal workflows missing, all already have issues → 0 raised, 3 skipped
  assertEquals(result.issuesRaised, 0);
  assertEquals(result.issuesSkipped, 3);
  assertEquals(state.issuesCreated.length, 0);
});

Deno.test("syncWorkflowsForRepo - second run creates no duplicate issues", async () => {
  // Simulate: all 3 universal issues already exist from first run.
  const { runner, state } = buildMockRunner({
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: [],
    existingIssues: new Set(["gitleaks", "semgrep", "markdown-lint"]),
  });

  const result = await syncWorkflowsForRepo("owner/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  assertEquals(result.issuesRaised, 0);
  assertEquals(result.issuesSkipped, 3);
  assertEquals(state.issuesCreated.length, 0);
});

// ---------------------------------------------------------------------------
// Issue content verification
// ---------------------------------------------------------------------------

Deno.test("syncWorkflowsForRepo - issues contain deduplication tags", async () => {
  const { runner, state } = buildMockRunner({
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: [],
  });

  await syncWorkflowsForRepo("owner/repo", { runCommand: runner });

  for (const issue of state.issuesCreated) {
    // Each issue body should contain the dedup tag
    assertEquals(
      issue.body.includes("<!-- vibe-coder:workflow-sync:"),
      true,
      `Issue "${issue.title}" should contain a deduplication tag`,
    );
  }
});

Deno.test("syncWorkflowsForRepo - issues contain workflow YAML template", async () => {
  const { runner, state } = buildMockRunner({
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: [],
  });

  await syncWorkflowsForRepo("owner/repo", { runCommand: runner });

  for (const issue of state.issuesCreated) {
    // Each issue body should contain a YAML code block
    assertEquals(
      issue.body.includes("```yaml"),
      true,
      `Issue "${issue.title}" should contain a YAML template`,
    );
  }
});

// ---------------------------------------------------------------------------
// Error handling — graceful degradation
// ---------------------------------------------------------------------------

Deno.test("syncWorkflowsForRepo - language detection failure returns error result", async () => {
  const { runner } = buildMockRunner({
    langDetectionFails: true,
  });

  const result = await syncWorkflowsForRepo("owner/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, false);
  assertEquals(result.repo, "owner/repo");
  assertEquals(typeof result.error, "string");
  assertEquals(result.issuesRaised, 0);
});

Deno.test("syncWorkflowsForRepo - issue creation failure does not block other issues", async () => {
  const { runner } = buildMockRunner({
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: [],
    issueCreationFails: true,
  });

  const result = await syncWorkflowsForRepo("owner/repo", {
    runCommand: runner,
  });

  // Should still succeed (graceful degradation) but with zero issues raised
  assertEquals(result.ok, true);
  assertEquals(result.issuesRaised, 0);
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

Deno.test("syncWorkflowsForRepo - dry run does not create issues", async () => {
  const { runner, state } = buildMockRunner({
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: [],
  });

  const result = await syncWorkflowsForRepo("owner/repo", {
    runCommand: runner,
    dryRun: true,
  });

  assertEquals(result.ok, true);
  // Reports missing count but creates nothing. 3 universal specs
  // (gitleaks, semgrep, markdown-lint — Issue #1686).
  assertEquals(result.issuesRaised, 3);
  assertEquals(state.issuesCreated.length, 0);
});

// ---------------------------------------------------------------------------
// syncWorkflowsForAllRepos
// ---------------------------------------------------------------------------

Deno.test("syncWorkflowsForAllRepos - processes multiple repos", async () => {
  // Use a runner that handles any repo
  const state: MockState = { issuesCreated: [], issueSearches: [] };
  const runner = (cmd: string[]): Promise<CommandOutput> => {
    const joined = cmd.join(" ");

    // Root contents (language detection)
    if (joined.includes("/contents/") && !joined.includes(".github")) {
      return Promise.resolve(
        ok(JSON.stringify([{ name: "README.md", type: "file" }])),
      );
    }
    // Languages API
    if (joined.includes("/languages")) {
      return Promise.resolve(ok("{}"));
    }
    // Workflow directory
    if (
      joined.includes("contents/.github/workflows") &&
      !joined.includes("Accept:")
    ) {
      return Promise.resolve(ok("[]"));
    }
    // Issue search
    if (joined.includes("gh issue list")) {
      return Promise.resolve(ok("[]"));
    }
    // Issue creation
    if (joined.includes("gh issue create")) {
      const repoIdx = cmd.indexOf("--repo");
      const titleIdx = cmd.indexOf("--title");
      state.issuesCreated.push({
        repo: repoIdx >= 0 ? cmd[repoIdx + 1]! : "",
        title: titleIdx >= 0 ? cmd[titleIdx + 1]! : "",
        body: "",
      });
      return Promise.resolve(ok("https://github.com/x/y/issues/1"));
    }
    return Promise.resolve(ok(""));
  };

  const results = await syncWorkflowsForAllRepos(
    ["org/repo1", "org/repo2"],
    { runCommand: runner },
  );

  assertEquals(results.length, 2);
  assertEquals(results[0]!.repo, "org/repo1");
  assertEquals(results[1]!.repo, "org/repo2");
  // Each repo should have 3 universal workflows missing
  // (gitleaks, semgrep, markdown-lint — Issue #1686).
  assertEquals(results[0]!.issuesRaised, 3);
  assertEquals(results[1]!.issuesRaised, 3);
});

Deno.test("syncWorkflowsForAllRepos - skips empty repo strings", async () => {
  const { runner } = buildMockRunner({
    rootFiles: ["README.md"],
    languagesApi: {},
    workflowFiles: [],
  });

  const results = await syncWorkflowsForAllRepos(
    ["owner/repo", "", "owner/repo"],
    { runCommand: runner },
  );

  assertEquals(results.length, 2);
});

Deno.test("syncWorkflowsForAllRepos - returns empty array for empty input", async () => {
  const { runner } = buildMockRunner({});

  const results = await syncWorkflowsForAllRepos([], { runCommand: runner });

  assertEquals(results.length, 0);
});

// ---------------------------------------------------------------------------
// Partial match — issue creation
// ---------------------------------------------------------------------------

// Rust workflow that satisfies only one of cargo-quality's two AND groups.
// Issue #1579 regrouped cargo-quality into two capability groups:
// [["cargo fmt", "rustfmt"], ["cargo clippy", "clippy"]]. This yaml only
// contains "cargo fmt" → format group satisfied, lint group missing → partial.
const cargoQualityPartialYaml = `name: Cargo Quality
on:
  pull_request:
jobs:
  fmt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cargo fmt --check
`;

Deno.test("partialDeduplicationTag - uses distinct tag from missing tag", () => {
  const missing = deduplicationTag("gitleaks");
  const partial = partialDeduplicationTag("gitleaks");

  assertEquals(partial, "<!-- vibe-coder:workflow-sync:partial:gitleaks -->");
  // Tags must differ so searches cannot collide.
  assertEquals(missing === partial, false);
  // Partial tag must not be a substring of the missing tag (which would
  // cause false positives in searches).
  assertEquals(missing.includes(partial), false);
  assertEquals(partial.includes(missing), false);
});

Deno.test("syncWorkflowsForRepo - raises issues for partial matches", async () => {
  // Rust repo has cargo-quality.yml satisfying only 1 of 4 AND groups.
  // Expected: 1 partial (cargo-quality), 5 missing
  // (3 universal — gitleaks, semgrep, markdown-lint per Issue #1686 —
  // plus cargo-audit + cargo-upgrade).
  const { runner, state } = buildMockRunner({
    rootFiles: ["Cargo.toml"],
    languagesApi: {},
    workflowFiles: ["cargo-quality.yml"],
    workflowContents: { "cargo-quality.yml": cargoQualityPartialYaml },
  });

  const result = await syncWorkflowsForRepo("owner/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  assertEquals(result.present, 0);
  assertEquals(result.partial, 1);
  // 5 missing → 5 issues raised; 1 partial → 1 partial issue raised.
  assertEquals(result.issuesRaised, 5);
  assertEquals(result.issuesSkipped, 0);
  assertEquals(result.partialIssuesRaised, 1);
  assertEquals(result.partialIssuesSkipped, 0);
  assertEquals(state.issuesCreated.length, 6);

  const partialIssue = state.issuesCreated.find((i) =>
    i.title.includes("Complete")
  );
  assertEquals(partialIssue !== undefined, true);
  assertEquals(
    partialIssue!.title,
    "Complete Cargo Format and Clippy workflow",
  );
});

Deno.test("syncWorkflowsForRepo - partial issue body uses capability-oriented language and notes alternative implementations", async () => {
  const { runner, state } = buildMockRunner({
    rootFiles: ["Cargo.toml"],
    languagesApi: {},
    workflowFiles: ["cargo-quality.yml"],
    workflowContents: { "cargo-quality.yml": cargoQualityPartialYaml },
  });

  await syncWorkflowsForRepo("owner/repo", { runCommand: runner });

  const partialIssue = state.issuesCreated.find((i) =>
    i.title.includes("Complete")
  );
  assertEquals(partialIssue !== undefined, true);

  const body = partialIssue!.body;
  // Body must reference the file where matches were found.
  assertEquals(body.includes("cargo-quality.yml"), true);
  // Body must use capability-oriented headings, not pattern-oriented.
  assertEquals(body.includes("Capabilities not detected"), true);
  assertEquals(body.includes("Capabilities detected"), true);
  assertEquals(body.includes("Patterns missing"), false);
  assertEquals(body.includes("Capabilities missing"), false);
  // Body must use human-readable capability labels for cargo-quality.
  // Issue #1579 capability labels: "Format check (cargo fmt or rustfmt)"
  // and "Lint check (cargo clippy or clippy)".
  // Detected: format capability — fmt is satisfied by the YAML.
  assertEquals(body.includes("Format check"), true);
  // Not detected: lint capability.
  assertEquals(body.includes("Lint check"), true);
  // Pattern strings still appear for traceability — alternatives are
  // listed inside the same group with "any of:".
  assertEquals(body.includes("`cargo fmt`"), true);
  assertEquals(body.includes("`rustfmt`"), true);
  assertEquals(body.includes("any of:"), true);
  // Body must explicitly explain that alternatives may not be detected
  // and ask the maintainer to close as not-applicable when appropriate.
  assertEquals(body.toLowerCase().includes("substring"), true);
  assertEquals(body.toLowerCase().includes("alternative"), true);
  assertEquals(body.toLowerCase().includes("not-applicable"), true);
  // Body must contain the partial deduplication tag.
  assertEquals(
    body.includes(partialDeduplicationTag("cargo-quality")),
    true,
  );
  // Body must NOT contain the missing-workflow tag (to avoid collisions).
  assertEquals(body.includes(deduplicationTag("cargo-quality")), false);
  // Body must include the workflow template for reference.
  assertEquals(body.includes("```yaml"), true);
});

Deno.test("syncWorkflowsForRepo - partial issues are idempotent", async () => {
  // Second run: a partial issue already exists for cargo-quality.
  const { runner, state } = buildMockRunner({
    rootFiles: ["Cargo.toml"],
    languagesApi: {},
    workflowFiles: ["cargo-quality.yml"],
    workflowContents: { "cargo-quality.yml": cargoQualityPartialYaml },
    existingPartialIssues: new Set(["cargo-quality"]),
  });

  const result = await syncWorkflowsForRepo("owner/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  assertEquals(result.partialIssuesRaised, 0);
  assertEquals(result.partialIssuesSkipped, 1);
  // No "Complete ..." issue should be created.
  const partialIssue = state.issuesCreated.find((i) =>
    i.title.includes("Complete")
  );
  assertEquals(partialIssue, undefined);
});

Deno.test("syncWorkflowsForRepo - missing and partial tags are searched separately", async () => {
  // Existing issue for cargo-quality as MISSING must NOT suppress the partial
  // issue (different tag → different search hit).
  const { runner, state } = buildMockRunner({
    rootFiles: ["Cargo.toml"],
    languagesApi: {},
    workflowFiles: ["cargo-quality.yml"],
    workflowContents: { "cargo-quality.yml": cargoQualityPartialYaml },
    existingIssues: new Set(["cargo-quality"]),
  });

  const result = await syncWorkflowsForRepo("owner/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  // cargo-quality is partial (not missing) so the missing-tag match does not
  // apply to it; the partial issue is still raised.
  assertEquals(result.partialIssuesRaised, 1);
  assertEquals(result.partialIssuesSkipped, 0);

  const partialIssue = state.issuesCreated.find((i) =>
    i.title.includes("Complete")
  );
  assertEquals(partialIssue !== undefined, true);

  // The search query for the partial must use the partial tag.
  const partialSearches = state.issueSearches.filter((s) =>
    s.query.includes(partialDeduplicationTag("cargo-quality"))
  );
  assertEquals(partialSearches.length >= 1, true);
});

Deno.test("syncWorkflowsForRepo - dry run reports partial count without creating issues", async () => {
  const { runner, state } = buildMockRunner({
    rootFiles: ["Cargo.toml"],
    languagesApi: {},
    workflowFiles: ["cargo-quality.yml"],
    workflowContents: { "cargo-quality.yml": cargoQualityPartialYaml },
  });

  const result = await syncWorkflowsForRepo("owner/repo", {
    runCommand: runner,
    dryRun: true,
  });

  assertEquals(result.ok, true);
  assertEquals(result.partial, 1);
  assertEquals(result.partialIssuesRaised, 1);
  assertEquals(state.issuesCreated.length, 0);
});

Deno.test("issueBodyPartial - standalone body uses capability labels and review note", () => {
  // Spec with two AND groups, each carrying an explicit capability label.
  // The first group (a single OR alternative pair) is reported as missing;
  // the second is satisfied.
  const spec = {
    id: "example",
    name: "Example Workflow",
    appliesTo: "universal" as const,
    triggers: ["pull_request"],
    detectionPatternGroups: [
      ["named/action", "cli-tool"],
      ["other-step"],
    ],
    capabilities: ["Primary capability", "Secondary capability"],
    suggestedFilename: "example.yml",
    category: "security" as const,
    template: "name: Example\non: [pull_request]\n",
  };

  const body = issueBodyPartial(spec, "existing.yml", [
    ["named/action", "cli-tool"],
  ]);

  assertEquals(body.includes("Partial Match"), true);
  assertEquals(body.includes("existing.yml"), true);
  // Missing group rendered as "- {capability} (any of: `pat1`, `pat2`)".
  assertEquals(
    body.includes("- Primary capability (any of: `named/action`, `cli-tool`)"),
    true,
  );
  // Satisfied single-element group rendered as "- {capability} (`pattern`)".
  assertEquals(body.includes("- Secondary capability (`other-step`)"), true);
  // Capability-oriented headings rather than pattern-oriented ones.
  assertEquals(body.includes("Capabilities not detected"), true);
  assertEquals(body.includes("Capabilities detected"), true);
  // Note about substring matching and not-applicable closure.
  assertEquals(body.toLowerCase().includes("substring"), true);
  assertEquals(body.toLowerCase().includes("not-applicable"), true);
  assertEquals(body.includes(partialDeduplicationTag("example")), true);
});

Deno.test("issueBodyPartial - falls back to first pattern when capability labels are absent", () => {
  // A spec with no `capabilities` field should still render readable bullets
  // by falling back to the first pattern in each group.
  const spec = {
    id: "legacy",
    name: "Legacy Workflow",
    appliesTo: "universal" as const,
    triggers: ["pull_request"],
    detectionPatternGroups: [["pat-a", "pat-b"], ["only-pat"]],
    suggestedFilename: "legacy.yml",
    category: "quality" as const,
    template: "name: Legacy\non: [pull_request]\n",
  };

  const body = issueBodyPartial(spec, "legacy.yml", [["pat-a", "pat-b"]]);

  // Fallback label is the first pattern in the group.
  assertEquals(body.includes("- pat-a (any of: `pat-a`, `pat-b`)"), true);
  assertEquals(body.includes("- only-pat (`only-pat`)"), true);
});

Deno.test("syncWorkflowsForAllRepos - one failing repo does not block others", async () => {
  let callCount = 0;
  const runner = (cmd: string[]): Promise<CommandOutput> => {
    const joined = cmd.join(" ");

    // First repo: fail language detection
    if (joined.includes("org/repo1")) {
      return Promise.resolve(fail("Network error"));
    }

    // Second repo: succeed
    if (joined.includes("/contents/") && !joined.includes(".github")) {
      return Promise.resolve(
        ok(JSON.stringify([{ name: "README.md", type: "file" }])),
      );
    }
    if (joined.includes("/languages")) {
      return Promise.resolve(ok("{}"));
    }
    if (
      joined.includes("contents/.github/workflows") &&
      !joined.includes("Accept:")
    ) {
      return Promise.resolve(ok("[]"));
    }
    if (joined.includes("gh issue list")) {
      return Promise.resolve(ok("[]"));
    }
    if (joined.includes("gh issue create")) {
      callCount++;
      return Promise.resolve(ok("https://github.com/x/y/issues/1"));
    }
    return Promise.resolve(ok(""));
  };

  const results = await syncWorkflowsForAllRepos(
    ["org/repo1", "org/repo2"],
    { runCommand: runner },
  );

  assertEquals(results.length, 2);
  assertEquals(results[0]!.ok, false, "First repo should fail");
  assertEquals(results[1]!.ok, true, "Second repo should succeed");
  // 3 universal workflows missing (gitleaks, semgrep, markdown-lint per
  // Issue #1686).
  assertEquals(results[1]!.issuesRaised, 3);
});

// ---------------------------------------------------------------------------
// Issue #1829 — Dedup must consider both open AND closed issues
// ---------------------------------------------------------------------------
//
// On 2026-04-30 private-repo-17 received duplicate "Add … workflow"
// issues (#1174–#1180) for workflows that were already present on the
// default branch. Earlier "Complete …" partial-match issues (#1151–#1153)
// had been raised and closed for the same specs. The dedup query
// previously filtered to `--state open` only, so a closed issue carrying
// the same workflow-sync tag did not suppress recreation. Search across
// both states (`--state all`) so previously-raised issues — whether still
// open or already closed — block re-raising the same one.

Deno.test(
  "syncWorkflowsForRepo - issue search uses '--state all' so closed issues dedupe (Issue #1829)",
  async () => {
    const { runner, state } = buildMockRunner({
      rootFiles: ["README.md"],
      languagesApi: {},
      workflowFiles: [],
    });

    await syncWorkflowsForRepo("owner/repo", { runCommand: runner });

    // Every dedup search must request all issue states. There are 3
    // universal specs so we expect 3 issue-list calls.
    assertEquals(
      state.issueSearches.length > 0,
      true,
      "Workflow sync must perform at least one dedup search",
    );
    // The mock runner stored the joined query string per call; the
    // real runner passes `--state all` as a separate argv element.
    // Verify the runner was invoked with `--state all` for every search
    // by intercepting the issue-list calls directly.
    const rawListCalls: string[][] = [];
    const wrapped: WorkflowSyncOptions["runCommand"] = (cmd) => {
      if (cmd.includes("gh") && cmd.includes("issue") && cmd.includes("list")) {
        rawListCalls.push([...cmd]);
      }
      return runner!(cmd);
    };
    await syncWorkflowsForRepo("owner/repo", { runCommand: wrapped });
    assertEquals(rawListCalls.length > 0, true);
    for (const cmd of rawListCalls) {
      const stateIdx = cmd.indexOf("--state");
      assertEquals(
        stateIdx >= 0 && cmd[stateIdx + 1] === "all",
        true,
        `dedup search should pass '--state all', got: ${cmd.join(" ")}`,
      );
    }
  },
);
