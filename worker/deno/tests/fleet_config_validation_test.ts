/**
 * Tests for validateFleetConfig / formatFleetConfigValidation (Issue #3138).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatFleetConfigValidation,
  validateFleetConfig,
} from "../lib/fleet_config_validation.ts";

Deno.test("validateFleetConfig - complete config is ok", () => {
  const result = validateFleetConfig({
    githubUser: "Vibecoderbot",
    allowedAuthors: ["Vibecoderbot", "stsvcbot", "human1"],
    fleetPrAuthors: ["stsvcbot"],
  });
  assertEquals(result.level, "ok");
  assertEquals(result.missingFromAllowed, []);
  assertEquals(result.messages, []);
});

Deno.test("validateFleetConfig - empty effective set is an error", () => {
  const result = validateFleetConfig({
    githubUser: "",
    allowedAuthors: [],
    fleetPrAuthors: [],
  });
  assertEquals(result.level, "error");
  assertEquals(result.effectiveAuthors, []);
  assertStringIncludes(result.messages[0]!, "EMPTY");
});

Deno.test("validateFleetConfig - an empty allowed_authors is the healthy state (Issue #1066)", () => {
  // It grants nothing now, so its emptiness is expected. The host's own login
  // still makes the effective fleet set non-empty, which is what the guard
  // needs.
  const result = validateFleetConfig({
    githubUser: "Vibecoderbot",
    allowedAuthors: [],
    fleetPrAuthors: [],
  });
  assertEquals(result.level, "ok", JSON.stringify(result.messages));
  assertEquals(result.messages, []);
});

Deno.test("validateFleetConfig - a sibling only in fleet_pr_authors is correct, not a smell (Issue #1066)", () => {
  // The #3138 blind-spot shape is now the *right* shape: fleet identity lives
  // in `fleet_pr_authors` / `service_accounts`, never in `allowed_authors`.
  const result = validateFleetConfig({
    githubUser: "Vibecoderbot",
    allowedAuthors: [],
    fleetPrAuthors: ["stsvcbot"],
  });
  assertEquals(result.level, "ok", JSON.stringify(result.messages));
  assertEquals(result.effectiveAuthors.includes("stsvcbot"), true);
});

Deno.test("validateFleetConfig - missing detection is case-insensitive", () => {
  const result = validateFleetConfig({
    githubUser: "host",
    allowedAuthors: ["STSVCBOT"],
    fleetPrAuthors: ["stsvcbot"],
  });
  assertEquals(result.missingFromAllowed, []);
  assertEquals(result.level, "ok");
});

Deno.test("formatFleetConfigValidation - ok renders single line", () => {
  const lines = formatFleetConfigValidation({
    level: "ok",
    effectiveAuthors: ["a", "b"],
    missingFromAllowed: [],
    messages: [],
  });
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "[fleet-config] ok");
  assertStringIncludes(lines[0]!, "a,b");
});

// Issue #209 changed the non-ok output: the effective author set is now
// named on every run, not only a clean one, so an operator can see which
// logins the guards actually cover while the warning is on screen. The two
// tests below assert the message lines around that leading line.
Deno.test("formatFleetConfigValidation - error lines carry ERROR tag", () => {
  const lines = formatFleetConfigValidation({
    level: "error",
    effectiveAuthors: [],
    missingFromAllowed: [],
    messages: ["boom"],
  });
  assertEquals(lines, [
    "[fleet-config] effective-authors=(none)",
    "[fleet-config] ERROR boom",
  ]);
});

Deno.test("formatFleetConfigValidation - warning lines carry WARNING tag", () => {
  const lines = formatFleetConfigValidation({
    level: "warning",
    effectiveAuthors: ["host"],
    missingFromAllowed: ["stsvcbot"],
    messages: ["m1", "m2"],
  });
  assertEquals(lines.length, 3);
  assertEquals(lines[0], "[fleet-config] effective-authors=host");
  assertStringIncludes(lines[1]!, "[fleet-config] WARNING m1");
  assertStringIncludes(lines[2]!, "[fleet-config] WARNING m2");
});

Deno.test("formatFleetConfigValidation - the effective set is named on every run (Issue #209)", () => {
  for (
    const result of [
      {
        level: "ok" as const,
        effectiveAuthors: ["host", "stsvcbot"],
        missingFromAllowed: [],
        messages: [],
      },
      {
        level: "warning" as const,
        effectiveAuthors: ["host", "stsvcbot"],
        missingFromAllowed: ["stsvcbot"],
        messages: ["m1"],
      },
    ]
  ) {
    assertStringIncludes(
      formatFleetConfigValidation(result)[0]!,
      "effective-authors=host,stsvcbot",
    );
  }
});
