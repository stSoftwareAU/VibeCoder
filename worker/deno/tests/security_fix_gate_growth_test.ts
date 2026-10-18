/**
 * Hostile-input growth check for the security-fix gate's cited-test parsing
 * (Issue #3659).
 *
 * `citedSecurityTests` scans diff lines an agent (steered by an untrusted
 * issue body) writes. This measures real elapsed time, so the file is
 * registered in `WALL_CLOCK_TEST_FILES` and runs in the serial pass.
 *
 * Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import { assertLinearGrowth } from "./support/growth.ts";
import { citedSecurityTests } from "../lib/security_fix_gate.ts";

/** A PR summary citing `tests/db_test.ts::rejects_injection`. */
const INJECTION_SUMMARY = `## Summary
Fixed the SQL injection by parameterising the query. Closes #100.

## Test Plan
- Added \`tests/db_test.ts::rejects_injection\` — a regression test that
  reproduces the flaw: it fails against the unfixed code and passes after the fix.
`;

Deno.test("citedSecurityTests - a long unclosed quote run on a declaration line grows linearly", () => {
  const result = assertLinearGrowth(
    "STRING_NAME_PATTERN over an unclosed quote run",
    (chars) =>
      "+++ b/tests/a_test.ts\n+Deno.test(rejects_injection " +
      '"'.repeat(chars) + "\n",
    (diff) => citedSecurityTests(INJECTION_SUMMARY, diff),
    { baseChars: 12_500 },
  );
  assertEquals(result.length <= 1, true);
});

Deno.test("citedSecurityTests - a long run of '::' citations in the summary grows linearly (PR #3921)", () => {
  const result = assertLinearGrowth(
    "FULL_CITED_NAME_PATTERN over a '::' run",
    (chars) => "::".repeat(chars / 2) + "\n",
    (summary) =>
      citedSecurityTests(
        summary,
        '+++ b/tests/a_test.ts\n+Deno.test("rejects_injection", () => {});',
      ),
    { baseChars: 12_500 },
  );
  assertEquals(result.length <= 1, true);
});
