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
  type CapFacts,
  checkCanonicalModel,
  LINKING_MODEL_FILES,
  parseCapFacts,
  runDeadlineModelDocsCheck,
  scanDeadlineModelContent,
} from "../lib/deadline_model_docs_check.ts";

/** Repository root — tests run with `worker/deno` as the working directory. */
const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

/** The figures the source of truth carries today, for the pure scan tests. */
const FACTS: CapFacts = { capSeconds: 10800, marginSeconds: 600 };

Deno.test("deadline docs - the retired 5400 s cap fails (Issue #426)", () => {
  const found = scanDeadlineModelContent(
    "docs/CONFIGURATION.md",
    "`loop.sh` wraps each run in `timeout <VIBE_RUN_MAX_SECONDS>` " +
      "(default 5400 s, `0` disables it).",
    FACTS,
  );
  assertEquals(found.length, 1);
  assertEquals(found[0]!.rule, "stale-run-cap");
  assertEquals(found[0]!.line, 1);
  assertStringIncludes(found[0]!.detail, "5400s");
  assertStringIncludes(found[0]!.detail, "10800s");
});

Deno.test("deadline docs - the cap loop.sh actually sets passes", () => {
  const found = scanDeadlineModelContent(
    "docs/DEPLOYMENT.md",
    "The supervisor cap is `VIBE_RUN_MAX_SECONDS=10800s` from run start.",
    FACTS,
  );
  assertEquals(found, []);
});

Deno.test("deadline docs - the check follows loop.sh when the cap moves", () => {
  const line = "`VIBE_RUN_MAX_SECONDS` defaults to 10800 s.";
  assertEquals(scanDeadlineModelContent("docs/X.md", line, FACTS), []);

  const raised = scanDeadlineModelContent("docs/X.md", line, {
    capSeconds: 14400,
    marginSeconds: 600,
  });
  assertEquals(raised.length, 1);
  assertEquals(raised[0]!.rule, "stale-run-cap");
  assertStringIncludes(raised[0]!.detail, "14400s");
});

Deno.test("deadline docs - the derived watchdog figures pass", () => {
  const found = scanDeadlineModelContent(
    "docs/DEPLOYMENT.md",
    "`VIBE_CONTAINER_WATCHDOG_SECONDS` defaults to the cap + 600 s = " +
      "11400 s, so the launcher never reaps a container the supervisor " +
      "would still allow to run.",
    FACTS,
  );
  assertEquals(found, []);
});

Deno.test("deadline docs - a watchdog that no longer clears the cap fails", () => {
  const found = scanDeadlineModelContent(
    "docs/DEPLOYMENT.md",
    "`VIBE_CONTAINER_WATCHDOG_SECONDS` defaults to 6000 s.",
    FACTS,
  );
  assertEquals(found.length, 1);
  assertEquals(found[0]!.rule, "stale-run-cap");
  assertStringIncludes(found[0]!.detail, "6000s");
});

Deno.test("deadline docs - describing the cap without quoting it passes", () => {
  const found = scanDeadlineModelContent(
    "docs/CONFIGURATION.md",
    "`loop.sh` wraps each run in `timeout <VIBE_RUN_MAX_SECONDS>`; the " +
      "default lives in `loop.sh` and the run-start line reports it.",
    FACTS,
  );
  assertEquals(found, []);
});

Deno.test("deadline docs - VIBE_RUN_MAX_SECONDS=0 is the documented disable", () => {
  const found = scanDeadlineModelContent(
    "docs/TROUBLESHOOTING.md",
    "If the run was uncapped, `VIBE_RUN_MAX_SECONDS` is `0s` — or the " +
      "worker was started outside `loop.sh`.",
    FACTS,
  );
  assertEquals(found, []);
});

Deno.test("deadline docs - an issue reference is not a seconds value", () => {
  const found = scanDeadlineModelContent(
    "docs/CONFIGURATION.md",
    "The worker reads `VIBE_RUN_MAX_SECONDS` with the run start epoch " +
      "(Issue #421), so it can see the deadline it runs towards.",
    FACTS,
  );
  assertEquals(found, []);
});

Deno.test("deadline docs - the cap figures are read from source, not prose", () => {
  const facts = parseCapFacts(
    'export VIBE_RUN_MAX_SECONDS="${VIBE_RUN_MAX_SECONDS:-10800}"\n',
    "export const WATCHDOG_MARGIN_SECONDS = 600;\n",
  );
  assertEquals(facts, { capSeconds: 10800, marginSeconds: 600 });
});

Deno.test("deadline docs - an underivable cap is a loud null, not a guess", () => {
  assertEquals(
    parseCapFacts("# the cap moved somewhere else\n", "const X = 600;\n"),
    null,
  );
});

Deno.test("deadline docs - extensions described as off by default fail", () => {
  const found = scanDeadlineModelContent(
    "docs/CONFIGURATION.md",
    "The progress-extended deadline is opt-in and off by default.",
    FACTS,
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
    FACTS,
  );
  assert(found.some((v) => v.rule === "extensions-off-by-default"));
});

Deno.test("deadline docs - extensions on by default passes", () => {
  const found = scanDeadlineModelContent(
    "docs/CONFIGURATION.md",
    "`progress_extension_enabled` defaults to `true` (Issue #422), so " +
      "progress extensions are on by default.",
    FACTS,
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
    FACTS,
  );
  assertEquals(found, []);
});

Deno.test("deadline docs - citing the execute-phase timeout rule fails", () => {
  const found = scanDeadlineModelContent(
    "docs/IDLE-TASK-FRAMEWORK.md",
    "Timeout becomes `min(requested, runway + claude_kill_after)` — the " +
      "`resolveExecuteTimeoutSeconds` rule the execute phase uses.",
    FACTS,
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
    FACTS,
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

/**
 * Write the source the check derives its figures from: `loop.sh`'s cap and
 * the launcher's watchdog margin.
 */
async function writeCapSource(
  root: string,
  facts: CapFacts = FACTS,
): Promise<void> {
  await Deno.mkdir(`${root}/worker/deno/lib`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/loop.sh`,
    `export VIBE_RUN_MAX_SECONDS="\${VIBE_RUN_MAX_SECONDS:-${facts.capSeconds}}"\n`,
  );
  await Deno.writeTextFile(
    `${root}/worker/deno/lib/container_watchdog.ts`,
    `export const WATCHDOG_MARGIN_SECONDS = ${facts.marginSeconds};\n`,
  );
}

Deno.test("deadline docs - no docs/ directory is SKIPPED, not FAILED", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await writeCapSource(tmp);
    const result = await runDeadlineModelDocsCheck(tmp);
    assertEquals(result.status, "SKIPPED");
    assertEquals(result.violations, []);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deadline docs - another repository's docs are SKIPPED", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/docs`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/docs/README.md`, "Someone else's docs.\n");
    const result = await runDeadlineModelDocsCheck(tmp);
    assertEquals(result.status, "SKIPPED");
    assertStringIncludes(result.output, "loop.sh");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deadline docs - an underivable cap fails loudly, not silently", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await writeCapSource(tmp);
    await Deno.writeTextFile(`${tmp}/loop.sh`, "# the cap moved elsewhere\n");
    await Deno.mkdir(`${tmp}/docs`, { recursive: true });
    await Deno.writeTextFile(
      `${tmp}/${CANONICAL_MODEL_FILE}`,
      `${CANONICAL_MODEL_HEADING}\n\nThe model.\n`,
    );
    const result = await runDeadlineModelDocsCheck(tmp);
    assertEquals(result.status, "FAILED");
    assertEquals(result.violations[0]!.rule, "stale-run-cap");
    assertStringIncludes(result.output, "VIBE_RUN_MAX_SECONDS");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deadline docs - a synthetic tree reports every rule it breaks", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await writeCapSource(tmp);
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
    assertEquals(rules, [
      "canonical-model",
      "canonical-model",
      "stale-run-cap",
    ]);
    assertStringIncludes(result.output, "cycle-deadline docs: FAILED");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deadline docs - archived PR summaries are exempt", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await writeCapSource(tmp);
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
