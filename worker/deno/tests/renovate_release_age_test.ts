/**
 * Behaviour tests for the Renovate release-age policy (Issue #5120).
 *
 * Each refusal is probed through `evaluateRenovatePolicy` and paired with an
 * accepted control that differs only in the probed value, so a refusal can be
 * traced to the value and nothing else. The fixtures under
 * `fixtures/renovate_release_age/` are real `renovate.json` files: they are
 * named `renovate.json` so Semgrep's path filter sees them, and they carry no
 * `"0"` or sub-7-day string inside packageRules (that would be the blocking
 * Semgrep finding itself), so those cases are inline below.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { evaluateRenovatePolicy } from "../lib/supply_chain_gate.ts";
import { parseRenovateDurationHours } from "../lib/renovate_release_age.ts";

const FIXTURES = new URL("./fixtures/renovate_release_age/", import.meta.url);
const SCHEMA = "https://docs.renovatebot.com/renovate-schema.json";

async function loadFixture(name: string): Promise<unknown> {
  const text = await Deno.readTextFile(
    new URL(`${name}/renovate.json`, FIXTURES),
  );
  return JSON.parse(text);
}

/** The repository's accepted shape, with `overrides` merged over it. */
function policy(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    $schema: SCHEMA,
    extends: ["config:recommended"],
    minimumReleaseAge: "24 hours",
    ...overrides,
  };
}

/** The accepted shape with one packageRules entry. */
function withRule(rule: Record<string, unknown>): Record<string, unknown> {
  return policy({ packageRules: [rule] });
}

/** Exactly one `renovate-release-age` refusal, whose message names `cause`. */
function assertRefused(
  findings: ReturnType<typeof evaluateRenovatePolicy>,
  cause: string,
): void {
  assertEquals(findings.map((f) => f.rule), ["renovate-release-age"]);
  assertStringIncludes(findings[0]!.message, cause);
}

Deno.test("renovate release-age - fixture: third-party-only config is accepted", async () => {
  assertEquals(
    evaluateRenovatePolicy(
      "renovate.json",
      await loadFixture("third_party_only"),
    ),
    [],
  );
});

Deno.test("renovate release-age - fixture: first-party null exemption alongside third-party is accepted", async () => {
  assertEquals(
    evaluateRenovatePolicy(
      "renovate.json",
      await loadFixture("first_and_third_party"),
    ),
    [],
  );
});

Deno.test("renovate release-age - fixture: null exemption for a third-party action is refused", async () => {
  assertRefused(
    evaluateRenovatePolicy(
      "renovate.json",
      await loadFixture("external_exemption"),
    ),
    "not first-party",
  );
});

Deno.test("renovate release-age - fixture: a 12-hour top-level age is refused", async () => {
  assertRefused(
    evaluateRenovatePolicy(
      "renovate.json",
      await loadFixture("insufficient_quarantine"),
    ),
    "below the 24-hour",
  );
});

Deno.test("renovate release-age - fixture: a boolean false age is refused by type", async () => {
  assertRefused(
    evaluateRenovatePolicy("renovate.json", await loadFixture("boolean_age")),
    "accepts only a duration string or null",
  );
});

Deno.test('renovate release-age - a first-party "0" exemption is accepted', () => {
  assertEquals(
    evaluateRenovatePolicy(
      "renovate.json",
      withRule({
        matchPackageNames: ["/^stSoftwareAU\\//"],
        minimumReleaseAge: "0",
      }),
    ),
    [],
  );
});

Deno.test('renovate release-age - a third-party "12 hours" rule is refused and "7 days" accepted', () => {
  const accepted = withRule({
    matchPackageNames: ["actions/checkout"],
    minimumReleaseAge: "7 days",
  });
  assertEquals(evaluateRenovatePolicy("renovate.json", accepted), []);
  const refused = withRule({
    matchPackageNames: ["actions/checkout"],
    minimumReleaseAge: "12 hours",
  });
  assertRefused(
    evaluateRenovatePolicy("renovate.json", refused),
    "not first-party",
  );
});

Deno.test("renovate release-age - a negated first-party pattern is refused", () => {
  const control = withRule({
    matchPackageNames: ["/^stSoftwareAU\\//"],
    minimumReleaseAge: null,
  });
  assertEquals(evaluateRenovatePolicy("renovate.json", control), []);
  const refused = withRule({
    matchPackageNames: ["!/^stSoftwareAU\\//"],
    minimumReleaseAge: null,
  });
  assertRefused(
    evaluateRenovatePolicy("renovate.json", refused),
    "not first-party",
  );
});

Deno.test("renovate release-age - an alternation naming a third-party owner is refused", () => {
  const control = withRule({
    matchPackageNames: ["/^stSoftwareAU\\//"],
    minimumReleaseAge: null,
  });
  assertEquals(evaluateRenovatePolicy("renovate.json", control), []);
  const refused = withRule({
    matchPackageNames: ["/^stSoftwareAU\\/|^actions\\//"],
    minimumReleaseAge: null,
  });
  assertRefused(
    evaluateRenovatePolicy("renovate.json", refused),
    "not first-party",
  );
});

Deno.test("renovate release-age - a prefix without the slash is refused", () => {
  const control = withRule({
    matchPackageNames: ["/^stSoftwareAU\\//"],
    minimumReleaseAge: null,
  });
  assertEquals(evaluateRenovatePolicy("renovate.json", control), []);
  // Would also match stSoftwareAUevil/x, a third-party name.
  const refused = withRule({
    matchPackageNames: ["/^stSoftwareAU/"],
    minimumReleaseAge: null,
  });
  assertRefused(
    evaluateRenovatePolicy("renovate.json", refused),
    "not first-party",
  );
});

Deno.test("renovate release-age - a null exemption scoped only by matchManagers is refused", () => {
  const control = withRule({
    matchManagers: ["github-actions"],
    minimumReleaseAge: "24 hours",
  });
  assertEquals(evaluateRenovatePolicy("renovate.json", control), []);
  const refused = withRule({
    matchManagers: ["github-actions"],
    minimumReleaseAge: null,
  });
  assertRefused(
    evaluateRenovatePolicy("renovate.json", refused),
    "not first-party",
  );
});

Deno.test("renovate release-age - a numeric 0 age is refused by type", () => {
  const control = withRule({
    matchPackageNames: ["/^stSoftwareAU\\//"],
    minimumReleaseAge: null,
  });
  assertEquals(evaluateRenovatePolicy("renovate.json", control), []);
  const refused = withRule({
    matchPackageNames: ["/^stSoftwareAU\\//"],
    minimumReleaseAge: 0,
  });
  assertRefused(
    evaluateRenovatePolicy("renovate.json", refused),
    "accepts only a duration string or null",
  );
});

Deno.test("renovate release-age - a nested github-actions null age is refused as a whole category", () => {
  const control = policy({
    "github-actions": { minimumReleaseAge: "24 hours" },
  });
  assertEquals(evaluateRenovatePolicy("renovate.json", control), []);
  const refused = policy({
    "github-actions": { minimumReleaseAge: null },
  });
  assertRefused(
    evaluateRenovatePolicy("renovate.json", refused),
    "lifts the quarantine for a whole category",
  );
});

Deno.test("renovate release-age - a null age under vulnerabilityAlerts is accepted", () => {
  const control = policy({
    vulnerabilityAlerts: { minimumReleaseAge: "24 hours" },
  });
  assertEquals(evaluateRenovatePolicy("renovate.json", control), []);
  const accepted = policy({
    vulnerabilityAlerts: { minimumReleaseAge: null },
  });
  assertEquals(evaluateRenovatePolicy("renovate.json", accepted), []);
});

Deno.test('renovate release-age - a top-level "P1D" age is refused as not a duration', () => {
  assertEquals(
    evaluateRenovatePolicy("renovate.json", policy()),
    [],
  );
  assertRefused(
    evaluateRenovatePolicy(
      "renovate.json",
      policy({ minimumReleaseAge: "P1D" }),
    ),
    "is not a duration Renovate reads",
  );
});

Deno.test("parseRenovateDurationHours - reads Renovate's duration strings as hours", () => {
  assertEquals(parseRenovateDurationHours("24 hours"), 24);
  assertEquals(parseRenovateDurationHours("1 day"), 24);
  assertEquals(parseRenovateDurationHours("2d"), 48);
  assertEquals(parseRenovateDurationHours("1 week"), 168);
  assertEquals(parseRenovateDurationHours("30 minutes"), 0.5);
  assertEquals(parseRenovateDurationHours("1 month"), 720);
  assertEquals(parseRenovateDurationHours("1 day 12 hours"), 36);
  assertEquals(parseRenovateDurationHours("0"), 0);
});

Deno.test("parseRenovateDurationHours - refuses input Renovate does not read as a duration", () => {
  assertEquals(parseRenovateDurationHours("P1D"), null);
  assertEquals(parseRenovateDurationHours(""), null);
  assertEquals(parseRenovateDurationHours("abc"), null);
});

Deno.test("parseRenovateDurationHours - refuses hostile over-long input without scanning it", () => {
  assertEquals(parseRenovateDurationHours("1".repeat(50_000) + "x"), null);
});

Deno.test("renovate release-age - a quantifier after the first-party slash is refused", () => {
  const control = withRule({
    matchPackageNames: ["/^stSoftwareAU\\//"],
    minimumReleaseAge: null,
  });
  assertEquals(evaluateRenovatePolicy("renovate.json", control), []);
  // `\/?evil` would match stSoftwareAUevil; `\/*x` would match stSoftwareAUx.
  for (const pattern of ["/^stSoftwareAU\\/?evil/", "/^stSoftwareAU\\/*x/"]) {
    assertRefused(
      evaluateRenovatePolicy(
        "renovate.json",
        withRule({ matchPackageNames: [pattern], minimumReleaseAge: null }),
      ),
      "not first-party",
    );
  }
  // The slash followed by a plain body, or a case-insensitive flag, stays first-party.
  for (
    const pattern of [
      "/^stSoftwareAU\\/.*/",
      "/^stSoftwareAU\\/foo/i",
    ]
  ) {
    assertEquals(
      evaluateRenovatePolicy(
        "renovate.json",
        withRule({ matchPackageNames: [pattern], minimumReleaseAge: null }),
      ),
      [],
    );
  }
});

Deno.test("renovate release-age - an unparseable age under a category is refused as not a duration", () => {
  const control = policy({
    "github-actions": { minimumReleaseAge: "7 days" },
  });
  assertEquals(evaluateRenovatePolicy("renovate.json", control), []);
  const refused = policy({
    "github-actions": { minimumReleaseAge: "P1D" },
  });
  assertRefused(
    evaluateRenovatePolicy("renovate.json", refused),
    'github-actions.minimumReleaseAge "P1D" is not a duration Renovate reads',
  );
});

Deno.test("renovate release-age - a non-string top-level age is refused by type, exactly once", () => {
  for (
    const [value, typeName] of [[false, "boolean"], [0, "number"]] as const
  ) {
    const findings = evaluateRenovatePolicy(
      "renovate.json",
      policy({ minimumReleaseAge: value }),
    );
    assertRefused(findings, "accepts only a duration string or null");
    assertStringIncludes(
      findings[0]!.message,
      `top-level.minimumReleaseAge is a ${typeName};`,
    );
  }
});

Deno.test("renovate release-age - a missing, null or blank top-level age yields the gate's missing finding", () => {
  const missing = policy();
  delete missing["minimumReleaseAge"];
  assertRefused(
    evaluateRenovatePolicy("renovate.json", missing),
    "top-level minimumReleaseAge is missing",
  );
  for (const value of [null, "   "]) {
    assertRefused(
      evaluateRenovatePolicy(
        "renovate.json",
        policy({ minimumReleaseAge: value }),
      ),
      "top-level minimumReleaseAge is missing",
    );
  }
});
