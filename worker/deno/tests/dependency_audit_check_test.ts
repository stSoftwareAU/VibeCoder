/**
 * Tests for the dependency-audit classifier (Issue #3141, parent #3116).
 *
 * A failing dependency audit must never be deferred to the base branch on a
 * `Depends on` line, so the classifier has to recognise one both by the
 * check's name and by an advisory ID in the failure text — and must not
 * mistake an unrelated check for one.
 */

import { assertEquals } from "@std/assert";
import {
  ADVISORY_ID_PATTERN,
  isDependencyAuditCheck,
} from "../lib/dependency_audit_check.ts";

for (
  const name of ["audit", "deno audit", "cargo audit", "audit (Deno Audit)"]
) {
  Deno.test(`isDependencyAuditCheck - "${name}" is an audit check by name (Issue #3141)`, () => {
    assertEquals(isDependencyAuditCheck(name, ""), true);
  });
}

Deno.test("isDependencyAuditCheck - name matching ignores case (Issue #3141)", () => {
  assertEquals(isDependencyAuditCheck("Deno Audit", ""), true);
  assertEquals(isDependencyAuditCheck("AUDIT", ""), true);
});

Deno.test("isDependencyAuditCheck - a GHSA ID in the failure text marks a non-audit check (Issue #3141)", () => {
  assertEquals(
    isDependencyAuditCheck(
      "test",
      "error: vulnerable dependency GHSA-vfj7-8cjw-p6xm in @std/http",
    ),
    true,
  );
});

Deno.test("isDependencyAuditCheck - a RUSTSEC ID in the failure text marks a non-audit check (Issue #3141)", () => {
  assertEquals(
    isDependencyAuditCheck("build", "Crate: foo\nID: RUSTSEC-2024-0001"),
    true,
  );
});

for (const name of ["lint", "test", "semgrep", "auditor-ui"]) {
  Deno.test(`isDependencyAuditCheck - "${name}" with no advisory ID is not an audit check (Issue #3141)`, () => {
    assertEquals(
      isDependencyAuditCheck(name, "error: expected 2 arguments, got 1"),
      false,
    );
  });
}

Deno.test("isDependencyAuditCheck - a near-miss advisory ID does not count (Issue #3141)", () => {
  assertEquals(isDependencyAuditCheck("lint", "GHSA-vfj7-8cjw"), false);
  assertEquals(isDependencyAuditCheck("lint", "RUSTSEC-24-1"), false);
});

Deno.test("ADVISORY_ID_PATTERN - names the first advisory in the text (Issue #3141)", () => {
  const text = "found GHSA-vfj7-8cjw-p6xm and RUSTSEC-2024-0001";
  assertEquals(ADVISORY_ID_PATTERN.exec(text)?.[0], "GHSA-vfj7-8cjw-p6xm");
  assertEquals(
    ADVISORY_ID_PATTERN.exec("ID: RUSTSEC-2024-0001")?.[0],
    "RUSTSEC-2024-0001",
  );
  assertEquals(ADVISORY_ID_PATTERN.exec("no advisory here"), null);
});
