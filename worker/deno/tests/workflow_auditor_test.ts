/**
 * Tests for workflow_auditor.ts — repository workflow gap analysis.
 *
 * Issue #1393: Create workflow auditor to check repos for required GitHub Actions.
 */

import { assertEquals } from "@std/assert";
import { _resetGhSpawnRunner, _setGhSpawnRunner } from "../lib/gh_spawn.ts";
import {
  auditRepoWorkflows,
  type CommandOutput,
  type WorkflowAuditOptions,
} from "../lib/workflow_auditor.ts";
import type { RepoLanguages } from "../lib/language_detector.ts";
import {
  getWorkflowsForLanguagesAndVisibility,
  WORKFLOW_SPECS,
  type WorkflowSpec,
} from "../lib/workflow_definitions.ts";
import type { RepoVisibility } from "../lib/repo_visibility.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock runner keyed by API path.
 *
 * Keys should be the GitHub API path (e.g. "repos/owner/repo/contents/.github/workflows").
 * The mock extracts the API path from the `gh api <path> [flags...]` command
 * and matches it against the keys. Exact match is tried first, then substring.
 */
function mockRunner(
  responses: Record<string, CommandOutput>,
): (cmd: string[]) => Promise<CommandOutput> {
  return (cmd: string[]): Promise<CommandOutput> => {
    // Extract the API path — it's the argument after "api" in the command.
    const apiIdx = cmd.indexOf("api");
    const apiPath = apiIdx >= 0 && apiIdx + 1 < cmd.length
      ? cmd[apiIdx + 1]!
      : "";

    // Try exact match on the API path first.
    if (apiPath && apiPath in responses) {
      return Promise.resolve(responses[apiPath]!);
    }

    // Fall back to substring match on the full joined command.
    const joined = cmd.join(" ");
    for (const [key, value] of Object.entries(responses)) {
      if (joined.includes(key)) {
        return Promise.resolve(value);
      }
    }

    // Dependabot configuration (Issue #4904): absent unless a test supplies it.
    if (apiPath.includes("/contents/.github/dependabot.")) {
      return Promise.resolve(fail("Not Found (HTTP 404)"));
    }

    // Default: empty success
    return Promise.resolve({ success: true, stdout: "[]", stderr: "" });
  };
}

function ok(stdout: string): CommandOutput {
  return { success: true, stdout, stderr: "" };
}

function fail(stderr: string): CommandOutput {
  return { success: false, stdout: "", stderr };
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

/** Build a simple RepoLanguages object from a list of language names. */
function makeLanguages(langs: string[], primary?: string): RepoLanguages {
  const markerFiles: Record<string, string> = {
    Rust: "Cargo.toml",
    Deno: "deno.json",
    Node: "package.json",
    Java: "pom.xml",
    "React/Web": "index.html",
  };
  return {
    detected: langs.map((l) => ({
      language: l,
      confidence: "marker" as const,
      markerFile: markerFiles[l],
    })),
    primary: primary ?? langs[0] ?? "unknown",
    raw: {},
    rootFiles: langs.flatMap((language) =>
      markerFiles[language] ? [markerFiles[language]!] : []
    ),
  };
}

/** Gitleaks + semgrep workflow YAML content. */
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
    branches: ["*"]
jobs:
  semgrep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: semgrep/semgrep-action@v1
        with:
          config: p/default
`;

const cargoAuditYaml = `name: Cargo Audit
on:
  pull_request:
    branches: ["*"]
  schedule:
    - cron: "0 6 * * 1"
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      # Alternative: uses rustsec/audit-check action
      - run: cargo install cargo-audit
      - run: cargo audit
`;

const cargoQualityYaml = `name: Cargo Quality
on:
  pull_request:
    branches: ["*"]
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - run: cargo fmt --check
      - run: cargo clippy -- -D warnings
`;

const cargoUpgradeYaml = `name: Cargo Dependency Updates
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:
jobs:
  upgrade:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo install cargo-edit
      - run: cargo upgrade
      - run: cargo update
`;

// ---------------------------------------------------------------------------
// All workflows present
// ---------------------------------------------------------------------------

// Markdown lint workflow content (Issue #1686 added markdown-lint as a
// universal spec; detection requires `markdownlint-cli2` to appear in the
// workflow body).
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

Deno.test("workflow_auditor - all workflows present for Rust repo", async () => {
  const languages = makeLanguages(["Rust"]);
  const opts: WorkflowAuditOptions = {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows/gitleaks.yml": ok(
        gitleaksYaml,
      ),
      "repos/owner/repo/contents/.github/workflows/semgrep.yml": ok(
        semgrepYaml,
      ),
      "repos/owner/repo/contents/.github/workflows/markdown-lint.yml": ok(
        markdownLintYaml,
      ),
      "repos/owner/repo/contents/.github/workflows/cargo-audit.yml": ok(
        cargoAuditYaml,
      ),
      "repos/owner/repo/contents/.github/workflows/cargo-quality.yml": ok(
        cargoQualityYaml,
      ),
      "repos/owner/repo/contents/.github/workflows/cargo-upgrade.yml": ok(
        cargoUpgradeYaml,
      ),
      "repos/owner/repo/contents/.github/workflows": workflowDirResponse([
        "gitleaks.yml",
        "semgrep.yml",
        "markdown-lint.yml",
        "cargo-audit.yml",
        "cargo-quality.yml",
        "cargo-upgrade.yml",
      ]),
    }),
  };

  const result = await auditRepoWorkflows("owner/repo", languages, opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(
    result.value.missing.length,
    0,
    "All workflows should be present",
  );
  assertEquals(result.value.partial.length, 0, "No partial matches expected");
  // 3 universal (gitleaks, semgrep, markdown-lint) + 3 Rust = 6
  assertEquals(result.value.present.length, 6);
  assertEquals(result.value.repo, "owner/repo");
  assertEquals(result.value.languages.includes("Rust"), true);
});

// ---------------------------------------------------------------------------
// No workflows directory
// ---------------------------------------------------------------------------

Deno.test("workflow_auditor - repo with no .github/workflows directory", async () => {
  const languages = makeLanguages(["Rust"]);
  const opts: WorkflowAuditOptions = {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows": fail("Not Found"),
    }),
  };

  const result = await auditRepoWorkflows("owner/repo", languages, opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(result.value.present.length, 0, "No workflows found");
  assertEquals(result.value.partial.length, 0, "No partial matches");
  // 3 universal (gitleaks, semgrep, markdown-lint per Issue #1686) +
  // 3 Rust = 6 missing
  assertEquals(result.value.missing.length, 6);
});

// ---------------------------------------------------------------------------
// Partial matches
// ---------------------------------------------------------------------------

Deno.test("workflow_auditor - partial match when gitleaks present but no semgrep", async () => {
  const languages = makeLanguages(["Bash"]);
  const opts: WorkflowAuditOptions = {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows/security.yml": ok(
        gitleaksYaml,
      ),
      "repos/owner/repo/contents/.github/workflows": workflowDirResponse([
        "security.yml",
      ]),
    }),
  };

  const result = await auditRepoWorkflows("owner/repo", languages, opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // Gitleaks should be present
  const gitleaksMatch = result.value.present.find((m) =>
    m.spec.id === "gitleaks"
  );
  assertEquals(
    gitleaksMatch !== undefined,
    true,
    "Gitleaks should be detected",
  );

  // Semgrep should be missing (not partial, because none of its patterns match the gitleaks yaml)
  const semgrepMissing = result.value.missing.find((s) => s.id === "semgrep");
  assertEquals(semgrepMissing !== undefined, true, "Semgrep should be missing");
});

Deno.test("workflow_auditor - partial match when some detection patterns match", async () => {
  // A workflow that mentions "cargo fmt" but NOT any clippy-equivalent.
  // Issue #1579 regrouped cargo-quality into capability groups:
  // [["cargo fmt", "rustfmt"], ["cargo clippy", "clippy"]]. With only the
  // format capability satisfied, the lint group is missing → partial.
  const partialCargoYaml = `name: CI
on:
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cargo fmt --check
`;

  const languages = makeLanguages(["Rust"]);
  const opts: WorkflowAuditOptions = {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows/ci.yml": ok(
        partialCargoYaml,
      ),
      "repos/owner/repo/contents/.github/workflows": workflowDirResponse([
        "ci.yml",
      ]),
    }),
  };

  const result = await auditRepoWorkflows("owner/repo", languages, opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // Format group satisfied (cargo fmt); lint group missing → partial.
  const partial = result.value.partial.find((p) =>
    p.spec.id === "cargo-quality"
  );
  assertEquals(
    partial !== undefined,
    true,
    "cargo-quality should be a partial match",
  );
  if (partial) {
    assertEquals(partial.foundIn, "ci.yml");
    assertEquals(
      partial.missingGroups.length,
      1,
      "Only the lint group should be missing",
    );
    const missingFlat = partial.missingGroups.flat();
    assertEquals(missingFlat.includes("cargo clippy"), true);
    assertEquals(missingFlat.includes("clippy"), true);
  }
});

// ---------------------------------------------------------------------------
// Issue #1578 — alternative groups (any-of within group, all-of between groups)
// ---------------------------------------------------------------------------

Deno.test(
  "workflow_auditor - cargo-audit present when only `cargo audit` CLI is used (alternatives)",
  async () => {
    // Reproduces the false positive in issue #1578: a workflow that uses
    // the `cargo audit` CLI directly (without the rustsec/audit-check
    // action) should be classified as PRESENT, not partial.
    const cliOnlyYaml = `name: Cargo Audit
on:
  pull_request:
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo install cargo-audit
      - run: cargo audit
`;

    const languages = makeLanguages(["Rust"]);
    const opts: WorkflowAuditOptions = {
      runCommand: mockRunner({
        "repos/owner/repo/contents/.github/workflows/cargo-audit.yml": ok(
          cliOnlyYaml,
        ),
        "repos/owner/repo/contents/.github/workflows": workflowDirResponse([
          "cargo-audit.yml",
        ]),
      }),
    };

    const result = await auditRepoWorkflows("owner/repo", languages, opts);
    assertEquals(result.ok, true);
    if (!result.ok) return;

    const presentIds = result.value.present.map((m) => m.spec.id);
    assertEquals(
      presentIds.includes("cargo-audit"),
      true,
      "cargo-audit should be PRESENT when only the CLI is used",
    );
    assertEquals(
      result.value.partial.find((p) => p.spec.id === "cargo-audit"),
      undefined,
      "cargo-audit should not be partial",
    );
  },
);

Deno.test(
  "workflow_auditor - shellcheck present when ludeeus action template is used",
  async () => {
    // Reproduces the false positive: the provided ShellCheck template uses
    // ludeeus/action-shellcheck which should satisfy the alternative group.
    const ludeeusYaml = `name: ShellCheck
on:
  pull_request:
jobs:
  shellcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ludeeus/action-shellcheck@master
        with:
          severity: warning
`;

    const languages = makeLanguages(["Bash"]);
    const opts: WorkflowAuditOptions = {
      runCommand: mockRunner({
        "repos/owner/repo/contents/.github/workflows/shellcheck.yml": ok(
          ludeeusYaml,
        ),
        "repos/owner/repo/contents/.github/workflows": workflowDirResponse([
          "shellcheck.yml",
        ]),
      }),
    };

    const result = await auditRepoWorkflows("owner/repo", languages, opts);
    assertEquals(result.ok, true);
    if (!result.ok) return;

    const presentIds = result.value.present.map((m) => m.spec.id);
    assertEquals(
      presentIds.includes("shellcheck"),
      true,
      "shellcheck should be PRESENT when ludeeus/action-shellcheck is used",
    );
  },
);

Deno.test(
  "workflow_auditor - single OR group: any-of one match is sufficient (synthetic spec)",
  async () => {
    // Use a real spec (gitleaks) which is modelled as a single OR group of
    // ["gitleaks/gitleaks-action", "gitleaks"]. A workflow that mentions
    // only "gitleaks" (not the action) is still fully present.
    const cliOnlyGitleaks = `name: Secrets
on: [pull_request]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: gitleaks detect --source .
`;

    const languages = makeLanguages([]);
    const opts: WorkflowAuditOptions = {
      runCommand: mockRunner({
        "repos/owner/repo/contents/.github/workflows/secrets.yml": ok(
          cliOnlyGitleaks,
        ),
        "repos/owner/repo/contents/.github/workflows": workflowDirResponse([
          "secrets.yml",
        ]),
      }),
    };

    const result = await auditRepoWorkflows("owner/repo", languages, opts);
    assertEquals(result.ok, true);
    if (!result.ok) return;

    const presentIds = result.value.present.map((m) => m.spec.id);
    assertEquals(presentIds.includes("gitleaks"), true);
  },
);

Deno.test(
  "workflow_auditor - multiple groups: all groups must be satisfied for present",
  async () => {
    // Issue #1579: cargo-quality groups are
    // [["cargo fmt", "rustfmt"], ["cargo clippy", "clippy"]]. A yaml that
    // satisfies both capabilities (format + lint) → present.
    const fullCargoYaml = `name: Cargo Quality
on: [pull_request]
jobs:
  q:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - run: cargo fmt --check
      - run: cargo clippy -- -D warnings
`;

    const languages = makeLanguages(["Rust"]);
    const opts: WorkflowAuditOptions = {
      runCommand: mockRunner({
        "repos/owner/repo/contents/.github/workflows/cargo-quality.yml": ok(
          fullCargoYaml,
        ),
        "repos/owner/repo/contents/.github/workflows": workflowDirResponse([
          "cargo-quality.yml",
        ]),
      }),
    };

    const result = await auditRepoWorkflows("owner/repo", languages, opts);
    assertEquals(result.ok, true);
    if (!result.ok) return;

    const presentIds = result.value.present.map((m) => m.spec.id);
    assertEquals(
      presentIds.includes("cargo-quality"),
      true,
      "All 4 cargo-quality groups satisfied → present",
    );
  },
);

Deno.test(
  "workflow_auditor - missing classification when no group matches",
  async () => {
    // cargo-quality with NONE of its patterns present anywhere.
    const unrelatedYaml = `name: CI
on: [pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo nothing-rust-related
`;

    const languages = makeLanguages(["Rust"]);
    const opts: WorkflowAuditOptions = {
      runCommand: mockRunner({
        "repos/owner/repo/contents/.github/workflows/ci.yml": ok(unrelatedYaml),
        "repos/owner/repo/contents/.github/workflows": workflowDirResponse([
          "ci.yml",
        ]),
      }),
    };

    const result = await auditRepoWorkflows("owner/repo", languages, opts);
    assertEquals(result.ok, true);
    if (!result.ok) return;

    const missingIds = result.value.missing.map((s) => s.id);
    assertEquals(
      missingIds.includes("cargo-quality"),
      true,
      "cargo-quality should be missing when no pattern matches",
    );
    assertEquals(
      result.value.partial.find((p) => p.spec.id === "cargo-quality"),
      undefined,
      "cargo-quality should not be partial",
    );
  },
);

// ---------------------------------------------------------------------------
// Multi-language repos
// ---------------------------------------------------------------------------

Deno.test("workflow_auditor - multi-language repo checks union of all required workflows", async () => {
  const languages = makeLanguages(["Rust", "Bash"]);
  const opts: WorkflowAuditOptions = {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows/gitleaks.yml": ok(
        gitleaksYaml,
      ),
      "repos/owner/repo/contents/.github/workflows/semgrep.yml": ok(
        semgrepYaml,
      ),
      "repos/owner/repo/contents/.github/workflows": workflowDirResponse([
        "gitleaks.yml",
        "semgrep.yml",
      ]),
    }),
  };

  const result = await auditRepoWorkflows("owner/repo", languages, opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // Universal (2 of 3 present — markdown-lint missing per Issue #1686).
  assertEquals(result.value.present.length, 2);

  // Missing should include the universal markdown-lint plus Rust-specific
  // (3) + Bash-specific (1).
  const missingIds = result.value.missing.map((s) => s.id);
  assertEquals(
    missingIds.includes("markdown-lint"),
    true,
    "markdown-lint should be missing",
  );
  assertEquals(
    missingIds.includes("cargo-audit"),
    true,
    "cargo-audit should be missing",
  );
  assertEquals(
    missingIds.includes("cargo-upgrade"),
    true,
    "cargo-upgrade should be missing",
  );
  assertEquals(
    missingIds.includes("cargo-quality"),
    true,
    "cargo-quality should be missing",
  );
  assertEquals(
    missingIds.includes("shellcheck"),
    true,
    "shellcheck should be missing",
  );

  // Languages in result should reflect both
  assertEquals(result.value.languages.includes("Rust"), true);
  assertEquals(result.value.languages.includes("Bash"), true);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

Deno.test("workflow_auditor - API failure returns Result error", async () => {
  const languages = makeLanguages(["Rust"]);
  const opts: WorkflowAuditOptions = {
    runCommand: (_cmd: string[]): Promise<CommandOutput> => {
      return Promise.reject(new Error("Network error"));
    },
  };

  const result = await auditRepoWorkflows("owner/repo", languages, opts);
  assertEquals(result.ok, false);
  if (result.ok) return;

  assertEquals(typeof result.error, "string");
});

Deno.test("workflow_auditor - invalid JSON from workflow listing returns error", async () => {
  const languages = makeLanguages(["Rust"]);
  const opts: WorkflowAuditOptions = {
    runCommand: mockRunner({
      "contents/.github/workflows": ok("not valid json{{{"),
    }),
  };

  const result = await auditRepoWorkflows("owner/repo", languages, opts);
  assertEquals(result.ok, false);
  if (result.ok) return;

  assertEquals(result.error.length > 0, true);
});

// ---------------------------------------------------------------------------
// Detection patterns match real-world private-repo-14-style YAML
// ---------------------------------------------------------------------------

Deno.test("workflow_auditor - detects workflows from private-repo-14-style combined YAML", async () => {
  // A single combined workflow file containing multiple tools
  const combinedYaml = `name: Security
on:
  pull_request:
    branches: ["*"]
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
  semgrep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: semgrep/semgrep-action@v1
        with:
          config: p/default
`;

  const languages = makeLanguages(["Bash"]);
  const opts: WorkflowAuditOptions = {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows/security.yml": ok(
        combinedYaml,
      ),
      "repos/owner/repo/contents/.github/workflows": workflowDirResponse([
        "security.yml",
      ]),
    }),
  };

  const result = await auditRepoWorkflows("owner/repo", languages, opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // Both universal workflows should be detected in the single combined file
  const presentIds = result.value.present.map((m) => m.spec.id);
  assertEquals(
    presentIds.includes("gitleaks"),
    true,
    "Gitleaks should be found",
  );
  assertEquals(presentIds.includes("semgrep"), true, "Semgrep should be found");

  // Verify foundIn references the combined file
  for (const match of result.value.present) {
    assertEquals(match.foundIn, "security.yml");
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("workflow_auditor - empty workflows directory means all missing", async () => {
  const languages = makeLanguages(["Bash"]);
  const opts: WorkflowAuditOptions = {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows": ok("[]"),
    }),
  };

  const result = await auditRepoWorkflows("owner/repo", languages, opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(result.value.present.length, 0);
  // 3 universal (gitleaks, semgrep, markdown-lint per Issue #1686) +
  // 1 shellcheck = 4
  assertEquals(result.value.missing.length, 4);
});

Deno.test("workflow_auditor - workflow found under different filename", async () => {
  // The file is called "ci.yml" but it contains gitleaks patterns
  const languages = makeLanguages([]);
  const opts: WorkflowAuditOptions = {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows/ci.yml": ok(gitleaksYaml),
      "repos/owner/repo/contents/.github/workflows": workflowDirResponse([
        "ci.yml",
      ]),
    }),
  };

  const result = await auditRepoWorkflows("owner/repo", languages, opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const gitleaksMatch = result.value.present.find((m) =>
    m.spec.id === "gitleaks"
  );
  assertEquals(
    gitleaksMatch !== undefined,
    true,
    "Gitleaks should be detected in ci.yml",
  );
  assertEquals(gitleaksMatch!.foundIn, "ci.yml");
});

// ---------------------------------------------------------------------------
// Visibility-aware filtering (Issue #1753)
// ---------------------------------------------------------------------------

/** Stub spec used to verify visibility filtering in the auditor. */
const stubPublicOnlySpec: WorkflowSpec = {
  id: "stub-public-only",
  name: "Stub Public Only",
  appliesTo: "universal",
  triggers: ["pull_request"],
  detectionPatternGroups: [["stub-pattern-not-in-any-real-yaml"]],
  suggestedFilename: "stub-public-only.yml",
  template:
    "name: Stub\non: [pull_request]\njobs:\n  s: { runs-on: ubuntu-latest }\n",
  category: "security",
  visibilityScope: "public-only",
};

/** Resolver that injects the stub alongside the real catalogue resolution. */
function resolverWithStub(
  languages: string[],
  visibility: RepoVisibility,
): WorkflowSpec[] {
  const real = getWorkflowsForLanguagesAndVisibility(languages, visibility);
  // Apply the same visibility filter to the stub.
  if (
    visibility === "public" ||
    stubPublicOnlySpec.visibilityScope !== "public-only"
  ) {
    return [...real, stubPublicOnlySpec];
  }
  return real;
}

/** Mock runner that reports the given visibility for the repo lookup. */
function runnerWithVisibility(
  visibility: "public" | "private" | "fail",
  workflowResponses: Record<string, CommandOutput> = {},
): (cmd: string[]) => Promise<CommandOutput> {
  return (cmd: string[]): Promise<CommandOutput> => {
    const apiIdx = cmd.indexOf("api");
    const apiPath = apiIdx >= 0 && apiIdx + 1 < cmd.length
      ? cmd[apiIdx + 1]!
      : "";

    // Visibility lookup: gh api repos/{owner}/{repo} --jq .visibility
    const isVisibilityCall = cmd.includes("--jq") &&
      cmd.includes(".visibility");
    if (isVisibilityCall) {
      if (visibility === "fail") {
        return Promise.resolve({ success: false, stdout: "", stderr: "boom" });
      }
      return Promise.resolve({ success: true, stdout: visibility, stderr: "" });
    }

    // Workflow lookups — exact match on API path first.
    if (apiPath in workflowResponses) {
      return Promise.resolve(workflowResponses[apiPath]!);
    }
    return Promise.resolve({ success: true, stdout: "[]", stderr: "" });
  };
}

Deno.test(
  "workflow_auditor - private repo omits public-only spec from missing/partial/present",
  async () => {
    const languages = makeLanguages([]);
    const opts: WorkflowAuditOptions = {
      runCommand: runnerWithVisibility("private", {
        "repos/owner/repo/contents/.github/workflows": ok("[]"),
      }),
      specsResolver: resolverWithStub,
    };

    const result = await auditRepoWorkflows("owner/repo", languages, opts);
    assertEquals(result.ok, true);
    if (!result.ok) return;

    const allIds = [
      ...result.value.present.map((p) => p.spec.id),
      ...result.value.partial.map((p) => p.spec.id),
      ...result.value.missing.map((s) => s.id),
    ];
    assertEquals(
      allIds.includes("stub-public-only"),
      false,
      "public-only stub must not appear in private repo audit",
    );
  },
);

Deno.test(
  "workflow_auditor - public repo evaluates public-only spec normally",
  async () => {
    const languages = makeLanguages([]);
    const opts: WorkflowAuditOptions = {
      runCommand: runnerWithVisibility("public", {
        "repos/owner/repo/contents/.github/workflows": ok("[]"),
      }),
      specsResolver: resolverWithStub,
    };

    const result = await auditRepoWorkflows("owner/repo", languages, opts);
    assertEquals(result.ok, true);
    if (!result.ok) return;

    const missingIds = result.value.missing.map((s) => s.id);
    assertEquals(
      missingIds.includes("stub-public-only"),
      true,
      "public-only stub should be classified as missing for public repo",
    );
  },
);

Deno.test(
  "workflow_auditor - visibility lookup failure falls back to private (omits public-only)",
  async () => {
    const languages = makeLanguages([]);
    const opts: WorkflowAuditOptions = {
      runCommand: runnerWithVisibility("fail", {
        "repos/owner/repo/contents/.github/workflows": ok("[]"),
      }),
      specsResolver: resolverWithStub,
    };

    const result = await auditRepoWorkflows("owner/repo", languages, opts);
    assertEquals(result.ok, true);
    if (!result.ok) return;

    const allIds = [
      ...result.value.present.map((p) => p.spec.id),
      ...result.value.partial.map((p) => p.spec.id),
      ...result.value.missing.map((s) => s.id),
    ];
    assertEquals(
      allIds.includes("stub-public-only"),
      false,
      "On visibility-lookup failure the auditor must behave as if private",
    );
  },
);

// ---------------------------------------------------------------------------
// Issue #1829 — Distinguish 404 (legitimately empty) from transient failures
// ---------------------------------------------------------------------------
//
// The original behaviour silently returned an empty workflow list whenever
// the listing API call failed for ANY reason (rate limit, auth, 5xx, etc.).
// That misclassified every required workflow as missing and caused
// workflow-sync to raise duplicate "Add … workflow" issues against repos
// where the workflows were in fact present (e.g. private-repo-17 on
// 2026-04-30 raised #1174–#1180 even though six of the seven workflows
// were already on the default branch). The fix: only treat an explicit
// "Not Found" / 404 as legitimately empty; propagate other failures as
// audit errors so the caller does not raise spurious issues.

Deno.test(
  "workflow_auditor - returns error when listing fails with non-404 stderr (Issue #1829)",
  async () => {
    const languages = makeLanguages(["Rust"]);
    const opts: WorkflowAuditOptions = {
      runCommand: mockRunner({
        // Simulate a transient API failure such as rate limiting or auth.
        "repos/owner/repo/contents/.github/workflows": fail(
          "API rate limit exceeded for user ID 12345",
        ),
      }),
    };

    const result = await auditRepoWorkflows("owner/repo", languages, opts);
    assertEquals(
      result.ok,
      false,
      "Transient listing failure must propagate as an audit error so " +
        "no false 'missing workflow' issues are raised (Issue #1829).",
    );
  },
);

Deno.test(
  "workflow_auditor - treats explicit 'Not Found' as legitimately empty (Issue #1829)",
  async () => {
    // The legitimate 404 path — `.github/workflows` directory simply does
    // not exist — must continue to be classified as success-with-no-files,
    // i.e. all required workflows missing. This preserves the existing
    // behaviour for new repos without any workflows at all.
    const languages = makeLanguages(["Rust"]);
    const opts: WorkflowAuditOptions = {
      runCommand: mockRunner({
        "repos/owner/repo/contents/.github/workflows": fail(
          "gh: Not Found (HTTP 404)",
        ),
      }),
    };

    const result = await auditRepoWorkflows("owner/repo", languages, opts);
    assertEquals(result.ok, true);
    if (!result.ok) return;
    // 3 universal (gitleaks, semgrep, markdown-lint) + 3 Rust = 6 missing.
    assertEquals(result.value.missing.length, 6);
    assertEquals(result.value.present.length, 0);
    assertEquals(result.value.partial.length, 0);
  },
);

Deno.test("workflow_auditor - API-only Rust does not require root Cargo workflows", async () => {
  const languages: RepoLanguages = {
    detected: [{ language: "Rust", confidence: "api" }],
    primary: "Rust",
    raw: { Rust: 4927 },
  };
  const result = await auditRepoWorkflows("owner/repo", languages, {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows": ok("[]"),
    }),
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.missing.some((spec) => spec.id.startsWith("cargo-")),
    false,
  );
  assertEquals(
    result.value.notApplicable.map((spec) => spec.id).filter((id) =>
      id.startsWith("cargo-")
    ),
    [
      "cargo-audit",
      "cargo-upgrade",
      "cargo-quality",
    ],
  );
});

Deno.test("workflow_auditor - root Cargo marker keeps all Cargo workflows", async () => {
  const result = await auditRepoWorkflows(
    "owner/repo",
    {
      detected: [{
        language: "Rust",
        confidence: "marker",
        markerFile: "Cargo.toml",
      }],
      primary: "Rust",
      raw: { Rust: 4927 },
      rootFiles: ["Cargo.toml"],
    },
    {
      runCommand: mockRunner({
        "repos/owner/repo/contents/.github/workflows": ok("[]"),
      }),
    },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.missing.map((spec) => spec.id).filter((id) =>
      id.startsWith("cargo-")
    ),
    ["cargo-audit", "cargo-upgrade", "cargo-quality"],
  );
  assertEquals(
    result.value.notApplicable.some((spec) => spec.id.startsWith("cargo-")),
    false,
  );
});

Deno.test("workflow_auditor - mixed languages retain marker workflows and universal specs", async () => {
  const result = await auditRepoWorkflows(
    "owner/repo",
    {
      detected: [
        { language: "Deno", confidence: "marker", markerFile: "deno.json" },
        { language: "Rust", confidence: "api" },
      ],
      primary: "Rust",
      raw: { Deno: 500, Rust: 4927 },
      rootFiles: ["deno.json"],
    },
    {
      runCommand: mockRunner({
        "repos/owner/repo/contents/.github/workflows": ok("[]"),
      }),
    },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const missing = result.value.missing.map((spec) => spec.id);
  assertEquals(missing.includes("deno-quality"), true);
  assertEquals(missing.includes("cargo-audit"), false);
  assertEquals(missing.includes("gitleaks"), true);
  assertEquals(missing.includes("semgrep"), true);
  assertEquals(missing.includes("markdown-lint"), true);
});

Deno.test("workflow_auditor - repository-wide templates accept nested project languages", async () => {
  const languages: RepoLanguages = {
    detected: [
      { language: "Bash", confidence: "api" },
      { language: "Java", confidence: "api" },
    ],
    primary: "Java",
    raw: { Bash: 100, Java: 200 },
  };
  const result = await auditRepoWorkflows("owner/repo", languages, {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows": ok("[]"),
    }),
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const missing = result.value.missing.map((spec) => spec.id);
  assertEquals(missing.includes("shellcheck"), true);
  assertEquals(missing.includes("java-dependency-check"), true);
  assertEquals(missing.includes("java-dependency-updates"), false);
  assertEquals(missing.includes("java-gradle-dependency-updates"), false);
  assertEquals(
    result.value.notApplicable.map((spec) => spec.id).filter((id) =>
      id.startsWith("java-")
    ),
    [
      "java-dependency-updates",
      "java-gradle-dependency-updates",
    ],
  );
});

Deno.test("workflow_auditor - Java Gradle build file alone files only the Gradle Dependabot spec", async () => {
  const languages: RepoLanguages = {
    detected: [{ language: "Java", confidence: "api" }],
    primary: "Java",
    raw: { Java: 200 },
    rootFiles: ["build.gradle"],
  };
  const result = await auditRepoWorkflows("owner/repo", languages, {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows": ok("[]"),
    }),
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.missing.map((spec) => spec.id).includes(
      "java-gradle-dependency-updates",
    ),
    true,
  );
  assertEquals(
    result.value.missing.map((spec) => spec.id).includes(
      "java-dependency-updates",
    ),
    false,
  );
  assertEquals(
    result.value.notApplicable.map((spec) => spec.id).includes(
      "java-dependency-updates",
    ),
    true,
  );
});

Deno.test("workflow_auditor - Java Gradle Kotlin DSL build file alone files only the Gradle Dependabot spec", async () => {
  const languages: RepoLanguages = {
    detected: [{ language: "Java", confidence: "api" }],
    primary: "Java",
    raw: { Java: 200 },
    rootFiles: ["build.gradle.kts"],
  };
  const result = await auditRepoWorkflows("owner/repo", languages, {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows": ok("[]"),
    }),
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.missing.map((spec) => spec.id).includes(
      "java-gradle-dependency-updates",
    ),
    true,
  );
  assertEquals(
    result.value.missing.map((spec) => spec.id).includes(
      "java-dependency-updates",
    ),
    false,
  );
  assertEquals(
    result.value.notApplicable.map((spec) => spec.id).includes(
      "java-dependency-updates",
    ),
    true,
  );
});

Deno.test("workflow_auditor - Maven pom.xml alone files only the Maven Dependabot spec", async () => {
  const languages: RepoLanguages = {
    detected: [{ language: "Java", confidence: "api" }],
    primary: "Java",
    raw: { Java: 200 },
    rootFiles: ["pom.xml"],
  };
  const result = await auditRepoWorkflows("owner/repo", languages, {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows": ok("[]"),
    }),
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.missing.map((spec) => spec.id).includes(
      "java-dependency-updates",
    ),
    true,
  );
  assertEquals(
    result.value.missing.map((spec) => spec.id).includes(
      "java-gradle-dependency-updates",
    ),
    false,
  );
  assertEquals(
    result.value.notApplicable.map((spec) => spec.id).includes(
      "java-gradle-dependency-updates",
    ),
    true,
  );
});

Deno.test("workflow_auditor - Maven-only Dependabot entry does not satisfy the Gradle spec", async () => {
  // The header names Dependabot, as the old template did: a bare `dependabot`
  // detection pattern on the Gradle spec would wrongly match it.
  const mavenOnlyWorkflow = `# Dependabot configuration for Maven
version: 2
updates:
  - package-ecosystem: maven
    directory: /
    schedule:
      interval: weekly
`;
  const languages: RepoLanguages = {
    detected: [{ language: "Java", confidence: "api" }],
    primary: "Java",
    raw: { Java: 200 },
    rootFiles: ["build.gradle"],
  };
  const result = await auditRepoWorkflows("owner/repo", languages, {
    runCommand: mockRunner({
      "repos/owner/repo/contents/.github/workflows/java-dependabot.yml": ok(
        mavenOnlyWorkflow,
      ),
      "repos/owner/repo/contents/.github/workflows": workflowDirResponse([
        "java-dependabot.yml",
      ]),
    }),
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.missing.map((spec) => spec.id).includes(
      "java-gradle-dependency-updates",
    ),
    true,
  );
  assertEquals(
    result.value.present.map((match) => match.spec.id).includes(
      "java-gradle-dependency-updates",
    ),
    false,
  );
  assertEquals(
    result.value.partial.map((match) => match.spec.id).includes(
      "java-gradle-dependency-updates",
    ),
    false,
  );
});

Deno.test("workflow_auditor - web asset marker alone does not satisfy npm root manifest", async () => {
  const result = await auditRepoWorkflows(
    "owner/repo",
    {
      detected: [{
        language: "React/Web",
        confidence: "marker",
        markerFile: "index.html",
      }],
      primary: "React/Web",
      raw: {},
    },
    {
      runCommand: mockRunner({
        "repos/owner/repo/contents/.github/workflows": ok("[]"),
      }),
    },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.missing.some((spec) =>
      spec.id.startsWith("npm-") || spec.id === "eslint-quality"
    ),
    false,
  );
  assertEquals(
    result.value.notApplicable.map((spec) => spec.id).filter((id) =>
      id.startsWith("npm-") || id === "eslint-quality"
    ),
    [
      "npm-audit",
      "npm-dependency-updates",
      "eslint-quality",
    ],
  );
});

// ---------------------------------------------------------------------------
// gh spawn chokepoint (Issue #1227)
// ---------------------------------------------------------------------------

Deno.test("workflow_auditor - the default runner routes gh through the shared chokepoint", async () => {
  // The default runner names its binary through `cmd[0]`, so before Issue
  // #1227 it spawned `gh` itself — skipping the write-repo allowlist, the
  // timeout and the audit journal that `spawnGh` owns.
  const calls: string[][] = [];
  _setGhSpawnRunner((args) => {
    calls.push([...args]);
    // An empty workflows directory: the audit needs no further calls.
    return Promise.resolve({
      code: 1,
      success: false,
      stdout: "",
      stderr: "gh: Not Found (HTTP 404)",
    });
  });

  const languages: RepoLanguages = {
    detected: [{ language: "Deno", confidence: "marker" }],
    primary: "Deno",
    raw: {},
    rootFiles: [],
  };

  try {
    // No `runCommand` override — this exercises the production default.
    const result = await auditRepoWorkflows("owner/repo", languages);
    assertEquals(result.ok, true);
    assertEquals(
      calls.some((c) =>
        c.join(" ") === "api repos/owner/repo/contents/.github/workflows"
      ),
      true,
    );
  } finally {
    _resetGhSpawnRunner();
  }
});

Deno.test("workflow_auditor - legacy language data fetches actual root files instead of selected markers", async () => {
  const result = await auditRepoWorkflows("owner/repo", {
    detected: [{
      language: "Deno",
      confidence: "marker",
      markerFile: "deno.json",
    }, {
      language: "React/Web",
      confidence: "marker",
      markerFile: "index.html",
    }],
    primary: "Deno",
    raw: {},
  }, {
    runCommand: mockRunner({
      "repos/owner/repo/contents/": ok(
        JSON.stringify(
          ["deno.json", "package.json", "index.html"].map((name) => ({
            name,
            type: "file",
          })),
        ),
      ),
      "repos/owner/repo/contents/.github/workflows": ok("[]"),
    }),
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.missing.some((spec) => spec.id === "npm-audit"),
    true,
  );
  assertEquals(
    result.value.notApplicable.some((spec) => spec.id === "npm-audit"),
    false,
  );
});

Deno.test("workflow_auditor - failed root evidence lookup cannot authorise closures", async () => {
  const result = await auditRepoWorkflows("owner/repo", {
    detected: [],
    primary: "unknown",
    raw: {},
  }, {
    runCommand: mockRunner({
      "repos/owner/repo/contents/": fail("HTTP 403: forbidden"),
    }),
  });
  assertEquals(result, {
    ok: false,
    error: "Failed to fetch repository contents: HTTP 403: forbidden",
  });
});

Deno.test("workflow_auditor - known root prerequisites remain inapplicable after every language disappears", async () => {
  const result = await auditRepoWorkflows("owner/repo", {
    detected: [],
    primary: "unknown",
    raw: {},
    rootFiles: ["README.md"],
  }, { runCommand: mockRunner({}) });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.notApplicable.map((spec) => spec.id), [
    "cargo-audit",
    "cargo-upgrade",
    "cargo-quality",
    "deno-outdated",
    "deno-quality",
    "npm-audit",
    "npm-dependency-updates",
    "eslint-quality",
    "java-dependency-updates",
    "java-gradle-dependency-updates",
  ]);
});

// ---------------------------------------------------------------------------
// Dependabot configuration (Issue #4904)
// ---------------------------------------------------------------------------

const WORKFLOWS_API_PATH = "repos/owner/repo/contents/.github/workflows";
const DEPENDABOT_YML_API_PATH =
  "repos/owner/repo/contents/.github/dependabot.yml";
const DEPENDABOT_YAML_API_PATH =
  "repos/owner/repo/contents/.github/dependabot.yaml";

/** A Dependabot config for npm, with the header comment the template ships. */
const DEPENDABOT_NPM_YAML =
  `# Dependabot configuration (place in .github/dependabot.yml)
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
`;

/**
 * Build a runner that answers the visibility lookup as private, an empty
 * workflow directory, and `respond` for every other API path. Records each
 * API path it is asked for.
 */
function dependabotAwareRunner(
  files: Record<string, CommandOutput>,
): {
  runner: (cmd: string[]) => Promise<CommandOutput>;
  apiPaths: string[];
  commands: string[][];
} {
  const apiPaths: string[] = [];
  const commands: string[][] = [];
  const runner = (cmd: string[]): Promise<CommandOutput> => {
    commands.push(cmd);
    const apiIdx = cmd.indexOf("api");
    const apiPath = apiIdx >= 0 ? cmd[apiIdx + 1] ?? "" : "";
    apiPaths.push(apiPath);
    if (apiPath === "repos/owner/repo") {
      return Promise.resolve(ok(JSON.stringify({ visibility: "private" })));
    }
    if (apiPath === WORKFLOWS_API_PATH) {
      return Promise.resolve(ok("[]"));
    }
    return Promise.resolve(files[apiPath] ?? fail("Not Found (HTTP 404)"));
  };
  return { runner, apiPaths, commands };
}

Deno.test("workflow_auditor - a Dependabot config alone makes npm-dependency-updates present, foundIn its path", async () => {
  const { runner } = dependabotAwareRunner({
    [DEPENDABOT_YML_API_PATH]: ok(DEPENDABOT_NPM_YAML),
  });
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node"]),
    { runCommand: runner },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const match = result.value.present.find((m) =>
    m.spec.id === "npm-dependency-updates"
  );
  assertEquals(match?.foundIn, ".github/dependabot.yml");
  assertEquals(
    result.value.missing.some((s) => s.id === "npm-dependency-updates"),
    false,
  );
});

Deno.test("workflow_auditor - a hand-written npm dependabot.yml with no tool-name mention still makes npm-dependency-updates present", async () => {
  // Deliberately free of "dependabot", "renovate", "ncu" and
  // "npm-check-updates": only the package-ecosystem line identifies it.
  const handWritten = `version: 2
updates:
  - package-ecosystem: npm
    directory: /
`;
  const { runner } = dependabotAwareRunner({
    [DEPENDABOT_YML_API_PATH]: ok(handWritten),
  });
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node"]),
    { runCommand: runner },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const match = result.value.present.find((m) =>
    m.spec.id === "npm-dependency-updates"
  );
  assertEquals(match?.foundIn, ".github/dependabot.yml");
  assertEquals(
    result.value.missing.some((s) => s.id === "npm-dependency-updates"),
    false,
  );
});

Deno.test("workflow_auditor - no Dependabot config (404 on both names) leaves npm-dependency-updates missing", async () => {
  const { runner, apiPaths } = dependabotAwareRunner({});
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node"]),
    { runCommand: runner },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(
    result.value.missing.some((s) => s.id === "npm-dependency-updates"),
    true,
  );
  assertEquals(apiPaths.includes(DEPENDABOT_YML_API_PATH), true);
  assertEquals(apiPaths.includes(DEPENDABOT_YAML_API_PATH), true);
});

Deno.test("workflow_auditor - a non-404 failure reading the Dependabot config fails the audit", async () => {
  const { runner } = dependabotAwareRunner({
    [DEPENDABOT_YML_API_PATH]: fail("API rate limit exceeded"),
  });
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node"]),
    { runCommand: runner },
  );
  assertEquals(result.ok, false);
});

Deno.test("workflow_auditor - localRepoPath reads .github/dependabot.yml from disk, not the API", async () => {
  const tmpDir = await Deno.makeTempDir({
    prefix: "workflow_auditor_dependabot_",
  });
  try {
    await Deno.mkdir(`${tmpDir}/.github`, { recursive: true });
    await Deno.writeTextFile(
      `${tmpDir}/.github/dependabot.yml`,
      DEPENDABOT_NPM_YAML,
    );
    const { runner, apiPaths } = dependabotAwareRunner({});
    const result = await auditRepoWorkflows(
      "owner/repo",
      makeLanguages(["Node"]),
      { runCommand: runner, localRepoPath: tmpDir },
    );
    assertEquals(result.ok, true);
    if (!result.ok) return;

    const match = result.value.present.find((m) =>
      m.spec.id === "npm-dependency-updates"
    );
    assertEquals(match?.foundIn, ".github/dependabot.yml");
    assertEquals(apiPaths.includes(DEPENDABOT_YML_API_PATH), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("workflow_auditor - no Dependabot config is fetched when no required spec needs one", async () => {
  const { runner, apiPaths } = dependabotAwareRunner({});
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Rust"]),
    { runCommand: runner },
  );
  assertEquals(result.ok, true);
  assertEquals(apiPaths.some((p) => p.includes("dependabot")), false);
});

Deno.test("workflow_auditor - the Dependabot config is fetched with the raw-content gh api call", async () => {
  const { runner, commands } = dependabotAwareRunner({
    [DEPENDABOT_YML_API_PATH]: ok(DEPENDABOT_NPM_YAML),
  });
  await auditRepoWorkflows("owner/repo", makeLanguages(["Node"]), {
    runCommand: runner,
  });
  assertEquals(
    commands.find((c) => c[2] === DEPENDABOT_YML_API_PATH),
    [
      "gh",
      "api",
      DEPENDABOT_YML_API_PATH,
      "-H",
      "Accept: application/vnd.github.raw+json",
    ],
  );
});

Deno.test("workflow_auditor - a non-404 Dependabot config failure names the path, repo and cause", async () => {
  const { runner } = dependabotAwareRunner({
    [DEPENDABOT_YML_API_PATH]: fail("API rate limit exceeded"),
  });
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node"]),
    { runCommand: runner },
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(
    result.error,
    "Failed to fetch .github/dependabot.yml for owner/repo: API rate limit exceeded",
  );
});

Deno.test("workflow_auditor - a Dependabot config fetch that throws an Error fails the audit with its message", async () => {
  const runner = (cmd: string[]): Promise<CommandOutput> => {
    const apiPath = cmd[cmd.indexOf("api") + 1] ?? "";
    if (apiPath === "repos/owner/repo") {
      return Promise.resolve(ok(JSON.stringify({ visibility: "private" })));
    }
    if (apiPath === WORKFLOWS_API_PATH) return Promise.resolve(ok("[]"));
    return Promise.reject(new Error("spawn exploded"));
  };
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node"]),
    { runCommand: runner },
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(
    result.error,
    "Failed to fetch Dependabot config for owner/repo: spawn exploded",
  );
});

Deno.test("workflow_auditor - a Dependabot config fetch that throws a non-Error fails the audit with its string form", async () => {
  const runner = (cmd: string[]): Promise<CommandOutput> => {
    const apiPath = cmd[cmd.indexOf("api") + 1] ?? "";
    if (apiPath === "repos/owner/repo") {
      return Promise.resolve(ok(JSON.stringify({ visibility: "private" })));
    }
    if (apiPath === WORKFLOWS_API_PATH) return Promise.resolve(ok("[]"));
    return Promise.reject("plain string failure");
  };
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node"]),
    { runCommand: runner },
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(
    result.error,
    "Failed to fetch Dependabot config for owner/repo: plain string failure",
  );
});

Deno.test("workflow_auditor - a dependabot.yaml is read when dependabot.yml is absent", async () => {
  const { runner } = dependabotAwareRunner({
    [DEPENDABOT_YAML_API_PATH]: ok(DEPENDABOT_NPM_YAML),
  });
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node"]),
    { runCommand: runner },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const match = result.value.present.find((m) =>
    m.spec.id === "npm-dependency-updates"
  );
  assertEquals(match?.foundIn, ".github/dependabot.yaml");
});

Deno.test("workflow_auditor - the Dependabot config satisfies only Dependabot specs, not other specs", async () => {
  // "gitleaks" in the config must not make the gitleaks spec present: only a
  // `dependabotConfig` spec is evaluated against the config.
  const { runner } = dependabotAwareRunner({
    [DEPENDABOT_YML_API_PATH]: ok(
      DEPENDABOT_NPM_YAML + "# gitleaks semgrep\n",
    ),
  });
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node"]),
    { runCommand: runner },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.present.some((m) => m.spec.id === "gitleaks"),
    false,
  );
  assertEquals(
    result.value.missing.some((s) => s.id === "gitleaks"),
    true,
  );
});

Deno.test("workflow_auditor - a github-actions-only dependabot.yml that says 'Dependabot' leaves npm-dependency-updates missing", async () => {
  const githubActionsOnly = `# Dependabot configuration
# https://docs.github.com/en/code-security/dependabot/dependabot-version-updates
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
`;
  const { runner } = dependabotAwareRunner({
    [DEPENDABOT_YML_API_PATH]: ok(githubActionsOnly),
  });
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node"]),
    { runCommand: runner },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.missing.some((s) => s.id === "npm-dependency-updates"),
    true,
  );
  assertEquals(
    result.value.present.some((m) => m.spec.id === "npm-dependency-updates"),
    false,
  );
});

for (const quoted of [`"npm"`, `'npm'`]) {
  Deno.test(`workflow_auditor - a dependabot.yml with package-ecosystem: ${quoted} makes npm-dependency-updates present`, async () => {
    const { runner } = dependabotAwareRunner({
      [DEPENDABOT_YML_API_PATH]: ok(
        `version: 2\nupdates:\n  - package-ecosystem: ${quoted}\n    directory: /\n`,
      ),
    });
    const result = await auditRepoWorkflows(
      "owner/repo",
      makeLanguages(["Node"]),
      { runCommand: runner },
    );
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(
      result.value.present.some((m) => m.spec.id === "npm-dependency-updates"),
      true,
    );
  });
}

Deno.test("workflow_auditor - a workflow file naming renovate still satisfies npm-dependency-updates, reported under .github/workflows/", async () => {
  const { runner } = dependabotAwareRunner({});
  const wrapped = (cmd: string[]): Promise<CommandOutput> => {
    const apiPath = cmd[cmd.indexOf("api") + 1] ?? "";
    if (apiPath === WORKFLOWS_API_PATH) {
      return Promise.resolve(workflowDirResponse(["deps.yml"]));
    }
    if (apiPath === `${WORKFLOWS_API_PATH}/deps.yml`) {
      return Promise.resolve(ok("name: deps\n# uses renovate\n"));
    }
    return runner(cmd);
  };
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node"]),
    { runCommand: wrapped },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const match = result.value.present.find((m) =>
    m.spec.id === "npm-dependency-updates"
  );
  assertEquals(match?.foundIn, ".github/workflows/deps.yml");
});

/** The rendered template of the workflow spec with `id`. */
function templateOf(id: string): string {
  const spec = WORKFLOW_SPECS.find((s) => s.id === id);
  if (spec === undefined) throw new Error(`no workflow spec ${id}`);
  return spec.template;
}

/**
 * Serve `workflows` (file name -> YAML) under .github/workflows/, and `extra`
 * (API path -> response), with every other path answered by
 * dependabotAwareRunner.
 */
function workflowFilesRunner(
  workflows: Record<string, string>,
  extra: Record<string, CommandOutput> = {},
): (cmd: string[]) => Promise<CommandOutput> {
  const { runner } = dependabotAwareRunner(extra);
  const prefix = `${WORKFLOWS_API_PATH}/`;
  return (cmd: string[]): Promise<CommandOutput> => {
    const apiPath = cmd[cmd.indexOf("api") + 1] ?? "";
    if (apiPath === WORKFLOWS_API_PATH) {
      return Promise.resolve(workflowDirResponse(Object.keys(workflows)));
    }
    if (apiPath.startsWith(prefix)) {
      const body = workflows[apiPath.slice(prefix.length)];
      if (body !== undefined) return Promise.resolve(ok(body));
    }
    return runner(cmd);
  };
}

/** Audit a Node repo and report where npm-dependency-updates landed. */
async function auditNpmUpdates(
  runCommand: (cmd: string[]) => Promise<CommandOutput>,
): Promise<
  { foundIn: string | undefined; missing: boolean; partial: boolean } | null
> {
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node"]),
    { runCommand },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return null;
  const id = "npm-dependency-updates";
  return {
    foundIn: result.value.present.find((m) => m.spec.id === id)?.foundIn,
    missing: result.value.missing.some((s) => s.id === id),
    partial: result.value.partial.some((p) => p.spec.id === id),
  };
}

Deno.test("workflow_auditor - the rendered gitleaks template alone leaves npm-dependency-updates missing (Issue #4903)", async () => {
  const template = templateOf("gitleaks");
  // Positive control: the fixture really carries the old false-positive text.
  assertEquals(/concurrency/i.test(template), true);
  assertEquals(/dependabot/i.test(template), true);

  const status = await auditNpmUpdates(
    workflowFilesRunner({ "gitleaks.yml": template }),
  );
  assertEquals(status?.foundIn, undefined);
  assertEquals(status?.missing, true);
  assertEquals(status?.partial, false);
});

Deno.test("workflow_auditor - a workflow carrying only a concurrency block leaves npm-dependency-updates missing (Issue #4903)", async () => {
  const concurrencyOnly = templateOf("eslint-quality");
  // Positive control: the fixture carries the `concurrency:` block.
  assertEquals(concurrencyOnly.includes("concurrency"), true);

  const status = await auditNpmUpdates(
    workflowFilesRunner({ "eslint.yml": concurrencyOnly }),
  );
  assertEquals(status?.foundIn, undefined);
  assertEquals(status?.missing, true);
  assertEquals(status?.partial, false);
});

Deno.test("workflow_auditor - a real npm Dependabot entry with the gitleaks workflow makes npm-dependency-updates present, foundIn the config (Issue #4903)", async () => {
  const status = await auditNpmUpdates(
    workflowFilesRunner(
      { "gitleaks.yml": templateOf("gitleaks") },
      { [DEPENDABOT_YML_API_PATH]: ok(DEPENDABOT_NPM_YAML) },
    ),
  );
  assertEquals(status?.foundIn, ".github/dependabot.yml");
  assertEquals(status?.missing, false);
});

Deno.test("workflow_auditor - a workflow running npm-check-updates makes npm-dependency-updates present, foundIn the workflow (Issue #4903)", async () => {
  const status = await auditNpmUpdates(
    workflowFilesRunner({
      "deps.yml": `name: deps
jobs:
  deps:
    runs-on: ubuntu-latest
    steps:
      - run: npx npm-check-updates -u
`,
    }),
  );
  assertEquals(status?.foundIn, ".github/workflows/deps.yml");
  assertEquals(status?.missing, false);
});

for (const invocation of ["npx ncu", "ncu -u", "ncu --upgrade"]) {
  Deno.test(`workflow_auditor - a workflow running "${invocation}" makes npm-dependency-updates present (Issue #4903)`, async () => {
    const status = await auditNpmUpdates(
      workflowFilesRunner({
        "deps.yml": `name: deps
jobs:
  deps:
    runs-on: ubuntu-latest
    steps:
      - run: ${invocation}
`,
      }),
    );
    assertEquals(status?.foundIn, ".github/workflows/deps.yml");
    assertEquals(status?.missing, false);
  });
}

Deno.test("workflow_auditor - a workflow that only names dependabot beside a concurrency block leaves npm-dependency-updates missing (Issue #4903)", async () => {
  const notes = `name: Notes
# managed by dependabot
on:
  pull_request:
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
`;
  const status = await auditNpmUpdates(
    workflowFilesRunner({ "notes.yml": notes }),
  );
  assertEquals(status?.foundIn, undefined);
  assertEquals(status?.missing, true);
  assertEquals(status?.partial, false);
});

Deno.test("workflow_auditor - a maven-only dependabot.yml makes java-dependency-updates present and leaves npm-dependency-updates missing", async () => {
  const mavenOnlyConfig = `version: 2
updates:
  - package-ecosystem: maven
    directory: /
`;
  const { runner } = dependabotAwareRunner({
    [DEPENDABOT_YML_API_PATH]: ok(mavenOnlyConfig),
  });
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node", "Java"]),
    { runCommand: runner },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const mavenMatch = result.value.present.find((m) =>
    m.spec.id === "java-dependency-updates"
  );
  assertEquals(mavenMatch?.foundIn, ".github/dependabot.yml");
  assertEquals(
    result.value.missing.some((s) => s.id === "java-dependency-updates"),
    false,
  );
  assertEquals(
    result.value.missing.some((s) => s.id === "npm-dependency-updates"),
    true,
  );
});

Deno.test("workflow_auditor - an npm-only dependabot.yml leaves java-dependency-updates missing", async () => {
  const npmOnlyConfig = `version: 2
updates:
  - package-ecosystem: npm
    directory: /
`;
  const { runner } = dependabotAwareRunner({
    [DEPENDABOT_YML_API_PATH]: ok(npmOnlyConfig),
  });
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(["Node", "Java"]),
    { runCommand: runner },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(
    result.value.present.some((m) => m.spec.id === "npm-dependency-updates"),
    true,
  );
  assertEquals(
    result.value.missing.some((s) => s.id === "java-dependency-updates"),
    true,
  );
});

Deno.test("workflow_auditor - a maven-only dependabot.yml leaves the Gradle spec missing", async () => {
  const mavenOnlyConfig = `version: 2
updates:
  - package-ecosystem: maven
    directory: /
`;
  const languages: RepoLanguages = {
    detected: [{ language: "Java", confidence: "api" }],
    primary: "Java",
    raw: { Java: 200 },
    rootFiles: ["build.gradle"],
  };
  const { runner } = dependabotAwareRunner({
    [DEPENDABOT_YML_API_PATH]: ok(mavenOnlyConfig),
  });
  const result = await auditRepoWorkflows("owner/repo", languages, {
    runCommand: runner,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(
    result.value.missing.some((s) => s.id === "java-gradle-dependency-updates"),
    true,
  );
  assertEquals(
    result.value.present.some((m) =>
      m.spec.id === "java-gradle-dependency-updates"
    ),
    false,
  );
});

Deno.test("workflow_auditor - a gradle entry in dependabot.yml makes java-gradle-dependency-updates present", async () => {
  const gradleConfig = `version: 2
updates:
  - package-ecosystem: gradle
    directory: /
`;
  const languages: RepoLanguages = {
    detected: [{ language: "Java", confidence: "api" }],
    primary: "Java",
    raw: { Java: 200 },
    rootFiles: ["build.gradle"],
  };
  const { runner } = dependabotAwareRunner({
    [DEPENDABOT_YML_API_PATH]: ok(gradleConfig),
  });
  const result = await auditRepoWorkflows("owner/repo", languages, {
    runCommand: runner,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const match = result.value.present.find((m) =>
    m.spec.id === "java-gradle-dependency-updates"
  );
  assertEquals(match?.foundIn, ".github/dependabot.yml");
  assertEquals(
    result.value.missing.some((s) => s.id === "java-gradle-dependency-updates"),
    false,
  );
});

for (const quoted of [`"maven"`, `'maven'`]) {
  Deno.test(
    `workflow_auditor - a dependabot.yml with package-ecosystem: ${quoted} makes java-dependency-updates present`,
    async () => {
      const { runner } = dependabotAwareRunner({
        [DEPENDABOT_YML_API_PATH]: ok(
          `version: 2\nupdates:\n  - package-ecosystem: ${quoted}\n    directory: /\n`,
        ),
      });
      const result = await auditRepoWorkflows(
        "owner/repo",
        makeLanguages(["Java"]),
        { runCommand: runner },
      );
      assertEquals(result.ok, true);
      if (!result.ok) return;
      assertEquals(
        result.value.present.some((m) =>
          m.spec.id === "java-dependency-updates"
        ),
        true,
      );
    },
  );
}

for (const quoted of [`"gradle"`, `'gradle'`]) {
  Deno.test(
    `workflow_auditor - a dependabot.yml with package-ecosystem: ${quoted} makes java-gradle-dependency-updates present`,
    async () => {
      const languages: RepoLanguages = {
        detected: [{ language: "Java", confidence: "api" }],
        primary: "Java",
        raw: { Java: 200 },
        rootFiles: ["build.gradle"],
      };
      const { runner } = dependabotAwareRunner({
        [DEPENDABOT_YML_API_PATH]: ok(
          `version: 2\nupdates:\n  - package-ecosystem: ${quoted}\n    directory: /\n`,
        ),
      });
      const result = await auditRepoWorkflows("owner/repo", languages, {
        runCommand: runner,
      });
      assertEquals(result.ok, true);
      if (!result.ok) return;
      assertEquals(
        result.value.present.some((m) =>
          m.spec.id === "java-gradle-dependency-updates"
        ),
        true,
      );
    },
  );
}
