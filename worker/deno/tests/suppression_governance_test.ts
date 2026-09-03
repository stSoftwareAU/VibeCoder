/**
 * Tests for suppression governance — author, reason, expiry (Issue #3712).
 *
 * A suppression marker used to need nothing but a finding id: no author,
 * no reason, no expiry, and no per-run report. These tests pin the
 * hardened contract — an ungoverned marker parses, but never suppresses.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetSuppressionAuthorAllowlist,
  findSuppressions,
  isSuppressed,
  recordedSuppressions,
  renderSuppressionSummary,
  resetSuppressionRegistry,
  setSuppressionAuthorAllowlist,
  type SuppressionPolicy,
} from "../lib/suppression_comments.ts";

const TODAY = "2026-08-02";
// Issue #3941: the author allowlist fails closed, so the baseline policy
// used across these tests names the authorised author explicitly.
const POLICY: SuppressionPolicy = { today: TODAY, allowedAuthors: ["nigel"] };

/** A fully-governed marker for `SEC-abc123` on the line given. */
function governed(id = "SEC-abc123"): string {
  return `doThing(); // security-scan-ignore: ${id} — author=nigel expires=2026-12-31 mitigated by the WAF`;
}

Deno.test("suppression governance - a governed marker parses author, expiry and reason", () => {
  const records = findSuppressions(governed(), "ts", POLICY);
  assertEquals(records.length, 1);
  const record = records[0];
  assert(record);
  assertEquals(record.author, "nigel");
  assertEquals(record.expiry, "2026-12-31");
  assertEquals(record.reason, "mitigated by the WAF");
  assertEquals(record.valid, true);
});

Deno.test("suppression governance - a governed marker suppresses its finding", () => {
  const records = findSuppressions(governed(), "ts", POLICY);
  assertEquals(isSuppressed("SEC-abc123", records, 1), true);
});

Deno.test("suppression governance - a marker with no expiry never suppresses", () => {
  const source =
    "doThing(); // security-scan-ignore: SEC-abc123 — author=nigel false positive";
  const records = findSuppressions(source, "ts", POLICY);
  assertEquals(records.length, 1, "the marker still parses");
  assertEquals(records[0]?.valid, false);
  assertStringIncludes(records[0]?.invalidReason ?? "", "expiry");
  assertEquals(isSuppressed("SEC-abc123", records, 1), false);
});

Deno.test("suppression governance - a marker with no reason never suppresses", () => {
  const source =
    "doThing(); // security-scan-ignore: SEC-abc123 — author=nigel expires=2026-12-31";
  const records = findSuppressions(source, "ts", POLICY);
  assertEquals(records[0]?.valid, false);
  assertStringIncludes(records[0]?.invalidReason ?? "", "reason");
  assertEquals(isSuppressed("SEC-abc123", records, 1), false);
});

Deno.test("suppression governance - a marker with no author never suppresses", () => {
  const source =
    "doThing(); // security-scan-ignore: SEC-abc123 — expires=2026-12-31 reviewed offline";
  const records = findSuppressions(source, "ts", POLICY);
  assertEquals(records[0]?.valid, false);
  assertStringIncludes(records[0]?.invalidReason ?? "", "author");
  assertEquals(isSuppressed("SEC-abc123", records, 1), false);
});

Deno.test("suppression governance - an expired marker never suppresses", () => {
  const source =
    "doThing(); // security-scan-ignore: SEC-abc123 — author=nigel expires=2026-08-01 stale waiver";
  const records = findSuppressions(source, "ts", POLICY);
  assertEquals(records[0]?.valid, false);
  assertStringIncludes(records[0]?.invalidReason ?? "", "expired");
  assertEquals(isSuppressed("SEC-abc123", records, 1), false);
});

Deno.test("suppression governance - a marker expiring today still suppresses", () => {
  const source =
    `doThing(); // security-scan-ignore: SEC-abc123 — author=nigel expires=${TODAY} last day`;
  const records = findSuppressions(source, "ts", POLICY);
  assertEquals(records[0]?.valid, true);
  assertEquals(isSuppressed("SEC-abc123", records, 1), true);
});

Deno.test("suppression governance - a malformed expiry never suppresses", () => {
  const source =
    "doThing(); // security-scan-ignore: SEC-abc123 — author=nigel expires=31/12/2026 typo";
  const records = findSuppressions(source, "ts", POLICY);
  assertEquals(records[0]?.valid, false);
  assertStringIncludes(records[0]?.invalidReason ?? "", "expiry");
});

Deno.test("suppression governance - an impossible calendar date is rejected", () => {
  const source =
    "doThing(); // security-scan-ignore: SEC-abc123 — author=nigel expires=2026-02-30 typo";
  const records = findSuppressions(source, "ts", POLICY);
  assertEquals(records[0]?.valid, false);
  assertStringIncludes(records[0]?.invalidReason ?? "", "expiry");
});

Deno.test("suppression governance - an author off the allowlist never suppresses", () => {
  const records = findSuppressions(governed(), "ts", {
    today: TODAY,
    allowedAuthors: ["alice", "bob"],
  });
  assertEquals(records[0]?.valid, false);
  assertStringIncludes(records[0]?.invalidReason ?? "", "nigel");
  assertEquals(isSuppressed("SEC-abc123", records, 1), false);
});

Deno.test("suppression governance - an author on the allowlist suppresses", () => {
  const records = findSuppressions(governed(), "ts", {
    today: TODAY,
    allowedAuthors: ["Nigel", "bob"],
  });
  assertEquals(
    records[0]?.valid,
    true,
    "allowlist matching is case-insensitive",
  );
  assertEquals(isSuppressed("SEC-abc123", records, 1), true);
});

Deno.test("suppression governance - hash and block marker forms carry the same fields", () => {
  const hash = findSuppressions(
    "do_thing()  # best-practice-ignore: BP-abcdef — author=nigel expires=2026-12-31 known good",
    "sh",
    POLICY,
  );
  assertEquals(hash[0]?.author, "nigel");
  assertEquals(hash[0]?.expiry, "2026-12-31");
  assertEquals(hash[0]?.reason, "known good");
  assertEquals(hash[0]?.valid, true);

  const block = findSuppressions(
    "/* best-practice-ignore: BP-abcdef — author=nigel expires=2026-12-31 known good */",
    "ts",
    POLICY,
  );
  assertEquals(block[0]?.author, "nigel");
  assertEquals(block[0]?.expiry, "2026-12-31");
  assertEquals(block[0]?.reason, "known good");
  assertEquals(block[0]?.valid, true);
});

// ---------------------------------------------------------------------------
// Per-run report
// ---------------------------------------------------------------------------

Deno.test("suppression governance - every parsed marker lands in the run registry", () => {
  resetSuppressionRegistry();
  findSuppressions(governed(), "ts", { ...POLICY, file: "src/a.ts" });
  findSuppressions(
    "doThing(); // security-scan-ignore: SEC-def456 — no governance here",
    "ts",
    { ...POLICY, file: "src/b.ts" },
  );

  const seen = recordedSuppressions();
  assertEquals(seen.length, 2);
  assertEquals(seen[0]?.file, "src/a.ts");
  assertEquals(seen[1]?.file, "src/b.ts");
  resetSuppressionRegistry();
});

Deno.test("suppression governance - the run report lists active and rejected markers", () => {
  resetSuppressionRegistry();
  findSuppressions(governed(), "ts", { ...POLICY, file: "src/a.ts" });
  findSuppressions(
    "doThing(); // security-scan-ignore: SEC-def456 — no governance here",
    "ts",
    { ...POLICY, file: "src/b.ts" },
  );

  const report = renderSuppressionSummary();
  assertStringIncludes(report, "Active suppressions (1)");
  assertStringIncludes(report, "SEC-abc123");
  assertStringIncludes(report, "src/a.ts:1");
  assertStringIncludes(report, "nigel");
  assertStringIncludes(report, "2026-12-31");
  assertStringIncludes(report, "Rejected suppressions (1)");
  assertStringIncludes(report, "SEC-def456");
  resetSuppressionRegistry();
});

Deno.test("suppression governance - the run report is empty when nothing was suppressed", () => {
  resetSuppressionRegistry();
  assertEquals(renderSuppressionSummary(), "");
});

Deno.test("suppression governance - duplicate markers are recorded once", () => {
  resetSuppressionRegistry();
  const source = governed();
  findSuppressions(source, "ts", { ...POLICY, file: "src/a.ts" });
  findSuppressions(source, "ts", { ...POLICY, file: "src/a.ts" });
  assertEquals(recordedSuppressions().length, 1);
  resetSuppressionRegistry();
});

// ---------------------------------------------------------------------------
// Issue #3941 — the author allowlist must be wired and fail closed
// ---------------------------------------------------------------------------

Deno.test("suppression governance - an unconfigured author allowlist fails closed (Issue #3941)", () => {
  _resetSuppressionAuthorAllowlist();
  try {
    // No policy allowlist and no configured allowlist: the author= field is
    // unverifiable free text, so the marker must not suppress.
    const records = findSuppressions(governed(), "ts", { today: TODAY });
    assertEquals(records[0]?.valid, false);
    assertStringIncludes(records[0]?.invalidReason ?? "", "allowlist");
    assertEquals(isSuppressed("SEC-abc123", records, 1), false);
  } finally {
    _resetSuppressionAuthorAllowlist();
  }
});

Deno.test("suppression governance - the configured allowlist authorises suppressions (Issue #3941)", () => {
  _resetSuppressionAuthorAllowlist();
  try {
    setSuppressionAuthorAllowlist(["Nigel"]);
    const records = findSuppressions(governed(), "ts", { today: TODAY });
    assertEquals(
      records[0]?.valid,
      true,
      "configured allowlist matching is case-insensitive",
    );
    assertEquals(isSuppressed("SEC-abc123", records, 1), true);
  } finally {
    _resetSuppressionAuthorAllowlist();
  }
});

Deno.test("suppression governance - the configured allowlist rejects unlisted authors (Issue #3941)", () => {
  _resetSuppressionAuthorAllowlist();
  try {
    setSuppressionAuthorAllowlist(["alice"]);
    const records = findSuppressions(governed(), "ts", { today: TODAY });
    assertEquals(records[0]?.valid, false);
    assertStringIncludes(records[0]?.invalidReason ?? "", "nigel");
    assertEquals(isSuppressed("SEC-abc123", records, 1), false);
  } finally {
    _resetSuppressionAuthorAllowlist();
  }
});

Deno.test("suppression governance - a policy allowlist overrides the configured one (Issue #3941)", () => {
  _resetSuppressionAuthorAllowlist();
  try {
    setSuppressionAuthorAllowlist(["nigel"]);
    const records = findSuppressions(governed(), "ts", {
      today: TODAY,
      allowedAuthors: ["alice"],
    });
    assertEquals(records[0]?.valid, false, "the explicit policy wins");
  } finally {
    _resetSuppressionAuthorAllowlist();
  }
});
