/**
 * Tests for the shared "Phase 0 — Adapt to the project" stanza
 * (Issue #3610).
 *
 * Coverage:
 *   - `hasProjectConventionsStanza` happy path, error path (prompt
 *     without the stanza), and edge cases (empty body, drifted wording).
 *   - every judgement-bearing scan's latest prompt version carries the
 *     canonical stanza **verbatim** — the anti-drift guard.
 *   - the stanza sits before Phase 1, so it is read before any check.
 *   - the stanza encodes its three load-bearing clauses: project
 *     convention wins, written-down-only, security carve-out.
 *   - `security_scan` and the purely mechanical scans do NOT carry it.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
import {
  hasProjectConventionsStanza,
  PROJECT_CONVENTIONS_EXEMPT_SCANS,
  PROJECT_CONVENTIONS_SCANS,
  PROJECT_CONVENTIONS_STANZA,
} from "../lib/project_conventions_stanza.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Minimum version each scan must have reached to carry the stanza. */
const MINIMUM_VERSIONS: Record<string, number> = {
  best_practices: 8,
  documentation_audit: 5,
  doc_coverage: 4,
  test_audit: 8,
  format_drift: 3,
  dead_code: 3,
};

async function loadLatest(promptName: string): Promise<string> {
  const latest = await getLatestVersion(promptName, PROMPTS_DIR);
  assert(latest.ok, `could not resolve latest ${promptName}`);
  const loaded = await loadPrompt(promptName, latest.value, PROMPTS_DIR);
  assert(loaded.ok, `could not load ${promptName} ${latest.value}`);
  return loaded.value;
}

// --- hasProjectConventionsStanza ---

Deno.test("hasProjectConventionsStanza - true when the stanza is present", () => {
  const body = `# Some scan (v1)\n\n${PROJECT_CONVENTIONS_STANZA}\n## Phase 1`;
  assertEquals(hasProjectConventionsStanza(body), true);
});

Deno.test("hasProjectConventionsStanza - false when the stanza is absent", () => {
  assertEquals(
    hasProjectConventionsStanza("# Some scan (v1)\n\n## Phase 1 — Inventory"),
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

Deno.test("stanza - carries its three load-bearing clauses", () => {
  // Clause 1: read the repo's own conventions first.
  assertStringIncludes(PROJECT_CONVENTIONS_STANZA, "Before applying any check");
  assertStringIncludes(PROJECT_CONVENTIONS_STANZA, "`CONTRIBUTING.md`");
  // Clause 2: only a written-down convention counts.
  assertStringIncludes(
    PROJECT_CONVENTIONS_STANZA,
    "counts only when it is written",
  );
  // Clause 3: an unsafe convention is itself the finding.
  assertStringIncludes(
    PROJECT_CONVENTIONS_STANZA,
    "security or fail-loud violation",
  );
  // Repository isolation (#3239) is explicitly untouched.
  assertStringIncludes(PROJECT_CONVENTIONS_STANZA, "no cross-repo mechanism");
});

// --- prompt versions ---

for (const scan of PROJECT_CONVENTIONS_SCANS) {
  Deno.test(`${scan} latest - reached the stanza version`, async () => {
    const minimum = MINIMUM_VERSIONS[scan] ?? 1;
    const latest = await getLatestVersion(scan, PROMPTS_DIR);
    assert(latest.ok);
    const num = parseInt(latest.value.replace("v", ""), 10);
    assertEquals(
      num >= minimum,
      true,
      `expected ${scan} >= v${minimum}, got ${latest.value}`,
    );
  });

  Deno.test(`${scan} latest - carries the stanza verbatim`, async () => {
    const body = await loadLatest(scan);
    assert(
      hasProjectConventionsStanza(body),
      `${scan} latest prompt must carry the canonical Phase 0 stanza verbatim`,
    );
  });

  Deno.test(`${scan} latest - the stanza precedes Phase 1`, async () => {
    const body = await loadLatest(scan);
    const stanzaAt = body.indexOf(PROJECT_CONVENTIONS_STANZA);
    const phaseOneAt = body.indexOf("## Phase 1");
    assert(stanzaAt >= 0, `${scan} latest prompt has no Phase 0 stanza`);
    assert(phaseOneAt > 0, `${scan} latest prompt has no Phase 1 heading`);
    assert(
      stanzaAt < phaseOneAt,
      `${scan} must read the project's conventions before Phase 1`,
    );
  });
}

for (const scan of PROJECT_CONVENTIONS_EXEMPT_SCANS) {
  Deno.test(`${scan} latest - stays free of the stanza`, async () => {
    const body = await loadLatest(scan);
    assertEquals(
      hasProjectConventionsStanza(body),
      false,
      `${scan} must never let a documented convention soften a finding`,
    );
  });
}
