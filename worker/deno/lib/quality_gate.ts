/**
 * Quality gate orchestration (Issue #917).
 *
 * Orchestrates running quality checks (deno test/lint/check, mermaid,
 * markdownlint, docs prompt-version) in parallel or sequential mode. This
 * replaces the orchestration logic from quality.sh with a Deno TypeScript
 * implementation. Bash linting is delegated to each target repo's own CI
 * (Issue #3129), so the worker no longer runs shellcheck here.
 *
 * Migrated from quality.sh as part of the incremental Deno migration (#896).
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { Result } from "../types.ts";
import {
  type CheckResult,
  type CheckStatus,
  detectTool,
  formatSummary,
  type QualityOptions,
  recordCheck,
  type SummaryResult,
} from "./quality_helpers.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { scanDirectoriesForHardcodedBranches } from "./hardcoded_branch_check.ts";
import { scanDirectoriesForDirectNeedsHuman } from "./needs_human_direct_label_check.ts";
import { scanDirectoriesForGhSpawn } from "./gh_spawn_chokepoint_check.ts";
import { scanDirectoriesForHomeWorkDir } from "./home_workdir_check.ts";
import { scanDirectoriesForGitRefArgv } from "./git_ref_argv_check.ts";
import {
  cachedPassAt,
  computeQualityInputDigest,
  invalidate,
  recordPass,
} from "./quality_gate_cache.ts";
import { scanWorkflowsForHygiene } from "./workflow_hygiene_check.ts";
import { runPagesLiquidCheck } from "./pages_liquid_check.ts";
import { runMermaidCheck } from "./mermaid_check.ts";
import { checkBuiltMermaidOutput } from "./mermaid_built_output_check.ts";
import { runMarkdownlintCheck } from "./markdownlint_check.ts";
import { runDocsPromptVersionCheck } from "./docs_prompt_version_check.ts";
import { runSemgrepCheck } from "./semgrep_check.ts";
import { posixSingleQuote } from "./shell_quote.ts";

/** Result of a single check execution. */
export interface CheckExecutionResult {
  name: string;
  status: CheckStatus;
  output: string;
  /** Wall time this check took, in milliseconds (Issue #86). */
  durationMs?: number;
}

/**
 * Run a check thunk and stamp its wall duration onto the result, so the gate
 * summary can show where the ~6-minute in-container cost actually goes
 * (Issue #86). A thrown check is left for the caller's own handling.
 */
async function timed(
  check: () => Promise<CheckExecutionResult>,
): Promise<CheckExecutionResult> {
  const start = Date.now();
  const result = await check();
  return { ...result, durationMs: Date.now() - start };
}

/**
 * Called as each check settles so a caller can show progress while the gate
 * is still running (Issue #399).
 */
export type QualityProgressReporter = (line: string) => void;

/** Status glyphs for the streamed progress line. */
const PROGRESS_GLYPHS: Record<CheckStatus, string> = {
  PASSED: "✓",
  FAILED: "✗",
  SKIPPED: "-",
};

/**
 * Format the one-line progress record for a settled check (Issue #399).
 *
 * The gate used to print nothing at all until every check had finished, so an
 * agent driving it could not tell a slow run from a hung one — which is why
 * the `sleep`/`pgrep` poll loops existed. One line per settled check makes a
 * live run observable without waiting for the summary table.
 */
export function formatCheckProgress(result: CheckExecutionResult): string {
  const glyph = PROGRESS_GLYPHS[result.status] ?? "?";
  const duration = result.durationMs === undefined
    ? ""
    : ` (${(result.durationMs / 1000).toFixed(1)}s)`;
  return `  ${glyph} ${result.name}: ${result.status}${duration}`;
}

/** Report a settled check, swallowing nothing — a throwing reporter fails loud. */
function report(
  onProgress: QualityProgressReporter | undefined,
  result: CheckExecutionResult,
): void {
  onProgress?.(formatCheckProgress(result));
}

/** Result of the full quality gate run. */
export interface QualityGateResult {
  checks: CheckResult[];
  summary: SummaryResult;
  passed: boolean;
  /** Combined output from all checks for display. */
  output: string;
}

/** Configuration for running the quality gate. */
export interface QualityGateConfig {
  /** Root directory of the project (defaults to cwd). */
  scriptDir: string;
  /** Deno worker directory. When omitted, Deno-specific checks are skipped. */
  denoDir?: string;
  /** Quality options (strict, sequential, validatePrompts). */
  options: QualityOptions;
  /**
   * Directory for the content-addressed check cache (Issue #86). Omitted, the
   * two expensive dimensions (deno test, deno check) run every time.
   */
  cacheDir?: string;
  /**
   * Called with one line per check as it settles (Issue #399), so a caller
   * can stream progress instead of printing nothing for minutes. Omitted,
   * the gate is silent until it finishes, exactly as before.
   */
  onProgress?: QualityProgressReporter;
}

/**
 * Run a subprocess command and capture output.
 *
 * Returns the exit code and combined stdout/stderr.
 */
async function runCommand(
  cmd: string[],
  options?: { cwd?: string },
): Promise<{ exitCode: number; output: string }> {
  const command = new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    cwd: options?.cwd,
    stdout: "piped",
    stderr: "piped",
  });

  const result = await command.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  const output = stdout + (stderr ? "\n" + stderr : "");

  return { exitCode: result.code, output: output.trim() };
}

/**
 * Run the prompt immutability check.
 *
 * Uses deno run to invoke the prompt-manager command with
 * validate-immutability operation.
 */
async function runPromptImmutabilityCheck(
  config: QualityGateConfig,
  denoCmd: string,
): Promise<CheckExecutionResult> {
  const name = "prompt immutability";

  // Detect base branch from the remote's HEAD rather than a hardcoded list
  let baseBranch = "";
  try {
    const currentResult = await runCommand(
      ["git", "-C", config.scriptDir, "rev-parse", "--abbrev-ref", "HEAD"],
    );
    const currentBranch = currentResult.output.trim();

    // Resolve the remote's default branch via symbolic-ref
    const remoteHeadResult = await runCommand(
      [
        "git",
        "-C",
        config.scriptDir,
        "rev-parse",
        "--abbrev-ref",
        "refs/remotes/origin/HEAD",
      ],
    );
    if (remoteHeadResult.exitCode === 0) {
      const remoteBranch = remoteHeadResult.output.trim().replace(
        /^origin\//,
        "",
      );
      if (remoteBranch && remoteBranch !== currentBranch) {
        baseBranch = remoteBranch;
      }
    }
  } catch (err) {
    console.warn(
      `[quality-gate] Could not detect git branch: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Check if we're inside a git work tree
  const gitCheckResult = await runCommand(
    ["git", "-C", config.scriptDir, "rev-parse", "--is-inside-work-tree"],
  );
  if (gitCheckResult.exitCode !== 0) {
    return { name, status: "SKIPPED", output: "Not a git repository" };
  }

  const args = [
    "run",
    "--allow-env",
    "--allow-read",
    "--allow-run",
    `${config.denoDir}/mod.ts`,
    "prompt-manager",
    "--operation",
    "validate-immutability",
    "--repo-dir",
    config.scriptDir,
    "--prompts-dir",
    `${config.scriptDir}/prompts`,
  ];

  if (baseBranch) {
    args.push("--base-branch", baseBranch);
  }

  const result = await runCommand([denoCmd, ...args]);
  if (result.exitCode === 0) {
    return { name, status: "PASSED", output: "prompt immutability: PASSED" };
  }
  return {
    name,
    status: "FAILED",
    output:
      "prompt immutability: FAILED\nExisting prompt versions are immutable. Create a new version (e.g., v2.md) instead.",
  };
}

/**
 * Run the prompt placeholder validation check.
 */
async function runPromptPlaceholderCheck(
  config: QualityGateConfig,
  denoCmd: string,
): Promise<CheckExecutionResult> {
  const name = "prompt placeholders";
  const args = [
    "run",
    "--allow-env",
    "--allow-read",
    `${config.denoDir}/mod.ts`,
    "prompt-manager",
    "--operation",
    "validate-all",
    "--prompts-dir",
    `${config.scriptDir}/prompts`,
  ];

  const result = await runCommand([denoCmd, ...args]);
  if (result.exitCode === 0) {
    return { name, status: "PASSED", output: "prompt placeholders: PASSED" };
  }
  return {
    name,
    status: "FAILED",
    output:
      "prompt placeholders: FAILED\nSome templates are missing required placeholders.",
  };
}

/**
 * Run the benchmark audit check (Issue #970: rewritten in pure TypeScript,
 * replacing the deleted worker/shared/benchmark_audit.sh).
 *
 * Scans Deno _test.ts files for test names containing benchmark patterns
 * (e.g., "benchmark", "bench_"). Returns non-zero if violations are found.
 */
async function runBenchmarkAudit(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const name = "benchmark audit";
  const denoTestDir = `${config.scriptDir}/worker/deno/tests`;

  try {
    await Deno.stat(denoTestDir);
  } catch {
    return { name, status: "SKIPPED", output: "deno test directory not found" };
  }

  const benchmarkPattern = /Deno\.test\s*\(\s*"[^"]*bench(?:mark|_)[^"]*"/i;
  const violations: string[] = [];

  for await (const entry of Deno.readDir(denoTestDir)) {
    if (!entry.isFile || !entry.name.endsWith("_test.ts")) continue;
    const filePath = `${denoTestDir}/${entry.name}`;
    const content = await Deno.readTextFile(filePath);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line !== undefined && benchmarkPattern.test(line)) {
        violations.push(`VIOLATION: ${filePath}:${i + 1}: ${line.trim()}`);
      }
    }
  }

  if (violations.length === 0) {
    return { name, status: "PASSED", output: "benchmark audit: PASSED" };
  }

  const output = [
    ...violations,
    "",
    "Benchmarks must NOT be disguised as unit tests (Issue #583).",
    "Unit tests verify correctness; benchmarks measure performance.",
    "Move benchmark logic to dedicated benchmark files instead.",
  ].join("\n");

  return {
    name,
    status: "FAILED",
    output: `benchmark audit: FAILED\n${output}`,
  };
}

/**
 * Run the hardcoded branch name check (Issue #1182).
 *
 * Scans Deno lib/ and commands/ source files for hardcoded default branch
 * names that assume a specific branch convention. Legitimate uses must be
 * annotated with `// allow-hardcoded-branch`.
 */
async function runHardcodedBranchCheck(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const name = "hardcoded branch names";
  const libDir = `${config.scriptDir}/worker/deno/lib`;
  const commandsDir = `${config.scriptDir}/worker/deno/commands`;

  let hasDirs = false;
  for (const dir of [libDir, commandsDir]) {
    try {
      const stat = await Deno.stat(dir);
      if (stat.isDirectory) hasDirs = true;
    } catch { /* directory doesn't exist */ }
  }

  if (!hasDirs) {
    return {
      name,
      status: "SKIPPED",
      output: "deno source directories not found",
    };
  }

  const result = await scanDirectoriesForHardcodedBranches([
    libDir,
    commandsDir,
  ]);

  if (result.violations.length === 0) {
    return {
      name,
      status: "PASSED",
      output:
        `hardcoded branch names: PASSED (${result.filesScanned} files scanned)`,
    };
  }

  const violationLines = result.violations.map(
    (v) => `VIOLATION: ${v.file}:${v.line}: ${v.content}`,
  );
  const output = [
    ...violationLines,
    "",
    "Hardcoded default branch names detected (Issue #1182).",
    "Default branches vary per repo — use dynamic detection instead.",
    "If this is a legitimate use, add '// allow-hardcoded-branch' to the line.",
  ].join("\n");

  return {
    name,
    status: "FAILED",
    output: `hardcoded branch names: FAILED\n${output}`,
  };
}

/**
 * Run the `needs-human` helper chokepoint check (Issue #2689).
 *
 * Scans Deno lib/ and commands/ source files for direct `needs-human`
 * label applications that bypass the `escalateToHuman` helper. Such a
 * call would re-introduce the silent-escalation regression class
 * (Issue #2202). The only permitted direct application is the helper
 * itself (see {@link NEEDS_HUMAN_ALLOWLIST}).
 */
async function runNeedsHumanHelperCheck(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const name = "needs-human chokepoint";
  const relDirs = ["worker/deno/lib", "worker/deno/commands"];

  let hasDirs = false;
  for (const relDir of relDirs) {
    try {
      const stat = await Deno.stat(`${config.scriptDir}/${relDir}`);
      if (stat.isDirectory) hasDirs = true;
    } catch { /* directory doesn't exist */ }
  }

  if (!hasDirs) {
    return {
      name,
      status: "SKIPPED",
      output: "deno source directories not found",
    };
  }

  const result = await scanDirectoriesForDirectNeedsHuman(
    config.scriptDir,
    relDirs,
  );

  if (result.violations.length === 0) {
    return {
      name,
      status: "PASSED",
      output:
        `needs-human chokepoint: PASSED (${result.filesScanned} files scanned)`,
    };
  }

  const violationLines = result.violations.map(
    (v) =>
      `VIOLATION: ${v.file}:${v.line}: ${v.text}  (matched /${v.pattern}/)`,
  );
  const output = [
    ...violationLines,
    "",
    "Direct `needs-human` label applications detected outside the",
    "`escalateToHuman` helper (Issue #2202). Route the call through",
    "`worker/deno/lib/needs_human_escalation.ts` so an explanation",
    "comment is always posted in the same run.",
  ].join("\n");

  return {
    name,
    status: "FAILED",
    output: `needs-human chokepoint: FAILED\n${output}`,
  };
}

/**
 * Run the `gh` spawn chokepoint check (Issue #3703).
 *
 * Scans Deno lib/ and commands/ source files for a direct
 * `new Deno.Command("gh", …)`. Such a spawn bypasses both the per-run
 * write-repo allowlist and the audit journal, which is exactly how ~20
 * modules had drifted away from the documented chokepoint. The only
 * permitted spawn is the chokepoint itself (`worker/deno/lib/gh_spawn.ts`).
 */
async function runGhSpawnChokepointCheck(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const name = "gh spawn chokepoint";
  const relDirs = ["worker/deno/lib", "worker/deno/commands"];

  let hasDirs = false;
  for (const relDir of relDirs) {
    try {
      const stat = await Deno.stat(`${config.scriptDir}/${relDir}`);
      if (stat.isDirectory) hasDirs = true;
    } catch { /* directory doesn't exist */ }
  }

  if (!hasDirs) {
    return {
      name,
      status: "SKIPPED",
      output: "deno source directories not found",
    };
  }

  const result = await scanDirectoriesForGhSpawn(config.scriptDir, relDirs);

  if (result.violations.length === 0) {
    return {
      name,
      status: "PASSED",
      output:
        `gh spawn chokepoint: PASSED (${result.filesScanned} files scanned)`,
    };
  }

  const output = [
    ...result.violations.map(
      (v) => `VIOLATION: ${v.file}:${v.line}: ${v.text}`,
    ),
    "",
    "Direct `gh` subprocess spawns detected outside the shared chokepoint",
    "(Issue #3703). Such a spawn skips the per-run write-repo allowlist and",
    "the audit journal. Route the call through `spawnGh`/`runGhOrThrow` in",
    "`worker/deno/lib/gh_spawn.ts` instead.",
  ].join("\n");

  return {
    name,
    status: "FAILED",
    output: `gh spawn chokepoint: FAILED\n${output}`,
  };
}

/**
 * Run the host work-dir guard check (Issue #135, parent #118).
 *
 * Scans the Deno source tree (tests excluded — fixtures legitimately build
 * these paths) for constructions of a work-dir path
 * (`…/auto-issue-work`) from `HOME`/`USERPROFILE` or any other base outside
 * the explicit, commented allowlist in `home_workdir_check.ts`. A new
 * HOME-derived default would silently recreate a stray `~/auto-issue-work`
 * on the host — the regression class Issues #131/#132/#133 removed.
 */
async function runHomeWorkDirGuardCheck(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const name = "host work-dir guard";
  const relDirs = ["worker/deno"];

  let hasDirs = false;
  for (const relDir of relDirs) {
    try {
      const stat = await Deno.stat(`${config.scriptDir}/${relDir}`);
      if (stat.isDirectory) hasDirs = true;
    } catch { /* directory doesn't exist */ }
  }

  if (!hasDirs) {
    return {
      name,
      status: "SKIPPED",
      output: "deno source directories not found",
    };
  }

  const result = await scanDirectoriesForHomeWorkDir(
    config.scriptDir,
    relDirs,
  );

  if (result.violations.length === 0 && result.staleAllowlist.length === 0) {
    return {
      name,
      status: "PASSED",
      output:
        `host work-dir guard: PASSED (${result.filesScanned} files scanned)`,
    };
  }

  const output = [
    ...result.violations.map(
      (v) => `VIOLATION: ${v.file}:${v.line}: ${v.text}`,
    ),
    ...result.staleAllowlist.map((s) => `STALE ALLOWLIST: ${s}`),
    "",
    "A work-dir path (…/auto-issue-work) is being built from HOME/USERPROFILE",
    "(or another base) outside the commented allowlist (Issue #135, parent",
    "#118). Such a default silently creates a stray work dir under the host's",
    "home. Read WORK_DIR (exported by the run driver, Issue #4370) or",
    "take an explicit work dir; if the site is genuinely legitimate, add it to",
    "HOME_WORKDIR_ALLOWLIST in worker/deno/lib/home_workdir_check.ts with a",
    "comment saying why.",
  ].join("\n");

  return {
    name,
    status: "FAILED",
    output: `host work-dir guard: FAILED\n${output}`,
  };
}

async function runGitRefArgvCheck(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const name = "git ref chokepoint";
  const relDirs = ["worker/deno/lib", "worker/deno/commands"];

  let hasDirs = false;
  for (const relDir of relDirs) {
    try {
      const stat = await Deno.stat(`${config.scriptDir}/${relDir}`);
      if (stat.isDirectory) hasDirs = true;
    } catch { /* directory doesn't exist */ }
  }
  if (!hasDirs) {
    return {
      name,
      status: "SKIPPED",
      output: "deno source directories not found",
    };
  }

  const result = await scanDirectoriesForGitRefArgv(config.scriptDir, relDirs);
  if (result.violations.length === 0) {
    return {
      name,
      status: "PASSED",
      output:
        `git ref chokepoint: PASSED (${result.filesScanned} files scanned)`,
    };
  }
  const output = [
    ...result.violations.map((v) =>
      `VIOLATION: ${v.file}:${v.line}: ${v.text}`
    ),
    "",
    "A PR head branch name reached a git ref argument inline (Issue #12,",
    "CWE-88). A dash-leading branch (e.g. `--upload-pack=…`) would be parsed",
    "as an option, not a ref. Route it through the builders in",
    "`worker/deno/lib/git_ref_args.ts` (buildFetchArgs / buildPullArgs /",
    "buildCheckoutArgs / buildCheckoutNewBranchArgs), which validate the ref",
    "and insert `--end-of-options`.",
  ].join("\n");
  return {
    name,
    status: "FAILED",
    output: `git ref chokepoint: FAILED\n${output}`,
  };
}

/**
 * Run the workflow-hygiene check (Issue #3716).
 *
 * Two static invariants over `.github/workflows`: every multi-line `run:`
 * block opens with `set -euo pipefail` (so a failing command mid-block
 * cannot be silently ignored), and a pinned action SHA carries the same
 * version comment everywhere it appears (so the comment stays a usable
 * review signal).
 */
async function runWorkflowHygieneCheck(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const name = "workflow hygiene";

  const result = await scanWorkflowsForHygiene(config.scriptDir);

  if (result.filesScanned === 0) {
    return { name, status: "SKIPPED", output: "no workflow files found" };
  }

  if (result.violations.length === 0) {
    return {
      name,
      status: "PASSED",
      output:
        `workflow hygiene: PASSED (${result.filesScanned} workflows scanned)`,
    };
  }

  const output = [
    ...result.violations.map(
      (v) => `VIOLATION: ${v.file}:${v.line}: ${v.detail}`,
    ),
    "",
    "Workflow hygiene defects detected (Issue #3716). Every multi-line",
    "`run:` block must open with `set -euo pipefail`, and one pinned SHA",
    "must carry one version comment everywhere it appears.",
  ].join("\n");

  return {
    name,
    status: "FAILED",
    output: `workflow hygiene: FAILED\n${output}`,
  };
}

/**
 * Run the config integration smoke test.
 */
async function runConfigSmokeTest(
  config: QualityGateConfig,
  denoCmd: string,
): Promise<CheckExecutionResult> {
  const name = "config integration";

  // Check if .config.json exists
  try {
    await Deno.stat(`${config.scriptDir}/.config.json`);
  } catch {
    return {
      name,
      status: "SKIPPED",
      output:
        "config integration: SKIPPED (deno or .config.json not available)",
    };
  }

  // Issue #97: the retired `config_defaults.sh` shim used to seed these empty
  // arrays before the load-config output was eval'd. Initialise them inline
  // instead — the check's invariant is that load-config *populates* REPOS and
  // ALLOWED_AUTHORS, and starting them empty is exactly what proves the
  // override (mirroring load_config_test.ts's own harness).
  const script = `
    set -euo pipefail
    REPOS=()
    ALLOWED_AUTHORS=()
    ISSUE_LABELS=()
    _output=$(cd ${posixSingleQuote(config.scriptDir)} && ${
    posixSingleQuote(denoCmd)
  } run --allow-read --allow-env worker/deno/mod.ts load-config 2>/dev/null) || true
    if [[ -n "$_output" ]]; then
        eval "$_output"
    fi
    if [[ \${#REPOS[@]} -eq 0 ]]; then
        echo 'FAIL: REPOS is empty after loading config — load-config output did not populate REPOS'
        exit 1
    fi
    if [[ \${#ALLOWED_AUTHORS[@]} -eq 0 ]]; then
        echo 'FAIL: ALLOWED_AUTHORS is empty after loading config'
        exit 1
    fi
    echo "OK: \${#REPOS[@]} repo(s), \${#ALLOWED_AUTHORS[@]} author(s)"
  `;

  const result = await runCommand(["bash", "-c", script]);
  if (result.exitCode === 0) {
    return {
      name,
      status: "PASSED",
      output: `config integration: PASSED (${result.output.trim()})`,
    };
  }
  return {
    name,
    status: "FAILED",
    output: `config integration: FAILED\n${result.output}`,
  };
}

/**
 * Run source target validation.
 *
 * Scans all .sh files for source directives and verifies targets exist.
 * Uses Deno file I/O for reliable cross-platform parsing.
 */
async function runSourceTargetCheck(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const name = "source targets";

  // Find all .sh files
  const findResult = await runCommand([
    "find",
    config.scriptDir,
    "-name",
    "*.sh",
    "-not",
    "-path",
    "*/node_modules/*",
    "-not",
    "-path",
    "*/.git/*",
    "-type",
    "f",
  ]);

  const files = findResult.output.split("\n").filter((f) => f.trim());
  if (files.length === 0) {
    return {
      name,
      status: "SKIPPED",
      output: "source target validation: SKIPPED (no .sh files found)",
    };
  }

  let failures = 0;
  let checked = 0;
  const errors: string[] = [];

  // Pattern to match source/dot directives: source "path" or . "path"
  const sourcePattern = /^\s*(source|\.) +(.+)/;

  for (const file of files) {
    let content: string;
    try {
      content = await Deno.readTextFile(file);
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]!;

      // Skip shellcheck directives and skip markers
      if (line.includes("shellcheck") || line.includes("# skip")) continue;

      const match = sourcePattern.exec(line);
      if (!match) continue;

      // Extract and clean target path
      let target = match[2]!;
      // Remove trailing comments
      target = target.replace(/#.*/, "").trim();
      // Remove quotes
      target = target.replace(/["']/g, "");

      // Skip variable expansions — we can only validate literal paths
      if (target.includes("$") || target.includes("`")) continue;
      if (!target) continue;

      checked++;
      const lineno = lineIdx + 1;

      // Check if file exists (absolute or relative to the file's directory)
      let exists = false;
      try {
        await Deno.stat(target);
        exists = true;
      } catch {
        // Try relative path
        const dir = file.substring(0, file.lastIndexOf("/"));
        try {
          await Deno.stat(`${dir}/${target}`);
          exists = true;
        } catch {
          // Does not exist
        }
      }

      if (!exists) {
        errors.push(
          `ERROR: ${file}:${lineno} sources '${target}' which does not exist`,
        );
        failures++;
      }
    }
  }

  if (failures > 0) {
    return {
      name,
      status: "FAILED",
      output: [
        ...errors,
        `source target validation: FAILED (${failures} missing target(s) in ${checked} checked)`,
      ].join("\n"),
    };
  }

  return {
    name,
    status: "PASSED",
    output: `source target validation: PASSED (${checked} targets checked)`,
  };
}

/**
 * Run the pages-liquid check (Issue #1601).
 *
 * Validates that every published Markdown file (AGENTS.md, README.md,
 * SECURITY.md, docs/**\/*.md) parses as valid Liquid AFTER the same
 * preprocessing step the Pages workflow uses. SKIPPED when Ruby +
 * Liquid is not installed locally (strict mode promotes SKIPPED to
 * FAILED so CI catches missing toolchains).
 */
async function runPagesLiquidQualityCheck(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const result = await runPagesLiquidCheck(config.scriptDir);
  return {
    name: "pages-liquid",
    status: result.status,
    output: result.output,
  };
}

/**
 * Run the mermaid quality check (Issue #1683).
 *
 * Validates every Mermaid block in every `.md` file in the repository so
 * syntax regressions like Issue #1663 are caught before they ship. The
 * check is fast and dependency-free — no Node/Mermaid toolchain
 * required — so it never SKIPS in normal runs.
 */
async function runMermaidQualityCheck(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const result = await runMermaidCheck(config.scriptDir);
  return {
    name: "mermaid",
    status: result.status,
    output: result.output,
  };
}

/**
 * Run the built-output Mermaid check (Issue #272).
 *
 * The `mermaid` check above validates Mermaid *blocks* in Markdown; the
 * security-level and CDN-integrity tests validate the *source* include. This
 * validates the HTML that actually ships. SKIPPED locally, where no Jekyll
 * build exists — strict mode promotes that to FAILED, and `pages.yml` runs it
 * against a real `_site` right after the build.
 */
async function runMermaidBuiltOutputQualityCheck(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const result = await checkBuiltMermaidOutput(`${config.scriptDir}/_site`);
  return {
    name: "mermaid built output",
    status: result.status,
    output: result.output,
  };
}

/**
 * Run the markdownlint quality check (Issue #1685).
 *
 * Drives `markdownlint-cli2` against the published Markdown set
 * (AGENTS.md, README.md, SECURITY.md, docs/**\/*.md) using the rule
 * selection in `.markdownlint-cli2.jsonc`. Catches structural defects
 * the pages-liquid (#1601) and mermaid (#1683) checks miss. Returns
 * SKIPPED when no markdownlint-cli2 binary is available; strict mode
 * promotes that to FAILED.
 */
async function runMarkdownlintQualityCheck(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const result = await runMarkdownlintCheck(config.scriptDir);
  return {
    name: "markdownlint",
    status: result.status,
    output: result.output,
  };
}

/**
 * Run the docs prompt-version freshness check (Issue #2286).
 *
 * Walks `CLAUDE.md`, `AGENTS.md`, and `docs/**\/*.md` (excluding the
 * historical `docs/archive/pr-summaries/` tree) and fails when any line
 * references `prompts/<type>/vN[.md]` for a version below the current
 * latest, unless the line carries an explicit "from vN onward" wording
 * or a `<!-- pinned: ... -->` marker.
 */
async function runDocsPromptVersionQualityCheck(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const result = await runDocsPromptVersionCheck(config.scriptDir);
  return {
    name: "docs prompt versions",
    status: result.status,
    output: result.output,
  };
}

/**
 * Run the semgrep SAST check over the branch's changed files (Issue #559).
 *
 * `semgrep ci --config p/default` blocks the PR, but nothing ran it locally,
 * so an agent's first sight of a SAST finding was a red PR. This runs the
 * same ruleset over the changed-file set only. SKIPPED — loudly, with the
 * reason — when semgrep is unavailable; strict mode promotes that to FAILED.
 */
async function runSemgrepQualityCheck(
  config: QualityGateConfig,
): Promise<CheckExecutionResult> {
  const result = await runSemgrepCheck(config.scriptDir);
  return { name: "semgrep", status: result.status, output: result.output };
}

/**
 * Run Deno tests.
 */
async function runDenoTests(
  config: QualityGateConfig,
  denoCmd: string,
): Promise<CheckExecutionResult> {
  const name = "deno tests";
  // Content-addressed skip (Issue #86): reuse a cached PASS only when the
  // whole .ts input set is byte-identical to the last passing run. The digest
  // walk is skipped entirely when caching is off, so a host dev run pays
  // nothing for it.
  const digest = config.cacheDir
    ? await computeQualityInputDigest(config.denoDir ?? ".")
    : null;
  const cachedAt = await cachedPassAt(config.cacheDir, name, digest);
  if (cachedAt) {
    return {
      name,
      status: "PASSED",
      output:
        `Deno tests: PASSED (cached — inputs unchanged since ${cachedAt})`,
    };
  }
  const result = await runCommand(
    [
      denoCmd,
      "test",
      // The gate's own `deno check '**/*.ts'` stage type-checks the whole
      // graph including tests/**, so `deno test` need not build a second
      // full TypeScript program (Issue #4347). In parallel mode both used
      // to start together and miss the shared cache — the memory spike
      // quality.sh blames for the in-container SIGKILLs.
      "--no-check",
      "--allow-read",
      "--allow-env",
      "--allow-run",
      "--allow-write",
      "--allow-sys=hostname",
    ],
    { cwd: config.denoDir },
  );

  if (result.exitCode === 0) {
    await recordPass(config.cacheDir, name, digest, isoNow());
    return {
      name,
      status: "PASSED",
      output: `${result.output}\nDeno tests: PASSED`,
    };
  }
  await invalidate(config.cacheDir, name);
  return {
    name,
    status: "FAILED",
    output: `${result.output}\nDeno tests: FAILED`,
  };
}

/**
 * Run Deno lint.
 */
async function runDenoLint(
  config: QualityGateConfig,
  denoCmd: string,
): Promise<CheckExecutionResult> {
  const name = "deno lint";
  const result = await runCommand([denoCmd, "lint"], { cwd: config.denoDir });

  if (result.exitCode === 0) {
    return {
      name,
      status: "PASSED",
      output: `${result.output}\nDeno lint: PASSED`,
    };
  }
  return {
    name,
    status: "FAILED",
    output: `${result.output}\nDeno lint: FAILED`,
  };
}

/**
 * Run `deno fmt --check` (Issue #2940).
 *
 * `deno lint` was already enforced both locally and in CI, but the
 * formatter gate was not, so ordinary formatting drift (import ordering,
 * line wrapping) could merge unnoticed. This check fails when any file in
 * the Deno tree is not formatted to the configured style; the offending
 * paths are surfaced in the output.
 */
export async function runDenoFmtCheck(
  config: QualityGateConfig,
  denoCmd: string,
): Promise<CheckExecutionResult> {
  const name = "deno fmt";
  const result = await runCommand([denoCmd, "fmt", "--check"], {
    cwd: config.denoDir,
  });

  if (result.exitCode === 0) {
    return {
      name,
      status: "PASSED",
      output: `${result.output}\nDeno fmt: PASSED`,
    };
  }
  return {
    name,
    status: "FAILED",
    output: `${result.output}\nDeno fmt: FAILED (run \`deno fmt\` to fix)`,
  };
}

// Issue #2569: check the whole tree via a recursive glob rather than just
// `mod.ts`. Checking only `mod.ts` type-checks the module graph reachable
// from `mod.ts`, so standalone entrypoints that nothing imports —
// `quality.ts` (the gate runner itself) and the `setup/` CLIs — were left
// unchecked or only covered incidentally via test imports. The glob is
// passed as a single literal argument so Deno expands it internally
// (recursively, including top-level files); a shell without `globstar`
// would otherwise miss the top-level entrypoints.
export async function runDenoCheck(
  config: QualityGateConfig,
  denoCmd: string,
): Promise<CheckExecutionResult> {
  const name = "deno type check";
  const digest = config.cacheDir
    ? await computeQualityInputDigest(config.denoDir ?? ".")
    : null;
  const cachedAt = await cachedPassAt(config.cacheDir, name, digest);
  if (cachedAt) {
    return {
      name,
      status: "PASSED",
      output:
        `Deno type check: PASSED (cached — inputs unchanged since ${cachedAt})`,
    };
  }
  const result = await runCommand(
    [denoCmd, "check", "**/*.ts"],
    { cwd: config.denoDir },
  );

  if (result.exitCode === 0) {
    await recordPass(config.cacheDir, name, digest, isoNow());
    return {
      name,
      status: "PASSED",
      output: `${result.output}\nDeno type check: PASSED`,
    };
  }
  await invalidate(config.cacheDir, name);
  return {
    name,
    status: "FAILED",
    output: `${result.output}\nDeno type check: FAILED`,
  };
}

/** ISO-8601 now, isolated so the cache stamp is easy to stub in tests. */
function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Run a set of checks in parallel, collecting results as they complete.
 *
 * Uses Promise.allSettled() so that a single throwing check does not
 * abort all other checks (Issue #1168). Rejected checks are recorded
 * as FAILED with the error message. Each check is reported to `onProgress`
 * the moment it settles, not when the slowest one does (Issue #399).
 */
export async function runChecksParallel(
  checks: Array<() => Promise<CheckExecutionResult>>,
  onProgress?: QualityProgressReporter,
): Promise<CheckExecutionResult[]> {
  const settled = await Promise.allSettled(checks.map(async (check, index) => {
    try {
      const result = await timed(check);
      report(onProgress, result);
      return result;
    } catch (err) {
      report(onProgress, {
        name: `check-${index + 1}`,
        status: "FAILED",
        output: "",
      });
      throw err;
    }
  }));
  return settled.map((outcome, index) => {
    if (outcome.status === "fulfilled") {
      return outcome.value;
    }
    const reason = outcome.reason instanceof Error
      ? outcome.reason.message
      : String(outcome.reason);
    recordFaultEvent(
      "promise_settled_rejection",
      `Quality check ${index + 1} rejected: ${reason}`,
    );
    return {
      name: `check-${index + 1}`,
      status: "FAILED" as CheckStatus,
      output: `Check threw an unexpected error: ${reason}`,
    };
  });
}

/**
 * Run a set of checks sequentially, reporting each one as it finishes
 * (Issue #399) rather than only when the whole set is done.
 */
export async function runChecksSequential(
  checks: Array<() => Promise<CheckExecutionResult>>,
  onProgress?: QualityProgressReporter,
): Promise<CheckExecutionResult[]> {
  const results: CheckExecutionResult[] = [];
  for (const check of checks) {
    const result = await timed(check);
    report(onProgress, result);
    results.push(result);
  }
  return results;
}

/**
 * Run the full quality gate.
 *
 * Orchestrates all quality checks: pre-checks (sequential), then main checks
 * (parallel by default, sequential with --sequential flag).
 *
 * Returns the overall result including check statuses and summary.
 */
export async function runQualityGate(
  config: QualityGateConfig,
): Promise<Result<QualityGateResult>> {
  const checks: CheckResult[] = [];
  const allOutput: string[] = [];

  /** Keep a settled check's output, record it, and stream it (Issue #399). */
  const note = (result: CheckExecutionResult): void => {
    allOutput.push(result.output);
    recordCheck(checks, result.name, result.status);
    report(config.onProgress, result);
  };

  allOutput.push("=== Running Quality Checks ===");
  config.onProgress?.("=== Running Quality Checks ===");

  // Detect tools
  const denoResult = await detectTool("deno");
  if (!denoResult.ok) {
    recordCheck(checks, "deno tests", "FAILED");
    recordCheck(checks, "deno lint", "FAILED");
    recordCheck(checks, "deno type check", "FAILED");
    recordCheck(checks, "deno fmt", "FAILED");
    const summary = formatSummary(checks, config.options.strict);
    return {
      ok: true,
      value: { checks, summary, passed: false, output: allOutput.join("\n") },
    };
  }
  const denoCmd = denoResult.value;

  // --- Pre-checks (sequential) ---

  // Prompt immutability — skip if prompts directory doesn't exist (non-VibeCoder repos)
  let hasPromptsDir = false;
  try {
    const stat = await Deno.stat(`${config.scriptDir}/prompts`);
    hasPromptsDir = stat.isDirectory;
  } catch { /* directory doesn't exist */ }

  if (hasPromptsDir && config.denoDir) {
    const immutabilityResult = await runPromptImmutabilityCheck(
      config,
      denoCmd,
    );
    note(immutabilityResult);
    if (immutabilityResult.status === "FAILED") {
      const summary = formatSummary(checks, config.options.strict);
      return {
        ok: true,
        value: { checks, summary, passed: false, output: allOutput.join("\n") },
      };
    }
  } else {
    recordCheck(checks, "prompt immutability", "SKIPPED");
  }

  // Prompt placeholders (only with --validate-prompts)
  if (config.options.validatePrompts && config.denoDir) {
    const placeholderResult = await runPromptPlaceholderCheck(config, denoCmd);
    note(placeholderResult);
  }

  // Benchmark audit
  note(await runBenchmarkAudit(config));

  // Hardcoded branch names (Issue #1182)
  note(await runHardcodedBranchCheck(config));

  // needs-human chokepoint (Issue #2689) — every `needs-human` label
  // application must route through the `escalateToHuman` helper.
  note(await runNeedsHumanHelperCheck(config));

  // gh spawn chokepoint (Issue #3703) — every `gh` subprocess must be
  // spawned by `gh_spawn.ts` so the write-repo allowlist and the audit
  // journal are unavoidable.
  note(await runGhSpawnChokepointCheck(config));

  // host work-dir guard (Issue #135, parent #118) — no source file may build
  // a work-dir path from HOME/USERPROFILE outside the commented allowlist,
  // so a host-side entry point can never grow back a ~/auto-issue-work
  // default.
  note(await runHomeWorkDirGuardCheck(config));

  // git ref chokepoint (Issue #12) — a PR head branch name must reach git
  // only through the ref-arg builders, never as an inline positional.
  note(await runGitRefArgvCheck(config));

  // Workflow hygiene (Issue #3716) — strict-mode `run:` blocks and
  // consistent SHA/version pin comments across .github/workflows.
  note(await runWorkflowHygieneCheck(config));

  // Config integration smoke test
  const configResult = await runConfigSmokeTest(config, denoCmd);
  note(configResult);
  if (configResult.status === "FAILED") {
    const summary = formatSummary(checks, config.options.strict);
    return {
      ok: true,
      value: { checks, summary, passed: false, output: allOutput.join("\n") },
    };
  }

  // Check deno dir exists
  let denoModuleExists = false;
  if (config.denoDir) {
    try {
      const stat = await Deno.stat(config.denoDir);
      denoModuleExists = stat.isDirectory;
    } catch (err) {
      // Directory does not exist — log for diagnostics (Issue #1168)
      console.warn(
        `[quality-gate] Deno directory not found at ${config.denoDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // --- Main checks (parallel or sequential) ---
  const mainChecks: Array<() => Promise<CheckExecutionResult>> = [];

  // Source target validation
  mainChecks.push(() => runSourceTargetCheck(config));

  // Pages-liquid (Issue #1601) — validates published Markdown parses as
  // Liquid after the same preprocessing the Pages workflow uses. Skipped
  // when Ruby + Liquid is unavailable locally; promoted to FAILED in
  // strict mode so CI catches missing toolchains.
  mainChecks.push(() => runPagesLiquidQualityCheck(config));

  // Mermaid (Issue #1683) — validates every Mermaid block in every .md
  // file in the repo. No external toolchain required.
  mainChecks.push(() => runMermaidQualityCheck(config));

  // Mermaid built output (Issue #272) — asserts securityLevel and the CDN
  // SRI hash in the built `_site` HTML, not just the source include. Skipped
  // when there is no local Jekyll build; `pages.yml` runs the same check
  // against the real artifact.
  mainChecks.push(() => runMermaidBuiltOutputQualityCheck(config));

  // Markdownlint (Issue #1685) — drives markdownlint-cli2 against the
  // published Markdown set to catch structural defects (broken tables,
  // heading hierarchy, missing-space ATX headings) that the
  // pages-liquid and mermaid checks miss. Skipped when the linter
  // binary is not available locally.
  mainChecks.push(() => runMarkdownlintQualityCheck(config));

  // Docs prompt versions (Issue #2286) — fails when CLAUDE.md, AGENTS.md,
  // or anything under docs/ (except docs/archive/pr-summaries/) references
  // a non-latest `prompts/<type>/vN[.md]` without "from vN onward" wording
  // or a `<!-- pinned: --> ` marker.
  mainChecks.push(() => runDocsPromptVersionQualityCheck(config));

  // Semgrep (Issue #559) — the same `p/default` ruleset the blocking
  // `semgrep.yml` PR check runs, over the branch's changed files only, so a
  // SAST finding is met before the push rather than after it. Skipped loudly
  // when semgrep is unavailable.
  mainChecks.push(() => runSemgrepQualityCheck(config));

  // Shellcheck is intentionally NOT run by the worker (Issue #3129). Bash
  // linting is owned by each target repo's own CI (the `shellcheck`
  // GitHub Actions workflow the worker syncs in via workflow_definitions.ts),
  // so the worker no longer runs it locally — that avoided two problems:
  // hosts without the shellcheck binary failed every .sh-containing repo, and
  // the worker's bare `-e SC1091 -e SC2034` scan drifted stricter than a
  // repo's own (deliberately curated) CI policy. A genuine CI shellcheck
  // failure is handled by the existing CI-fix flow (ci_failure_classifier.ts).

  // Deno checks
  if (denoModuleExists) {
    mainChecks.push(() => runDenoTests(config, denoCmd));
    mainChecks.push(() => runDenoLint(config, denoCmd));
    mainChecks.push(() => runDenoCheck(config, denoCmd));
    // Issue #2940 — enforce formatting drift alongside lint/type-check.
    mainChecks.push(() => runDenoFmtCheck(config, denoCmd));
  }

  // Execute checks
  let mainResults: CheckExecutionResult[];
  if (config.options.sequential) {
    mainResults = await runChecksSequential(mainChecks, config.onProgress);
  } else {
    allOutput.push("");
    allOutput.push(
      "Running independent checks in parallel (Issue #625)...",
    );
    config.onProgress?.("Running independent checks in parallel...");
    mainResults = await runChecksParallel(mainChecks, config.onProgress);
  }

  // Record results, with a per-check duration line so the gate's cost is
  // visible (Issue #86) — the two heavy dimensions dominate, and a cached
  // skip shows as a few milliseconds.
  for (const result of mainResults) {
    allOutput.push(result.output);
    if (result.durationMs !== undefined) {
      allOutput.push(
        `  ⏱  ${result.name}: ${(result.durationMs / 1000).toFixed(1)}s`,
      );
    }
    recordCheck(checks, result.name, result.status);
  }

  // Record skipped checks for missing tools
  if (!denoModuleExists) {
    recordCheck(checks, "deno tests", "SKIPPED");
    recordCheck(checks, "deno lint", "SKIPPED");
    recordCheck(checks, "deno type check", "SKIPPED");
    recordCheck(checks, "deno fmt", "SKIPPED");
  }

  const summary = formatSummary(checks, config.options.strict);
  return {
    ok: true,
    value: {
      checks,
      summary,
      passed: summary.passed,
      output: allOutput.join("\n"),
    },
  };
}
