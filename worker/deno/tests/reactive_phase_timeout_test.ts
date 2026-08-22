/**
 * Tests for the reactive-phase budget resolver (Issue #213).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { reactivePhaseTimeout } from "../lib/reactive_phase_timeout.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

Deno.test("reactive phase timeout - each phase uses its own configured key (Issue #213)", () => {
  const config = { prFeedbackTimeout: 900, ciFixTimeout: 1200 };
  assertEquals(reactivePhaseTimeout(config, "pr-feedback"), 900);
  assertEquals(reactivePhaseTimeout(config, "ci-fix"), 1200);
});

Deno.test("reactive phase timeout - a CI fix never inherits the issue-work hour (Issue #213)", () => {
  // The exact production shape from the incident: `claude_timeout: 3600`
  // with the reactive keys left at their documented 1800.
  const config = buildDefaultWorkerConfig();
  config.claudeTimeout = 3600;
  config.ciFixTimeout = OPERATIONAL_DEFAULTS.ciFixTimeout;
  config.prFeedbackTimeout = OPERATIONAL_DEFAULTS.prFeedbackTimeout;

  assertEquals(reactivePhaseTimeout(config, "ci-fix"), 1800);
  assertEquals(reactivePhaseTimeout(config, "pr-feedback"), 1800);
  assert(
    reactivePhaseTimeout(config, "ci-fix") !== config.claudeTimeout,
    "the CI-fix budget must never resolve to claude_timeout",
  );
});

Deno.test("reactive phase timeout - a missing budget degrades to the phase default, not to claude_timeout (Issue #213)", () => {
  // A config that lost its reactive keys must fall back to the documented
  // reactive value; silently using the hour-long issue-work budget is the
  // very failure this resolver exists to stop.
  for (
    const missing of [
      undefined as unknown as number,
      0,
      -1,
      Number.NaN,
    ]
  ) {
    const config = { prFeedbackTimeout: missing, ciFixTimeout: missing };
    assertEquals(
      reactivePhaseTimeout(config, "ci-fix"),
      OPERATIONAL_DEFAULTS.ciFixTimeout,
    );
    assertEquals(
      reactivePhaseTimeout(config, "pr-feedback"),
      OPERATIONAL_DEFAULTS.prFeedbackTimeout,
    );
  }
});
