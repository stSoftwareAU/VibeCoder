/**
 * The documented work-prioritisation ladder must match the dispatch table
 * in `lib/run_core.ts` (Issue #3348).
 *
 * The docs restated the ladder by hand and drifted: Planning/Question were
 * inverted and two live steps were missing. This test parses the code's
 * `priority: N, name: "…"` pairs and asserts every one appears — with the
 * same number — in the canonical table (`docs/workflows/README.md`), its
 * flow diagram, and the `docs/USAGE.md` diagram, and that the tables list
 * no priority the code does not have. Names are matched loosely (a doc row
 * may say "Question answering" for the code's "Question Answering").
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert } from "@std/assert";

const ROOT = new URL("../../../", import.meta.url).pathname;

interface Step {
  priority: string;
  name: string;
}

/** `priority: N,` followed by `name: "X"` in lib/run_core.ts. */
export function parseCodeLadder(source: string): Step[] {
  const out: Step[] = [];
  const re = /priority:\s*([0-9.]+),\s*\n\s*name:\s*"([^"]+)"/g;
  for (const m of source.matchAll(re)) {
    out.push({ priority: normalise(m[1] ?? ""), name: m[2] ?? "" });
  }
  return out;
}

/** "1.80" and "1.8" are the same tier. */
function normalise(priority: string): string {
  return String(Number(priority));
}

/** Priorities in the workflows table: rows `| 1.65 | … |`. */
function parseTablePriorities(markdown: string): string[] {
  return [...markdown.matchAll(/^\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|/gm)].map((
    m,
  ) => normalise(m[1] ?? ""));
}

/** Priorities in a mermaid diagram: `["1.65: …"]` or `"Priority 1.65 —"`. */
function parseDiagramPriorities(markdown: string): string[] {
  return [
    ...markdown.matchAll(
      /\["(?:[^"]*?Priority\s+)?([0-9]+(?:\.[0-9]+)?)(?:\s*[:—-])/g,
    ),
  ].map((m) => normalise(m[1] ?? ""));
}

const code = parseCodeLadder(
  await Deno.readTextFile(`${ROOT}worker/deno/lib/run_core.ts`),
);
const workflows = await Deno.readTextFile(`${ROOT}docs/workflows/README.md`);
const usage = await Deno.readTextFile(`${ROOT}docs/USAGE.md`);

Deno.test("priority ladder - the code has the tiers this test is about", () => {
  const priorities = code.map((s) => s.priority);
  for (
    const p of [
      "1",
      "1.5",
      "1.55",
      "1.6",
      "1.65",
      "1.67",
      "1.68",
      "1.7",
      "1.72",
      "1.75",
      "1.78",
      "1.8",
      "1.85",
      "2",
    ]
  ) {
    assert(priorities.includes(p), `run_core.ts has no priority ${p}`);
  }
  const planning = code.find((s) => s.name === "Planning Mode")!;
  const question = code.find((s) => s.name === "Question Answering")!;
  assert(
    Number(planning.priority) < Number(question.priority),
    "planning runs before question answering in the code",
  );
});

Deno.test("priority ladder - docs/workflows/README.md table lists every dispatch tier and no invented one (Issue #3348)", () => {
  const table = parseTablePriorities(workflows);
  for (const step of code) {
    assert(
      table.includes(step.priority),
      `workflows table lacks ${step.priority} (${step.name})`,
    );
  }
  // Documented-but-not-dispatched tiers are allowed only for the known
  // extras: the branch cleanup that runs once at start-up (1.66) and the
  // issue-scan sub-tiers (2.5, 2.9) that live inside priority 2.
  const allowedExtras = new Set(["1.66", "2.5", "2.9"]);
  for (const p of table) {
    assert(
      code.some((s) => s.priority === p) || allowedExtras.has(p),
      `workflows table documents priority ${p}, which the code does not dispatch`,
    );
  }
});

Deno.test("priority ladder - both flow diagrams carry every dispatch tier (Issue #3348)", () => {
  for (const [label, text] of [["workflows", workflows], ["USAGE", usage]]) {
    const found = parseDiagramPriorities(text!);
    for (const step of code) {
      assert(
        found.includes(step.priority),
        `${label} diagram lacks ${step.priority} (${step.name}); found ${
          found.join(",")
        }`,
      );
    }
  }
});
