/**
 * Tests for the orphan_deps prompt v1 (Issue #2905, parent #2902).
 *
 * `prompts/orphan_deps/v1.md` is the detection brain of the `orphan-deps`
 * idle-task template. It mirrors the four-phase shape of
 * `prompts/supply_chain_detection/v2.md` but is the **one sanctioned
 * exception** to the static-evidence-only discipline: it may read
 * registry / source-repository metadata within a fixed allow-list to
 * decide what is orphaned. It still forbids package installs and
 * lifecycle scripts.
 *
 * These tests assert the load-bearing worker contracts (placeholders,
 * dedup lists, id recipe, labels, no-PR rule) and the issue's acceptance
 * criteria: the four phases, the replacement-suggestion requirement, the
 * no-PR rule, the network-sanction scoping, and the scope-boundary
 * wording are all present.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("orphan_deps prompt v1 - resolves via loadPrompt", async () => {
  const result = await loadPrompt("orphan_deps", "v1", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("orphan_deps prompt - loadPrompt resolves the latest (v1)", async () => {
  // Acceptance criterion: loadPrompt("orphan_deps") resolves v1.
  const result = await loadPrompt("orphan_deps", undefined, PROMPTS_DIR);
  assert(result.ok);
  const latest = await getLatestVersion("orphan_deps", PROMPTS_DIR);
  assert(latest.ok);
  if (latest.ok) {
    const num = parseInt(latest.value.replace("v", ""), 10);
    assertEquals(
      num >= 1,
      true,
      `Expected orphan_deps >= v1, got ${latest.value}`,
    );
  }
});

Deno.test(
  "orphan_deps prompt v1 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("orphan_deps", "v1", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate(
      "orphan_deps",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "orphan_deps prompt v1 - carries every placeholder the template substitutes",
  async () => {
    const result = await loadPrompt("orphan_deps", "v1", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const ph of [
        "{{SUPPRESSED_IDS}}",
        "{{KNOWN_OPEN_FINDING_IDS}}",
        "{{ATTRIBUTION_FOOTER}}",
      ]
    ) {
      assert(body.includes(ph), `v1 must carry the placeholder '${ph}'`);
    }
  },
);

Deno.test(
  "orphan_deps prompt v1 - keeps the H1 fingerprint",
  async () => {
    const result = await loadPrompt("orphan_deps", "v1", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      /^#+\s+Orphan(ed)?[ -/]/im.test(result.value),
      "v1 must keep an 'Orphan…' H1 fingerprint",
    );
  },
);

Deno.test(
  "orphan_deps prompt v1 - names all four phases",
  async () => {
    const result = await loadPrompt("orphan_deps", "v1", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const phase of [
        "Phase 1",
        "Phase 2",
        "Phase 3",
        "Phase 4",
        "Inventory",
        "Detect",
        "Triage",
      ]
    ) {
      assert(
        body.includes(phase),
        `v1 must name the phase marker '${phase}'`,
      );
    }
  },
);

Deno.test(
  "orphan_deps prompt v1 - states the orphan / unmaintained detection signals",
  async () => {
    const result = await loadPrompt("orphan_deps", "v1", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value.toLowerCase();
    for (
      const signal of [
        "deprecated", // npm deprecated flag / JSR yanked
        "archived", // GitHub archived: true
        "eol", // declared end-of-life / end-of-support
      ]
    ) {
      assert(
        body.includes(signal),
        `v1 must describe the '${signal}' orphan signal`,
      );
    }
    // Stale last-publish threshold must be stated as a default.
    assert(
      /stale|no release|last publish|months/.test(body),
      "v1 must describe the stale-last-publish signal with a default threshold",
    );
  },
);

Deno.test(
  "orphan_deps prompt v1 - requires a suggested maintained replacement",
  async () => {
    const result = await loadPrompt("orphan_deps", "v1", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value.toLowerCase();
    assert(
      body.includes("replacement"),
      "v1 must require a suggested maintained replacement",
    );
    assert(
      body.includes("migration"),
      "v1 must require a one-line migration note for the replacement",
    );
  },
);

Deno.test(
  "orphan_deps prompt v1 - scopes the network sanction to this scan and forbids installs",
  async () => {
    const result = await loadPrompt("orphan_deps", "v1", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    const lower = body.toLowerCase();
    // The static-evidence-only rule is lifted ONLY for this scan.
    assert(
      lower.includes("allow-list") || lower.includes("allowlist"),
      "v1 must reference the sanctioned metadata allow-list",
    );
    assert(
      /metadata/.test(lower),
      "v1 must scope the sanction to metadata reads",
    );
    // No install, ever; no lifecycle scripts.
    assert(
      /no (package )?install/.test(lower) || lower.includes("never install"),
      "v1 must forbid package installs",
    );
    assert(
      lower.includes("lifecycle script"),
      "v1 must forbid running lifecycle scripts",
    );
  },
);

Deno.test(
  "orphan_deps prompt v1 - states the no-PR rule (issue only)",
  async () => {
    const result = await loadPrompt("orphan_deps", "v1", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const lower = result.value.toLowerCase();
    assert(
      lower.includes("never") && lower.includes("pull request") ||
        lower.includes("issue only") || lower.includes("no pr"),
      "v1 must state the issue-only / no-PR rule",
    );
  },
);

Deno.test(
  "orphan_deps prompt v1 - states the scope boundary (not merely out-of-date)",
  async () => {
    const result = await loadPrompt("orphan_deps", "v1", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const lower = result.value.toLowerCase();
    assert(
      lower.includes("out-of-date") || lower.includes("out of date"),
      "v1 must distinguish orphaned from merely out-of-date deps",
    );
    assert(
      lower.includes("dependency-bump") || lower.includes("dependency bump") ||
        lower.includes("bump flow"),
      "v1 must defer out-of-date-but-maintained deps to the dependency-bump flow",
    );
  },
);

Deno.test(
  "orphan_deps prompt v1 - cross-links the sibling templates without duplicating",
  async () => {
    const result = await loadPrompt("orphan_deps", "v1", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const lower = result.value.toLowerCase();
    for (
      const sibling of [
        "security-scan",
        "supply-chain-readiness",
        "supply-chain-detection",
      ]
    ) {
      assert(
        lower.includes(sibling),
        `v1 must cross-link the sibling template '${sibling}'`,
      );
    }
    assert(
      lower.includes("cross-link") || lower.includes("complement"),
      "v1 must instruct to cross-link rather than duplicate",
    );
  },
);

Deno.test(
  "orphan_deps prompt v1 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt("orphan_deps", "v1", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "orphan-deps", // template label
        "severity:high|severity:medium|severity:low",
        "<!-- finding-id:", // hidden dedup marker
        "suppression_comments.ts", // suppression grammar source
        "6", // 6-finding cap
      ]
    ) {
      assert(
        body.includes(contract),
        `v1 must retain the contract string '${contract}'`,
      );
    }
  },
);
