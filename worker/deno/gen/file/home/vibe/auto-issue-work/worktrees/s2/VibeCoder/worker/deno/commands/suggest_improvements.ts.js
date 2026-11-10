/**
 * Suggest improvements command for the Vibe Coder worker.
 *
 * Generates actionable improvement suggestions for the Vibe Coder project
 * and optionally creates GitHub issues for each suggestion using the gh CLI.
 * Issues are filed through the issue router (`fileRoutedIssue`, Issue #3745),
 * so each lands in the repository that owns it. `--dry-run` with `--repo`
 * runs the router's read-only steps and reports what it would do.
 *
 * Issue #192 — Initial suggest improvements command.
 * Issue #209 — Updated with prompt and workflow improvement suggestions.
 * Issue #1531 — Refreshed suggestions to reflect the post-Deno-migration
 * codebase. Stale references to retired shell modules and already-completed
 * work (log levels, quality.sh status table, prompt version traceability)
 * were removed.
 */ import { createGitHubIssuesWithPartialFailures } from "../lib/github.ts";
import { validateSuggestImprovementsArgs } from "../lib/command_args.ts";
import { customLabelPromptLabels } from "../lib/custom_label_prompts_config.ts";
import { plural } from "../lib/codebase_map.ts";
/**
 * Generate a curated list of improvement suggestions.
 *
 * These suggestions are based on analysis of the Vibe Coder codebase,
 * identifying genuine gaps and opportunities.
 *
 * @returns Array of improvement suggestions
 */ export function generateImprovements() {
  return [
    {
      title: "Expand PR feedback prompt template to match issue template depth",
      description: "`prompts/pr_feedback/prompt.md` is noticeably shallower than " + "`prompts/issue/prompt.md`. It omits the worked example, " + "acceptance-criteria re-check step, and error-recovery guidance that the " + "issue template carries.\n\n" + "### Proposed Solution\n" + "Edit `prompts/pr_feedback/prompt.md` in place to add:\n" + "- A concrete before/after example of applying review feedback\n" + "- An explicit step to re-verify the original acceptance criteria after " + "reworking for feedback\n" + "- Error-recovery guidance when feedback-driven changes break tests\n" + "- Self-verification checkpoint consistent with the issue template",
      category: "maintainability",
      labels: [
        "enhancement"
      ]
    },
    {
      title: "Add runtime schema validation for gh CLI JSON output",
      description: "Across `worker/deno/` there are ~44 `JSON.parse(...) as SomeType` casts " + "(e.g., `lib/issue_query.ts`, `lib/milestone_health.ts`, `lib/github.ts`). " + "These provide no runtime guarantee: a gh CLI response with a missing or " + "null field crashes deep inside the worker rather than failing with a " + "clear error at the parse boundary.\n\n" + "### Proposed Solution\n" + "Introduce a small type-guard helper (or adopt `@std/jsonc`-style " + "validation) that each gh-wrapping module uses in place of the unchecked " + "cast, returning a `Result<T, ValidationError>` with the offending field " + "name on failure.",
      category: "resilience",
      labels: [
        "enhancement"
      ]
    },
    {
      title: "Reduce unsafe type assertions in issue_worker_wiring.ts",
      description: "`worker/deno/lib/issue_worker_wiring.ts` contains ~84 `as unknown as X` " + "casts — by far the highest concentration in the codebase. Each cast " + "silently bypasses the type checker, so a change in a wired dependency's " + "signature will not surface until runtime.\n\n" + "### Proposed Solution\n" + "Replace the double-casts with explicit adapter functions or typed " + "interfaces for each dependency. Where an adapter is genuinely needed, " + "extract it so the cast is isolated and documented rather than scattered.",
      category: "maintainability",
      labels: [
        "enhancement"
      ]
    },
    {
      title: "Split run_core_production_deps.ts into focused modules",
      description: "`worker/deno/lib/run_core_production_deps.ts` is ~1307 lines — the " + "largest file in the repo — and wires every production dependency (git, " + "GitHub, Claude, filesystem, etc.) in a single module. This conflicts with " + "the Single-Responsibility principle documented in AGENTS.md.\n\n" + "### Proposed Solution\n" + "Split by concern into (for example) `run_core_deps_git.ts`, " + "`run_core_deps_github.ts`, `run_core_deps_claude.ts`, and compose them " + "in a thin top-level `run_core_production_deps.ts`.",
      category: "maintainability",
      labels: [
        "enhancement"
      ]
    },
    {
      title: "Split issue_worker.ts into per-phase modules",
      description: "`worker/deno/lib/issue_worker.ts` is ~1291 lines and contains the full " + "orchestration for clone → prompt build → Claude execution → timeout " + "handling → PR creation. Each phase is independently testable but is " + "currently stitched together in one file.\n\n" + "### Proposed Solution\n" + "Extract each phase into its own module under `worker/deno/lib/phases/` " + "(e.g., `phases/build_prompt.ts`, `phases/run_claude.ts`, " + "`phases/finalise_pr.ts`). Keep `issue_worker.ts` as a thin orchestrator.",
      category: "maintainability",
      labels: [
        "enhancement"
      ]
    },
    {
      title: "Add dedicated tests for Deno modules that currently lack direct coverage",
      description: "Several modules in `worker/deno/lib/` and `worker/deno/commands/` do not " + "have a matching `tests/<name>_test.ts` file — examples include " + "`lib/atomic_write.ts`, `lib/label_cache.ts`, `lib/pr_manager.ts`, " + "`lib/stuck_detection.ts`, `commands/find_issues.ts`, and " + "`commands/git_operations.ts`. They may be exercised transitively, but " + "direct tests are missing.\n\n" + "### Proposed Solution\n" + "Audit `worker/deno/{lib,commands}/*.ts` against `worker/deno/tests/` and " + "add focused unit tests for each module that has no corresponding " + "`_test.ts`. Prioritise modules with exported decision-making logic.",
      category: "testing",
      labels: [
        "enhancement"
      ]
    },
    {
      title: "Persist the prompts commit to a per-run audit log",
      description: "`recordPromptCommit()` exists in `worker/deno/lib/prompt_manager.ts` " + "and is wired to the `prompt-manager` command, but the execute phase " + 'only logs the resolved commit via `logger.info("Using prompts from ' + 'commit", ...)` in `worker/deno/lib/phases/execute_phase.ts` (Issue ' + "#1190, #844). There is no durable audit trail tying a specific issue " + "run to the exact prompt text used.\n\n" + "### Proposed Solution\n" + "Call `recordPromptCommit()` from the execute phase after resolving " + "the commit, writing to a per-repo log (e.g., `logs/prompt-commits.log`). " + "Include the issue number so a completed PR can be traced back to the " + "exact prompt text that produced it.",
      category: "observability",
      labels: [
        "enhancement"
      ]
    }
  ];
}
/**
 * Format an improvement suggestion as a GitHub issue body in markdown.
 *
 * @param improvement - The improvement to format
 * @returns Formatted markdown body for the GitHub issue
 */ export function formatImprovementAsIssueBody(improvement) {
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
    "*This suggestion was generated by the `suggest-improvements` command (Issue #209).*"
  ].join("\n");
}
/** The worker's own repository; worker improvements route here (Issue #3745). */ const WORKER_REPO = "stSoftwareAU/VibeCoder";
/**
 * Build the suggest-improvements command with the given dependencies.
 */ export function createSuggestImprovementsCommand(deps = {}) {
  return {
    name: "suggest-improvements",
    description: "Generate and optionally create GitHub issues for improvement suggestions",
    async execute (args, config) {
      // Validate args using typed schema (Issue #630)
      const parsed = validateSuggestImprovementsArgs(args);
      if (!parsed.ok) {
        return {
          success: false,
          message: parsed.error.message
        };
      }
      const { dryRun, repo } = parsed.value;
      const improvements = generateImprovements();
      if (!repo) {
        const count = improvements.length;
        return {
          success: true,
          message: `Generated ${count} improvement suggestion${count === 1 ? "" : "s"} (dry-run)`,
          data: {
            improvements,
            repo: repo ?? null
          }
        };
      }
      const result = await createGitHubIssuesWithPartialFailures(improvements, repo, {
        routingContext: {
          vibeCoderRepo: WORKER_REPO,
          productRepos: config.repos
        },
        dryRun,
        // Issue #847: a configured custom label dispatches a privileged phase,
        // so the worker must never self-apply one on an issue it files.
        extraReservedLabels: customLabelPromptLabels(config),
        ghCommandFn: deps.ghCommandFn,
        now: deps.now,
        ...deps.dedupAuthors ? {
          dedupAuthors: deps.dedupAuthors
        } : {}
      });
      const count = (action)=>result.routed.filter((r)=>r.action === action).length;
      const created = result.createdIssues.length;
      const reused = count("reused");
      const summary = dryRun ? `Dry run: ${plural(count("would-create"), "improvement issue")} would be created and ${plural(count("would-reuse"), "existing issue")} reused, routed from ${repo}` : `Created ${plural(created, "improvement issue")} and reused ${plural(reused, "existing issue")}, routed from ${repo}`;
      // A same-titled match that is not owned and open suppresses the filing.
      const suppressed = count("suppressed");
      const suppressedMsg = suppressed > 0 ? `; ${plural(suppressed, "improvement")} not filed, because a same-titled issue or PR exists that is not reused` : "";
      const failureMsg = result.failures.length > 0 ? ` (${result.failures.length} failed)` : "";
      return {
        success: result.failures.length === 0,
        message: summary + suppressedMsg + failureMsg,
        data: {
          improvements,
          createdIssues: result.createdIssues,
          failures: result.failures,
          routed: result.routed,
          repo
        }
      };
    }
  };
}
/**
 * Suggest improvements command implementation.
 */ export const suggestImprovementsCommand = createSuggestImprovementsCommand();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2NvbW1hbmRzL3N1Z2dlc3RfaW1wcm92ZW1lbnRzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU3VnZ2VzdCBpbXByb3ZlbWVudHMgY29tbWFuZCBmb3IgdGhlIFZpYmUgQ29kZXIgd29ya2VyLlxuICpcbiAqIEdlbmVyYXRlcyBhY3Rpb25hYmxlIGltcHJvdmVtZW50IHN1Z2dlc3Rpb25zIGZvciB0aGUgVmliZSBDb2RlciBwcm9qZWN0XG4gKiBhbmQgb3B0aW9uYWxseSBjcmVhdGVzIEdpdEh1YiBpc3N1ZXMgZm9yIGVhY2ggc3VnZ2VzdGlvbiB1c2luZyB0aGUgZ2ggQ0xJLlxuICogSXNzdWVzIGFyZSBmaWxlZCB0aHJvdWdoIHRoZSBpc3N1ZSByb3V0ZXIgKGBmaWxlUm91dGVkSXNzdWVgLCBJc3N1ZSAjMzc0NSksXG4gKiBzbyBlYWNoIGxhbmRzIGluIHRoZSByZXBvc2l0b3J5IHRoYXQgb3ducyBpdC4gYC0tZHJ5LXJ1bmAgd2l0aCBgLS1yZXBvYFxuICogcnVucyB0aGUgcm91dGVyJ3MgcmVhZC1vbmx5IHN0ZXBzIGFuZCByZXBvcnRzIHdoYXQgaXQgd291bGQgZG8uXG4gKlxuICogSXNzdWUgIzE5MiDigJQgSW5pdGlhbCBzdWdnZXN0IGltcHJvdmVtZW50cyBjb21tYW5kLlxuICogSXNzdWUgIzIwOSDigJQgVXBkYXRlZCB3aXRoIHByb21wdCBhbmQgd29ya2Zsb3cgaW1wcm92ZW1lbnQgc3VnZ2VzdGlvbnMuXG4gKiBJc3N1ZSAjMTUzMSDigJQgUmVmcmVzaGVkIHN1Z2dlc3Rpb25zIHRvIHJlZmxlY3QgdGhlIHBvc3QtRGVuby1taWdyYXRpb25cbiAqIGNvZGViYXNlLiBTdGFsZSByZWZlcmVuY2VzIHRvIHJldGlyZWQgc2hlbGwgbW9kdWxlcyBhbmQgYWxyZWFkeS1jb21wbGV0ZWRcbiAqIHdvcmsgKGxvZyBsZXZlbHMsIHF1YWxpdHkuc2ggc3RhdHVzIHRhYmxlLCBwcm9tcHQgdmVyc2lvbiB0cmFjZWFiaWxpdHkpXG4gKiB3ZXJlIHJlbW92ZWQuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBDb21tYW5kLCBDb21tYW5kUmVzdWx0LCBXb3JrZXJDb25maWcgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7XG4gIGNyZWF0ZUdpdEh1Yklzc3Vlc1dpdGhQYXJ0aWFsRmFpbHVyZXMsXG4gIHR5cGUgQ3JlYXRlSXNzdWVzUmVzdWx0LFxuICB0eXBlIFJvdXRlZEltcHJvdmVtZW50LFxufSBmcm9tIFwiLi4vbGliL2dpdGh1Yi50c1wiO1xuaW1wb3J0IHR5cGUgeyBBbGVydERlZHVwQXV0aG9yT3B0aW9ucyB9IGZyb20gXCIuLi9saWIvYWxlcnRfZGVkdXBfYXV0aG9ycy50c1wiO1xuaW1wb3J0IHsgdmFsaWRhdGVTdWdnZXN0SW1wcm92ZW1lbnRzQXJncyB9IGZyb20gXCIuLi9saWIvY29tbWFuZF9hcmdzLnRzXCI7XG5pbXBvcnQgeyBjdXN0b21MYWJlbFByb21wdExhYmVscyB9IGZyb20gXCIuLi9saWIvY3VzdG9tX2xhYmVsX3Byb21wdHNfY29uZmlnLnRzXCI7XG5pbXBvcnQgeyBwbHVyYWwgfSBmcm9tIFwiLi4vbGliL2NvZGViYXNlX21hcC50c1wiO1xuXG4vKipcbiAqIFJlcHJlc2VudHMgYSBzaW5nbGUgaW1wcm92ZW1lbnQgc3VnZ2VzdGlvbi5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBJbXByb3ZlbWVudCB7XG4gIC8qKiBTaG9ydCwgZGVzY3JpcHRpdmUgdGl0bGUgZm9yIHRoZSBpbXByb3ZlbWVudCAqL1xuICB0aXRsZTogc3RyaW5nO1xuICAvKiogRGV0YWlsZWQgZGVzY3JpcHRpb24gb2YgdGhlIHByb2JsZW0gYW5kIHByb3Bvc2VkIHNvbHV0aW9uICovXG4gIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIC8qKiBDYXRlZ29yeSBvZiB0aGUgaW1wcm92ZW1lbnQgKi9cbiAgY2F0ZWdvcnk6XG4gICAgfCBcIm9ic2VydmFiaWxpdHlcIlxuICAgIHwgXCJyZXNpbGllbmNlXCJcbiAgICB8IFwidGVzdGluZ1wiXG4gICAgfCBcImRldmVsb3Blci1leHBlcmllbmNlXCJcbiAgICB8IFwic2VjdXJpdHlcIlxuICAgIHwgXCJtYWludGFpbmFiaWxpdHlcIjtcbiAgLyoqIEdpdEh1YiBsYWJlbHMgdG8gYXBwbHkgdG8gdGhlIGlzc3VlICovXG4gIGxhYmVsczogc3RyaW5nW107XG59XG5cbi8qKlxuICogR2VuZXJhdGUgYSBjdXJhdGVkIGxpc3Qgb2YgaW1wcm92ZW1lbnQgc3VnZ2VzdGlvbnMuXG4gKlxuICogVGhlc2Ugc3VnZ2VzdGlvbnMgYXJlIGJhc2VkIG9uIGFuYWx5c2lzIG9mIHRoZSBWaWJlIENvZGVyIGNvZGViYXNlLFxuICogaWRlbnRpZnlpbmcgZ2VudWluZSBnYXBzIGFuZCBvcHBvcnR1bml0aWVzLlxuICpcbiAqIEByZXR1cm5zIEFycmF5IG9mIGltcHJvdmVtZW50IHN1Z2dlc3Rpb25zXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZW5lcmF0ZUltcHJvdmVtZW50cygpOiBJbXByb3ZlbWVudFtdIHtcbiAgcmV0dXJuIFtcbiAgICB7XG4gICAgICB0aXRsZTogXCJFeHBhbmQgUFIgZmVlZGJhY2sgcHJvbXB0IHRlbXBsYXRlIHRvIG1hdGNoIGlzc3VlIHRlbXBsYXRlIGRlcHRoXCIsXG4gICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgXCJgcHJvbXB0cy9wcl9mZWVkYmFjay9wcm9tcHQubWRgIGlzIG5vdGljZWFibHkgc2hhbGxvd2VyIHRoYW4gXCIgK1xuICAgICAgICBcImBwcm9tcHRzL2lzc3VlL3Byb21wdC5tZGAuIEl0IG9taXRzIHRoZSB3b3JrZWQgZXhhbXBsZSwgXCIgK1xuICAgICAgICBcImFjY2VwdGFuY2UtY3JpdGVyaWEgcmUtY2hlY2sgc3RlcCwgYW5kIGVycm9yLXJlY292ZXJ5IGd1aWRhbmNlIHRoYXQgdGhlIFwiICtcbiAgICAgICAgXCJpc3N1ZSB0ZW1wbGF0ZSBjYXJyaWVzLlxcblxcblwiICtcbiAgICAgICAgXCIjIyMgUHJvcG9zZWQgU29sdXRpb25cXG5cIiArXG4gICAgICAgIFwiRWRpdCBgcHJvbXB0cy9wcl9mZWVkYmFjay9wcm9tcHQubWRgIGluIHBsYWNlIHRvIGFkZDpcXG5cIiArXG4gICAgICAgIFwiLSBBIGNvbmNyZXRlIGJlZm9yZS9hZnRlciBleGFtcGxlIG9mIGFwcGx5aW5nIHJldmlldyBmZWVkYmFja1xcblwiICtcbiAgICAgICAgXCItIEFuIGV4cGxpY2l0IHN0ZXAgdG8gcmUtdmVyaWZ5IHRoZSBvcmlnaW5hbCBhY2NlcHRhbmNlIGNyaXRlcmlhIGFmdGVyIFwiICtcbiAgICAgICAgXCJyZXdvcmtpbmcgZm9yIGZlZWRiYWNrXFxuXCIgK1xuICAgICAgICBcIi0gRXJyb3ItcmVjb3ZlcnkgZ3VpZGFuY2Ugd2hlbiBmZWVkYmFjay1kcml2ZW4gY2hhbmdlcyBicmVhayB0ZXN0c1xcblwiICtcbiAgICAgICAgXCItIFNlbGYtdmVyaWZpY2F0aW9uIGNoZWNrcG9pbnQgY29uc2lzdGVudCB3aXRoIHRoZSBpc3N1ZSB0ZW1wbGF0ZVwiLFxuICAgICAgY2F0ZWdvcnk6IFwibWFpbnRhaW5hYmlsaXR5XCIsXG4gICAgICBsYWJlbHM6IFtcImVuaGFuY2VtZW50XCJdLFxuICAgIH0sXG4gICAge1xuICAgICAgdGl0bGU6IFwiQWRkIHJ1bnRpbWUgc2NoZW1hIHZhbGlkYXRpb24gZm9yIGdoIENMSSBKU09OIG91dHB1dFwiLFxuICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgIFwiQWNyb3NzIGB3b3JrZXIvZGVuby9gIHRoZXJlIGFyZSB+NDQgYEpTT04ucGFyc2UoLi4uKSBhcyBTb21lVHlwZWAgY2FzdHMgXCIgK1xuICAgICAgICBcIihlLmcuLCBgbGliL2lzc3VlX3F1ZXJ5LnRzYCwgYGxpYi9taWxlc3RvbmVfaGVhbHRoLnRzYCwgYGxpYi9naXRodWIudHNgKS4gXCIgK1xuICAgICAgICBcIlRoZXNlIHByb3ZpZGUgbm8gcnVudGltZSBndWFyYW50ZWU6IGEgZ2ggQ0xJIHJlc3BvbnNlIHdpdGggYSBtaXNzaW5nIG9yIFwiICtcbiAgICAgICAgXCJudWxsIGZpZWxkIGNyYXNoZXMgZGVlcCBpbnNpZGUgdGhlIHdvcmtlciByYXRoZXIgdGhhbiBmYWlsaW5nIHdpdGggYSBcIiArXG4gICAgICAgIFwiY2xlYXIgZXJyb3IgYXQgdGhlIHBhcnNlIGJvdW5kYXJ5LlxcblxcblwiICtcbiAgICAgICAgXCIjIyMgUHJvcG9zZWQgU29sdXRpb25cXG5cIiArXG4gICAgICAgIFwiSW50cm9kdWNlIGEgc21hbGwgdHlwZS1ndWFyZCBoZWxwZXIgKG9yIGFkb3B0IGBAc3RkL2pzb25jYC1zdHlsZSBcIiArXG4gICAgICAgIFwidmFsaWRhdGlvbikgdGhhdCBlYWNoIGdoLXdyYXBwaW5nIG1vZHVsZSB1c2VzIGluIHBsYWNlIG9mIHRoZSB1bmNoZWNrZWQgXCIgK1xuICAgICAgICBcImNhc3QsIHJldHVybmluZyBhIGBSZXN1bHQ8VCwgVmFsaWRhdGlvbkVycm9yPmAgd2l0aCB0aGUgb2ZmZW5kaW5nIGZpZWxkIFwiICtcbiAgICAgICAgXCJuYW1lIG9uIGZhaWx1cmUuXCIsXG4gICAgICBjYXRlZ29yeTogXCJyZXNpbGllbmNlXCIsXG4gICAgICBsYWJlbHM6IFtcImVuaGFuY2VtZW50XCJdLFxuICAgIH0sXG4gICAge1xuICAgICAgdGl0bGU6IFwiUmVkdWNlIHVuc2FmZSB0eXBlIGFzc2VydGlvbnMgaW4gaXNzdWVfd29ya2VyX3dpcmluZy50c1wiLFxuICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgIFwiYHdvcmtlci9kZW5vL2xpYi9pc3N1ZV93b3JrZXJfd2lyaW5nLnRzYCBjb250YWlucyB+ODQgYGFzIHVua25vd24gYXMgWGAgXCIgK1xuICAgICAgICBcImNhc3RzIOKAlCBieSBmYXIgdGhlIGhpZ2hlc3QgY29uY2VudHJhdGlvbiBpbiB0aGUgY29kZWJhc2UuIEVhY2ggY2FzdCBcIiArXG4gICAgICAgIFwic2lsZW50bHkgYnlwYXNzZXMgdGhlIHR5cGUgY2hlY2tlciwgc28gYSBjaGFuZ2UgaW4gYSB3aXJlZCBkZXBlbmRlbmN5J3MgXCIgK1xuICAgICAgICBcInNpZ25hdHVyZSB3aWxsIG5vdCBzdXJmYWNlIHVudGlsIHJ1bnRpbWUuXFxuXFxuXCIgK1xuICAgICAgICBcIiMjIyBQcm9wb3NlZCBTb2x1dGlvblxcblwiICtcbiAgICAgICAgXCJSZXBsYWNlIHRoZSBkb3VibGUtY2FzdHMgd2l0aCBleHBsaWNpdCBhZGFwdGVyIGZ1bmN0aW9ucyBvciB0eXBlZCBcIiArXG4gICAgICAgIFwiaW50ZXJmYWNlcyBmb3IgZWFjaCBkZXBlbmRlbmN5LiBXaGVyZSBhbiBhZGFwdGVyIGlzIGdlbnVpbmVseSBuZWVkZWQsIFwiICtcbiAgICAgICAgXCJleHRyYWN0IGl0IHNvIHRoZSBjYXN0IGlzIGlzb2xhdGVkIGFuZCBkb2N1bWVudGVkIHJhdGhlciB0aGFuIHNjYXR0ZXJlZC5cIixcbiAgICAgIGNhdGVnb3J5OiBcIm1haW50YWluYWJpbGl0eVwiLFxuICAgICAgbGFiZWxzOiBbXCJlbmhhbmNlbWVudFwiXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHRpdGxlOiBcIlNwbGl0IHJ1bl9jb3JlX3Byb2R1Y3Rpb25fZGVwcy50cyBpbnRvIGZvY3VzZWQgbW9kdWxlc1wiLFxuICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgIFwiYHdvcmtlci9kZW5vL2xpYi9ydW5fY29yZV9wcm9kdWN0aW9uX2RlcHMudHNgIGlzIH4xMzA3IGxpbmVzIOKAlCB0aGUgXCIgK1xuICAgICAgICBcImxhcmdlc3QgZmlsZSBpbiB0aGUgcmVwbyDigJQgYW5kIHdpcmVzIGV2ZXJ5IHByb2R1Y3Rpb24gZGVwZW5kZW5jeSAoZ2l0LCBcIiArXG4gICAgICAgIFwiR2l0SHViLCBDbGF1ZGUsIGZpbGVzeXN0ZW0sIGV0Yy4pIGluIGEgc2luZ2xlIG1vZHVsZS4gVGhpcyBjb25mbGljdHMgd2l0aCBcIiArXG4gICAgICAgIFwidGhlIFNpbmdsZS1SZXNwb25zaWJpbGl0eSBwcmluY2lwbGUgZG9jdW1lbnRlZCBpbiBBR0VOVFMubWQuXFxuXFxuXCIgK1xuICAgICAgICBcIiMjIyBQcm9wb3NlZCBTb2x1dGlvblxcblwiICtcbiAgICAgICAgXCJTcGxpdCBieSBjb25jZXJuIGludG8gKGZvciBleGFtcGxlKSBgcnVuX2NvcmVfZGVwc19naXQudHNgLCBcIiArXG4gICAgICAgIFwiYHJ1bl9jb3JlX2RlcHNfZ2l0aHViLnRzYCwgYHJ1bl9jb3JlX2RlcHNfY2xhdWRlLnRzYCwgYW5kIGNvbXBvc2UgdGhlbSBcIiArXG4gICAgICAgIFwiaW4gYSB0aGluIHRvcC1sZXZlbCBgcnVuX2NvcmVfcHJvZHVjdGlvbl9kZXBzLnRzYC5cIixcbiAgICAgIGNhdGVnb3J5OiBcIm1haW50YWluYWJpbGl0eVwiLFxuICAgICAgbGFiZWxzOiBbXCJlbmhhbmNlbWVudFwiXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHRpdGxlOiBcIlNwbGl0IGlzc3VlX3dvcmtlci50cyBpbnRvIHBlci1waGFzZSBtb2R1bGVzXCIsXG4gICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgXCJgd29ya2VyL2Rlbm8vbGliL2lzc3VlX3dvcmtlci50c2AgaXMgfjEyOTEgbGluZXMgYW5kIGNvbnRhaW5zIHRoZSBmdWxsIFwiICtcbiAgICAgICAgXCJvcmNoZXN0cmF0aW9uIGZvciBjbG9uZSDihpIgcHJvbXB0IGJ1aWxkIOKGkiBDbGF1ZGUgZXhlY3V0aW9uIOKGkiB0aW1lb3V0IFwiICtcbiAgICAgICAgXCJoYW5kbGluZyDihpIgUFIgY3JlYXRpb24uIEVhY2ggcGhhc2UgaXMgaW5kZXBlbmRlbnRseSB0ZXN0YWJsZSBidXQgaXMgXCIgK1xuICAgICAgICBcImN1cnJlbnRseSBzdGl0Y2hlZCB0b2dldGhlciBpbiBvbmUgZmlsZS5cXG5cXG5cIiArXG4gICAgICAgIFwiIyMjIFByb3Bvc2VkIFNvbHV0aW9uXFxuXCIgK1xuICAgICAgICBcIkV4dHJhY3QgZWFjaCBwaGFzZSBpbnRvIGl0cyBvd24gbW9kdWxlIHVuZGVyIGB3b3JrZXIvZGVuby9saWIvcGhhc2VzL2AgXCIgK1xuICAgICAgICBcIihlLmcuLCBgcGhhc2VzL2J1aWxkX3Byb21wdC50c2AsIGBwaGFzZXMvcnVuX2NsYXVkZS50c2AsIFwiICtcbiAgICAgICAgXCJgcGhhc2VzL2ZpbmFsaXNlX3ByLnRzYCkuIEtlZXAgYGlzc3VlX3dvcmtlci50c2AgYXMgYSB0aGluIG9yY2hlc3RyYXRvci5cIixcbiAgICAgIGNhdGVnb3J5OiBcIm1haW50YWluYWJpbGl0eVwiLFxuICAgICAgbGFiZWxzOiBbXCJlbmhhbmNlbWVudFwiXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHRpdGxlOlxuICAgICAgICBcIkFkZCBkZWRpY2F0ZWQgdGVzdHMgZm9yIERlbm8gbW9kdWxlcyB0aGF0IGN1cnJlbnRseSBsYWNrIGRpcmVjdCBjb3ZlcmFnZVwiLFxuICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgIFwiU2V2ZXJhbCBtb2R1bGVzIGluIGB3b3JrZXIvZGVuby9saWIvYCBhbmQgYHdvcmtlci9kZW5vL2NvbW1hbmRzL2AgZG8gbm90IFwiICtcbiAgICAgICAgXCJoYXZlIGEgbWF0Y2hpbmcgYHRlc3RzLzxuYW1lPl90ZXN0LnRzYCBmaWxlIOKAlCBleGFtcGxlcyBpbmNsdWRlIFwiICtcbiAgICAgICAgXCJgbGliL2F0b21pY193cml0ZS50c2AsIGBsaWIvbGFiZWxfY2FjaGUudHNgLCBgbGliL3ByX21hbmFnZXIudHNgLCBcIiArXG4gICAgICAgIFwiYGxpYi9zdHVja19kZXRlY3Rpb24udHNgLCBgY29tbWFuZHMvZmluZF9pc3N1ZXMudHNgLCBhbmQgXCIgK1xuICAgICAgICBcImBjb21tYW5kcy9naXRfb3BlcmF0aW9ucy50c2AuIFRoZXkgbWF5IGJlIGV4ZXJjaXNlZCB0cmFuc2l0aXZlbHksIGJ1dCBcIiArXG4gICAgICAgIFwiZGlyZWN0IHRlc3RzIGFyZSBtaXNzaW5nLlxcblxcblwiICtcbiAgICAgICAgXCIjIyMgUHJvcG9zZWQgU29sdXRpb25cXG5cIiArXG4gICAgICAgIFwiQXVkaXQgYHdvcmtlci9kZW5vL3tsaWIsY29tbWFuZHN9LyoudHNgIGFnYWluc3QgYHdvcmtlci9kZW5vL3Rlc3RzL2AgYW5kIFwiICtcbiAgICAgICAgXCJhZGQgZm9jdXNlZCB1bml0IHRlc3RzIGZvciBlYWNoIG1vZHVsZSB0aGF0IGhhcyBubyBjb3JyZXNwb25kaW5nIFwiICtcbiAgICAgICAgXCJgX3Rlc3QudHNgLiBQcmlvcml0aXNlIG1vZHVsZXMgd2l0aCBleHBvcnRlZCBkZWNpc2lvbi1tYWtpbmcgbG9naWMuXCIsXG4gICAgICBjYXRlZ29yeTogXCJ0ZXN0aW5nXCIsXG4gICAgICBsYWJlbHM6IFtcImVuaGFuY2VtZW50XCJdLFxuICAgIH0sXG4gICAge1xuICAgICAgdGl0bGU6IFwiUGVyc2lzdCB0aGUgcHJvbXB0cyBjb21taXQgdG8gYSBwZXItcnVuIGF1ZGl0IGxvZ1wiLFxuICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgIFwiYHJlY29yZFByb21wdENvbW1pdCgpYCBleGlzdHMgaW4gYHdvcmtlci9kZW5vL2xpYi9wcm9tcHRfbWFuYWdlci50c2AgXCIgK1xuICAgICAgICBcImFuZCBpcyB3aXJlZCB0byB0aGUgYHByb21wdC1tYW5hZ2VyYCBjb21tYW5kLCBidXQgdGhlIGV4ZWN1dGUgcGhhc2UgXCIgK1xuICAgICAgICAnb25seSBsb2dzIHRoZSByZXNvbHZlZCBjb21taXQgdmlhIGBsb2dnZXIuaW5mbyhcIlVzaW5nIHByb21wdHMgZnJvbSAnICtcbiAgICAgICAgJ2NvbW1pdFwiLCAuLi4pYCBpbiBgd29ya2VyL2Rlbm8vbGliL3BoYXNlcy9leGVjdXRlX3BoYXNlLnRzYCAoSXNzdWUgJyArXG4gICAgICAgIFwiIzExOTAsICM4NDQpLiBUaGVyZSBpcyBubyBkdXJhYmxlIGF1ZGl0IHRyYWlsIHR5aW5nIGEgc3BlY2lmaWMgaXNzdWUgXCIgK1xuICAgICAgICBcInJ1biB0byB0aGUgZXhhY3QgcHJvbXB0IHRleHQgdXNlZC5cXG5cXG5cIiArXG4gICAgICAgIFwiIyMjIFByb3Bvc2VkIFNvbHV0aW9uXFxuXCIgK1xuICAgICAgICBcIkNhbGwgYHJlY29yZFByb21wdENvbW1pdCgpYCBmcm9tIHRoZSBleGVjdXRlIHBoYXNlIGFmdGVyIHJlc29sdmluZyBcIiArXG4gICAgICAgIFwidGhlIGNvbW1pdCwgd3JpdGluZyB0byBhIHBlci1yZXBvIGxvZyAoZS5nLiwgYGxvZ3MvcHJvbXB0LWNvbW1pdHMubG9nYCkuIFwiICtcbiAgICAgICAgXCJJbmNsdWRlIHRoZSBpc3N1ZSBudW1iZXIgc28gYSBjb21wbGV0ZWQgUFIgY2FuIGJlIHRyYWNlZCBiYWNrIHRvIHRoZSBcIiArXG4gICAgICAgIFwiZXhhY3QgcHJvbXB0IHRleHQgdGhhdCBwcm9kdWNlZCBpdC5cIixcbiAgICAgIGNhdGVnb3J5OiBcIm9ic2VydmFiaWxpdHlcIixcbiAgICAgIGxhYmVsczogW1wiZW5oYW5jZW1lbnRcIl0sXG4gICAgfSxcbiAgXTtcbn1cblxuLyoqXG4gKiBGb3JtYXQgYW4gaW1wcm92ZW1lbnQgc3VnZ2VzdGlvbiBhcyBhIEdpdEh1YiBpc3N1ZSBib2R5IGluIG1hcmtkb3duLlxuICpcbiAqIEBwYXJhbSBpbXByb3ZlbWVudCAtIFRoZSBpbXByb3ZlbWVudCB0byBmb3JtYXRcbiAqIEByZXR1cm5zIEZvcm1hdHRlZCBtYXJrZG93biBib2R5IGZvciB0aGUgR2l0SHViIGlzc3VlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRJbXByb3ZlbWVudEFzSXNzdWVCb2R5KGltcHJvdmVtZW50OiBJbXByb3ZlbWVudCk6IHN0cmluZyB7XG4gIHJldHVybiBbXG4gICAgXCIjIyBEZXNjcmlwdGlvblwiLFxuICAgIFwiXCIsXG4gICAgaW1wcm92ZW1lbnQuZGVzY3JpcHRpb24sXG4gICAgXCJcIixcbiAgICBcIiMjIENhdGVnb3J5XCIsXG4gICAgXCJcIixcbiAgICBpbXByb3ZlbWVudC5jYXRlZ29yeSxcbiAgICBcIlwiLFxuICAgIFwiLS0tXCIsXG4gICAgXCIqVGhpcyBzdWdnZXN0aW9uIHdhcyBnZW5lcmF0ZWQgYnkgdGhlIGBzdWdnZXN0LWltcHJvdmVtZW50c2AgY29tbWFuZCAoSXNzdWUgIzIwOSkuKlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKiBUaGUgd29ya2VyJ3Mgb3duIHJlcG9zaXRvcnk7IHdvcmtlciBpbXByb3ZlbWVudHMgcm91dGUgaGVyZSAoSXNzdWUgIzM3NDUpLiAqL1xuY29uc3QgV09SS0VSX1JFUE8gPSBcInN0U29mdHdhcmVBVS9WaWJlQ29kZXJcIjtcblxuLyoqIFR5cGVkIGRhdGEgcmV0dXJuZWQgYnkgdGhlIHN1Z2dlc3QtaW1wcm92ZW1lbnRzIGNvbW1hbmQgKElzc3VlICMyMjMpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTdWdnZXN0SW1wcm92ZW1lbnRzRGF0YSB7XG4gIGltcHJvdmVtZW50czogSW1wcm92ZW1lbnRbXTtcbiAgcmVwbzogc3RyaW5nIHwgbnVsbDtcbiAgY3JlYXRlZElzc3Vlcz86IENyZWF0ZUlzc3Vlc1Jlc3VsdFtcImNyZWF0ZWRJc3N1ZXNcIl07XG4gIGZhaWx1cmVzPzogQ3JlYXRlSXNzdWVzUmVzdWx0W1wiZmFpbHVyZXNcIl07XG4gIHJvdXRlZD86IENyZWF0ZUlzc3Vlc1Jlc3VsdFtcInJvdXRlZFwiXTtcbn1cblxuLyoqIEluamVjdGlvbiBwb2ludHMgZm9yIHtAbGluayBjcmVhdGVTdWdnZXN0SW1wcm92ZW1lbnRzQ29tbWFuZH07IHByb2R1Y3Rpb24gZGVmYXVsdHMgYXBwbHkgd2hlbiBvbWl0dGVkLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTdWdnZXN0SW1wcm92ZW1lbnRzRGVwcyB7XG4gIGdoQ29tbWFuZEZuPzogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz47XG4gIG5vdz86ICgpID0+IERhdGU7XG4gIC8qKiBGbGVldCBhdXRob3Igc2V0IGZvciB0aGUgb3duZWQtYXJ0ZWZhY3QgY2hlY2tzOyBvbWl0dGVkIG1lYW5zIGNvbmZpZ3VyZWQgaWRlbnRpdHkuICovXG4gIGRlZHVwQXV0aG9ycz86IEFsZXJ0RGVkdXBBdXRob3JPcHRpb25zO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBzdWdnZXN0LWltcHJvdmVtZW50cyBjb21tYW5kIHdpdGggdGhlIGdpdmVuIGRlcGVuZGVuY2llcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVN1Z2dlc3RJbXByb3ZlbWVudHNDb21tYW5kKFxuICBkZXBzOiBTdWdnZXN0SW1wcm92ZW1lbnRzRGVwcyA9IHt9LFxuKTogQ29tbWFuZCB7XG4gIHJldHVybiB7XG4gICAgbmFtZTogXCJzdWdnZXN0LWltcHJvdmVtZW50c1wiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJHZW5lcmF0ZSBhbmQgb3B0aW9uYWxseSBjcmVhdGUgR2l0SHViIGlzc3VlcyBmb3IgaW1wcm92ZW1lbnQgc3VnZ2VzdGlvbnNcIixcblxuICAgIGFzeW5jIGV4ZWN1dGUoXG4gICAgICBhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICAgIGNvbmZpZzogV29ya2VyQ29uZmlnLFxuICAgICk6IFByb21pc2U8Q29tbWFuZFJlc3VsdDxTdWdnZXN0SW1wcm92ZW1lbnRzRGF0YT4+IHtcbiAgICAgIC8vIFZhbGlkYXRlIGFyZ3MgdXNpbmcgdHlwZWQgc2NoZW1hIChJc3N1ZSAjNjMwKVxuICAgICAgY29uc3QgcGFyc2VkID0gdmFsaWRhdGVTdWdnZXN0SW1wcm92ZW1lbnRzQXJncyhhcmdzKTtcbiAgICAgIGlmICghcGFyc2VkLm9rKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgbWVzc2FnZTogcGFyc2VkLmVycm9yLm1lc3NhZ2UsXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHsgZHJ5UnVuLCByZXBvIH0gPSBwYXJzZWQudmFsdWU7XG4gICAgICBjb25zdCBpbXByb3ZlbWVudHMgPSBnZW5lcmF0ZUltcHJvdmVtZW50cygpO1xuXG4gICAgICBpZiAoIXJlcG8pIHtcbiAgICAgICAgY29uc3QgY291bnQgPSBpbXByb3ZlbWVudHMubGVuZ3RoO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgICAgICAgbWVzc2FnZTogYEdlbmVyYXRlZCAke2NvdW50fSBpbXByb3ZlbWVudCBzdWdnZXN0aW9uJHtcbiAgICAgICAgICAgIGNvdW50ID09PSAxID8gXCJcIiA6IFwic1wiXG4gICAgICAgICAgfSAoZHJ5LXJ1bilgLFxuICAgICAgICAgIGRhdGE6IHtcbiAgICAgICAgICAgIGltcHJvdmVtZW50cyxcbiAgICAgICAgICAgIHJlcG86IHJlcG8gPz8gbnVsbCxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjcmVhdGVHaXRIdWJJc3N1ZXNXaXRoUGFydGlhbEZhaWx1cmVzKFxuICAgICAgICBpbXByb3ZlbWVudHMsXG4gICAgICAgIHJlcG8sXG4gICAgICAgIHtcbiAgICAgICAgICByb3V0aW5nQ29udGV4dDoge1xuICAgICAgICAgICAgdmliZUNvZGVyUmVwbzogV09SS0VSX1JFUE8sXG4gICAgICAgICAgICBwcm9kdWN0UmVwb3M6IGNvbmZpZy5yZXBvcyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIGRyeVJ1bixcbiAgICAgICAgICAvLyBJc3N1ZSAjODQ3OiBhIGNvbmZpZ3VyZWQgY3VzdG9tIGxhYmVsIGRpc3BhdGNoZXMgYSBwcml2aWxlZ2VkIHBoYXNlLFxuICAgICAgICAgIC8vIHNvIHRoZSB3b3JrZXIgbXVzdCBuZXZlciBzZWxmLWFwcGx5IG9uZSBvbiBhbiBpc3N1ZSBpdCBmaWxlcy5cbiAgICAgICAgICBleHRyYVJlc2VydmVkTGFiZWxzOiBjdXN0b21MYWJlbFByb21wdExhYmVscyhjb25maWcpLFxuICAgICAgICAgIGdoQ29tbWFuZEZuOiBkZXBzLmdoQ29tbWFuZEZuLFxuICAgICAgICAgIG5vdzogZGVwcy5ub3csXG4gICAgICAgICAgLi4uKGRlcHMuZGVkdXBBdXRob3JzID8geyBkZWR1cEF1dGhvcnM6IGRlcHMuZGVkdXBBdXRob3JzIH0gOiB7fSksXG4gICAgICAgIH0sXG4gICAgICApO1xuXG4gICAgICBjb25zdCBjb3VudCA9IChhY3Rpb246IFJvdXRlZEltcHJvdmVtZW50W1wiYWN0aW9uXCJdKSA9PlxuICAgICAgICByZXN1bHQucm91dGVkLmZpbHRlcigocikgPT4gci5hY3Rpb24gPT09IGFjdGlvbikubGVuZ3RoO1xuICAgICAgY29uc3QgY3JlYXRlZCA9IHJlc3VsdC5jcmVhdGVkSXNzdWVzLmxlbmd0aDtcbiAgICAgIGNvbnN0IHJldXNlZCA9IGNvdW50KFwicmV1c2VkXCIpO1xuICAgICAgY29uc3Qgc3VtbWFyeSA9IGRyeVJ1blxuICAgICAgICA/IGBEcnkgcnVuOiAke1xuICAgICAgICAgIHBsdXJhbChjb3VudChcIndvdWxkLWNyZWF0ZVwiKSwgXCJpbXByb3ZlbWVudCBpc3N1ZVwiKVxuICAgICAgICB9IHdvdWxkIGJlIGNyZWF0ZWQgYW5kICR7XG4gICAgICAgICAgcGx1cmFsKGNvdW50KFwid291bGQtcmV1c2VcIiksIFwiZXhpc3RpbmcgaXNzdWVcIilcbiAgICAgICAgfSByZXVzZWQsIHJvdXRlZCBmcm9tICR7cmVwb31gXG4gICAgICAgIDogYENyZWF0ZWQgJHtwbHVyYWwoY3JlYXRlZCwgXCJpbXByb3ZlbWVudCBpc3N1ZVwiKX0gYW5kIHJldXNlZCAke1xuICAgICAgICAgIHBsdXJhbChyZXVzZWQsIFwiZXhpc3RpbmcgaXNzdWVcIilcbiAgICAgICAgfSwgcm91dGVkIGZyb20gJHtyZXBvfWA7XG4gICAgICAvLyBBIHNhbWUtdGl0bGVkIG1hdGNoIHRoYXQgaXMgbm90IG93bmVkIGFuZCBvcGVuIHN1cHByZXNzZXMgdGhlIGZpbGluZy5cbiAgICAgIGNvbnN0IHN1cHByZXNzZWQgPSBjb3VudChcInN1cHByZXNzZWRcIik7XG4gICAgICBjb25zdCBzdXBwcmVzc2VkTXNnID0gc3VwcHJlc3NlZCA+IDBcbiAgICAgICAgPyBgOyAke1xuICAgICAgICAgIHBsdXJhbChzdXBwcmVzc2VkLCBcImltcHJvdmVtZW50XCIpXG4gICAgICAgIH0gbm90IGZpbGVkLCBiZWNhdXNlIGEgc2FtZS10aXRsZWQgaXNzdWUgb3IgUFIgZXhpc3RzIHRoYXQgaXMgbm90IHJldXNlZGBcbiAgICAgICAgOiBcIlwiO1xuICAgICAgY29uc3QgZmFpbHVyZU1zZyA9IHJlc3VsdC5mYWlsdXJlcy5sZW5ndGggPiAwXG4gICAgICAgID8gYCAoJHtyZXN1bHQuZmFpbHVyZXMubGVuZ3RofSBmYWlsZWQpYFxuICAgICAgICA6IFwiXCI7XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN1Y2Nlc3M6IHJlc3VsdC5mYWlsdXJlcy5sZW5ndGggPT09IDAsXG4gICAgICAgIG1lc3NhZ2U6IHN1bW1hcnkgKyBzdXBwcmVzc2VkTXNnICsgZmFpbHVyZU1zZyxcbiAgICAgICAgZGF0YToge1xuICAgICAgICAgIGltcHJvdmVtZW50cyxcbiAgICAgICAgICBjcmVhdGVkSXNzdWVzOiByZXN1bHQuY3JlYXRlZElzc3VlcyxcbiAgICAgICAgICBmYWlsdXJlczogcmVzdWx0LmZhaWx1cmVzLFxuICAgICAgICAgIHJvdXRlZDogcmVzdWx0LnJvdXRlZCxcbiAgICAgICAgICByZXBvLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9LFxuICB9O1xufVxuXG4vKipcbiAqIFN1Z2dlc3QgaW1wcm92ZW1lbnRzIGNvbW1hbmQgaW1wbGVtZW50YXRpb24uXG4gKi9cbmV4cG9ydCBjb25zdCBzdWdnZXN0SW1wcm92ZW1lbnRzQ29tbWFuZDogQ29tbWFuZCA9XG4gIGNyZWF0ZVN1Z2dlc3RJbXByb3ZlbWVudHNDb21tYW5kKCk7XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7OztDQWVDLEdBR0QsU0FDRSxxQ0FBcUMsUUFHaEMsbUJBQW1CO0FBRTFCLFNBQVMsK0JBQStCLFFBQVEseUJBQXlCO0FBQ3pFLFNBQVMsdUJBQXVC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
// denoCacheMetadata=15773315360809017202,17480037562275686331