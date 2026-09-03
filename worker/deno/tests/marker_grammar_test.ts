/**
 * Issue #842: the worker's `vibe-*` marker grammar is a closed set.
 *
 * Markers are the worker's machine-readable channel into issue and PR bodies.
 * The templates under `prompts/` are internally consistent — a bare `vibe-`
 * prefix and `key="value"` attributes. The worker does not match that.
 *
 * The issue named three deviating call sites. Scanning every marker literal
 * in `lib/` found **sixteen**, in three families — only six markers are
 * canonical:
 *
 * - `vibe-coder-` prefix (2): the stale-workflow pair.
 * - `vibe-coder:` prefix with a colon payload (9): ci-nudge, the three
 *   merge-conflict states, milestone-retarget, orphaned-rollup,
 *   purge-not-applicable, and the two workflow-sync shapes.
 * - bare `vibe-` with a colon payload (5): blocked-deferral,
 *   analysis-only-handoff, references-refresh-id, work-escalation,
 *   worker-issue.
 *
 * All sixteen are **frozen rather than fixed**, and that is the point of this
 * test. Every one is a guard read back out of comments already posted — a
 * first deferral told from a repeat, a stale diagnostic not posted twice.
 * Renaming any makes every marker already in the wild invisible to its guard,
 * so the action it prevents starts repeating on live issues. The
 * compatibility cost falls on real data; the consistency gain is cosmetic.
 *
 * So the deviations stay and this test makes them a **declared, closed set**.
 * A seventeenth marker cannot quietly add a fourth convention, which is the
 * drift the issue is actually about.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";

const LIB_DIR = new URL("../lib", import.meta.url).pathname;

/**
 * The accepted deviations, with the reason each is frozen.
 *
 * Adding to this set is a deliberate act that needs the same justification:
 * a marker already in live bodies that something reads back.
 */
const ACCEPTED_DEVIATIONS: ReadonlyMap<string, string> = new Map([
  // Family 1 — `vibe-coder-` prefix. Matched by `hasExistingStaleComment`;
  // renaming re-posts a stale diagnostic on every issue already carrying one.
  ["vibe-coder-stale-workflow", "stale-comment dedup"],
  ["vibe-coder-stale-diagnostic", "stale-comment dedup"],

  // Family 2 — `vibe-coder:` prefix with a colon-delimited payload. Each is a
  // repeat guard read back from comments already posted, so a rename makes
  // every marker in the wild invisible and the action repeats.
  ["vibe-coder:ci-nudge", "repeat-nudge guard"],
  ["vibe-coder:merge-conflict-attempt", "repeat-attempt guard"],
  ["vibe-coder:merge-conflict-failed", "repeat-attempt guard"],
  ["vibe-coder:merge-conflict-resolved", "repeat-attempt guard"],
  ["vibe-coder:milestone-retarget", "repeat-retarget guard"],
  ["vibe-coder:orphaned-rollup", "rollup dedup"],
  ["vibe-coder:purge-not-applicable:", "per-target purge dedup"],
  ["vibe-coder:workflow-sync:", "per-repo sync dedup"],
  ["vibe-coder:workflow-sync:partial:", "per-repo sync dedup"],

  // Family 3 — bare `vibe-` prefix, colon-delimited payload rather than
  // `key="value"`. Same reason: read back to tell a first action from a
  // repeat one.
  ["vibe-blocked-deferral:", "repeat-deferral guard"],
  ["vibe-analysis-only-handoff:", "repeat-handoff guard"],
  ["vibe-references-refresh-id:", "per-refresh dedup"],
  ["vibe-work-escalation:", "repeat-escalation guard"],
  ["vibe-worker-issue-", "per-issue marker prefix"],
]);

/** Every `<!-- vibe-… -->` literal the worker's lib emits. */
async function markerLiterals(): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for await (const entry of Deno.readDir(LIB_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const text = await Deno.readTextFile(`${LIB_DIR}/${entry.name}`);
    for (const match of text.matchAll(/<!--\s*(vibe-[A-Za-z0-9:_-]+)/g)) {
      const marker = match[1];
      if (marker === undefined) continue;
      const files = found.get(marker) ?? [];
      if (!files.includes(entry.name)) files.push(entry.name);
      found.set(marker, files);
    }
  }
  return found;
}

/** A marker is canonical when it uses the bare `vibe-` prefix and no payload. */
function isCanonical(marker: string): boolean {
  if (marker.startsWith("vibe-coder-")) return false;
  if (marker.endsWith(":")) return false;
  return /^vibe-[a-z0-9-]+$/.test(marker);
}

Deno.test("marker grammar - no marker deviates outside the declared set (Issue #842)", async () => {
  const offenders: string[] = [];
  for (const [marker, files] of await markerLiterals()) {
    if (isCanonical(marker)) continue;
    if (ACCEPTED_DEVIATIONS.has(marker)) continue;
    offenders.push(`${marker} (${files.join(", ")})`);
  }
  offenders.sort();
  assertEquals(
    offenders,
    [],
    "a new marker deviates from the documented `vibe-*` grammar. Use the " +
      'bare `vibe-` prefix and `key="value"` attributes, or add it to ' +
      "ACCEPTED_DEVIATIONS with the reason it cannot change:\n" +
      offenders.join("\n"),
  );
});

Deno.test("marker grammar - every declared deviation is still emitted (Issue #842)", async () => {
  // A stale entry means the deviation was fixed and the exemption outlived
  // it — the same trap `HOME_WORKDIR_ALLOWLIST` guards against, which broke
  // #805 when `fleet_health.ts` was deleted under it.
  const emitted = await markerLiterals();
  const stale = [...ACCEPTED_DEVIATIONS.keys()].filter((m) => !emitted.has(m));
  assertEquals(
    stale,
    [],
    "these deviations are no longer emitted — drop them from " +
      "ACCEPTED_DEVIATIONS so the set stays an exact record: " +
      stale.join(", "),
  );
});

Deno.test("marker grammar - the canonical shape is recognised (Issue #842)", () => {
  for (const marker of ["vibe-spec-review", "vibe-standards-review"]) {
    assertEquals(isCanonical(marker), true, `${marker} should be canonical`);
  }
  for (
    const marker of [
      "vibe-coder-stale-workflow",
      "vibe-blocked-deferral:",
    ]
  ) {
    assertEquals(isCanonical(marker), false, `${marker} should not be`);
  }
});
