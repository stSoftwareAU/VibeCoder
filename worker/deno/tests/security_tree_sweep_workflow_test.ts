/**
 * The scheduled sweep workflow (Issue #4409) must be repository-local and
 * fail-loud, and must ship in the public export.
 *
 * - the slug comes from `github.repository`; no private repository name is
 *   hard-coded, so the same file runs as the public repository after the
 *   cut-over;
 * - CodeQL keeps its SARIF local (`upload: never`) so it cannot collide with
 *   the repository's default-setup CodeQL;
 * - the sweep is called with the pre-produced semgrep JSON and CodeQL SARIF,
 *   the report reaches the job summary, and the sweep's exit status is the
 *   job's;
 * - the baseline the command reads by default is the file the workflow and
 *   the export manifest name.
 *
 * Uses Australian English throughout (behaviour, artefact).
 */

import { assert, assertStringIncludes } from "@std/assert";
import { DEFAULT_BASELINE } from "../commands/security_tree_sweep.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const workflow = await Deno.readTextFile(
  `${ROOT}.github/workflows/security-tree-sweep.yml`,
);
const manifest = await Deno.readTextFile(`${ROOT}export/public-manifest.txt`);

Deno.test("sweep workflow - repository-local: slug from github.repository, no private repository name (Issue #4409)", () => {
  assertStringIncludes(workflow, '--slug "${GITHUB_REPOSITORY}"');
  assert(
    !/stSoftwareAU\/Vibe/.test(workflow),
    "the workflow must not name a repository",
  );
});

Deno.test("sweep workflow - CodeQL SARIF stays local and both scanner outputs feed the sweep (Issue #4409)", () => {
  assertStringIncludes(workflow, "upload: never");
  assertStringIncludes(workflow, "--codeql-sarif");
  assertStringIncludes(workflow, "--semgrep-json");
  assertStringIncludes(workflow, "semgrep scan --config p/default --json");
  // The same digest-pinned image semgrep.yml runs.
  assertStringIncludes(
    workflow,
    "semgrep/semgrep:1.173.0@sha256:67319956da3dcb58baf5b322899c15458e3963e7018a86aeeb5cd224e69cb77a",
  );
});

Deno.test("sweep workflow - fail loud: the sweep's exit status is the job's, and the report reaches the summary (Issue #4409)", () => {
  assertStringIncludes(workflow, 'exit "$status"');
  assertStringIncludes(workflow, '>> "$GITHUB_STEP_SUMMARY"');
  assertStringIncludes(workflow, "::error::CodeQL produced no SARIF");
  assertStringIncludes(workflow, "schedule:");
  assertStringIncludes(workflow, "workflow_dispatch:");
});

Deno.test("sweep workflow - the default baseline path is exported alongside the workflow (Issue #4409)", () => {
  assertStringIncludes(workflow, DEFAULT_BASELINE);
  const lines = manifest.split("\n").map((l) => l.trim());
  assert(
    lines.includes(DEFAULT_BASELINE),
    `${DEFAULT_BASELINE} not in manifest`,
  );
  assert(lines.includes(".github/workflows/security-tree-sweep.yml"));
});
