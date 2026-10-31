/**
 * Tests for decision_warn_dedup.ts — once-per-decision warning suppression
 * (Issue #4495).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  configureDecisionWarnStore,
  DECISION_MAX_AGE_MS,
  DECISION_REFRESH_MS,
  decisionWarnStorePath,
  resetDecisionWarnings,
  shouldWarnDecision,
} from "../lib/decision_warn_dedup.ts";

Deno.test("shouldWarnDecision - a first sighting warns and an identical repeat does not (Issue #4495)", () => {
  resetDecisionWarnings();
  assertEquals(shouldWarnDecision("k", "sig"), true);
  assertEquals(shouldWarnDecision("k", "sig"), false);
  assertEquals(shouldWarnDecision("k", "sig"), false);
});

Deno.test("shouldWarnDecision - a changed signature warns again and is then remembered (Issue #4495)", () => {
  resetDecisionWarnings();
  assertEquals(shouldWarnDecision("k", "orphaned"), true);
  assertEquals(shouldWarnDecision("k", "not-merged"), true);
  assertEquals(shouldWarnDecision("k", "not-merged"), false);
  // Reverting to an earlier signature is a change from the last one recorded.
  assertEquals(shouldWarnDecision("k", "orphaned"), true);
});

Deno.test("shouldWarnDecision - keys are tracked independently (Issue #4495)", () => {
  resetDecisionWarnings();
  assertEquals(shouldWarnDecision("pr-1", "sig"), true);
  assertEquals(shouldWarnDecision("pr-2", "sig"), true);
  assertEquals(shouldWarnDecision("pr-1", "sig"), false);
  assertEquals(shouldWarnDecision("pr-2", "sig"), false);
});

Deno.test("resetDecisionWarnings - clears every recorded signature (Issue #4495)", () => {
  resetDecisionWarnings();
  assertEquals(shouldWarnDecision("k", "sig"), true);
  assertEquals(shouldWarnDecision("k", "sig"), false);
  resetDecisionWarnings();
  assertEquals(shouldWarnDecision("k", "sig"), true);
});

/** Run `body` with a fresh work directory; always detach the store after. */
async function withWorkDir(body: (workDir: string) => void | Promise<void>) {
  const workDir = await Deno.makeTempDir({ prefix: "vibe-decision-warn-" });
  try {
    await body(workDir);
  } finally {
    resetDecisionWarnings();
    await Deno.remove(workDir, { recursive: true });
  }
}

/** Simulate a process restart: drop memory, then reload from the store. */
function restart(workDir: string, now?: () => number) {
  resetDecisionWarnings();
  configureDecisionWarnStore(workDir, now);
}

Deno.test("shouldWarnDecision - an unchanged signature stays quiet after a restart and a changed one warns (PR #4535 review)", async () => {
  await withWorkDir((workDir) => {
    resetDecisionWarnings();
    configureDecisionWarnStore(workDir);
    assertEquals(shouldWarnDecision("k", "sig"), true);

    restart(workDir);
    assertEquals(shouldWarnDecision("k", "sig"), false);
    assertEquals(shouldWarnDecision("other", "sig"), true);

    restart(workDir);
    assertEquals(shouldWarnDecision("k", "changed"), true);
    assertEquals(shouldWarnDecision("other", "sig"), false);

    // The changed signature is itself persisted.
    restart(workDir);
    assertEquals(shouldWarnDecision("k", "changed"), false);
  });
});

Deno.test("shouldWarnDecision - without a configured store a restart warns again", () => {
  resetDecisionWarnings();
  assertEquals(shouldWarnDecision("k", "sig"), true);
  resetDecisionWarnings();
  assertEquals(shouldWarnDecision("k", "sig"), true);
});

Deno.test("configureDecisionWarnStore - an entry unseen for the maximum age is dropped; a refreshed one survives", async () => {
  await withWorkDir((workDir) => {
    let clock = 1_000_000;
    const now = () => clock;
    resetDecisionWarnings();
    configureDecisionWarnStore(workDir, now);
    shouldWarnDecision("stale", "sig");
    shouldWarnDecision("kept", "sig");

    // "kept" is re-checked daily, so its stamp is refreshed; "stale" is not.
    for (let day = 0; day < 8; day++) {
      clock += DECISION_REFRESH_MS;
      assertEquals(shouldWarnDecision("kept", "sig"), false);
    }
    assertEquals(clock - 1_000_000 > DECISION_MAX_AGE_MS, true);

    restart(workDir, now);
    assertEquals(shouldWarnDecision("kept", "sig"), false);
    assertEquals(shouldWarnDecision("stale", "sig"), true);
  });
});

Deno.test("configureDecisionWarnStore - a corrupt store reads as empty and is rewritten (fail loud, not silent)", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(decisionWarnStorePath(workDir), "{not json");
    resetDecisionWarnings();
    configureDecisionWarnStore(workDir);
    assertEquals(shouldWarnDecision("k", "sig"), true);
    restart(workDir);
    assertEquals(shouldWarnDecision("k", "sig"), false);
  });
});

Deno.test("configureDecisionWarnStore - a store holding a prototype key or malformed entries loads only the valid entries", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      decisionWarnStorePath(workDir),
      '{"version":1,"decisions":{"__proto__":{"signature":"x","seenAt":' +
        Date.now() +
        '},"bad":{"signature":1},"good":{"signature":"sig","seenAt":' +
        Date.now() + "}}}",
    );
    resetDecisionWarnings();
    configureDecisionWarnStore(workDir);
    assertEquals(shouldWarnDecision("good", "sig"), false);
    assertEquals(shouldWarnDecision("bad", "sig"), true);
    assertEquals(
      ({} as Record<string, unknown>).signature,
      undefined,
      "Object.prototype must not be polluted",
    );
  });
});
