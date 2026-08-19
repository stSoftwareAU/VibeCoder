/**
 * Read-only sweep of the default-branch ruleset decision (Issue #4356).
 *
 * For every repo given (or every non-archived repo of an organisation) this
 * computes what `ensureDefaultBranchRuleset()` **would** do — create/update
 * the worker's ruleset, delete its own stale one, or skip and why — via the
 * read-only {@link planBranchProtectionForRepo}, and renders the answers as a
 * Markdown table. Nothing is written: no ruleset, no comment, no label.
 *
 * It exists so an operator can see, before a setup run, which repos the
 * direct-push guard now protects (`direct-push-branch` / `opted-out`) and
 * which still receive a ruleset.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  planBranchProtectionForRepo,
  type SyncRepoOptions,
} from "../setup/branch_protection_sync.ts";
import { defaultGhExec, type GhExec } from "./repo_rulesets.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What the sync would do to one repo. */
export type AuditDecision =
  | "create"
  | "update"
  | "delete"
  | "existing-ruleset"
  | "no-reported-checks"
  | "direct-push-branch"
  | "opted-out"
  | "error";

/** One row of the audit table. */
export interface AuditRow {
  repo: string;
  branch?: string;
  visibility?: string;
  decision: AuditDecision;
  /** Contexts a create/update would require. */
  contexts: string[];
  /** Skip reason detail, or the error message. */
  detail: string;
}

/** Options for {@link auditDefaultBranchRulesets}. */
export interface AuditOptions {
  /** `owner/repo` slugs to inspect. */
  repos: readonly string[];
  /** Custom gh config directory (from `.config.json` `gh_config_dir`). */
  ghConfigDir?: string;
  /** Override for metadata-read command execution (testing). */
  runCommand?: SyncRepoOptions["runCommand"];
  /** Override for the ruleset/read executor (testing). */
  ghFn?: GhExec;
}

// ---------------------------------------------------------------------------
// Repo discovery
// ---------------------------------------------------------------------------

/** Validate a GitHub organisation / user login for an API path. */
export function isValidOrgLogin(org: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(org);
}

/**
 * Every non-archived repository of an organisation, as `owner/repo` slugs.
 * Read-only (`gh api --paginate`).
 */
export async function listOrgRepos(
  org: string,
  ghFn: GhExec = defaultGhExec,
): Promise<string[]> {
  if (!isValidOrgLogin(org)) throw new Error(`Invalid organisation: ${org}`);
  const raw = await ghFn([
    "api",
    "--paginate",
    `orgs/${org}/repos?per_page=100&type=all`,
    "--jq",
    ".[] | select(.archived | not) | .full_name",
  ]);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/**
 * Compute the decision for every repo. Never throws for a single repo — a
 * failure becomes an `error` row so the sweep completes.
 */
export async function auditDefaultBranchRulesets(
  options: AuditOptions,
): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  for (const repo of options.repos) {
    const result = await planBranchProtectionForRepo(repo, {
      ghConfigDir: options.ghConfigDir,
      runCommand: options.runCommand,
      ghFn: options.ghFn,
    });
    if (!result.ok || !result.plan) {
      rows.push({
        repo,
        branch: result.branch,
        visibility: result.visibility,
        decision: "error",
        contexts: [],
        detail: result.error ?? "unknown error",
      });
      continue;
    }
    const plan = result.plan;
    const decision: AuditDecision = plan.action !== "none"
      ? plan.action
      : (plan.skipped ?? "error");
    const contexts = plan.action === "create" || plan.action === "update"
      ? [...plan.preserved, ...plan.added]
      : plan.preserved;
    rows.push({
      repo,
      branch: result.branch,
      visibility: result.visibility,
      decision,
      contexts,
      detail: plan.action === "delete"
        ? `${plan.skipped}: ${plan.detail ?? ""} — would delete own ruleset`
        : plan.detail ?? "",
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/** Render the rows as a GitHub-flavoured Markdown table. */
export function formatAuditTable(rows: readonly AuditRow[]): string {
  const lines = [
    "| Repo | Branch | Visibility | Decision | Contexts | Detail |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${cell(row.repo)} | ${cell(row.branch ?? "-")} | ${
        cell(row.visibility ?? "-")
      } | ${cell(row.decision)} | ${
        cell(row.contexts.length > 0 ? row.contexts.join(", ") : "-")
      } | ${cell(row.detail || "-")} |`,
    );
  }
  return lines.join("\n");
}

/** One-line tally by decision, e.g. `create 2, direct-push-branch 6`. */
export function summariseAudit(rows: readonly AuditRow[]): string {
  const counts = new Map<AuditDecision, number>();
  for (const row of rows) {
    counts.set(row.decision, (counts.get(row.decision) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([decision, n]) => `${decision} ${n}`)
    .join(", ");
}
