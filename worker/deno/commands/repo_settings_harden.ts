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
 * enforcement, an allow-list of the actions the workflows use, secret
 * scanning + push protection (refused without Secret Protection — reported).
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
import { getRepoDefaultBranch } from "../lib/shell_helpers.ts";
import {
  applyRepoSettingsPlan,
  buildAllowedActionPatterns,
  type HardenResult,
  isValidActionCoordinate,
  planRepoSettingsHardening,
  type RepoSettingsSnapshot,
  resolveTransitiveActionCoordinates,
} from "../lib/repo_settings_harden.ts";
import { readWorkflowFiles } from "../lib/workflow_scan_common.ts";
import { extractUsesValue } from "../lib/action_pin_scanner.ts";

/** What the command reports. */
export interface RepoSettingsHardenReport {
  repo: string;
  applied: boolean;
  results: HardenResult[];
}

async function readJson<T>(
  gh: (args: string[]) => Promise<string>,
  endpoint: string,
): Promise<T | undefined> {
  try {
    return JSON.parse(await gh(["api", endpoint])) as T;
  } catch {
    return undefined;
  }
}

/**
 * Every repository `uses:` reference in the checkout's workflows, with its
 * ref (`owner/repo@sha`), so composite manifests can be read at the pinned
 * revision (Issue #4424). Local and docker steps are not repository actions.
 */
export async function collectUsesReferences(
  workDir: string,
): Promise<string[]> {
  const files = await readWorkflowFiles(workDir);
  const out = new Set<string>();
  for (const file of files) {
    for (const line of file.rawText.split("\n")) {
      const value = extractUsesValue(line);
      if (!value || value.startsWith(".") || value.startsWith("docker://")) {
        continue;
      }
      const at = value.indexOf("@");
      const path = at >= 0 ? value.slice(0, at) : value;
      const [owner, repo] = path.split("/");
      if (owner && repo) out.add(value);
    }
  }
  return [...out].sort();
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
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
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
    const gh = runGhCommand;

    const defaultBranch = await getRepoDefaultBranch(repo, gh);
    if (!defaultBranch.ok) {
      return {
        success: false,
        message: `default branch unknown: ${defaultBranch.error.message}`,
      };
    }
    const snapshot: RepoSettingsSnapshot = {
      workflow: await readJson(
        gh,
        `repos/${repo}/actions/permissions/workflow`,
      ),
      actions: await readJson(gh, `repos/${repo}/actions/permissions`),
      security: (await readJson<
        { security_and_analysis?: RepoSettingsSnapshot["security"] }
      >(gh, `repos/${repo}`))?.security_and_analysis,
      rules: await readJson(
        gh,
        `repos/${repo}/rules/branches/${
          encodeURIComponent(defaultBranch.value)
        }`,
      ),
    };
    // The allow-list must cover what the workflows run, including the
    // actions their composite steps pull in (Issue #4424).
    if (snapshot.actions?.allowed_actions === "selected") {
      snapshot.selectedActions = await readJson(
        gh,
        `repos/${repo}/actions/permissions/selected-actions`,
      );
    }
    let references: string[] = [];
    try {
      references = await collectUsesReferences(workDir);
    } catch {
      references = [];
    }
    const transitive = await resolveTransitiveActionCoordinates(
      references,
      gh,
    );
    const coordinates = [
      ...new Set([...transitive.coordinates, ...extraCoordinates]),
    ].sort();
    const plan = planRepoSettingsHardening(snapshot, {
      thirdPartyPatterns: buildAllowedActionPatterns(coordinates),
      requireReviews,
      requireCodeOwnerReview,
      defaultBranch: defaultBranch.value,
    });
    const results = await applyRepoSettingsPlan(repo, plan, {
      apply,
      ghCommandFn: gh,
    });
    const lines = results.map((r) =>
      `- [${r.status}] ${r.step.kind}: ${r.step.title}` +
      (r.step.warning ? ` — ⚠ ${r.step.warning}` : "") +
      (r.detail ? ` — ${r.detail}` : "")
    );
    const message = plan.length === 0
      ? `${repo}: nothing to harden — every checked setting already holds.`
      : `${repo}: ${
        apply ? "applied" : "planned (dry run; add --apply)"
      } ${plan.length} step(s):\n${lines.join("\n")}` +
        (coordinates.length > 0
          ? `\nAllow-list source: ${coordinates.length} action coordinate(s) from ${references.length} workflow reference(s) in ${workDir}` +
            (extraCoordinates.length > 0
              ? ` plus --allow-action ${extraCoordinates.join(", ")}`
              : "")
          : "") +
        (transitive.unreadable.length > 0
          ? `\n⚠ Could not read the manifest of ${transitive.unreadable.length} action(s) — the allow-list may be incomplete: ${
            transitive.unreadable.join("; ")
          }`
          : "");
    const failed = results.some((r) => r.status === "failed");
    return {
      success: !failed,
      message,
      data: { repo, applied: apply, results },
    };
  },
};
