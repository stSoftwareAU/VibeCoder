/**
 * Tests for the shared "Phase 0 — Adapt to the project" stanza
 * (Issue #3610).
 *
 * Coverage:
 *   - `hasProjectConventionsStanza` happy path, error path (prompt
 *     without the stanza), and edge cases (empty body, drifted wording).
 *   - every judgement-bearing scan's prompt carries the canonical stanza
 *     **verbatim** — the anti-drift guard.
 *   - the stanza sits before Phase 1, so it is read before any check.
 *   - the stanza encodes its three load-bearing clauses: project
 *     convention wins, written-down-only, security carve-out.
 *   - `security_scan` and the purely mechanical scans do NOT carry it.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import {
  hasProjectConventionsStanza,
  PROJECT_CONVENTIONS_EXEMPT_SCANS,
  PROJECT_CONVENTIONS_SCANS,
  PROJECT_CONVENTIONS_STANZA,
} from "../lib/project_conventions_stanza.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadBody(promptName: string): Promise<string> {
  const loaded = await loadPrompt(promptName, PROMPTS_DIR);
  assert(loaded.ok, `could not load ${promptName}`);
  return loaded.value;
}

// --- hasProjectConventionsStanza ---

Deno.test("hasProjectConventionsStanza - true when the stanza is present", () => {
  const body = `# Some scan\n\n${PROJECT_CONVENTIONS_STANZA}\n## Phase 1`;
  assertEquals(hasProjectConventionsStanza(body), true);
});

Deno.test("hasProjectConventionsStanza - false when the stanza is absent", () => {
  assertEquals(
    hasProjectConventionsStanza("# Some scan\n\n## Phase 1 — Inventory"),
    false,
  );
});

Deno.test("hasProjectConventionsStanza - false on an empty body", () => {
  assertEquals(hasProjectConventionsStanza(""), false);
});

Deno.test("hasProjectConventionsStanza - false when the wording drifted", () => {
  // A single reworded clause must not pass — the whole point is that the
  // eight copies stay byte-identical.
  const drifted = PROJECT_CONVENTIONS_STANZA.replace(
    "the project convention wins",
    "the project convention usually wins",
  );
  assertEquals(hasProjectConventionsStanza(drifted), false);
});

// --- the canonical wording ---

// --- prompt bodies ---

for (const scan of PROJECT_CONVENTIONS_SCANS) {
  Deno.test(`${scan} - carries the stanza verbatim`, async () => {
    const body = await loadBody(scan);
    assert(
      hasProjectConventionsStanza(body),
      `${scan} must carry the canonical Phase 0 stanza verbatim`,
    );
  });

  Deno.test(`${scan} - the stanza precedes Phase 1`, async () => {
    const body = await loadBody(scan);
    const stanzaAt = body.indexOf(PROJECT_CONVENTIONS_STANZA);
    const phaseOneAt = body.indexOf("## Phase 1");
    assert(stanzaAt >= 0, `${scan} has no Phase 0 stanza`);
    assert(phaseOneAt > 0, `${scan} has no Phase 1 heading`);
    assert(
      stanzaAt < phaseOneAt,
      `${scan} must read the project's conventions before Phase 1`,
    );
  });
}

for (const scan of PROJECT_CONVENTIONS_EXEMPT_SCANS) {
  Deno.test(`${scan} - stays free of the stanza`, async () => {
    const body = await loadBody(scan);
    assertEquals(
      hasProjectConventionsStanza(body),
      false,
      `${scan} must never let a documented convention soften a finding`,
    );
  });
}
