/**
 * Quality check helpers and result formatting (Issue #917).
 *
 * Provides shared utilities for the quality gate:
 * - Check status tracking and summary formatting
 * - Tool detection (deno)
 * - Quality failure message formatting for GitHub comments
 * - Baseline quality note formatting
 * - Missing tool detection and reporting
 * - Argument parsing for quality flags
 *
 * Migrated from worker/shared/quality_helpers.sh as part of the
 * incremental Deno migration (#896).
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { Result } from "../types.ts";

/** Status of an individual quality check. */
export type CheckStatus = "PASSED" | "SKIPPED" | "FAILED";

/** Result of a single quality check. */
export interface CheckResult {
  name: string;
  status: CheckStatus;
}

/** Parsed quality gate options. */
export interface QualityOptions {
  strict: boolean;
  sequential: boolean;
  validatePrompts: boolean;
}

/**
 * Parse quality gate command-line arguments.
 *
 * Recognises --strict, --sequential, and --validate-prompts flags.
 * Also respects QUALITY_STRICT, QUALITY_SEQUENTIAL, and
 * QUALITY_VALIDATE_PROMPTS environment variables.
 */
export function parseQualityArgs(args: string[]): QualityOptions {
  const options: QualityOptions = {
    strict: false,
    sequential: false,
    validatePrompts: false,
  };

  for (const arg of args) {
    switch (arg) {
      case "--strict":
        options.strict = true;
        break;
      case "--sequential":
        options.sequential = true;
        break;
      case "--validate-prompts":
        options.validatePrompts = true;
        break;
    }
  }

  return options;
}

/**
 * Apply environment variable overrides to quality options.
 *
 * Checks QUALITY_STRICT, QUALITY_SEQUENTIAL, and QUALITY_VALIDATE_PROMPTS
 * environment variables. Environment variables override CLI flags (set to true).
 */
export function applyEnvOverrides(
  options: QualityOptions,
  env: Record<string, string | undefined>,
): QualityOptions {
  return {
    strict: options.strict || env["QUALITY_STRICT"] === "true",
    sequential: options.sequential || env["QUALITY_SEQUENTIAL"] === "true",
    validatePrompts: options.validatePrompts ||
      env["QUALITY_VALIDATE_PROMPTS"] === "true",
  };
}

/**
 * Record or update a check result in the results array.
 *
 * If a check with the same name already exists, its status is updated in place.
 * Otherwise, a new entry is appended.
 */
export function recordCheck(
  results: CheckResult[],
  name: string,
  status: CheckStatus,
): void {
  const existing = results.find((r) => r.name === name);
  if (existing) {
    existing.status = status;
  } else {
    results.push({ name, status });
  }
}

/** Summary result from evaluating check outcomes. */
export interface SummaryResult {
  /** Formatted summary table text. */
  text: string;
  /** Whether all checks passed (considering strict mode). */
  passed: boolean;
}

/**
 * Format the quality check summary table.
 *
 * Returns a formatted summary table and whether the overall result is PASSED.
 * In strict mode, skipped checks cause failure.
 */
export function formatSummary(
  results: CheckResult[],
  strict: boolean,
): SummaryResult {
  const lines: string[] = [];
  lines.push("");
  lines.push("=== Quality Check Summary ===");
  lines.push("");

  let hasFailed = false;
  let hasSkipped = false;

  for (const { name, status } of results) {
    if (status === "FAILED") hasFailed = true;
    if (status === "SKIPPED") hasSkipped = true;
    lines.push(`  ${name.padEnd(30)} ${status}`);
  }

  lines.push("");

  if (hasFailed) {
    lines.push("Result: FAILED");
    return { text: lines.join("\n"), passed: false };
  }

  if (hasSkipped) {
    if (strict) {
      lines.push(
        "Result: FAILED (strict mode \u2014 skipped checks are not allowed)",
      );
      return { text: lines.join("\n"), passed: false };
    }
    lines.push("Result: PASSED (with skipped checks)");
    return { text: lines.join("\n"), passed: true };
  }

  lines.push("Result: PASSED");
  return { text: lines.join("\n"), passed: true };
}

/**
 * Detect whether a tool is available on the system.
 *
 * Checks the PATH first via `which`, then common install locations.
 * Returns the path to the tool if found, or an error result if not.
 */
export async function detectTool(
  toolName: string,
  homeDir?: string,
): Promise<Result<string>> {
  // Check PATH via which
  try {
    const cmd = new Deno.Command("which", {
      args: [toolName],
      stdout: "piped",
      stderr: "null",
    });
    const output = await cmd.output();
    if (output.success) {
      const path = new TextDecoder().decode(output.stdout).trim();
      if (path) {
        return { ok: true, value: path };
      }
    }
  } catch {
    // which not available, fall through to manual search
  }

  // Check common locations based on tool name
  const searchPaths: string[] = [];
  const home = homeDir ?? Deno.env.get("HOME") ?? "";

  switch (toolName) {
    case "deno":
      searchPaths.push(
        `${home}/.deno/bin/deno`,
        "/opt/homebrew/bin/deno",
        "/usr/local/bin/deno",
      );
      break;
  }

  for (const path of searchPaths) {
    try {
      const stat = await Deno.stat(path);
      if (stat.isFile) {
        return { ok: true, value: path };
      }
    } catch {
      // Path does not exist, continue
    }
  }

  return { ok: false, error: new Error(`Tool not found: ${toolName}`) };
}

/**
 * Format a quality check failure message for GitHub comments.
 *
 * Shows the last 30 lines prominently, with the full output (truncated
 * to 200 lines) in a collapsed details block. Optionally includes
 * baseline context when the baseline was already failing.
 */
export function formatQualityFailureMessage(
  qualityOutput: string,
  baselinePassed?: boolean,
  baselineOutput?: string,
): string {
  const maxFullLines = 200;
  const tailLines = 30;

  const header =
    `Quality checks (\`./quality.sh\`) failed and could not be fixed automatically.

The PR was not created because local quality checks must pass before raising a PR.`;

  const footer =
    "The issue will be retried on the next scan. Claude will attempt to fix the quality issues.";

  if (!qualityOutput) {
    return `${header}\n\n${footer}`;
  }

  const outputLines = qualityOutput.split("\n");
  const totalLines = outputLines.length;

  // Extract the last N lines for the prominent section
  const tailOutput = totalLines <= tailLines
    ? qualityOutput
    : outputLines.slice(-tailLines).join("\n");

  // Build the full output for the details block, truncated if needed
  let fullOutput: string;
  let truncationNotice = "";
  if (totalLines > maxFullLines) {
    fullOutput = outputLines.slice(-maxFullLines).join("\n");
    const linesTruncated = totalLines - maxFullLines;
    truncationNotice =
      `(${linesTruncated} lines truncated \u2014 showing last ${maxFullLines} of ${totalLines} lines)`;
  } else {
    fullOutput = qualityOutput;
  }

  const parts: string[] = [];
  parts.push(header);
  parts.push("");
  parts.push("### Quality Check Output");
  parts.push("```");
  parts.push(tailOutput);
  parts.push("```");
  parts.push("");
  parts.push("<details>");
  parts.push("<summary>Full quality check output (click to expand)</summary>");
  parts.push("");
  if (truncationNotice) {
    parts.push(`_${truncationNotice}_`);
    parts.push("");
  }
  parts.push("```");
  parts.push(fullOutput);
  parts.push("```");
  parts.push("");
  parts.push("</details>");
  parts.push("");
  parts.push(footer);

  // Append baseline context if baseline was already failing
  if (baselinePassed === false && baselineOutput) {
    const baselineNote = formatBaselineQualityNote(baselineOutput);
    if (baselineNote) {
      parts.push("");
      parts.push(baselineNote);
    }
  }

  return parts.join("\n");
}

/**
 * Format a note distinguishing "only pre-existing failures" from "new
 * failures introduced" in the post-Claude quality run (Issue #1549).
 *
 * Used by the baseline-aware quality gate — when the gate ultimately
 * fails AND the baseline-aware decision identified at least one
 * pre-existing finding, this note tells reviewers how many of the
 * remaining findings carried over from the baseline so they can focus
 * on the genuinely new ones.
 *
 * Returns an empty string when there were no pre-existing findings (the
 * legacy "all-new" path) so the failure message stays unchanged.
 */
export function formatBaselineCarryoverNote(preExistingCount: number): string {
  if (preExistingCount <= 0) return "";
  const noun = preExistingCount === 1 ? "finding was" : "findings were";
  return `> **Baseline carryover:** ${preExistingCount} pre-existing ` +
    `${noun} present on the default branch before this change. The remaining ` +
    `failure(s) are NEW findings introduced by the change — focus the fix on those.`;
}

/**
 * Format a note about pre-existing quality failures.
 *
 * When the baseline quality check detected failures before the worker started,
 * this formats a markdown note to include in failure comments.
 * Returns empty string if baseline output is empty (baseline passed or not run).
 */
export function formatBaselineQualityNote(baselineOutput: string): string {
  if (!baselineOutput) {
    return "";
  }

  const maxLines = 50;
  const outputLines = baselineOutput.split("\n");
  const totalLines = outputLines.length;

  let displayOutput: string;
  if (totalLines > maxLines) {
    displayOutput = `(showing last ${maxLines} of ${totalLines} lines)\n${
      outputLines.slice(-maxLines).join("\n")
    }`;
  } else {
    displayOutput = baselineOutput;
  }

  return `> **Note:** Quality checks were already failing on the clean repository before the worker started. The following pre-existing failures were detected:\n>\n\`\`\`\n${displayOutput}\n\`\`\``;
}

/**
 * Detect missing quality tools by scanning a quality script.
 *
 * Scans the quality script for references to common tools (npm, node, yarn,
 * pnpm, deno, etc.) and verifies they are available in the current PATH.
 *
 * Returns a list of missing tool names, or an empty array if all found.
 */
export async function detectMissingQualityTools(
  qualityScript: string,
): Promise<Result<string[]>> {
  const toolsToCheck = [
    "npm",
    "node",
    "yarn",
    "pnpm",
    "npx",
    "deno",
    "bun",
  ];

  let scriptContent: string;
  try {
    scriptContent = await Deno.readTextFile(qualityScript);
  } catch {
    return { ok: true, value: [] };
  }

  const missingTools: string[] = [];
  const toolPattern = (tool: string) =>
    new RegExp(`(^|[\\s/"])(${tool})([\\s"']|$)`, "m");

  for (const tool of toolsToCheck) {
    if (toolPattern(tool).test(scriptContent)) {
      const found = await detectTool(tool);
      if (!found.ok) {
        missingTools.push(tool);
      }
    }
  }

  return { ok: true, value: missingTools };
}

/**
 * Format a clear failure message for missing tools.
 *
 * Creates a markdown-formatted message explaining which tools are missing
 * from the worker environment and what the developer should do about it.
 */
export function formatMissingToolsMessage(
  missingTools: string[],
  qualityScript: string,
): string {
  const toolList = missingTools.map((t) => `- \`${t}\``).join("\n");

  return `**Cannot run quality checks \u2014 required tools are not available in the worker environment.**

The following tool(s) referenced in \`${qualityScript}\` are not installed or not in PATH:

${toolList}

**Why this blocks the issue:** The quality gate (\`./quality.sh\`) cannot execute because these tools are missing from the unattended worker machine. Claude cannot install system-level tools, so this must be fixed by a developer.

**How to fix:**
1. Configure a \`docker_image\` for this repository in \`.config.json\` so quality checks run inside a container with the right tools, e.g.:
   \`\`\`json
   "repo_config": {
     "org/repo": {
       "docker_image": "node:20"
     }
   }
   \`\`\`
   Common images: \`node:20\`, \`node:22\`, \`denoland/deno:latest\`, \`eclipse-temurin:21\`, \`rust:latest\`
2. Update \`${qualityScript}\` to skip checks that require unavailable tools (e.g., gate them behind \`command -v\` checks), **or**
3. Install the missing tool(s) on the worker machine directly

This is an **environment issue**, not a code issue \u2014 retrying will produce the same result until the environment is fixed.`;
}
