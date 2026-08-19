/**
 * Regression tests for Issue #1838.
 *
 * Reproduces the private-repo-16 scenario: workflow-sync runs against a
 * repo where `localRepoPath` is provided but the local clone does not
 * exist on disk. Before the fix, `fetchWorkflowFiles` correctly fell
 * through to `gh api` for the listing, but `fetchWorkflowContent` did
 * NOT — every per-file content read returned `{ ok: false, ... }` and
 * the audit silently swallowed the failure (line 332). The map of
 * file contents ended up empty, so every required workflow was
 * misclassified as missing and a flood of duplicate "Add … workflow"
 * issues was raised against repos whose workflows were in fact
 * present (just under a different filename or job name).
 *
 * The fix mirrors the listing semantics in the content fetcher:
 * try the local path first, fall through to the API when the local
 * read fails for any reason.
 */

import { assertEquals } from "@std/assert";
import {
  auditRepoWorkflows,
  type CommandOutput,
  type WorkflowAuditOptions,
} from "../lib/workflow_auditor.ts";
import type { RepoLanguages } from "../lib/language_detector.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A combined `ci.yml` carrying cargo fmt / clippy + shellcheck steps,
 * mirroring the private-repo-16 layout. */
const ciYaml = `name: CI
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
  scripts-and-spelling:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: shellcheck $(git ls-files '*.sh')
`;

const gitleaksYaml = `name: Gitleaks
on:
  pull_request:
    branches: ["*"]
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: gitleaks/gitleaks-action@v2
`;

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

/**
 * Build a runner that fakes the API responses private-repo-16 would
 * return: a non-empty workflow listing plus content for each named
 * file. Visibility lookups answer "private" so the audit doesn't
 * include public-only specs.
 */
function buildApiRunner(files: Record<string, string>): {
  runner: (cmd: string[]) => Promise<CommandOutput>;
  contentApiCalls: string[];
} {
  const contentApiCalls: string[] = [];
  const runner = (cmd: string[]): Promise<CommandOutput> => {
    const apiIdx = cmd.indexOf("api");
    const apiPath = apiIdx >= 0 && apiIdx + 1 < cmd.length
      ? cmd[apiIdx + 1] ?? ""
      : "";

    // Listing endpoint
    if (/\/contents\/\.github\/workflows$/.test(apiPath)) {
      const entries = Object.keys(files).map((name) => ({
        name,
        type: "file",
      }));
      return Promise.resolve({
        success: true,
        stdout: JSON.stringify(entries),
        stderr: "",
      });
    }

    // Per-file content endpoint
    const m = apiPath.match(/\/contents\/\.github\/workflows\/([^/]+)$/);
    if (m) {
      const filename = m[1]!;
      contentApiCalls.push(filename);
      const content = files[filename];
      if (content !== undefined) {
        return Promise.resolve({ success: true, stdout: content, stderr: "" });
      }
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "Not Found (404)",
      });
    }

    // Visibility lookup
    if (/^repos\/[^/]+\/[^/]+$/.test(apiPath)) {
      return Promise.resolve({
        success: true,
        stdout: JSON.stringify({ visibility: "private" }),
        stderr: "",
      });
    }

    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  return { runner, contentApiCalls };
}

// ---------------------------------------------------------------------------
// Regression — Issue #1838
// ---------------------------------------------------------------------------

Deno.test(
  "workflow_auditor - localRepoPath missing on disk: content fetch falls back to API",
  async () => {
    // Point at a path that does NOT exist — mirrors the worker calling
    // syncWorkflowsForRepo with workDir set but the repo not yet cloned.
    const nonexistentPath = await Deno.makeTempDir({
      prefix: "workflow_auditor_missing_",
    });
    await Deno.remove(nonexistentPath); // ensure it does not exist

    const { runner, contentApiCalls } = buildApiRunner({
      "ci.yml": ciYaml,
      "gitleaks.yml": gitleaksYaml,
    });

    const opts: WorkflowAuditOptions = {
      runCommand: runner,
      localRepoPath: nonexistentPath,
    };

    const languages = makeLanguages(["Rust", "Bash"]);
    const result = await auditRepoWorkflows("owner/repo", languages, opts);

    assertEquals(result.ok, true);
    if (!result.ok) return;

    // Both files must have been fetched via the API since local read failed.
    assertEquals(
      contentApiCalls.sort(),
      ["ci.yml", "gitleaks.yml"],
      `Expected API content fallback for both files, got: ${
        contentApiCalls.join(", ")
      }`,
    );

    // The combined ci.yml satisfies cargo-quality (cargo fmt + cargo clippy)
    // and shellcheck. gitleaks.yml satisfies gitleaks.
    const presentIds = result.value.present.map((m) => m.spec.id);
    const missingIds = result.value.missing.map((s) => s.id);

    for (const id of ["cargo-quality", "shellcheck", "gitleaks"]) {
      assertEquals(
        presentIds.includes(id),
        true,
        `Expected ${id} to be detected as present (from ci.yml/gitleaks.yml). ` +
          `present=${presentIds.join(",")} missing=${missingIds.join(",")}`,
      );
    }
  },
);

Deno.test(
  "workflow_auditor - private-repo-16 scenario: ci.yml satisfies cargo-quality and shellcheck under different filename",
  async () => {
    // Repo has a single ci.yml that runs both cargo fmt/clippy AND
    // shellcheck. The auditor must detect both capabilities regardless
    // of the filename (i.e. NOT raise "Add Cargo Format and Clippy
    // workflow" or "Add ShellCheck Lint workflow" issues).
    const tmpDir = await Deno.makeTempDir({
      prefix: "workflow_auditor_neat_ai_core_",
    });
    await Deno.mkdir(`${tmpDir}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(`${tmpDir}/.github/workflows/ci.yml`, ciYaml);

    try {
      const { runner } = buildApiRunner({});
      const opts: WorkflowAuditOptions = {
        runCommand: runner,
        localRepoPath: tmpDir,
      };

      const languages = makeLanguages(["Rust", "Bash"]);
      const result = await auditRepoWorkflows("owner/repo", languages, opts);

      assertEquals(result.ok, true);
      if (!result.ok) return;

      const presentIds = result.value.present.map((m) => m.spec.id);
      const missingIds = result.value.missing.map((s) => s.id);

      assertEquals(
        presentIds.includes("cargo-quality"),
        true,
        `cargo-quality should be detected in ci.yml. ` +
          `present=${presentIds.join(",")} missing=${missingIds.join(",")}`,
      );
      assertEquals(
        presentIds.includes("shellcheck"),
        true,
        `shellcheck should be detected in ci.yml. ` +
          `present=${presentIds.join(",")} missing=${missingIds.join(",")}`,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);
