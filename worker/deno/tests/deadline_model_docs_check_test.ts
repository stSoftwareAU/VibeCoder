/**
 * Tests for the cycle-deadline documentation check (Issue #426).
 *
 * Each rule is exercised against both the retired fact it must catch and the
 * corrected wording it must accept, then the whole check is run against this
 * repository's real `docs/` tree — the regression that matters, since the
 * point of the check is that a stale number cannot survive review.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CANONICAL_MODEL_ANCHOR,
  CANONICAL_MODEL_FILE,
  CANONICAL_MODEL_HEADING,
  checkCanonicalModel,
  LINKING_MODEL_FILES,
  runDeadlineModelDocsCheck,
  scanDeadlineModelContent,
} from "../lib/deadline_model_docs_check.ts";

/** Repository root — tests run with `worker/deno` as the working directory. */
const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("deadline docs - a quoted supervisor cap fails (Issue #426)", () => {
  const found = scanDeadlineModelContent(
    "docs/CONFIGURATION.md",
    "`loop.sh` wraps each run in `timeout <VIBE_RUN_MAX_SECONDS>` " +
      "(default 5400 s, `0` disables it).",
  );
  assertEquals(found.length, 1);
  assertEquals(found[0]!.rule, "stale-run-cap");
  assertEquals(found[0]!.line, 1);
  assertStringIncludes(found[0]!.detail, "5400s");
});

Deno.test("deadline docs - a raised cap is caught just as a stale one is", () => {
  const found = scanDeadlineModelContent(
    "docs/DEPLOYMENT.md",
    "The supervisor cap is `VIBE_RUN_MAX_SECONDS=10800s` from run start.",
  );
  assertEquals(found.length, 1);
  assertEquals(found[0]!.rule, "stale-run-cap");
  assertStringIncludes(found[0]!.detail, "10800s");
});

Deno.test("deadline docs - describing the cap without quoting it passes", () => {
  const found = scanDeadlineModelContent(
    "docs/CONFIGURATION.md",
    "`loop.sh` wraps each run in `timeout <VIBE_RUN_MAX_SECONDS>`; the " +
      "default lives in `loop.sh` and the run-start line reports it.",
  );
  assertEquals(found, []);
});

Deno.test("deadline docs - VIBE_RUN_MAX_SECONDS=0 is the documented disable", () => {
  const found = scanDeadlineModelContent(
    "docs/TROUBLESHOOTING.md",
    "If the run was uncapped, `VIBE_RUN_MAX_SECONDS` is `0s` — or the " +
      "worker was started outside `loop.sh`.",
  );
  assertEquals(found, []);
});

Deno.test("deadline docs - an issue reference is not a seconds value", () => {
  const found = scanDeadlineModelContent(
    "docs/CONFIGURATION.md",
    "The worker reads `VIBE_RUN_MAX_SECONDS` with the run start epoch " +
      "(Issue #421), so it can see the deadline it runs towards.",
  );
  assertEquals(found, []);
});

Deno.test("deadline docs - extensions described as off by default fail", () => {
  const found = scanDeadlineModelContent(
    "docs/CONFIGURATION.md",
    "The progress-extended deadline is opt-in and off by default.",
  );
  assertEquals(found.length, 1);
  assertEquals(found[0]!.rule, "extensions-off-by-default");
});

Deno.test("deadline docs - off-by-default is caught across wrapped lines", () => {
  const found = scanDeadlineModelContent(
    "docs/CONFIGURATION.md",
    [
      "Progress extensions re-arm the deadline while the agent is",
      "demonstrably progressing. The feature is disabled by default, so a",
      "host that wants it must opt in.",
    ].join("\n"),
  );
  assert(found.some((v) => v.rule === "extensions-off-by-default"));
});

Deno.test("deadline docs - extensions on by default passes", () => {
  const found = scanDeadlineModelContent(
    "docs/CONFIGURATION.md",
    "`progress_extension_enabled` defaults to `true` (Issue #422), so " +
      "progress extensions are on by default.",
  );
  assertEquals(found, []);
});

Deno.test("deadline docs - 'Turning it off' near the feature name passes", () => {
  const found = scanDeadlineModelContent(
    "docs/CONFIGURATION.md",
    [
      "#### Turning it off",
      "",
      "Progress extensions are on by default (Issue #422). One key restores",
      "the flat one-shot kill.",
    ].join("\n"),
  );
  assertEquals(found, []);
});

Deno.test("deadline docs - citing the execute-phase timeout rule fails", () => {
  const found = scanDeadlineModelContent(
    "docs/IDLE-TASK-FRAMEWORK.md",
    "Timeout becomes `min(requested, runway + claude_kill_after)` — the " +
      "`resolveExecuteTimeoutSeconds` rule the execute phase uses.",
  );
  assertEquals(found.length, 1);
  assertEquals(found[0]!.rule, "execute-deadline-rule");
  assertStringIncludes(found[0]!.detail, "Issue #420");
});

Deno.test("deadline docs - the scan bound justified on its own terms passes", () => {
  const found = scanDeadlineModelContent(
    "docs/IDLE-TASK-FRAMEWORK.md",
    "A scan holds no work-in-progress and is discretionary, so its budget " +
      "is bounded by the runway left plus the kill grace.",
  );
  assertEquals(found, []);
});

Deno.test("deadline docs - a missing canonical section fails", () => {
  const violations = checkCanonicalModel(
    new Map([[CANONICAL_MODEL_FILE, "## Something else entirely\n"]]),
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]!.rule, "canonical-model");
  assertEquals(violations[0]!.file, CANONICAL_MODEL_FILE);
});

Deno.test("deadline docs - a page that does not link to the model fails", () => {
  const violations = checkCanonicalModel(
    new Map([
      [CANONICAL_MODEL_FILE, `${CANONICAL_MODEL_HEADING}\n\nThe model.\n`],
      ["docs/DEPLOYMENT.md", "The supervisor cap bounds a run.\n"],
    ]),
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]!.file, "docs/DEPLOYMENT.md");
  assertStringIncludes(violations[0]!.detail, CANONICAL_MODEL_ANCHOR);
});

Deno.test("deadline docs - canonical section plus links passes", () => {
  const files = new Map<string, string>([
    [CANONICAL_MODEL_FILE, `${CANONICAL_MODEL_HEADING}\n\nThe model.\n`],
  ]);
  for (const relPath of LINKING_MODEL_FILES) {
    files.set(relPath, `See [the model](${CANONICAL_MODEL_ANCHOR}).\n`);
  }
  assertEquals(checkCanonicalModel(files), []);
});

Deno.test("deadline docs - an absent page is skipped, not failed", () => {
  const violations = checkCanonicalModel(
    new Map([[CANONICAL_MODEL_FILE, `${CANONICAL_MODEL_HEADING}\n`]]),
  );
  assertEquals(violations, []);
});

Deno.test("deadline docs - no docs/ directory is SKIPPED, not FAILED", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const result = await runDeadlineModelDocsCheck(tmp);
    assertEquals(result.status, "SKIPPED");
    assertEquals(result.violations, []);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deadline docs - a synthetic tree reports every rule it breaks", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/docs`, { recursive: true });
    await Deno.writeTextFile(
      `${tmp}/${CANONICAL_MODEL_FILE}`,
      "### ⏳ Progress-extended deadline\n\n" +
        "`timeout <VIBE_RUN_MAX_SECONDS>` (default 5400 s).\n",
    );
    await Deno.writeTextFile(
      `${tmp}/docs/DEPLOYMENT.md`,
      "The supervisor cap bounds a run.\n",
    );
    const result = await runDeadlineModelDocsCheck(tmp);
    assertEquals(result.status, "FAILED");
    const rules = result.violations.map((v) => v.rule).sort();
    assertEquals(rules, ["canonical-model", "canonical-model", "stale-run-cap"]);
    assertStringIncludes(result.output, "cycle-deadline docs: FAILED");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deadline docs - archived PR summaries are exempt", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/docs/archive/pr-summaries`, { recursive: true });
    await Deno.writeTextFile(
      `${tmp}/${CANONICAL_MODEL_FILE}`,
      `${CANONICAL_MODEL_HEADING}\n\nThe model.\n`,
    );
    await Deno.writeTextFile(
      `${tmp}/docs/archive/pr-summaries/pr-summary-421.md`,
      "Run hard cap: VIBE_RUN_MAX_SECONDS=5400s from run start.\n",
    );
    const result = await runDeadlineModelDocsCheck(tmp);
    assertEquals(result.status, "PASSED");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deadline docs - this repository's own docs satisfy the model (Issue #426)", async () => {
  const result = await runDeadlineModelDocsCheck(ROOT);
  assertEquals(
    result.status,
    "PASSED",
    `expected the repository's docs to pass:\n${result.output}`,
  );
  assert(result.filesScanned > 0);
});
