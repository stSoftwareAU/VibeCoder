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
 */ import { redactSecrets } from "./secret_redaction.ts";
import { commandOutputWithTimeout, isCommandTimeoutError } from "./subprocess_timeout.ts";
/** `which` and the other tool probes. A hang here must not look like success. */ const TOOL_PROBE_TIMEOUT_MS = 10_000;
/**
 * Characters kept from each end of a logged quality-gate excerpt (Issue
 * #1852). The head carries the failing check's name — the gate prints it as it
 * starts the check — and the tail carries the findings, so a log line that
 * kept only one of the two could not say what was red.
 */ export const GATE_EXCERPT_HEAD_CHARS = 250;
export const GATE_EXCERPT_TAIL_CHARS = 500;
/**
 * Parse quality gate command-line arguments.
 *
 * Recognises --strict, --sequential, and --validate-prompts flags.
 * Also respects QUALITY_STRICT, QUALITY_SEQUENTIAL, and
 * QUALITY_VALIDATE_PROMPTS environment variables.
 */ export function parseQualityArgs(args) {
  const options = {
    strict: false,
    sequential: false,
    validatePrompts: false
  };
  for (const arg of args){
    switch(arg){
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
 */ export function applyEnvOverrides(options, env) {
  return {
    strict: options.strict || env["QUALITY_STRICT"] === "true",
    sequential: options.sequential || env["QUALITY_SEQUENTIAL"] === "true",
    validatePrompts: options.validatePrompts || env["QUALITY_VALIDATE_PROMPTS"] === "true"
  };
}
/**
 * Record or update a check result in the results array.
 *
 * If a check with the same name already exists, its status is updated in place.
 * Otherwise, a new entry is appended.
 */ export function recordCheck(results, name, status, output) {
  const existing = results.find((r)=>r.name === name);
  if (existing) {
    existing.status = status;
    // An omitted output leaves whatever was recorded before, so a caller that
    // only updates a status cannot silently erase the recorded output.
    if (output !== undefined) existing.output = output;
  } else {
    results.push({
      name,
      status,
      ...output !== undefined ? {
        output
      } : {}
    });
  }
}
/**
 * Format the quality check summary table.
 *
 * Returns a formatted summary table and whether the overall result is PASSED.
 * In strict mode, skipped checks cause failure.
 */ export function formatSummary(results, strict) {
  const lines = [];
  lines.push("");
  lines.push("=== Quality Check Summary ===");
  lines.push("");
  let hasFailed = false;
  let hasSkipped = false;
  for (const { name, status } of results){
    if (status === "FAILED") hasFailed = true;
    if (status === "SKIPPED") hasSkipped = true;
    lines.push(`  ${name.padEnd(30)} ${status}`);
  }
  lines.push("");
  if (hasFailed) {
    lines.push("Result: FAILED");
    return {
      text: lines.join("\n"),
      passed: false
    };
  }
  if (hasSkipped) {
    if (strict) {
      lines.push("Result: FAILED (strict mode \u2014 skipped checks are not allowed)");
      return {
        text: lines.join("\n"),
        passed: false
      };
    }
    lines.push("Result: PASSED (with skipped checks)");
    return {
      text: lines.join("\n"),
      passed: true
    };
  }
  lines.push("Result: PASSED");
  return {
    text: lines.join("\n"),
    passed: true
  };
}
/**
 * The running Deno executable, when it is one.
 *
 * This process IS deno, so its own path is the authoritative answer for the
 * `deno` tool — no PATH lookup can be more accurate, and none can fail.
 * `Deno.execPath()` throws without read permission, and a `deno compile`d
 * binary's path is not a deno CLI, so both cases fall through to the probes.
 */ export function runningDenoPath() {
  try {
    const path = Deno.execPath();
    const name = path.split(/[/\\]/).pop() ?? "";
    return name === "deno" || name === "deno.exe" ? path : null;
  } catch  {
    return null; // no read permission — fall through to the probes
  }
}
/**
 * Detect whether a tool is available on the system.
 *
 * For `deno`, the running executable answers first (PR #888 CI): `which` is
 * an unnecessary subprocess whose failure — a PATH a test left rewritten, a
 * spawn that lost a fork, an image without `which` — silently demoted every
 * Deno check in the gate. CI installs Deno into the runner tool cache, which
 * none of the hardcoded fallbacks below cover, so that lookup was the only
 * thing standing between the gate and four unexplained FAILED checks.
 *
 * Otherwise checks the PATH via `which`, then common install locations.
 * Returns the path to the tool if found, or an error result if not.
 */ export async function detectTool(toolName, homeDir, timeoutMs = TOOL_PROBE_TIMEOUT_MS) {
  if (toolName === "deno") {
    const running = runningDenoPath();
    if (running) return {
      ok: true,
      value: running
    };
  }
  // Check PATH via which
  try {
    const output = await commandOutputWithTimeout("which", {
      args: [
        toolName
      ],
      stdout: "piped",
      stderr: "null",
      timeoutMs
    });
    if (output.success) {
      const path = new TextDecoder().decode(output.stdout).trim();
      if (path) {
        return {
          ok: true,
          value: path
        };
      }
    }
  } catch (error) {
    if (isCommandTimeoutError(error)) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(`which timed out after ${timeoutMs}ms`)
      };
    }
  // which not available, fall through to manual search
  }
  // Check common locations based on tool name
  const searchPaths = [];
  const home = homeDir ?? Deno.env.get("HOME") ?? "";
  switch(toolName){
    case "deno":
      searchPaths.push(`${home}/.deno/bin/deno`, "/opt/homebrew/bin/deno", "/usr/local/bin/deno");
      break;
  }
  for (const path of searchPaths){
    try {
      const stat = await Deno.stat(path);
      if (stat.isFile) {
        return {
          ok: true,
          value: path
        };
      }
    } catch  {
    // Path does not exist, continue
    }
  }
  return {
    ok: false,
    error: new Error(`Tool not found: ${toolName}`)
  };
}
/**
 * Format a quality check failure message for GitHub comments.
 *
 * Shows the last 30 lines prominently, with the full output (truncated
 * to 200 lines) in a collapsed details block. Optionally includes
 * baseline context when the baseline was already failing.
 */ export function formatQualityFailureMessage(qualityOutput, baselinePassed, baselineOutput) {
  const maxFullLines = 200;
  const tailLines = 30;
  const header = `Quality checks (\`./quality.sh\`) failed and could not be fixed automatically.

The PR was not created because local quality checks must pass before raising a PR.`;
  const footer = "The issue will be retried on the next scan. Claude will attempt to fix the quality issues.";
  if (!qualityOutput) {
    return `${header}\n\n${footer}`;
  }
  // Redact the whole output before either cut (Issue #1257): `./quality.sh`
  // echoes whatever a failing check printed — a tokenised remote URL, an
  // `export *_TOKEN=` line — and this message is posted as a public comment.
  // Cutting first would split a credential into a fragment no rule matches.
  const redactedOutput = redactSecrets(qualityOutput);
  const outputLines = redactedOutput.split("\n");
  const totalLines = outputLines.length;
  // Extract the last N lines for the prominent section
  const tailOutput = totalLines <= tailLines ? redactedOutput : outputLines.slice(-tailLines).join("\n");
  // Build the full output for the details block, truncated if needed
  let fullOutput;
  let truncationNotice = "";
  if (totalLines > maxFullLines) {
    fullOutput = outputLines.slice(-maxFullLines).join("\n");
    const linesTruncated = totalLines - maxFullLines;
    truncationNotice = `(${linesTruncated} lines truncated \u2014 showing last ${maxFullLines} of ${totalLines} lines)`;
  } else {
    fullOutput = redactedOutput;
  }
  const parts = [];
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
 */ export function formatBaselineCarryoverNote(preExistingCount) {
  if (preExistingCount <= 0) return "";
  const noun = preExistingCount === 1 ? "finding was" : "findings were";
  return `> **Baseline carryover:** ${preExistingCount} pre-existing ` + `${noun} present on the default branch before this change. The remaining ` + `failure(s) are NEW findings introduced by the change — focus the fix on those.`;
}
/**
 * Format a note about pre-existing quality failures.
 *
 * When the baseline quality check detected failures before the worker started,
 * this formats a markdown note to include in failure comments.
 * Returns empty string if baseline output is empty (baseline passed or not run).
 */ export function formatBaselineQualityNote(baselineOutput) {
  if (!baselineOutput) {
    return "";
  }
  const maxLines = 50;
  // Redacted whole, then cut (Issue #1257) — this note is quoted into a public
  // failure comment.
  const redactedOutput = redactSecrets(baselineOutput);
  const outputLines = redactedOutput.split("\n");
  const totalLines = outputLines.length;
  let displayOutput;
  if (totalLines > maxLines) {
    displayOutput = `(showing last ${maxLines} of ${totalLines} lines)\n${outputLines.slice(-maxLines).join("\n")}`;
  } else {
    displayOutput = redactedOutput;
  }
  return `> **Note:** Quality checks were already failing on the clean repository before the worker started. The following pre-existing failures were detected:\n>\n\`\`\`\n${displayOutput}\n\`\`\``;
}
/**
 * Word-delimited tokens in a shell script, the shape a tool name appears in:
 * preceded by start-of-line, whitespace, `/` or `"`, and followed by
 * whitespace, a quote or end-of-line — so `.npmrc` and `deno.lock` are single
 * tokens rather than references to `npm` and `deno`.
 *
 * One literal pattern for every tool, rather than `new RegExp(tool)` per name:
 * a regex built from an interpolated value is a semgrep
 * `detect-non-literal-regexp` finding, and the same rule blocks the PR in
 * `.github/workflows/semgrep.yml`.
 */ const TOOL_WORD_PATTERN = /(?:^|[\s/"])([\w.-]+)(?=[\s"']|$)/gm;
/** The set of word-delimited tokens a quality script mentions. */ function referencedToolWords(scriptContent) {
  const words = new Set();
  for (const match of scriptContent.matchAll(TOOL_WORD_PATTERN)){
    const word = match[1];
    if (word) words.add(word);
  }
  return words;
}
/**
 * Detect missing quality tools by scanning a quality script.
 *
 * Scans the quality script for references to common tools (npm, node, yarn,
 * pnpm, deno, etc.) and verifies they are available in the current PATH.
 *
 * Returns a list of missing tool names, or an empty array if all found.
 */ export async function detectMissingQualityTools(qualityScript) {
  const toolsToCheck = [
    "npm",
    "node",
    "yarn",
    "pnpm",
    "npx",
    "deno",
    "bun"
  ];
  let scriptContent;
  try {
    scriptContent = await Deno.readTextFile(qualityScript);
  } catch  {
    return {
      ok: true,
      value: []
    };
  }
  const missingTools = [];
  const referenced = referencedToolWords(scriptContent);
  for (const tool of toolsToCheck){
    if (referenced.has(tool)) {
      const found = await detectTool(tool);
      if (!found.ok) {
        missingTools.push(tool);
      }
    }
  }
  return {
    ok: true,
    value: missingTools
  };
}
/**
 * Format a clear failure message for missing tools.
 *
 * Creates a markdown-formatted message explaining which tools are missing
 * from the worker environment and what the developer should do about it.
 */ export function formatMissingToolsMessage(missingTools, qualityScript) {
  const toolList = missingTools.map((t)=>`- \`${t}\``).join("\n");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9xdWFsaXR5X2hlbHBlcnMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBRdWFsaXR5IGNoZWNrIGhlbHBlcnMgYW5kIHJlc3VsdCBmb3JtYXR0aW5nIChJc3N1ZSAjOTE3KS5cbiAqXG4gKiBQcm92aWRlcyBzaGFyZWQgdXRpbGl0aWVzIGZvciB0aGUgcXVhbGl0eSBnYXRlOlxuICogLSBDaGVjayBzdGF0dXMgdHJhY2tpbmcgYW5kIHN1bW1hcnkgZm9ybWF0dGluZ1xuICogLSBUb29sIGRldGVjdGlvbiAoZGVubylcbiAqIC0gUXVhbGl0eSBmYWlsdXJlIG1lc3NhZ2UgZm9ybWF0dGluZyBmb3IgR2l0SHViIGNvbW1lbnRzXG4gKiAtIEJhc2VsaW5lIHF1YWxpdHkgbm90ZSBmb3JtYXR0aW5nXG4gKiAtIE1pc3NpbmcgdG9vbCBkZXRlY3Rpb24gYW5kIHJlcG9ydGluZ1xuICogLSBBcmd1bWVudCBwYXJzaW5nIGZvciBxdWFsaXR5IGZsYWdzXG4gKlxuICogTWlncmF0ZWQgZnJvbSB3b3JrZXIvc2hhcmVkL3F1YWxpdHlfaGVscGVycy5zaCBhcyBwYXJ0IG9mIHRoZVxuICogaW5jcmVtZW50YWwgRGVubyBtaWdyYXRpb24gKCM4OTYpLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB1c2VkIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgcmVkYWN0U2VjcmV0cyB9IGZyb20gXCIuL3NlY3JldF9yZWRhY3Rpb24udHNcIjtcbmltcG9ydCB7XG4gIGNvbW1hbmRPdXRwdXRXaXRoVGltZW91dCxcbiAgaXNDb21tYW5kVGltZW91dEVycm9yLFxufSBmcm9tIFwiLi9zdWJwcm9jZXNzX3RpbWVvdXQudHNcIjtcblxuLyoqIGB3aGljaGAgYW5kIHRoZSBvdGhlciB0b29sIHByb2Jlcy4gQSBoYW5nIGhlcmUgbXVzdCBub3QgbG9vayBsaWtlIHN1Y2Nlc3MuICovXG5jb25zdCBUT09MX1BST0JFX1RJTUVPVVRfTVMgPSAxMF8wMDA7XG5cbi8qKlxuICogQ2hhcmFjdGVycyBrZXB0IGZyb20gZWFjaCBlbmQgb2YgYSBsb2dnZWQgcXVhbGl0eS1nYXRlIGV4Y2VycHQgKElzc3VlXG4gKiAjMTg1MikuIFRoZSBoZWFkIGNhcnJpZXMgdGhlIGZhaWxpbmcgY2hlY2sncyBuYW1lIOKAlCB0aGUgZ2F0ZSBwcmludHMgaXQgYXMgaXRcbiAqIHN0YXJ0cyB0aGUgY2hlY2sg4oCUIGFuZCB0aGUgdGFpbCBjYXJyaWVzIHRoZSBmaW5kaW5ncywgc28gYSBsb2cgbGluZSB0aGF0XG4gKiBrZXB0IG9ubHkgb25lIG9mIHRoZSB0d28gY291bGQgbm90IHNheSB3aGF0IHdhcyByZWQuXG4gKi9cbmV4cG9ydCBjb25zdCBHQVRFX0VYQ0VSUFRfSEVBRF9DSEFSUyA9IDI1MDtcbmV4cG9ydCBjb25zdCBHQVRFX0VYQ0VSUFRfVEFJTF9DSEFSUyA9IDUwMDtcblxuLyoqIFN0YXR1cyBvZiBhbiBpbmRpdmlkdWFsIHF1YWxpdHkgY2hlY2suICovXG5leHBvcnQgdHlwZSBDaGVja1N0YXR1cyA9IFwiUEFTU0VEXCIgfCBcIlNLSVBQRURcIiB8IFwiRkFJTEVEXCI7XG5cbi8qKiBSZXN1bHQgb2YgYSBzaW5nbGUgcXVhbGl0eSBjaGVjay4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2hlY2tSZXN1bHQge1xuICBuYW1lOiBzdHJpbmc7XG4gIHN0YXR1czogQ2hlY2tTdGF0dXM7XG4gIC8qKlxuICAgKiBXaGF0IHRoZSBjaGVjayBwcmludGVkIChJc3N1ZXMgIzE4NTIsICMzNzI2KS4gUmVjb3JkZWQgZm9yIEZBSUxFRCBjaGVja3NcbiAgICogc28gdGhlIHBvc3QtY2hhbmdlIGdhdGUgY2FuIGFzayB3aGV0aGVyIGEgZmFpbHVyZSByZXByb2R1Y2VzIG9uZSB0aGVcbiAgICogdW50b3VjaGVkIHRyZWUgYWxyZWFkeSBoYWQsIGFuZCBmb3IgU0tJUFBFRCBjaGVja3MgYmVjYXVzZSB0aGUgb3V0cHV0IGlzXG4gICAqIHRoZSByZWFzb24gdGhlIHN0YWdlIGRpZCBub3QgcnVuLCB3aGljaCBhbiBhdWRpdCBuZWVkcyB0byBtYXRjaCBhIENJLW9ubHlcbiAgICogZmFpbHVyZSB0byBhIHNraXBwZWQgbG9jYWwgc3RhZ2UuIEFic2VudCB3aGVuIHRoZSBjYWxsZXIgcmVjb3JkZWQgbm9cbiAgICogb3V0cHV0IOKAlCB0aGUgY29tcGFyaXNvbiB0aGVuIGNhbm5vdCBhdHRyaWJ1dGUgdGhlIGZhaWx1cmUgYW5kIGZhbGxzIGJhY2tcbiAgICogdG8gdG9kYXkncyBiZWhhdmlvdXIuXG4gICAqL1xuICBvdXRwdXQ/OiBzdHJpbmc7XG59XG5cbi8qKiBQYXJzZWQgcXVhbGl0eSBnYXRlIG9wdGlvbnMuICovXG5leHBvcnQgaW50ZXJmYWNlIFF1YWxpdHlPcHRpb25zIHtcbiAgc3RyaWN0OiBib29sZWFuO1xuICBzZXF1ZW50aWFsOiBib29sZWFuO1xuICB2YWxpZGF0ZVByb21wdHM6IGJvb2xlYW47XG59XG5cbi8qKlxuICogUGFyc2UgcXVhbGl0eSBnYXRlIGNvbW1hbmQtbGluZSBhcmd1bWVudHMuXG4gKlxuICogUmVjb2duaXNlcyAtLXN0cmljdCwgLS1zZXF1ZW50aWFsLCBhbmQgLS12YWxpZGF0ZS1wcm9tcHRzIGZsYWdzLlxuICogQWxzbyByZXNwZWN0cyBRVUFMSVRZX1NUUklDVCwgUVVBTElUWV9TRVFVRU5USUFMLCBhbmRcbiAqIFFVQUxJVFlfVkFMSURBVEVfUFJPTVBUUyBlbnZpcm9ubWVudCB2YXJpYWJsZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVF1YWxpdHlBcmdzKGFyZ3M6IHN0cmluZ1tdKTogUXVhbGl0eU9wdGlvbnMge1xuICBjb25zdCBvcHRpb25zOiBRdWFsaXR5T3B0aW9ucyA9IHtcbiAgICBzdHJpY3Q6IGZhbHNlLFxuICAgIHNlcXVlbnRpYWw6IGZhbHNlLFxuICAgIHZhbGlkYXRlUHJvbXB0czogZmFsc2UsXG4gIH07XG5cbiAgZm9yIChjb25zdCBhcmcgb2YgYXJncykge1xuICAgIHN3aXRjaCAoYXJnKSB7XG4gICAgICBjYXNlIFwiLS1zdHJpY3RcIjpcbiAgICAgICAgb3B0aW9ucy5zdHJpY3QgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCItLXNlcXVlbnRpYWxcIjpcbiAgICAgICAgb3B0aW9ucy5zZXF1ZW50aWFsID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiLS12YWxpZGF0ZS1wcm9tcHRzXCI6XG4gICAgICAgIG9wdGlvbnMudmFsaWRhdGVQcm9tcHRzID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG9wdGlvbnM7XG59XG5cbi8qKlxuICogQXBwbHkgZW52aXJvbm1lbnQgdmFyaWFibGUgb3ZlcnJpZGVzIHRvIHF1YWxpdHkgb3B0aW9ucy5cbiAqXG4gKiBDaGVja3MgUVVBTElUWV9TVFJJQ1QsIFFVQUxJVFlfU0VRVUVOVElBTCwgYW5kIFFVQUxJVFlfVkFMSURBVEVfUFJPTVBUU1xuICogZW52aXJvbm1lbnQgdmFyaWFibGVzLiBFbnZpcm9ubWVudCB2YXJpYWJsZXMgb3ZlcnJpZGUgQ0xJIGZsYWdzIChzZXQgdG8gdHJ1ZSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBseUVudk92ZXJyaWRlcyhcbiAgb3B0aW9uczogUXVhbGl0eU9wdGlvbnMsXG4gIGVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPixcbik6IFF1YWxpdHlPcHRpb25zIHtcbiAgcmV0dXJuIHtcbiAgICBzdHJpY3Q6IG9wdGlvbnMuc3RyaWN0IHx8IGVudltcIlFVQUxJVFlfU1RSSUNUXCJdID09PSBcInRydWVcIixcbiAgICBzZXF1ZW50aWFsOiBvcHRpb25zLnNlcXVlbnRpYWwgfHwgZW52W1wiUVVBTElUWV9TRVFVRU5USUFMXCJdID09PSBcInRydWVcIixcbiAgICB2YWxpZGF0ZVByb21wdHM6IG9wdGlvbnMudmFsaWRhdGVQcm9tcHRzIHx8XG4gICAgICBlbnZbXCJRVUFMSVRZX1ZBTElEQVRFX1BST01QVFNcIl0gPT09IFwidHJ1ZVwiLFxuICB9O1xufVxuXG4vKipcbiAqIFJlY29yZCBvciB1cGRhdGUgYSBjaGVjayByZXN1bHQgaW4gdGhlIHJlc3VsdHMgYXJyYXkuXG4gKlxuICogSWYgYSBjaGVjayB3aXRoIHRoZSBzYW1lIG5hbWUgYWxyZWFkeSBleGlzdHMsIGl0cyBzdGF0dXMgaXMgdXBkYXRlZCBpbiBwbGFjZS5cbiAqIE90aGVyd2lzZSwgYSBuZXcgZW50cnkgaXMgYXBwZW5kZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWNvcmRDaGVjayhcbiAgcmVzdWx0czogQ2hlY2tSZXN1bHRbXSxcbiAgbmFtZTogc3RyaW5nLFxuICBzdGF0dXM6IENoZWNrU3RhdHVzLFxuICBvdXRwdXQ/OiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgY29uc3QgZXhpc3RpbmcgPSByZXN1bHRzLmZpbmQoKHIpID0+IHIubmFtZSA9PT0gbmFtZSk7XG4gIGlmIChleGlzdGluZykge1xuICAgIGV4aXN0aW5nLnN0YXR1cyA9IHN0YXR1cztcbiAgICAvLyBBbiBvbWl0dGVkIG91dHB1dCBsZWF2ZXMgd2hhdGV2ZXIgd2FzIHJlY29yZGVkIGJlZm9yZSwgc28gYSBjYWxsZXIgdGhhdFxuICAgIC8vIG9ubHkgdXBkYXRlcyBhIHN0YXR1cyBjYW5ub3Qgc2lsZW50bHkgZXJhc2UgdGhlIHJlY29yZGVkIG91dHB1dC5cbiAgICBpZiAob3V0cHV0ICE9PSB1bmRlZmluZWQpIGV4aXN0aW5nLm91dHB1dCA9IG91dHB1dDtcbiAgfSBlbHNlIHtcbiAgICByZXN1bHRzLnB1c2goeyBuYW1lLCBzdGF0dXMsIC4uLihvdXRwdXQgIT09IHVuZGVmaW5lZCA/IHsgb3V0cHV0IH0gOiB7fSkgfSk7XG4gIH1cbn1cblxuLyoqIFN1bW1hcnkgcmVzdWx0IGZyb20gZXZhbHVhdGluZyBjaGVjayBvdXRjb21lcy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3VtbWFyeVJlc3VsdCB7XG4gIC8qKiBGb3JtYXR0ZWQgc3VtbWFyeSB0YWJsZSB0ZXh0LiAqL1xuICB0ZXh0OiBzdHJpbmc7XG4gIC8qKiBXaGV0aGVyIGFsbCBjaGVja3MgcGFzc2VkIChjb25zaWRlcmluZyBzdHJpY3QgbW9kZSkuICovXG4gIHBhc3NlZDogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBGb3JtYXQgdGhlIHF1YWxpdHkgY2hlY2sgc3VtbWFyeSB0YWJsZS5cbiAqXG4gKiBSZXR1cm5zIGEgZm9ybWF0dGVkIHN1bW1hcnkgdGFibGUgYW5kIHdoZXRoZXIgdGhlIG92ZXJhbGwgcmVzdWx0IGlzIFBBU1NFRC5cbiAqIEluIHN0cmljdCBtb2RlLCBza2lwcGVkIGNoZWNrcyBjYXVzZSBmYWlsdXJlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0U3VtbWFyeShcbiAgcmVzdWx0czogQ2hlY2tSZXN1bHRbXSxcbiAgc3RyaWN0OiBib29sZWFuLFxuKTogU3VtbWFyeVJlc3VsdCB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKFwiPT09IFF1YWxpdHkgQ2hlY2sgU3VtbWFyeSA9PT1cIik7XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgbGV0IGhhc0ZhaWxlZCA9IGZhbHNlO1xuICBsZXQgaGFzU2tpcHBlZCA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgeyBuYW1lLCBzdGF0dXMgfSBvZiByZXN1bHRzKSB7XG4gICAgaWYgKHN0YXR1cyA9PT0gXCJGQUlMRURcIikgaGFzRmFpbGVkID0gdHJ1ZTtcbiAgICBpZiAoc3RhdHVzID09PSBcIlNLSVBQRURcIikgaGFzU2tpcHBlZCA9IHRydWU7XG4gICAgbGluZXMucHVzaChgICAke25hbWUucGFkRW5kKDMwKX0gJHtzdGF0dXN9YCk7XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIGlmIChoYXNGYWlsZWQpIHtcbiAgICBsaW5lcy5wdXNoKFwiUmVzdWx0OiBGQUlMRURcIik7XG4gICAgcmV0dXJuIHsgdGV4dDogbGluZXMuam9pbihcIlxcblwiKSwgcGFzc2VkOiBmYWxzZSB9O1xuICB9XG5cbiAgaWYgKGhhc1NraXBwZWQpIHtcbiAgICBpZiAoc3RyaWN0KSB7XG4gICAgICBsaW5lcy5wdXNoKFxuICAgICAgICBcIlJlc3VsdDogRkFJTEVEIChzdHJpY3QgbW9kZSBcXHUyMDE0IHNraXBwZWQgY2hlY2tzIGFyZSBub3QgYWxsb3dlZClcIixcbiAgICAgICk7XG4gICAgICByZXR1cm4geyB0ZXh0OiBsaW5lcy5qb2luKFwiXFxuXCIpLCBwYXNzZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGxpbmVzLnB1c2goXCJSZXN1bHQ6IFBBU1NFRCAod2l0aCBza2lwcGVkIGNoZWNrcylcIik7XG4gICAgcmV0dXJuIHsgdGV4dDogbGluZXMuam9pbihcIlxcblwiKSwgcGFzc2VkOiB0cnVlIH07XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiUmVzdWx0OiBQQVNTRURcIik7XG4gIHJldHVybiB7IHRleHQ6IGxpbmVzLmpvaW4oXCJcXG5cIiksIHBhc3NlZDogdHJ1ZSB9O1xufVxuXG4vKipcbiAqIFRoZSBydW5uaW5nIERlbm8gZXhlY3V0YWJsZSwgd2hlbiBpdCBpcyBvbmUuXG4gKlxuICogVGhpcyBwcm9jZXNzIElTIGRlbm8sIHNvIGl0cyBvd24gcGF0aCBpcyB0aGUgYXV0aG9yaXRhdGl2ZSBhbnN3ZXIgZm9yIHRoZVxuICogYGRlbm9gIHRvb2wg4oCUIG5vIFBBVEggbG9va3VwIGNhbiBiZSBtb3JlIGFjY3VyYXRlLCBhbmQgbm9uZSBjYW4gZmFpbC5cbiAqIGBEZW5vLmV4ZWNQYXRoKClgIHRocm93cyB3aXRob3V0IHJlYWQgcGVybWlzc2lvbiwgYW5kIGEgYGRlbm8gY29tcGlsZWBkXG4gKiBiaW5hcnkncyBwYXRoIGlzIG5vdCBhIGRlbm8gQ0xJLCBzbyBib3RoIGNhc2VzIGZhbGwgdGhyb3VnaCB0byB0aGUgcHJvYmVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcnVubmluZ0Rlbm9QYXRoKCk6IHN0cmluZyB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IHBhdGggPSBEZW5vLmV4ZWNQYXRoKCk7XG4gICAgY29uc3QgbmFtZSA9IHBhdGguc3BsaXQoL1svXFxcXF0vKS5wb3AoKSA/PyBcIlwiO1xuICAgIHJldHVybiBuYW1lID09PSBcImRlbm9cIiB8fCBuYW1lID09PSBcImRlbm8uZXhlXCIgPyBwYXRoIDogbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7IC8vIG5vIHJlYWQgcGVybWlzc2lvbiDigJQgZmFsbCB0aHJvdWdoIHRvIHRoZSBwcm9iZXNcbiAgfVxufVxuXG4vKipcbiAqIERldGVjdCB3aGV0aGVyIGEgdG9vbCBpcyBhdmFpbGFibGUgb24gdGhlIHN5c3RlbS5cbiAqXG4gKiBGb3IgYGRlbm9gLCB0aGUgcnVubmluZyBleGVjdXRhYmxlIGFuc3dlcnMgZmlyc3QgKFBSICM4ODggQ0kpOiBgd2hpY2hgIGlzXG4gKiBhbiB1bm5lY2Vzc2FyeSBzdWJwcm9jZXNzIHdob3NlIGZhaWx1cmUg4oCUIGEgUEFUSCBhIHRlc3QgbGVmdCByZXdyaXR0ZW4sIGFcbiAqIHNwYXduIHRoYXQgbG9zdCBhIGZvcmssIGFuIGltYWdlIHdpdGhvdXQgYHdoaWNoYCDigJQgc2lsZW50bHkgZGVtb3RlZCBldmVyeVxuICogRGVubyBjaGVjayBpbiB0aGUgZ2F0ZS4gQ0kgaW5zdGFsbHMgRGVubyBpbnRvIHRoZSBydW5uZXIgdG9vbCBjYWNoZSwgd2hpY2hcbiAqIG5vbmUgb2YgdGhlIGhhcmRjb2RlZCBmYWxsYmFja3MgYmVsb3cgY292ZXIsIHNvIHRoYXQgbG9va3VwIHdhcyB0aGUgb25seVxuICogdGhpbmcgc3RhbmRpbmcgYmV0d2VlbiB0aGUgZ2F0ZSBhbmQgZm91ciB1bmV4cGxhaW5lZCBGQUlMRUQgY2hlY2tzLlxuICpcbiAqIE90aGVyd2lzZSBjaGVja3MgdGhlIFBBVEggdmlhIGB3aGljaGAsIHRoZW4gY29tbW9uIGluc3RhbGwgbG9jYXRpb25zLlxuICogUmV0dXJucyB0aGUgcGF0aCB0byB0aGUgdG9vbCBpZiBmb3VuZCwgb3IgYW4gZXJyb3IgcmVzdWx0IGlmIG5vdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRldGVjdFRvb2woXG4gIHRvb2xOYW1lOiBzdHJpbmcsXG4gIGhvbWVEaXI/OiBzdHJpbmcsXG4gIHRpbWVvdXRNczogbnVtYmVyID0gVE9PTF9QUk9CRV9USU1FT1VUX01TLFxuKTogUHJvbWlzZTxSZXN1bHQ8c3RyaW5nPj4ge1xuICBpZiAodG9vbE5hbWUgPT09IFwiZGVub1wiKSB7XG4gICAgY29uc3QgcnVubmluZyA9IHJ1bm5pbmdEZW5vUGF0aCgpO1xuICAgIGlmIChydW5uaW5nKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHJ1bm5pbmcgfTtcbiAgfVxuXG4gIC8vIENoZWNrIFBBVEggdmlhIHdoaWNoXG4gIHRyeSB7XG4gICAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgY29tbWFuZE91dHB1dFdpdGhUaW1lb3V0KFwid2hpY2hcIiwge1xuICAgICAgYXJnczogW3Rvb2xOYW1lXSxcbiAgICAgIHN0ZG91dDogXCJwaXBlZFwiLFxuICAgICAgc3RkZXJyOiBcIm51bGxcIixcbiAgICAgIHRpbWVvdXRNcyxcbiAgICB9KTtcbiAgICBpZiAob3V0cHV0LnN1Y2Nlc3MpIHtcbiAgICAgIGNvbnN0IHBhdGggPSBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUob3V0cHV0LnN0ZG91dCkudHJpbSgpO1xuICAgICAgaWYgKHBhdGgpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBwYXRoIH07XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChpc0NvbW1hbmRUaW1lb3V0RXJyb3IoZXJyb3IpKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yXG4gICAgICAgICAgPyBlcnJvclxuICAgICAgICAgIDogbmV3IEVycm9yKGB3aGljaCB0aW1lZCBvdXQgYWZ0ZXIgJHt0aW1lb3V0TXN9bXNgKSxcbiAgICAgIH07XG4gICAgfVxuICAgIC8vIHdoaWNoIG5vdCBhdmFpbGFibGUsIGZhbGwgdGhyb3VnaCB0byBtYW51YWwgc2VhcmNoXG4gIH1cblxuICAvLyBDaGVjayBjb21tb24gbG9jYXRpb25zIGJhc2VkIG9uIHRvb2wgbmFtZVxuICBjb25zdCBzZWFyY2hQYXRoczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgaG9tZSA9IGhvbWVEaXIgPz8gRGVuby5lbnYuZ2V0KFwiSE9NRVwiKSA/PyBcIlwiO1xuXG4gIHN3aXRjaCAodG9vbE5hbWUpIHtcbiAgICBjYXNlIFwiZGVub1wiOlxuICAgICAgc2VhcmNoUGF0aHMucHVzaChcbiAgICAgICAgYCR7aG9tZX0vLmRlbm8vYmluL2Rlbm9gLFxuICAgICAgICBcIi9vcHQvaG9tZWJyZXcvYmluL2Rlbm9cIixcbiAgICAgICAgXCIvdXNyL2xvY2FsL2Jpbi9kZW5vXCIsXG4gICAgICApO1xuICAgICAgYnJlYWs7XG4gIH1cblxuICBmb3IgKGNvbnN0IHBhdGggb2Ygc2VhcmNoUGF0aHMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3RhdCA9IGF3YWl0IERlbm8uc3RhdChwYXRoKTtcbiAgICAgIGlmIChzdGF0LmlzRmlsZSkge1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHBhdGggfTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFBhdGggZG9lcyBub3QgZXhpc3QsIGNvbnRpbnVlXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogbmV3IEVycm9yKGBUb29sIG5vdCBmb3VuZDogJHt0b29sTmFtZX1gKSB9O1xufVxuXG4vKipcbiAqIEZvcm1hdCBhIHF1YWxpdHkgY2hlY2sgZmFpbHVyZSBtZXNzYWdlIGZvciBHaXRIdWIgY29tbWVudHMuXG4gKlxuICogU2hvd3MgdGhlIGxhc3QgMzAgbGluZXMgcHJvbWluZW50bHksIHdpdGggdGhlIGZ1bGwgb3V0cHV0ICh0cnVuY2F0ZWRcbiAqIHRvIDIwMCBsaW5lcykgaW4gYSBjb2xsYXBzZWQgZGV0YWlscyBibG9jay4gT3B0aW9uYWxseSBpbmNsdWRlc1xuICogYmFzZWxpbmUgY29udGV4dCB3aGVuIHRoZSBiYXNlbGluZSB3YXMgYWxyZWFkeSBmYWlsaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0UXVhbGl0eUZhaWx1cmVNZXNzYWdlKFxuICBxdWFsaXR5T3V0cHV0OiBzdHJpbmcsXG4gIGJhc2VsaW5lUGFzc2VkPzogYm9vbGVhbixcbiAgYmFzZWxpbmVPdXRwdXQ/OiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICBjb25zdCBtYXhGdWxsTGluZXMgPSAyMDA7XG4gIGNvbnN0IHRhaWxMaW5lcyA9IDMwO1xuXG4gIGNvbnN0IGhlYWRlciA9XG4gICAgYFF1YWxpdHkgY2hlY2tzIChcXGAuL3F1YWxpdHkuc2hcXGApIGZhaWxlZCBhbmQgY291bGQgbm90IGJlIGZpeGVkIGF1dG9tYXRpY2FsbHkuXG5cblRoZSBQUiB3YXMgbm90IGNyZWF0ZWQgYmVjYXVzZSBsb2NhbCBxdWFsaXR5IGNoZWNrcyBtdXN0IHBhc3MgYmVmb3JlIHJhaXNpbmcgYSBQUi5gO1xuXG4gIGNvbnN0IGZvb3RlciA9XG4gICAgXCJUaGUgaXNzdWUgd2lsbCBiZSByZXRyaWVkIG9uIHRoZSBuZXh0IHNjYW4uIENsYXVkZSB3aWxsIGF0dGVtcHQgdG8gZml4IHRoZSBxdWFsaXR5IGlzc3Vlcy5cIjtcblxuICBpZiAoIXF1YWxpdHlPdXRwdXQpIHtcbiAgICByZXR1cm4gYCR7aGVhZGVyfVxcblxcbiR7Zm9vdGVyfWA7XG4gIH1cblxuICAvLyBSZWRhY3QgdGhlIHdob2xlIG91dHB1dCBiZWZvcmUgZWl0aGVyIGN1dCAoSXNzdWUgIzEyNTcpOiBgLi9xdWFsaXR5LnNoYFxuICAvLyBlY2hvZXMgd2hhdGV2ZXIgYSBmYWlsaW5nIGNoZWNrIHByaW50ZWQg4oCUIGEgdG9rZW5pc2VkIHJlbW90ZSBVUkwsIGFuXG4gIC8vIGBleHBvcnQgKl9UT0tFTj1gIGxpbmUg4oCUIGFuZCB0aGlzIG1lc3NhZ2UgaXMgcG9zdGVkIGFzIGEgcHVibGljIGNvbW1lbnQuXG4gIC8vIEN1dHRpbmcgZmlyc3Qgd291bGQgc3BsaXQgYSBjcmVkZW50aWFsIGludG8gYSBmcmFnbWVudCBubyBydWxlIG1hdGNoZXMuXG4gIGNvbnN0IHJlZGFjdGVkT3V0cHV0ID0gcmVkYWN0U2VjcmV0cyhxdWFsaXR5T3V0cHV0KTtcbiAgY29uc3Qgb3V0cHV0TGluZXMgPSByZWRhY3RlZE91dHB1dC5zcGxpdChcIlxcblwiKTtcbiAgY29uc3QgdG90YWxMaW5lcyA9IG91dHB1dExpbmVzLmxlbmd0aDtcblxuICAvLyBFeHRyYWN0IHRoZSBsYXN0IE4gbGluZXMgZm9yIHRoZSBwcm9taW5lbnQgc2VjdGlvblxuICBjb25zdCB0YWlsT3V0cHV0ID0gdG90YWxMaW5lcyA8PSB0YWlsTGluZXNcbiAgICA/IHJlZGFjdGVkT3V0cHV0XG4gICAgOiBvdXRwdXRMaW5lcy5zbGljZSgtdGFpbExpbmVzKS5qb2luKFwiXFxuXCIpO1xuXG4gIC8vIEJ1aWxkIHRoZSBmdWxsIG91dHB1dCBmb3IgdGhlIGRldGFpbHMgYmxvY2ssIHRydW5jYXRlZCBpZiBuZWVkZWRcbiAgbGV0IGZ1bGxPdXRwdXQ6IHN0cmluZztcbiAgbGV0IHRydW5jYXRpb25Ob3RpY2UgPSBcIlwiO1xuICBpZiAodG90YWxMaW5lcyA+IG1heEZ1bGxMaW5lcykge1xuICAgIGZ1bGxPdXRwdXQgPSBvdXRwdXRMaW5lcy5zbGljZSgtbWF4RnVsbExpbmVzKS5qb2luKFwiXFxuXCIpO1xuICAgIGNvbnN0IGxpbmVzVHJ1bmNhdGVkID0gdG90YWxMaW5lcyAtIG1heEZ1bGxMaW5lcztcbiAgICB0cnVuY2F0aW9uTm90aWNlID1cbiAgICAgIGAoJHtsaW5lc1RydW5jYXRlZH0gbGluZXMgdHJ1bmNhdGVkIFxcdTIwMTQgc2hvd2luZyBsYXN0ICR7bWF4RnVsbExpbmVzfSBvZiAke3RvdGFsTGluZXN9IGxpbmVzKWA7XG4gIH0gZWxzZSB7XG4gICAgZnVsbE91dHB1dCA9IHJlZGFjdGVkT3V0cHV0O1xuICB9XG5cbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIHBhcnRzLnB1c2goaGVhZGVyKTtcbiAgcGFydHMucHVzaChcIlwiKTtcbiAgcGFydHMucHVzaChcIiMjIyBRdWFsaXR5IENoZWNrIE91dHB1dFwiKTtcbiAgcGFydHMucHVzaChcImBgYFwiKTtcbiAgcGFydHMucHVzaCh0YWlsT3V0cHV0KTtcbiAgcGFydHMucHVzaChcImBgYFwiKTtcbiAgcGFydHMucHVzaChcIlwiKTtcbiAgcGFydHMucHVzaChcIjxkZXRhaWxzPlwiKTtcbiAgcGFydHMucHVzaChcIjxzdW1tYXJ5PkZ1bGwgcXVhbGl0eSBjaGVjayBvdXRwdXQgKGNsaWNrIHRvIGV4cGFuZCk8L3N1bW1hcnk+XCIpO1xuICBwYXJ0cy5wdXNoKFwiXCIpO1xuICBpZiAodHJ1bmNhdGlvbk5vdGljZSkge1xuICAgIHBhcnRzLnB1c2goYF8ke3RydW5jYXRpb25Ob3RpY2V9X2ApO1xuICAgIHBhcnRzLnB1c2goXCJcIik7XG4gIH1cbiAgcGFydHMucHVzaChcImBgYFwiKTtcbiAgcGFydHMucHVzaChmdWxsT3V0cHV0KTtcbiAgcGFydHMucHVzaChcImBgYFwiKTtcbiAgcGFydHMucHVzaChcIlwiKTtcbiAgcGFydHMucHVzaChcIjwvZGV0YWlscz5cIik7XG4gIHBhcnRzLnB1c2goXCJcIik7XG4gIHBhcnRzLnB1c2goZm9vdGVyKTtcblxuICAvLyBBcHBlbmQgYmFzZWxpbmUgY29udGV4dCBpZiBiYXNlbGluZSB3YXMgYWxyZWFkeSBmYWlsaW5nXG4gIGlmIChiYXNlbGluZVBhc3NlZCA9PT0gZmFsc2UgJiYgYmFzZWxpbmVPdXRwdXQpIHtcbiAgICBjb25zdCBiYXNlbGluZU5vdGUgPSBmb3JtYXRCYXNlbGluZVF1YWxpdHlOb3RlKGJhc2VsaW5lT3V0cHV0KTtcbiAgICBpZiAoYmFzZWxpbmVOb3RlKSB7XG4gICAgICBwYXJ0cy5wdXNoKFwiXCIpO1xuICAgICAgcGFydHMucHVzaChiYXNlbGluZU5vdGUpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBwYXJ0cy5qb2luKFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIEZvcm1hdCBhIG5vdGUgZGlzdGluZ3Vpc2hpbmcgXCJvbmx5IHByZS1leGlzdGluZyBmYWlsdXJlc1wiIGZyb20gXCJuZXdcbiAqIGZhaWx1cmVzIGludHJvZHVjZWRcIiBpbiB0aGUgcG9zdC1DbGF1ZGUgcXVhbGl0eSBydW4gKElzc3VlICMxNTQ5KS5cbiAqXG4gKiBVc2VkIGJ5IHRoZSBiYXNlbGluZS1hd2FyZSBxdWFsaXR5IGdhdGUg4oCUIHdoZW4gdGhlIGdhdGUgdWx0aW1hdGVseVxuICogZmFpbHMgQU5EIHRoZSBiYXNlbGluZS1hd2FyZSBkZWNpc2lvbiBpZGVudGlmaWVkIGF0IGxlYXN0IG9uZVxuICogcHJlLWV4aXN0aW5nIGZpbmRpbmcsIHRoaXMgbm90ZSB0ZWxscyByZXZpZXdlcnMgaG93IG1hbnkgb2YgdGhlXG4gKiByZW1haW5pbmcgZmluZGluZ3MgY2FycmllZCBvdmVyIGZyb20gdGhlIGJhc2VsaW5lIHNvIHRoZXkgY2FuIGZvY3VzXG4gKiBvbiB0aGUgZ2VudWluZWx5IG5ldyBvbmVzLlxuICpcbiAqIFJldHVybnMgYW4gZW1wdHkgc3RyaW5nIHdoZW4gdGhlcmUgd2VyZSBubyBwcmUtZXhpc3RpbmcgZmluZGluZ3MgKHRoZVxuICogbGVnYWN5IFwiYWxsLW5ld1wiIHBhdGgpIHNvIHRoZSBmYWlsdXJlIG1lc3NhZ2Ugc3RheXMgdW5jaGFuZ2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0QmFzZWxpbmVDYXJyeW92ZXJOb3RlKHByZUV4aXN0aW5nQ291bnQ6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmIChwcmVFeGlzdGluZ0NvdW50IDw9IDApIHJldHVybiBcIlwiO1xuICBjb25zdCBub3VuID0gcHJlRXhpc3RpbmdDb3VudCA9PT0gMSA/IFwiZmluZGluZyB3YXNcIiA6IFwiZmluZGluZ3Mgd2VyZVwiO1xuICByZXR1cm4gYD4gKipCYXNlbGluZSBjYXJyeW92ZXI6KiogJHtwcmVFeGlzdGluZ0NvdW50fSBwcmUtZXhpc3RpbmcgYCArXG4gICAgYCR7bm91bn0gcHJlc2VudCBvbiB0aGUgZGVmYXVsdCBicmFuY2ggYmVmb3JlIHRoaXMgY2hhbmdlLiBUaGUgcmVtYWluaW5nIGAgK1xuICAgIGBmYWlsdXJlKHMpIGFyZSBORVcgZmluZGluZ3MgaW50cm9kdWNlZCBieSB0aGUgY2hhbmdlIOKAlCBmb2N1cyB0aGUgZml4IG9uIHRob3NlLmA7XG59XG5cbi8qKlxuICogRm9ybWF0IGEgbm90ZSBhYm91dCBwcmUtZXhpc3RpbmcgcXVhbGl0eSBmYWlsdXJlcy5cbiAqXG4gKiBXaGVuIHRoZSBiYXNlbGluZSBxdWFsaXR5IGNoZWNrIGRldGVjdGVkIGZhaWx1cmVzIGJlZm9yZSB0aGUgd29ya2VyIHN0YXJ0ZWQsXG4gKiB0aGlzIGZvcm1hdHMgYSBtYXJrZG93biBub3RlIHRvIGluY2x1ZGUgaW4gZmFpbHVyZSBjb21tZW50cy5cbiAqIFJldHVybnMgZW1wdHkgc3RyaW5nIGlmIGJhc2VsaW5lIG91dHB1dCBpcyBlbXB0eSAoYmFzZWxpbmUgcGFzc2VkIG9yIG5vdCBydW4pLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0QmFzZWxpbmVRdWFsaXR5Tm90ZShiYXNlbGluZU91dHB1dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFiYXNlbGluZU91dHB1dCkge1xuICAgIHJldHVybiBcIlwiO1xuICB9XG5cbiAgY29uc3QgbWF4TGluZXMgPSA1MDtcbiAgLy8gUmVkYWN0ZWQgd2hvbGUsIHRoZW4gY3V0IChJc3N1ZSAjMTI1Nykg4oCUIHRoaXMgbm90ZSBpcyBxdW90ZWQgaW50byBhIHB1YmxpY1xuICAvLyBmYWlsdXJlIGNvbW1lbnQuXG4gIGNvbnN0IHJlZGFjdGVkT3V0cHV0ID0gcmVkYWN0U2VjcmV0cyhiYXNlbGluZU91dHB1dCk7XG4gIGNvbnN0IG91dHB1dExpbmVzID0gcmVkYWN0ZWRPdXRwdXQuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IHRvdGFsTGluZXMgPSBvdXRwdXRMaW5lcy5sZW5ndGg7XG5cbiAgbGV0IGRpc3BsYXlPdXRwdXQ6IHN0cmluZztcbiAgaWYgKHRvdGFsTGluZXMgPiBtYXhMaW5lcykge1xuICAgIGRpc3BsYXlPdXRwdXQgPSBgKHNob3dpbmcgbGFzdCAke21heExpbmVzfSBvZiAke3RvdGFsTGluZXN9IGxpbmVzKVxcbiR7XG4gICAgICBvdXRwdXRMaW5lcy5zbGljZSgtbWF4TGluZXMpLmpvaW4oXCJcXG5cIilcbiAgICB9YDtcbiAgfSBlbHNlIHtcbiAgICBkaXNwbGF5T3V0cHV0ID0gcmVkYWN0ZWRPdXRwdXQ7XG4gIH1cblxuICByZXR1cm4gYD4gKipOb3RlOioqIFF1YWxpdHkgY2hlY2tzIHdlcmUgYWxyZWFkeSBmYWlsaW5nIG9uIHRoZSBjbGVhbiByZXBvc2l0b3J5IGJlZm9yZSB0aGUgd29ya2VyIHN0YXJ0ZWQuIFRoZSBmb2xsb3dpbmcgcHJlLWV4aXN0aW5nIGZhaWx1cmVzIHdlcmUgZGV0ZWN0ZWQ6XFxuPlxcblxcYFxcYFxcYFxcbiR7ZGlzcGxheU91dHB1dH1cXG5cXGBcXGBcXGBgO1xufVxuXG4vKipcbiAqIFdvcmQtZGVsaW1pdGVkIHRva2VucyBpbiBhIHNoZWxsIHNjcmlwdCwgdGhlIHNoYXBlIGEgdG9vbCBuYW1lIGFwcGVhcnMgaW46XG4gKiBwcmVjZWRlZCBieSBzdGFydC1vZi1saW5lLCB3aGl0ZXNwYWNlLCBgL2Agb3IgYFwiYCwgYW5kIGZvbGxvd2VkIGJ5XG4gKiB3aGl0ZXNwYWNlLCBhIHF1b3RlIG9yIGVuZC1vZi1saW5lIOKAlCBzbyBgLm5wbXJjYCBhbmQgYGRlbm8ubG9ja2AgYXJlIHNpbmdsZVxuICogdG9rZW5zIHJhdGhlciB0aGFuIHJlZmVyZW5jZXMgdG8gYG5wbWAgYW5kIGBkZW5vYC5cbiAqXG4gKiBPbmUgbGl0ZXJhbCBwYXR0ZXJuIGZvciBldmVyeSB0b29sLCByYXRoZXIgdGhhbiBgbmV3IFJlZ0V4cCh0b29sKWAgcGVyIG5hbWU6XG4gKiBhIHJlZ2V4IGJ1aWx0IGZyb20gYW4gaW50ZXJwb2xhdGVkIHZhbHVlIGlzIGEgc2VtZ3JlcFxuICogYGRldGVjdC1ub24tbGl0ZXJhbC1yZWdleHBgIGZpbmRpbmcsIGFuZCB0aGUgc2FtZSBydWxlIGJsb2NrcyB0aGUgUFIgaW5cbiAqIGAuZ2l0aHViL3dvcmtmbG93cy9zZW1ncmVwLnltbGAuXG4gKi9cbmNvbnN0IFRPT0xfV09SRF9QQVRURVJOID0gLyg/Ol58W1xccy9cIl0pKFtcXHcuLV0rKSg/PVtcXHNcIiddfCQpL2dtO1xuXG4vKiogVGhlIHNldCBvZiB3b3JkLWRlbGltaXRlZCB0b2tlbnMgYSBxdWFsaXR5IHNjcmlwdCBtZW50aW9ucy4gKi9cbmZ1bmN0aW9uIHJlZmVyZW5jZWRUb29sV29yZHMoc2NyaXB0Q29udGVudDogc3RyaW5nKTogU2V0PHN0cmluZz4ge1xuICBjb25zdCB3b3JkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIHNjcmlwdENvbnRlbnQubWF0Y2hBbGwoVE9PTF9XT1JEX1BBVFRFUk4pKSB7XG4gICAgY29uc3Qgd29yZCA9IG1hdGNoWzFdO1xuICAgIGlmICh3b3JkKSB3b3Jkcy5hZGQod29yZCk7XG4gIH1cbiAgcmV0dXJuIHdvcmRzO1xufVxuXG4vKipcbiAqIERldGVjdCBtaXNzaW5nIHF1YWxpdHkgdG9vbHMgYnkgc2Nhbm5pbmcgYSBxdWFsaXR5IHNjcmlwdC5cbiAqXG4gKiBTY2FucyB0aGUgcXVhbGl0eSBzY3JpcHQgZm9yIHJlZmVyZW5jZXMgdG8gY29tbW9uIHRvb2xzIChucG0sIG5vZGUsIHlhcm4sXG4gKiBwbnBtLCBkZW5vLCBldGMuKSBhbmQgdmVyaWZpZXMgdGhleSBhcmUgYXZhaWxhYmxlIGluIHRoZSBjdXJyZW50IFBBVEguXG4gKlxuICogUmV0dXJucyBhIGxpc3Qgb2YgbWlzc2luZyB0b29sIG5hbWVzLCBvciBhbiBlbXB0eSBhcnJheSBpZiBhbGwgZm91bmQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkZXRlY3RNaXNzaW5nUXVhbGl0eVRvb2xzKFxuICBxdWFsaXR5U2NyaXB0OiBzdHJpbmcsXG4pOiBQcm9taXNlPFJlc3VsdDxzdHJpbmdbXT4+IHtcbiAgY29uc3QgdG9vbHNUb0NoZWNrID0gW1xuICAgIFwibnBtXCIsXG4gICAgXCJub2RlXCIsXG4gICAgXCJ5YXJuXCIsXG4gICAgXCJwbnBtXCIsXG4gICAgXCJucHhcIixcbiAgICBcImRlbm9cIixcbiAgICBcImJ1blwiLFxuICBdO1xuXG4gIGxldCBzY3JpcHRDb250ZW50OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgc2NyaXB0Q29udGVudCA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKHF1YWxpdHlTY3JpcHQpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IFtdIH07XG4gIH1cblxuICBjb25zdCBtaXNzaW5nVG9vbHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHJlZmVyZW5jZWQgPSByZWZlcmVuY2VkVG9vbFdvcmRzKHNjcmlwdENvbnRlbnQpO1xuXG4gIGZvciAoY29uc3QgdG9vbCBvZiB0b29sc1RvQ2hlY2spIHtcbiAgICBpZiAocmVmZXJlbmNlZC5oYXModG9vbCkpIHtcbiAgICAgIGNvbnN0IGZvdW5kID0gYXdhaXQgZGV0ZWN0VG9vbCh0b29sKTtcbiAgICAgIGlmICghZm91bmQub2spIHtcbiAgICAgICAgbWlzc2luZ1Rvb2xzLnB1c2godG9vbCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBtaXNzaW5nVG9vbHMgfTtcbn1cblxuLyoqXG4gKiBGb3JtYXQgYSBjbGVhciBmYWlsdXJlIG1lc3NhZ2UgZm9yIG1pc3NpbmcgdG9vbHMuXG4gKlxuICogQ3JlYXRlcyBhIG1hcmtkb3duLWZvcm1hdHRlZCBtZXNzYWdlIGV4cGxhaW5pbmcgd2hpY2ggdG9vbHMgYXJlIG1pc3NpbmdcbiAqIGZyb20gdGhlIHdvcmtlciBlbnZpcm9ubWVudCBhbmQgd2hhdCB0aGUgZGV2ZWxvcGVyIHNob3VsZCBkbyBhYm91dCBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdE1pc3NpbmdUb29sc01lc3NhZ2UoXG4gIG1pc3NpbmdUb29sczogc3RyaW5nW10sXG4gIHF1YWxpdHlTY3JpcHQ6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHRvb2xMaXN0ID0gbWlzc2luZ1Rvb2xzLm1hcCgodCkgPT4gYC0gXFxgJHt0fVxcYGApLmpvaW4oXCJcXG5cIik7XG5cbiAgcmV0dXJuIGAqKkNhbm5vdCBydW4gcXVhbGl0eSBjaGVja3MgXFx1MjAxNCByZXF1aXJlZCB0b29scyBhcmUgbm90IGF2YWlsYWJsZSBpbiB0aGUgd29ya2VyIGVudmlyb25tZW50LioqXG5cblRoZSBmb2xsb3dpbmcgdG9vbChzKSByZWZlcmVuY2VkIGluIFxcYCR7cXVhbGl0eVNjcmlwdH1cXGAgYXJlIG5vdCBpbnN0YWxsZWQgb3Igbm90IGluIFBBVEg6XG5cbiR7dG9vbExpc3R9XG5cbioqV2h5IHRoaXMgYmxvY2tzIHRoZSBpc3N1ZToqKiBUaGUgcXVhbGl0eSBnYXRlIChcXGAuL3F1YWxpdHkuc2hcXGApIGNhbm5vdCBleGVjdXRlIGJlY2F1c2UgdGhlc2UgdG9vbHMgYXJlIG1pc3NpbmcgZnJvbSB0aGUgdW5hdHRlbmRlZCB3b3JrZXIgbWFjaGluZS4gQ2xhdWRlIGNhbm5vdCBpbnN0YWxsIHN5c3RlbS1sZXZlbCB0b29scywgc28gdGhpcyBtdXN0IGJlIGZpeGVkIGJ5IGEgZGV2ZWxvcGVyLlxuXG4qKkhvdyB0byBmaXg6KipcbjEuIENvbmZpZ3VyZSBhIFxcYGRvY2tlcl9pbWFnZVxcYCBmb3IgdGhpcyByZXBvc2l0b3J5IGluIFxcYC5jb25maWcuanNvblxcYCBzbyBxdWFsaXR5IGNoZWNrcyBydW4gaW5zaWRlIGEgY29udGFpbmVyIHdpdGggdGhlIHJpZ2h0IHRvb2xzLCBlLmcuOlxuICAgXFxgXFxgXFxganNvblxuICAgXCJyZXBvX2NvbmZpZ1wiOiB7XG4gICAgIFwib3JnL3JlcG9cIjoge1xuICAgICAgIFwiZG9ja2VyX2ltYWdlXCI6IFwibm9kZToyMFwiXG4gICAgIH1cbiAgIH1cbiAgIFxcYFxcYFxcYFxuICAgQ29tbW9uIGltYWdlczogXFxgbm9kZToyMFxcYCwgXFxgbm9kZToyMlxcYCwgXFxgZGVub2xhbmQvZGVubzpsYXRlc3RcXGAsIFxcYGVjbGlwc2UtdGVtdXJpbjoyMVxcYCwgXFxgcnVzdDpsYXRlc3RcXGBcbjIuIFVwZGF0ZSBcXGAke3F1YWxpdHlTY3JpcHR9XFxgIHRvIHNraXAgY2hlY2tzIHRoYXQgcmVxdWlyZSB1bmF2YWlsYWJsZSB0b29scyAoZS5nLiwgZ2F0ZSB0aGVtIGJlaGluZCBcXGBjb21tYW5kIC12XFxgIGNoZWNrcyksICoqb3IqKlxuMy4gSW5zdGFsbCB0aGUgbWlzc2luZyB0b29sKHMpIG9uIHRoZSB3b3JrZXIgbWFjaGluZSBkaXJlY3RseVxuXG5UaGlzIGlzIGFuICoqZW52aXJvbm1lbnQgaXNzdWUqKiwgbm90IGEgY29kZSBpc3N1ZSBcXHUyMDE0IHJldHJ5aW5nIHdpbGwgcHJvZHVjZSB0aGUgc2FtZSByZXN1bHQgdW50aWwgdGhlIGVudmlyb25tZW50IGlzIGZpeGVkLmA7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7OztDQWVDLEdBR0QsU0FBUyxhQUFhLFFBQVEsd0JBQXdCO0FBQ3RELFNBQ0Usd0JBQXdCLEVBQ3hCLHFCQUFxQixRQUNoQiwwQkFBMEI7QUFFakMsK0VBQStFLEdBQy9FLE1BQU0sd0JBQXdCO0FBRTlCOzs7OztDQUtDLEdBQ0QsT0FBTyxNQUFNLDBCQUEwQixJQUFJO0FBQzNDLE9BQU8sTUFBTSwwQkFBMEIsSUFBSTtBQTRCM0M7Ozs7OztDQU1DLEdBQ0QsT0FBTyxTQUFTLGlCQUFpQixJQUFjO0VBQzdDLE1BQU0sVUFBMEI7SUFDOUIsUUFBUTtJQUNSLFlBQVk7SUFDWixpQkFBaUI7RUFDbkI7RUFFQSxLQUFLLE1BQU0sT0FBTyxLQUFNO0lBQ3RCLE9BQVE7TUFDTixLQUFLO1FBQ0gsUUFBUSxNQUFNLEdBQUc7UUFDakI7TUFDRixLQUFLO1FBQ0gsUUFBUSxVQUFVLEdBQUc7UUFDckI7TUFDRixLQUFLO1FBQ0gsUUFBUSxlQUFlLEdBQUc7UUFDMUI7SUFDSjtFQUNGO0VBRUEsT0FBTztBQUNUO0FBRUE7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVMsa0JBQ2QsT0FBdUIsRUFDdkIsR0FBdUM7RUFFdkMsT0FBTztJQUNMLFFBQVEsUUFBUSxNQUFNLElBQUksR0FBRyxDQUFDLGlCQUFpQixLQUFLO0lBQ3BELFlBQVksUUFBUSxVQUFVLElBQUksR0FBRyxDQUFDLHFCQUFxQixLQUFLO0lBQ2hFLGlCQUFpQixRQUFRLGVBQWUsSUFDdEMsR0FBRyxDQUFDLDJCQUEyQixLQUFLO0VBQ3hDO0FBQ0Y7QUFFQTs7Ozs7Q0FLQyxHQUNELE9BQU8sU0FBUyxZQUNkLE9BQXNCLEVBQ3RCLElBQVksRUFDWixNQUFtQixFQUNuQixNQUFlO0VBRWYsTUFBTSxXQUFXLFFBQVEsSUFBSSxDQUFDLENBQUMsSUFBTSxFQUFFLElBQUksS0FBSztFQUNoRCxJQUFJLFVBQVU7SUFDWixTQUFTLE1BQU0sR0FBRztJQUNsQiwwRUFBMEU7SUFDMUUsbUVBQW1FO0lBQ25FLElBQUksV0FBVyxXQUFXLFNBQVMsTUFBTSxHQUFHO0VBQzlDLE9BQU87SUFDTCxRQUFRLElBQUksQ0FBQztNQUFFO01BQU07TUFBUSxHQUFJLFdBQVcsWUFBWTtRQUFFO01BQU8sSUFBSSxDQUFDLENBQUM7SUFBRTtFQUMzRTtBQUNGO0FBVUE7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVMsY0FDZCxPQUFzQixFQUN0QixNQUFlO0VBRWYsTUFBTSxRQUFrQixFQUFFO0VBQzFCLE1BQU0sSUFBSSxDQUFDO0VBQ1gsTUFBTSxJQUFJLENBQUM7RUFDWCxNQUFNLElBQUksQ0FBQztFQUVYLElBQUksWUFBWTtFQUNoQixJQUFJLGFBQWE7RUFFakIsS0FBSyxNQUFNLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxJQUFJLFFBQVM7SUFDdEMsSUFBSSxXQUFXLFVBQVUsWUFBWTtJQUNyQyxJQUFJLFdBQVcsV0FBVyxhQUFhO0lBQ3ZDLE1BQU0sSUFBSSxDQUFDLENBQUMsRUFBRSxFQUFFLEtBQUssTUFBTSxDQUFDLElBQUksQ0FBQyxFQUFFLFFBQVE7RUFDN0M7RUFFQSxNQUFNLElBQUksQ0FBQztFQUVYLElBQUksV0FBVztJQUNiLE1BQU0sSUFBSSxDQUFDO0lBQ1gsT0FBTztNQUFFLE1BQU0sTUFBTSxJQUFJLENBQUM7TUFBTyxRQUFRO0lBQU07RUFDakQ7RUFFQSxJQUFJLFlBQVk7SUFDZCxJQUFJLFFBQVE7TUFDVixNQUFNLElBQUksQ0FDUjtNQUVGLE9BQU87UUFBRSxNQUFNLE1BQU0sSUFBSSxDQUFDO1FBQU8sUUFBUTtNQUFNO0lBQ2pEO0lBQ0EsTUFBTSxJQUFJLENBQUM7SUFDWCxPQUFPO01BQUUsTUFBTSxNQUFNLElBQUksQ0FBQztNQUFPLFFBQVE7SUFBSztFQUNoRDtFQUVBLE1BQU0sSUFBSSxDQUFDO0VBQ1gsT0FBTztJQUFFLE1BQU0sTUFBTSxJQUFJLENBQUM7SUFBTyxRQUFRO0VBQUs7QUFDaEQ7QUFFQTs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxTQUFTO0VBQ2QsSUFBSTtJQUNGLE1BQU0sT0FBTyxLQUFLLFFBQVE7SUFDMUIsTUFBTSxPQUFPLEtBQUssS0FBSyxDQUFDLFNBQVMsR0FBRyxNQUFNO0lBQzFDLE9BQU8sU0FBUyxVQUFVLFNBQVMsYUFBYSxPQUFPO0VBQ3pELEVBQUUsT0FBTTtJQUNOLE9BQU8sTUFBTSxrREFBa0Q7RUFDakU7QUFDRjtBQUVBOzs7Ozs7Ozs7Ozs7Q0FZQyxHQUNELE9BQU8sZUFBZSxXQUNwQixRQUFnQixFQUNoQixPQUFnQixFQUNoQixZQUFvQixxQkFBcUI7RUFFekMsSUFBSSxhQUFhLFFBQVE7SUFDdkIsTUFBTSxVQUFVO0lBQ2hCLElBQUksU0FBUyxPQUFPO01BQUUsSUFBSTtNQUFNLE9BQU87SUFBUTtFQUNqRDtFQUVBLHVCQUF1QjtFQUN2QixJQUFJO0lBQ0YsTUFBTSxTQUFTLE1BQU0seUJBQXlCLFNBQVM7TUFDckQsTUFBTTtRQUFDO09BQVM7TUFDaEIsUUFBUTtNQUNSLFFBQVE7TUFDUjtJQUNGO0lBQ0EsSUFBSSxPQUFPLE9BQU8sRUFBRTtNQUNsQixNQUFNLE9BQU8sSUFBSSxjQUFjLE1BQU0sQ0FBQyxPQUFPLE1BQU0sRUFBRSxJQUFJO01BQ3pELElBQUksTUFBTTtRQUNSLE9BQU87VUFBRSxJQUFJO1VBQU0sT0FBTztRQUFLO01BQ2pDO0lBQ0Y7RUFDRixFQUFFLE9BQU8sT0FBTztJQUNkLElBQUksc0JBQXNCLFFBQVE7TUFDaEMsT0FBTztRQUNMLElBQUk7UUFDSixPQUFPLGlCQUFpQixRQUNwQixRQUNBLElBQUksTUFBTSxDQUFDLHNCQUFzQixFQUFFLFVBQVUsRUFBRSxDQUFDO01BQ3REO0lBQ0Y7RUFDQSxxREFBcUQ7RUFDdkQ7RUFFQSw0Q0FBNEM7RUFDNUMsTUFBTSxjQUF3QixFQUFFO0VBQ2hDLE1BQU0sT0FBTyxXQUFXLEtBQUssR0FBRyxDQUFDLEdBQUcsQ0FBQyxXQUFXO0VBRWhELE9BQVE7SUFDTixLQUFLO01BQ0gsWUFBWSxJQUFJLENBQ2QsR0FBRyxLQUFLLGVBQWUsQ0FBQyxFQUN4QiwwQkFDQTtNQUVGO0VBQ0o7RUFFQSxLQUFLLE1BQU0sUUFBUSxZQUFhO0lBQzlCLElBQUk7TUFDRixNQUFNLE9BQU8sTUFBTSxLQUFLLElBQUksQ0FBQztNQUM3QixJQUFJLEtBQUssTUFBTSxFQUFFO1FBQ2YsT0FBTztVQUFFLElBQUk7VUFBTSxPQUFPO1FBQUs7TUFDakM7SUFDRixFQUFFLE9BQU07SUFDTixnQ0FBZ0M7SUFDbEM7RUFDRjtFQUVBLE9BQU87SUFBRSxJQUFJO0lBQU8sT0FBTyxJQUFJLE1BQU0sQ0FBQyxnQkFBZ0IsRUFBRSxVQUFVO0VBQUU7QUFDdEU7QUFFQTs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMsNEJBQ2QsYUFBcUIsRUFDckIsY0FBd0IsRUFDeEIsY0FBdUI7RUFFdkIsTUFBTSxlQUFlO0VBQ3JCLE1BQU0sWUFBWTtFQUVsQixNQUFNLFNBQ0osQ0FBQzs7a0ZBRTZFLENBQUM7RUFFakYsTUFBTSxTQUNKO0VBRUYsSUFBSSxDQUFDLGVBQWU7SUFDbEIsT0FBTyxHQUFHLE9BQU8sSUFBSSxFQUFFLFFBQVE7RUFDakM7RUFFQSwwRUFBMEU7RUFDMUUsdUVBQXVFO0VBQ3ZFLDJFQUEyRTtFQUMzRSwwRUFBMEU7RUFDMUUsTUFBTSxpQkFBaUIsY0FBYztFQUNyQyxNQUFNLGNBQWMsZUFBZSxLQUFLLENBQUM7RUFDekMsTUFBTSxhQUFhLFlBQVksTUFBTTtFQUVyQyxxREFBcUQ7RUFDckQsTUFBTSxhQUFhLGNBQWMsWUFDN0IsaUJBQ0EsWUFBWSxLQUFLLENBQUMsQ0FBQyxXQUFXLElBQUksQ0FBQztFQUV2QyxtRUFBbUU7RUFDbkUsSUFBSTtFQUNKLElBQUksbUJBQW1CO0VBQ3ZCLElBQUksYUFBYSxjQUFjO0lBQzdCLGFBQWEsWUFBWSxLQUFLLENBQUMsQ0FBQyxjQUFjLElBQUksQ0FBQztJQUNuRCxNQUFNLGlCQUFpQixhQUFhO0lBQ3BDLG1CQUNFLENBQUMsQ0FBQyxFQUFFLGVBQWUscUNBQXFDLEVBQUUsYUFBYSxJQUFJLEVBQUUsV0FBVyxPQUFPLENBQUM7RUFDcEcsT0FBTztJQUNMLGFBQWE7RUFDZjtFQUVBLE1BQU0sUUFBa0IsRUFBRTtFQUMxQixNQUFNLElBQUksQ0FBQztFQUNYLE1BQU0sSUFBSSxDQUFDO0VBQ1gsTUFBTSxJQUFJLENBQUM7RUFDWCxNQUFNLElBQUksQ0FBQztFQUNYLE1BQU0sSUFBSSxDQUFDO0VBQ1gsTUFBTSxJQUFJLENBQUM7RUFDWCxNQUFNLElBQUksQ0FBQztFQUNYLE1BQU0sSUFBSSxDQUFDO0VBQ1gsTUFBTSxJQUFJLENBQUM7RUFDWCxNQUFNLElBQUksQ0FBQztFQUNYLElBQUksa0JBQWtCO0lBQ3BCLE1BQU0sSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLGlCQUFpQixDQUFDLENBQUM7SUFDbEMsTUFBTSxJQUFJLENBQUM7RUFDYjtFQUNBLE1BQU0sSUFBSSxDQUFDO0VBQ1gsTUFBTSxJQUFJLENBQUM7RUFDWCxNQUFNLElBQUksQ0FBQztFQUNYLE1BQU0sSUFBSSxDQUFDO0VBQ1gsTUFBTSxJQUFJLENBQUM7RUFDWCxNQUFNLElBQUksQ0FBQztFQUNYLE1BQU0sSUFBSSxDQUFDO0VBRVgsMERBQTBEO0VBQzFELElBQUksbUJBQW1CLFNBQVMsZ0JBQWdCO0lBQzlDLE1BQU0sZUFBZSwwQkFBMEI7SUFDL0MsSUFBSSxjQUFjO01BQ2hCLE1BQU0sSUFBSSxDQUFDO01BQ1gsTUFBTSxJQUFJLENBQUM7SUFDYjtFQUNGO0VBRUEsT0FBTyxNQUFNLElBQUksQ0FBQztBQUNwQjtBQUVBOzs7Ozs7Ozs7Ozs7Q0FZQyxHQUNELE9BQU8sU0FBUyw0QkFBNEIsZ0JBQXdCO0VBQ2xFLElBQUksb0JBQW9CLEdBQUcsT0FBTztFQUNsQyxNQUFNLE9BQU8scUJBQXFCLElBQUksZ0JBQWdCO0VBQ3RELE9BQU8sQ0FBQywwQkFBMEIsRUFBRSxpQkFBaUIsY0FBYyxDQUFDLEdBQ2xFLEdBQUcsS0FBSyxpRUFBaUUsQ0FBQyxHQUMxRSxDQUFDLDhFQUE4RSxDQUFDO0FBQ3BGO0FBRUE7Ozs7OztDQU1DLEdBQ0QsT0FBTyxTQUFTLDBCQUEwQixjQUFzQjtFQUM5RCxJQUFJLENBQUMsZ0JBQWdCO0lBQ25CLE9BQU87RUFDVDtFQUVBLE1BQU0sV0FBVztFQUNqQiw2RUFBNkU7RUFDN0UsbUJBQW1CO0VBQ25CLE1BQU0saUJBQWlCLGNBQWM7RUFDckMsTUFBTSxjQUFjLGVBQWUsS0FBSyxDQUFDO0VBQ3pDLE1BQU0sYUFBYSxZQUFZLE1BQU07RUFFckMsSUFBSTtFQUNKLElBQUksYUFBYSxVQUFVO0lBQ3pCLGdCQUFnQixDQUFDLGNBQWMsRUFBRSxTQUFTLElBQUksRUFBRSxXQUFXLFNBQVMsRUFDbEUsWUFBWSxLQUFLLENBQUMsQ0FBQyxVQUFVLElBQUksQ0FBQyxPQUNsQztFQUNKLE9BQU87SUFDTCxnQkFBZ0I7RUFDbEI7RUFFQSxPQUFPLENBQUMsa0tBQWtLLEVBQUUsY0FBYyxRQUFRLENBQUM7QUFDck07QUFFQTs7Ozs7Ozs7OztDQVVDLEdBQ0QsTUFBTSxvQkFBb0I7QUFFMUIsZ0VBQWdFLEdBQ2hFLFNBQVMsb0JBQW9CLGFBQXFCO0VBQ2hELE1BQU0sUUFBUSxJQUFJO0VBQ2xCLEtBQUssTUFBTSxTQUFTLGNBQWMsUUFBUSxDQUFDLG1CQUFvQjtJQUM3RCxNQUFNLE9BQU8sS0FBSyxDQUFDLEVBQUU7SUFDckIsSUFBSSxNQUFNLE1BQU0sR0FBRyxDQUFDO0VBQ3RCO0VBQ0EsT0FBTztBQUNUO0FBRUE7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sZUFBZSwwQkFDcEIsYUFBcUI7RUFFckIsTUFBTSxlQUFlO0lBQ25CO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0dBQ0Q7RUFFRCxJQUFJO0VBQ0osSUFBSTtJQUNGLGdCQUFnQixNQUFNLEtBQUssWUFBWSxDQUFDO0VBQzFDLEVBQUUsT0FBTTtJQUNOLE9BQU87TUFBRSxJQUFJO01BQU0sT0FBTyxFQUFFO0lBQUM7RUFDL0I7RUFFQSxNQUFNLGVBQXlCLEVBQUU7RUFDakMsTUFBTSxhQUFhLG9CQUFvQjtFQUV2QyxLQUFLLE1BQU0sUUFBUSxhQUFjO0lBQy9CLElBQUksV0FBVyxHQUFHLENBQUMsT0FBTztNQUN4QixNQUFNLFFBQVEsTUFBTSxXQUFXO01BQy9CLElBQUksQ0FBQyxNQUFNLEVBQUUsRUFBRTtRQUNiLGFBQWEsSUFBSSxDQUFDO01BQ3BCO0lBQ0Y7RUFDRjtFQUVBLE9BQU87SUFBRSxJQUFJO0lBQU0sT0FBTztFQUFhO0FBQ3pDO0FBRUE7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVMsMEJBQ2QsWUFBc0IsRUFDdEIsYUFBcUI7RUFFckIsTUFBTSxXQUFXLGFBQWEsR0FBRyxDQUFDLENBQUMsSUFBTSxDQUFDLElBQUksRUFBRSxFQUFFLEVBQUUsQ0FBQyxFQUFFLElBQUksQ0FBQztFQUU1RCxPQUFPLENBQUM7O3NDQUU0QixFQUFFLGNBQWM7O0FBRXRELEVBQUUsU0FBUzs7Ozs7Ozs7Ozs7Ozs7WUFjQyxFQUFFLGNBQWM7OzsrSEFHbUcsQ0FBQztBQUNoSSJ9
// denoCacheMetadata=12456295217238386694,8699636370207980363