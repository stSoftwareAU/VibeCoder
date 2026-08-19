/**
 * Native least-privilege `permissions:` pre-filer for the
 * github-actions-audit template (Issue #2502, part of #2497).
 *
 * Deterministically flags the decidable core of v7 prompt check #2
 * (least-privilege `permissions:`):
 *
 *   - (a) a workflow with **no top-level `permissions:`** AND a job with
 *     **no job-level `permissions:`** — that job inherits the broad
 *     repository default (`contents: write`, etc.); and
 *   - (b) any `permissions: write-all` grant at top or job level.
 *
 * Whether a `permissions:` block is present, and whether it is
 * `write-all`, is a pure structural YAML decision with low
 * false-positive risk — ideal for a native deterministic check. The
 * judgement-heavy cases are deliberately left to the LLM and the v7
 * prompt checks (#2/#9/#24): this scanner does **not** attempt
 * `id-token: write` scoping (#9) or `secrets: inherit` (#24), which both
 * need "does the job actually need it" reasoning.
 *
 * Severity is `medium` — a missing or over-broad permissions block is a
 * hardening gap in the v7 medium band, not an active compromise.
 *
 * Stable id is `BP-PERMISSIONS-<workflow-basename>[-<job>]`. The `BP-`
 * prefix is required: `idle_task_snapshot.listKnownOpenFindingIds`
 * defaults `idPrefix` to `BP-`, so a non-`BP-` id silently breaks dedup
 * and the LLM re-files.
 *
 * Pure aside from reading the already-parsed/raw `WorkflowFile` — callers
 * read the files via `readWorkflowFiles`.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import {
  isFindingSuppressed,
  type WorkflowFile,
  type WorkflowFindingSeverity,
} from "./workflow_scan_common.ts";

/** Which `permissions:` problem a finding describes. */
export type PermissionsFindingKind = "missing-block" | "write-all";

/** Where the problem sits in the workflow file. */
export type PermissionsFindingScope = "top" | "job";

/** A single least-privilege `permissions:` finding for one workflow/job. */
export interface WorkflowPermissionsFinding {
  /** Stable id `BP-PERMISSIONS-<basename>[-<job>]`. */
  findingId: string;
  /** `missing-block` (inherits broad default) or `write-all`. */
  kind: PermissionsFindingKind;
  /** `top` (workflow-level) or `job` (a single job). */
  scope: PermissionsFindingScope;
  /** Repo-relative workflow path, e.g. `.github/workflows/ci.yml`. */
  workflowPath: string;
  /** Job name when `scope === "job"`, otherwise undefined. */
  job?: string;
  /** Always `medium` — a hardening gap, not an active compromise. */
  severity: WorkflowFindingSeverity;
  /** Issue title (carries the severity emoji prefix). */
  title: string;
  /** File the finding is raised against (the workflow path). */
  file: string;
  /** Best-effort 1-based line number for the cited location. */
  lines: number;
  /** `## Why this matters` rationale. */
  whyItMatters: string;
  /** `## Suggested fix` guidance. */
  suggestedFix: string;
  /** `## Evidence` block. */
  evidence: string;
}

/** Options for {@link scanWorkflowPermissions}. */
export interface ScanWorkflowPermissionsOptions {
  /** Stable ids suppressed by prior triage — skip these findings. */
  suppressedIds?: Iterable<string>;
  /** Stable ids already open as findings — skip these findings. */
  knownOpenFindingIds?: Iterable<string>;
}

/** The GitHub Actions shorthand granting every write scope. */
const WRITE_ALL = "write-all";

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
 * Is `perms` a `write-all` grant? Only the scalar string shorthand
 * (`permissions: write-all`) counts — individual `write` scopes inside a
 * map are normal scoped grants, not a broad write-all.
 */
function isWriteAll(perms: unknown): boolean {
  return typeof perms === "string" && perms.trim().toLowerCase() === WRITE_ALL;
}

/**
 * Does `line` declare `key` as a YAML key — `<key>` followed by optional
 * spaces and a colon, ignoring leading indentation? Plain string matching
 * (no dynamic RegExp) so an attacker-influenced key cannot trigger
 * catastrophic backtracking.
 */
function lineDeclaresKey(line: string, key: string): boolean {
  const unindented = line.replace(/^\s+/, "");
  if (!unindented.startsWith(key)) return false;
  return unindented.slice(key.length).replace(/^[ \t]+/, "").startsWith(":");
}

/** Best-effort: 1-based line of a top-level `key:` (no indentation). */
function lineOfTopLevelKey(lines: readonly string[], key: string): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (indentOf(line) === 0 && lineDeclaresKey(line, key)) return i + 1;
  }
  return 1;
}

/** Best-effort: 1-based line of an indented job key `  <job>:`. */
function lineOfJobKey(lines: readonly string[], job: string): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (indentOf(line) > 0 && lineDeclaresKey(line, job)) return i + 1;
  }
  return 1;
}

/**
 * Best-effort: 1-based line of a job's own `permissions:` key. Locates
 * the job key, then scans forward for the first more-indented
 * `permissions:` before the next sibling key. Falls back to the job key
 * line when not found.
 */
function lineOfJobPermissions(lines: readonly string[], job: string): number {
  const jobLine = lineOfJobKey(lines, job);
  const jobIndent = indentOf(lines[jobLine - 1] as string);
  for (let i = jobLine; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (indent <= jobIndent) break; // reached the next sibling
    if (/^\s+permissions\s*:/.test(line)) return i + 1;
  }
  return jobLine;
}

function indentOf(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1]!.length : 0;
}

/**
 * Scan every workflow file for missing-block and write-all
 * `permissions:` problems and return one {@link
 * WorkflowPermissionsFinding} per affected workflow (top scope) or job
 * (job scope).
 *
 * Behaviour:
 *   - Only `kind === "workflow"` files are scanned — composite actions
 *     have no `permissions:` concept.
 *   - Unparseable workflows (parsed `null`) and non-record roots yield no
 *     finding.
 *   - A finding suppressed by an in-source `best-practice-ignore:
 *     BP-PERMISSIONS-…` marker near its cited line is dropped.
 *   - Findings whose stable id appears in `suppressedIds` or
 *     `knownOpenFindingIds` are dropped (the LLM / a prior run owns them).
 *
 * Findings are returned sorted by stable id for deterministic output.
 */
export function scanWorkflowPermissions(
  files: readonly WorkflowFile[],
  opts: ScanWorkflowPermissionsOptions = {},
): WorkflowPermissionsFinding[] {
  const suppressed = new Set(opts.suppressedIds ?? []);
  const knownOpen = new Set(opts.knownOpenFindingIds ?? []);
  const findings: WorkflowPermissionsFinding[] = [];

  for (const file of files) {
    if (file.kind !== "workflow") continue;
    if (!isRecord(file.parsed)) continue;

    const basename = slugify(workflowBasename(file.path));
    const lines = file.rawText.split("\n");
    const topPerms = file.parsed.permissions;
    const topHasBlock = topPerms !== undefined;

    // (b) top-level write-all.
    if (isWriteAll(topPerms)) {
      const id = `BP-PERMISSIONS-${basename}`;
      maybePush(
        findings,
        buildTopWriteAll(file, id, lineOfTopLevelKey(lines, "permissions")),
        {
          file,
          suppressed,
          knownOpen,
        },
      );
    }

    const jobs = file.parsed.jobs;
    if (!isRecord(jobs)) continue;

    for (const [jobName, jobValue] of Object.entries(jobs)) {
      const jobPerms = isRecord(jobValue) ? jobValue.permissions : undefined;
      const id = `BP-PERMISSIONS-${basename}-${slugify(jobName)}`;

      if (isWriteAll(jobPerms)) {
        // (b) job-level write-all takes precedence over missing-block.
        maybePush(
          findings,
          buildJobWriteAll(
            file,
            id,
            jobName,
            lineOfJobPermissions(lines, jobName),
          ),
          { file, suppressed, knownOpen },
        );
      } else if (!topHasBlock && jobPerms === undefined) {
        // (a) no top-level block and this job has no job-level block.
        maybePush(
          findings,
          buildMissingBlock(file, id, jobName, lineOfJobKey(lines, jobName)),
          { file, suppressed, knownOpen },
        );
      }
    }
  }

  findings.sort((a, b) => a.findingId.localeCompare(b.findingId));
  return findings;
}

/** Filter a candidate finding through suppression/dedup, then push it. */
function maybePush(
  out: WorkflowPermissionsFinding[],
  finding: WorkflowPermissionsFinding,
  ctx: {
    file: WorkflowFile;
    suppressed: Set<string>;
    knownOpen: Set<string>;
  },
): void {
  if (ctx.suppressed.has(finding.findingId)) return;
  if (ctx.knownOpen.has(finding.findingId)) return;
  if (
    isFindingSuppressed(
      ctx.file.rawText,
      finding.lines,
      finding.findingId,
      ctx.file.path,
    )
  ) {
    return;
  }
  out.push(finding);
}

const MEDIUM_EMOJI = "🟠";

function buildTopWriteAll(
  file: WorkflowFile,
  id: string,
  line: number,
): WorkflowPermissionsFinding {
  return {
    findingId: id,
    kind: "write-all",
    scope: "top",
    workflowPath: file.path,
    severity: "medium",
    title: `${MEDIUM_EMOJI} Workflow grants \`permissions: write-all\` ` +
      `(\`${file.path}\`)`,
    file: file.path,
    lines: line,
    whyItMatters:
      "This workflow grants `permissions: write-all` at the top level, " +
      "handing every `GITHUB_TOKEN` write scope to every job. If any " +
      "step is compromised (a poisoned dependency, an untrusted action, " +
      "an injected expression), the token can push code, publish " +
      "packages, or alter releases. Least privilege means granting only " +
      "the scopes each job needs.",
    suggestedFix:
      "Replace `permissions: write-all` with an explicit scoped block " +
      "granting only what is needed, e.g.\n\n```yaml\npermissions:\n" +
      "  contents: read\n```\n\nAdd narrower write scopes per job where a " +
      "job genuinely needs them.",
    evidence: `\`${file.path}\`:${line} — \`permissions: write-all\``,
  };
}

function buildJobWriteAll(
  file: WorkflowFile,
  id: string,
  job: string,
  line: number,
): WorkflowPermissionsFinding {
  return {
    findingId: id,
    kind: "write-all",
    scope: "job",
    workflowPath: file.path,
    job,
    severity: "medium",
    title: `${MEDIUM_EMOJI} Job \`${job}\` grants ` +
      `\`permissions: write-all\` (\`${file.path}\`)`,
    file: file.path,
    lines: line,
    whyItMatters:
      `Job \`${job}\` grants \`permissions: write-all\`, handing it every ` +
      "`GITHUB_TOKEN` write scope. If any step in this job is compromised, " +
      "the token can push code, publish packages, or alter releases. " +
      "Least privilege means granting only the scopes the job needs.",
    suggestedFix:
      `Replace this job's \`permissions: write-all\` with an explicit ` +
      "scoped block granting only what `" + job + "` needs, e.g.\n\n" +
      "```yaml\n    permissions:\n      contents: read\n```",
    evidence: `\`${file.path}\`:${line} — \`permissions: write-all\``,
  };
}

function buildMissingBlock(
  file: WorkflowFile,
  id: string,
  job: string,
  line: number,
): WorkflowPermissionsFinding {
  return {
    findingId: id,
    kind: "missing-block",
    scope: "job",
    workflowPath: file.path,
    job,
    severity: "medium",
    title: `${MEDIUM_EMOJI} Job \`${job}\` has no \`permissions:\` block ` +
      `(\`${file.path}\`)`,
    file: file.path,
    lines: line,
    whyItMatters: `Neither this workflow nor job \`${job}\` declares a ` +
      "`permissions:` block, so the job inherits the repository's broad " +
      "default `GITHUB_TOKEN` scopes (often `contents: write` and more). " +
      "If any step is compromised, the token can act with those broad " +
      "scopes. Declaring an explicit least-privilege block closes that gap.",
    suggestedFix:
      "Add an explicit `permissions:` block — at the top level to cover " +
      "every job, or on this job — granting only the scopes it needs, " +
      "e.g.\n\n```yaml\npermissions:\n  contents: read\n```\n\nUse " +
      "`permissions: {}` if the job needs no token scopes at all.",
    evidence: `\`${file.path}\`:${line} — job \`${job}\` (no ` +
      "`permissions:` block at workflow or job level)",
  };
}
