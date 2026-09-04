/**
 * Drift guards for `docs/CUSTOM-PROMPTS.md` (Issue #851, part of #843).
 *
 * The page tells an operator to copy a JSON block, write a template carrying
 * named placeholders, and expect a read-only mount at a named path. Each of
 * those is a claim about code in this repository, so each is checked against
 * the code rather than re-typed: the documented mapping goes through the real
 * `parseCustomLabelPrompts`, the documented placeholder table is compared with
 * `REQUIRED_PLACEHOLDERS`, and the documented mount target and environment
 * variable are the exported constants.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { parseCustomLabelPrompts } from "../lib/custom_label_prompts_config.ts";
import { getRequiredPlaceholders } from "../lib/prompt_manager.ts";
import {
  CUSTOM_PROMPT_PATH_MAP_ENV,
  CUSTOM_PROMPTS_TARGET_SUBDIR,
} from "../lib/custom_prompt_mounts.ts";

const PAGE = "docs/CUSTOM-PROMPTS.md";

/** tests/ → worker/deno/ → worker/ → repo root */
function read(relative: string): string {
  return Deno.readTextFileSync(
    new URL(`../../../${relative}`, import.meta.url),
  );
}

/** Extract every fenced ```json block body. */
function jsonBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) =>
    m[1] ?? ""
  );
}

/** Split a Markdown table into rows of trimmed cells. */
function tableRows(markdown: string): string[][] {
  return markdown.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
}

/** Backticked `SHOUTING_SNAKE` tokens in a cell — the placeholder names. */
function placeholderNames(cell: string): string[] {
  return [...cell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]!);
}

/** The override table's row for a phase, keyed on its first cell. */
function phaseRow(markdown: string, phase: string): string[] {
  const row = tableRows(markdown).find((cells) =>
    cells[0]?.includes(`\`${phase}\``) && (cells[1] ?? "").includes("`")
  );
  assert(row, `${PAGE} documents no required-placeholder row for '${phase}'`);
  return row;
}

Deno.test("custom prompts docs - the documented mapping block is accepted by the real parser", async () => {
  const block = jsonBlocks(read(PAGE))[0];
  assert(block, `${PAGE} carries no copyable custom_label_prompts JSON block`);
  const parsed = JSON.parse(block) as Record<string, unknown>;
  const raw = parsed.custom_label_prompts;
  assert(Array.isArray(raw), "the first JSON block must be the mapping array");

  // The documented host paths do not exist on a test machine, so resolve each
  // to one temporary template carrying every placeholder the documented
  // entries' phases require. The parser then judges the documented *shape*.
  const dir = await Deno.makeTempDir();
  try {
    const template = `{{REPO}} #{{ISSUE_NUMBER}} {{PLANNING_LABEL}} ` +
      `{{QUALITY_INSTRUCTIONS}}`;
    const path = `${dir}/template.md`;
    await Deno.writeTextFile(path, template);

    const result = parseCustomLabelPrompts(raw, { resolvePath: () => path });
    assert(
      result.ok,
      `${PAGE}'s documented mapping is rejected by the real parser: ${
        result.ok ? "" : result.error
      }`,
    );
    assertEquals(
      result.value.length,
      raw.length,
      "every documented entry must survive validation",
    );
    // The documented block must exercise both shapes the page describes: a
    // new dispatch label, and an override naming an explicit phase.
    assert(
      result.value.some((m) => m.overridesPhase === undefined),
      `${PAGE} must document a new-label mapping`,
    );
    assertEquals(
      result.value.some((m) => m.overridesPhase === "planning_critique"),
      true,
      `${PAGE} must document the second-turn override entry`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("custom prompts docs - the documented placeholder contract matches the code", () => {
  const page = read(PAGE);

  for (const phase of ["issue", "planning", "planning_critique", "question"]) {
    const required = getRequiredPlaceholders(phase);
    assert(required.ok, `${phase} must be a registered template type`);
    const documented = placeholderNames(phaseRow(page, phase)[1] ?? "");
    assertEquals(
      [...documented].sort(),
      [...required.value].sort(),
      `${PAGE} documents the wrong required placeholders for '${phase}'`,
    );
  }

  // `grill-me` and `quorum` share a row shape but are long; check membership
  // both ways so neither a missing nor an invented placeholder survives.
  for (const phase of ["grill-me", "quorum"]) {
    const required = getRequiredPlaceholders(phase);
    assert(required.ok, `${phase} must be a registered template type`);
    assertEquals(
      placeholderNames(phaseRow(page, phase)[1] ?? "").sort(),
      [...required.value].sort(),
      `${PAGE} documents the wrong required placeholders for '${phase}'`,
    );
  }

  // The judge row is documented as "the quorum set, plus PLAN_A and PLAN_B",
  // so check that difference is still the truth.
  const judge = getRequiredPlaceholders("quorum_judge");
  const quorum = getRequiredPlaceholders("quorum");
  assert(
    judge.ok && quorum.ok,
    "both Quorum template types must be registered",
  );
  assertEquals(
    judge.value.filter((name) => !quorum.value.includes(name)).sort(),
    ["PLAN_A", "PLAN_B"],
    `${PAGE} documents quorum_judge as the quorum set plus PLAN_A/PLAN_B`,
  );
  const judgeRow = phaseRow(page, "quorum_judge")[1] ?? "";
  assert(
    judgeRow.includes("`PLAN_A`") && judgeRow.includes("`PLAN_B`"),
    `${PAGE} must name PLAN_A and PLAN_B in the quorum_judge row`,
  );
});

Deno.test("custom prompts docs - the documented container mount is the real one", () => {
  const page = read(PAGE);
  assert(
    page.includes(`/home/vibe/${CUSTOM_PROMPTS_TARGET_SUBDIR}/`),
    `${PAGE} must document the real in-container mount target`,
  );
  assert(
    page.includes(CUSTOM_PROMPT_PATH_MAP_ENV),
    `${PAGE} must name ${CUSTOM_PROMPT_PATH_MAP_ENV}, the translation map`,
  );
});

Deno.test("custom prompts docs - the page is reachable from the docs that lead to it", () => {
  for (
    const source of [
      "docs/EXTENDING.md",
      "docs/PROMPTS.md",
      "docs/CONFIGURATION.md",
      "README.md",
    ]
  ) {
    assert(
      read(source).includes("CUSTOM-PROMPTS.md"),
      `${source} must link to ${PAGE}`,
    );
  }
});
