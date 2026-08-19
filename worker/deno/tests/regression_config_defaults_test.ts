/**
 * Regression test suite — config defaults parity validation (Issue #1235).
 *
 * Validates that shell config_defaults.sh and Deno config_defaults.ts remain
 * in sync across all categories: labels, timeouts, toggles, array defaults,
 * and model selections. Extends the existing config_defaults_sync_test.ts with
 * comprehensive operational default coverage.
 *
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildDefaultWorkerConfig,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_MODEL_PLANNING,
  DEFAULT_SHUFFLE_REPOS,
  DEFAULT_WORKER_NAME,
  DISCOVERY_LABELS,
  getCheaperModel,
  LABEL_DEFAULTS,
  MODEL_FALLBACK_MAP,
  OPERATIONAL_DEFAULTS,
  PHASE_MODEL_DEFAULTS,
  RESERVED_LABELS,
} from "../lib/config_defaults.ts";

// ============================================================================
// Helpers — read shell defaults
// ============================================================================

async function readShellFile(): Promise<string> {
  const denoDir = new URL(".", import.meta.url).pathname;
  const shellPath = `${denoDir}../../shared/config_defaults.sh`;
  return await Deno.readTextFile(shellPath);
}

/** Extract simple `: "${VAR:=value}"` assignments from shell config. */
function extractShellDefaults(content: string): Map<string, string> {
  const defaults = new Map<string, string>();
  const pattern = /: "\$\{(\w+):=([^"]*)\}"/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    defaults.set(match[1]!, match[2]!);
  }
  return defaults;
}

// ============================================================================
// Operational defaults — timeout parity
// ============================================================================

Deno.test("regression config - shell timeout defaults match Deno OPERATIONAL_DEFAULTS", async () => {
  const content = await readShellFile();
  const shellDefaults = extractShellDefaults(content);

  const timeoutMap: Record<string, keyof typeof OPERATIONAL_DEFAULTS> = {
    CLAUDE_TIMEOUT: "claudeTimeout",
    PR_FEEDBACK_TIMEOUT: "prFeedbackTimeout",
    CI_FIX_TIMEOUT: "ciFixTimeout",
    CLAUDE_KILL_AFTER: "claudeKillAfter",
    REFINEMENT_TIMEOUT: "refinementTimeout",
    REFINEMENT_KILL_AFTER: "refinementKillAfter",
    PLANNING_TIMEOUT: "planningTimeout",
    PLANNING_KILL_AFTER: "planningKillAfter",
    QUESTION_TIMEOUT: "questionTimeout",
    QUESTION_KILL_AFTER: "questionKillAfter",
    CLARIFICATION_TIMEOUT: "clarificationTimeout",
    CLARIFICATION_KILL_AFTER: "clarificationKillAfter",
    MAX_RATE_LIMIT_RETRIES: "maxRateLimitRetries",
    MAX_RATE_LIMIT_WAIT: "maxRateLimitWait",
    RETRY_MAX_DELAY: "retryMaxDelay",
    MAX_ISSUE_BODY_TOKENS: "maxIssueBodyTokens",
    SUMMARISE_TIMEOUT: "summariseTimeout",
    SUMMARISE_KILL_AFTER: "summariseKillAfter",
    FEATURE_CHECK_TIMEOUT: "featureCheckTimeout",
    CLAUDE_NO_OUTPUT_TIMEOUT: "claudeNoOutputTimeout",
    QUALITY_CHECK_TIMEOUT: "qualityCheckTimeout",
    MAX_CLARIFICATION_ROUNDS: "maxClarificationRounds",
    MAX_GRILL_ME_ROUNDS: "maxGrillMeRounds",
    GRILL_ME_TIMEOUT: "grillMeTimeout",
    GRILL_ME_KILL_AFTER: "grillMeKillAfter",
  };

  for (const [shellVar, tsKey] of Object.entries(timeoutMap)) {
    const shellValue = shellDefaults.get(shellVar);
    assert(
      shellValue !== undefined,
      `Shell default ${shellVar} not found in config_defaults.sh`,
    );
    const tsValue = OPERATIONAL_DEFAULTS[tsKey] as number;
    assertEquals(
      parseInt(shellValue!, 10),
      tsValue,
      `Shell ${shellVar}=${shellValue} does not match Deno OPERATIONAL_DEFAULTS.${tsKey}=${tsValue}`,
    );
  }
});

Deno.test("regression config - shell interval defaults match Deno OPERATIONAL_DEFAULTS", async () => {
  const content = await readShellFile();
  const shellDefaults = extractShellDefaults(content);

  assertEquals(
    parseInt(shellDefaults.get("SLEEP_INTERVAL")!, 10),
    OPERATIONAL_DEFAULTS.sleepInterval,
    "SLEEP_INTERVAL mismatch",
  );
  assertEquals(
    parseInt(shellDefaults.get("CREDIT_WAIT_INTERVAL")!, 10),
    OPERATIONAL_DEFAULTS.creditWaitInterval,
    "CREDIT_WAIT_INTERVAL mismatch",
  );
});

Deno.test("regression config - shell model defaults match Deno model defaults", async () => {
  const content = await readShellFile();
  const shellDefaults = extractShellDefaults(content);

  assertEquals(shellDefaults.get("CLAUDE_MODEL"), DEFAULT_CLAUDE_MODEL);
  assertEquals(
    shellDefaults.get("CLAUDE_MODEL_PLANNING"),
    DEFAULT_CLAUDE_MODEL_PLANNING,
  );
});

Deno.test("regression config - shell toggle defaults match Deno defaults", async () => {
  const content = await readShellFile();
  const shellDefaults = extractShellDefaults(content);

  assertEquals(
    shellDefaults.get("SHUFFLE_REPOS"),
    String(DEFAULT_SHUFFLE_REPOS),
  );
  assertEquals(shellDefaults.get("WORKER_NAME"), DEFAULT_WORKER_NAME);
});

// ============================================================================
// Array defaults — issue labels parity
// ============================================================================

Deno.test("regression config - shell ISSUE_LABELS contains only the hardwired top-priority label (Issue #1834)", async () => {
  // Issue #1834: ISSUE_LABELS is hardwired to a single element — the
  // top-priority discovery label. work-on and low-priority have
  // dedicated author-checked collectors and must not appear here.
  const content = await readShellFile();
  const match = content.match(/ISSUE_LABELS=\(([^)]+)\)/);
  assert(match !== null, "ISSUE_LABELS array not found in shell config");

  const shellLabels: string[] = [];
  const labelPattern = /"([^"]+)"/g;
  let labelMatch;
  while ((labelMatch = labelPattern.exec(match![1]!)) !== null) {
    shellLabels.push(labelMatch[1]!);
  }

  assertEquals(shellLabels, [LABEL_DEFAULTS.topPriorityLabel]);
});

Deno.test("regression config - DISCOVERY_LABELS contains the three hardwired discovery labels (Issue #1834)", () => {
  // Issue #1834: top-priority, work-on, low-priority — three constants
  // hardwired in LABEL_DEFAULTS and surfaced as DISCOVERY_LABELS for
  // diagnostic and admin tooling.
  assertEquals(DISCOVERY_LABELS, [
    LABEL_DEFAULTS.topPriorityLabel,
    LABEL_DEFAULTS.workOnLabel,
    LABEL_DEFAULTS.lowPriorityLabel,
  ]);
});

Deno.test("regression config - shell claim churn threshold matches Deno", async () => {
  const content = await readShellFile();
  const shellDefaults = extractShellDefaults(content);

  assertEquals(
    parseInt(shellDefaults.get("CLAIM_CHURN_THRESHOLD")!, 10),
    OPERATIONAL_DEFAULTS.claimChurnThreshold,
    "CLAIM_CHURN_THRESHOLD mismatch",
  );
});

// ============================================================================
// buildDefaultWorkerConfig — structural validation
// ============================================================================

Deno.test("regression config - buildDefaultWorkerConfig produces core LABEL_DEFAULTS", () => {
  const config = buildDefaultWorkerConfig();

  // Check labels that buildDefaultWorkerConfig explicitly includes
  // Issue #2031: needs-clarification retired — needs-human is the handoff label.
  // Issue #2166: narrow to keys present on BOTH LABEL_DEFAULTS and WorkerConfig
  // (e.g. topPriorityLabel is on LABEL_DEFAULTS but not on WorkerConfig).
  const coreLabels: Array<
    keyof typeof LABEL_DEFAULTS & keyof import("../types.ts").WorkerConfig
  > = [
    "workOnLabel",
    "failedOnceLabel",
    "failedLabel",
    "refineIssueLabel",
    "planningLabel",
    "questionLabel",
    "needsRevisionLabel",
    "needsHumanLabel",
    "lowPriorityLabel",
  ];

  for (const key of coreLabels) {
    assertEquals(
      config[key],
      LABEL_DEFAULTS[key],
      `buildDefaultWorkerConfig().${key} should be "${
        LABEL_DEFAULTS[key]
      }" but was "${config[key]}"`,
    );
  }
});

Deno.test("regression config - buildDefaultWorkerConfig produces core OPERATIONAL_DEFAULTS", () => {
  const config = buildDefaultWorkerConfig();

  // Check operational defaults that buildDefaultWorkerConfig explicitly includes.
  // Issue #2166: claimChurnThreshold removed — it is consumed by shell scripts
  // via the CLAIM_CHURN_THRESHOLD env var, not via WorkerConfig, so it does not
  // belong in WorkerConfig and was a stale field in the builder literal.
  // The intersection type rules out any OPERATIONAL_DEFAULTS key that isn't on
  // WorkerConfig — surfacing the next stale field at compile time.
  const coreOperational: Array<
    keyof typeof OPERATIONAL_DEFAULTS & keyof import("../types.ts").WorkerConfig
  > = [
    "claudeTimeout",
    "prFeedbackTimeout",
    "ciFixTimeout",
    "claudeKillAfter",
    "maxClarificationRounds",
    "sleepInterval",
    "creditWaitInterval",
    "refinementTimeout",
    "planningTimeout",
    "questionTimeout",
    "clarificationTimeout",
    "qualityCheckTimeout",
    "healthCacheTtl",
    "enableModelFallback",
    "minDiskSpaceMb",
    "syncMilestoneBranches",
    "enableSessionResume",
  ];

  for (const key of coreOperational) {
    assertEquals(
      config[key],
      // Cast through unknown: OPERATIONAL_DEFAULTS narrows arrays to
      // `readonly number[]`, while WorkerConfig types them as mutable.
      OPERATIONAL_DEFAULTS[key] as unknown,
      `buildDefaultWorkerConfig().${key} should be ${
        OPERATIONAL_DEFAULTS[key]
      } but was ${config[key]}`,
    );
  }
});

// Issue #2166: ensure buildDefaultWorkerConfig returns a fully-typed WorkerConfig.
// Previously the return type was `any`, which silently allowed missing fields
// (e.g. includeUntrustedComments) and extra fields not in WorkerConfig.
Deno.test("regression config #2166 - buildDefaultWorkerConfig includes includeUntrustedComments", () => {
  const config = buildDefaultWorkerConfig();
  assertEquals(
    config.includeUntrustedComments,
    OPERATIONAL_DEFAULTS.includeUntrustedComments,
    "buildDefaultWorkerConfig() must populate includeUntrustedComments from OPERATIONAL_DEFAULTS",
  );
});

Deno.test("regression config #2166 - buildDefaultWorkerConfig is assignable to WorkerConfig without a cast", () => {
  // This compiles only if the return type is WorkerConfig (not `any`).
  // Before #2166 the call sites needed `as WorkerConfig` to bridge the gap.
  const config: import("../types.ts").WorkerConfig = buildDefaultWorkerConfig();
  // includeUntrustedComments is a required field on WorkerConfig — accessing
  // it through the typed binding verifies the structural contract.
  assertEquals(typeof config.includeUntrustedComments, "boolean");
});

Deno.test("regression config - buildDefaultWorkerConfig overrides replace defaults", () => {
  const config = buildDefaultWorkerConfig({
    claudeTimeout: 999,
    workOnLabel: "custom-label",
  });

  assertEquals(config.claudeTimeout, 999);
  assertEquals(config.workOnLabel, "custom-label");
  // Other defaults should remain
  assertEquals(config.sleepInterval, OPERATIONAL_DEFAULTS.sleepInterval);
});

// ============================================================================
// RESERVED_LABELS — ensures all operational labels are reserved
// ============================================================================

Deno.test("regression config - RESERVED_LABELS includes all LABEL_DEFAULTS except non-workflow labels", () => {
  // The key workflow labels should all be reserved
  const expectedReserved = [
    LABEL_DEFAULTS.workOnLabel,
    LABEL_DEFAULTS.failedLabel,
    LABEL_DEFAULTS.failedOnceLabel,
    // Issue #2031: needs-clarification retired.
    LABEL_DEFAULTS.refineIssueLabel,
    LABEL_DEFAULTS.planningLabel,
    LABEL_DEFAULTS.questionLabel,
    LABEL_DEFAULTS.needsRevisionLabel,
    LABEL_DEFAULTS.needsHumanLabel,
    LABEL_DEFAULTS.grillMeLabel,
    LABEL_DEFAULTS.lowPriorityLabel,
  ];

  for (const label of expectedReserved) {
    assert(
      RESERVED_LABELS.includes(label),
      `RESERVED_LABELS should include "${label}"`,
    );
  }
});

Deno.test("regression config - RESERVED_LABELS includes 'answered' literal (Issue #2030)", () => {
  // Issue #2030: `answered` retired from LABEL_DEFAULTS but kept as a
  // literal in RESERVED_LABELS so the worker never re-applies it on repos
  // that still carry the deprecated label.
  assert(
    RESERVED_LABELS.includes("answered"),
    "RESERVED_LABELS must still include the literal 'answered'",
  );
});

Deno.test("regression config - RESERVED_LABELS includes grill-me (Issue #1616)", () => {
  assert(
    RESERVED_LABELS.includes("grill-me"),
    "RESERVED_LABELS must include 'grill-me' so the worker never applies it to created sub-issues",
  );
});

Deno.test("regression config - RESERVED_LABELS includes issue discovery labels", () => {
  assert(
    RESERVED_LABELS.includes("claude"),
    "RESERVED_LABELS should include 'claude'",
  );
  assert(
    RESERVED_LABELS.includes("help wanted"),
    "RESERVED_LABELS should include 'help wanted'",
  );
  // Issue #1623: top-priority must be reserved so the worker never self-applies it.
  assert(
    RESERVED_LABELS.includes("top-priority"),
    "RESERVED_LABELS should include 'top-priority'",
  );
});

// ============================================================================
// Model fallback — edge cases
// ============================================================================

Deno.test("regression config - getCheaperModel returns correct fallbacks", () => {
  assertEquals(getCheaperModel("opus"), "sonnet");
  assertEquals(getCheaperModel("sonnet"), "haiku");
  assertEquals(getCheaperModel("haiku"), null);
});

Deno.test("regression config - getCheaperModel handles full model IDs", () => {
  assertEquals(getCheaperModel("claude-opus-4-6"), "sonnet");
  assertEquals(getCheaperModel("claude-sonnet-4-6"), "haiku");
  assertEquals(getCheaperModel("claude-haiku-4-5-20251001"), null);
});

Deno.test("regression config - getCheaperModel returns null for unknown models", () => {
  assertEquals(getCheaperModel("unknown"), null);
  assertEquals(getCheaperModel(""), null);
  assertEquals(getCheaperModel("gpt-4"), null);
});

Deno.test("regression config - PHASE_MODEL_DEFAULTS covers all expected phases", () => {
  const expectedPhases = [
    "planning",
    "grill_me",
    "issue",
    "refinement",
    "revision",
    "ci_fix",
    "quality_fix",
    "pr_feedback",
    "spelling_fix",
    "question",
    "summarise",
    "health",
  ];

  for (const phase of expectedPhases) {
    assert(
      phase in PHASE_MODEL_DEFAULTS,
      `PHASE_MODEL_DEFAULTS should include phase "${phase}"`,
    );
  }
});

Deno.test("regression config - MODEL_FALLBACK_MAP forms a linear chain", () => {
  // Verify the chain: opus → sonnet → haiku → null
  let current: string | null = "opus";
  const chain: string[] = [];
  while (current !== null) {
    chain.push(current);
    current = MODEL_FALLBACK_MAP[current] ?? null;
  }

  assertEquals(chain, ["opus", "sonnet", "haiku"]);
});
