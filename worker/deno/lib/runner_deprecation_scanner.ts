/**
 * Runner deprecation scanner (Issue #2220, part of #2205).
 *
 * Reads the most recent GitHub Actions workflow runs for a repository
 * via an injected `gh` command runner and extracts deprecation warnings
 * emitted by the runner — most notably the "Node.js 20 actions are
 * deprecated" notice that flags actions pinned to SHAs the static
 * `.github/workflows/*.yml` audit cannot resolve.
 *
 * Design choices:
 *   - Pure function with injected `ghCommandFn` — no `Deno.Command`
 *     usage, so the unit tests run with no network and no shell.
 *   - Deterministic caps on the number of runs inspected and the total
 *     log bytes consumed, so a noisy repo cannot stall the
 *     best-practices scan.
 *   - On any `gh` failure (auth, network, parse) the scanner returns an
 *     empty array rather than throwing — this is a background quality
 *     audit, not a critical path.
 *
 * Findings are grouped by `(action, reason)` so a workflow that calls
 * `actions/checkout` from ten different jobs produces one finding, not
 * ten. The stable id recipe (`BP-RUNNER-<action-slug>-<reason-slug>`)
 * lets downstream code suppress, dedup, and re-issue findings idempotently.
 *
 * Australian English throughout (behaviour, organisation, recognised).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Function signature for running `gh` CLI commands. Returns stdout. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** A single runner-deprecation finding ready for the best-practices template. */
export interface DeprecationFinding {
  /** Deterministic id, e.g. `BP-RUNNER-actions-checkout-node20`. */
  stableId: string;
  /** Action coordinate, e.g. `actions/checkout`. */
  action: string;
  /** The pinned ref the runner reported — a SHA, `v4`, etc. */
  pinnedRef: string;
  /** Slug describing why it was flagged, e.g. `node20`, `set-output`. */
  reason: string;
  /** First workflow run URL where the warning appeared. */
  runUrl: string;
  /** Short, human-readable evidence string for the issue body. */
  evidence: string;
}

/** Options for `scanRecentRunsForDeprecations`. */
export interface RunnerDeprecationScanOptions {
  /** Maximum number of recent runs to enumerate (default 10). */
  runLimit?: number;
  /** Only inspect runs created within the last N days (default 14). */
  sinceDays?: number;
  /** Hard cap on total log bytes inspected across all runs (default ~2 MB). */
  logByteCap?: number;
  /** Override the clock — used only by tests. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Internal types and constants
// ---------------------------------------------------------------------------

interface RunSummary {
  databaseId: number;
  url: string;
  workflowName: string;
  conclusion: string;
  headBranch: string;
  createdAt: string;
}

const DEFAULT_RUN_LIMIT = 10;
const DEFAULT_SINCE_DAYS = 14;
const DEFAULT_LOG_BYTE_CAP = 2 * 1024 * 1024; // ~2 MB
const CONTEXT_LOOKBACK_LINES = 50;

// Matches "Node.js NN actions are deprecated"; capture group 1 is the version.
const NODE_DEPRECATION_RE = /Node\.js\s+(\d+)\s+actions are deprecated/i;

// Matches the runner's `set-output` / `save-state` deprecation warnings.
const SET_OUTPUT_RE = /[`'"]?set-output[`'"]?\s+command is deprecated/i;
const SAVE_STATE_RE = /[`'"]?save-state[`'"]?\s+command is deprecated/i;

// `owner/repo@ref` — the canonical GitHub Actions reference shape.
const ACTION_REF_RE =
  /([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)/g;

// Detects a "Run owner/repo@ref" line — the canonical step prelude in the log.
const RUN_ACTION_LINE_RE =
  /Run\s+([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enumerate recent workflow runs for `repo`, fetch their logs via the
 * injected `ghCommandFn`, and return one structured `DeprecationFinding`
 * per `(action, reason)` group recognised in those logs.
 *
 * Never throws — any `gh` failure is treated as "no findings".
 */
export async function scanRecentRunsForDeprecations(
  repo: string,
  ghCommandFn: GhCommandFn,
  opts: RunnerDeprecationScanOptions = {},
): Promise<DeprecationFinding[]> {
  const runLimit = clampPositiveInt(opts.runLimit, DEFAULT_RUN_LIMIT);
  const sinceDays = clampPositiveInt(opts.sinceDays, DEFAULT_SINCE_DAYS);
  const logByteCap = clampPositiveInt(opts.logByteCap, DEFAULT_LOG_BYTE_CAP);
  const now = opts.now ?? new Date();
  const cutoffMs = now.getTime() - sinceDays * 24 * 60 * 60 * 1000;

  const runs = await listRecentRuns(repo, ghCommandFn, runLimit);
  if (runs.length === 0) return [];

  const eligible = runs.filter((r) => isRecent(r.createdAt, cutoffMs));

  const findings = new Map<string, DeprecationFinding>();
  let bytesConsumed = 0;

  for (const run of eligible) {
    if (bytesConsumed >= logByteCap) break;
    const remaining = logByteCap - bytesConsumed;

    const log = await fetchRunLog(repo, run, ghCommandFn);
    if (log === null) continue;

    const bounded = log.length > remaining ? log.slice(0, remaining) : log;
    bytesConsumed += bounded.length;

    parseLogForFindings(bounded, run, findings);
  }

  return [...findings.values()];
}

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function isRecent(createdAt: string | undefined, cutoffMs: number): boolean {
  if (!createdAt) return true; // Be lenient — don't drop runs with no timestamp.
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return true;
  return t >= cutoffMs;
}

async function listRecentRuns(
  repo: string,
  ghCommandFn: GhCommandFn,
  runLimit: number,
): Promise<RunSummary[]> {
  try {
    const raw = await ghCommandFn([
      "run",
      "list",
      "--repo",
      repo,
      "--limit",
      String(runLimit),
      "--status",
      "completed",
      "--json",
      "databaseId,conclusion,headBranch,workflowName,url,createdAt",
    ]);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRunSummary).slice(0, runLimit);
  } catch {
    return [];
  }
}

function isRunSummary(value: unknown): value is RunSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.databaseId === "number" && typeof v.url === "string";
}

async function fetchRunLog(
  repo: string,
  run: RunSummary,
  ghCommandFn: GhCommandFn,
): Promise<string | null> {
  const logArg = run.conclusion === "failure" ? "--log-failed" : "--log";
  try {
    return await ghCommandFn([
      "run",
      "view",
      String(run.databaseId),
      "--repo",
      repo,
      logArg,
    ]);
  } catch {
    return null;
  }
}

function parseLogForFindings(
  log: string,
  run: RunSummary,
  findings: Map<string, DeprecationFinding>,
): void {
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    const nodeMatch = line.match(NODE_DEPRECATION_RE);
    if (nodeMatch && nodeMatch[1]) {
      const reason = `node${nodeMatch[1]}`;
      // Reset the global regex's state per line.
      const matcher = new RegExp(ACTION_REF_RE.source, "g");
      for (const m of line.matchAll(matcher)) {
        const action = m[1];
        const pinnedRef = m[2];
        if (!action || !pinnedRef) continue;
        recordFinding(findings, { action, pinnedRef, reason, run, line });
      }
      continue;
    }

    let reason: string | null = null;
    if (SET_OUTPUT_RE.test(line)) reason = "set-output";
    else if (SAVE_STATE_RE.test(line)) reason = "save-state";
    if (reason !== null) {
      const ctx = findActionContext(lines, i);
      if (ctx) {
        recordFinding(findings, {
          action: ctx.action,
          pinnedRef: ctx.pinnedRef,
          reason,
          run,
          line,
        });
      }
    }
  }
}

function findActionContext(
  lines: string[],
  fromIndex: number,
): { action: string; pinnedRef: string } | null {
  const start = Math.max(0, fromIndex - CONTEXT_LOOKBACK_LINES);
  for (let i = fromIndex; i >= start; i--) {
    const l = lines[i];
    if (l === undefined) continue;
    const m = l.match(RUN_ACTION_LINE_RE);
    if (m && m[1] && m[2]) {
      return { action: m[1], pinnedRef: m[2] };
    }
  }
  return null;
}

function recordFinding(
  findings: Map<string, DeprecationFinding>,
  args: {
    action: string;
    pinnedRef: string;
    reason: string;
    run: RunSummary;
    line: string;
  },
): void {
  const key = `${args.action}|${args.reason}`;
  const existing = findings.get(key);
  const snippet = truncate(args.line.trim(), 240);
  const evidenceLine = `${args.run.workflowName} (${args.run.url}): ${snippet}`;

  if (existing) {
    if (!existing.evidence.includes(evidenceLine)) {
      existing.evidence = `${existing.evidence}\n${evidenceLine}`;
    }
    return;
  }
  findings.set(key, {
    stableId: makeStableId(args.action, args.reason),
    action: args.action,
    pinnedRef: args.pinnedRef,
    reason: args.reason,
    runUrl: args.run.url,
    evidence: evidenceLine,
  });
}

function makeStableId(action: string, reason: string): string {
  return `BP-RUNNER-${slugify(action)}-${slugify(reason)}`;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function truncate(input: string, max: number): string {
  return input.length > max ? `${input.slice(0, max)}…` : input;
}
