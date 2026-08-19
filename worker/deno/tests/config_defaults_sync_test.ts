/**
 * Config defaults sync test — verifies shell and TypeScript defaults match.
 *
 * The shell defaults in worker/shared/config_defaults.sh must stay in sync
 * with the TypeScript defaults in worker/deno/lib/config_defaults.ts.
 * This test reads the shell file and verifies each label default matches.
 *
 * Issue #897: Register needs-revision as a workflow label and add config default.
 */

import { assert, assertEquals } from "@std/assert";
import { LABEL_DEFAULTS } from "../lib/config_defaults.ts";

/** Read the shell config defaults file and extract label assignments. */
async function readShellDefaults(): Promise<Map<string, string>> {
  const denoDir = new URL(".", import.meta.url).pathname;
  const shellPath = `${denoDir}../../shared/config_defaults.sh`;
  const content = await Deno.readTextFile(shellPath);
  const defaults = new Map<string, string>();

  // Match lines like: : "${NEEDS_REVISION_LABEL:=needs-revision}"
  const pattern = /: "\$\{(\w+_LABEL):=([^"]+)\}"/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    defaults.set(match[1]!, match[2]!);
  }
  return defaults;
}

/** Map from shell variable names to TypeScript LABEL_DEFAULTS keys. */
const SHELL_TO_TS: Record<string, keyof typeof LABEL_DEFAULTS> = {
  // Issue #1834: top-priority hardwired alongside work-on/low-priority.
  TOP_PRIORITY_LABEL: "topPriorityLabel",
  WORK_ON_LABEL: "workOnLabel",
  FAILED_LABEL: "failedLabel",
  FAILED_ONCE_LABEL: "failedOnceLabel",
  // Issue #2031: NEEDS_CLARIFICATION_LABEL retired — clarification handoff
  // is signalled via NEEDS_HUMAN_LABEL.
  REFINE_ISSUE_LABEL: "refineIssueLabel",
  PLANNING_LABEL: "planningLabel",
  QUESTION_LABEL: "questionLabel",
  // Issue #2030: ANSWERED_LABEL retired — question workflow now signals
  // handoff via NEEDS_HUMAN_LABEL.
  NEEDS_REVISION_LABEL: "needsRevisionLabel",
  NEEDS_HUMAN_LABEL: "needsHumanLabel",
  DOCUMENTATION_LABEL: "documentationLabel",
  NEEDS_SCREENSHOT_LABEL: "needsScreenshotLabel",
  GRILL_ME_LABEL: "grillMeLabel",
  // Issue #4112: the Quorum plan-off label.
  QUORUM_LABEL: "quorumLabel",
  LOW_PRIORITY_LABEL: "lowPriorityLabel",
};

Deno.test("config_defaults_sync - shell label defaults match TypeScript LABEL_DEFAULTS", async () => {
  const shellDefaults = await readShellDefaults();

  for (const [shellVar, tsKey] of Object.entries(SHELL_TO_TS)) {
    const shellValue = shellDefaults.get(shellVar);
    assert(
      shellValue !== undefined,
      `Shell default ${shellVar} not found in config_defaults.sh`,
    );
    const tsValue = LABEL_DEFAULTS[tsKey];
    assertEquals(
      shellValue,
      tsValue,
      `Shell ${shellVar}="${shellValue}" does not match TypeScript LABEL_DEFAULTS.${tsKey}="${tsValue}"`,
    );
  }
});

Deno.test("config_defaults_sync - NEEDS_REVISION_LABEL exists in shell defaults", async () => {
  const shellDefaults = await readShellDefaults();
  assert(
    shellDefaults.has("NEEDS_REVISION_LABEL"),
    "NEEDS_REVISION_LABEL must be defined in config_defaults.sh",
  );
  assertEquals(shellDefaults.get("NEEDS_REVISION_LABEL"), "needs-revision");
});

Deno.test("config_defaults_sync - every TypeScript label default has a shell counterpart", async () => {
  const shellDefaults = await readShellDefaults();
  const tsKeys = new Set(Object.values(SHELL_TO_TS));

  for (
    const key of Object.keys(LABEL_DEFAULTS) as Array<
      keyof typeof LABEL_DEFAULTS
    >
  ) {
    assert(
      tsKeys.has(key),
      `TypeScript LABEL_DEFAULTS.${key} has no mapping in SHELL_TO_TS — add it to the sync test`,
    );
  }

  // Verify all mapped shell vars exist
  for (const shellVar of Object.keys(SHELL_TO_TS)) {
    assert(
      shellDefaults.has(shellVar),
      `Expected shell variable ${shellVar} in config_defaults.sh but it was not found`,
    );
  }
});
