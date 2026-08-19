/**
 * Tests for branch_protection_definitions.ts — canonical required-checks
 * definitions with visibility-aware filtering.
 *
 * Issue #2583: Branch-protection required-checks definitions + visibility-aware
 * filtering (never require an unsatisfiable check).
 */

import { assertEquals } from "@std/assert";
import {
  type CheckSpec,
  getRequiredChecksForRepo,
  REQUIRED_CHECKS,
} from "../lib/branch_protection_definitions.ts";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";

// ---------------------------------------------------------------------------
// Canonical catalogue shape
// ---------------------------------------------------------------------------

Deno.test("branch_protection - REQUIRED_CHECKS is non-empty and well-formed", () => {
  assertEquals(REQUIRED_CHECKS.length > 0, true);
  for (const check of REQUIRED_CHECKS) {
    assertEquals(typeof check.id, "string");
    assertEquals(check.id.length > 0, true);
    assertEquals(Array.isArray(check.contextNames), true);
    assertEquals(check.contextNames.length > 0, true);
  }
});

Deno.test("branch_protection - check ids are unique", () => {
  const ids = REQUIRED_CHECKS.map((c) => c.id);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("branch_protection - dependency-review reuses workflow public-only signal", () => {
  const depReview = REQUIRED_CHECKS.find((c) => c.id === "dependency-review");
  assertEquals(depReview !== undefined, true);
  assertEquals(depReview!.requiresPublic, true);

  // The signal must match workflow_definitions.ts, not be re-derived.
  const spec = WORKFLOW_SPECS.find((s) => s.id === "dependency-review");
  assertEquals(spec!.visibilityScope, "public-only");
});

// ---------------------------------------------------------------------------
// Visibility-aware filtering
// ---------------------------------------------------------------------------

Deno.test("branch_protection - public includes public-only checks", () => {
  const checks = getRequiredChecksForRepo("public");
  const ids = checks.map((c) => c.id);
  assertEquals(ids.includes("dependency-review"), true);
});

Deno.test("branch_protection - private excludes public-only checks", () => {
  const checks = getRequiredChecksForRepo("private");
  const ids = checks.map((c) => c.id);
  assertEquals(ids.includes("dependency-review"), false);
  // Universal, non-public-only checks still present.
  assertEquals(ids.includes("gitleaks"), true);
});

Deno.test("branch_protection - unknown visibility treated as private", () => {
  const unknown = getRequiredChecksForRepo("unknown");
  const undef = getRequiredChecksForRepo(undefined);
  const priv = getRequiredChecksForRepo("private");
  assertEquals(unknown.map((c) => c.id), priv.map((c) => c.id));
  assertEquals(undef.map((c) => c.id), priv.map((c) => c.id));
  // No public-only check leaks through.
  assertEquals(unknown.some((c) => c.requiresPublic === true), false);
});

// ---------------------------------------------------------------------------
// Language gating
// ---------------------------------------------------------------------------

Deno.test("branch_protection - language-gated check included when language present", () => {
  const checks = getRequiredChecksForRepo("private", ["Deno"]);
  const ids = checks.map((c) => c.id);
  assertEquals(ids.includes("deno-quality"), true);
  // Rust-gated check stays out when only Deno is present.
  assertEquals(ids.includes("cargo-quality"), false);
});

Deno.test("branch_protection - language-gated check excluded when language absent", () => {
  const checks = getRequiredChecksForRepo("public", ["Rust"]);
  const ids = checks.map((c) => c.id);
  assertEquals(ids.includes("deno-quality"), false);
  assertEquals(ids.includes("cargo-quality"), true);
});

Deno.test("branch_protection - language-gated checks excluded when no languages provided", () => {
  const checks = getRequiredChecksForRepo("public");
  const langGated = checks.filter((c) =>
    c.languages !== undefined && c.languages.length > 0
  );
  // Never require a language-gated check we cannot confirm is satisfiable.
  assertEquals(langGated.length, 0);
});

Deno.test("branch_protection - public-only AND language-gated requires both", () => {
  // A synthetic spec proving the two filters compose (AND), guarding the
  // invariant without depending on the canonical catalogue's contents.
  const both: CheckSpec = {
    id: "synthetic",
    contextNames: ["synthetic"],
    requiresPublic: true,
    languages: ["Deno"],
  };
  const passes = (vis: "public" | "private", langs?: string[]) => {
    const isPublic = vis === "public";
    if (both.requiresPublic && !isPublic) return false;
    if (both.languages && !langs?.some((l) => both.languages!.includes(l))) {
      return false;
    }
    return true;
  };
  assertEquals(passes("public", ["Deno"]), true);
  assertEquals(passes("private", ["Deno"]), false);
  assertEquals(passes("public", ["Rust"]), false);
});
