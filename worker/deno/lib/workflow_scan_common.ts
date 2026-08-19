/**
 * Shared workflow-scan scaffolding for native github-actions-audit
 * pre-filers (Issue #2500, part of #2497).
 *
 * The `github-actions-audit` idle-task template (#4) currently checks
 * SHA-pinning, least-privilege `permissions:`, and script injection only
 * via the LLM prompt (`prompts/github_actions_audit/`), which is
 * non-deterministic and capped at six findings per run. The follow-up
 * sub-issues add native deterministic pre-filers for those three named
 * best practices; this module provides the plumbing they all share so
 * each check stays small and DRY — mirroring how
 * `runner_deprecation_filer.ts` was extracted as a shared module.
 *
 * It provides four pieces:
 *
 *   - {@link readWorkflowFiles} — enumerate and parse
 *     `.github/workflows/*.{yml,yaml}` and composite actions under
 *     `.github/actions/**\/action.{yml,yaml}`. Reuses the
 *     `collectSteps`/`isRecord`/local-read **patterns** from
 *     `workflow_best_practices.ts` without touching that module (it is
 *     wired only into the separate `setup/best_practices_sync.ts`
 *     pipeline).
 *   - {@link fileWorkflowFinding} — a generic finding filer mirroring
 *     `runner_deprecation_filer.ts`, matching the v7 Phase 4 body shape.
 *   - {@link isFindingSuppressed} — honour in-source
 *     `best-practice-ignore: BP-…` markers so native pre-filers respect
 *     suppression the same way the LLM Phase-3 triage does.
 *   - {@link makeStableId} — produce a deterministic `BP-`-prefixed
 *     stable id (the `BP-` prefix is required: `listKnownOpenFindingIds`
 *     defaults `idPrefix` to `BP-`, so a non-`BP-` id silently breaks
 *     dedup and the LLM re-files).
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { parse as parseYaml } from "@std/yaml/parse";
import {
  filterByFamily,
  findSuppressions,
  isSuppressed,
} from "./suppression_comments.ts";
import { buildAttributionFooter } from "./idle_task_attribution.ts";
import type { GhCommandFn } from "./runner_deprecation_scanner.ts";

export type { GhCommandFn };

// ---------------------------------------------------------------------------
// readWorkflowFiles
// ---------------------------------------------------------------------------

/** Severity of a native workflow-scan finding. */
export type WorkflowFindingSeverity = "high" | "medium" | "low";

/** Which kind of GitHub Actions material a {@link WorkflowFile} came from. */
export type WorkflowFileKind = "workflow" | "composite-action";

/**
 * A single GitHub Actions file, read and parsed and ready for
 * inspection by a native pre-filer.
 *
 * Pre-filers receive the parsed YAML for structural inspection and the
 * raw text for best-effort line-number resolution and suppression
 * scanning.
 */
export interface WorkflowFile {
  /** Path relative to `workDir`, e.g. `.github/workflows/ci.yml`. */
  path: string;
  /** Raw file contents. */
  rawText: string;
  /** YAML-parsed structure. `null` when parsing failed. */
  parsed: unknown;
  /** Whether this is a workflow or a composite action definition. */
  kind: WorkflowFileKind;
}

/**
 * Enumerate and read every GitHub Actions file under `workDir`:
 *
 *   - `.github/workflows/*.{yml,yaml}` (workflows)
 *   - `.github/actions/**\/action.{yml,yaml}` (composite actions)
 *
 * Each returned entry carries its repo-relative path, raw text, and
 * YAML-parsed structure (`null` when the file does not parse — the
 * pre-filer can still inspect the raw text). A repo with no
 * `.github/workflows` and no `.github/actions` returns an empty array
 * without throwing.
 *
 * Results are sorted by path so test assertions stay deterministic.
 */
export async function readWorkflowFiles(
  workDir: string,
): Promise<WorkflowFile[]> {
  const files: WorkflowFile[] = [];

  const workflowsDir = `${workDir}/.github/workflows`;
  for await (const name of listYamlFiles(workflowsDir)) {
    const rel = `.github/workflows/${name}`;
    const entry = await readWorkflowFile(
      `${workflowsDir}/${name}`,
      rel,
      "workflow",
    );
    if (entry) files.push(entry);
  }

  const actionsDir = `${workDir}/.github/actions`;
  for await (const abs of listCompositeActionFiles(actionsDir)) {
    const rel = abs.startsWith(`${workDir}/`)
      ? abs.slice(workDir.length + 1)
      : abs;
    const entry = await readWorkflowFile(abs, rel, "composite-action");
    if (entry) files.push(entry);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/** Read a single file and parse it. Returns `null` if the read fails. */
async function readWorkflowFile(
  absPath: string,
  relPath: string,
  kind: WorkflowFileKind,
): Promise<WorkflowFile | null> {
  let rawText: string;
  try {
    rawText = await Deno.readTextFile(absPath);
  } catch {
    return null;
  }
  let parsed: unknown = null;
  try {
    parsed = parseYaml(rawText);
  } catch {
    // Leave `parsed` null — the pre-filer can still inspect the raw text.
    parsed = null;
  }
  return { path: relPath, rawText, parsed, kind };
}

/** Yield the names of `*.yml`/`*.yaml` files directly inside `dir`. */
async function* listYamlFiles(dir: string): AsyncGenerator<string> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(dir);
  } catch {
    return; // Missing directory → no files.
  }
  const names: string[] = [];
  try {
    for await (const entry of entries) {
      if (!entry.isFile) continue;
      if (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml")) {
        continue;
      }
      names.push(entry.name);
    }
  } catch {
    return;
  }
  names.sort();
  for (const name of names) yield name;
}

/**
 * Recursively yield absolute paths of `action.yml`/`action.yaml` files
 * anywhere beneath `dir` (composite-action definitions).
 */
async function* listCompositeActionFiles(dir: string): AsyncGenerator<string> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(dir);
  } catch {
    return; // Missing directory → no files.
  }
  const subdirs: string[] = [];
  try {
    for await (const entry of entries) {
      const abs = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        subdirs.push(abs);
      } else if (
        entry.isFile &&
        (entry.name === "action.yml" || entry.name === "action.yaml")
      ) {
        yield abs;
      }
    }
  } catch {
    return;
  }
  subdirs.sort();
  for (const sub of subdirs) {
    yield* listCompositeActionFiles(sub);
  }
}

// ---------------------------------------------------------------------------
// makeStableId
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic `BP-`-prefixed stable id from `parts`.
 *
 * The id is `BP-` followed by the first 12 hex characters of SHA-256
 * over `parts.join("|")`, mirroring `security_finding_id.ts`. Callers
 * include a discriminator (e.g. `"github-actions-audit"`) as one of the
 * parts so ids never collide with another scan's findings for the same
 * file.
 *
 * The `BP-` prefix is required, not cosmetic:
 * `idle_task_snapshot.listKnownOpenFindingIds` defaults its `idPrefix`
 * to `BP-`, so a non-`BP-` id silently breaks dedup and the LLM
 * re-files the finding on the next run.
 */
export async function makeStableId(
  parts: readonly string[],
): Promise<string> {
  const canonical = parts.join("|");
  const encoded = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `BP-${hex.slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// isFindingSuppressed
// ---------------------------------------------------------------------------

/**
 * Is the finding `stableId` suppressed by an in-source
 * `best-practice-ignore: <id>` marker near line `lineNumber`?
 *
 * Workflow and composite-action files use YAML `#` comments, so the
 * hash-comment marker forms of `suppression_comments.ts` apply. A marker
 * suppresses the finding when it sits on the cited line or the line
 * immediately above it (the `eslint-disable-next-line` convention).
 *
 * Native pre-filers call this before filing so they honour suppression
 * the same way the LLM Phase-3 triage does.
 *
 * `filePath` is recorded against each marker in the per-run suppression
 * registry so the scan report can name where an active waiver lives
 * (Issue #3712).
 */
export function isFindingSuppressed(
  fileText: string,
  lineNumber: number,
  stableId: string,
  filePath?: string,
): boolean {
  // YAML comments are `#`-style — reuse the hash-comment marker forms.
  const suppressions = filterByFamily(
    findSuppressions(fileText, "sh", filePath ? { file: filePath } : {}),
    "best-practices",
  );
  return isSuppressed(stableId, suppressions, lineNumber);
}

// ---------------------------------------------------------------------------
// fileWorkflowFinding
// ---------------------------------------------------------------------------

/** Options for {@link fileWorkflowFinding}. */
export interface FileWorkflowFindingOptions {
  /** Target repo in `owner/repo` form. */
  repo: string;
  /** Stable `BP-`-prefixed finding id (embedded as the HTML marker). */
  findingId: string;
  /** Severity — attached as exactly one `severity:<level>` label. */
  severity: WorkflowFindingSeverity;
  /** Issue title (the caller supplies any severity emoji prefix). */
  title: string;
  /** File path the finding is raised against (cited in the prose lead). */
  file: string;
  /** Optional line(s) the finding cites, e.g. `42` or `42-50`. */
  lines?: string | number;
  /** One-paragraph `## Why this matters` rationale. */
  whyItMatters: string;
  /** One-paragraph (or diff-shaped) `## Suggested fix`. */
  suggestedFix: string;
  /** Optional `## Evidence` block (e.g. the offending source line). */
  evidence?: string;
  /** Idle-task template name for the attribution footer. */
  template: string;
  /** Worker run id for the attribution footer. */
  runId: string;
  /** Injected gh CLI runner. */
  ghCommandFn: GhCommandFn;
}

/**
 * File a native workflow-scan finding as a GitHub issue and return its
 * number plus the stable finding id.
 *
 * Mirrors `runner_deprecation_filer.ts` and matches the v7 Phase 4 body
 * shape:
 *
 *   - `<!-- finding-id: <id> -->` HTML marker on its own line at the top.
 *   - A prose lead naming the file, line(s), and severity.
 *   - A `## Why this matters` section.
 *   - A `## Suggested fix` section.
 *   - An optional `## Evidence` section.
 *   - The attribution footer as the final line, separated by a blank
 *     line.
 *
 * Attaches exactly the `github-actions-audit` label plus one
 * `severity:<level>` label — never an operational workflow label.
 *
 * Returns `{ number, findingId }` on success, or `null` when the gh call
 * throws or its output does not contain an `/issues/<n>` URL — the
 * caller logs it and continues.
 */
export async function fileWorkflowFinding(
  opts: FileWorkflowFindingOptions,
): Promise<{ number: number; findingId: string } | null> {
  const footer = buildAttributionFooter({
    template: opts.template,
    runId: opts.runId,
  });

  const location = opts.lines !== undefined && opts.lines !== ""
    ? `\`${opts.file}\`:${opts.lines}`
    : `\`${opts.file}\``;

  const bodyLines: string[] = [
    `<!-- finding-id: ${opts.findingId} -->`,
    "",
    `**File:** ${location}`,
    `**Severity:** ${opts.severity}`,
    "",
    "## Why this matters",
    "",
    opts.whyItMatters,
    "",
    "## Suggested fix",
    "",
    opts.suggestedFix,
  ];
  if (opts.evidence !== undefined && opts.evidence !== "") {
    bodyLines.push("", "## Evidence", "", opts.evidence);
  }
  bodyLines.push("", footer);
  const body = bodyLines.join("\n");

  const args: string[] = [
    "issue",
    "create",
    "--repo",
    opts.repo,
    "--title",
    opts.title,
    "--body",
    body,
    "--label",
    "github-actions-audit",
    "--label",
    `severity:${opts.severity}`,
  ];

  let raw: string;
  try {
    raw = await opts.ghCommandFn(args);
  } catch {
    return null;
  }

  const m = raw.trim().match(/\/issues\/(\d+)\s*$/);
  if (!m || !m[1]) return null;
  const number = parseInt(m[1], 10);
  if (!Number.isFinite(number)) return null;
  return { number, findingId: opts.findingId };
}
