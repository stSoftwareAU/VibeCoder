/**
 * Suggest improvements command for the Vibe Coder worker.
 *
 * Generates actionable improvement suggestions for the Vibe Coder project
 * and optionally creates GitHub issues for each suggestion using the gh CLI.
 *
 * Issue #192 — Initial suggest improvements command.
 * Issue #209 — Updated with prompt and workflow improvement suggestions.
 * Issue #1531 — Refreshed suggestions to reflect the post-Deno-migration
 * codebase. Stale references to retired shell modules and already-completed
 * work (log levels, quality.sh status table, prompt version traceability)
 * were removed.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  createGitHubIssuesWithPartialFailures,
  type CreateIssuesResult,
} from "../lib/github.ts";
import { validateSuggestImprovementsArgs } from "../lib/command_args.ts";

/**
 * Represents a single improvement suggestion.
 */
export interface Improvement {
  /** Short, descriptive title for the improvement */
  title: string;
  /** Detailed description of the problem and proposed solution */
  description: string;
  /** Category of the improvement */
  category:
    | "observability"
    | "resilience"
    | "testing"
    | "developer-experience"
    | "security"
    | "maintainability";
  /** GitHub labels to apply to the issue */
  labels: string[];
}

/**
 * Generate a curated list of improvement suggestions.
 *
 * These suggestions are based on analysis of the Vibe Coder codebase,
 * identifying genuine gaps and opportunities.
 *
 * @returns Array of improvement suggestions
 */
export function generateImprovements(): Improvement[] {
  return [
    {
      title: "Expand PR feedback prompt template to match issue template depth",
      description:
        "`prompts/pr_feedback/prompt.md` is noticeably shallower than " +
        "`prompts/issue/prompt.md`. It omits the worked example, " +
        "acceptance-criteria re-check step, and error-recovery guidance that the " +
        "issue template carries.\n\n" +
        "### Proposed Solution\n" +
        "Edit `prompts/pr_feedback/prompt.md` in place to add:\n" +
        "- A concrete before/after example of applying review feedback\n" +
        "- An explicit step to re-verify the original acceptance criteria after " +
        "reworking for feedback\n" +
        "- Error-recovery guidance when feedback-driven changes break tests\n" +
        "- Self-verification checkpoint consistent with the issue template",
      category: "maintainability",
      labels: ["enhancement"],
    },
    {
      title: "Add runtime schema validation for gh CLI JSON output",
      description:
        "Across `worker/deno/` there are ~44 `JSON.parse(...) as SomeType` casts " +
        "(e.g., `lib/issue_query.ts`, `lib/milestone_health.ts`, `lib/github.ts`). " +
        "These provide no runtime guarantee: a gh CLI response with a missing or " +
        "null field crashes deep inside the worker rather than failing with a " +
        "clear error at the parse boundary.\n\n" +
        "### Proposed Solution\n" +
        "Introduce a small type-guard helper (or adopt `@std/jsonc`-style " +
        "validation) that each gh-wrapping module uses in place of the unchecked " +
        "cast, returning a `Result<T, ValidationError>` with the offending field " +
        "name on failure.",
      category: "resilience",
      labels: ["enhancement"],
    },
    {
      title: "Reduce unsafe type assertions in issue_worker_wiring.ts",
      description:
        "`worker/deno/lib/issue_worker_wiring.ts` contains ~84 `as unknown as X` " +
        "casts — by far the highest concentration in the codebase. Each cast " +
        "silently bypasses the type checker, so a change in a wired dependency's " +
        "signature will not surface until runtime.\n\n" +
        "### Proposed Solution\n" +
        "Replace the double-casts with explicit adapter functions or typed " +
        "interfaces for each dependency. Where an adapter is genuinely needed, " +
        "extract it so the cast is isolated and documented rather than scattered.",
      category: "maintainability",
      labels: ["enhancement"],
    },
    {
      title: "Split run_core_production_deps.ts into focused modules",
      description:
        "`worker/deno/lib/run_core_production_deps.ts` is ~1307 lines — the " +
        "largest file in the repo — and wires every production dependency (git, " +
        "GitHub, Claude, filesystem, etc.) in a single module. This conflicts with " +
        "the Single-Responsibility principle documented in AGENTS.md.\n\n" +
        "### Proposed Solution\n" +
        "Split by concern into (for example) `run_core_deps_git.ts`, " +
        "`run_core_deps_github.ts`, `run_core_deps_claude.ts`, and compose them " +
        "in a thin top-level `run_core_production_deps.ts`.",
      category: "maintainability",
      labels: ["enhancement"],
    },
    {
      title: "Split issue_worker.ts into per-phase modules",
      description:
        "`worker/deno/lib/issue_worker.ts` is ~1291 lines and contains the full " +
        "orchestration for clone → prompt build → Claude execution → timeout " +
        "handling → PR creation. Each phase is independently testable but is " +
        "currently stitched together in one file.\n\n" +
        "### Proposed Solution\n" +
        "Extract each phase into its own module under `worker/deno/lib/phases/` " +
        "(e.g., `phases/build_prompt.ts`, `phases/run_claude.ts`, " +
        "`phases/finalise_pr.ts`). Keep `issue_worker.ts` as a thin orchestrator.",
      category: "maintainability",
      labels: ["enhancement"],
    },
    {
      title:
        "Add dedicated tests for Deno modules that currently lack direct coverage",
      description:
        "Several modules in `worker/deno/lib/` and `worker/deno/commands/` do not " +
        "have a matching `tests/<name>_test.ts` file — examples include " +
        "`lib/atomic_write.ts`, `lib/label_cache.ts`, `lib/pr_manager.ts`, " +
        "`lib/stuck_detection.ts`, `commands/find_issues.ts`, and " +
        "`commands/git_operations.ts`. They may be exercised transitively, but " +
        "direct tests are missing.\n\n" +
        "### Proposed Solution\n" +
        "Audit `worker/deno/{lib,commands}/*.ts` against `worker/deno/tests/` and " +
        "add focused unit tests for each module that has no corresponding " +
        "`_test.ts`. Prioritise modules with exported decision-making logic.",
      category: "testing",
      labels: ["enhancement"],
    },
    {
      title: "Persist the prompts commit to a per-run audit log",
      description:
        "`recordPromptCommit()` exists in `worker/deno/lib/prompt_manager.ts` " +
        "and is wired to the `prompt-manager` command, but the execute phase " +
        'only logs the resolved commit via `logger.info("Using prompts from ' +
        'commit", ...)` in `worker/deno/lib/phases/execute_phase.ts` (Issue ' +
        "#1190, #844). There is no durable audit trail tying a specific issue " +
        "run to the exact prompt text used.\n\n" +
        "### Proposed Solution\n" +
        "Call `recordPromptCommit()` from the execute phase after resolving " +
        "the commit, writing to a per-repo log (e.g., `logs/prompt-commits.log`). " +
        "Include the issue number so a completed PR can be traced back to the " +
        "exact prompt text that produced it.",
      category: "observability",
      labels: ["enhancement"],
    },
  ];
}

/**
 * Format an improvement suggestion as a GitHub issue body in markdown.
 *
 * @param improvement - The improvement to format
 * @returns Formatted markdown body for the GitHub issue
 */
export function formatImprovementAsIssueBody(improvement: Improvement): string {
  return [
    "## Description",
    "",
    improvement.description,
    "",
    "## Category",
    "",
    improvement.category,
    "",
    "---",
    "*This suggestion was generated by the `suggest-improvements` command (Issue #209).*",
  ].join("\n");
}

/** Typed data returned by the suggest-improvements command (Issue #223). */
export interface SuggestImprovementsData {
  improvements: Improvement[];
  repo: string | null;
  createdIssues?: CreateIssuesResult["createdIssues"];
  failures?: CreateIssuesResult["failures"];
}

/**
 * Suggest improvements command implementation.
 */
export const suggestImprovementsCommand: Command = {
  name: "suggest-improvements",
  description:
    "Generate and optionally create GitHub issues for improvement suggestions",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<SuggestImprovementsData>> {
    // Validate args using typed schema (Issue #630)
    const parsed = validateSuggestImprovementsArgs(args);
    if (!parsed.ok) {
      return {
        success: false,
        message: parsed.error.message,
      };
    }

    const { dryRun, repo } = parsed.value;
    const improvements = generateImprovements();

    if (dryRun || !repo) {
      const count = improvements.length;
      return {
        success: true,
        message: `Generated ${count} improvement suggestion${
          count === 1 ? "" : "s"
        } (dry-run)`,
        data: {
          improvements,
          repo: repo ?? null,
        },
      };
    }

    const result = await createGitHubIssuesWithPartialFailures(
      improvements,
      repo,
    );

    const successMsg =
      `Created ${result.createdIssues.length} improvement issue${
        result.createdIssues.length === 1 ? "" : "s"
      } in ${repo}`;
    const failureMsg = result.failures.length > 0
      ? ` (${result.failures.length} failed)`
      : "";

    return {
      success: result.failures.length === 0,
      message: successMsg + failureMsg,
      data: {
        improvements,
        createdIssues: result.createdIssues,
        failures: result.failures,
        repo,
      },
    };
  },
};
