/**
 * Tests for the `codegraph_context` block parser (Issue #2154, part of #2145).
 *
 * The parser is the trust boundary between operator-written JSON and the
 * worker's `codegraphContext` switch, so each branch is exercised directly
 * here; `tests/config_test.ts` covers the same block through `loadConfig`.
 *
 * Australian English spelling used throughout (behaviour, recognised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CODEGRAPH_CONTEXT_KEYS,
  defaultCodegraphContext,
  parseCodegraphContext,
} from "../lib/codegraph_context_config.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";

/** The error of a parse expected to fail. */
function errorOf(raw: unknown): string {
  const result = parseCodegraphContext(raw);
  assert(!result.ok, `Expected ${JSON.stringify(raw)} to be refused`);
  return result.error;
}

/** The value of a parse expected to succeed. */
function valueOf(raw: unknown): { enabled: boolean } {
  const result = parseCodegraphContext(raw);
  assert(result.ok, `Expected ${JSON.stringify(raw)} to parse`);
  return result.value;
}

Deno.test("parseCodegraphContext - an absent block is off", () => {
  assertEquals(valueOf(undefined), { enabled: false });
});

Deno.test("parseCodegraphContext - an empty block is off", () => {
  assertEquals(valueOf({}), { enabled: false });
});

Deno.test("parseCodegraphContext - enabled true and false round-trip", () => {
  assertEquals(valueOf({ enabled: true }), { enabled: true });
  assertEquals(valueOf({ enabled: false }), { enabled: false });
});

Deno.test("parseCodegraphContext - a non-boolean enabled is refused, naming the key", () => {
  for (const bad of ["yes", 1, null, [], {}]) {
    assertStringIncludes(
      errorOf({ enabled: bad }),
      "codegraph_context.enabled",
    );
  }
  assertStringIncludes(errorOf({ enabled: "yes" }), "got string");
  assertStringIncludes(errorOf({ enabled: null }), "got null");
  assertStringIncludes(errorOf({ enabled: [] }), "got array");
});

Deno.test("parseCodegraphContext - a non-object block is refused, naming the key", () => {
  for (const bad of ["on", 1, true, ["enabled"]]) {
    const message = errorOf(bad);
    assertStringIncludes(message, "codegraph_context.enabled");
  }
  assertStringIncludes(errorOf(["enabled"]), "got array");
});

Deno.test("parseCodegraphContext - an explicit null block is refused, not read as off", () => {
  // Only an absent key means "this host said nothing": a written-out `null`
  // is a malformed block and must fail the load loudly.
  assertStringIncludes(errorOf(null), "codegraph_context.enabled");
  assertStringIncludes(errorOf(null), "got null");
});

Deno.test("parseCodegraphContext - an unknown nested key does not fail the parse", () => {
  // It warns instead (`lib/config_unknown_keys.ts`); nothing is refused.
  assertEquals(valueOf({ enabled: true, enabeld: false }), { enabled: true });
});

Deno.test("defaultCodegraphContext - follows OPERATIONAL_DEFAULTS and is never shared", () => {
  assertEquals(
    defaultCodegraphContext().enabled,
    OPERATIONAL_DEFAULTS.codegraphContext.enabled,
  );
  assertEquals(defaultCodegraphContext().enabled, false);

  const first = defaultCodegraphContext();
  first.enabled = true;
  assertEquals(
    defaultCodegraphContext().enabled,
    false,
    "Each call must return a fresh object",
  );
});

Deno.test("CODEGRAPH_CONTEXT_KEYS - the block accepts only enabled", () => {
  assertEquals([...CODEGRAPH_CONTEXT_KEYS], ["enabled"]);
});
