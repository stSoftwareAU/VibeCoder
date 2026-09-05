/**
 * Workflow-run annotation-scan idle-task template (Issue #3488, parent #3485 —
 * the orchestration slice of the workflow-annotation-scan idle task, the 15th
 * canonical wrapper).
 *
 * `ci_fix` only reads annotations while fixing a *failing* run, so annotations
 * attached to *passing* runs (deprecated-runtime warnings and notices) have no
 * coverage today. This template wires the fetcher → classifier → filer flow of
 * the new annotation-scan idle task so the fleet seeds and runs it per repo on
 * a weekly cadence. It is **detect-and-file only** (per-repo isolation, Issue
 * #3239): the scan never opens a pull request and never fixes an annotation —
 * each filed issue rides the normal per-repo, label-driven `work-on` workflow
 * later.
 *
 *   - **Orchestrate, don't reimplement.** `runTask` calls the native fetcher
 *     (`workflow_annotation_fetcher.ts`, Issue #3486), then the version-agnostic
 *     classifier (Issue #3487), then files one deduped issue per annotation
 *     class (Issue #3489). The classify and file steps are injected so the
 *     sibling sub-issues own their logic; this template only sequences them and
 *     verifies the outcome.
 *   - **Outcome verified by snapshot-diff.** `runTask` snapshots the repo's
 *     open `workflow-annotation-scan`-labelled issues before and after filing
 *     and treats the difference as the newly-filed set (the `alert-feed` /
 *     `supply_chain_readiness` contract, via `idle_task_snapshot.ts`) — no JSON
 *     round-trip through a run's own output.
 *   - **Per-class dedup.** Each filed issue embeds a stable
 *     `<!-- annotation-class: … -->` marker; the next run reads every open
 *     `workflow-annotation-scan` issue's markers back and skips any class
 *     already open, so a re-run over the same annotations files nothing.
 *   - **Label-ensure first.** The `workflow-annotation-scan` label and the
 *     three `severity:*` labels are ensured up front — the label is not seeded
 *     anywhere else, so the first run must create it.
 *   - **shouldFile veto.** Mirroring `security-scan`, `shouldFile` refuses to
 *     queue a fresh wrapper while an un-triaged batch of this class's findings
 *     (or a prior wrapper) is still open.
 *   - **Fail-loud.** An unexpected fault forces a loud `ok: false` outcome —
 *     never a silent zero-findings green (Issue #3234).
 *   - **Weekly cadence.** `cooldownHours: 168` caps the scan to once per week
 *     per repo (enforced by `idle_task_cooldown_gate.ts`).
 *
 * Registration happens at module load — importing this file is the only thing
 * callers need to do.
 *
 * Australian English used throughout (behaviour, organisation, authorised).
 */

import {
  type IdleTaskBodyOptions,
  idleTaskPromptsDir,
  type IdleTaskRunOptions,
  type IdleTaskRunResult,
  type IdleTaskShouldFileOptions,
  type IdleTaskTemplate,
  registerTemplate,
} from "../idle_task_template.ts";
import { runGhCommand as defaultGhCommand } from "../github.ts";
import type { AlertDedupAuthorOptions } from "../alert_dedup_authors.ts";
import { hasFleetAuthoredOpenIssueTitled } from "../idle_task_wrapper_dedup.ts";
import { loadPrompt as defaultLoadPrompt } from "../prompt_manager.ts";
import {
  diffNewlyFiled,
  listOpenIssueNumbersByLabel,
  parseGhJsonArray,
} from "../idle_task_snapshot.ts";
import { ensureLabelExists as defaultEnsureLabelExists } from "../label_operations.ts";
import { SEVERITY_LABELS } from "../bulk_triage.ts";
import { buildAttributionFooter } from "../idle_task_attribution.ts";
import { RUN_ID_ENV_VAR } from "../run_id.ts";
import {
  fetchWorkflowRunAnnotations as defaultFetchAnnotations,
  type WorkflowRunAnnotation,
} from "../workflow_annotation_fetcher.ts";
import type { Result } from "../../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "workflow-annotation-scan";

const DESCRIPTION =
  "Scan recent workflow-run annotations (warnings and notices on passing " +
  "runs, which ci_fix never sees) and file one deduped issue per annotation " +
  "class in the repository itself. Detect-and-file — never opens a pull " +
  "request and never fixes an annotation.";

/** Label every filed workflow-annotation-scan finding (and the wrapper) carries. */
export const WORKFLOW_ANNOTATION_SCAN_LABEL = "workflow-annotation-scan";

/** Static wrapper title — dispatch matches against this string. */
export const WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE =
  "Scan recent workflow-run annotations";

/** Colour for the `workflow-annotation-scan` label. */
export const WORKFLOW_ANNOTATION_SCAN_LABEL_COLOUR = "0E8A16";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "workflow_annotation_scan";

/** Once-per-week-per-repo cap (enforced by `idle_task_cooldown_gate.ts`). */
const COOLDOWN_HOURS = 168;

/**
 * Body fingerprint uniquely identifying a workflow-annotation-scan wrapper.
 * Anchored to the prompt's H1 `# Workflow-Run Annotation Scan — …`.
 */
export const WORKFLOW_ANNOTATION_SCAN_BODY_FINGERPRINT =
  /^#+\s+Workflow-Run Annotation Scan\b/m;

/** Marker id prefix embedded in each filed finding for per-class dedup. */
const ANNOTATION_CLASS_MARKER_PREFIX = "annotation-class:";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity attached to an annotation-class finding. */
export type AnnotationSeverity = "high" | "medium" | "low";

/**
 * A single classified annotation finding — one deduped issue is filed per
 * entry. Produced by the classifier (Issue #3487) and rendered/filed by the
 * filer (Issue #3489); this template only sequences them.
 */
export interface WorkflowAnnotationFinding {
  /** Stable, version-agnostic dedup key (embedded as a body marker). */
  classKey: string;
  /** Issue title. */
  title: string;
  /** Issue body (fingerprint marker prepended by {@link renderFindingBody}). */
  body: string;
  /** Severity label suffix. */
  severity: AnnotationSeverity;
}

/** Injectable dependencies for {@link createWorkflowAnnotationScanTemplate}. */
export interface WorkflowAnnotationScanTemplateDeps {
  /**
   * Author-verification inputs for the wrapper dedup search
   * ({@link hasFleetAuthoredOpenIssueTitled}). Omitted — every
   * production caller — reads the configured fleet identity.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
  /** gh CLI runner used for snapshots, dedup, filing, and the wrapper veto. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Prompt loader — defaults to `loadPrompt`. */
  loadPromptFn?: (
    name: string,
    promptsDir?: string,
  ) => Promise<Result<string>>;
  /**
   * Ensure the `workflow-annotation-scan` label and the three `severity:*`
   * labels exist. Defaults to a per-label `ensureLabelExists` loop.
   */
  ensureLabelsFn?: (repo: string) => Promise<void>;
  /**
   * Fetch recent workflow-run annotations for the repo (Issue #3486). Defaults
   * to `fetchWorkflowRunAnnotations`. Tests inject a stub returning fixed
   * annotations (or throwing to exercise the fail-loud path).
   */
  fetchAnnotationsFn?: (repo: string) => Promise<WorkflowRunAnnotation[]>;
  /**
   * Classify raw annotations into deduped classes (Issue #3487). Defaults to
   * the not-yet-wired placeholder {@link defaultClassifyAnnotations}, which
   * returns no findings; the classifier sub-issue replaces this default.
   */
  classifyAnnotationsFn?: (
    repo: string,
    annotations: readonly WorkflowRunAnnotation[],
  ) => WorkflowAnnotationFinding[];
  /**
   * File a single finding, returning its issue number or `null` on gh failure
   * (Issue #3489). Defaults to {@link defaultFileFinding}.
   */
  fileFindingFn?: (
    repo: string,
    finding: WorkflowAnnotationFinding,
    footer: string,
    ghCommandFn: (args: string[]) => Promise<string>,
  ) => Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Marker + body helpers (pure)
// ---------------------------------------------------------------------------

/** Hidden HTML-comment marker embedding a class's dedup key. */
export function annotationClassMarker(classKey: string): string {
  return `<!-- ${ANNOTATION_CLASS_MARKER_PREFIX} ${classKey} -->`;
}

/**
 * Render the issue body for a single finding: the hidden class marker (the
 * dedup key the next run reads back), then the classifier/filer-supplied body,
 * then the attribution footer. The marker is rendered first so it is
 * byte-stable regardless of the finding's free-text content. Pure — no I/O.
 */
export function renderFindingBody(
  finding: WorkflowAnnotationFinding,
  footer: string,
): string {
  return [
    annotationClassMarker(finding.classKey),
    "",
    finding.body,
    "",
    footer,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Placeholder defaults (replaced by the sibling sub-issues)
// ---------------------------------------------------------------------------

/**
 * Placeholder classifier — returns no findings. The version-agnostic
 * classifier lands in Issue #3487 and is injected as `classifyAnnotationsFn`;
 * until then the production default files nothing (never a silent *success
 * marker* — the wrapper still reports "no findings" honestly).
 */
export function defaultClassifyAnnotations(
  _repo: string,
  _annotations: readonly WorkflowRunAnnotation[],
): WorkflowAnnotationFinding[] {
  return [];
}

/** File a single finding, returning its number or `null` on gh failure. */
async function defaultFileFinding(
  repo: string,
  finding: WorkflowAnnotationFinding,
  footer: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<number | null> {
  const body = renderFindingBody(finding, footer);
  const args: string[] = [
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    finding.title,
    "--body",
    body,
    "--label",
    WORKFLOW_ANNOTATION_SCAN_LABEL,
    "--label",
    `severity:${finding.severity}`,
  ];
  let raw: string;
  try {
    raw = await ghCommandFn(args);
  } catch {
    return null;
  }
  const m = raw.trim().match(/\/issues\/(\d+)\s*$/);
  if (!m || !m[1]) return null;
  const number = parseInt(m[1], 10);
  if (!Number.isFinite(number)) return null;
  return number;
}

// ---------------------------------------------------------------------------
// gh snapshot / dedup helpers
// ---------------------------------------------------------------------------

/**
 * Return the set of class keys already open as `workflow-annotation-scan`
 * findings, read back from each open issue's `<!-- annotation-class: … -->`
 * marker. A gh failure degrades to an empty set so the dedup never blocks
 * filing on a transient hiccup.
 */
async function listKnownOpenClassKeys(
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Set<string>> {
  const keys = new Set<string>();
  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      WORKFLOW_ANNOTATION_SCAN_LABEL,
      "--state",
      "open",
      "--json",
      "body",
      "--limit",
      "200",
    ]);
  } catch {
    return keys;
  }
  const marker = /<!--\s*annotation-class:\s*(\S+)\s*-->/g;
  for (const item of parseGhJsonArray(raw, "read annotation-class markers")) {
    if (item === null || typeof item !== "object") continue;
    const body = (item as { body?: unknown }).body;
    if (typeof body !== "string") continue;
    for (const m of body.matchAll(marker)) {
      if (m[1]) keys.add(m[1]);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Summary builder (pure)
// ---------------------------------------------------------------------------

/**
 * Render the close-comment summary for the wrapper idle-task issue.
 *
 *   - No newly-filed issues → `"no findings"`.
 *   - One or more newly-filed → `"Workflow-annotation scan complete. Filed N
 *     issues: #A, #B, …"` with numbers sorted ascending.
 *
 * Exported so tests can assert on the exact wording.
 */
export function renderWorkflowAnnotationScanSummary(
  newlyFiled: readonly number[],
): string {
  if (newlyFiled.length === 0) return "no findings";
  const sorted = [...newlyFiled].sort((a, b) => a - b);
  const list = sorted.map((n) => `#${n}`).join(", ");
  return `Workflow-annotation scan complete. Filed ${sorted.length} issues: ${list}`;
}

// ---------------------------------------------------------------------------
// Template factory
// ---------------------------------------------------------------------------

/** Build the workflow-annotation-scan template using the supplied deps. */
export function createWorkflowAnnotationScanTemplate(
  deps: WorkflowAnnotationScanTemplateDeps = {},
): IdleTaskTemplate {
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const dedupAuthors = deps.dedupAuthors ?? {};
  const loadPromptFn = deps.loadPromptFn ??
    ((name, promptsDir) => defaultLoadPrompt(name, promptsDir));
  const ensureLabelsFn = deps.ensureLabelsFn ??
    (async (repo: string) => {
      await defaultEnsureLabelExists(
        repo,
        WORKFLOW_ANNOTATION_SCAN_LABEL,
        WORKFLOW_ANNOTATION_SCAN_LABEL_COLOUR,
        "A new class of workflow-run annotation (warning/notice)",
      );
      for (const severity of SEVERITY_LABELS) {
        await defaultEnsureLabelExists(repo, severity);
      }
    });
  const fetchAnnotationsFn = deps.fetchAnnotationsFn ??
    ((repo: string) => defaultFetchAnnotations({ repo, ghCommandFn }));
  const classifyAnnotationsFn = deps.classifyAnnotationsFn ??
    defaultClassifyAnnotations;
  const fileFindingFn = deps.fileFindingFn ?? defaultFileFinding;

  async function buildIssueBody(opts: IdleTaskBodyOptions): Promise<string> {
    // Issue #2077: the wrapper body IS the prompt, fully substituted at file
    // time so a developer reading the issue sees concrete values.
    const loaded = await loadPromptFn(PROMPT_NAME, idleTaskPromptsDir(opts));
    if (!loaded.ok) {
      throw new Error(
        `workflow-annotation-scan: failed to load prompt template ${PROMPT_NAME}: ` +
          loaded.error.message,
      );
    }
    const footer = buildAttributionFooter({
      template: NAME,
      runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
    });
    return loaded.value.replaceAll("{{ATTRIBUTION_FOOTER}}", footer);
  }

  function buildIssueTitle(_repo: string): string {
    return WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE;
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    // Mirror security-scan: refuse to pile on while an un-triaged batch of
    // findings (or a prior wrapper) is still open.
    const known = await listKnownOpenClassKeys(opts.repo, ghCommandFn);
    if (known.size > 0) return false;
    if (
      await hasFleetAuthoredOpenIssueTitled({
        repo: opts.repo,
        title: WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE,
        context: "workflow-annotation-scan wrapper",
        ghCommand: ghCommandFn,
        ...dedupAuthors,
      })
    ) {
      return false;
    }
    return true;
  }

  async function runTask(opts: IdleTaskRunOptions): Promise<IdleTaskRunResult> {
    try {
      // 1. Ensure the scan label + severity labels exist before any filing.
      await ensureLabelsFn(opts.repo);

      // 2. Snapshot open findings before the scan.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        WORKFLOW_ANNOTATION_SCAN_LABEL,
        ghCommandFn,
      );

      // 3. Fetch → classify. The fetcher reads the remote repo via `gh api`
      //    (Issue #3486), so no local checkout is needed.
      const annotations = await fetchAnnotationsFn(opts.repo);
      const findings = classifyAnnotationsFn(opts.repo, annotations);

      // 4. Read known-open class keys and skip classes already tracked.
      const knownOpen = await listKnownOpenClassKeys(opts.repo, ghCommandFn);

      // 5. File one deduped issue per new class.
      const footer = buildAttributionFooter({
        template: NAME,
        runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
      });
      const seen = new Set<string>(knownOpen);
      for (const finding of findings) {
        if (seen.has(finding.classKey)) continue;
        seen.add(finding.classKey);
        await fileFindingFn(opts.repo, finding, footer, ghCommandFn);
      }

      // 6. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        WORKFLOW_ANNOTATION_SCAN_LABEL,
        ghCommandFn,
      );
      const newlyFiled = diffNewlyFiled(before, after);

      return {
        ok: true,
        summary: renderWorkflowAnnotationScanSummary(newlyFiled),
      };
    } catch (err) {
      // Fail-loud (Issue #3234): an unexpected fault is a loud failure, never
      // a silent zero-findings green.
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `workflow-annotation-scan threw: ${message}`,
      };
    }
  }

  return {
    name: NAME,
    description: DESCRIPTION,
    buildIssueTitle,
    buildIssueBody,
    shouldFile,
    runTask,
    matchesIdleTaskBody: (body) =>
      WORKFLOW_ANNOTATION_SCAN_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: WORKFLOW_ANNOTATION_SCAN_LABEL,
    requiresStructuredOutput: true,
    cooldownHours: COOLDOWN_HOURS,
  };
}

/** Module-load registration so importing this file wires the template up. */
export const workflowAnnotationScanTemplate: IdleTaskTemplate =
  createWorkflowAnnotationScanTemplate();

registerTemplate(workflowAnnotationScanTemplate);
