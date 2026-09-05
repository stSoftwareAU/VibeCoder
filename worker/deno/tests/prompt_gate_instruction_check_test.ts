/**
 * Tests for the unconditional-gate-instruction check (Issue #1138).
 *
 * The scanning functions are exercised against literal templates, and the
 * shipped prompts are then scanned as the standing guard: a template that
 * hard-codes "run the gate before you push" bypasses the budget-aware
 * decision in `buildQualityInstructions` and spends the run on a gate CI runs
 * for free.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  findUnconditionalGateInstructions,
  formatGateInstructionFailure,
  GATE_INSTRUCTION_ALLOWLIST,
  scanPromptsForUnconditionalGate,
} from "../lib/prompt_gate_instruction_check.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("gate instruction check - catches an order to run the gate before pushing", () => {
  const found = findUnconditionalGateInstructions(
    "x/prompt.md",
    "- Run `./quality.sh` locally and ensure all checks pass BEFORE pushing.\n",
  );
  assertEquals(found.length, 1);
  assertEquals(found[0]!.line, 1);
});

Deno.test("gate instruction check - catches a gate asserted as passed", () => {
  const found = findUnconditionalGateInstructions(
    "x/prompt.md",
    "**Gate:** `./quality.sh` (or the repository's gate) passed locally.\n",
  );
  assertEquals(found.length, 1);
});

Deno.test("gate instruction check - catches the bare command with no leading ./", () => {
  const found = findUnconditionalGateInstructions(
    "x/prompt.md",
    "Re-run quality.sh after every edit.\n",
  );
  assertEquals(found.length, 1);
});

Deno.test("gate instruction check - allows a budget-conditional instruction", () => {
  const found = findUnconditionalGateInstructions(
    "x/prompt.md",
    "- Run `./quality.sh` once at the end, but only when the run budget covers it.\n",
  );
  assertEquals(found.length, 0);
});

Deno.test("gate instruction check - allows an instruction that names the skip channel", () => {
  const found = findUnconditionalGateInstructions(
    "x/prompt.md",
    "- Check `.vibe-run-budget.md` before you run `./quality.sh`.\n",
  );
  assertEquals(found.length, 0);
});

Deno.test("gate instruction check - ignores fenced examples", () => {
  const found = findUnconditionalGateInstructions(
    "x/prompt.md",
    ["Example output:", "", "```bash", "run ./quality.sh", "```", ""].join(
      "\n",
    ),
  );
  assertEquals(found.length, 0);
});

Deno.test("gate instruction check - ignores prose that merely mentions the script", () => {
  const found = findUnconditionalGateInstructions(
    "x/prompt.md",
    "The repository commits its gate as `quality.sh` at the root.\n",
  );
  assertEquals(found.length, 0);
});

Deno.test("gate instruction check - reports every offending line in order", () => {
  const found = findUnconditionalGateInstructions(
    "x/prompt.md",
    [
      "intro",
      "Run `./quality.sh` before pushing.",
      "more prose",
      "Then re-run ./quality.sh until it is green.",
    ].join("\n"),
  );
  assertEquals(found.map((v) => v.line), [2, 4]);
});

Deno.test("gate instruction check - the failure message names the single source of truth", () => {
  const message = formatGateInstructionFailure({
    violations: [{ file: "x/prompt.md", line: 2, text: "Run ./quality.sh" }],
    filesScanned: 1,
  });
  assertStringIncludes(message, "x/prompt.md:2");
  assertStringIncludes(message, "{{QUALITY_INSTRUCTIONS}}");
});

// The standing guard: this is the acceptance criterion of Issue #1138 —
// "no prompt instructs an unconditional ./quality.sh before pushing".
Deno.test("gate instruction check - no shipped prompt orders the gate unconditionally (Issue #1138)", async () => {
  const result = await scanPromptsForUnconditionalGate(PROMPTS_DIR);
  assert(
    result.filesScanned > 0,
    "the prompts directory must actually have been read",
  );
  assertEquals(
    result.violations,
    [],
    formatGateInstructionFailure(result),
  );
});

Deno.test("gate instruction check - every allowlisted template still exists", async () => {
  for (const relative of GATE_INSTRUCTION_ALLOWLIST) {
    const stat = await Deno.stat(`${PROMPTS_DIR}/${relative}`);
    assert(stat.isFile, `${relative} is allowlisted but is not a file`);
  }
});
