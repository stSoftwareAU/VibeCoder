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
  return {
    detected: langs.map((l) => ({
      language: l,
      confidence: "marker" as const,
    })),
    primary: primary ?? langs[0] ?? "unknown",
    raw: {},
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
