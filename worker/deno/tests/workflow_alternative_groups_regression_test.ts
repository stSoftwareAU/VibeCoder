/**
 * Regression tests for workflow alternative-group detection (Issue #1579).
 *
 * These fixtures reproduce the four false-positive partial-match cases
 * observed against NEAT-AI-scorer once the per-tool entries in
 * workflow_definitions.ts adopted the alternative-group structure
 * introduced in #1578. Each scenario exercises a workflow that uses one
 * of several valid implementations of the same capability and asserts
 * that the auditor classifies the spec as PRESENT (not partial).
 */

import { assertEquals } from "@std/assert";
import {
  auditRepoWorkflows,
  type CommandOutput,
  type WorkflowAuditOptions,
} from "../lib/workflow_auditor.ts";
import type { RepoLanguages } from "../lib/language_detector.ts";

// ---------------------------------------------------------------------------
// Helpers (kept minimal — see workflow_auditor_test.ts for the full set)
// ---------------------------------------------------------------------------

function ok(stdout: string): CommandOutput {
  return { success: true, stdout, stderr: "" };
}

function workflowDirResponse(filenames: string[]): CommandOutput {
  const items = filenames.map((n) => ({
    name: n,
    type: "file",
    download_url:
      `https://raw.githubusercontent.com/owner/repo/main/.github/workflows/${n}`,
  }));
  return ok(JSON.stringify(items));
}

function mockRunner(
  responses: Record<string, CommandOutput>,
): (cmd: string[]) => Promise<CommandOutput> {
  return (cmd: string[]): Promise<CommandOutput> => {
    const apiIdx = cmd.indexOf("api");
    const apiPath = apiIdx >= 0 && apiIdx + 1 < cmd.length
      ? cmd[apiIdx + 1]!
      : "";
    if (apiPath && apiPath in responses) {
      return Promise.resolve(responses[apiPath]!);
    }
    const joined = cmd.join(" ");
    for (const [key, value] of Object.entries(responses)) {
      if (joined.includes(key)) return Promise.resolve(value);
    }
    return Promise.resolve({ success: true, stdout: "[]", stderr: "" });
  };
}

function makeLanguages(langs: string[]): RepoLanguages {
  return {
    detected: langs.map((l) => ({
      language: l,
      confidence: "marker" as const,
    })),
    primary: langs[0] ?? "unknown",
    raw: {},
  };
}

async function assertPresent(
  filename: string,
  yaml: string,
  languages: string[],
  specId: string,
): Promise<void> {
  const opts: WorkflowAuditOptions = {
    runCommand: mockRunner({
      [`repos/owner/repo/contents/.github/workflows/${filename}`]: ok(yaml),
      "repos/owner/repo/contents/.github/workflows": workflowDirResponse([
        filename,
      ]),
    }),
  };
  const result = await auditRepoWorkflows(
    "owner/repo",
    makeLanguages(languages),
    opts,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const presentIds = result.value.present.map((m) => m.spec.id);
  assertEquals(
    presentIds.includes(specId),
    true,
    `${specId} should be PRESENT for fixture ${filename}, got partial=${
      JSON.stringify(result.value.partial.map((p) => p.spec.id))
    } missing=${JSON.stringify(result.value.missing.map((s) => s.id))}`,
  );
  assertEquals(
    result.value.partial.find((p) => p.spec.id === specId),
    undefined,
    `${specId} should not be partial`,
  );
}

// ---------------------------------------------------------------------------
// 1. security.yml containing only `cargo audit` → cargo-audit must be PRESENT
// ---------------------------------------------------------------------------

Deno.test(
  "regression #1579 - cargo-audit present when security.yml only runs `cargo audit`",
  async () => {
    const securityYaml = `name: Security
on:
  pull_request:
  schedule:
    - cron: "0 6 * * 1"
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo install cargo-audit
      - run: cargo audit
`;
    await assertPresent("security.yml", securityYaml, ["Rust"], "cargo-audit");
  },
);

// ---------------------------------------------------------------------------
// 2. gitleaks.yml running gitleaks via pinned binary (no action) → PRESENT
// ---------------------------------------------------------------------------

Deno.test(
  "regression #1579 - gitleaks present when run via pinned binary, no action reference",
  async () => {
    const gitleaksYaml = `name: Gitleaks
on:
  pull_request:
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Install gitleaks
        run: |
          curl -sSL -o gitleaks.tar.gz https://github.com/gitleaks/gitleaks/releases/download/v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz
          tar -xzf gitleaks.tar.gz
          sudo mv gitleaks /usr/local/bin/gitleaks
      - name: Run gitleaks
        run: gitleaks detect --source . --redact
`;
    await assertPresent("gitleaks.yml", gitleaksYaml, [], "gitleaks");
  },
);

// ---------------------------------------------------------------------------
// 3. semgrep.yml matching the suggested template (uses `semgrep ci` only)
// ---------------------------------------------------------------------------

Deno.test(
  "regression #1579 - semgrep present when workflow only invokes `semgrep ci`",
  async () => {
    const semgrepYaml = `name: Semgrep
on:
  pull_request:
    branches: ["*"]
permissions:
  contents: read
jobs:
  semgrep:
    runs-on: ubuntu-latest
    container:
      image: semgrep/semgrep
    steps:
      - uses: actions/checkout@v4
      - run: semgrep ci --config p/default
`;
    await assertPresent("semgrep.yml", semgrepYaml, [], "semgrep");
  },
);

// ---------------------------------------------------------------------------
// 4. ci.yml calling `shellcheck` directly → PRESENT
// ---------------------------------------------------------------------------

Deno.test(
  "regression #1579 - shellcheck present when ci.yml invokes the CLI directly",
  async () => {
    const ciYaml = `name: CI
on:
  pull_request:
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Lint shell scripts
        run: |
          sudo apt-get update && sudo apt-get install -y shellcheck
          shellcheck **/*.sh
`;
    await assertPresent("ci.yml", ciYaml, ["Bash"], "shellcheck");
  },
);
