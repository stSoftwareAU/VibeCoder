/**
 * The third-party actions the workflow-sync templates use (Issue #4448).
 *
 * `allowed_actions=selected` is enforced against every action a run uses, so
 * a workflow-sync PR that adds the Gitleaks or ShellCheck template fails with
 * `startup_failure` unless the allow-list already admits that action. The
 * default-branch scan in `repo_settings_harden.ts` only sees the workflows the
 * repository already has, so this module adds the actions of the templates
 * workflow sync would file for it: the missing and partial specs for its
 * detected languages, read through the same detection and audit that
 * `setup/workflow_sync.ts` runs.
 */

import {
  type CommandOutput,
  detectRepoLanguages,
} from "./language_detector.ts";
import { extractUsesValue } from "./action_pin_scanner.ts";
import type { GhCommandFn } from "./repo_settings_harden.ts";
import { auditRepoWorkflows } from "./workflow_auditor.ts";
import type { WorkflowSpec } from "./workflow_definitions.ts";

/** What {@link workflowSyncActionReferences} found. */
export interface WorkflowSyncActionReferences {
  /**
   * `owner/repo@sha` for every `uses:` in the templates, sorted and unique.
   * GitHub-owned actions are kept; the allow-list builder keeps them implicit.
   */
  references: string[];
  /**
   * Why the templates could not be read, naming the cause. Absent when they
   * were read. A fault means `references` is empty, never a partial list.
   */
  fault?: string;
}

/**
 * Adapt `gh` to the command runner the detector and auditor take. Only `gh`
 * is run; a thrown error becomes a failed command carrying its message.
 */
export function ghRunner(
  gh: GhCommandFn,
): (cmd: string[]) => Promise<CommandOutput> {
  return async (cmd: string[]): Promise<CommandOutput> => {
    if (cmd[0] !== "gh") {
      return {
        success: false,
        stdout: "",
        stderr: `refusing to run "${cmd[0] ?? ""}"`,
      };
    }
    try {
      return { success: true, stdout: await gh(cmd.slice(1)), stderr: "" };
    } catch (err) {
      return {
        success: false,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/**
 * Every `uses:` value in the templates of `specs`, sorted and unique. Local
 * (`./…`) and `docker://` references are not allow-listable and are skipped.
 */
export function templateActionReferences(
  specs: readonly WorkflowSpec[],
): string[] {
  const out = new Set<string>();
  for (const spec of specs) {
    for (const line of spec.template.split("\n")) {
      const value = extractUsesValue(line);
      if (!value || value.startsWith(".") || value.startsWith("docker://")) {
        continue;
      }
      out.add(value);
    }
  }
  return [...out].sort();
}

/**
 * The `uses:` references of the workflow-sync templates `repo` would be
 * filed with: the missing specs and the partial specs, for its detected
 * languages. Never throws; a failed detection, audit or read is a `fault`
 * with `references` empty.
 */
export async function workflowSyncActionReferences(
  repo: string,
  gh: GhCommandFn,
): Promise<WorkflowSyncActionReferences> {
  const runCommand = ghRunner(gh);
  try {
    const languages = await detectRepoLanguages(repo, { runCommand });
    if (!languages.ok) {
      return {
        references: [],
        fault: `language detection failed: ${languages.error}`,
      };
    }
    const audit = await auditRepoWorkflows(repo, languages.value, {
      runCommand,
    });
    if (!audit.ok) {
      return { references: [], fault: `workflow audit failed: ${audit.error}` };
    }
    const specs = [
      ...audit.value.missing,
      ...audit.value.partial.map((match) => match.spec),
    ];
    return { references: templateActionReferences(specs) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { references: [], fault: `could not read the templates: ${reason}` };
  }
}
