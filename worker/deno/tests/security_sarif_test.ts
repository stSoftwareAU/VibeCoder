/**
 * Tests for security_sarif.ts — the pure SARIF 2.1.0 builder and the
 * filed-issue → structured-finding extraction (Issue #3538, gap G2).
 *
 * Every test exercises the real functions against in-memory issue fixtures —
 * no filesystem, no network. The load-bearing behaviours are pinned:
 *
 *   - finding-id / cwe / severity / location extraction from a filed issue,
 *   - severity → SARIF level and GHAS security-severity score mapping,
 *   - the built document is valid SARIF 2.1.0 (version, one rule + result per
 *     finding, rule id = the stable SEC-<hex>, CWE tag present, location only
 *     when a file:line was parsed),
 *   - findings without a finding-id marker are dropped; duplicates deduped,
 *   - free text (message, artifact URI) is redacted as the document is built,
 *     because the uploader gzips it before any sink can scan it (Issue #1255).
 *
 * Australian English spelling used throughout (behaviour, colour).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildSecuritySarif,
  extractCwe,
  extractFindingId,
  extractLocation,
  extractSeverity,
  parseSecurityFinding,
  parseSecurityFindings,
  SARIF_TOOL_NAME,
  type SecuritySarifFinding,
  severityToLevel,
  severityToScore,
  stripSeverityEmoji,
} from "../lib/security_sarif.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";

function issue(
  title: string,
  body: string,
  labels: string[] = [],
): { title: string; body: string; labels: string[] } {
  return { title, body, labels };
}

const SQLI_BODY = [
  "<!-- finding-id: SEC-0a1b2c3d4e5f -->",
  "<!-- cwe: CWE-89 -->",
  "SQL injection in `src/api/orders.ts` line 47.",
].join("\n");

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

Deno.test("extractFindingId - reads the SEC-<hex> marker", () => {
  assertEquals(extractFindingId(SQLI_BODY), "SEC-0a1b2c3d4e5f");
});

Deno.test("extractFindingId - returns null when no marker present", () => {
  assertEquals(extractFindingId("no marker here"), null);
});

Deno.test("extractCwe - reads and normalises the CWE marker", () => {
  assertEquals(extractCwe(SQLI_BODY), "CWE-89");
  assertEquals(extractCwe("<!-- cwe: cwe-79 -->"), "CWE-79");
});

Deno.test("extractCwe - returns null when absent", () => {
  assertEquals(extractCwe("<!-- finding-id: SEC-abc123 -->"), null);
});

Deno.test("extractSeverity - prefers the severity:* label", () => {
  assertEquals(
    extractSeverity(issue("🟢 x", "", ["security", "severity:critical"])),
    "critical",
  );
});

Deno.test("extractSeverity - falls back to the title emoji", () => {
  assertEquals(extractSeverity(issue("🟠 SQLi in a.ts:1", "")), "high");
  assertEquals(extractSeverity(issue("🔴 RCE", "")), "critical");
});

Deno.test("extractSeverity - defaults to low when nothing is present", () => {
  assertEquals(extractSeverity(issue("plain title", "")), "low");
});

Deno.test("extractLocation - parses 'in <file>:<line>' from the title", () => {
  assertEquals(
    extractLocation("🟠 SQL injection in src/api/orders.ts:47", ""),
    { file: "src/api/orders.ts", startLine: 47 },
  );
});

Deno.test("extractLocation - null when no location present", () => {
  assertEquals(
    extractLocation("🟢 Weak config", "no location in body"),
    { file: null, startLine: null },
  );
});

Deno.test("stripSeverityEmoji - removes a leading severity emoji", () => {
  assertEquals(
    stripSeverityEmoji("🟠 SQL injection in a.ts:1"),
    "SQL injection in a.ts:1",
  );
  assertEquals(stripSeverityEmoji("No emoji"), "No emoji");
});

Deno.test("parseSecurityFinding - full extraction from a filed issue", () => {
  const finding = parseSecurityFinding(
    issue(
      "🟠 SQL injection in src/api/orders.ts:47",
      SQLI_BODY,
      ["security", "severity:high", "confidence:high"],
    ),
  );
  assert(finding);
  assertEquals(
    finding,
    {
      findingId: "SEC-0a1b2c3d4e5f",
      cwe: "CWE-89",
      severity: "high",
      message: "SQL injection in src/api/orders.ts:47",
      file: "src/api/orders.ts",
      startLine: 47,
    } satisfies SecuritySarifFinding,
  );
});

Deno.test("parseSecurityFinding - null when no finding-id marker", () => {
  assertEquals(
    parseSecurityFinding(issue("Some tracker", "no marker")),
    null,
  );
});

Deno.test("parseSecurityFindings - drops non-findings and dedups by id", () => {
  const findings = parseSecurityFindings([
    issue("🟠 A in a.ts:1", "<!-- finding-id: SEC-aaa -->", ["severity:high"]),
    issue("overflow tracker", "no marker"),
    issue("🟠 A dup in a.ts:1", "<!-- finding-id: SEC-aaa -->", [
      "severity:low",
    ]),
    issue("🔴 B in b.ts:2", "<!-- finding-id: SEC-bbb -->", [
      "severity:critical",
    ]),
  ]);
  assertEquals(findings.map((f) => f.findingId), ["SEC-aaa", "SEC-bbb"]);
});

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

Deno.test("severityToLevel - maps to SARIF levels", () => {
  assertEquals(severityToLevel("critical"), "error");
  assertEquals(severityToLevel("high"), "error");
  assertEquals(severityToLevel("medium"), "warning");
  assertEquals(severityToLevel("low"), "note");
});

Deno.test("severityToScore - maps into GHAS security-severity buckets", () => {
  assertEquals(severityToScore("critical"), "9.0");
  assertEquals(severityToScore("high"), "7.5");
  assertEquals(severityToScore("medium"), "5.0");
  assertEquals(severityToScore("low"), "2.5");
});

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const FINDINGS: SecuritySarifFinding[] = [
  {
    findingId: "SEC-aaa111",
    cwe: "CWE-89",
    severity: "high",
    message: "SQL injection in src/api/orders.ts:47",
    file: "src/api/orders.ts",
    startLine: 47,
  },
  {
    findingId: "SEC-bbb222",
    cwe: null,
    severity: "low",
    message: "Weak config (no location)",
    file: null,
    startLine: null,
  },
];

// deno-lint-ignore no-explicit-any -- deep JSON traversal in assertions.
function json(sarif: unknown): any {
  return sarif;
}

Deno.test("buildSecuritySarif - emits valid SARIF 2.1.0 top-level shape", () => {
  const sarif = json(buildSecuritySarif(FINDINGS));
  assertEquals(sarif.version, "2.1.0");
  assert(typeof sarif.$schema === "string" && sarif.$schema.includes("sarif"));
  assertEquals(sarif.runs.length, 1);
  assertEquals(sarif.runs[0].tool.driver.name, SARIF_TOOL_NAME);
});

Deno.test("buildSecuritySarif - one rule + one result per finding, rule id = SEC-<hex>", () => {
  const sarif = json(buildSecuritySarif(FINDINGS));
  const rules = sarif.runs[0].tool.driver.rules;
  const results = sarif.runs[0].results;
  assertEquals(rules.length, 2);
  assertEquals(results.length, 2);
  assertEquals(rules[0].id, "SEC-aaa111");
  assertEquals(results[0].ruleId, "SEC-aaa111");
  assertEquals(results[0].ruleIndex, 0);
});

Deno.test("buildSecuritySarif - CWE rides rule.properties.tags", () => {
  const sarif = json(buildSecuritySarif(FINDINGS));
  const rules = sarif.runs[0].tool.driver.rules;
  const tags = rules[0].properties.tags as string[];
  assert(tags.includes("security"));
  assert(tags.includes("external/cwe/cwe-89"));
  assertEquals(rules[0].properties["security-severity"], "7.5");
  // No CWE finding → only the security tag.
  assertEquals(rules[1].properties.tags, ["security"]);
});

Deno.test("buildSecuritySarif - physicalLocation only when file:line present", () => {
  const sarif = json(buildSecuritySarif(FINDINGS));
  const results = sarif.runs[0].results;
  const phys = results[0].locations[0].physicalLocation;
  assertEquals(phys.artifactLocation.uri, "src/api/orders.ts");
  assertEquals(phys.region.startLine, 47);
  // Location-less finding still emits a valid result — just no `locations`.
  assertEquals(results[1].locations, undefined);
  assertEquals(results[1].ruleId, "SEC-bbb222");
});

Deno.test("buildSecuritySarif - empty findings yield an empty run (valid SARIF)", () => {
  const sarif = json(buildSecuritySarif([]));
  assertEquals(sarif.version, "2.1.0");
  assertEquals(sarif.runs[0].results, []);
});

// ---------------------------------------------------------------------------
// Redaction (Issue #1255) — the uploader gzips the document, so a secret has
// to be masked here or it reaches code scanning unmasked and unscannable.
// ---------------------------------------------------------------------------

/** Shape-valid but fake — never a live credential. */
const FAKE_TOKEN = "ghp_" + "a".repeat(36);

Deno.test("buildSecuritySarif - redacts a secret in the finding message", () => {
  const findings = parseSecurityFindings([
    issue(
      `🔴 Token ${FAKE_TOKEN} echoed in src/api/orders.ts:47`,
      "<!-- finding-id: SEC-ccc333 -->",
    ),
  ]);
  const sarif = json(buildSecuritySarif(findings));
  const serialised = JSON.stringify(sarif);
  assert(
    !serialised.includes(FAKE_TOKEN),
    `secret leaked into the SARIF document: ${serialised}`,
  );
  assert(serialised.includes(REDACTION_PLACEHOLDER));

  const rule = sarif.runs[0].tool.driver.rules[0];
  assert(rule.shortDescription.text.includes(REDACTION_PLACEHOLDER));
  assert(rule.fullDescription.text.includes(REDACTION_PLACEHOLDER));
  assert(sarif.runs[0].results[0].message.text.includes(REDACTION_PLACEHOLDER));
  // The rule id stays intact — it is the dedupe fingerprint, not free text.
  assertEquals(rule.id, "SEC-ccc333");
});

Deno.test("buildSecuritySarif - redacts a secret in the artifact location URI", () => {
  const sarif = json(buildSecuritySarif([{
    findingId: "SEC-ddd444",
    cwe: null,
    severity: "medium",
    message: "Secret in a path",
    file: `tmp/${FAKE_TOKEN}/config.ts`,
    startLine: 12,
  }]));
  const uri = sarif.runs[0].results[0].locations[0].physicalLocation
    .artifactLocation.uri;
  assert(!uri.includes(FAKE_TOKEN), `secret leaked into the URI: ${uri}`);
  assert(uri.includes(REDACTION_PLACEHOLDER));
});

Deno.test("buildSecuritySarif - leaves ordinary finding text unchanged", () => {
  const sarif = json(buildSecuritySarif(FINDINGS));
  assertEquals(
    sarif.runs[0].results[0].message.text,
    "SQL injection in src/api/orders.ts:47",
  );
  assertEquals(
    sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
    "src/api/orders.ts",
  );
});
