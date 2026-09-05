/**
 * `check-main-ruleset` — reconcile the `main` branch ruleset (Issue #858).
 *
 * Two comparisons, both read-only:
 *
 *   1. **Offline** — every check a PR into `main` always reports is either
 *      required by `infra/rulesets/main.json` or carries a recorded reason
 *      for not being. This one also runs in the test suite, so drift fails
 *      the quality gate rather than waiting to be noticed.
 *   2. **Live** — the ruleset GitHub applies against the committed payload,
 *      field by field. Skips loudly without a credential.
 *
 * Usage:
 *   deno run --allow-all mod.ts check-main-ruleset [--repo owner/repo]
 */

import type { Command, CommandResult } from "../types.ts";
import {
  loadMainBranchRuleset,
  requiredContexts,
} from "../lib/main_branch_ruleset.ts";
import {
  checkMainBranchRuleset,
  type MainRulesetStatus,
} from "../lib/main_branch_ruleset_check.ts";
import {
  type ContextReconciliation,
  pullRequestCheckContexts,
  reconcileRequiredContexts,
} from "../lib/pr_check_contexts.ts";
import { readWorkflowFiles } from "../lib/workflow_scan_common.ts";

/** The repository this payload describes, unless `--repo` says otherwise. */
const DEFAULT_REPO = "stSoftwareAU/VibeCoder";

interface CheckData {
  status: MainRulesetStatus;
  reconciliation: ContextReconciliation;
}

/** Repository root, resolved from this module's location. */
function repoRoot(): string {
  return decodeURIComponent(new URL("../../../", import.meta.url).pathname)
    .replace(/\/$/, "");
}

/** Render the offline reconciliation as operator-facing lines. */
function describe(result: ContextReconciliation): string {
  const lines: string[] = [];
  for (const context of result.missing) {
    lines.push(`  - "${context}" runs on every main PR but is not required`);
  }
  for (const context of result.phantom) {
    lines.push(`  - "${context}" is required but no workflow reports it`);
  }
  for (const context of result.staleExemptions) {
    lines.push(`  - "${context}" is exempted but no longer exists`);
  }
  return lines.length === 0
    ? "Workflow jobs and required contexts agree."
    : `Required-context drift against the workflows:\n${lines.join("\n")}`;
}

export const checkMainRulesetCommand: Command = {
  name: "check-main-ruleset",
  description:
    "Read-only: compare the applied main-branch ruleset and the workflow " +
    "jobs against infra/rulesets/main.json",

  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<CheckData>> {
    const repo = typeof args["repo"] === "string" && args["repo"].length > 0
      ? args["repo"]
      : DEFAULT_REPO;

    const root = repoRoot();
    const derived = pullRequestCheckContexts(
      await readWorkflowFiles(root),
      "main",
    );
    const committed = await loadMainBranchRuleset(root);
    const reconciliation = reconcileRequiredContexts(
      requiredContexts(committed),
      derived,
    );
    const offlineOk = reconciliation.missing.length === 0 &&
      reconciliation.phantom.length === 0 &&
      reconciliation.staleExemptions.length === 0;

    const live = await checkMainBranchRuleset({ repo, root });

    return {
      // A skipped live comparison is not a pass, but it is not a failure the
      // operator can act on either — the offline half still gates.
      success: offlineOk && (live.status === "ok" || live.status === "skipped"),
      message: `${describe(reconciliation)}\n\n${live.message}`,
      data: { status: live.status, reconciliation },
    };
  },
};
