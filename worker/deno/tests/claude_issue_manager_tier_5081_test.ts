/**
 * The Claude `issue` manager (Opus) is pinned above the shared `standard` tier
 * (Sonnet) — Issue #5081.
 *
 * Before the split, Claude's `standard` tier *was* the issue-manager constant,
 * so moving the manager to Opus silently moved ci_fix, pr_feedback,
 * quality_fix and merge_conflict to Opus too. These tests pin both
 * directions: the manager is Opus, and the reactive phases stay on Sonnet —
 * including when an operator regenerates the tier map through
 * `phase_model_tiers` / `provider_model_tiers`.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  PHASE_MODEL_DEFAULTS,
  PROVIDER_MODEL_TIERS,
} from "../lib/config_defaults.ts";
import { loadConfig } from "../lib/config.ts";
import { emptyEnv } from "./support/env_lookup.ts";

const REACTIVE = ["ci_fix", "pr_feedback", "quality_fix", "merge_conflict"];

async function configWith(file: Record<string, unknown>) {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, JSON.stringify(file));
    return await loadConfig(path, { env: emptyEnv });
  } finally {
    await Deno.remove(path);
  }
}

Deno.test("Issue #5081 - the Opus issue manager does not drag the reactive phases off Sonnet", () => {
  assertEquals(PHASE_MODEL_DEFAULTS["issue"], "opus");
  assertEquals(PROVIDER_MODEL_TIERS.claude.standard, "sonnet");
  for (const phase of REACTIVE) {
    assertEquals(PHASE_MODEL_DEFAULTS[phase], "sonnet", phase);
  }
});

Deno.test("Issue #5081 - a regenerated Claude tier map keeps the Opus issue manager", async () => {
  const config = await configWith({
    provider_model_tiers: {
      claude: { best: "fable", standard: "sonnet", fast: "haiku" },
    },
  });
  assertEquals(config.phaseModelOverrides["issue"], "opus");
  for (const phase of REACTIVE) {
    assertEquals(config.phaseModelOverrides[phase], "sonnet", phase);
  }
});

Deno.test("Issue #5081 - an operator tiering issue explicitly still wins", async () => {
  const config = await configWith({
    phase_model_tiers: { issue: "standard" },
  });
  assertEquals(config.phaseModelOverrides["issue"], "sonnet");
});

Deno.test("Issue #5081 - an unconfigured deployment carries no tier overrides", async () => {
  // The pin applies only to a regenerated map; with no tier settings the
  // override map stays empty and the built-in defaults route the phases.
  const config = await configWith({});
  assertEquals(config.phaseModelOverrides["issue"], undefined);
});
