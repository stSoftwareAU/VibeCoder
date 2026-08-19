/**
 * Tests for resolveFleetAuthors (Issue #3138).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  compareFleetAuthorSets,
  type FleetAuthorSetInput,
  isFleetAuthor,
  resolveFleetAuthors,
  resolveFleetMaintenanceAuthorSet,
  resolveFleetPrAuthorSet,
} from "../lib/fleet_authors.ts";

Deno.test("resolveFleetAuthors - unions host, allowed and fleet-pr authors", () => {
  const result = resolveFleetAuthors(
    "Vibecoderbot",
    ["human1"],
    ["stsvcbot"],
  );
  assertEquals(result, ["Vibecoderbot", "human1", "stsvcbot"]);
});

Deno.test("resolveFleetAuthors - includes fleet sibling missing from allowed_authors", () => {
  // Root-cause scenario: sibling only in fleet_pr_authors must still be queried.
  const result = resolveFleetAuthors("Vibecoderbot", ["human1"], ["stsvcbot"]);
  assertEquals(result.includes("stsvcbot"), true);
});

Deno.test("resolveFleetAuthors - deduplicates case-insensitively, first-seen wins", () => {
  const result = resolveFleetAuthors(
    "Vibecoderbot",
    ["vibecoderbot", "Human1"],
    ["HUMAN1", "stsvcbot"],
  );
  assertEquals(result, ["Vibecoderbot", "Human1", "stsvcbot"]);
});

Deno.test("resolveFleetAuthors - drops blank and whitespace entries", () => {
  const result = resolveFleetAuthors("", ["  ", "alice", ""], ["  bob  "]);
  assertEquals(result, ["alice", "bob"]);
});

Deno.test("resolveFleetAuthors - empty inputs yield empty list", () => {
  assertEquals(resolveFleetAuthors("", [], []), []);
});

// --- isFleetAuthor (Issue #3164) ---

Deno.test("isFleetAuthor - matches a fleet login case-insensitively", () => {
  const fleet = ["Vibecoderbot", "stsvcbot"];
  assertEquals(isFleetAuthor("vibecoderbot", fleet), true);
  assertEquals(isFleetAuthor("STSVCBOT", fleet), true);
});

Deno.test("isFleetAuthor - rejects a non-fleet author", () => {
  assertEquals(isFleetAuthor("attacker", ["Vibecoderbot"]), false);
});

Deno.test("isFleetAuthor - null/undefined/blank logins are never fleet", () => {
  const fleet = ["Vibecoderbot"];
  assertEquals(isFleetAuthor(null, fleet), false);
  assertEquals(isFleetAuthor(undefined, fleet), false);
  assertEquals(isFleetAuthor("   ", fleet), false);
});

Deno.test("isFleetAuthor - empty fleet list matches nobody", () => {
  assertEquals(isFleetAuthor("Vibecoderbot", []), false);
});

// --- resolveFleetMaintenanceAuthorSet (Issue #4075) ---

Deno.test("resolveFleetMaintenanceAuthorSet - excludes every allowedAuthors entry", () => {
  // The #4074 regression: a trusted human's PR was adopted by the
  // maintenance scans because the push-capable set inherited allowed_authors.
  const result = resolveFleetMaintenanceAuthorSet({
    githubUser: "Vibecoderbot",
    allowedAuthors: ["human1", "human2"],
    fleetPrAuthors: ["stsvcbot"],
  });
  assertEquals(result, ["Vibecoderbot", "stsvcbot"]);
});

Deno.test("resolveFleetMaintenanceAuthorSet - keeps a login listed in both lists", () => {
  // Membership comes from the sibling list, so also being a trusted human
  // must not remove a genuine fleet account.
  const result = resolveFleetMaintenanceAuthorSet({
    githubUser: "Vibecoderbot",
    allowedAuthors: ["stsvcbot", "human1"],
    fleetPrAuthors: ["stsvcbot"],
  });
  assertEquals(result, ["Vibecoderbot", "stsvcbot"]);
});

Deno.test("resolveFleetMaintenanceAuthorSet - host login is always present", () => {
  assertEquals(
    resolveFleetMaintenanceAuthorSet({ githubUser: "Vibecoderbot" }),
    ["Vibecoderbot"],
  );
  assertEquals(
    resolveFleetMaintenanceAuthorSet({
      githubUser: "Vibecoderbot",
      allowedAuthors: ["human1"],
      fleetPrAuthors: ["stsvcbot"],
    })[0],
    "Vibecoderbot",
  );
});

Deno.test("resolveFleetPrAuthorSet - host login is always present", () => {
  assertEquals(
    resolveFleetPrAuthorSet({
      githubUser: "Vibecoderbot",
      allowedAuthors: ["human1"],
      fleetPrAuthors: ["stsvcbot"],
    })[0],
    "Vibecoderbot",
  );
});

Deno.test("resolveFleetMaintenanceAuthorSet - drops blank and whitespace entries", () => {
  const result = resolveFleetMaintenanceAuthorSet({
    githubUser: "  ",
    allowedAuthors: ["  ", "human1"],
    fleetPrAuthors: ["  stsvcbot  ", ""],
  });
  assertEquals(result, ["stsvcbot"]);
});

Deno.test("resolveFleetMaintenanceAuthorSet - dedupes case-insensitively, first-seen casing wins", () => {
  const result = resolveFleetMaintenanceAuthorSet({
    githubUser: "Vibecoderbot",
    fleetPrAuthors: ["vibecoderbot", "Stsvcbot", "STSVCBOT"],
  });
  assertEquals(result, ["Vibecoderbot", "Stsvcbot"]);
});

Deno.test("resolveFleetMaintenanceAuthorSet - is a subset of the fleet-owned set", () => {
  const inputs: FleetAuthorSetInput[] = [
    { githubUser: "Vibecoderbot" },
    { githubUser: "Vibecoderbot", allowedAuthors: ["human1"] },
    { githubUser: "Vibecoderbot", fleetPrAuthors: ["stsvcbot"] },
    {
      githubUser: "Vibecoderbot",
      allowedAuthors: ["human1", "stsvcbot"],
      fleetPrAuthors: ["stsvcbot", "sibling2"],
    },
    {
      githubUser: "  ",
      allowedAuthors: ["", "  ", "HUMAN1"],
      fleetPrAuthors: ["stsvcbot", "human1"],
    },
    { githubUser: "", allowedAuthors: [], fleetPrAuthors: [] },
  ];
  for (const input of inputs) {
    const owned = resolveFleetPrAuthorSet(input).map((a) => a.toLowerCase());
    const maintenance = resolveFleetMaintenanceAuthorSet(input);
    for (const login of maintenance) {
      assertEquals(
        owned.includes(login.toLowerCase()),
        true,
        `${login} must also be in the fleet-owned set for ${
          JSON.stringify(input)
        }`,
      );
    }
    assertEquals(maintenance.length <= owned.length, true);
  }
});

// --- compareFleetAuthorSets, intent-aware (Issue #4079) ---

const INTENT_INPUT: FleetAuthorSetInput = {
  githubUser: "Vibecoderbot",
  allowedAuthors: ["human1"],
  fleetPrAuthors: ["stsvcbot"],
};

Deno.test("compareFleetAuthorSets - sets differing only by allowed_authors do not diverge", () => {
  // The #4076 shape: the maintenance set is the fleet-owned set minus the
  // trusted humans. That delta is intended, so it must be silent.
  const result = compareFleetAuthorSets(
    resolveFleetPrAuthorSet(INTENT_INPUT),
    resolveFleetMaintenanceAuthorSet(INTENT_INPUT),
    { expectedMaintenanceExclusions: INTENT_INPUT.allowedAuthors },
  );
  assertEquals(result.diverged, false);
  assertEquals(result.missingFromMaintenance, []);
  assertEquals(result.missingFromBlocking, []);
});

Deno.test("compareFleetAuthorSets - a fleet sibling missing from maintenance still diverges", () => {
  // The genuine #4023 hazard: a fleet-owned PR that blocks work and that no
  // scan will ever fix, answer, or merge.
  const result = compareFleetAuthorSets(
    resolveFleetPrAuthorSet(INTENT_INPUT),
    ["Vibecoderbot"],
    { expectedMaintenanceExclusions: INTENT_INPUT.allowedAuthors },
  );
  assertEquals(result.diverged, true);
  assertEquals(result.missingFromMaintenance, ["stsvcbot"]);
  assertEquals(result.missingFromBlocking, []);
});

Deno.test("compareFleetAuthorSets - a maintenance login invisible to the blocking guard still diverges", () => {
  // The #3138 hazard: a login the worker pushes to but the duplicate guard
  // cannot see. Trusted-human exclusions never suppress this direction.
  const result = compareFleetAuthorSets(
    ["Vibecoderbot"],
    ["Vibecoderbot", "stsvcbot"],
    { expectedMaintenanceExclusions: ["human1", "stsvcbot"] },
  );
  assertEquals(result.diverged, true);
  assertEquals(result.missingFromBlocking, ["stsvcbot"]);
  assertEquals(result.missingFromMaintenance, []);
});

Deno.test("compareFleetAuthorSets - a login in both allowed_authors and fleet_pr_authors never diverges", () => {
  const input: FleetAuthorSetInput = {
    githubUser: "Vibecoderbot",
    allowedAuthors: ["human1", "stsvcbot"],
    fleetPrAuthors: ["stsvcbot"],
  };
  const blocking = resolveFleetPrAuthorSet(input);
  const maintenance = resolveFleetMaintenanceAuthorSet(input);
  // Present in both sets despite also being a trusted human.
  assertEquals(isFleetAuthor("stsvcbot", blocking), true);
  assertEquals(isFleetAuthor("stsvcbot", maintenance), true);
  const result = compareFleetAuthorSets(blocking, maintenance, {
    expectedMaintenanceExclusions: input.allowedAuthors,
  });
  assertEquals(result.diverged, false);
  assertEquals(result.missingFromMaintenance, []);
  assertEquals(result.missingFromBlocking, []);
});

Deno.test("compareFleetAuthorSets - exclusions match case-insensitively and ignore blanks", () => {
  const result = compareFleetAuthorSets(
    ["Vibecoderbot", "Human1", "sibling2"],
    ["Vibecoderbot"],
    { expectedMaintenanceExclusions: ["  ", "HUMAN1"] },
  );
  assertEquals(result.diverged, true);
  // The blank exclusion excused nothing; the human was excused, the
  // unmaintained sibling was not.
  assertEquals(result.missingFromMaintenance, ["sibling2"]);
});

Deno.test("compareFleetAuthorSets - omitted options keep the strict equality check", () => {
  const result = compareFleetAuthorSets(["Vibecoderbot", "human1"], [
    "Vibecoderbot",
  ]);
  assertEquals(result.diverged, true);
  assertEquals(result.missingFromMaintenance, ["human1"]);
});
