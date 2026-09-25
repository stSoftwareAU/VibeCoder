/**
 * `repo-settings-harden` — close the repository-settings gaps the Actions
 * audit reports (Issues #4397, #4398, #4401).
 *
 *   mod.ts repo-settings-harden --repo owner/name            # dry run: show the plan
 *   mod.ts repo-settings-harden --repo owner/name --apply    # write the safe subset
 *   mod.ts repo-settings-harden --repo owner/name --apply --require-code-owner-review
 *   mod.ts repo-settings-harden --repo owner/name --apply --require-reviews
 *
 * The safe subset: read-only default token, no approve-PRs, SHA-pin
 * enforcement, an allow-list of the actions the workflows use, and — on a
 * public repository only — secret scanning + push protection; a private or
 * internal repository needs the paid GitHub Secret Protection add-on, so
 * that step is skipped and the skip printed (Issue #2225).
 * `--require-code-owner-review` (Issue #4397) makes PRs that touch a path in
 * `.github/CODEOWNERS` — the workflows, actions and scripts — wait for an
 * owner's approval while every other PR merges as before; the approval count
 * is left alone. `--require-reviews` additionally requires one approving
 * review on every PR — it stops the fleet's autonomous merges, so it is
 * never part of the default plan and wins over the owner-only flag.
 *
 * Needs an admin token; the worker's own token cannot write settings, so
 * this is an operator command, not a fleet task.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { runGhCommand } from "../lib/github.ts";
import { isValidRepoSlug } from "../lib/repo_rulesets.ts";
import {
  collectUsesReferences,
  hardenRepo,
  type HardenResult,
  isValidActionCoordinate,
} from "../lib/repo_settings_harden.ts";

/** What the command reports. */
export interface RepoSettingsHardenReport {
  repo: string;
  applied: boolean;
  results: HardenResult[];
}

/** Coordinates (`owner/repo`) of every `uses:` in the checkout's workflows. */
export async function collectUsesCoordinates(
  workDir: string,
): Promise<string[]> {
  const out = new Set<string>();
  for (const reference of await collectUsesReferences(workDir)) {
    const at = reference.indexOf("@");
    out.add(at >= 0 ? reference.slice(0, at) : reference);
  }
  return [...out].sort();
}

/**
 * `--allow-action owner/repo[,owner/repo…]`: extra coordinates the operator
 * vouches for (an action the resolver could not read, or one a workflow
 * will use next). Anything that is not `owner/repo` is rejected loudly.
 */
export function parseAllowActionArg(value: unknown): string[] {
  if (value === undefined || value === true) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of raw) {
    for (const part of String(item).split(",")) {
      const trimmed = part.trim();
      if (trimmed === "") continue;
      const [owner, repo, ...rest] = trimmed.split("/");
      // Rejected loudly here so an operator coordinate the pattern builder
      // would drop (a `.`/`..` segment) can never pass silently (Issue #1235).
      if (
        rest.length > 0 || !owner || !repo ||
        !isValidActionCoordinate(owner, repo)
      ) {
        throw new Error(
          `--allow-action expects owner/repo, got ${JSON.stringify(trimmed)}`,
        );
      }
      out.push(trimmed);
    }
  }
  return out;
}

export const repoSettingsHardenCommand: Command = {
  name: "repo-settings-harden",
  description:
    "Plan (default) or apply (--apply) the repository-settings hardening the Actions audit reports: read-only token, no approve-PRs, SHA-pin enforcement, action allow-list, secret scanning; --require-code-owner-review makes owned paths (workflows) wait for an owner's approval without touching other PRs; --require-reviews opts into the fleet-stopping one-approval rule; the allow-list follows composite actions' own uses: and --allow-action adds more (Issues #4397 #4398 #4401 #4424)",
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<RepoSettingsHardenReport>> {
    const repo = typeof args["repo"] === "string" ? args["repo"] : "";
    if (!isValidRepoSlug(repo)) {
      return {
        success: false,
        message: "repo-settings-harden requires --repo owner/name",
      };
    }
    const apply = args["apply"] === true;
    const requireReviews = args["require-reviews"] === true;
    const requireCodeOwnerReview = args["require-code-owner-review"] === true;
    const workDir = typeof args["work-dir"] === "string"
      ? args["work-dir"]
      : Deno.cwd();
    let extraCoordinates: string[];
    try {
      extraCoordinates = parseAllowActionArg(args["allow-action"]);
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    const outcome = await hardenRepo(repo, {
      apply,
      ghCommandFn: runGhCommand,
      workDir,
      requireReviews,
      requireCodeOwnerReview,
      extraCoordinates,
    });
    const { results, coordinates, referenceCount, unreadable } = outcome;
    const lines = results.map((r) =>
      `- [${r.status}] ${r.step.kind}: ${r.step.title}` +
      (r.step.warning ? ` — ⚠ ${r.step.warning}` : "") +
      (r.detail ? ` — ${r.detail}` : "")
    );
    // The exempted step is stated in the output, never silently absent.
    const skipNote = outcome.skipNote ? `\n${outcome.skipNote}` : "";
    const message =
      (results.length === 0
        ? `${repo}: nothing to harden — every checked setting already holds.`
        : `${repo}: ${
          apply ? "applied" : "planned (dry run; add --apply)"
        } ${results.length} step(s):\n${lines.join("\n")}` +
          (coordinates.length > 0
            ? `\nAllow-list source: ${coordinates.length} action coordinate(s) from ${referenceCount} workflow reference(s) in ${workDir}` +
              (extraCoordinates.length > 0
                ? ` plus --allow-action ${extraCoordinates.join(", ")}`
                : "")
            : "") +
          (unreadable.length > 0
            ? `\n⚠ Could not read the manifest of ${unreadable.length} action(s) — the allow-list may be incomplete: ${
              unreadable.join("; ")
            }`
            : "")) + skipNote;
    const failed = results.some((r) => r.status === "failed");
    return {
      success: !failed,
      message,
      data: { repo, applied: apply, results },
    };
  },
};
