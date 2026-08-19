/**
 * Tests for suppression_comments.ts (Issue #1938, extended in #2146).
 *
 * Covers the recognised comment forms across both finding families
 * (security-scan and best-practices), language handling, malformed
 * IDs, family separation, and the `isSuppressed` adjacency rule.
 *
 * Also pins the orphan-deps suppression path to that same adjacency rule
 * so the two paths cannot silently diverge again (Issue #3947).
 */

import { assertEquals } from "@std/assert";
import {
  filterByFamily,
  findSuppressions,
  isSuppressed,
  type SupportedLanguage,
  type SuppressionRecord,
} from "../lib/suppression_comments.ts";
import {
  collectOrphanDepsSuppressions,
  isOrphanDepsSuppressed,
} from "../lib/orphan_deps_finding_id.ts";

Deno.test("findSuppressions - python noqa form with em-dash separator", () => {
  const source = [
    "import os",
    "os.system(cmd)  # noqa: SEC-abc123def456 — sanitised upstream",
  ].join("\n");
  const result = findSuppressions(source, "py");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "SEC-abc123def456");
  assertEquals(result[0]?.line, 2);
  assertEquals(result[0]?.reason, "sanitised upstream");
});

Deno.test("findSuppressions - python noqa with hyphen separator", () => {
  const source = "danger()  # noqa: SEC-abcdef reason text";
  const result = findSuppressions(source, "py");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "SEC-abcdef");
  assertEquals(result[0]?.reason, "reason text");
});

Deno.test("findSuppressions - eslint-disable-next-line form", () => {
  const source = [
    "function f() {",
    "  // eslint-disable-next-line SEC-1a2b3c — reviewed offline",
    "  return eval(x);",
    "}",
  ].join("\n");
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "SEC-1a2b3c");
  assertEquals(result[0]?.line, 2);
  assertEquals(result[0]?.reason, "reviewed offline");
});

Deno.test("findSuppressions - generic line-comment form (// security-scan-ignore)", () => {
  const source =
    "doThing(); // security-scan-ignore: SEC-deadbeef — false positive";
  const result = findSuppressions(source, "js");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "SEC-deadbeef");
  assertEquals(result[0]?.reason, "false positive");
});

Deno.test("findSuppressions - generic hash-comment form (# security-scan-ignore)", () => {
  const source =
    "do_thing()  # security-scan-ignore: SEC-cafe01 — mitigated via WAF";
  const result = findSuppressions(source, "py");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "SEC-cafe01");
  assertEquals(result[0]?.reason, "mitigated via WAF");
});

Deno.test("findSuppressions - block-comment form (/* security-scan-ignore */)", () => {
  const source = "/* security-scan-ignore: SEC-bb11cc — see ticket 42 */";
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "SEC-bb11cc");
  assertEquals(result[0]?.reason, "see ticket 42");
});

Deno.test("findSuppressions - unknown language returns empty array", () => {
  const source = "// security-scan-ignore: SEC-abcdef — reason";
  const result = findSuppressions(source, "unknown");
  assertEquals(result, []);
});

Deno.test("findSuppressions - keyword matching is case-insensitive", () => {
  const source = "doThing(); // SECURITY-SCAN-IGNORE: SEC-abcdef — reason";
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "SEC-abcdef");
});

Deno.test("findSuppressions - malformed SEC- prefix is ignored", () => {
  // Upper-case hex not matching [a-f0-9], non-hex letters, missing prefix.
  const source = [
    "a(); // security-scan-ignore: SEC-XYZG — bad hex",
    "b(); // security-scan-ignore: BAD-abcdef — wrong prefix",
    "c(); // security-scan-ignore: SEC- — empty",
  ].join("\n");
  const result = findSuppressions(source, "ts");
  assertEquals(result, []);
});

Deno.test("findSuppressions - hash form ignored in JS/TS (not a comment there)", () => {
  const source = "doThing(); # security-scan-ignore: SEC-abcdef — reason";
  const result = findSuppressions(source, "ts");
  // `#` is not a line-comment marker in TS, so this must not match.
  assertEquals(result, []);
});

Deno.test("findSuppressions - multiple suppressions on different lines", () => {
  const source = [
    "a(); // security-scan-ignore: SEC-aaaaaa — r1",
    "b(); // security-scan-ignore: SEC-bbbbbb — r2",
  ].join("\n");
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 2);
  assertEquals(result[0]?.line, 1);
  assertEquals(result[1]?.line, 2);
});

// ---------------------------------------------------------------------------
// isSuppressed adjacency rule
// ---------------------------------------------------------------------------

Deno.test("isSuppressed - matches when suppression is on the same line as finding", () => {
  const suppressions: SuppressionRecord[] = [
    {
      id: "SEC-aaaaaa",
      line: 10,
      reason: "ok",
      family: "security-scan",
      valid: true,
    },
  ];
  assertEquals(isSuppressed("SEC-aaaaaa", suppressions, 10), true);
});

Deno.test("isSuppressed - matches when suppression is on the line immediately above", () => {
  const suppressions: SuppressionRecord[] = [
    {
      id: "SEC-aaaaaa",
      line: 9,
      reason: "ok",
      family: "security-scan",
      valid: true,
    },
  ];
  assertEquals(isSuppressed("SEC-aaaaaa", suppressions, 10), true);
});

Deno.test("isSuppressed - does not match when suppression is two lines above", () => {
  const suppressions: SuppressionRecord[] = [
    {
      id: "SEC-aaaaaa",
      line: 8,
      reason: "ok",
      family: "security-scan",
      valid: true,
    },
  ];
  assertEquals(isSuppressed("SEC-aaaaaa", suppressions, 10), false);
});

Deno.test("isSuppressed - does not match when suppression is below the finding", () => {
  const suppressions: SuppressionRecord[] = [
    {
      id: "SEC-aaaaaa",
      line: 11,
      reason: "ok",
      family: "security-scan",
      valid: true,
    },
  ];
  assertEquals(isSuppressed("SEC-aaaaaa", suppressions, 10), false);
});

Deno.test("isSuppressed - does not match when finding ID differs", () => {
  const suppressions: SuppressionRecord[] = [
    {
      id: "SEC-bbbbbb",
      line: 10,
      reason: "ok",
      family: "security-scan",
      valid: true,
    },
  ];
  assertEquals(isSuppressed("SEC-aaaaaa", suppressions, 10), false);
});

Deno.test("isSuppressed - returns false for empty suppression list", () => {
  assertEquals(isSuppressed("SEC-aaaaaa", [], 10), false);
});

// ---------------------------------------------------------------------------
// best-practice-ignore marker (Issue #2146)
// ---------------------------------------------------------------------------

Deno.test("findSuppressions - best-practice-ignore tags family as best-practices", () => {
  const source =
    "doThing(); // best-practice-ignore: BP-abcdef012345 — deliberate";
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "BP-abcdef012345");
  assertEquals(result[0]?.reason, "deliberate");
  assertEquals(result[0]?.family, "best-practices");
});

Deno.test("findSuppressions - security-scan-ignore tags family as security-scan", () => {
  const source =
    "doThing(); // security-scan-ignore: SEC-abcdef — false positive";
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.family, "security-scan");
});

// --- All 9 supported dialects for the best-practice-ignore marker ----------

Deno.test("findSuppressions - best-practice-ignore recognised in ts (slash comment)", () => {
  const source = "doThing(); // best-practice-ignore: BP-aa11bb — reason";
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "BP-aa11bb");
  assertEquals(result[0]?.family, "best-practices");
});

Deno.test("findSuppressions - best-practice-ignore recognised in js (slash comment)", () => {
  const source = "doThing(); // best-practice-ignore: BP-aa11bb — reason";
  const result = findSuppressions(source, "js");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.family, "best-practices");
});

Deno.test("findSuppressions - best-practice-ignore recognised in py (hash comment)", () => {
  const source = "do_thing()  # best-practice-ignore: BP-aa11bb — reason";
  const result = findSuppressions(source, "py");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "BP-aa11bb");
  assertEquals(result[0]?.family, "best-practices");
});

Deno.test("findSuppressions - best-practice-ignore recognised in go (slash comment)", () => {
  const source = "doThing() // best-practice-ignore: BP-aa11bb — reason";
  const result = findSuppressions(source, "go");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.family, "best-practices");
});

Deno.test("findSuppressions - best-practice-ignore recognised in rs (slash comment)", () => {
  const source = "do_thing(); // best-practice-ignore: BP-aa11bb — reason";
  const result = findSuppressions(source, "rs");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.family, "best-practices");
});

Deno.test("findSuppressions - best-practice-ignore recognised in java (slash comment)", () => {
  const source = "doThing(); // best-practice-ignore: BP-aa11bb — reason";
  const result = findSuppressions(source, "java");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.family, "best-practices");
});

Deno.test("findSuppressions - best-practice-ignore recognised in rb (hash comment)", () => {
  const source = "do_thing  # best-practice-ignore: BP-aa11bb — reason";
  const result = findSuppressions(source, "rb");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.family, "best-practices");
});

Deno.test("findSuppressions - best-practice-ignore recognised in sh (hash comment)", () => {
  const source = "do_thing  # best-practice-ignore: BP-aa11bb — reason";
  const result = findSuppressions(source, "sh");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.family, "best-practices");
});

Deno.test("findSuppressions - best-practice-ignore unknown language returns empty", () => {
  const source = "// best-practice-ignore: BP-aa11bb — reason";
  const result = findSuppressions(source, "unknown");
  assertEquals(result, []);
});

// --- Block-comment form for best-practice-ignore ---------------------------

Deno.test("findSuppressions - best-practice-ignore block-comment form", () => {
  const source = "/* best-practice-ignore: BP-bb11cc — see issue 42 */";
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "BP-bb11cc");
  assertEquals(result[0]?.reason, "see issue 42");
  assertEquals(result[0]?.family, "best-practices");
});

// --- Aliases: noqa / eslint-disable-next-line carry the BP- prefix --------

Deno.test("findSuppressions - noqa with BP- id is tagged best-practices", () => {
  const source = "do_thing()  # noqa: BP-cafe01 — intentional";
  const result = findSuppressions(source, "py");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "BP-cafe01");
  assertEquals(result[0]?.family, "best-practices");
});

Deno.test("findSuppressions - eslint-disable-next-line with BP- id is tagged best-practices", () => {
  const source = [
    "function f() {",
    "  // eslint-disable-next-line BP-1a2b3c — reviewed",
    "  return x;",
    "}",
  ].join("\n");
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "BP-1a2b3c");
  assertEquals(result[0]?.family, "best-practices");
});

// --- Case-insensitive keyword for best-practice-ignore ---------------------

Deno.test("findSuppressions - best-practice-ignore keyword is case-insensitive", () => {
  const source = "doThing(); // BEST-PRACTICE-IGNORE: BP-abcdef — reason";
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "BP-abcdef");
  assertEquals(result[0]?.family, "best-practices");
});

// --- Malformed BP- IDs are ignored -----------------------------------------

Deno.test("findSuppressions - malformed BP- prefix is ignored", () => {
  // Issue #2501 broadened the best-practices id charset from hex-only to
  // `[A-Za-z0-9-]` so prefix-style ids (BP-SHA-PIN-…, BP-STALE-ACTION-…)
  // are suppressible. "Malformed" now means a character outside that set
  // (here `_`), a wrong prefix, or an empty id — not merely a non-hex
  // letter. The former "bad hex" case `BP-XYZG` is now a valid id and is
  // asserted as recognised in the test below.
  const source = [
    "a(); // best-practice-ignore: BP-foo_bar — underscore not allowed",
    "b(); // best-practice-ignore: BAD-abcdef — wrong prefix",
    "c(); // best-practice-ignore: BP- — empty",
  ].join("\n");
  const result = findSuppressions(source, "ts");
  assertEquals(result, []);
});

Deno.test("findSuppressions - prefix-style BP id (uppercase, hyphens) is recognised", () => {
  // Issue #2501 — BP-SHA-PIN-<owner>-<slug> style ids must suppress.
  const source =
    "doThing(); // best-practice-ignore: BP-SHA-PIN-actions-checkout — pinned by mirror";
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "BP-SHA-PIN-actions-checkout");
  assertEquals(result[0]?.reason, "pinned by mirror");
  assertEquals(result[0]?.family, "best-practices");
});

// ---------------------------------------------------------------------------
// Family separation — Issue #2146
// ---------------------------------------------------------------------------

Deno.test("findSuppressions - security-scan-ignore with BP- id does NOT match (cross-family)", () => {
  // The security-scan-ignore keyword pairs only with SEC- IDs.
  const source =
    "doThing(); // security-scan-ignore: BP-aa11bb — wrong keyword";
  const result = findSuppressions(source, "ts");
  assertEquals(result, []);
});

Deno.test("findSuppressions - best-practice-ignore with SEC- id does NOT match (cross-family)", () => {
  // The best-practice-ignore keyword pairs only with BP- IDs.
  const source =
    "doThing(); // best-practice-ignore: SEC-aa11bb — wrong keyword";
  const result = findSuppressions(source, "ts");
  assertEquals(result, []);
});

Deno.test("filterByFamily - returns only the requested family", () => {
  const source = [
    "a(); // security-scan-ignore: SEC-aaaaaa — r1",
    "b(); // best-practice-ignore: BP-bbbbbb — r2",
    "c(); // security-scan-ignore: SEC-cccccc — r3",
  ].join("\n");
  const all = findSuppressions(source, "ts");
  assertEquals(all.length, 3);
  const sec = filterByFamily(all, "security-scan");
  assertEquals(sec.length, 2);
  assertEquals(sec.every((s) => s.family === "security-scan"), true);
  const bp = filterByFamily(all, "best-practices");
  assertEquals(bp.length, 1);
  assertEquals(bp[0]?.id, "BP-bbbbbb");
});

Deno.test("isSuppressed - SEC- finding is not hidden by a BP- suppression on the same line", () => {
  // ID prefixes are disjoint, so cross-family hiding is impossible by
  // construction. This test pins the invariant.
  const suppressions: SuppressionRecord[] = [
    {
      id: "BP-aaaaaa",
      line: 10,
      reason: "ok",
      family: "best-practices",
      valid: true,
    },
  ];
  assertEquals(isSuppressed("SEC-aaaaaa", suppressions, 10), false);
});

Deno.test("isSuppressed - BP- finding is not hidden by a SEC- suppression on the same line", () => {
  const suppressions: SuppressionRecord[] = [
    {
      id: "SEC-aaaaaa",
      line: 10,
      reason: "ok",
      family: "security-scan",
      valid: true,
    },
  ];
  assertEquals(isSuppressed("BP-aaaaaa", suppressions, 10), false);
});

// ---------------------------------------------------------------------------
// Mixed-family source files
// ---------------------------------------------------------------------------

Deno.test("findSuppressions - mixed families on adjacent lines are both recorded", () => {
  const source = [
    "a(); // security-scan-ignore: SEC-111111 — r1",
    "b(); // best-practice-ignore: BP-222222 — r2",
  ].join("\n");
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 2);
  assertEquals(result[0]?.family, "security-scan");
  assertEquals(result[0]?.id, "SEC-111111");
  assertEquals(result[1]?.family, "best-practices");
  assertEquals(result[1]?.id, "BP-222222");
});

// ---------------------------------------------------------------------------
// orphan-deps-ignore synonym (Issue #2908)
// ---------------------------------------------------------------------------

Deno.test("findSuppressions - orphan-deps-ignore slash form tagged best-practices", () => {
  const source =
    "  // orphan-deps-ignore: BP-abcdef012345 — finished library, safe";
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "BP-abcdef012345");
  assertEquals(result[0]?.reason, "finished library, safe");
  assertEquals(result[0]?.family, "best-practices");
});

Deno.test("findSuppressions - orphan-deps-ignore hash form (TOML/YAML manifests)", () => {
  const source =
    'serde = "1.0"  # orphan-deps-ignore: BP-cafe01 — migration pending';
  const result = findSuppressions(source, "sh");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "BP-cafe01");
  assertEquals(result[0]?.reason, "migration pending");
  assertEquals(result[0]?.family, "best-practices");
});

Deno.test("findSuppressions - orphan-deps-ignore block form", () => {
  const source = "/* orphan-deps-ignore: BP-bb11cc — see issue 42 */";
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "BP-bb11cc");
  assertEquals(result[0]?.family, "best-practices");
});

Deno.test("findSuppressions - orphan-deps-ignore keyword is case-insensitive", () => {
  const source = "x; // ORPHAN-DEPS-IGNORE: BP-abcdef — reason";
  const result = findSuppressions(source, "ts");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "BP-abcdef");
  assertEquals(result[0]?.family, "best-practices");
});

// ---------------------------------------------------------------------------
// Scoping consistency with the orphan-deps path (Issue #3947)
// ---------------------------------------------------------------------------

Deno.test("isOrphanDepsSuppressed - matches the isSuppressed line-proximity rule", () => {
  // A marker on line 2 of Cargo.toml, expressed through both paths.
  const marker =
    "# orphan-deps-ignore: BP-777777777777 — author=nigel expires=2999-01-01 archived";
  const source = ["[dependencies]", marker, 'serde = "1.0"'].join("\n");

  const shared = filterByFamily(
    findSuppressions(source, "sh", { file: "Cargo.toml" }),
    "best-practices",
  );
  const orphanDeps = collectOrphanDepsSuppressions([
    { file: "Cargo.toml", text: source, grammar: "hash" },
  ]);

  // Both paths must agree on every candidate line in the declaring file.
  for (let line = 1; line <= 6; line++) {
    assertEquals(
      isOrphanDepsSuppressed("BP-777777777777", orphanDeps, {
        file: "Cargo.toml",
        line,
      }),
      isSuppressed("BP-777777777777", shared, line),
      `paths disagree on line ${line}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Type-level sanity check: SupportedLanguage covers all 9 dialects we test.
// ---------------------------------------------------------------------------

Deno.test("SupportedLanguage - all 9 documented dialects accepted", () => {
  const dialects: SupportedLanguage[] = [
    "ts",
    "js",
    "py",
    "go",
    "rs",
    "java",
    "rb",
    "sh",
    "unknown",
  ];
  // Calling findSuppressions with each dialect must not throw and must
  // return an array (possibly empty).
  for (const d of dialects) {
    const result = findSuppressions("", d);
    assertEquals(Array.isArray(result), true);
  }
});
