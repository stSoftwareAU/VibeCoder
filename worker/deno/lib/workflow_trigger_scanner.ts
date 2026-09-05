/**
 * Native workflow-trigger pre-filer for the github-actions-audit template
 * (Issue #2587, part of #2561).
 *
 * Flags test/lint/scan workflows that still trigger on **push to the
 * default branch**. Making those workflows PR-only stops them re-running
 * post-merge on the default branch (the duplicate-required-check problem
 * #2561 closes) while publishers keep firing on push.
 *
 * The check is deliberately conservative — it only files when both
 * signals are unambiguous:
 *
 *   - The workflow classifies as `test` with `high` confidence via
 *     {@link classifyWorkflow} (#2585). `deploy` and `ambiguous`
 *     workflows are left untouched: a publisher must keep its push
 *     trigger, and a mixed workflow needs a human eye.
 *   - Its `on:` block triggers a push that reaches the default branch
 *     (no branch filter → all branches; an explicit `branches:` list
 *     matching the default; a `branches-ignore:` list that does not
 *     exclude it). A push config that filters tags only never fires on a
 *     branch push, so it is not flagged.
 *
 * Each surviving finding is a `BP-TRIGGER-<workflow-basename>`
 * `severity:low` finding describing the fix: drop `push:` to the default
 * branch, keep `pull_request` / `schedule` / `workflow_dispatch`. The
 * scan itself raises no PR — the YAML fix rides a normal worker PR
 * through the pre-merge gate.
 *
 * Pure aside from reading the already-parsed/raw {@link WorkflowFile} —
 * callers read the files via `readWorkflowFiles`. Never throws on
 * malformed input.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { anyBranchMatches } from "./workflow_branch_glob.ts";
import { classifyWorkflow } from "./workflow_classifier.ts";
import {
  isFindingSuppressed,
  type WorkflowFile,
  type WorkflowFindingSeverity,
} from "./workflow_scan_common.ts";

/** A single push-to-default trigger finding for one test/lint workflow. */
export interface WorkflowTriggerFinding {
  /** Stable id `BP-TRIGGER-<workflow-basename>`. */
  findingId: string;
  /** Repo-relative workflow path, e.g. `.github/workflows/ci.yml`. */
  workflowPath: string;
  /** Always `low` — a CI-hygiene gap, not a security or correctness bug. */
  severity: WorkflowFindingSeverity;
  /** Issue title (carries the severity emoji prefix). */
  title: string;
  /** File the finding is raised against (the workflow path). */
  file: string;
  /** Best-effort 1-based line number for the cited `push:`/`on:` location. */
  lines: number;
  /** `## Why this matters` rationale. */
  whyItMatters: string;
  /** `## Suggested fix` guidance. */
  suggestedFix: string;
  /** `## Evidence` block. */
  evidence: string;
}

/** Options for {@link scanWorkflowTriggers}. */
export interface ScanWorkflowTriggersOptions {
  /**
   * The repo's default branch name (e.g. `main`). Required to decide
   * whether a `push:` trigger reaches the default branch. When omitted or
   * empty, no findings are produced (the caller could not resolve it).
   */
  defaultBranch?: string;
  /** Stable ids suppressed by prior triage — skip these findings. */
  suppressedIds?: Iterable<string>;
  /** Stable ids already open as findings — skip these findings. */
  knownOpenFindingIds?: Iterable<string>;
}

const LOW_EMOJI = "🟡";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Slugify a path fragment into `[a-z0-9-]` for the stable id. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Strip directory and extension from a workflow path → bare basename. */
function workflowBasename(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Read the `on:` trigger block from a parsed workflow.
 *
 * `@std/yaml` keeps `on` as a string key (YAML 1.2 core schema), but a
 * YAML 1.1 parser would coerce it to the boolean `true`. Check both so
 * the scanner is robust regardless of the parser's schema.
 */
export function readOnBlock(parsed: Record<string, unknown>): unknown {
  if ("on" in parsed) return parsed["on"];
  // Defensive: a YAML 1.1 parser coerces the `on` key to boolean true.
  const coerced = (parsed as Record<string, unknown>)[
    "true" as unknown as string
  ];
  return coerced;
}

/**
 * Does this workflow's `on:` block fire a push that reaches
 * `defaultBranch`?
 *
 *   - `on: push` (string) or `on: [push, …]` (array) → all branches → yes.
 *   - `on: { push: <null/empty> }` → all branches → yes.
 *   - `on: { push: { branches: [...] } }` → yes if a pattern matches.
 *   - `on: { push: { branches-ignore: [...] } }` → yes unless the default
 *     is in the ignore list.
 *   - `on: { push: { tags: [...] } }` with no branch filter → tag pushes
 *     only → no.
 *   - no `push` key at all → no.
 */
function pushTriggersDefaultBranch(
  onBlock: unknown,
  defaultBranch: string,
): boolean {
  if (typeof onBlock === "string") return onBlock === "push";
  if (Array.isArray(onBlock)) return onBlock.includes("push");
  if (!isRecord(onBlock)) return false;
  if (!("push" in onBlock)) return false;

  const push = onBlock["push"];
  // `push:` with an empty/null value triggers on every branch.
  if (push === null || push === undefined) return true;
  if (!isRecord(push)) return true;

  const branches = push["branches"];
  if (Array.isArray(branches)) {
    return anyBranchMatches(branches, defaultBranch);
  }
  const branchesIgnore = push["branches-ignore"];
  if (Array.isArray(branchesIgnore)) {
    return !anyBranchMatches(branchesIgnore, defaultBranch);
  }

  // No branch filter. If the push config filters tags only, it never
  // fires on a branch push, so the default branch is not reached.
  const hasTagFilter = Array.isArray(push["tags"]) ||
    Array.isArray(push["tags-ignore"]);
  if (hasTagFilter) return false;

  // `push: {}` or a push config with only path filters → all branches.
  return true;
}

/** Best-effort: 1-based line of a top-level `key:` (no indentation). */
function lineOfTopLevelKey(lines: readonly string[], key: string): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const unindented = line.replace(/^\s+/, "");
    if (line === unindented && unindented.startsWith(`${key}:`)) return i + 1;
  }
  return 1;
}

/**
 * Best-effort: 1-based line of the `push:` key under `on:`, falling back
 * to the `on:` line, then to line 1. Used only to anchor suppression and
 * the evidence citation.
 */
function lineOfPushTrigger(lines: readonly string[]): number {
  const onLine = lineOfTopLevelKey(lines, "on");
  // Start at the `on:` line itself (0-based index `onLine - 1`) so the inline
  // `on: push` form is genuinely handled, not just reached via the fallback.
  for (let i = onLine - 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s+push\s*:/.test(line)) return i + 1;
    // Inline form `on: push` / `on: [push, …]` sits on the `on:` line.
    if (i === onLine - 1 && /\bpush\b/.test(line)) return onLine;
  }
  return onLine;
}

/**
 * Scan every workflow file and return one {@link WorkflowTriggerFinding}
 * per test/lint/scan workflow that triggers on push to the default
 * branch.
 *
 * Behaviour:
 *   - Only `kind === "workflow"` files are scanned.
 *   - Unparseable workflows (parsed `null`) and non-record roots yield no
 *     finding.
 *   - Only `category === "test"` with `confidence === "high"` qualifies —
 *     `deploy` and `ambiguous` workflows are never flagged.
 *   - A finding suppressed by an in-source `best-practice-ignore:
 *     BP-TRIGGER-…` marker near its cited line is dropped.
 *   - Findings whose stable id appears in `suppressedIds` or
 *     `knownOpenFindingIds` are dropped (the LLM / a prior run owns them).
 *   - With no resolvable `defaultBranch`, no findings are produced.
 *
 * Findings are returned sorted by stable id for deterministic output.
 */
export function scanWorkflowTriggers(
  files: readonly WorkflowFile[],
  opts: ScanWorkflowTriggersOptions = {},
): WorkflowTriggerFinding[] {
  const defaultBranch = opts.defaultBranch?.trim();
  if (!defaultBranch) return [];

  const suppressed = new Set(opts.suppressedIds ?? []);
  const knownOpen = new Set(opts.knownOpenFindingIds ?? []);
  const findings: WorkflowTriggerFinding[] = [];

  for (const file of files) {
    if (file.kind !== "workflow") continue;
    if (!isRecord(file.parsed)) continue;

    const classification = classifyWorkflow(file.parsed);
    if (
      classification.category !== "test" || classification.confidence !== "high"
    ) {
      continue;
    }

    const onBlock = readOnBlock(file.parsed);
    if (!pushTriggersDefaultBranch(onBlock, defaultBranch)) continue;

    const basename = slugify(workflowBasename(file.path));
    const findingId = `BP-TRIGGER-${basename}`;
    if (suppressed.has(findingId)) continue;
    if (knownOpen.has(findingId)) continue;

    const lines = file.rawText.split("\n");
    const line = lineOfPushTrigger(lines);
    if (isFindingSuppressed(file.rawText, line, findingId, file.path)) continue;

    findings.push(buildFinding(file, findingId, line, defaultBranch));
  }

  findings.sort((a, b) => a.findingId.localeCompare(b.findingId));
  return findings;
}

function buildFinding(
  file: WorkflowFile,
  findingId: string,
  line: number,
  defaultBranch: string,
): WorkflowTriggerFinding {
  return {
    findingId,
    workflowPath: file.path,
    severity: "low",
    title: `${LOW_EMOJI} Test/lint workflow triggers on push to ` +
      `\`${defaultBranch}\` (\`${file.path}\`)`,
    file: file.path,
    lines: line,
    whyItMatters:
      "This is a test/lint/scan workflow that still triggers on push to " +
      `the default branch (\`${defaultBranch}\`). Once it is a required ` +
      "status check, every merge into the default branch re-runs it — a " +
      "duplicate of the run that already gated the pull request. The " +
      "duplicate post-merge run wastes CI minutes and can leave a red " +
      "tick on the default branch for a check that already passed on the " +
      "PR. Deploy/publish/release workflows are different — they must " +
      "keep firing on push — but a checker should gate the PR only.",
    suggestedFix:
      `Drop \`push:\` to \`${defaultBranch}\` from this workflow's \`on:\` ` +
      "block, keeping the PR and scheduled triggers. For example:\n\n" +
      "```yaml\non:\n  pull_request:\n  workflow_dispatch:\n  # schedule: " +
      "keep any existing cron trigger\n```\n\nIf the workflow needs to run " +
      "on pushes to non-default branches, narrow the `branches:` filter to " +
      `exclude \`${defaultBranch}\` rather than removing \`push:\` entirely.`,
    evidence: `\`${file.path}\`:${line} — test/lint workflow with a ` +
      `\`push:\` trigger reaching \`${defaultBranch}\``,
  };
}
