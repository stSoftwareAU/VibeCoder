/**
 * `audit-default-branch-rulesets` — read-only sweep of the default-branch
 * ruleset decision (Issue #4356).
 *
 * Prints, for every repo, what the setup-time ruleset sync **would** do:
 * `create` / `update` the worker's ruleset, `delete` its own stale one, or
 * skip (`direct-push-branch`, `opted-out`, `existing-ruleset`,
 * `no-reported-checks`). Nothing is written.
 *
 * Usage:
 *   deno run --allow-all mod.ts audit-default-branch-rulesets \
 *     [--org stSoftwareAU | --repos owner/a,owner/b]
 *
 * With neither flag the configured monitored repos are audited.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  auditDefaultBranchRulesets,
  type AuditRow,
  formatAuditTable,
  listOrgRepos,
  summariseAudit,
} from "../lib/default_branch_ruleset_audit.ts";

interface AuditCommandData {
  rows: AuditRow[];
}

/** Resolve the repo list from `--org`, `--repos`, or the config. */
async function resolveRepos(
  args: Record<string, unknown>,
  config: WorkerConfig,
): Promise<string[]> {
  if (typeof args["org"] === "string" && args["org"].length > 0) {
    return await listOrgRepos(args["org"]);
  }
  if (typeof args["repos"] === "string" && args["repos"].length > 0) {
    return args["repos"].split(",").map((r) => r.trim()).filter((r) =>
      r.length > 0
    );
  }
  return config.repos ?? [];
}

export const auditDefaultBranchRulesetsCommand: Command = {
  name: "audit-default-branch-rulesets",
  description:
    "Read-only: list what the default-branch ruleset sync would do per repo",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<AuditCommandData>> {
    const repos = await resolveRepos(args, config);
    if (repos.length === 0) {
      return {
        success: true,
        message: "No repos to audit (pass --org <org> or --repos a/b,c/d).",
        data: { rows: [] },
      };
    }
    // The service-account gh identity (GH_CONFIG_DIR) is already applied to
    // the process env by mod.ts, so both executors inherit it.
    const rows = await auditDefaultBranchRulesets({ repos });
    const errors = rows.filter((r) => r.decision === "error").length;
    return {
      success: errors === 0,
      message: `${formatAuditTable(rows)}\n\nDecisions: ${
        summariseAudit(rows)
      } (of ${rows.length}; read-only, nothing written)`,
      data: { rows },
    };
  },
};
