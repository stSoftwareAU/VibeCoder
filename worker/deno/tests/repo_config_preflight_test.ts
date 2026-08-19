/**
 * Tests for pre-flight command config parsing (Issue #3577).
 *
 * `parsePreFlightCommands` and `getPreFlightCommands` follow the
 * `prFailureActions` precedent: optional, absent means no gate, and a
 * malformed entry fails loudly rather than silently disabling the gate.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  getPreFlightCommands,
  parsePreFlightCommands,
} from "../lib/repo_config.ts";
import type { RepoConfig } from "../types.ts";

Deno.test("parsePreFlightCommands - undefined/null → empty (no gate)", () => {
  const a = parsePreFlightCommands(undefined);
  assert(a.ok);
  assertEquals(a.ok && a.value, []);
  const b = parsePreFlightCommands(null);
  assert(b.ok);
  assertEquals(b.ok && b.value, []);
});

Deno.test("parsePreFlightCommands - valid array of non-empty strings", () => {
  const result = parsePreFlightCommands(["./pre-flight.sh", "mvn compile"]);
  assert(result.ok);
  assertEquals(result.ok && result.value, ["./pre-flight.sh", "mvn compile"]);
});

Deno.test("parsePreFlightCommands - non-array fails loudly", () => {
  const result = parsePreFlightCommands("./pre-flight.sh");
  assert(!result.ok, "a bare string is malformed");
  assert(!result.ok && /must be an array/.test(result.error));
});

Deno.test("parsePreFlightCommands - non-string entry fails loudly", () => {
  const result = parsePreFlightCommands(["./ok.sh", 42]);
  assert(!result.ok);
  assert(!result.ok && /\[1\] must be a string/.test(result.error));
});

Deno.test("parsePreFlightCommands - empty/blank entry fails loudly", () => {
  const empty = parsePreFlightCommands([""]);
  assert(!empty.ok);
  assert(!empty.ok && /non-empty/.test(empty.error));

  const blank = parsePreFlightCommands(["   "]);
  assert(!blank.ok, "whitespace-only entry is malformed");
});

Deno.test("getPreFlightCommands - returns [] when repo has no entry", () => {
  const configs: Record<string, RepoConfig> = {
    "org/other": { preFlight: ["./x.sh"] },
  };
  assertEquals(getPreFlightCommands(configs, "org/repo"), []);
  assertEquals(getPreFlightCommands(undefined, "org/repo"), []);
});

Deno.test("getPreFlightCommands - returns configured commands", () => {
  const configs: Record<string, RepoConfig> = {
    "org/repo": { preFlight: ["./pre-flight.sh"] },
  };
  assertEquals(getPreFlightCommands(configs, "org/repo"), ["./pre-flight.sh"]);
});

Deno.test("getPreFlightCommands - throws loudly on malformed config", () => {
  const configs = {
    "org/repo": { preFlight: [123] },
  } as unknown as Record<string, RepoConfig>;
  assertThrows(
    () => getPreFlightCommands(configs, "org/repo"),
    Error,
    "Invalid pre-flight for org/repo",
  );
});
