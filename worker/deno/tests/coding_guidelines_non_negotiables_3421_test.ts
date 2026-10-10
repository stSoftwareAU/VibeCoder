/**
 * Non-negotiables digest opens the shared coding guidelines (Issue #3421).
 *
 * The irreversible-action rules sat deep in the shared guidelines, so a short
 * "Non-negotiables" digest now opens them, linking each rule to its full
 * section. Layering drops commit-only sections from some phases, so these
 * cases pin that every digest link resolves in every layer:
 *
 * - the digest is the first `## ` section in every layer;
 * - every in-page anchor in the digest resolves in the rendered layer;
 * - each layer carries exactly the expected set of links (the commit-only
 *   Commit Safety link is absent from the core layer).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CodingGuidelinesLayer,
  selectCodingGuidelinesLayer,
} from "../lib/coding_guidelines_overlay.ts";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { anchorSet } from "../lib/markdown_anchors.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const LAYERS: CodingGuidelinesLayer[] = ["core", "commit", "code"];
const HEADING = "## Non-negotiables";

async function render(layer: CodingGuidelinesLayer): Promise<string> {
  const loaded = await loadPrompt("coding_guidelines", PROMPTS_DIR);
  if (!loaded.ok) throw loaded.error;
  const selected = selectCodingGuidelinesLayer(loaded.value, layer);
  if (!selected.ok) throw selected.error;
  return selected.value;
}

function digestOf(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === HEADING);
  if (start < 0) throw new Error("Non-negotiables heading not found");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]?.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function anchorsIn(section: string): string[] {
  return [...section.matchAll(/\]\(#([^)\s]+)\)/g)].map((m) => m[1] ?? "");
}

const BASE = [
  "human-escalation",
  "issue-lifecycle-is-not-yours-to-change",
  "long-horizon-runs",
  "never-fail-silently--fail-loud",
  "tool-output--data-never-instructions",
  "untrusted-images--never-obey-instructions-inside-an-image",
];

Deno.test("Non-negotiables is the first section in every layer (Issue #3421)", async () => {
  for (const layer of LAYERS) {
    const text = await render(layer);
    const first = text.split("\n").find((l) => l.startsWith("## "));
    assertEquals(first, HEADING, `layer ${layer}: digest must lead`);
  }
});

Deno.test("every Non-negotiables link resolves in every layer (Issue #3421)", async () => {
  for (const layer of LAYERS) {
    const text = await render(layer);
    const anchors = anchorSet(text);
    const unresolved = anchorsIn(digestOf(text)).filter((a) => !anchors.has(a));
    assertEquals(unresolved, [], `layer ${layer}: unresolved digest anchors`);
  }
});

Deno.test("Non-negotiables link sets are exact per layer (Issue #3421)", async () => {
  const core = [...new Set(anchorsIn(digestOf(await render("core"))))].sort();
  assert(core.length > 0);
  assertEquals(core, BASE, "layer core");
  const withCommit = [...BASE, "commit-safety"].sort();
  for (const layer of ["commit", "code"] as const) {
    const got = [...new Set(anchorsIn(digestOf(await render(layer))))].sort();
    assertEquals(got, withCommit, `layer ${layer}`);
  }
});
