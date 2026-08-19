/**
 * Workflow best-practice synchronisation across monitored repositories.
 *
 * Runs the workflow best-practice auditor (see
 * `lib/workflow_best_practices.ts`) against each repo and files a
 * single follow-up issue per repo when findings exist. Idempotent: a
 * marker comment in the issue body lets subsequent runs update the
 * existing issue with a new findings comment rather than create a
 * duplicate.
 *
 * Labelling (Issue #2335): each filed issue carries `enhancement` plus
 * two descriptive labels derived from the findings — `severity:<highest>`
 * (the highest of `high > medium > low` across all findings) and the
 * stable category label `best-practices`. Every derived label is created
 * in the target repo (via `ensureLabelExists`) before it is applied, and
 * all label operations recover silently: a label that cannot be ensured
 * is simply omitted, a labelled create that fails falls back to filing
 * with no labels, and nothing throws or logs at error level. These are
 * descriptive labels, not reserved workflow labels, so `label_security.ts`
 * does not strip them. On the update path the same labels are reconciled
 * onto the existing issue so drift self-heals on subsequent runs.
 *
 * Issue #2102: setup.sh best-practice sync. Part of #2094.
 */

import {
  auditWorkflowBestPractices,
  type BestPracticeFinding,
} from "../lib/workflow_best_practices.ts";
import { addLabelToIssue, ensureLabelExists } from "../lib/label_operations.ts";
import type { LabelManagerDeps } from "../lib/label_types.ts";
import { retryWithBackoff } from "../lib/retry.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Output from a shell command (mirrors `setup/workflow_sync.ts`). */
export interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Runner used to invoke shell commands (typically `gh`). */
export type GhCommandFn = (cmd: string[]) => Promise<CommandOutput>;

/** Options for `syncBestPracticesForAllRepos`. */
export interface SyncAllOptions {
  /** Monitored repos in `owner/repo` form. */
  repos: string[];
  /**
   * Working directory containing per-repo clones. Each repo is
   * expected at `<workDir>/<repoName>`. Required when
   * `localRepoPath` is not set on per-repo calls.
   */
  workDir?: string;
  /** Command runner override (testing). */
  ghCommandFn?: GhCommandFn;
  /** Custom `gh` config directory. */
  ghConfigDir?: string;
  /** Cache directory for label lookups (testing — overrides the default). */
  labelCacheDir?: string;
  /** When true, report findings but do not file or update issues. */
  dryRun?: boolean;
}

/** Options for `syncBestPracticesForRepo`. */
export interface SyncRepoOptions {
  /** Path to local clone of the repo (overrides `workDir` derivation). */
  localRepoPath?: string;
  /** Command runner override (testing). */
  ghCommandFn?: GhCommandFn;
  /** Custom `gh` config directory. */
  ghConfigDir?: string;
  /** Cache directory for label lookups (testing — overrides the default). */
  labelCacheDir?: string;
  /** When true, report findings but do not file or update issues. */
  dryRun?: boolean;
}

/** Per-repo result of a sync run. */
export interface BestPracticesSyncResult {
  ok: boolean;
  repo: string;
  /** Number of findings detected by the auditor. */
  findings: number;
  /** True when a new issue was filed. */
  issueCreated: boolean;
  /** True when an existing issue was updated via a comment. */
  issueUpdated: boolean;
  /** Error message when the sync failed (still callable for the next repo). */
  error?: string;
}

/**
 * Issue title used for the follow-up issue. Stable so callers and
 * tests can refer to it without duplicating the literal.
 */
export const BEST_PRACTICES_ISSUE_TITLE = "Workflow best-practice findings";

/**
 * Marker embedded in the issue body. Used for idempotency — searching
 * for it returns the existing issue (if any) so a second run can
 * comment on it rather than create a duplicate.
 */
export const BEST_PRACTICES_MARKER = "<!-- vibe-coder:best-practices-sync -->";

/**
 * Stable source/category label applied to every filed issue (Issue #2335).
 *
 * Reuses the existing `best-practices` label already present in repos that
 * have run the idle-task best-practices scan; created on demand elsewhere.
 * Descriptive (not a reserved workflow label), so it is not stripped by
 * `label_security.ts`.
 */
export const BEST_PRACTICES_CATEGORY_LABEL = "best-practices";

/** Label colours (hex, no `#`) keyed by severity, plus the category label. */
const SEVERITY_LABEL_COLOURS: Record<BestPracticeFinding["severity"], string> =
  {
    high: "b60205",
    medium: "d93f0b",
    low: "fbca04",
  };
const CATEGORY_LABEL_COLOUR = "0e8a16";

/** Severity precedence, highest first. */
const SEVERITY_ORDER: BestPracticeFinding["severity"][] = [
  "high",
  "medium",
  "low",
];

/**
 * Derive the descriptive labels to apply for a set of findings (Issue #2335).
 *
 * Returns `severity:<highest>` (highest of `high > medium > low` across all
 * findings) followed by the stable `best-practices` category label. Pure and
 * exported so callers and tests can assert the derivation without any `gh`
 * interaction. Returns just the category label when `findings` is empty.
 */
export function deriveBestPracticeLabels(
  findings: Pick<BestPracticeFinding, "severity">[],
): string[] {
  const labels: string[] = [];
  const highest = SEVERITY_ORDER.find((sev) =>
    findings.some((f) => f.severity === sev)
  );
  if (highest) labels.push(`severity:${highest}`);
  labels.push(BEST_PRACTICES_CATEGORY_LABEL);
  return labels;
}

/** Resolve the colour for a derived label. */
export function labelColour(label: string): string {
  if (label.startsWith("severity:")) {
    const sev = label.slice(
      "severity:".length,
    ) as BestPracticeFinding["severity"];
    return SEVERITY_LABEL_COLOURS[sev] ?? CATEGORY_LABEL_COLOUR;
  }
  return CATEGORY_LABEL_COLOUR;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Adapt the module's `GhCommandFn` (prefixes `gh`, returns `CommandOutput`,
 * never throws) to the `LabelManagerDeps.ghCommandFn` shape (args without the
 * `gh` prefix, returns stdout, throws on failure). Each invocation is routed
 * through `retryWithBackoff` so transient `gh` failures get retry/backoff;
 * permanent failures (label/permission errors) propagate immediately for the
 * label helpers to handle silently.
 */
export function buildLabelDeps(
  runner: GhCommandFn,
  labelCacheDir?: string,
): LabelManagerDeps {
  const ghCommandFn = (args: string[]): Promise<string> =>
    retryWithBackoff(async () => {
      const out = await runner(["gh", ...args]);
      if (!out.success) {
        throw new Error(out.stderr || out.stdout || "gh command failed");
      }
      return out.stdout;
    });
  return labelCacheDir
    ? { ghCommandFn, cacheDir: labelCacheDir }
    : { ghCommandFn };
}

/**
 * Ensure each derived label exists in the repo, returning only those that
 * were ensured successfully. Recovers silently — a label that cannot be
 * created is omitted (never throws, never logs at error level).
 */
export async function ensureDerivedLabels(
  repo: string,
  labels: string[],
  deps: LabelManagerDeps,
): Promise<string[]> {
  const ensured: string[] = [];
  for (const label of labels) {
    const result = await ensureLabelExists(
      repo,
      label,
      labelColour(label),
      "",
      deps,
    );
    if (result.ok) ensured.push(label);
  }
  return ensured;
}

function defaultRunner(ghConfigDir?: string): GhCommandFn {
  return async (cmd: string[]): Promise<CommandOutput> => {
    const env = ghConfigDir
      ? { ...Deno.env.toObject(), GH_CONFIG_DIR: ghConfigDir }
      : undefined;
    const command = new Deno.Command(cmd[0]!, {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
      env,
    });
    const out = await command.output();
    const decoder = new TextDecoder();
    return {
      success: out.success,
      stdout: decoder.decode(out.stdout).trim(),
      stderr: decoder.decode(out.stderr).trim(),
    };
  };
}

/** Find the existing follow-up issue (open) by marker — returns its number or null. */
async function findExistingIssue(
  repo: string,
  runner: GhCommandFn,
): Promise<number | null> {
  const result = await runner([
    "gh",
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    `"${BEST_PRACTICES_MARKER}" in:body`,
    "--json",
    "number",
    "--limit",
    "1",
  ]);
  if (!result.success) return null;
  try {
    const issues = JSON.parse(result.stdout) as { number: number }[];
    return issues.length > 0 ? issues[0]!.number : null;
  } catch {
    return null;
  }
}

/**
 * Render a finding as a numbered Markdown section. Each finding
 * carries the check title, severity, workflow file, line number, and
 * suggested fix — matching the acceptance criteria in Issue #2102.
 */
function renderFinding(index: number, finding: BestPracticeFinding): string {
  return [
    `### ${
      index + 1
    }. \`${finding.checkId}\` — severity: **${finding.severity}**`,
    ``,
    `- **Workflow file:** \`.github/workflows/${finding.workflowFile}\``,
    `- **Line:** ${finding.lineNumber}`,
    ``,
    `**Suggested fix:**`,
    ``,
    finding.suggestedFix,
  ].join("\n");
}

/**
 * Build a Mermaid flowchart showing each affected workflow file.
 * Included in the issue body when there are 3+ findings so reviewers
 * can see the spread at a glance.
 */
export function buildMermaidDiagram(findings: BestPracticeFinding[]): string {
  const files = [...new Set(findings.map((f) => f.workflowFile))].sort();
  const lines: string[] = ["```mermaid", "flowchart LR"];
  lines.push(
    `    Audit["Best-practice audit"] --> Findings["${findings.length} finding(s)"]`,
  );
  for (let i = 0; i < files.length; i++) {
    const id = `F${i}`;
    lines.push(`    Findings --> ${id}["${files[i]}"]`);
  }
  lines.push("```");
  return lines.join("\n");
}

/** Build the body for a freshly-filed follow-up issue. */
export function buildIssueBody(
  repo: string,
  findings: BestPracticeFinding[],
): string {
  const parts: string[] = [];
  parts.push(`## Workflow best-practice findings`);
  parts.push(``);
  parts.push(
    `The workflow best-practice auditor detected **${findings.length}** finding(s) in \`${repo}\`.`,
  );
  parts.push(``);
  if (findings.length >= 3) {
    parts.push(`### Affected workflows`);
    parts.push(``);
    parts.push(buildMermaidDiagram(findings));
    parts.push(``);
  }
  parts.push(`## Findings`);
  parts.push(``);
  parts.push(
    findings.map((f, i) => renderFinding(i, f)).join("\n\n"),
  );
  parts.push(``);
  parts.push(`---`);
  parts.push(
    `*Raised automatically by VibeCoder best-practice sync (Issue #2102).*`,
  );
  parts.push(BEST_PRACTICES_MARKER);
  return parts.join("\n");
}

/** Build the body for a comment posted onto an existing follow-up issue. */
export function buildUpdateCommentBody(
  findings: BestPracticeFinding[],
): string {
  const parts: string[] = [];
  parts.push(`### Best-practice audit re-run — ${findings.length} finding(s)`);
  parts.push(``);
  if (findings.length === 0) {
    parts.push(
      `The auditor produced no findings on this run. The workflows previously flagged appear to have been resolved.`,
    );
  } else {
    parts.push(
      findings.map((f, i) => renderFinding(i, f)).join("\n\n"),
    );
  }
  parts.push(``);
  parts.push(BEST_PRACTICES_MARKER);
  return parts.join("\n");
}

/** Issue `gh issue create` with the given labels (each as a `--label` flag). */
async function runCreate(
  repo: string,
  body: string,
  labels: string[],
  runner: GhCommandFn,
): Promise<boolean> {
  const cmd = [
    "gh",
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    BEST_PRACTICES_ISSUE_TITLE,
    "--body",
    body,
  ];
  for (const label of labels) cmd.push("--label", label);
  const out = await runner(cmd);
  return out.success;
}

/**
 * Create a fresh follow-up issue (Issue #2335).
 *
 * Derives `severity:<highest>` + the `best-practices` category label from the
 * findings, ensures each exists (omitting any that cannot be created), then
 * files with `enhancement` plus the ensured labels. If the labelled create
 * fails, falls back to filing with no labels so the issue is never lost.
 * Returns true on success.
 */
async function createIssue(
  repo: string,
  body: string,
  findings: BestPracticeFinding[],
  runner: GhCommandFn,
  labelCacheDir?: string,
): Promise<boolean> {
  const deps = buildLabelDeps(runner, labelCacheDir);
  const ensured = await ensureDerivedLabels(
    repo,
    deriveBestPracticeLabels(findings),
    deps,
  );
  const labels = ["enhancement", ...ensured];

  if (await runCreate(repo, body, labels, runner)) return true;
  // Fallback: file with no labels rather than lose the issue.
  return await runCreate(repo, body, [], runner);
}

/**
 * Reconcile the derived `severity:*` + category labels onto an existing
 * issue (Issue #2335). Ensures each label exists, then adds it. Self-heals
 * label drift on subsequent sync runs. Recovers silently — never throws.
 */
async function reconcileLabels(
  repo: string,
  issueNumber: number,
  findings: BestPracticeFinding[],
  runner: GhCommandFn,
  labelCacheDir?: string,
): Promise<void> {
  const deps = buildLabelDeps(runner, labelCacheDir);
  const ensured = await ensureDerivedLabels(
    repo,
    deriveBestPracticeLabels(findings),
    deps,
  );
  for (const label of ensured) {
    // addLabelToIssue returns a Result and never throws.
    await addLabelToIssue(repo, issueNumber, label, deps);
  }
}

/** Post a comment on an existing follow-up issue. */
async function commentOnIssue(
  repo: string,
  issueNumber: number,
  body: string,
  runner: GhCommandFn,
): Promise<boolean> {
  const result = await runner([
    "gh",
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    repo,
    "--body",
    body,
  ]);
  return result.success;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sync best-practice findings for a single repository.
 *
 * 1. Run the auditor against the local clone.
 * 2. If there are no findings, return without filing anything.
 * 3. If there are findings, search for an existing follow-up issue
 *    by marker. If one exists, post a comment with the new findings.
 *    Otherwise file a fresh issue.
 *
 * Dry-run mode skips all `gh` mutations but still reports the audit
 * result so operators can preview what would be filed.
 */
export async function syncBestPracticesForRepo(
  repo: string,
  options: SyncRepoOptions = {},
): Promise<BestPracticesSyncResult> {
  const runner = options.ghCommandFn ?? defaultRunner(options.ghConfigDir);

  const auditResult = await auditWorkflowBestPractices({
    repo,
    localRepoPath: options.localRepoPath,
  });

  if (!auditResult.ok) {
    return {
      ok: false,
      repo,
      findings: 0,
      issueCreated: false,
      issueUpdated: false,
      error: auditResult.error,
    };
  }

  const findings = auditResult.value.findings;
  if (findings.length === 0) {
    return {
      ok: true,
      repo,
      findings: 0,
      issueCreated: false,
      issueUpdated: false,
    };
  }

  if (options.dryRun) {
    return {
      ok: true,
      repo,
      findings: findings.length,
      issueCreated: false,
      issueUpdated: false,
    };
  }

  let existing: number | null = null;
  try {
    existing = await findExistingIssue(repo, runner);
  } catch (err) {
    return {
      ok: false,
      repo,
      findings: findings.length,
      issueCreated: false,
      issueUpdated: false,
      error: `Failed to look up existing issue: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (existing !== null) {
    const updated = await commentOnIssue(
      repo,
      existing,
      buildUpdateCommentBody(findings),
      runner,
    );
    // Reconcile the descriptive labels onto the existing issue so drift
    // self-heals (Issue #2335). Silent — never blocks the result.
    await reconcileLabels(
      repo,
      existing,
      findings,
      runner,
      options.labelCacheDir,
    );
    return {
      ok: updated,
      repo,
      findings: findings.length,
      issueCreated: false,
      issueUpdated: updated,
      error: updated ? undefined : "Failed to comment on existing issue",
    };
  }

  const created = await createIssue(
    repo,
    buildIssueBody(repo, findings),
    findings,
    runner,
    options.labelCacheDir,
  );
  return {
    ok: created,
    repo,
    findings: findings.length,
    issueCreated: created,
    issueUpdated: false,
    error: created ? undefined : "Failed to create follow-up issue",
  };
}

/**
 * Sync best-practice findings across every monitored repository.
 *
 * Iterates serially so a transient failure on one repo never blocks
 * the next. Each repo's `localRepoPath` is derived from `workDir`
 * (i.e. `<workDir>/<repoName>`), matching the convention used by
 * `workflow_sync.ts` and `gitignore_sync.ts`.
 */
export async function syncBestPracticesForAllRepos(
  options: SyncAllOptions,
): Promise<BestPracticesSyncResult[]> {
  const runner = options.ghCommandFn ?? defaultRunner(options.ghConfigDir);
  const results: BestPracticesSyncResult[] = [];
  for (const repo of options.repos) {
    if (!repo) continue;
    const localRepoPath = options.workDir
      ? `${options.workDir}/${repo.split("/").pop() ?? repo}`
      : undefined;
    const result = await syncBestPracticesForRepo(repo, {
      ghCommandFn: runner,
      localRepoPath,
      labelCacheDir: options.labelCacheDir,
      dryRun: options.dryRun,
    });
    results.push(result);
  }
  return results;
}
