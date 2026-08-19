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

Deno.test("validateFleetConfig - empty allowed_authors warns about blindness", () => {
  const result = validateFleetConfig({
    githubUser: "Vibecoderbot",
    allowedAuthors: [],
    fleetPrAuthors: [],
  });
  assertEquals(result.level, "warning");
  assertStringIncludes(result.messages[0]!, "allowed_authors is empty");
});

Deno.test("validateFleetConfig - sibling only in fleet_pr_authors warns", () => {
  // The exact #3138 blind-spot shape.
  const result = validateFleetConfig({
    githubUser: "Vibecoderbot",
    allowedAuthors: ["Vibecoderbot", "human1"],
    fleetPrAuthors: ["stsvcbot"],
  });
  assertEquals(result.level, "warning");
  assertEquals(result.missingFromAllowed, ["stsvcbot"]);
  assertStringIncludes(result.messages.join(" "), "stsvcbot");
  // Guard still covers it via the union.
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

Deno.test("formatFleetConfigValidation - error lines carry ERROR tag", () => {
  const lines = formatFleetConfigValidation({
    level: "error",
    effectiveAuthors: [],
    missingFromAllowed: [],
    messages: ["boom"],
  });
  assertEquals(lines, ["[fleet-config] ERROR boom"]);
});

Deno.test("formatFleetConfigValidation - warning lines carry WARNING tag", () => {
  const lines = formatFleetConfigValidation({
    level: "warning",
    effectiveAuthors: ["host"],
    missingFromAllowed: ["stsvcbot"],
    messages: ["m1", "m2"],
  });
  assertEquals(lines.length, 2);
  assertStringIncludes(lines[0]!, "[fleet-config] WARNING m1");
});
