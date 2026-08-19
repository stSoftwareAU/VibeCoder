/**
 * Tests for the configuration defaults module.
 *
 * Verifies that:
 * 1. Default values are exported correctly
 * 2. loadConfig uses the shared defaults (consistency)
 * 3. The fallback config in mod.ts uses the shared defaults
 *
 * Issue #216: Consolidate configuration defaults into single source of truth.
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_CLAUDE_EFFORT_CI_FIX,
  DEFAULT_CLAUDE_EFFORT_CLARIFICATION,
  DEFAULT_CLAUDE_EFFORT_GRILL_ME,
  DEFAULT_CLAUDE_EFFORT_HEALTH,
  DEFAULT_CLAUDE_EFFORT_ISSUE,
  DEFAULT_CLAUDE_EFFORT_PLANNING,
  DEFAULT_CLAUDE_EFFORT_PR_FEEDBACK,
  DEFAULT_CLAUDE_EFFORT_QUALITY_FIX,
  DEFAULT_CLAUDE_EFFORT_QUESTION,
  DEFAULT_CLAUDE_EFFORT_REFINEMENT,
  DEFAULT_CLAUDE_EFFORT_REVISION,
  DEFAULT_CLAUDE_EFFORT_SPELLING_FIX,
  DEFAULT_CLAUDE_EFFORT_SUMMARISE,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_MODEL_CI_FIX,
  DEFAULT_CLAUDE_MODEL_CLARIFICATION,
  DEFAULT_CLAUDE_MODEL_GRILL_ME,
  DEFAULT_CLAUDE_MODEL_HEALTH,
  DEFAULT_CLAUDE_MODEL_ISSUE,
  DEFAULT_CLAUDE_MODEL_PLANNING,
  DEFAULT_CLAUDE_MODEL_PR_FEEDBACK,
  DEFAULT_CLAUDE_MODEL_QUALITY_FIX,
  DEFAULT_CLAUDE_MODEL_QUESTION,
  DEFAULT_CLAUDE_MODEL_REFINEMENT,
  DEFAULT_CLAUDE_MODEL_REVISION,
  DEFAULT_CLAUDE_MODEL_SPELLING_FIX,
  DEFAULT_CLAUDE_MODEL_SUMMARISE,
  DEFAULT_CLAUDE_MODEL_TOP_TIER,
  DEFAULT_EFFORT,
  DEFAULT_SHUFFLE_REPOS,
  DISCOVERY_LABELS,
  EFFORT_LEVELS,
  getCheaperModel,
  isReservedLabel,
  LABEL_DEFAULTS,
  NUMERIC_DEFAULTS,
  OPERATIONAL_DEFAULTS,
  PHASE_EFFORT_DEFAULTS,
  PHASE_MODEL_DEFAULTS,
} from "../lib/config_defaults.ts";
import { loadConfig } from "../lib/config.ts";
import type { ConfigFile } from "../types.ts";

// Test helper to create a temporary config file
async function withTempConfig(
  config: ConfigFile,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(config));
  try {
    await fn(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

// =============================================================================
// Default Values Exported Correctly
// =============================================================================

Deno.test("config_defaults - LABEL_DEFAULTS has correct workOnLabel", () => {
  assertEquals(LABEL_DEFAULTS.workOnLabel, "work-on");
});

Deno.test("config_defaults - LABEL_DEFAULTS has correct failedOnceLabel", () => {
  assertEquals(LABEL_DEFAULTS.failedOnceLabel, "failed-once");
});

Deno.test("config_defaults - LABEL_DEFAULTS has correct failedLabel", () => {
  assertEquals(LABEL_DEFAULTS.failedLabel, "failed");
});

Deno.test("config_defaults - LABEL_DEFAULTS does not expose needsClarificationLabel (Issue #2031)", () => {
  // Issue #2031: the field has been removed; clarification handoff signal
  // is `needs-human`.
  assertEquals(
    "needsClarificationLabel" in LABEL_DEFAULTS,
    false,
  );
  assertEquals(LABEL_DEFAULTS.needsHumanLabel, "needs-human");
});

Deno.test("config_defaults - LABEL_DEFAULTS has correct refineIssueLabel", () => {
  assertEquals(LABEL_DEFAULTS.refineIssueLabel, "refine-issue");
});

Deno.test("config_defaults - LABEL_DEFAULTS has correct topPriorityLabel (Issue #1834)", () => {
  // Issue #1834: top-priority hardwired alongside work-on and low-priority
  // as the three canonical discovery labels.
  assertEquals(LABEL_DEFAULTS.topPriorityLabel, "top-priority");
});

Deno.test("config_defaults - isReservedLabel matches case-insensitively (Issue #3088)", () => {
  // Lower-case canonical entries match.
  assertEquals(isReservedLabel("top-priority"), true);
  assertEquals(isReservedLabel("work-on"), true);
  assertEquals(isReservedLabel("planning"), true);
  // Non-lower-case forms must still match (GitHub is case-insensitive).
  assertEquals(isReservedLabel("Top-Priority"), true);
  assertEquals(isReservedLabel("WORK-ON"), true);
  assertEquals(isReservedLabel("Planning"), true);
  // Descriptive / non-reserved labels are not reserved regardless of case.
  assertEquals(isReservedLabel("idle-task"), false);
  assertEquals(isReservedLabel("Enhancement"), false);
  assertEquals(isReservedLabel("bug"), false);
});

Deno.test("config_defaults - DISCOVERY_LABELS has the three hardwired discovery labels (Issue #1834)", () => {
  // Issue #1834: top-priority, work-on, low-priority — hardwired and not
  // configurable. Diagnose builds its discovery list from these and dedups
  // against config.workOnLabel / config.lowPriorityLabel.
  assertEquals(DISCOVERY_LABELS, ["top-priority", "work-on", "low-priority"]);
});

Deno.test("config_defaults - NUMERIC_DEFAULTS has correct claudeTimeout (Issue #1824)", () => {
  // Issue #1824: lowered from 14400 (4h) to 3600 (1h) to keep wedged
  // Claude runs from consuming an entire iteration's run-duration budget.
  assertEquals(NUMERIC_DEFAULTS.claudeTimeout, 3600);
});

Deno.test("config_defaults - NUMERIC_DEFAULTS has correct maxClarificationRounds", () => {
  assertEquals(NUMERIC_DEFAULTS.maxClarificationRounds, 3);
});

// =============================================================================
// loadConfig Uses Shared Defaults (Consistency)
// =============================================================================

Deno.test("config_defaults - loadConfig uses shared label defaults", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.workOnLabel, LABEL_DEFAULTS.workOnLabel);
    assertEquals(config.failedOnceLabel, LABEL_DEFAULTS.failedOnceLabel);
    assertEquals(config.failedLabel, LABEL_DEFAULTS.failedLabel);
    // Issue #2031: needs-human (replacing the retired needs-clarification handoff).
    assertEquals(config.needsHumanLabel, LABEL_DEFAULTS.needsHumanLabel);
    assertEquals(config.refineIssueLabel, LABEL_DEFAULTS.refineIssueLabel);
  });
});

Deno.test("config_defaults - loadConfig issueLabels is hardwired (Issue #1834)", async () => {
  // Issue #1834: issueLabels is hardwired to [topPriorityLabel] —
  // .config.json may not override it, and the resolved value is stable
  // across every Vibe Coder install.
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.issueLabels, [LABEL_DEFAULTS.topPriorityLabel]);
  });
});

Deno.test("config_defaults - loadConfig uses shared numeric defaults", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.claudeTimeout, NUMERIC_DEFAULTS.claudeTimeout);
    assertEquals(
      config.maxClarificationRounds,
      NUMERIC_DEFAULTS.maxClarificationRounds,
    );
  });
});

// =============================================================================
// Claude Model Default (Issue #260)
// =============================================================================

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL is opus (best model first attempt)", () => {
  assertEquals(DEFAULT_CLAUDE_MODEL, "opus");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL_HEALTH stays haiku (effort-first secondary tier, Issue #2391)", () => {
  // Effort-first routing (#2391) consolidates the mid tier onto Opus but keeps
  // the three trivial phases on Haiku as the secondary tier lever.
  assertEquals(DEFAULT_CLAUDE_MODEL_HEALTH, "haiku");
});

Deno.test("config_defaults - loadConfig uses shared claude model default", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.claudeModel, DEFAULT_CLAUDE_MODEL);
  });
});

// =============================================================================
// Operational Defaults (Issue #277)
// =============================================================================

Deno.test("config_defaults - OPERATIONAL_DEFAULTS has correct claudeTimeout (Issue #1824)", () => {
  // Issue #1824: lowered from 14400 (4h) to 3600 (1h).
  assertEquals(OPERATIONAL_DEFAULTS.claudeTimeout, 3600);
});

Deno.test("config_defaults - OPERATIONAL_DEFAULTS has correct sleepInterval", () => {
  assertEquals(OPERATIONAL_DEFAULTS.sleepInterval, 30);
});

Deno.test("config_defaults - OPERATIONAL_DEFAULTS has correct planningTimeout (Issue #1824)", () => {
  // Issue #1824: lowered from 14400 (4h) to 1800 (30 min). Planning produces
  // sub-issues — it should be quick.
  assertEquals(OPERATIONAL_DEFAULTS.planningTimeout, 1800);
});

Deno.test("config_defaults - OPERATIONAL_DEFAULTS has correct prFeedbackTimeout (Issue #1824)", () => {
  // Issue #1824: 1800 (30 min) — a single PR comment cannot reasonably
  // need more.
  assertEquals(OPERATIONAL_DEFAULTS.prFeedbackTimeout, 1800);
});

Deno.test("config_defaults - OPERATIONAL_DEFAULTS has correct ciFixTimeout (Issue #1824)", () => {
  // Issue #1824: 1800 (30 min) — failed annotation set is bounded.
  assertEquals(OPERATIONAL_DEFAULTS.ciFixTimeout, 1800);
});

Deno.test("config_defaults - NUMERIC_DEFAULTS mirrors OPERATIONAL_DEFAULTS", () => {
  assertEquals(
    NUMERIC_DEFAULTS.claudeTimeout,
    OPERATIONAL_DEFAULTS.claudeTimeout,
  );
  assertEquals(
    NUMERIC_DEFAULTS.maxClarificationRounds,
    OPERATIONAL_DEFAULTS.maxClarificationRounds,
  );
});

Deno.test("config_defaults - LABEL_DEFAULTS has correct planningLabel", () => {
  assertEquals(LABEL_DEFAULTS.planningLabel, "planning");
});

Deno.test("config_defaults - LABEL_DEFAULTS has correct questionLabel (Issue #287)", () => {
  assertEquals(LABEL_DEFAULTS.questionLabel, "question");
});

Deno.test("config_defaults - LABEL_DEFAULTS no longer exposes answeredLabel (Issue #2030)", () => {
  // Issue #2030: `answered` retired — question workflow now signals handoff
  // with `needs-human`. The field has been removed from the config surface.
  assertEquals("answeredLabel" in LABEL_DEFAULTS, false);
});

Deno.test("config_defaults - LABEL_DEFAULTS has correct needsRevisionLabel (Issue #898)", () => {
  assertEquals(LABEL_DEFAULTS.needsRevisionLabel, "needs-revision");
});

Deno.test("config_defaults - LABEL_DEFAULTS has correct needsHumanLabel (Issue #1469)", () => {
  assertEquals(LABEL_DEFAULTS.needsHumanLabel, "needs-human");
});

Deno.test("config_defaults - LABEL_DEFAULTS has correct grillMeLabel (Issue #1616)", () => {
  assertEquals(LABEL_DEFAULTS.grillMeLabel, "grill-me");
});

// =============================================================================
// Low-Priority Label Scaffolding (Issue #1723)
// =============================================================================

Deno.test("config_defaults - LABEL_DEFAULTS has correct lowPriorityLabel (Issue #1723)", () => {
  assertEquals(LABEL_DEFAULTS.lowPriorityLabel, "low-priority");
});

Deno.test("config_defaults - RESERVED_LABELS includes low-priority (Issue #1723)", async () => {
  const { RESERVED_LABELS } = await import("../lib/config_defaults.ts");
  assertEquals(RESERVED_LABELS.includes("low-priority"), true);
});

Deno.test("config_defaults - buildDefaultWorkerConfig populates lowPriorityLabel (Issue #1723)", async () => {
  const { buildDefaultWorkerConfig } = await import(
    "../lib/config_defaults.ts"
  );
  const config = buildDefaultWorkerConfig();
  assertEquals(config.lowPriorityLabel, "low-priority");
});

Deno.test("config_defaults - loadConfig defaults lowPriorityLabel (Issue #1723)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.lowPriorityLabel, LABEL_DEFAULTS.lowPriorityLabel);
  });
});

Deno.test("config_defaults - lowPriorityLabel is hardwired (Issue #1834)", async () => {
  // Issue #1834: low_priority_label is no longer accepted; the resolved
  // value comes from LABEL_DEFAULTS only. Even if a stale config slipped
  // past `detectUnknownConfigKeys`, the loaded config must ignore it.
  const testConfig = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  } as ConfigFile;

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.lowPriorityLabel, LABEL_DEFAULTS.lowPriorityLabel);
  });
});

Deno.test("config_defaults - OPERATIONAL_DEFAULTS has correct maxGrillMeRounds (Issue #1616)", () => {
  assertEquals(OPERATIONAL_DEFAULTS.maxGrillMeRounds, 5);
});

Deno.test("config_defaults - OPERATIONAL_DEFAULTS has correct grillMeTimeout (Issue #3154)", () => {
  // Raised from 600 to match the issue-work budget: grill-me is an analysis
  // phase that may need to investigate the codebase / probe the served model.
  assertEquals(OPERATIONAL_DEFAULTS.grillMeTimeout, 3600);
  assertEquals(
    OPERATIONAL_DEFAULTS.grillMeTimeout,
    OPERATIONAL_DEFAULTS.claudeTimeout,
  );
});

Deno.test("config_defaults - OPERATIONAL_DEFAULTS has correct grillMeKillAfter (Issue #1616)", () => {
  assertEquals(OPERATIONAL_DEFAULTS.grillMeKillAfter, 10);
});

Deno.test("config_defaults - OPERATIONAL_DEFAULTS has correct questionTimeout (Issue #662)", () => {
  assertEquals(OPERATIONAL_DEFAULTS.questionTimeout, 600);
});

Deno.test("config_defaults - OPERATIONAL_DEFAULTS has correct healthCacheTtl (Issue #1070)", () => {
  assertEquals(OPERATIONAL_DEFAULTS.healthCacheTtl, 900);
});

Deno.test("config_defaults - loadConfig defaults healthCacheTtl to 900 (Issue #1070)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.healthCacheTtl, OPERATIONAL_DEFAULTS.healthCacheTtl);
  });
});

Deno.test("config_defaults - loadConfig loads health_cache_ttl override from config (Issue #1070)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    health_cache_ttl: 1800,
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.healthCacheTtl, 1800);
  });
});

Deno.test("config_defaults - loadConfig uses shared operational defaults (Issue #277)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.sleepInterval, OPERATIONAL_DEFAULTS.sleepInterval);
    assertEquals(
      config.creditWaitInterval,
      OPERATIONAL_DEFAULTS.creditWaitInterval,
    );
    assertEquals(
      config.refinementTimeout,
      OPERATIONAL_DEFAULTS.refinementTimeout,
    );
    assertEquals(config.planningTimeout, OPERATIONAL_DEFAULTS.planningTimeout);
    assertEquals(
      config.featureCheckTimeout,
      OPERATIONAL_DEFAULTS.featureCheckTimeout,
    );
    assertEquals(config.planningLabel, LABEL_DEFAULTS.planningLabel);
    assertEquals(config.questionLabel, LABEL_DEFAULTS.questionLabel);
    assertEquals(config.questionTimeout, OPERATIONAL_DEFAULTS.questionTimeout);
    assertEquals(config.needsRevisionLabel, LABEL_DEFAULTS.needsRevisionLabel);
  });
});

// =============================================================================
// Shuffle Repos Default (Issue #435)
// =============================================================================

Deno.test("config_defaults - DEFAULT_SHUFFLE_REPOS is true for backward compatibility", () => {
  assertEquals(DEFAULT_SHUFFLE_REPOS, true);
});

Deno.test("config_defaults - loadConfig defaults shuffleRepos to true", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.shuffleRepos, DEFAULT_SHUFFLE_REPOS);
  });
});

Deno.test("config_defaults - loadConfig loads shuffle_repos false from config", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    shuffle_repos: false,
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.shuffleRepos, false);
  });
});

Deno.test("config_defaults - loadConfig loads shuffle_repos true from config", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    shuffle_repos: true,
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.shuffleRepos, true);
  });
});

// =============================================================================
// Phase-Specific Model Defaults (Issue #1071)
// =============================================================================

// Effort-first routing (Issue #2391): every phase resolves to the single top
// tier (DEFAULT_CLAUDE_MODEL = "opus"); per-phase differentiation moved to
// PHASE_EFFORT_DEFAULTS. These tests previously asserted per-phase model
// families (sonnet/haiku) — updated for the single-tier model.

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL_REFINEMENT is the Fable 5 top tier (planning-shaped, Issue #3229)", () => {
  assertEquals(DEFAULT_CLAUDE_MODEL_REFINEMENT, DEFAULT_CLAUDE_MODEL_TOP_TIER);
});

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL_SPELLING_FIX stays haiku (effort-first secondary tier, Issue #2391)", () => {
  assertEquals(DEFAULT_CLAUDE_MODEL_SPELLING_FIX, "haiku");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL_QUESTION is the Fable 5 top tier (planning-shaped, Issue #3229)", () => {
  assertEquals(DEFAULT_CLAUDE_MODEL_QUESTION, DEFAULT_CLAUDE_MODEL_TOP_TIER);
});

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL_SUMMARISE stays haiku (effort-first secondary tier, Issue #2391)", () => {
  assertEquals(DEFAULT_CLAUDE_MODEL_SUMMARISE, "haiku");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL_PLANNING is the Fable 5 top tier (Issue #2621)", () => {
  // Issue #2621: planning moved from opus to fable — plan quality compounds
  // across every downstream sub-issue, so the top tier is spent here.
  assertEquals(DEFAULT_CLAUDE_MODEL_PLANNING, "fable");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL_TOP_TIER is the fable alias (Issue #2621)", () => {
  assertEquals(DEFAULT_CLAUDE_MODEL_TOP_TIER, "fable");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL_GRILL_ME is the Fable 5 top tier (Issue #2621)", () => {
  // Same plan-quality argument as planning: requirements interrogation shapes
  // everything downstream.
  assertEquals(DEFAULT_CLAUDE_MODEL_GRILL_ME, "fable");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_EFFORT_GRILL_ME is high (Issue #3229)", () => {
  // Issue #3229: planning-shaped phases run at "high" (was "max"); the `max`
  // bump is reserved for the #3217 pre-flight reroute to Opus.
  assertEquals(DEFAULT_CLAUDE_EFFORT_GRILL_ME, "high");
});

Deno.test("config_defaults - grill_me has explicit model and effort entries, no longer fallback-dependent (Issues #2621, #3229)", () => {
  // Before #2621 grill_me had no entry and silently rode the global fallbacks
  // (opus + high). It pins fable explicitly; #3229 set effort to high.
  assertEquals(PHASE_MODEL_DEFAULTS["grill_me"], "fable");
  assertEquals(PHASE_EFFORT_DEFAULTS["grill_me"], "high");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL_REVISION is the Fable 5 top tier (planning-shaped, Issue #3229)", () => {
  assertEquals(DEFAULT_CLAUDE_MODEL_REVISION, DEFAULT_CLAUDE_MODEL_TOP_TIER);
});

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL_CI_FIX is top tier (effort-first, Issue #2391)", () => {
  assertEquals(DEFAULT_CLAUDE_MODEL_CI_FIX, DEFAULT_CLAUDE_MODEL);
});

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL_PR_FEEDBACK is top tier (effort-first, Issue #2391)", () => {
  assertEquals(DEFAULT_CLAUDE_MODEL_PR_FEEDBACK, DEFAULT_CLAUDE_MODEL);
});

Deno.test("config_defaults - PHASE_MODEL_DEFAULTS routes planning-shaped phases to fable, reactive to opus, trivial to haiku (Issues #2391, #2621, #3229)", () => {
  // Issue #2621/#3229: model tier is the secondary lever at both extremes —
  // the six planning-shaped phases on Fable 5 (top), trivial phases on Haiku
  // (cheap), everything in between on Opus.
  const fablePhases = new Set([
    "planning",
    "grill_me",
    // Issue #4112: the two Quorum phases are planning-shaped — Quorum decides
    // what the plan is before planning splits it into sub-issues.
    "quorum",
    "quorum_judge",
    "refinement",
    "revision",
    "question",
    "clarification",
  ]);
  const haikuPhases = new Set(["spelling_fix", "summarise", "health"]);
  for (const [phase, model] of Object.entries(PHASE_MODEL_DEFAULTS)) {
    if (fablePhases.has(phase)) {
      assertEquals(
        model,
        "fable",
        `Planning-shaped phase "${phase}" should run on the Fable 5 top tier`,
      );
    } else if (haikuPhases.has(phase)) {
      assertEquals(
        model,
        "haiku",
        `Trivial phase "${phase}" should stay on the Haiku secondary tier`,
      );
    } else {
      assertEquals(
        model,
        DEFAULT_CLAUDE_MODEL,
        `Reactive/substantive phase "${phase}" should resolve to the Opus tier`,
      );
    }
  }
});

Deno.test("config_defaults - PHASE_MODEL_DEFAULTS consistent with individual constants (Issue #1071)", () => {
  assertEquals(PHASE_MODEL_DEFAULTS["planning"], DEFAULT_CLAUDE_MODEL_PLANNING);
  assertEquals(PHASE_MODEL_DEFAULTS["grill_me"], DEFAULT_CLAUDE_MODEL_GRILL_ME);
  assertEquals(PHASE_MODEL_DEFAULTS["issue"], DEFAULT_CLAUDE_MODEL_ISSUE);
  assertEquals(
    PHASE_MODEL_DEFAULTS["refinement"],
    DEFAULT_CLAUDE_MODEL_REFINEMENT,
  );
  assertEquals(PHASE_MODEL_DEFAULTS["revision"], DEFAULT_CLAUDE_MODEL_REVISION);
  assertEquals(PHASE_MODEL_DEFAULTS["ci_fix"], DEFAULT_CLAUDE_MODEL_CI_FIX);
  assertEquals(
    PHASE_MODEL_DEFAULTS["pr_feedback"],
    DEFAULT_CLAUDE_MODEL_PR_FEEDBACK,
  );
  assertEquals(
    PHASE_MODEL_DEFAULTS["spelling_fix"],
    DEFAULT_CLAUDE_MODEL_SPELLING_FIX,
  );
  assertEquals(PHASE_MODEL_DEFAULTS["question"], DEFAULT_CLAUDE_MODEL_QUESTION);
  assertEquals(
    PHASE_MODEL_DEFAULTS["clarification"],
    DEFAULT_CLAUDE_MODEL_CLARIFICATION,
  );
  assertEquals(
    PHASE_MODEL_DEFAULTS["summarise"],
    DEFAULT_CLAUDE_MODEL_SUMMARISE,
  );
  assertEquals(PHASE_MODEL_DEFAULTS["health"], DEFAULT_CLAUDE_MODEL_HEALTH);
  assertEquals(
    PHASE_MODEL_DEFAULTS["quality_fix"],
    DEFAULT_CLAUDE_MODEL_QUALITY_FIX,
  );
});

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL_QUALITY_FIX is top tier (effort-first, Issue #2391)", () => {
  assertEquals(DEFAULT_CLAUDE_MODEL_QUALITY_FIX, DEFAULT_CLAUDE_MODEL);
});

// =============================================================================
// Clarification Phase Model Default (Issue #1265)
// =============================================================================

Deno.test("config_defaults - DEFAULT_CLAUDE_MODEL_CLARIFICATION is the Fable 5 top tier (planning-shaped, Issue #3229)", () => {
  assertEquals(
    DEFAULT_CLAUDE_MODEL_CLARIFICATION,
    DEFAULT_CLAUDE_MODEL_TOP_TIER,
  );
});

Deno.test("config_defaults - PHASE_MODEL_DEFAULTS includes clarification phase (Issue #1265, #3229)", () => {
  assertEquals(
    PHASE_MODEL_DEFAULTS["clarification"],
    DEFAULT_CLAUDE_MODEL_TOP_TIER,
  );
});

Deno.test("config_defaults - PHASE_MODEL_DEFAULTS clarification consistent with constant (Issue #1265)", () => {
  assertEquals(
    PHASE_MODEL_DEFAULTS["clarification"],
    DEFAULT_CLAUDE_MODEL_CLARIFICATION,
  );
});

// =============================================================================
// Phase Model Config Overrides (Issue #1265)
// =============================================================================

Deno.test("config_defaults - loadConfig loads phase_model_overrides from config (Issue #1265)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    phase_model_overrides: {
      planning: "sonnet",
      health: "sonnet",
    },
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.phaseModelOverrides["planning"], "sonnet");
    assertEquals(config.phaseModelOverrides["health"], "sonnet");
  });
});

Deno.test("config_defaults - loadConfig defaults phaseModelOverrides to empty object (Issue #1265)", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.phaseModelOverrides, {});
  });
});

// =============================================================================
// Effort Level Constants (Issue #1402)
// =============================================================================

Deno.test("config_defaults - EFFORT_LEVELS has all five valid levels (Issue #1402, #2620)", () => {
  assertEquals(EFFORT_LEVELS.low, "low");
  assertEquals(EFFORT_LEVELS.medium, "medium");
  assertEquals(EFFORT_LEVELS.high, "high");
  assertEquals(EFFORT_LEVELS.xhigh, "xhigh");
  assertEquals(EFFORT_LEVELS.max, "max");
});

Deno.test("config_defaults - EFFORT_LEVELS includes xhigh between high and max (Issue #2620)", () => {
  const keys = Object.keys(EFFORT_LEVELS);
  assertEquals(keys.indexOf("xhigh"), keys.indexOf("high") + 1);
  assertEquals(keys.indexOf("max"), keys.indexOf("xhigh") + 1);
});

Deno.test("config_defaults - EFFORT_LEVELS has exactly five entries (Issue #1402, #2620)", () => {
  assertEquals(Object.keys(EFFORT_LEVELS).length, 5);
});

Deno.test("config_defaults - EFFORT_LEVELS values are all strings (Issue #1402)", () => {
  for (const value of Object.values(EFFORT_LEVELS)) {
    assertEquals(typeof value, "string");
  }
});

Deno.test("config_defaults - DEFAULT_EFFORT is high (Issue #1402)", () => {
  assertEquals(DEFAULT_EFFORT, "high");
});

Deno.test("config_defaults - DEFAULT_EFFORT is a valid effort level (Issue #1402)", () => {
  const validLevels = Object.values(EFFORT_LEVELS);
  assertEquals(validLevels.includes(DEFAULT_EFFORT), true);
});

// =============================================================================
// Per-Phase Effort Default Constants (Issue #1402)
// =============================================================================

Deno.test("config_defaults - DEFAULT_CLAUDE_EFFORT_PLANNING is high (Issue #3229)", () => {
  // Issue #3229: planning-shaped phases run at "high" (was "max"); the `max`
  // bump is reserved for the #3217 pre-flight reroute to Opus.
  assertEquals(DEFAULT_CLAUDE_EFFORT_PLANNING, "high");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_EFFORT_ISSUE is high (Issue #1402)", () => {
  assertEquals(DEFAULT_CLAUDE_EFFORT_ISSUE, "high");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_EFFORT_QUESTION is high (planning-shaped, Issue #3229)", () => {
  // Issue #3229: question is a planning-shaped phase — Fable 5 top tier at high.
  assertEquals(DEFAULT_CLAUDE_EFFORT_QUESTION, "high");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_EFFORT_CI_FIX is medium (Issue #1402)", () => {
  assertEquals(DEFAULT_CLAUDE_EFFORT_CI_FIX, "medium");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_EFFORT_PR_FEEDBACK is medium (Issue #1402)", () => {
  assertEquals(DEFAULT_CLAUDE_EFFORT_PR_FEEDBACK, "medium");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_EFFORT_QUALITY_FIX is medium (Issue #1402)", () => {
  assertEquals(DEFAULT_CLAUDE_EFFORT_QUALITY_FIX, "medium");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_EFFORT_REFINEMENT is high (planning-shaped, Issue #3229)", () => {
  assertEquals(DEFAULT_CLAUDE_EFFORT_REFINEMENT, "high");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_EFFORT_REVISION is high (planning-shaped, Issue #3229)", () => {
  assertEquals(DEFAULT_CLAUDE_EFFORT_REVISION, "high");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_EFFORT_CLARIFICATION is high (planning-shaped, Issue #3229)", () => {
  assertEquals(DEFAULT_CLAUDE_EFFORT_CLARIFICATION, "high");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_EFFORT_SPELLING_FIX is low (Issue #1402)", () => {
  assertEquals(DEFAULT_CLAUDE_EFFORT_SPELLING_FIX, "low");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_EFFORT_SUMMARISE is low (Issue #1402)", () => {
  assertEquals(DEFAULT_CLAUDE_EFFORT_SUMMARISE, "low");
});

Deno.test("config_defaults - DEFAULT_CLAUDE_EFFORT_HEALTH is low (Issue #1402)", () => {
  assertEquals(DEFAULT_CLAUDE_EFFORT_HEALTH, "low");
});

// =============================================================================
// PHASE_EFFORT_DEFAULTS Map (Issue #1402)
// =============================================================================

Deno.test("config_defaults - PHASE_EFFORT_DEFAULTS maps all phases (Issue #1402)", () => {
  // Issue #3229: the six planning-shaped phases run at high effort.
  assertEquals(PHASE_EFFORT_DEFAULTS["planning"], "high");
  assertEquals(PHASE_EFFORT_DEFAULTS["grill_me"], "high");
  assertEquals(PHASE_EFFORT_DEFAULTS["issue"], "high");
  assertEquals(PHASE_EFFORT_DEFAULTS["question"], "high");
  assertEquals(PHASE_EFFORT_DEFAULTS["ci_fix"], "medium");
  assertEquals(PHASE_EFFORT_DEFAULTS["pr_feedback"], "medium");
  assertEquals(PHASE_EFFORT_DEFAULTS["quality_fix"], "medium");
  assertEquals(PHASE_EFFORT_DEFAULTS["refinement"], "high");
  assertEquals(PHASE_EFFORT_DEFAULTS["revision"], "high");
  assertEquals(PHASE_EFFORT_DEFAULTS["clarification"], "high");
  assertEquals(PHASE_EFFORT_DEFAULTS["spelling_fix"], "low");
  assertEquals(PHASE_EFFORT_DEFAULTS["summarise"], "low");
  assertEquals(PHASE_EFFORT_DEFAULTS["health"], "low");
});

Deno.test("config_defaults - PHASE_EFFORT_DEFAULTS consistent with individual constants (Issue #1402)", () => {
  assertEquals(
    PHASE_EFFORT_DEFAULTS["planning"],
    DEFAULT_CLAUDE_EFFORT_PLANNING,
  );
  assertEquals(
    PHASE_EFFORT_DEFAULTS["grill_me"],
    DEFAULT_CLAUDE_EFFORT_GRILL_ME,
  );
  assertEquals(PHASE_EFFORT_DEFAULTS["issue"], DEFAULT_CLAUDE_EFFORT_ISSUE);
  assertEquals(
    PHASE_EFFORT_DEFAULTS["question"],
    DEFAULT_CLAUDE_EFFORT_QUESTION,
  );
  assertEquals(PHASE_EFFORT_DEFAULTS["ci_fix"], DEFAULT_CLAUDE_EFFORT_CI_FIX);
  assertEquals(
    PHASE_EFFORT_DEFAULTS["pr_feedback"],
    DEFAULT_CLAUDE_EFFORT_PR_FEEDBACK,
  );
  assertEquals(
    PHASE_EFFORT_DEFAULTS["quality_fix"],
    DEFAULT_CLAUDE_EFFORT_QUALITY_FIX,
  );
  assertEquals(
    PHASE_EFFORT_DEFAULTS["refinement"],
    DEFAULT_CLAUDE_EFFORT_REFINEMENT,
  );
  assertEquals(
    PHASE_EFFORT_DEFAULTS["revision"],
    DEFAULT_CLAUDE_EFFORT_REVISION,
  );
  assertEquals(
    PHASE_EFFORT_DEFAULTS["clarification"],
    DEFAULT_CLAUDE_EFFORT_CLARIFICATION,
  );
  assertEquals(
    PHASE_EFFORT_DEFAULTS["spelling_fix"],
    DEFAULT_CLAUDE_EFFORT_SPELLING_FIX,
  );
  assertEquals(
    PHASE_EFFORT_DEFAULTS["summarise"],
    DEFAULT_CLAUDE_EFFORT_SUMMARISE,
  );
  assertEquals(PHASE_EFFORT_DEFAULTS["health"], DEFAULT_CLAUDE_EFFORT_HEALTH);
});

Deno.test("config_defaults - PHASE_EFFORT_DEFAULTS all values are valid effort levels (Issue #1402)", () => {
  const validLevels = Object.values(EFFORT_LEVELS) as string[];
  for (const [phase, effort] of Object.entries(PHASE_EFFORT_DEFAULTS)) {
    assertEquals(
      validLevels.includes(effort),
      true,
      `Phase "${phase}" has invalid effort level "${effort}"`,
    );
  }
});

Deno.test("config_defaults - PHASE_EFFORT_DEFAULTS has exactly 15 phases (Issues #1402, #2621, #4112)", () => {
  // Issue #2621 added the explicit grill_me entry (was 12); Issue #4112 added
  // the two Quorum phases (quorum, quorum_judge).
  assertEquals(Object.keys(PHASE_EFFORT_DEFAULTS).length, 15);
});

// =============================================================================
// Effort-first routing invariant (Issue #2391)
// =============================================================================

Deno.test("config_defaults - routing: planning-shaped phases on fable, trivial on haiku, rest on opus (Issues #2391, #2621, #3229)", () => {
  // Effort is the primary lever; model tier is the secondary lever at both
  // extremes. The six planning-shaped phases run on Fable 5, trivial phases on
  // Haiku, everything else on the Opus tier.
  const fablePhases = new Set([
    "planning",
    "grill_me",
    // Issue #4112: the two Quorum phases are planning-shaped — Quorum decides
    // what the plan is before planning splits it into sub-issues.
    "quorum",
    "quorum_judge",
    "refinement",
    "revision",
    "question",
    "clarification",
  ]);
  const haikuPhases = new Set(["spelling_fix", "summarise", "health"]);
  for (const phase of Object.keys(PHASE_EFFORT_DEFAULTS)) {
    if (phase === "issue") continue; // issue has no model-default entry (base tier)
    const expected = fablePhases.has(phase)
      ? "fable"
      : haikuPhases.has(phase)
      ? "haiku"
      : DEFAULT_CLAUDE_MODEL;
    assertEquals(
      PHASE_MODEL_DEFAULTS[phase],
      expected,
      `Phase "${phase}" has the wrong default model tier`,
    );
  }
});

Deno.test("config_defaults - effort-first: effort tiers rank by phase complexity (Issues #2391, #2621, #3229)", () => {
  // Issue #3229: the six planning-shaped phases and issue all sit at high;
  // the three genuinely reactive phases sit at medium; trivial phases at low.
  const rank: Record<string, number> = { low: 0, medium: 1, high: 2, max: 3 };
  // Planning-shaped phases + issue at high.
  for (
    const phase of [
      "planning",
      "grill_me",
      "issue",
      "question",
      "refinement",
      "revision",
      "clarification",
    ]
  ) {
    assertEquals(
      rank[PHASE_EFFORT_DEFAULTS[phase]!],
      2,
      `Phase "${phase}" should default to high effort`,
    );
  }
  // Genuinely reactive phases sit at medium.
  for (const phase of ["ci_fix", "pr_feedback", "quality_fix"]) {
    assertEquals(
      rank[PHASE_EFFORT_DEFAULTS[phase]!],
      1,
      `Reactive phase "${phase}" should default to medium effort`,
    );
  }
  // Trivial phases sit at low.
  for (const phase of ["spelling_fix", "summarise", "health"]) {
    assertEquals(
      rank[PHASE_EFFORT_DEFAULTS[phase]!],
      0,
      `Trivial phase "${phase}" should default to low effort`,
    );
  }
});

// =============================================================================
// Full fifteen-phase model + effort table (Issues #3229, #4112)
//
// A single exhaustive table so any future drift in either map is caught at
// once. The eight planning-shaped phases run on fable + high; the three
// trivial phases on haiku + low; the remaining four (issue, ci_fix,
// pr_feedback, quality_fix) on opus, differentiated by effort.
// =============================================================================

Deno.test("config_defaults - fifteen-phase model + effort defaults table (Issues #3229, #4112)", () => {
  const table: Record<string, { model: string; effort: string }> = {
    // Eight planning-shaped phases → Fable 5 top tier at high.
    planning: { model: "fable", effort: "high" },
    grill_me: { model: "fable", effort: "high" },
    // Issue #4112: Quorum drafts and judges a plan — planning-shaped work.
    quorum: { model: "fable", effort: "high" },
    quorum_judge: { model: "fable", effort: "high" },
    refinement: { model: "fable", effort: "high" },
    revision: { model: "fable", effort: "high" },
    question: { model: "fable", effort: "high" },
    clarification: { model: "fable", effort: "high" },
    // Implementation phase → Opus base tier at high.
    issue: { model: "opus", effort: "high" },
    // Genuinely reactive phases → Opus base tier at medium.
    ci_fix: { model: "opus", effort: "medium" },
    pr_feedback: { model: "opus", effort: "medium" },
    quality_fix: { model: "opus", effort: "medium" },
    // Trivial phases → Haiku secondary tier at low.
    spelling_fix: { model: "haiku", effort: "low" },
    summarise: { model: "haiku", effort: "low" },
    health: { model: "haiku", effort: "low" },
  };

  // Every phase in the table resolves to the expected model + effort.
  for (const [phase, expected] of Object.entries(table)) {
    assertEquals(
      PHASE_MODEL_DEFAULTS[phase],
      expected.model,
      `Phase "${phase}" should default to model "${expected.model}"`,
    );
    assertEquals(
      PHASE_EFFORT_DEFAULTS[phase],
      expected.effort,
      `Phase "${phase}" should default to effort "${expected.effort}"`,
    );
  }

  // The table is exhaustive — no phase is missing or extra in either map.
  assertEquals(
    Object.keys(PHASE_MODEL_DEFAULTS).sort(),
    Object.keys(table).sort(),
  );
  assertEquals(
    Object.keys(PHASE_EFFORT_DEFAULTS).sort(),
    Object.keys(table).sort(),
  );
});

// Issue #3560: the "claude-opus-5" id has no version segment after the tier
// (no "-opus-N-M"), so getCheaperModel matches it only via the trailing
// "-opus" substring branch. Pin the sonnet fallback explicitly so a future
// matcher refactor cannot silently break Opus 5 degraded-mode tiering.
Deno.test("config_defaults - getCheaperModel returns sonnet for claude-opus-5 (Issue #3560)", () => {
  assertEquals(getCheaperModel("claude-opus-5"), "sonnet");
});

// Issue #4011: the converged #4003 cadence policy ships as the default, so an
// operator who configures nothing still gets the weekly `sonnet` / monthly
// `fable` floor. Pinned here so the default policy cannot drift silently.
Deno.test("config_defaults - buildDefaultWorkerConfig ships the #4003 cadence policy (Issue #4011)", async () => {
  const { buildDefaultWorkerConfig } = await import(
    "../lib/config_defaults.ts"
  );
  const cadence = buildDefaultWorkerConfig().idleTaskCadence;

  assertEquals(cadence.enabled, true);
  assertEquals(cadence.weeklyDays, 7);
  assertEquals(cadence.monthlyDays, 30);
  assertEquals(cadence.templates, {
    "security-scan": { weeklyModel: "sonnet", monthlyModel: "fable" },
    "supply-chain-readiness": { weeklyModel: "sonnet", monthlyModel: "fable" },
    "github-actions-audit": { weeklyModel: "sonnet", monthlyModel: "fable" },
  });
});
