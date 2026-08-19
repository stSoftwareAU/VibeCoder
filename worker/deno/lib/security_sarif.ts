/**
 * SARIF 2.1.0 emission for `security-scan` findings (Issue #3538, gap G2 of
 * the #3535 gap analysis).
 *
 * Visa VVAH's stage S9 emits **SARIF 2.1.0** and tags every finding with a
 * CWE id; VibeCoder emitted findings only as GitHub issues even though it
 * already *consumes* GitHub code-scanning alerts via the `alert-feed`
 * idle-task template. This module closes that half-open loop: it turns the
 * issues a security-scan just filed into a SARIF 2.1.0 document so the same
 * findings can be uploaded to GitHub code scanning, deduped against tool
 * alerts, and triaged in the shared code-scanning UI.
 *
 * This file is **pure** — it parses filed-issue text into structured findings
 * and builds the SARIF object. Uploading (gzip + `gh api`) lives in the
 * sibling `security_sarif_upload.ts` so the network side stays isolated and
 * the builder stays trivially unit-testable.
 *
 * Free-text carried out of an issue (title, message) is treated strictly as
 * data — never interpreted as instructions.
 *
 * Australian English throughout (behaviour, normalise, colour).
 */

/** The four triaged severities a security-scan finding may carry. */
export type SecuritySeverity = "critical" | "high" | "medium" | "low";

/** SARIF result levels GitHub code scanning understands. */
export type SarifLevel = "error" | "warning" | "note";

/** Tool driver name that appears in the uploaded SARIF run. */
export const SARIF_TOOL_NAME = "VibeCoder-security-scan";

/** Information URI for the tool driver. */
export const SARIF_TOOL_URI = "https://github.com/stSoftwareAU/VibeCoder";

/** Canonical SARIF 2.1.0 schema URL. */
export const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";

/**
 * A single structured finding extracted from a filed `security` issue,
 * ready to be turned into one SARIF rule + result.
 */
export interface SecuritySarifFinding {
  /** Stable `SEC-<hex>` id — the SARIF rule id and result fingerprint. */
  findingId: string;
  /** CWE id (e.g. `CWE-89`) tagged onto the rule, or `null` when absent. */
  cwe: string | null;
  /** Triaged severity, driving the SARIF level and GHAS security-severity. */
  severity: SecuritySeverity;
  /** Human-readable one-line message (issue title, emoji stripped). */
  message: string;
  /** Repo-relative source path, or `null` when the title carried none. */
  file: string | null;
  /** 1-based line number, or `null` when absent. */
  startLine: number | null;
}

/** The subset of a filed GitHub issue this module reads. */
export interface SecurityIssueLike {
  /** Issue title, e.g. `🟠 SQL injection in src/api/orders.ts:47`. */
  title: string;
  /** Issue body — carries the hidden finding-id and cwe markers. */
  body: string;
  /** Issue labels; `severity:*` is the authoritative severity source. */
  labels?: readonly string[];
}

// Hardcoded regexes — no dynamic RegExp, no ReDoS risk.
const FINDING_ID_RE = /<!--\s*finding-id:\s*(SEC-[A-Za-z0-9]+)\s*-->/i;
const CWE_RE = /<!--\s*cwe:\s*(CWE-\d+)\s*-->/i;
/** `... in <path>:<line>` — the Phase-4 title convention (emoji-prefixed). */
const TITLE_LOCATION_RE = /\bin\s+(\S+?):(\d+)\b/;
/** Emoji → severity fallback when a `severity:*` label is missing. */
const SEVERITY_EMOJI: ReadonlyMap<string, SecuritySeverity> = new Map([
  ["🔴", "critical"],
  ["🟠", "high"],
  ["🟡", "medium"],
  ["🟢", "low"],
]);
const SEVERITIES: ReadonlySet<string> = new Set([
  "critical",
  "high",
  "medium",
  "low",
]);

/** SARIF level for a triaged severity. */
export function severityToLevel(severity: SecuritySeverity): SarifLevel {
  switch (severity) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
      return "note";
  }
}

/**
 * GHAS `security-severity` numeric score (0.0–10.0, as a string) for a
 * triaged severity. GitHub buckets: critical ≥ 9.0, high 7.0–8.9,
 * medium 4.0–6.9, low 0.1–3.9.
 */
export function severityToScore(severity: SecuritySeverity): string {
  switch (severity) {
    case "critical":
      return "9.0";
    case "high":
      return "7.5";
    case "medium":
      return "5.0";
    case "low":
      return "2.5";
  }
}

/** Extract the stable `SEC-<hex>` finding id from an issue body, or null. */
export function extractFindingId(body: string): string | null {
  const m = FINDING_ID_RE.exec(body ?? "");
  return m?.[1] ?? null;
}

/** Extract and normalise the `CWE-<n>` id from an issue body, or null. */
export function extractCwe(body: string): string | null {
  const m = CWE_RE.exec(body ?? "");
  const cwe = m?.[1];
  return cwe ? `CWE-${cwe.slice(4)}` : null;
}

/**
 * Determine the finding's severity. The `severity:*` label is authoritative;
 * a leading title emoji is the fallback; `low` is the conservative default
 * when neither is present (a finding is never dropped for lack of severity).
 */
export function extractSeverity(issue: SecurityIssueLike): SecuritySeverity {
  for (const label of issue.labels ?? []) {
    const trimmed = String(label).trim().toLowerCase();
    if (trimmed.startsWith("severity:")) {
      const value = trimmed.slice("severity:".length);
      if (SEVERITIES.has(value)) return value as SecuritySeverity;
    }
  }
  for (const [emoji, severity] of SEVERITY_EMOJI) {
    if ((issue.title ?? "").includes(emoji)) return severity;
  }
  return "low";
}

/**
 * Parse the `<file>:<line>` location from a title (preferred) or body prose.
 * Returns `{ file: null, startLine: null }` when no location is present.
 */
export function extractLocation(
  title: string,
  body: string,
): { file: string | null; startLine: number | null } {
  for (const source of [title ?? "", body ?? ""]) {
    const m = TITLE_LOCATION_RE.exec(source);
    const file = m?.[1];
    const lineText = m?.[2];
    if (file && lineText) {
      const line = Number.parseInt(lineText, 10);
      if (Number.isFinite(line) && line > 0) {
        return { file, startLine: line };
      }
    }
  }
  return { file: null, startLine: null };
}

/** Strip a leading severity emoji (and following spaces) from a title. */
export function stripSeverityEmoji(title: string): string {
  let out = title ?? "";
  for (const emoji of SEVERITY_EMOJI.keys()) {
    if (out.startsWith(emoji)) {
      out = out.slice(emoji.length);
      break;
    }
  }
  return out.trim();
}

/**
 * Parse a filed `security` issue into a structured finding, or `null` when it
 * carries no `SEC-<hex>` finding-id marker (i.e. it is not a scanner finding —
 * e.g. an overflow tracker or an unrelated hand-filed issue).
 */
export function parseSecurityFinding(
  issue: SecurityIssueLike,
): SecuritySarifFinding | null {
  const findingId = extractFindingId(issue.body);
  if (!findingId) return null;
  const { file, startLine } = extractLocation(issue.title, issue.body);
  return {
    findingId,
    cwe: extractCwe(issue.body),
    severity: extractSeverity(issue),
    message: stripSeverityEmoji(issue.title) || findingId,
    file,
    startLine,
  };
}

/**
 * Parse many issues into findings, dropping non-findings and de-duplicating
 * by finding-id (first occurrence wins — stable across a run).
 */
export function parseSecurityFindings(
  issues: readonly SecurityIssueLike[],
): SecuritySarifFinding[] {
  const seen = new Set<string>();
  const findings: SecuritySarifFinding[] = [];
  for (const issue of issues) {
    const finding = parseSecurityFinding(issue);
    if (!finding) continue;
    if (seen.has(finding.findingId)) continue;
    seen.add(finding.findingId);
    findings.push(finding);
  }
  return findings;
}

/** A minimal typed view of the SARIF document this module builds. */
export interface SarifDocument {
  $schema: string;
  version: "2.1.0";
  runs: Array<Record<string, unknown>>;
}

/** Options for {@link buildSecuritySarif}. */
export interface BuildSarifOptions {
  /** Tool driver semantic version (defaults to `1.0.0`). */
  toolVersion?: string;
}

/**
 * Build a SARIF 2.1.0 document from structured findings.
 *
 * One rule per finding (rule id = the stable `SEC-<hex>`), one result per
 * finding referencing that rule. CWE ids ride on `rule.properties.tags` as
 * the GitHub-recognised `external/cwe/cwe-<n>` tag, and the GHAS
 * `security-severity` score maps our triaged severity into the code-scanning
 * severity buckets. A result gains a `physicalLocation` only when the finding
 * carried a parseable `<file>:<line>`; findings without one still emit a valid
 * location-less result rather than being silently dropped.
 */
export function buildSecuritySarif(
  findings: readonly SecuritySarifFinding[],
  options: BuildSarifOptions = {},
): SarifDocument {
  const toolVersion = options.toolVersion ?? "1.0.0";

  const rules = findings.map((f) => {
    const tags = ["security"];
    if (f.cwe) tags.push(`external/cwe/cwe-${f.cwe.slice(4)}`);
    return {
      id: f.findingId,
      name: f.findingId,
      shortDescription: { text: f.message },
      fullDescription: { text: f.message },
      defaultConfiguration: { level: severityToLevel(f.severity) },
      properties: {
        tags,
        "security-severity": severityToScore(f.severity),
      },
    };
  });

  const results = findings.map((f, index) => {
    const result: Record<string, unknown> = {
      ruleId: f.findingId,
      ruleIndex: index,
      level: severityToLevel(f.severity),
      message: { text: f.message },
      partialFingerprints: { vibeSecurityFindingId: f.findingId },
    };
    if (f.file && f.startLine) {
      result.locations = [
        {
          physicalLocation: {
            artifactLocation: { uri: f.file },
            region: { startLine: f.startLine },
          },
        },
      ];
    }
    return result;
  });

  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: SARIF_TOOL_NAME,
            informationUri: SARIF_TOOL_URI,
            version: toolVersion,
            rules,
          },
        },
        results,
      },
    ],
  };
}
