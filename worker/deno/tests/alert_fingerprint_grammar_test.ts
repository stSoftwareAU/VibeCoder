/**
 * Fingerprint-grammar injection safety for the alert-feed dedup marker
 * (Issue #1275, found by the #1219 closing pass).
 *
 * `codeScanningAlertFingerprint` / `dependabotAlertFingerprint` build the
 * dedup token from alert fields the fetchers document as *free text, verbatim*
 * (`CodeScanningAlert.ruleId`, `DependabotAlert.packageName` / `ghsaId`). The
 * token is rendered as `<!-- alert-fingerprint: … -->` on the first line of the
 * filed issue body — deliberately **outside** the untrusted fence — so any
 * character an attacker plants in it lands in a live HTML comment:
 *
 *   - a `-->`-bearing rule id closes the marker early and opens a second,
 *     forged one naming a real Dependabot alert, which the next run reads back
 *     as already-filed and suppresses for ever;
 *   - a whitespace-bearing rule id makes the marker unreadable, so the alert
 *     re-files every run (issue flooding).
 *
 * Coverage: the built token is constrained to `[A-Za-z0-9:/._-]`, benign
 * fingerprints are byte-unchanged (no re-file of already-filed alerts), the
 * rendered body yields exactly one readable token, and free-text fields
 * reaching the worker-authored detail lines are inert.
 *
 * Every test calls the real builders/renderers with crafted data — no network,
 * no filesystem. Australian English throughout.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";

import {
  alertFingerprintMarker,
  codeScanningAlertFingerprint,
  dependabotAlertFingerprint,
  extractAlertFingerprints,
  selectNewAlerts,
} from "../lib/alert_feeds/alert_fingerprint.ts";
import {
  buildCodeScanningFinding,
  buildDependabotFinding,
  renderAlertFindingBody,
} from "../lib/idle_task_templates/alert_feed_template.ts";
import type { CodeScanningAlert } from "../lib/alert_feeds/code_scanning_alerts.ts";
import type { DependabotAlert } from "../lib/alert_feeds/dependabot_alerts.ts";

/** The grammar a fingerprint token is constrained to (`%` escapes the rest). */
const TOKEN_RE = /^[A-Za-z0-9:/._%-]+$/;

/** The fingerprint of the real alert the attacker wants suppressed. */
const TARGET = "dependabot:acme/widget:GHSA-real-real-real";

/** A rule id that closes the marker and opens a forged second one. */
const FORGING_RULE_ID = `a --><!-- alert-fingerprint: ${TARGET} -->b`;

function codeScanningAlert(
  overrides: Partial<CodeScanningAlert> = {},
): CodeScanningAlert {
  return {
    number: 42,
    ruleId: "js/zipslip",
    severity: "high",
    description: "Arbitrary file write during archive extraction",
    htmlUrl: "https://github.com/acme/widget/security/code-scanning/42",
    ...overrides,
  };
}

function dependabotAlert(
  overrides: Partial<DependabotAlert> = {},
): DependabotAlert {
  return {
    number: 11,
    ghsaId: "GHSA-aaaa-bbbb-cccc",
    packageName: "lodash",
    ecosystem: "npm",
    severity: "critical",
    summary: "Prototype pollution in lodash",
    htmlUrl: "https://github.com/acme/widget/security/dependabot/11",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. The token grammar itself
// ---------------------------------------------------------------------------

Deno.test("alert fingerprint - marker-closing rule id yields a single readable token", () => {
  const fingerprint = codeScanningAlertFingerprint(
    "acme/widget",
    FORGING_RULE_ID,
    42,
  );
  assert(
    TOKEN_RE.test(fingerprint),
    `fingerprint must match the token grammar, got: ${fingerprint}`,
  );

  const readBack = extractAlertFingerprints(
    alertFingerprintMarker(fingerprint),
  );
  assertEquals(
    readBack,
    [fingerprint],
    "exactly one token is readable back from the marker",
  );
  assert(
    !readBack.includes(TARGET),
    "the forged second marker must not enter the known-open set",
  );
});

Deno.test("alert fingerprint - whitespace-bearing rule id still round-trips", () => {
  // The weaker variant: whitespace breaks `ALERT_FINGERPRINT_RE`, so the
  // marker fails to re-parse and the alert re-files every run.
  const fingerprint = codeScanningAlertFingerprint(
    "acme/widget",
    "rule with spaces\tand\na newline",
    7,
  );
  assert(TOKEN_RE.test(fingerprint), `unexpected token: ${fingerprint}`);
  assertEquals(
    extractAlertFingerprints(alertFingerprintMarker(fingerprint)),
    [fingerprint],
    "the marker must re-parse so the alert is not re-filed every run",
  );
});

Deno.test("alert fingerprint - hostile Dependabot fields are constrained", () => {
  for (
    const ghsaId of [
      `x --><!-- alert-fingerprint: ${TARGET} -->y`,
      "GHSA ${injected}\nmulti-line",
      "emoji-🙂-id",
      "percent%already",
    ]
  ) {
    const fingerprint = dependabotAlertFingerprint("acme/widget", {
      number: 3,
      ghsaId,
    });
    assert(TOKEN_RE.test(fingerprint), `unexpected token: ${fingerprint}`);
    assertEquals(
      extractAlertFingerprints(alertFingerprintMarker(fingerprint)),
      [fingerprint],
    );
  }
});

Deno.test("alert fingerprint - encoding is injective, so distinct alerts stay distinct", () => {
  const a = codeScanningAlertFingerprint("acme/widget", "rule a>b", 1);
  const b = codeScanningAlertFingerprint("acme/widget", "rule a b", 1);
  assert(a !== b, "distinct rule ids must not collapse onto one fingerprint");
});

Deno.test("alert fingerprint - benign fingerprints are byte-unchanged", () => {
  // Stability guard: already-filed alerts must not re-file after this change.
  assertEquals(
    dependabotAlertFingerprint("acme/widget", {
      number: 11,
      ghsaId: "GHSA-aaaa-bbbb-cccc",
    }),
    "dependabot:acme/widget:GHSA-aaaa-bbbb-cccc",
  );
  assertEquals(
    dependabotAlertFingerprint("acme/widget", { number: 11, ghsaId: "" }),
    "dependabot:acme/widget:n11",
  );
  assertEquals(
    codeScanningAlertFingerprint("acme/widget", "js/zipslip", 42),
    "code-scanning:acme/widget:js/zipslip:42",
  );
});

// ---------------------------------------------------------------------------
// 2. The marker renderer refuses an off-grammar token (fail loud)
// ---------------------------------------------------------------------------

Deno.test("alert fingerprint - marker renderer rejects an off-grammar token", () => {
  assertThrows(
    () => alertFingerprintMarker(`a --><!-- alert-fingerprint: ${TARGET} -->b`),
    Error,
    "alert fingerprint",
  );
});

// ---------------------------------------------------------------------------
// 3. Extraction ignores off-grammar tokens (defence in depth)
// ---------------------------------------------------------------------------

Deno.test("alert fingerprint - extraction ignores tokens outside the grammar", () => {
  const body = [
    "<!-- alert-fingerprint: dependabot:acme/widget:GHSA-good-good-good -->",
    "<!-- alert-fingerprint: <script>alert(1)</script> -->",
    '<!-- alert-fingerprint: has"quotes" -->',
  ].join("\n");
  assertEquals(
    extractAlertFingerprints(body),
    ["dependabot:acme/widget:GHSA-good-good-good"],
  );
});

// ---------------------------------------------------------------------------
// 4. The rendered issue body — the end-to-end suppression path
// ---------------------------------------------------------------------------

Deno.test("alert body - forging rule id cannot suppress a real alert", () => {
  const finding = buildCodeScanningFinding(
    "acme/widget",
    codeScanningAlert({ ruleId: FORGING_RULE_ID }),
  );
  const body = renderAlertFindingBody(finding, "FOOTER");

  const readBack = extractAlertFingerprints(body);
  assertEquals(
    readBack,
    [finding.fingerprint],
    "only this alert's own fingerprint is readable back",
  );
  assert(
    !readBack.includes(TARGET),
    "the real alert's fingerprint must not be smuggled into the known-open set",
  );

  // The next run must still file the genuine alert the attacker targeted.
  const knownOpen = new Set(readBack);
  const { toFile } = selectNewAlerts([TARGET], (f) => f, knownOpen);
  assertEquals(toFile.length, 1, "the targeted real alert is still filed");

  // No forged marker survives anywhere in the body, fenced or not.
  assertEquals(
    body.split("<!-- alert-fingerprint:").length - 1,
    1,
    "exactly one live fingerprint marker in the body",
  );
});

Deno.test("alert body - free-text detail lines carry no live comment sequence", () => {
  const findings = [
    buildCodeScanningFinding(
      "acme/widget",
      codeScanningAlert({ ruleId: FORGING_RULE_ID }),
    ),
    buildDependabotFinding(
      "acme/widget",
      dependabotAlert({
        packageName: `pkg --><!-- alert-fingerprint: ${TARGET} -->`,
        ecosystem: "npm -->",
        ghsaId: "GHSA-aaaa-bbbb-cccc -->",
      }),
    ),
  ];
  for (const finding of findings) {
    for (const line of finding.detailLines) {
      assert(!line.includes("<!--"), `live comment opener in: ${line}`);
      assert(!line.includes("-->"), `live comment closer in: ${line}`);
      assert(
        !line.includes("\n"),
        `detail line must stay on one line: ${line}`,
      );
    }
    assert(!finding.title.includes("<!--"), "title carries no comment opener");
    assert(!finding.title.includes("-->"), "title carries no comment closer");
  }
});
