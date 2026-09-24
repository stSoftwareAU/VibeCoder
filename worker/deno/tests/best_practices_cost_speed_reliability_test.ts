/**
 * The best-practices scan has a cost, speed and reliability lens (Issue #2579).
 *
 * Before this change the bucket guides reviewed almost entirely for
 * correctness, security and hygiene, and the 6-finding cap meant a cost or
 * reliability finding rarely survived even where a bucket noticed one. Three
 * things now carry the lens, and these cases pin each where a later reword
 * cannot quietly drop it:
 *
 *   - seven bucket guides carry a `## Cost, speed and reliability` section of
 *     numbered checks, each with a stable id recipe;
 *   - Phase 3 of the orchestrator reserves one of the six slots for such a
 *     finding, below `severity:high`;
 *   - the Phase 4 body template shows the estimated effect and the risk every
 *     such finding states.
 *
 * Each prose predicate is paired with its negative control: the same predicate
 * run against the surface with the new text cut out must come back false, so
 * a predicate satisfied by unrelated text elsewhere cannot pass for ever.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { checkNumbersIn } from "../lib/bucket_check_numbering.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const PROMPTS_DIR = `${REPO_ROOT}prompts`;
const HEADING = "## Cost, speed and reliability";

/** The buckets the issue names; `html` and `design` are deliberately out. */
const BUCKETS = [
  "aws-cloudformation",
  "terraform",
  "rust",
  "typescript",
  "react",
  "java",
  "general",
] as const;

async function orchestratorPrompt(): Promise<string> {
  const loaded = await loadPrompt("best_practices", PROMPTS_DIR);
  assertEquals(loaded.ok, true, "best_practices failed to load");
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

function bucketGuide(bucket: string): Promise<string> {
  return Deno.readTextFile(
    `${PROMPTS_DIR}/best_practices/buckets/${bucket}.md`,
  );
}

/**
 * Bounds of the section `heading` opens: up to the next heading of its level
 * or above, outside fenced code.
 */
function sectionBounds(text: string, heading: string): [number, number] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  assert(start >= 0, `heading not found: ${heading}`);
  const level = heading.match(/^#+/)![0].length;
  let end = lines.length;
  let inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    // A heading inside a fenced sample (the Phase 4 body template) is
    // sample text, not a section boundary.
    if (/^\s*(```|~~~)/.test(lines[i]!)) inFence = !inFence;
    if (inFence) continue;
    const opened = /^(#{1,6}) /.exec(lines[i]!);
    if (opened && opened[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return [start, end];
}

function section(text: string, heading: string): string {
  const [start, end] = sectionBounds(text, heading);
  return text.split("\n").slice(start, end).join("\n");
}

function withoutSection(text: string, heading: string): string {
  const [start, end] = sectionBounds(text, heading);
  const lines = text.split("\n");
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/** A section that numbers checks and gives each a stable id recipe. */
function carriesIdRecipedChecks(text: string): boolean {
  const checks = checkNumbersIn(text).length;
  const recipes = (text.match(/Stable id:/g) ?? []).length;
  return checks > 0 && recipes >= checks;
}

for (const bucket of BUCKETS) {
  Deno.test(`${bucket} guide carries a cost, speed and reliability section with id-reciped checks (Issue #2579)`, async () => {
    const guide = await bucketGuide(bucket);
    assert(
      carriesIdRecipedChecks(section(guide, HEADING)),
      `${bucket}.md: the section must number its checks and give each a ` +
        "`Stable id:` recipe",
    );
  });

  Deno.test(`${bucket} guide states no stable id recipe outside the new section (negative control, Issue #2579)`, async () => {
    const rest = withoutSection(await bucketGuide(bucket), HEADING);
    assert(
      !/Stable id:/.test(rest),
      `${bucket}.md: the \`Stable id:\` predicate fires without the new ` +
        "section, so it pins nothing",
    );
  });
}

/** The reserved-slot rule: one of six, for this lens, below severity:high. */
function statesReservedSlot(text: string): boolean {
  return /reserve[sd]?\s+(one|1)\s+of\s+the\s+(6|six)/i.test(text) &&
    /cost,\s+speed\s+(and|or)\s+reliability/i.test(text) &&
    /severity:high/.test(text);
}

Deno.test("Phase 3 reserves one of the six slots for a cost, speed or reliability finding below severity:high (Issue #2579)", async () => {
  const phase3 = section(await orchestratorPrompt(), "## Phase 3 — Triage");
  assert(statesReservedSlot(phase3), "Phase 3 must state the reserved slot");
});

Deno.test("the reserved-slot rule lives only in Phase 3 (negative control, Issue #2579)", async () => {
  const rest = withoutSection(
    await orchestratorPrompt(),
    "## Phase 3 — Triage",
  );
  assert(!statesReservedSlot(rest), "reserved-slot predicate pins nothing");
});

/** The body template shows both the estimated effect and the risk. */
function showsEffectAndRisk(text: string): boolean {
  return /\*\*Estimated effect:\*\*[^\n]*\(estimated\)/.test(text) &&
    /\*\*Risk:\*\*/.test(text);
}

Deno.test("the Phase 4 body template shows an estimated effect and a risk line (Issue #2579)", async () => {
  const phase4 = section(
    await orchestratorPrompt(),
    "## Phase 4 — File one issue per finding (outcome-only)",
  );
  assert(showsEffectAndRisk(phase4), "template must show effect and risk");
});

Deno.test("effect and risk are shown only in the Phase 4 template (negative control, Issue #2579)", async () => {
  const rest = withoutSection(
    await orchestratorPrompt(),
    "## Phase 4 — File one issue per finding (outcome-only)",
  );
  assert(!showsEffectAndRisk(rest), "effect/risk predicate pins nothing");
});

Deno.test("the operator manual documents the check family and the reserved slot (Issue #2579)", async () => {
  const manual = await Deno.readTextFile(
    `${REPO_ROOT}docs/BEST-PRACTICES-SCAN.md`,
  );
  assert(
    /### Cost, speed and reliability/.test(manual),
    "docs/BEST-PRACTICES-SCAN.md must document the check family",
  );
  assert(
    statesReservedSlot(section(manual, "## 6-issue cap and priority order")),
    "the cap section must document the reserved slot",
  );
});
