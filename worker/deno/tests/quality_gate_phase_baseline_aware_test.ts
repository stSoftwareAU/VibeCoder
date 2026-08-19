/**
 * Tests for the baseline-aware quality-gate feature flag.
 *
 * Exercises `isBaselineAwareQualityGateEnabled` (global default + per-repo
 * override). The shellcheck-only `decideBaselineAwareGate` /
 * `formatNewFindingsPrompt` helpers were removed with worker-side shellcheck
 * (Issue #3129); the generic diffable bypass they were superseded by is
 * covered by `baseline_gate_test.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { isBaselineAwareQualityGateEnabled } from "../lib/baseline_aware_gate.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function makeConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return { ...(buildDefaultWorkerConfig()), ...overrides };
}

Deno.test(
  "baseline-aware gate - enabled by global default",
  () => {
    const config = makeConfig({ baselineAwareQualityGate: true });
    assertEquals(isBaselineAwareQualityGateEnabled(config, "org/repo"), true);
  },
);

Deno.test(
  "baseline-aware gate - disabled by global default",
  () => {
    const config = makeConfig({ baselineAwareQualityGate: false });
    assertEquals(isBaselineAwareQualityGateEnabled(config, "org/repo"), false);
  },
);

Deno.test(
  "baseline-aware gate - per-repo override wins over global default",
  () => {
    const config = makeConfig({
      baselineAwareQualityGate: true,
      repoConfig: {
        "org/repo": { baselineAwareQualityGate: false },
      },
    });
    assertEquals(
      isBaselineAwareQualityGateEnabled(config, "org/repo"),
      false,
      "per-repo false override must disable feature",
    );
    assertEquals(
      isBaselineAwareQualityGateEnabled(config, "org/other"),
      true,
      "other repos still see global default",
    );
  },
);
