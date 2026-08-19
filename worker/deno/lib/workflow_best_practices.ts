/**
 * Workflow best-practice auditor.
 *
 * Scans `.github/workflows/*.{yml,yaml}` for anti-patterns and emits
 * findings the calling layer can turn into follow-up issues. The
 * inaugural check is `pr-creator-token` — flagging
 * `peter-evans/create-pull-request` steps authenticated with
 * `GITHUB_TOKEN` (or no `token:` argument at all, which defaults to
 * `GITHUB_TOKEN`) instead of an org-level PAT.
 *
 * Architecture: each check implements the {@link BestPracticeCheck}
 * interface and is registered in {@link REGISTERED_CHECKS}. Adding a
 * new check is a single-entry append — the driver requires no changes.
 *
 * Issue #2101 (root-cause audit for #2094).
 */

import { parse as parseYaml } from "@std/yaml/parse";
import type { Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity of a best-practice finding. */
export type BestPracticeSeverity = "high" | "medium" | "low";

/**
 * A single workflow file, parsed and ready for inspection.
 *
 * Checks receive the parsed YAML for structural inspection and the
 * raw content for best-effort line-number resolution.
 */
export interface ParsedWorkflow {
  /** Workflow filename (e.g. "ci.yml"). */
  filename: string;
  /** Raw file contents (used for best-effort line-number resolution). */
  rawContent: string;
  /** YAML-parsed structure. `null` if parsing failed. */
  parsed: unknown;
}

/** A finding produced by a {@link BestPracticeCheck}. */
export interface BestPracticeFinding {
  /** Stable check identifier (e.g. "pr-creator-token"). */
  checkId: string;
  /** Workflow filename the finding was raised against. */
  workflowFile: string;
  /** Best-effort line number in the source file (1-based; 1 when unknown). */
  lineNumber: number;
  /** Severity inherited from the originating check. */
  severity: BestPracticeSeverity;
  /** Markdown-formatted remediation text suitable for a follow-up issue body. */
  suggestedFix: string;
}

/**
 * A single best-practice check.
 *
 * Checks are registered in {@link REGISTERED_CHECKS}. The driver
 * ({@link auditWorkflowBestPractices}) walks every registered check
 * against every parsed workflow file — adding a new check is one
 * append; no driver changes are required.
 */
export interface BestPracticeCheck {
  /** Stable identifier (e.g. "pr-creator-token"). */
  id: string;
  /** Short human title used in audit summaries. */
  title: string;
  /** Default severity for findings this check produces. */
  severity: BestPracticeSeverity;
  /** One-paragraph explanation plus suggested fix (used in follow-up issues). */
  description: string;
  /**
   * Inspect a parsed workflow and return a finding when the
   * anti-pattern is detected, or `null` otherwise.
   */
  detect(workflow: ParsedWorkflow): BestPracticeFinding | null;
}

/** Options for {@link auditWorkflowBestPractices}. */
export interface AuditWorkflowBestPracticesOptions {
  /** Repository in `owner/repo` form — echoed back in the result. */
  repo: string;
  /**
   * Path to a local clone of the repository. When provided, the
   * auditor reads `.github/workflows/*.{yml,yaml}` from the working
   * tree.
   */
  localRepoPath?: string;
  /**
   * Optional `gh` runner. Reserved for a future remote audit path —
   * not consulted when `localRepoPath` is provided. Kept in the
   * signature so callers can pass it through uniformly.
   */
  ghCommandFn?: (cmd: string[]) => Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
  }>;
  /**
   * Override the registered checks (test-only). Defaults to
   * {@link REGISTERED_CHECKS}.
   */
  checks?: BestPracticeCheck[];
}

/** Result of {@link auditWorkflowBestPractices}. */
export interface AuditWorkflowBestPracticesResult {
  /** Repository the audit was run against. */
  repo: string;
  /** Findings produced by the registered checks. */
  findings: BestPracticeFinding[];
}

// ---------------------------------------------------------------------------
// Check implementations
// ---------------------------------------------------------------------------

/**
 * `pr-creator-token` — flags `peter-evans/create-pull-request` steps
 * authenticated with `GITHUB_TOKEN` (explicit) or no `token:` key
 * (implicit default of `GITHUB_TOKEN`).
 *
 * When a PR is opened with `GITHUB_TOKEN`, GitHub deliberately
 * suppresses downstream workflow triggers — so the created PR sits
 * without CI checks until somebody pushes a new commit. The fix is to
 * authenticate with an org-level PAT and keep `GITHUB_TOKEN` as a
 * fallback (Issue #1636).
 */
const prCreatorTokenCheck: BestPracticeCheck = {
  id: "pr-creator-token",
  title:
    "peter-evans/create-pull-request authenticated with GITHUB_TOKEN suppresses downstream workflows",
  severity: "high",
  description:
    "When `peter-evans/create-pull-request` runs under `GITHUB_TOKEN`, " +
    "GitHub deliberately suppresses workflow triggers on the resulting " +
    "pull request — CI, labelling, and review automation never fire. " +
    "Authenticate with an org-level PAT (`ACTIONS_PUSH`) and keep " +
    "`GITHUB_TOKEN` as a fallback so the workflow still functions when " +
    "the PAT is unset locally.",
  detect(workflow: ParsedWorkflow): BestPracticeFinding | null {
    const steps = collectSteps(workflow.parsed);
    for (const step of steps) {
      const uses = step.uses;
      if (typeof uses !== "string") continue;
      if (!/^peter-evans\/create-pull-request(@|$)/.test(uses)) continue;

      // Decide whether this step is using the anti-pattern.
      const token = step.token;
      let isAntiPattern = false;
      if (token === undefined) {
        // No token key — defaults to GITHUB_TOKEN.
        isAntiPattern = true;
      } else if (typeof token === "string") {
        const safe = /ACTIONS_PUSH/.test(token);
        const usesGithubToken = /GITHUB_TOKEN/.test(token);
        if (!safe && usesGithubToken) {
          isAntiPattern = true;
        }
        // Non-GITHUB_TOKEN bespoke secret — out of scope for this check.
      }

      if (!isAntiPattern) continue;

      return {
        checkId: "pr-creator-token",
        workflowFile: workflow.filename,
        lineNumber: findUsesLine(workflow.rawContent, uses),
        severity: "high",
        suggestedFix: buildPrCreatorTokenFix(uses),
      };
    }
    return null;
  },
};

function buildPrCreatorTokenFix(uses: string): string {
  return [
    "Authenticate `peter-evans/create-pull-request` with the org-level PAT and",
    "fall back to `GITHUB_TOKEN` only when the secret is unset (Issue #1636):",
    "",
    "```yaml",
    `- uses: ${uses}`,
    "  with:",
    "    token: ${{ secrets.ACTIONS_PUSH || secrets.GITHUB_TOKEN }}",
    "```",
    "",
    "Using `GITHUB_TOKEN` directly causes GitHub to suppress downstream",
    "workflow triggers on the created pull request — CI checks, labels, and",
    "reviewer automation never fire until somebody pushes a new commit.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Registered checks
// ---------------------------------------------------------------------------

/**
 * Module-level registry of best-practice checks. Append new entries
 * here — the driver picks them up automatically.
 */
export const REGISTERED_CHECKS: readonly BestPracticeCheck[] = Object.freeze([
  prCreatorTokenCheck,
]);

/** Snapshot of the registered checks (defensive copy). */
export function getRegisteredChecks(): BestPracticeCheck[] {
  return [...REGISTERED_CHECKS];
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Audit a repository's workflows for best-practice violations.
 *
 * Reads `.github/workflows/*.{yml,yaml}` from `localRepoPath`, parses
 * each file, and runs every registered (or injected) check against
 * every workflow. Workflows that fail to parse are skipped — they
 * cannot trigger a finding either way, and surfacing a parse error
 * here would conflict with the dedicated YAML-validity checks
 * elsewhere in the stack.
 */
export async function auditWorkflowBestPractices(
  options: AuditWorkflowBestPracticesOptions,
): Promise<Result<AuditWorkflowBestPracticesResult, string>> {
  const checks = options.checks ?? getRegisteredChecks();

  const workflowsResult = await loadLocalWorkflows(options.localRepoPath);
  if (!workflowsResult.ok) return workflowsResult;

  const findings: BestPracticeFinding[] = [];
  for (const workflow of workflowsResult.value) {
    for (const check of checks) {
      const finding = check.detect(workflow);
      if (finding) findings.push(finding);
    }
  }

  return {
    ok: true,
    value: { repo: options.repo, findings },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadLocalWorkflows(
  localRepoPath: string | undefined,
): Promise<Result<ParsedWorkflow[], string>> {
  if (localRepoPath === undefined) {
    return {
      ok: false,
      error:
        "auditWorkflowBestPractices requires `localRepoPath` — remote audits are not yet implemented.",
    };
  }

  const dir = `${localRepoPath}/.github/workflows`;
  const workflows: ParsedWorkflow[] = [];

  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(dir);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { ok: true, value: [] };
    }
    return {
      ok: false,
      error: `Failed to read ${dir}: ${errorMessage(err)}`,
    };
  }

  try {
    for await (const entry of entries) {
      if (!entry.isFile) continue;
      if (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml")) {
        continue;
      }
      const path = `${dir}/${entry.name}`;
      let rawContent: string;
      try {
        rawContent = await Deno.readTextFile(path);
      } catch (err) {
        return {
          ok: false,
          error: `Failed to read ${path}: ${errorMessage(err)}`,
        };
      }

      let parsed: unknown = null;
      try {
        parsed = parseYaml(rawContent);
      } catch {
        // Skip unparseable workflows — they cannot trigger findings
        // and YAML validity is enforced by other checks in the stack.
        continue;
      }
      workflows.push({ filename: entry.name, rawContent, parsed });
    }
  } catch (err) {
    // `Deno.readDir` itself can throw on iteration (e.g. the directory
    // disappears mid-walk). Treat NotFound as empty, otherwise surface.
    if (err instanceof Deno.errors.NotFound) {
      return { ok: true, value: [] };
    }
    return {
      ok: false,
      error: `Failed to iterate ${dir}: ${errorMessage(err)}`,
    };
  }

  // Stable ordering keeps test assertions deterministic.
  workflows.sort((a, b) => a.filename.localeCompare(b.filename));
  return { ok: true, value: workflows };
}

interface NormalisedStep {
  uses?: string;
  token?: unknown;
}

/**
 * Walk every `jobs.<job>.steps[]` entry in the parsed workflow and
 * return a flat list of `{ uses, token }` records. Unknown shapes are
 * skipped silently — defensive parsing keeps the checks resilient to
 * partially-valid YAML.
 */
function collectSteps(parsed: unknown): NormalisedStep[] {
  if (!isRecord(parsed)) return [];
  const jobs = parsed.jobs;
  if (!isRecord(jobs)) return [];

  const out: NormalisedStep[] = [];
  for (const job of Object.values(jobs)) {
    if (!isRecord(job)) continue;
    const steps = job.steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!isRecord(step)) continue;
      const uses = typeof step.uses === "string" ? step.uses : undefined;
      const withArgs = isRecord(step.with) ? step.with : undefined;
      const token = withArgs?.token;
      out.push({ uses, token });
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Best-effort line-number resolution: find the first line containing
 * the `uses:` value and return its 1-based index. Returns 1 when the
 * needle is not found — callers treat the value as advisory.
 */
function findUsesLine(rawContent: string, uses: string): number {
  const lines = rawContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.includes(uses)) return i + 1;
  }
  return 1;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
