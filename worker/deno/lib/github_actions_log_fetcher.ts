/**
 * Built-in GitHub Actions CI log provider (Issue #3580).
 *
 * GitHub Actions is the default CI provider every repo gets with zero
 * configuration, but until now the worker only saw check *annotations* —
 * a summary surface that routinely omits the stack trace, the failing
 * assertion diff, and the compiler error context the fix prompt needs.
 * This module fetches the failing job's actual log through the worker's
 * existing authenticated `gh` CLI (no new secret), trims it down to the
 * signal, and hands it to the same `{{PR_FAILURE_ACTIONS}}` prompt slot
 * an out-of-tree provider uses.
 *
 * A failing check that is not an Actions job (e.g. an external CI system's
 * commit status) yields a clean "not applicable" outcome so callers fall
 * through rather than error.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */

/** Provider id logged on every CI-fix run so fall-through is visible. */
export const GITHUB_ACTIONS_PROVIDER_ID = "github-actions";

/**
 * Hard cap on the excerpt handed to the fix prompt (16 KiB). The
 * prompt-facing excerpt is deliberately smaller than any fetch-side cap so
 * a multi-megabyte Actions log cannot blow the model context.
 */
export const MAX_ACTIONS_EXCERPT_BYTES = 16 * 1024;

/** Lines of context kept before the first failure marker. */
const FAILURE_LEAD_LINES = 30;
/** Lines of context kept after the first failure marker. */
const FAILURE_TRAIL_LINES = 120;
/** Lines of log tail always kept — failures usually surface at the end. */
const TAIL_LINES = 200;

/** Injectable `gh` CLI runner (returns stdout). */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** Result of resolving a failing check run to an Actions job id. */
export type ActionsJobResolution =
  | { kind: "job"; jobId: number }
  | { kind: "not-applicable"; reason: string }
  | { kind: "error"; error: string };

/** Result of the end-to-end provider call. */
export type ActionsLogOutcome =
  | {
    kind: "excerpt";
    providerId: typeof GITHUB_ACTIONS_PROVIDER_ID;
    jobId: number;
    excerpt: string;
  }
  | { kind: "not-applicable"; reason: string }
  | { kind: "error"; error: string };

/** Options shared by resolution and the end-to-end fetch. */
export interface ActionsLogOptions {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** GitHub check run id of the failing check. */
  checkRunId: string;
  /** Failing check name — used to pick the job from a run listing. */
  checkName?: string;
  /** Check `target_url` / `details_url` when the caller already has it. */
  targetUrl?: string;
  /** Injectable `gh` runner. */
  ghFn: GhCommandFn;
  /** Override the excerpt byte cap (defaults to {@link MAX_ACTIONS_EXCERPT_BYTES}). */
  maxBytes?: number;
}

/** Parsed shape of an Actions check `details_url`. */
export type ActionsCheckUrl =
  | { kind: "job"; runId: number; jobId: number }
  | { kind: "run"; runId: number }
  | { kind: "other" };

/**
 * Parse a check `details_url` into the Actions run/job ids it encodes.
 *
 * Actions check runs point at `/{owner}/{repo}/actions/runs/{run}/job/{job}`
 * (the `/jobs/{job}` spelling also occurs). A check-suite entry may only
 * carry the run. Anything else — another CI system's build URL, an empty
 * string — is `other`.
 */
export function parseActionsCheckUrl(url: string): ActionsCheckUrl {
  if (!url) return { kind: "other" };

  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }

  const job = /\/actions\/runs\/(\d+)\/jobs?\/(\d+)/.exec(path);
  if (job) {
    return { kind: "job", runId: Number(job[1]), jobId: Number(job[2]) };
  }

  const run = /\/actions\/runs\/(\d+)/.exec(path);
  if (run) return { kind: "run", runId: Number(run[1]) };

  return { kind: "other" };
}

/** Run `gh api <endpoint>` and return stdout, or a descriptive error. */
async function ghApi(
  ghFn: GhCommandFn,
  endpoint: string,
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  try {
    return { ok: true, body: await ghFn(["api", endpoint]) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `gh api ${endpoint} failed: ${message}` };
  }
}

/**
 * Terminal control sequences that Actions logs carry (colour, cursor,
 * OSC titles). Built from the escape byte at runtime — a literal control
 * character in a regex source trips `no-control-regex`.
 */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_RE = new RegExp(
  `${ESC}\\[[?0-9;]*[A-Za-z]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  "g",
);

/** Strip ANSI/OSC escape sequences from a fetched log. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** The refusal `gh` ≥ 2.9x gives for a body carrying escape sequences. */
const ESCAPE_SEQUENCE_REFUSAL = /allow-escape-sequences/i;

/**
 * Fetch a raw log body (Issue #4376). Actions logs always contain ANSI
 * colour codes, and `gh` ≥ 2.9x refuses to emit such a response unless
 * `--allow-escape-sequences` is passed — observed live as "No CI log
 * provider produced an excerpt … pass --allow-escape-sequences to output
 * it anyway", which left the CI-fix agent working blind. The flag is passed
 * first; a `gh` too old to know it ("unknown flag") gets the plain call.
 * The body is ANSI-stripped either way.
 */
async function ghApiLogs(
  ghFn: GhCommandFn,
  endpoint: string,
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  try {
    const body = await ghFn(["api", "--allow-escape-sequences", endpoint]);
    return { ok: true, body: stripAnsi(body) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      !/unknown flag|unknown option|unrecognised|unrecognized/i.test(message)
    ) {
      // The flagged call is the right one on a current gh; report its error
      // unless the flag itself was the problem.
      if (!ESCAPE_SEQUENCE_REFUSAL.test(message)) {
        return { ok: false, error: `gh api ${endpoint} failed: ${message}` };
      }
    }
  }
  // Older gh: no such flag (or a refusal we cannot explain) — plain call.
  const plain = await ghApi(ghFn, endpoint);
  return plain.ok ? { ok: true, body: stripAnsi(plain.body) } : plain;
}

/**
 * Resolve a failing check run to a GitHub Actions job id.
 *
 * Resolution order:
 * 1. A supplied `targetUrl` that already encodes the job id.
 * 2. The check-run API (`/repos/{repo}/check-runs/{id}`) — its
 *    `details_url` carries the job id, and `app.slug` tells us whether
 *    the check is an Actions job at all.
 * 3. When only a run id is known, the run's job listing, matched on
 *    check name and falling back to the first non-successful job.
 */
export async function resolveActionsJobId(
  opts: ActionsLogOptions,
): Promise<ActionsJobResolution> {
  const { repo, checkRunId, checkName, targetUrl, ghFn } = opts;

  if (targetUrl) {
    const parsed = parseActionsCheckUrl(targetUrl);
    if (parsed.kind === "job") return { kind: "job", jobId: parsed.jobId };
    if (parsed.kind === "run") {
      return await resolveJobFromRun(repo, parsed.runId, checkName, ghFn);
    }
    return {
      kind: "not-applicable",
      reason: `check target URL is not a GitHub Actions job URL: ${targetUrl}`,
    };
  }

  const response = await ghApi(ghFn, `repos/${repo}/check-runs/${checkRunId}`);
  if (!response.ok) return { kind: "error", error: response.error };

  let checkRun: Record<string, unknown>;
  try {
    const parsed = JSON.parse(response.body);
    if (typeof parsed !== "object" || parsed === null) {
      return { kind: "error", error: "check-run response was not an object" };
    }
    checkRun = parsed as Record<string, unknown>;
  } catch {
    return { kind: "error", error: "check-run response was not valid JSON" };
  }

  const app = checkRun["app"] as Record<string, unknown> | undefined;
  const slug = typeof app?.["slug"] === "string" ? app["slug"] : "";
  if (slug !== "" && slug !== GITHUB_ACTIONS_PROVIDER_ID) {
    return {
      kind: "not-applicable",
      reason: `check run is owned by '${slug}', not GitHub Actions`,
    };
  }

  const detailsUrl = typeof checkRun["details_url"] === "string"
    ? checkRun["details_url"]
    : "";
  const parsedDetails = parseActionsCheckUrl(detailsUrl);
  if (parsedDetails.kind === "job") {
    return { kind: "job", jobId: parsedDetails.jobId };
  }
  if (parsedDetails.kind === "run") {
    return await resolveJobFromRun(repo, parsedDetails.runId, checkName, ghFn);
  }

  return {
    kind: "not-applicable",
    reason: "check run has no GitHub Actions job URL",
  };
}

/** Pick the failing job of a workflow run by name, else the first failure. */
async function resolveJobFromRun(
  repo: string,
  runId: number,
  checkName: string | undefined,
  ghFn: GhCommandFn,
): Promise<ActionsJobResolution> {
  const response = await ghApi(
    ghFn,
    `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
  );
  if (!response.ok) return { kind: "error", error: response.error };

  let jobs: Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(response.body) as { jobs?: unknown };
    jobs = Array.isArray(parsed.jobs)
      ? parsed.jobs as Array<Record<string, unknown>>
      : [];
  } catch {
    return { kind: "error", error: "run jobs response was not valid JSON" };
  }

  const byName = checkName
    ? jobs.find((j) => j["name"] === checkName)
    : undefined;
  const failing = jobs.find((j) =>
    j["conclusion"] === "failure" || j["conclusion"] === "timed_out"
  );
  const chosen = byName ?? failing;
  const jobId = typeof chosen?.["id"] === "number" ? chosen["id"] : NaN;

  if (!Number.isFinite(jobId)) {
    return {
      kind: "not-applicable",
      reason: `workflow run ${runId} has no resolvable failing job`,
    };
  }
  return { kind: "job", jobId };
}

/**
 * Strip the ISO-8601 timestamp GitHub Actions prepends to every log
 * line. The timestamps burn context for no diagnostic signal. Lines
 * without a prefix are returned unchanged.
 */
function stripTimestamp(line: string): string {
  return line.replace(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s?/,
    "",
  );
}

/** Markers identifying the first genuine failure in an Actions log. */
const FAILURE_MARKERS = [
  /##\[error\]/i,
  /^\s*(?:error|fail(?:ed|ure)?)\b[:\s]/i,
  /\bBUILD FAILURE\b/,
  /\bFAILED\b/,
  /\bTests? run:.*Failures: [1-9]/,
  /\bAssertionError\b/,
  /\bException\b/,
];

function isFailureMarker(line: string): boolean {
  return FAILURE_MARKERS.some((re) => re.test(line));
}

/** Options for {@link summariseActionsLog}. */
export interface SummariseOptions {
  /** Hard byte cap (defaults to {@link MAX_ACTIONS_EXCERPT_BYTES}). */
  maxBytes?: number;
}

/**
 * Trim a raw GitHub Actions job log to the material worth putting in a
 * fix prompt: the window around the first failure marker plus the log
 * tail, with timestamp prefixes stripped and the result hard-capped.
 *
 * Keeps the window around the first failure marker plus the tail, which is
 * where a build log's root cause almost always sits.
 */
export function summariseActionsLog(
  rawLog: string,
  opts: SummariseOptions = {},
): string {
  const maxBytes = opts.maxBytes ?? MAX_ACTIONS_EXCERPT_BYTES;
  const lines = rawLog.split("\n").map(stripTimestamp);

  const failureIndex = lines.findIndex(isFailureMarker);
  const tailStart = Math.max(0, lines.length - TAIL_LINES);

  const kept: string[] = [];
  if (failureIndex >= 0 && failureIndex < tailStart) {
    const from = Math.max(0, failureIndex - FAILURE_LEAD_LINES);
    const to = Math.min(tailStart, failureIndex + FAILURE_TRAIL_LINES + 1);
    if (from > 0) kept.push(`[... ${from} earlier lines omitted ...]`);
    kept.push(...lines.slice(from, to));
    kept.push(`[... ${tailStart - to} lines omitted ...]`);
  } else if (tailStart > 0) {
    kept.push(`[... ${tailStart} earlier lines omitted ...]`);
  }
  kept.push(...lines.slice(tailStart));

  return capBytesPreservingTail(kept.join("\n"), maxBytes);
}

/**
 * Cap `text` at `maxBytes` UTF-8 bytes, keeping the tail and prefixing a
 * marker so a reader knows content was dropped.
 */
function capBytesPreservingTail(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;

  const marker = `[... truncated ${
    bytes.byteLength - maxBytes
  } bytes — showing tail ...]\n`;
  const budget = Math.max(0, maxBytes - encoder.encode(marker).byteLength);
  const tail = bytes.subarray(bytes.byteLength - budget);
  return marker + new TextDecoder("utf-8", { fatal: false }).decode(tail);
}

/**
 * Fetch and trim the log of the failing GitHub Actions job behind a
 * check run.
 *
 * Returns `not-applicable` when the check is not an Actions job (so the
 * caller falls through cleanly), `error` when resolution or retrieval
 * genuinely failed, and `excerpt` on success. Never throws.
 */
export async function fetchGithubActionsLogExcerpt(
  opts: ActionsLogOptions,
): Promise<ActionsLogOutcome> {
  const resolution = await resolveActionsJobId(opts);
  if (resolution.kind !== "job") return resolution;

  const response = await ghApiLogs(
    opts.ghFn,
    `repos/${opts.repo}/actions/jobs/${resolution.jobId}/logs`,
  );
  if (!response.ok) return { kind: "error", error: response.error };

  if (response.body.trim() === "") {
    return {
      kind: "error",
      error: `GitHub Actions job ${resolution.jobId} returned an empty log`,
    };
  }

  const excerpt = summariseActionsLog(response.body, {
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });

  return {
    kind: "excerpt",
    providerId: GITHUB_ACTIONS_PROVIDER_ID,
    jobId: resolution.jobId,
    excerpt,
  };
}
