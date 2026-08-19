/**
 * Native fetcher for recent GitHub Actions workflow-run annotations
 * (Issue #3486, part of #3485).
 *
 * `ci_fix` only reads annotations while fixing a *failing* run, so
 * annotations attached to *passing* runs (for example deprecated-runtime
 * warnings) have no coverage today. This module is the data-source half of
 * the new annotation-scan idle task: it retrieves recent workflow-run
 * annotations (failures, warnings and notices) for a monitored repo and
 * normalises each to a stable shape. It does **no** classification and
 * files **no** issues — everything downstream (classification, templating,
 * filing) lives in separate #3485 sub-issues.
 *
 * Design notes:
 *
 *   - The scan window is bounded by two named, injectable constants
 *     ({@link DEFAULT_ANNOTATION_SCAN_MAX_RUNS} and
 *     {@link DEFAULT_ANNOTATION_SCAN_WINDOW_DAYS}) rather than magic
 *     literals, so the parent idle task can tune it without editing this
 *     module.
 *   - The `gh` runner is injected (mirroring `GhCommandFn` in
 *     `workflow_scan_common.ts`) so the whole fetcher is unit-testable
 *     offline with no live `gh` calls.
 *   - It degrades gracefully: a malformed or `404` response for one run (or
 *     one check run) is skipped and logged, never aborting the whole fetch
 *     — mirroring the "degrades to nothing open" pattern in
 *     `create_all_idle_task_wrappers.ts`.
 *   - It is **runtime-version-agnostic**: the raw annotation text is
 *     captured verbatim; this module never filters on or hardcodes any
 *     runtime string (`node20`, etc.). Filtering/classification is a
 *     separate sub-issue.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import type { GhCommandFn } from "./workflow_scan_common.ts";

export type { GhCommandFn };

// ---------------------------------------------------------------------------
// Window constants
// ---------------------------------------------------------------------------

/**
 * Default upper bound on how many recent workflow runs a single fetch
 * inspects. Named (not a magic literal) so the parent idle task can tune the
 * window centrally.
 */
export const DEFAULT_ANNOTATION_SCAN_MAX_RUNS = 50;

/**
 * Default age window, in days: runs created more than this many days before
 * `now` are excluded. Named (not a magic literal) so the window is tunable.
 */
export const DEFAULT_ANNOTATION_SCAN_WINDOW_DAYS = 7;

/** GitHub caps `per_page` at 100 for the actions/runs listing. */
const MAX_PER_PAGE = 100;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * Annotation severity as reported by GitHub's check-runs annotations API
 * (`annotation_level`). Captured verbatim — never derived from message text.
 */
export type AnnotationLevel = "failure" | "warning" | "notice";

/**
 * A single workflow-run annotation, normalised to a stable shape that is
 * independent of the underlying GitHub API response.
 */
export interface WorkflowRunAnnotation {
  /** Severity reported by GitHub (`failure`/`warning`/`notice`). */
  level: AnnotationLevel;
  /** Annotation message body (verbatim; empty string when absent). */
  message: string;
  /** Annotation title (verbatim; empty string when absent). */
  title: string;
  /** Repo-relative path the annotation targets (empty string when absent). */
  path: string;
  /** Raw details attached to the annotation (empty string when absent). */
  rawDetails: string;
  /** Numeric id of the originating workflow run. */
  runId: number;
  /** `html_url` of the originating workflow run. */
  runUrl: string;
  /** Display name of the workflow (`name`; empty string when absent). */
  workflowName: string;
  /** Workflow definition path (`path`; empty string when absent). */
  workflowPath: string;
}

/** Options for {@link fetchWorkflowRunAnnotations}. */
export interface FetchWorkflowRunAnnotationsOptions {
  /** Target repo in `owner/repo` form. */
  repo: string;
  /** Injected `gh` CLI runner. */
  ghCommandFn: GhCommandFn;
  /** Upper bound on runs inspected. Defaults to {@link DEFAULT_ANNOTATION_SCAN_MAX_RUNS}. */
  maxRuns?: number;
  /** Age window in days. Defaults to {@link DEFAULT_ANNOTATION_SCAN_WINDOW_DAYS}. */
  windowDays?: number;
  /** Injectable clock for window filtering (defaults to wall-clock). */
  now?: () => Date;
  /** Optional structured logger for per-run skip/warning lines. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Internal run shape
// ---------------------------------------------------------------------------

interface WorkflowRunRef {
  id: number;
  name: string;
  path: string;
  htmlUrl: string;
  checkSuiteId: number | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// fetchWorkflowRunAnnotations
// ---------------------------------------------------------------------------

/**
 * Fetch recent workflow-run annotations for `repo`.
 *
 * Lists recent workflow runs (bounded by `maxRuns` and `windowDays`),
 * discovers the check runs behind each run, fetches each check run's
 * annotations, and returns them normalised to {@link WorkflowRunAnnotation}.
 *
 * Degrades gracefully: any per-run or per-check-run failure (network error,
 * `404`, malformed JSON) is skipped and logged; the fetch continues and
 * returns whatever it could collect. An empty repo (no runs, or no
 * annotations) returns `[]`.
 */
export async function fetchWorkflowRunAnnotations(
  opts: FetchWorkflowRunAnnotationsOptions,
): Promise<WorkflowRunAnnotation[]> {
  const gh = opts.ghCommandFn;
  const maxRuns = normalisePositive(
    opts.maxRuns,
    DEFAULT_ANNOTATION_SCAN_MAX_RUNS,
  );
  const windowDays = normalisePositive(
    opts.windowDays,
    DEFAULT_ANNOTATION_SCAN_WINDOW_DAYS,
  );
  const now = (opts.now ?? (() => new Date()))();
  const log = opts.log ?? (() => {});

  const runs = await listRecentRuns(
    opts.repo,
    maxRuns,
    windowDays,
    now,
    gh,
    log,
  );

  const out: WorkflowRunAnnotation[] = [];
  for (const run of runs) {
    try {
      const checkRunIds = await listCheckRunIds(
        opts.repo,
        run.checkSuiteId,
        gh,
        log,
      );
      for (const checkId of checkRunIds) {
        const raw = await fetchAnnotations(opts.repo, checkId, gh, log);
        for (const item of raw) {
          const normalised = normaliseAnnotation(item, run);
          if (normalised) out.push(normalised);
        }
      }
    } catch (err) {
      // Defence in depth: one bad run must never abort the whole fetch.
      log(
        `[annotation-fetcher] repo=${opts.repo} run=${run.id} action=skipped reason=${
          errText(err)
        }`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run listing
// ---------------------------------------------------------------------------

/**
 * List recent workflow runs for `repo`, filtered to the `windowDays` age
 * window and capped at `maxRuns`. Returns `[]` (never throws) on any error or
 * malformed response so the caller degrades to "nothing".
 */
async function listRecentRuns(
  repo: string,
  maxRuns: number,
  windowDays: number,
  now: Date,
  gh: GhCommandFn,
  log: (message: string) => void,
): Promise<WorkflowRunRef[]> {
  const perPage = Math.min(maxRuns, MAX_PER_PAGE);
  let raw: string;
  try {
    raw = await gh([
      "api",
      `repos/${repo}/actions/runs?per_page=${perPage}`,
      "--jq",
      "[.workflow_runs[] | {id, name, path, html_url, check_suite_id, created_at}]",
    ]);
  } catch (err) {
    log(
      `[annotation-fetcher] repo=${repo} action=list-runs-failed reason=${
        errText(err)
      }`,
    );
    return [];
  }

  const parsed = safeParseArray(raw);
  if (!parsed) {
    log(`[annotation-fetcher] repo=${repo} action=list-runs-malformed`);
    return [];
  }

  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const runs: WorkflowRunRef[] = [];
  for (const entry of parsed) {
    const run = toRunRef(entry);
    if (!run) continue;
    // Keep runs whose creation time is unknown/unparseable (never silently drop
    // an annotation-bearing run just because its timestamp is odd) or within
    // the window.
    const created = Date.parse(run.createdAt);
    if (Number.isFinite(created) && created < cutoff) continue;
    runs.push(run);
    if (runs.length >= maxRuns) break;
  }
  return runs;
}

/** Coerce one parsed run object into a {@link WorkflowRunRef}, or `null`. */
function toRunRef(entry: unknown): WorkflowRunRef | null {
  if (entry === null || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  const id = numberOrNull(rec.id);
  if (id === null) return null;
  return {
    id,
    name: str(rec.name),
    path: str(rec.path),
    htmlUrl: str(rec.html_url),
    checkSuiteId: numberOrNull(rec.check_suite_id),
    createdAt: str(rec.created_at),
  };
}

// ---------------------------------------------------------------------------
// Check-run discovery
// ---------------------------------------------------------------------------

/**
 * Discover the check-run ids behind a workflow run via its check suite.
 * Returns `[]` (never throws) on any error so a single bad run is skipped.
 */
async function listCheckRunIds(
  repo: string,
  checkSuiteId: number | null,
  gh: GhCommandFn,
  log: (message: string) => void,
): Promise<number[]> {
  if (checkSuiteId === null) return [];
  let raw: string;
  try {
    raw = await gh([
      "api",
      `repos/${repo}/check-suites/${checkSuiteId}/check-runs`,
      "--jq",
      "[.check_runs[] | {id}]",
    ]);
  } catch (err) {
    log(
      `[annotation-fetcher] repo=${repo} suite=${checkSuiteId} action=list-check-runs-failed reason=${
        errText(err)
      }`,
    );
    return [];
  }
  const parsed = safeParseArray(raw);
  if (!parsed) {
    log(
      `[annotation-fetcher] repo=${repo} suite=${checkSuiteId} action=list-check-runs-malformed`,
    );
    return [];
  }
  const ids: number[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const id = numberOrNull((entry as Record<string, unknown>).id);
    if (id !== null) ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Annotation fetch + normalisation
// ---------------------------------------------------------------------------

/**
 * Fetch the raw annotation objects for a single check run. Returns `[]`
 * (never throws) on any error or malformed response so one bad check run does
 * not abort the run.
 */
async function fetchAnnotations(
  repo: string,
  checkId: number,
  gh: GhCommandFn,
  log: (message: string) => void,
): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await gh([
      "api",
      `repos/${repo}/check-runs/${checkId}/annotations`,
    ]);
  } catch (err) {
    log(
      `[annotation-fetcher] repo=${repo} check=${checkId} action=annotations-failed reason=${
        errText(err)
      }`,
    );
    return [];
  }
  const parsed = safeParseArray(raw);
  if (!parsed) {
    log(
      `[annotation-fetcher] repo=${repo} check=${checkId} action=annotations-malformed`,
    );
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const entry of parsed) {
    if (entry !== null && typeof entry === "object") {
      out.push(entry as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * Normalise one raw annotation object (verbatim capture) onto its run.
 * Returns `null` when the object carries no usable content at all.
 */
function normaliseAnnotation(
  a: Record<string, unknown>,
  run: WorkflowRunRef,
): WorkflowRunAnnotation | null {
  const level = coerceLevel(a.annotation_level);
  const message = str(a.message);
  const title = str(a.title);
  const path = str(a.path);
  const rawDetails = str(a.raw_details);
  // Skip an entirely empty annotation (no level signal and no text).
  if (
    a.annotation_level === undefined &&
    message === "" &&
    title === "" &&
    rawDetails === ""
  ) {
    return null;
  }
  return {
    level,
    message,
    title,
    path,
    rawDetails,
    runId: run.id,
    runUrl: run.htmlUrl,
    workflowName: run.name,
    workflowPath: run.path,
  };
}

/**
 * Coerce GitHub's `annotation_level` into a known {@link AnnotationLevel}.
 * Unknown values fall back to `notice` (least severe) so an odd payload never
 * throws — the raw text is still captured verbatim in `message`/`rawDetails`.
 */
function coerceLevel(value: unknown): AnnotationLevel {
  if (value === "failure" || value === "warning" || value === "notice") {
    return value;
  }
  return "notice";
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Parse a JSON string into an array, or `null` on error / non-array. */
function safeParseArray(raw: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

/** Coerce a value to a trimmed string, or `""` when absent/non-string. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Coerce a finite number, or `null`. */
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Return `fallback` unless `value` is a positive finite number. */
function normalisePositive(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** Short message text for an unknown thrown value. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
