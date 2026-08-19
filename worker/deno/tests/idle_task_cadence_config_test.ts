/**
 * Tests for the `idle_task_cadence` config parser (Issue #4011).
 *
 * The cadence policy (#4003/#4008) is a spend decision — which templates get a
 * guaranteed floor, over which windows, and at which model tier — so it is
 * operator-only configuration in `.config.json` (#2625/#2626), never an in-repo
 * setting. This suite is the acceptance-criteria matrix from the issue:
 *
 *   1. a valid block parses;
 *   2. an unknown template name warns and is dropped;
 *   3. a bad model alias warns and falls back to the default tier;
 *   4. `monthly_days <= weekly_days` (and non-finite / non-positive days) warns
 *      and falls back to 7/30;
 *   5. a missing or malformed block yields the defaults without throwing; and
 *   6. `enabled: false` round-trips as the kill switch.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertNotStrictEquals } from "@std/assert";
import {
  DEFAULT_CADENCE_POLICY,
  MONTHLY_MODEL_TIER,
  MONTHLY_WINDOW_DAYS,
  WEEKLY_MODEL_TIER,
  WEEKLY_WINDOW_DAYS,
} from "../lib/idle_task_cadence.ts";
import { parseIdleTaskCadence } from "../lib/idle_task_cadence_config.ts";

/** Collect warnings so each case can assert the parser is loud. */
function recorder(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message: string) => messages.push(message), messages };
}

/** Assert at least one warning mentions each of the given fragments. */
function assertWarned(messages: string[], ...fragments: string[]): void {
  for (const fragment of fragments) {
    assert(
      messages.some((m) => m.includes(fragment)),
      `expected a warning mentioning "${fragment}", got: ${
        JSON.stringify(messages)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

Deno.test("parseIdleTaskCadence - an absent block yields the defaults silently", () => {
  const { warn, messages } = recorder();

  assertEquals(parseIdleTaskCadence(undefined, { warn }), {
    ...DEFAULT_CADENCE_POLICY,
  });
  assertEquals(parseIdleTaskCadence(null, { warn }), {
    ...DEFAULT_CADENCE_POLICY,
  });
  assertEquals(messages, []);
});

Deno.test("parseIdleTaskCadence - the default policy is the converged #4003 policy", () => {
  const policy = parseIdleTaskCadence(undefined);

  assertEquals(policy.enabled, true);
  assertEquals(policy.weeklyDays, WEEKLY_WINDOW_DAYS);
  assertEquals(policy.monthlyDays, MONTHLY_WINDOW_DAYS);
  assertEquals(Object.keys(policy.templates).sort(), [
    "github-actions-audit",
    "security-scan",
    "supply-chain-readiness",
  ]);
  for (const template of Object.values(policy.templates)) {
    assertEquals(template.weeklyModel, WEEKLY_MODEL_TIER);
    assertEquals(template.monthlyModel, MONTHLY_MODEL_TIER);
  }
});

Deno.test("parseIdleTaskCadence - the result never aliases the shared default policy", () => {
  const policy = parseIdleTaskCadence(undefined);

  assertNotStrictEquals(policy, DEFAULT_CADENCE_POLICY);
  assertNotStrictEquals(policy.templates, DEFAULT_CADENCE_POLICY.templates);
  assertNotStrictEquals(
    policy.templates["security-scan"],
    DEFAULT_CADENCE_POLICY.templates["security-scan"],
  );
});

Deno.test("parseIdleTaskCadence - a malformed block warns and yields the defaults", () => {
  for (const raw of ["weekly", 7, [], true]) {
    const { warn, messages } = recorder();
    assertEquals(parseIdleTaskCadence(raw, { warn }), {
      ...DEFAULT_CADENCE_POLICY,
    });
    assertWarned(messages, "idle_task_cadence");
  }
});

// ---------------------------------------------------------------------------
// Valid configuration
// ---------------------------------------------------------------------------

Deno.test("parseIdleTaskCadence - a valid block parses", () => {
  const { warn, messages } = recorder();

  const policy = parseIdleTaskCadence({
    enabled: true,
    templates: {
      "security-scan": { weekly_model: "haiku", monthly_model: "opus" },
      "test-audit": { weekly_model: "sonnet", monthly_model: "fable" },
    },
    weekly_days: 5,
    monthly_days: 45,
  }, { warn });

  assertEquals(policy, {
    enabled: true,
    weeklyDays: 5,
    monthlyDays: 45,
    templates: {
      "security-scan": { weeklyModel: "haiku", monthlyModel: "opus" },
      "test-audit": { weeklyModel: "sonnet", monthlyModel: "fable" },
    },
  });
  assertEquals(messages, []);
});

Deno.test("parseIdleTaskCadence - enabled:false round-trips as the kill switch", () => {
  const { warn, messages } = recorder();

  const policy = parseIdleTaskCadence({ enabled: false }, { warn });

  assertEquals(policy.enabled, false);
  // The kill switch alone must not disturb the rest of the policy.
  assertEquals(policy.templates, DEFAULT_CADENCE_POLICY.templates);
  assertEquals(policy.weeklyDays, WEEKLY_WINDOW_DAYS);
  assertEquals(policy.monthlyDays, MONTHLY_WINDOW_DAYS);
  assertEquals(messages, []);
});

Deno.test("parseIdleTaskCadence - a non-boolean enabled warns and stays enabled", () => {
  const { warn, messages } = recorder();

  const policy = parseIdleTaskCadence({ enabled: "false" }, { warn });

  assertEquals(policy.enabled, true);
  assertWarned(messages, "enabled");
});

Deno.test("parseIdleTaskCadence - an omitted model alias takes the window default", () => {
  const policy = parseIdleTaskCadence({
    templates: { "security-scan": {} },
  });

  assertEquals(policy.templates, {
    "security-scan": {
      weeklyModel: WEEKLY_MODEL_TIER,
      monthlyModel: MONTHLY_MODEL_TIER,
    },
  });
});

// ---------------------------------------------------------------------------
// Template validation
// ---------------------------------------------------------------------------

Deno.test("parseIdleTaskCadence - an unknown template name warns and is dropped", () => {
  const { warn, messages } = recorder();

  const policy = parseIdleTaskCadence({
    templates: {
      "secuirty-scan": { weekly_model: "sonnet", monthly_model: "fable" },
      "security-scan": { weekly_model: "sonnet", monthly_model: "fable" },
    },
  }, { warn });

  assertEquals(Object.keys(policy.templates), ["security-scan"]);
  assertWarned(messages, "secuirty-scan", "unknown");
});

Deno.test("parseIdleTaskCadence - a non-object template entry warns and is dropped", () => {
  const { warn, messages } = recorder();

  const policy = parseIdleTaskCadence({
    templates: { "security-scan": "sonnet" },
  }, { warn });

  assertEquals(policy.templates, {});
  assertWarned(messages, "security-scan");
});

Deno.test("parseIdleTaskCadence - a non-object templates block warns and keeps the defaults", () => {
  const { warn, messages } = recorder();

  const policy = parseIdleTaskCadence({ templates: ["security-scan"] }, {
    warn,
  });

  assertEquals(policy.templates, DEFAULT_CADENCE_POLICY.templates);
  assertWarned(messages, "templates");
});

Deno.test("parseIdleTaskCadence - a bad model alias warns and falls back to the default tier", () => {
  const { warn, messages } = recorder();

  const policy = parseIdleTaskCadence({
    templates: {
      "security-scan": { weekly_model: "gpt-5", monthly_model: 7 },
    },
  }, { warn });

  assertEquals(policy.templates, {
    "security-scan": {
      weeklyModel: WEEKLY_MODEL_TIER,
      monthlyModel: MONTHLY_MODEL_TIER,
    },
  });
  assertWarned(messages, "weekly_model", "monthly_model");
});

// ---------------------------------------------------------------------------
// Window validation
// ---------------------------------------------------------------------------

Deno.test("parseIdleTaskCadence - monthly_days <= weekly_days warns and falls back", () => {
  const { warn, messages } = recorder();

  const policy = parseIdleTaskCadence({
    weekly_days: 30,
    monthly_days: 30,
  }, { warn });

  assertEquals(policy.weeklyDays, WEEKLY_WINDOW_DAYS);
  assertEquals(policy.monthlyDays, MONTHLY_WINDOW_DAYS);
  assertWarned(messages, "monthly_days");
});

Deno.test("parseIdleTaskCadence - non-finite and non-positive windows warn and fall back", () => {
  for (
    const raw of [
      { weekly_days: 0, monthly_days: 30 },
      { weekly_days: -7, monthly_days: 30 },
      { weekly_days: 7, monthly_days: Number.NaN },
      { weekly_days: "7", monthly_days: 30 },
      { weekly_days: 7, monthly_days: null },
    ]
  ) {
    const { warn, messages } = recorder();
    const policy = parseIdleTaskCadence(raw, { warn });

    assertEquals(
      policy.weeklyDays,
      WEEKLY_WINDOW_DAYS,
      `weeklyDays for ${JSON.stringify(raw)}`,
    );
    assertEquals(
      policy.monthlyDays,
      MONTHLY_WINDOW_DAYS,
      `monthlyDays for ${JSON.stringify(raw)}`,
    );
    assert(
      messages.length > 0,
      `expected a warning for ${JSON.stringify(raw)}`,
    );
  }
});

Deno.test("parseIdleTaskCadence - one valid window is kept when the other is absent", () => {
  const { warn, messages } = recorder();

  const policy = parseIdleTaskCadence({ weekly_days: 3 }, { warn });

  assertEquals(policy.weeklyDays, 3);
  assertEquals(policy.monthlyDays, MONTHLY_WINDOW_DAYS);
  assertEquals(messages, []);
});

// ---------------------------------------------------------------------------
// Unknown keys
// ---------------------------------------------------------------------------

Deno.test("parseIdleTaskCadence - an unrecognised key warns but does not stop the parse", () => {
  const { warn, messages } = recorder();

  const policy = parseIdleTaskCadence({
    enabled: true,
    weekly_days: 4,
    quarterly_days: 90,
  }, { warn });

  assertEquals(policy.weeklyDays, 4);
  assertWarned(messages, "quarterly_days");
});
