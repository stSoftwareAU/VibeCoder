/**
 * Section-scoped wording pins for retro's three-field suppression governance
 * (Issue #789), split out of `suppression_governance_drift_test.ts` and
 * scoped to their section per Issue #3309.
 *
 * These pin exact phrases within the `## Phase 4 — Triage` section of
 * `prompts/retro/prompt.md`, where rule 6 states the governance check. This
 * file imports `markdown_docs.ts`, which spawns git — which is why these
 * pins live here rather than in `suppression_governance_drift_test.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("suppression governance - retro's Phase 4 triage checks all three governance fields (Issue #789)", async () => {
  const collapsed = flat(
    section(
      await readRepoDoc("prompts/retro/prompt.md"),
      "Phase 4 — Triage",
    ),
  );
  assertStringIncludes(
    collapsed,
    "check all three governance fields",
    "missing from retro's Phase 4 — Triage section",
  );
  assertStringIncludes(
    collapsed,
    "Never silently honour an ungoverned marker",
    "missing from retro's Phase 4 — Triage section",
  );
});
