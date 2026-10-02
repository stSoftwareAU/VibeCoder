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
 * - the baseline the command reads by default is the file the workflow names.
 *
 * Uses Australian English throughout (behaviour, artefact).
 */

import { assert, assertStringIncludes } from "@std/assert";
import { DEFAULT_BASELINE } from "../commands/security_tree_sweep.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const workflow = await Deno.readTextFile(
  `${ROOT}.github/workflows/security-tree-sweep.yml`,
);

/**
 * True only when the text writes the changed-files list NUL-delimited and
 * unquoted (`-c core.quotePath=false` AND `-z`), and no line writing that
 * file omits either safeguard (Issue #2776).
 */
function writesUnquotedChangedFiles(text: string): boolean {
  const lines = text.split("\n");
  const writesTarget = (line: string) =>
    line.includes('> "$RUNNER_TEMP/changed-files.txt"');
  const safe = (line: string) =>
    /-c\s+core\.quotePath=false/.test(line) &&
    /diff\s+--name-only/.test(line) &&
    /(^|[\s])-z([\s]|$)/.test(line) &&
    writesTarget(line);
  const hasSafeWrite = lines.some(safe);
  const hasUnsafeWrite = lines.some(
    (line) => writesTarget(line) && !safe(line),
  );
  return hasSafeWrite && !hasUnsafeWrite;
}

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

Deno.test("sweep workflow - a PR passes its own changed files; the schedule stays strict (Issue #2467)", () => {
  // The base SHA comes from the event payload via env (never interpolated
  // into the shell), and the diff is exactly base..HEAD.
  assertStringIncludes(
    workflow,
    "github.event.pull_request.base.sha",
  );
  assertStringIncludes(
    workflow,
    'git -c core.quotePath=false diff --name-only -z "$BASE_SHA" HEAD',
  );
  // Only a pull_request run writes the list; the strict mode is the
  // default when no list exists.
  assertStringIncludes(workflow, "if: github.event_name == 'pull_request'");
  assertStringIncludes(workflow, "--changed-files");
  assertStringIncludes(workflow, "changed_files_args=()");
});

Deno.test("sweep workflow - the changed-files list is NUL-delimited and unquoted (Issue #2776)", () => {
  assert(
    writesUnquotedChangedFiles(workflow),
    "the changed-files list must be written with -c core.quotePath=false and -z",
  );
  assert(
    !writesUnquotedChangedFiles(
      'git diff --name-only "$BASE_SHA" HEAD > "$RUNNER_TEMP/changed-files.txt"',
    ),
    "the old quoted, newline-delimited form must be rejected",
  );
  assert(
    !writesUnquotedChangedFiles(
      'git diff --name-only -z "$BASE_SHA" HEAD > "$RUNNER_TEMP/changed-files.txt"',
    ),
    "-z without core.quotePath=false must be rejected (defence in depth)",
  );
  assert(
    !writesUnquotedChangedFiles(
      'git -c core.quotePath=false diff --name-only "$BASE_SHA" HEAD > "$RUNNER_TEMP/changed-files.txt"',
    ),
    "core.quotePath=false without -z must be rejected (newline-in-path still quoted)",
  );
});

Deno.test("sweep workflow - the default baseline path is the file the workflow names and it exists", async () => {
  assertStringIncludes(workflow, DEFAULT_BASELINE);
  const stat = await Deno.stat(`${ROOT}${DEFAULT_BASELINE}`);
  assert(stat.isFile);
});
