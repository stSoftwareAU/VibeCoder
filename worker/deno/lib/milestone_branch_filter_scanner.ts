/**
 * Native milestone-branch-filter pre-filer for the github-actions-audit
 * template (Issue #3360).
 *
 * Flags CI quality workflows (test/lint/scan) whose `pull_request` branch
 * filter misses milestone feature branches. Milestone sub-issue PRs target
 * a shared `milestone/<name>` branch (Issue #1300); a workflow that
 * restricts `pull_request.branches` to, say, `[Develop, main]` never runs
 * on those PRs, so they merge into the milestone branch without the gate.
 *
 * The check is deliberately conservative — it only files when both
 * signals are unambiguous:
 *
 *   - The workflow classifies as `test` with `high` confidence via
 *     {@link classifyWorkflow}. `deploy` and `ambiguous` workflows are
 *     left untouched: a publisher/release workflow has no business running
 *     on every milestone PR, and a mixed workflow needs a human eye.
 *   - It has a `pull_request` trigger whose `branches:` list matches none
 *     of the milestone feature branches, **or** a `branches-ignore:` list
 *     that excludes them. A `pull_request` trigger with no branch filter
 *     already runs on every PR target (including milestone branches), so it
 *     is never flagged.
 *
 * Each surviving finding is a `BP-MILESTONE-FILTER-<workflow-basename>`
 * `severity:medium` finding describing the fix: add `milestone/*` to the
 * `pull_request.branches` filter. The scan itself raises no PR — the YAML
 * fix rides a normal worker PR through the pre-merge gate (Issue #3239
 * isolation: each repo enforces its own gate).
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

/** A single milestone-branch-filter finding for one CI quality workflow. */
export interface MilestoneBranchFilterFinding {
  /** Stable id `BP-MILESTONE-FILTER-<workflow-basename>`. */
  findingId: string;
  /** Repo-relative workflow path, e.g. `.github/workflows/ci.yml`. */
  workflowPath: string;
  /** Always `medium` — a real gate gap, backstopped by the final rollup PR. */
  severity: WorkflowFindingSeverity;
  /** Issue title (carries the severity emoji prefix). */
  title: string;
  /** File the finding is raised against (the workflow path). */
  file: string;
  /** Best-effort 1-based line number for the cited `pull_request:`/`on:`. */
  lines: number;
  /** `## Why this matters` rationale. */
  whyItMatters: string;
  /** `## Suggested fix` guidance. */
  suggestedFix: string;
  /** `## Evidence` block. */
  evidence: string;
}

/** Options for {@link scanMilestoneBranchFilters}. */
export interface ScanMilestoneBranchFiltersOptions {
  /** Stable ids suppressed by prior triage — skip these findings. */
  suppressedIds?: Iterable<string>;
  /** Stable ids already open as findings — skip these findings. */
  knownOpenFindingIds?: Iterable<string>;
}

const MEDIUM_EMOJI = "🟠";

/**
 * Representative milestone branch name (Issue #1300: `milestone/<slug>`).
 * A filter covers milestone PRs iff it matches this sample — so
 * `milestone/*`, `milestone/**`, and `**` all count as covering while
 * `[Develop, main]` does not.
 */
const MILESTONE_SAMPLE_BRANCH = "milestone/example";

/** The glob callers should add to close the gap. */
const MILESTONE_GLOB = "milestone/*";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Slug of a workflow's basename, as used in per-workflow finding ids
 * (`.github/workflows/gitleaks.yml` → `gitleaks`).
 *
 * Exported so sibling per-workflow pre-filers — the gitleaks-drift scanner
 * (Issue #598) — mint ids the same way instead of re-deriving the rule.
 */
export function workflowIdSlug(path: string): string {
  return slugify(workflowBasename(path));
}

/**
 * The stable id this scanner would emit for `path`.
 *
 * Exported so the gitleaks-drift scanner (Issue #598) can suppress its own
 * branch-gap finding when this scanner already owns the same gap for the
 * same workflow file.
 */
export function milestoneFindingIdForPath(path: string): string {
  return `BP-MILESTONE-FILTER-${workflowIdSlug(path)}`;
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
function readOnBlock(parsed: Record<string, unknown>): unknown {
  if ("on" in parsed) return parsed["on"];
  // Defensive: a YAML 1.1 parser coerces the `on` key to boolean true.
  return (parsed as Record<string, unknown>)["true" as unknown as string];
}

/**
 * Decide whether this workflow's `pull_request` trigger already covers
 * milestone feature branches.
 *
 *   - No `pull_request` key at all → not a PR gate → treated as covered
 *     (nothing to flag; the workflow does not gate PRs).
 *   - `on: pull_request` (string) or `on: [pull_request, …]` (array) → no
 *     branch filter → covers all PR targets → covered.
 *   - `pull_request: <null/empty>` → all PR targets → covered.
 *   - `pull_request: { branches: [...] }` → covered iff a pattern matches a
 *     `milestone/<slug>` branch.
 *   - `pull_request: { branches-ignore: [...] }` → covered unless the ignore
 *     list matches a milestone branch (i.e. milestone PRs are excluded).
 *   - `pull_request: { types/paths only }` → no branch filter → covered.
 *
 * Returns `"covered"` (no finding), `"gap"` (flag it), or `"none"` (no
 * `pull_request` trigger — no finding).
 */
function milestoneCoverage(
  onBlock: unknown,
): "covered" | "gap" | "none" {
  if (typeof onBlock === "string") {
    return onBlock === "pull_request" ? "covered" : "none";
  }
  if (Array.isArray(onBlock)) {
    return onBlock.includes("pull_request") ? "covered" : "none";
  }
  if (!isRecord(onBlock)) return "none";
  if (!("pull_request" in onBlock)) return "none";

  const pr = onBlock["pull_request"];
  // `pull_request:` with an empty/null value triggers on every PR target.
  if (pr === null || pr === undefined) return "covered";
  if (!isRecord(pr)) return "covered";

  const branches = pr["branches"];
  if (Array.isArray(branches)) {
    return anyBranchMatches(branches, MILESTONE_SAMPLE_BRANCH)
      ? "covered"
      : "gap";
  }
  const branchesIgnore = pr["branches-ignore"];
  if (Array.isArray(branchesIgnore)) {
    // Covered unless the ignore list explicitly excludes milestone PRs.
    return anyBranchMatches(branchesIgnore, MILESTONE_SAMPLE_BRANCH)
      ? "gap"
      : "covered";
  }

  // No branch filter (types/paths only, or `pull_request: {}`) → all PR
  // targets are gated, including milestone branches.
  return "covered";
}

/**
 * Milestone-PR coverage of a whole parsed workflow — `readOnBlock` plus
 * {@link milestoneCoverage}.
 *
 *   - `"covered"` — milestone PRs run this workflow.
 *   - `"gap"`     — it gates PRs but skips milestone branches.
 *   - `"none"`    — no `pull_request` trigger at all (or an unusable root).
 *
 * Exported so the gitleaks-drift scanner (Issue #598) reuses this exact
 * decision rather than duplicating the branch-filter reasoning.
 */
export function workflowMilestoneCoverage(
  parsed: unknown,
): "covered" | "gap" | "none" {
  if (!isRecord(parsed)) return "none";
  return milestoneCoverage(readOnBlock(parsed));
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
 * Best-effort: 1-based line of the `branches:` key under
 * `on: pull_request:`, falling back to the `pull_request:` line, then the
 * `on:` line, then line 1. Used only to anchor suppression and evidence.
 *
 * Exported for the gitleaks-drift scanner (Issue #598), which anchors its
 * branch-gap finding on the same line.
 */
export function lineOfPullRequestFilter(lines: readonly string[]): number {
  const onLine = lineOfTopLevelKey(lines, "on");
  let prLine = onLine;
  // Start at the 0-based index of the `on:` line (onLine is 1-based) so the
  // first iteration can detect the inline form on that same line.
  for (let i = onLine - 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s+pull_request\s*:/.test(line)) {
      prLine = i + 1;
      break;
    }
    // Inline form `on: pull_request` / `on: [pull_request, …]`.
    if (i === onLine - 1 && /\bpull_request\b/.test(line)) return onLine;
  }
  for (let i = prLine; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s+branches(-ignore)?\s*:/.test(line)) return i + 1;
    // Stop at the next same-or-lower-indent top-level trigger key.
    if (i > prLine - 1 && /^\S/.test(line)) break;
  }
  return prLine;
}

/**
 * Scan every workflow file and return one
 * {@link MilestoneBranchFilterFinding} per CI quality workflow whose
 * `pull_request` branch filter misses milestone feature branches.
 *
 * Behaviour:
 *   - Only `kind === "workflow"` files are scanned.
 *   - Unparseable workflows (parsed `null`) and non-record roots yield no
 *     finding.
 *   - Only `category === "test"` with `confidence === "high"` qualifies —
 *     `deploy` and `ambiguous` workflows are never flagged.
 *   - A finding suppressed by an in-source `best-practice-ignore:
 *     BP-MILESTONE-FILTER-…` marker near its cited line is dropped.
 *   - Findings whose stable id appears in `suppressedIds` or
 *     `knownOpenFindingIds` are dropped (the LLM / a prior run owns them).
 *
 * Findings are returned sorted by stable id for deterministic output.
 */
export function scanMilestoneBranchFilters(
  files: readonly WorkflowFile[],
  opts: ScanMilestoneBranchFiltersOptions = {},
): MilestoneBranchFilterFinding[] {
  const suppressed = new Set(opts.suppressedIds ?? []);
  const knownOpen = new Set(opts.knownOpenFindingIds ?? []);
  const findings: MilestoneBranchFilterFinding[] = [];

  for (const file of files) {
    if (file.kind !== "workflow") continue;
    if (!isRecord(file.parsed)) continue;

    const classification = classifyWorkflow(file.parsed);
    if (
      classification.category !== "test" || classification.confidence !== "high"
    ) {
      continue;
    }

    if (workflowMilestoneCoverage(file.parsed) !== "gap") continue;

    const findingId = milestoneFindingIdForPath(file.path);
    if (suppressed.has(findingId)) continue;
    if (knownOpen.has(findingId)) continue;

    const lines = file.rawText.split("\n");
    const line = lineOfPullRequestFilter(lines);
    if (isFindingSuppressed(file.rawText, line, findingId, file.path)) continue;

    findings.push(buildFinding(file, findingId, line));
  }

  findings.sort((a, b) => a.findingId.localeCompare(b.findingId));
  return findings;
}

function buildFinding(
  file: WorkflowFile,
  findingId: string,
  line: number,
): MilestoneBranchFilterFinding {
  return {
    findingId,
    workflowPath: file.path,
    severity: "medium",
    title: `${MEDIUM_EMOJI} CI quality workflow skips milestone PRs ` +
      `(\`${file.path}\`)`,
    file: file.path,
    lines: line,
    whyItMatters: "This is a CI quality workflow (test/lint/scan) whose " +
      "`pull_request` branch filter matches none of the milestone feature " +
      "branches. Milestone sub-issue PRs target a shared `milestone/<name>` " +
      "branch (planning delivery workflow), so with this filter the gate " +
      "never runs on those PRs and they merge into the milestone branch " +
      "unchecked. The gap is only caught later by the single rollup PR into " +
      "the default branch — every intermediate sub-issue PR merges without " +
      "this workflow gating it.",
    suggestedFix: `Add \`${MILESTONE_GLOB}\` to this workflow's ` +
      "`pull_request.branches` filter so the gate runs on milestone PRs " +
      "too. For example:\n\n" +
      "```yaml\non:\n  pull_request:\n    branches: [Develop, main, " +
      `${MILESTONE_GLOB}]\n\`\`\`\n\nMilestone branch names are ` +
      "`milestone/<slug>` with no nested slashes, so the single-level " +
      `\`${MILESTONE_GLOB}\` glob is sufficient.`,
    evidence: `\`${file.path}\`:${line} — CI quality workflow whose ` +
      "`pull_request` branch filter does not match `milestone/<slug>`",
  };
}
