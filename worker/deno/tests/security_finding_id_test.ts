/**
 * Tests for security_finding_id.ts (Issue #1938).
 *
 * Covers determinism, case-sensitivity, whitespace normalisation, and
 * per-repo uniqueness for `computeFindingId`.
 */

import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { computeFindingId } from "../lib/security_finding_id.ts";

Deno.test("computeFindingId - returns deterministic ID for identical input", async () => {
  const input = {
    repo: "stSoftwareAU/VibeCoder",
    class: "sql-injection",
    file: "src/app.ts",
    snippet: "query('SELECT * FROM users WHERE id = ' + id)",
  };
  const a = await computeFindingId(input);
  const b = await computeFindingId(input);
  assertEquals(a, b);
});

Deno.test("computeFindingId - returned ID matches SEC-<12 hex> shape", async () => {
  const id = await computeFindingId({
    repo: "org/repo",
    class: "xss",
    file: "a.ts",
    snippet: "innerHTML = userInput",
  });
  assertMatch(id, /^SEC-[a-f0-9]{12}$/);
});

Deno.test("computeFindingId - identifier case changes produce different IDs", async () => {
  const base = {
    repo: "org/repo",
    class: "vuln",
    file: "x.ts",
  } as const;
  const lower = await computeFindingId({
    ...base,
    snippet: "let user = req.body",
  });
  const camel = await computeFindingId({
    ...base,
    snippet: "let User = req.body",
  });
  assertNotEquals(lower, camel);
});

Deno.test("computeFindingId - whitespace normalisation collapses runs and trims lines", async () => {
  const base = {
    repo: "org/repo",
    class: "vuln",
    file: "x.ts",
  } as const;
  // These three snippets should normalise to the same canonical form:
  // "let x = 1\nreturn x"
  const a = await computeFindingId({ ...base, snippet: "let x = 1\nreturn x" });
  const b = await computeFindingId({
    ...base,
    snippet: "  let   x =   1  \n  return   x  ",
  });
  const c = await computeFindingId({
    ...base,
    snippet: "let x = 1\n\n\nreturn x",
  });
  assertEquals(a, b);
  assertEquals(a, c);
});

Deno.test("computeFindingId - different repos produce different IDs", async () => {
  const base = {
    class: "vuln",
    file: "x.ts",
    snippet: "dangerous()",
  } as const;
  const a = await computeFindingId({ ...base, repo: "org/repo-a" });
  const b = await computeFindingId({ ...base, repo: "org/repo-b" });
  assertNotEquals(a, b);
});

Deno.test("computeFindingId - different vulnerability classes produce different IDs", async () => {
  const base = {
    repo: "org/repo",
    file: "x.ts",
    snippet: "dangerous()",
  } as const;
  const a = await computeFindingId({ ...base, class: "sqli" });
  const b = await computeFindingId({ ...base, class: "xss" });
  assertNotEquals(a, b);
});

Deno.test("computeFindingId - different files produce different IDs", async () => {
  const base = {
    repo: "org/repo",
    class: "vuln",
    snippet: "dangerous()",
  } as const;
  const a = await computeFindingId({ ...base, file: "a.ts" });
  const b = await computeFindingId({ ...base, file: "b.ts" });
  assertNotEquals(a, b);
});
