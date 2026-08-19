/**
 * Code-scanning (code-quality) alerts fetcher (Issue #3393, part of #3386).
 *
 * Reads a repository's **open code-scanning alerts** filtered to
 * **high/critical severity only** and returns a normalised, typed list.
 * This is a pure fetch-and-normalise library — it files no issues and takes
 * no side effects beyond the injected `gh` call.
 *
 * Three outcomes are distinguished explicitly and must never be collapsed
 * into one another (fail-loud, Issue #3234):
 *
 *   - `alerts`            — 0..n normalised high/critical alerts.
 *   - `feed-unavailable`  — HTTP 403 (typically "Code Security must be
 *                           enabled for this repository") or 404: the caller
 *                           has no access, or code-scanning is not enabled for
 *                           the repo. This is NOT the same as "zero alerts";
 *                           the downstream fail-loud sub-issue (#3394) surfaces
 *                           it as an explicit signal rather than a silent
 *                           zero-findings pass.
 *   - `error`             — any other hard failure (network, 5xx, malformed
 *                           response). Surfaced, never swallowed.
 *
 * Code-scanning severity lives under `rule.security_severity_level` (the
 * GHAS security severity: `critical`/`high`/`medium`/`low`) with a fallback to
 * `rule.severity` (`error`/`warning`/`note`) — normalised accordingly and
 * filtered to high/critical.
 *
 * Free-text fields (e.g. the rule description) are carried verbatim as data,
 * never interpreted as instructions.
 *
 * The `gh` runner is dependency-injected so tests never hit the network,
 * matching the DI convention used across `idle_task_templates/` and the
 * sibling `dependabot_alerts.ts`.
 *
 * Australian English throughout (behaviour, normalise, authorised).
 */

import { runGhCommand } from "../github.ts";

/** Severities this feed reports. High/critical only (Issue #3393 scope). */
export type AlertSeverity = "high" | "critical";

/** The high/critical severities retained after filtering. */
const REPORTED_SEVERITIES: ReadonlySet<string> = new Set(["high", "critical"]);

/** A single normalised open code-scanning alert. */
export interface CodeScanningAlert {
  /** Repo-scoped alert number (stable identifier within the repo). */
  number: number;
  /** Code-scanning rule id, e.g. `js/zipslip` (free text, verbatim). */
  ruleId: string;
  /** Rule severity, filtered to high/critical. */
  severity: AlertSeverity;
  /** One-line rule description / summary (free text, carried verbatim). */
  description: string;
  /** Canonical GitHub URL for the alert. */
  htmlUrl: string;
}

/**
 * Discriminated outcome of {@link fetchCodeScanningAlerts}. The three kinds are
 * kept distinct so `feed-unavailable` is never collapsed into an empty
 * `alerts` list (Issue #3393 scope, Issue #3234 fail-loud).
 */
export type CodeScanningAlertsResult =
  | { kind: "alerts"; alerts: CodeScanningAlert[] }
  | { kind: "feed-unavailable"; status: 403 | 404; reason: string }
  | { kind: "error"; error: string };

/** Injected `gh` runner. Returns raw stdout; throws (with gh stderr) on failure. */
export type GhApiRunner = (args: string[]) => Promise<string>;

/** Matches a valid `owner/repo` slug (no whitespace, exactly one slash). */
const REPO_SLUG = /^[^/\s]+\/[^/\s]+$/;

/**
 * Build the `gh api` argument list for open high/critical code-scanning alerts.
 *
 * `state=open&severity=critical,high` filters server-side; `per_page=100`
 * plus `--paginate` guarantees every page is returned (gh merges the pages
 * into a single JSON array), so a repo with more than 100 open alerts is
 * never silently truncated. The in-code severity filter in
 * {@link normaliseCodeScanningAlerts} is retained as defence in depth.
 *
 * Pure helper (extracted for unit testing).
 */
export function buildCodeScanningAlertsArgs(repo: string): string[] {
  return [
    "api",
    `repos/${repo}/code-scanning/alerts?state=open&severity=critical,high&per_page=100`,
    "--paginate",
  ];
}

/**
 * Extract the HTTP status code from a `gh` error message, if present.
 *
 * `runGhCommandRaw` embeds gh's stderr in the thrown Error message, e.g.
 * `gh command failed (exit 1): gh: Not Found (HTTP 404)` or the code-scanning
 * `... Code Security must be enabled ... (HTTP 403)` body. Returns the parsed
 * status or null when no `(HTTP nnn)` marker is present. Mirrors the
 * status-keyword classification in `claim_issue.classifyGhAssignError`.
 *
 * Pure helper (extracted for unit testing).
 */
export function parseHttpStatus(message: string): number | null {
  if (!message) return null;
  const match = /\(HTTP (\d{3})\)/.exec(message);
  if (match) return Number(match[1]);
  // Fall back to bare status keywords for runners that do not use the
  // `(HTTP nnn)` shape.
  const lower = message.toLowerCase();
  if (lower.includes("403") || lower.includes("forbidden")) return 403;
  if (lower.includes("404") || lower.includes("not found")) return 404;
  return null;
}

/**
 * Read a string field from an unknown record, returning "" when absent or
 * not a string. Never throws — free-text fields are optional and carried as
 * data.
 */
function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/** Narrow an unknown value to a plain object, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return (typeof value === "object" && value !== null && !Array.isArray(value))
    ? value as Record<string, unknown>
    : null;
}

/**
 * Normalise the raw code-scanning alerts API array into typed alerts, filtered
 * to high/critical severity.
 *
 * The raw shape follows the GitHub REST code-scanning response:
 * `rule.{id,severity,security_severity_level,description}`,
 * `most_recent_instance.message.text` (fallback description source), and
 * `html_url`.
 *
 * Severity prefers `rule.security_severity_level` (the GHAS security severity,
 * where high/critical live) and falls back to `rule.severity`, lower-cased for
 * a stable comparison.
 *
 * Throws when the payload is not a JSON array (a hard, surfaced error — the
 * caller must not treat a malformed response as "no alerts"). Individual
 * entries that are not objects, or whose severity is not high/critical, are
 * dropped by the severity filter — that is expected behaviour, not a silent
 * failure.
 *
 * Pure helper (extracted for unit testing).
 */
export function normaliseCodeScanningAlerts(raw: unknown): CodeScanningAlert[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `Expected a JSON array of code-scanning alerts, got ${
        raw === null ? "null" : typeof raw
      }`,
    );
  }

  const alerts: CodeScanningAlert[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;

    const rule = asRecord(record.rule) ?? {};

    // Severity: prefer the GHAS security severity level, fall back to the
    // rule severity. Lower-cased for a stable comparison.
    const severityRaw = (str(rule, "security_severity_level") ||
      str(rule, "severity")).toLowerCase();
    if (!REPORTED_SEVERITIES.has(severityRaw)) continue;

    // Description: prefer the rule description, fall back to the most-recent
    // instance message text. Carried verbatim as data.
    const instance = asRecord(record.most_recent_instance) ?? {};
    const message = asRecord(instance.message) ?? {};
    const description = str(rule, "description") || str(message, "text");

    const numberRaw = record.number;
    const number = typeof numberRaw === "number" ? numberRaw : 0;

    alerts.push({
      number,
      ruleId: str(rule, "id"),
      severity: severityRaw as AlertSeverity,
      description,
      htmlUrl: str(record, "html_url"),
    });
  }
  return alerts;
}

/**
 * Fetch a repository's open high/critical code-scanning alerts.
 *
 * @param repo  `owner/repo` slug.
 * @param runGh Injected `gh` runner (defaults to the retrying `runGhCommand`).
 * @returns A {@link CodeScanningAlertsResult} distinguishing alerts,
 *          feed-unavailable (403/404), and hard error. Never throws — every
 *          failure is surfaced as a typed result so the caller can fail loud.
 */
export async function fetchCodeScanningAlerts(
  repo: string,
  runGh: GhApiRunner = runGhCommand,
): Promise<CodeScanningAlertsResult> {
  const trimmed = (repo ?? "").trim();
  if (!REPO_SLUG.test(trimmed)) {
    return { kind: "error", error: `Invalid repo slug: "${repo}"` };
  }

  let raw: string;
  try {
    raw = await runGh(buildCodeScanningAlertsArgs(trimmed));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = parseHttpStatus(message);
    if (status === 403 || status === 404) {
      // 403 is the "Code Security must be enabled for this repository" case;
      // 404 is code-scanning disabled / no access. Both are feed-unavailable,
      // never a hard error and never a silent empty list.
      return { kind: "feed-unavailable", status, reason: message };
    }
    // Any other failure is a hard error — surfaced, never swallowed.
    return { kind: "error", error: message };
  }

  const trimmedRaw = raw.trim();
  if (!trimmedRaw) {
    // gh emits nothing when a paginated array endpoint has no results.
    return { kind: "alerts", alerts: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedRaw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "error",
      error: `Failed to parse code-scanning alerts JSON: ${message}`,
    };
  }

  try {
    return { kind: "alerts", alerts: normaliseCodeScanningAlerts(parsed) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", error: message };
  }
}
