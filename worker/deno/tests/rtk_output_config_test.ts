/**
 * Tests for the `rtk_output` block parser (Issue #2380, part of #2328).
 *
 * The parser is the trust boundary between operator-written JSON and the
 * worker's `rtkOutput` switch, so each branch is exercised directly here;
 * `tests/config_test.ts` covers the same block through `loadConfig`.
 *
 * Australian English spelling used throughout (behaviour, recognised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  defaultRtkOutput,
  parseRtkOutput,
  RTK_OUTPUT_KEYS,
} from "../lib/rtk_output_config.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";
import {
  detectUnknownConfigKeys,
  KNOWN_CONFIG_KEYS,
} from "../lib/config_unknown_keys.ts";

/** The error of a parse expected to fail. */
function errorOf(raw: unknown): string {
  const result = parseRtkOutput(raw);
  assert(!result.ok, `Expected ${JSON.stringify(raw)} to be refused`);
  return result.error;
}

/** The value of a parse expected to succeed. */
function valueOf(raw: unknown): { enabled: boolean } {
  const result = parseRtkOutput(raw);
  assert(result.ok, `Expected ${JSON.stringify(raw)} to parse`);
  return result.value;
}

Deno.test("parseRtkOutput - an absent block is on (Issue #2432)", () => {
  assertEquals(valueOf(undefined), { enabled: true });
});

Deno.test("parseRtkOutput - an empty block is on (Issue #2432)", () => {
  assertEquals(valueOf({}), { enabled: true });
});

Deno.test("parseRtkOutput - enabled true and false round-trip", () => {
  assertEquals(valueOf({ enabled: true }), { enabled: true });
  assertEquals(valueOf({ enabled: false }), { enabled: false });
});

Deno.test("parseRtkOutput - a non-boolean enabled is refused, naming the key", () => {
  for (const bad of ["yes", 1, null, [], {}]) {
    assertStringIncludes(errorOf({ enabled: bad }), "rtk_output.enabled");
  }
  assertStringIncludes(errorOf({ enabled: "yes" }), "got string");
  assertStringIncludes(errorOf({ enabled: null }), "got null");
  assertStringIncludes(errorOf({ enabled: [] }), "got array");
});

Deno.test("parseRtkOutput - a non-object block is refused, naming the key", () => {
  for (const bad of ["on", 1, true, ["enabled"]]) {
    assertStringIncludes(errorOf(bad), "rtk_output.enabled");
  }
  assertStringIncludes(errorOf(["enabled"]), "got array");
});

Deno.test("parseRtkOutput - an explicit null block is refused, not read as off", () => {
  // Only an absent key means "this host said nothing": a written-out `null`
  // is a malformed block and must fail the load loudly.
  assertStringIncludes(errorOf(null), "rtk_output.enabled");
  assertStringIncludes(errorOf(null), "got null");
});

Deno.test("parseRtkOutput - an unknown nested key does not fail the parse", () => {
  // It warns instead (`lib/config_unknown_keys.ts`); nothing is refused.
  assertEquals(valueOf({ enabled: true, enabledd: false }), { enabled: true });
});

Deno.test("defaultRtkOutput - follows OPERATIONAL_DEFAULTS and is never shared", () => {
  assertEquals(
    defaultRtkOutput().enabled,
    OPERATIONAL_DEFAULTS.rtkOutput.enabled,
  );
  assertEquals(defaultRtkOutput().enabled, true);

  const first = defaultRtkOutput();
  first.enabled = false;
  assertEquals(
    defaultRtkOutput().enabled,
    true,
    "Each call must return a fresh object",
  );
});

Deno.test("RTK_OUTPUT_KEYS - the block accepts only enabled", () => {
  assertEquals([...RTK_OUTPUT_KEYS], ["enabled"]);
});

Deno.test("rtk_output - is a recognised top-level key", () => {
  assertEquals(KNOWN_CONFIG_KEYS.has("rtk_output"), true);
  assertEquals(
    detectUnknownConfigKeys({ rtk_output: { enabled: true } }),
    [],
    "A well-formed rtk_output block must raise no warning",
  );
});

Deno.test("rtk_output - an unknown nested key is reported with a suggestion", () => {
  const warnings = detectUnknownConfigKeys({
    rtk_output: { enabledd: true },
  });
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]!.field, "rtk_output.enabledd");
  assertEquals(warnings[0]!.suggestion, "rtk_output.enabled");
});
