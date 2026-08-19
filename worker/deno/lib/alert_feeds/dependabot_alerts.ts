/**
 * Dependabot alerts fetcher (Issue #3392, part of #3386).
 *
 * Reads a repository's **open Dependabot alerts** filtered to
 * **high/critical severity only** and returns a normalised, typed list.
 * This is a pure fetch-and-normalise library — it files no issues and takes
 * no side effects beyond the injected `gh` call.
 *
 * Three outcomes are distinguished explicitly and must never be collapsed
 * into one another (fail-loud, Issue #3234):
 *
 *   - `alerts`            — 0..n normalised high/critical alerts.
 *   - `feed-unavailable`  — HTTP 403/404: the caller has no access, or
 *                           Dependabot alerts are disabled for the repo.
 *                           This is NOT the same as "zero alerts"; the
 *                           downstream fail-loud sub-issue (#3396-scope)
 *                           surfaces it as an explicit signal rather than a
 *                           silent zero-findings pass.
 *   - `error`             — any other hard failure (network, 5xx, malformed
 *                           response). Surfaced, never swallowed.
 *
 * Free-text advisory fields (e.g. `summary`) are carried verbatim as data,
 * never interpreted as instructions.
 *
 * The `gh` runner is dependency-injected so tests never hit the network,
 * matching the DI convention used across `idle_task_templates/`.
 *
 * Australian English throughout (behaviour, normalise, authorised).
 */

import { runGhCommand } from "../github.ts";

/** Severities this feed reports. High/critical only (Issue #3392 scope). */
export type AlertSeverity = "high" | "critical";

/** The high/critical severities retained after filtering. */
const REPORTED_SEVERITIES: ReadonlySet<string> = new Set(["high", "critical"]);

/** A single normalised open Dependabot alert. */
export interface DependabotAlert {
  /** Repo-scoped alert number (stable identifier within the repo). */
  number: number;
  /** GitHub Security Advisory id, e.g. `GHSA-xxxx-xxxx-xxxx` (or ""). */
  ghsaId: string;
  /** Affected package name, e.g. `lodash` (free text, verbatim). */
  packageName: string;
  /** Package ecosystem, e.g. `npm`, `pip`, `cargo` (free text, verbatim). */
  ecosystem: string;
  /** Advisory severity, filtered to high/critical. */
  severity: AlertSeverity;
  /** One-line advisory summary (free text, carried verbatim as data). */
  summary: string;
  /** Canonical GitHub URL for the alert. */
  htmlUrl: string;
}

/**
 * Discriminated outcome of {@link fetchDependabotAlerts}. The three kinds are
 * kept distinct so `feed-unavailable` is never collapsed into an empty
 * `alerts` list (Issue #3392 scope, Issue #3234 fail-loud).
 */
export type DependabotAlertsResult =
  | { kind: "alerts"; alerts: DependabotAlert[] }
  | { kind: "feed-unavailable"; status: 403 | 404; reason: string }
  | { kind: "error"; error: string };

/** Injected `gh` runner. Returns raw stdout; throws (with gh stderr) on failure. */
export type GhApiRunner = (args: string[]) => Promise<string>;

/** Matches a valid `owner/repo` slug (no whitespace, exactly one slash). */
const REPO_SLUG = /^[^/\s]+\/[^/\s]+$/;

/**
 * Build the `gh api` argument list for open high/critical Dependabot alerts.
 *
 * `state=open&severity=high,critical` filters server-side; `per_page=100`
 * plus `--paginate` guarantees every page is returned (gh merges the pages
 * into a single JSON array), so a repo with more than 100 open alerts is
 * never silently truncated. The in-code severity filter in
 * {@link normaliseDependabotAlerts} is retained as defence in depth.
 *
 * Pure helper (extracted for unit testing).
 */
export function buildDependabotAlertsArgs(repo: string): string[] {
  return [
    "api",
    `repos/${repo}/dependabot/alerts?state=open&severity=high,critical&per_page=100`,
    "--paginate",
  ];
}

/**
 * Extract the HTTP status code from a `gh` error message, if present.
 *
 * `runGhCommandRaw` embeds gh's stderr in the thrown Error message, e.g.
 * `gh command failed (exit 1): gh: Not Found (HTTP 404)`. Returns the parsed
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
 * Normalise the raw Dependabot alerts API array into typed alerts, filtered
 * to high/critical severity.
 *
 * The raw shape follows the GitHub REST Dependabot alerts response:
 * `security_advisory.{ghsa_id,severity,summary}`,
 * `security_vulnerability.package.{ecosystem,name}` (falling back to
 * `dependency.package`), and `html_url`.
 *
 * Throws when the payload is not a JSON array (a hard, surfaced error — the
 * caller must not treat a malformed response as "no alerts"). Individual
 * entries that are not objects, or whose severity is not high/critical, are
 * dropped by the severity filter — that is expected behaviour, not a silent
 * failure.
 *
 * Pure helper (extracted for unit testing).
 */
export function normaliseDependabotAlerts(raw: unknown): DependabotAlert[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `Expected a JSON array of Dependabot alerts, got ${
        raw === null ? "null" : typeof raw
      }`,
    );
  }

  const alerts: DependabotAlert[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;

    const advisory = asRecord(record.security_advisory) ?? {};
    const vulnerability = asRecord(record.security_vulnerability) ?? {};

    // Severity: prefer the advisory severity, fall back to the
    // per-vulnerability severity. Lower-cased for a stable comparison.
    const severityRaw = (str(advisory, "severity") ||
      str(vulnerability, "severity")).toLowerCase();
    if (!REPORTED_SEVERITIES.has(severityRaw)) continue;

    // Package/ecosystem: security_vulnerability.package first, then the
    // top-level dependency.package.
    const dependency = asRecord(record.dependency) ?? {};
    const pkg = asRecord(vulnerability.package) ??
      asRecord(dependency.package) ?? {};

    const numberRaw = record.number;
    const number = typeof numberRaw === "number" ? numberRaw : 0;

    alerts.push({
      number,
      ghsaId: str(advisory, "ghsa_id"),
      packageName: str(pkg, "name"),
      ecosystem: str(pkg, "ecosystem"),
      severity: severityRaw as AlertSeverity,
      summary: str(advisory, "summary"),
      htmlUrl: str(record, "html_url"),
    });
  }
  return alerts;
}

/**
 * Fetch a repository's open high/critical Dependabot alerts.
 *
 * @param repo  `owner/repo` slug.
 * @param runGh Injected `gh` runner (defaults to the retrying `runGhCommand`).
 * @returns A {@link DependabotAlertsResult} distinguishing alerts,
 *          feed-unavailable (403/404), and hard error. Never throws — every
 *          failure is surfaced as a typed result so the caller can fail loud.
 */
export async function fetchDependabotAlerts(
  repo: string,
  runGh: GhApiRunner = runGhCommand,
): Promise<DependabotAlertsResult> {
  const trimmed = (repo ?? "").trim();
  if (!REPO_SLUG.test(trimmed)) {
    return { kind: "error", error: `Invalid repo slug: "${repo}"` };
  }

  let raw: string;
  try {
    raw = await runGh(buildDependabotAlertsArgs(trimmed));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = parseHttpStatus(message);
    if (status === 403 || status === 404) {
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
      error: `Failed to parse Dependabot alerts JSON: ${message}`,
    };
  }

  try {
    return { kind: "alerts", alerts: normaliseDependabotAlerts(parsed) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", error: message };
  }
}
