/**
 * Tests for the heartbeat-recovery audit classifier (Issue #1885).
 *
 * Each fixture comment exercises one classifier branch to confirm
 * the correct label is produced.
 */

import { assert, assertEquals } from "@std/assert";
import {
  ASSIGNED_WITHOUT_HEARTBEAT_MARKER,
  classifyRecoveryEvent,
  deriveMarkerStateAtRecovery,
  findRecoveryComments,
  type RecoveryCategory,
  renderReport,
  tallyCategories,
} from "../lib/heartbeat_recovery_audit.ts";
import { formatHeartbeatMarker } from "../lib/heartbeat_storage.ts";

Deno.test("classifyRecoveryEvent — open PR wins regardless of marker", () => {
  const cat = classifyRecoveryEvent({
    markerStateAtRecovery: "live",
    openPrLinkedAtRecovery: true,
    reclaimedAfterRecovery: false,
    prMergedAfterRecovery: false,
  });
  assertEquals(cat, "false-positive:open-pr");
});

Deno.test("classifyRecoveryEvent — cleared marker without open PR", () => {
  const cat = classifyRecoveryEvent({
    markerStateAtRecovery: "cleared",
    openPrLinkedAtRecovery: false,
    reclaimedAfterRecovery: false,
    prMergedAfterRecovery: false,
  });
  assertEquals(cat, "false-positive:cleared-marker");
});

Deno.test("classifyRecoveryEvent — live marker with no PR is other false positive", () => {
  const cat = classifyRecoveryEvent({
    markerStateAtRecovery: "live",
    openPrLinkedAtRecovery: false,
    reclaimedAfterRecovery: false,
    prMergedAfterRecovery: false,
  });
  assertEquals(cat, "false-positive:other");
});

Deno.test("classifyRecoveryEvent — none + no follow-up = legitimate crash", () => {
  const cat = classifyRecoveryEvent({
    markerStateAtRecovery: "none",
    openPrLinkedAtRecovery: false,
    reclaimedAfterRecovery: false,
    prMergedAfterRecovery: false,
  });
  assertEquals(cat, "legitimate-crash");
});

Deno.test("classifyRecoveryEvent — stale marker + no follow-up = legitimate crash", () => {
  const cat = classifyRecoveryEvent({
    markerStateAtRecovery: "stale",
    openPrLinkedAtRecovery: false,
    reclaimedAfterRecovery: false,
    prMergedAfterRecovery: false,
  });
  assertEquals(cat, "legitimate-crash");
});

Deno.test("classifyRecoveryEvent — stale marker but PR merged later = other false positive", () => {
  // The recovery fired but the work eventually completed cleanly,
  // suggesting the worker had not actually crashed permanently.
  const cat = classifyRecoveryEvent({
    markerStateAtRecovery: "stale",
    openPrLinkedAtRecovery: false,
    reclaimedAfterRecovery: true,
    prMergedAfterRecovery: true,
  });
  assertEquals(cat, "false-positive:other");
});

Deno.test("deriveMarkerStateAtRecovery — no comments yields none", () => {
  const state = deriveMarkerStateAtRecovery([], "2026-05-10T12:00:00Z", 1800);
  assertEquals(state, "none");
});

Deno.test("deriveMarkerStateAtRecovery — recent marker yields live", () => {
  const recovery = "2026-05-10T12:30:00Z";
  // Marker epoch 5 minutes before recovery, well within 30-minute timeout.
  const markerEpoch = Math.floor(
    (Date.parse(recovery) - 5 * 60 * 1000) / 1000,
  );
  const comments = [{
    body: formatHeartbeatMarker("machine-a", markerEpoch),
    created_at: "2026-05-10T12:25:00Z",
  }];
  const state = deriveMarkerStateAtRecovery(comments, recovery, 1800);
  assertEquals(state, "live");
});

Deno.test("deriveMarkerStateAtRecovery — old marker yields stale", () => {
  const recovery = "2026-05-10T12:30:00Z";
  // Marker epoch 4 hours before recovery, far outside 30-minute timeout.
  const markerEpoch = Math.floor(
    (Date.parse(recovery) - 4 * 3600 * 1000) / 1000,
  );
  const comments = [{
    body: formatHeartbeatMarker("machine-a", markerEpoch),
    created_at: "2026-05-10T08:30:00Z",
  }];
  const state = deriveMarkerStateAtRecovery(comments, recovery, 1800);
  assertEquals(state, "stale");
});

Deno.test("deriveMarkerStateAtRecovery — epoch=0 marker yields cleared", () => {
  const recovery = "2026-05-10T12:30:00Z";
  const comments = [{
    body:
      "<!-- VIBE_CODER_HEARTBEAT:machine-a:0 --> <!-- cleared: claim released -->",
    created_at: "2026-05-10T12:00:00Z",
  }];
  const state = deriveMarkerStateAtRecovery(comments, recovery, 1800);
  assertEquals(state, "cleared");
});

Deno.test("deriveMarkerStateAtRecovery — comments after recovery are ignored", () => {
  const recovery = "2026-05-10T12:30:00Z";
  // Live marker AFTER recovery should not influence classification.
  const markerEpoch = Math.floor(
    (Date.parse(recovery) + 60 * 1000) / 1000,
  );
  const comments = [{
    body: formatHeartbeatMarker("machine-a", markerEpoch),
    created_at: "2026-05-10T12:31:00Z",
  }];
  const state = deriveMarkerStateAtRecovery(comments, recovery, 1800);
  assertEquals(state, "none");
});

Deno.test("findRecoveryComments — matches the canonical marker", () => {
  const comments = [
    {
      id: 1,
      body: "Some unrelated comment",
      created_at: "2026-05-10T11:00:00Z",
    },
    {
      id: 2,
      body: `Recovery body\n\n---\n\n${ASSIGNED_WITHOUT_HEARTBEAT_MARKER}`,
      created_at: "2026-05-10T12:00:00Z",
    },
    {
      id: 3,
      body: "Self-healing recovery (Issue #471)",
      created_at: "2026-05-10T13:00:00Z",
    },
  ];
  const found = findRecoveryComments(comments);
  assertEquals(found.length, 1);
  assertEquals(found[0]!.id, 2);
});

Deno.test("tallyCategories — sums all four buckets", () => {
  const categories: RecoveryCategory[] = [
    "legitimate-crash",
    "legitimate-crash",
    "false-positive:cleared-marker",
    "false-positive:open-pr",
    "false-positive:other",
    "false-positive:other",
  ];
  const totals = tallyCategories(categories);
  assertEquals(totals.total, 6);
  assertEquals(totals.legitimateCrash, 2);
  assertEquals(totals.falsePositiveClearedMarker, 1);
  assertEquals(totals.falsePositiveOpenPr, 1);
  assertEquals(totals.falsePositiveOther, 2);
});

Deno.test("renderReport — includes counts, examples and conclusion", () => {
  const examples = new Map<
    RecoveryCategory,
    Array<{
      repo: string;
      issueNumber: number;
      recoveryIso: string;
    }>
  >();
  examples.set("legitimate-crash", [
    { repo: "org/foo", issueNumber: 100, recoveryIso: "2026-05-01T10:00:00Z" },
  ]);
  examples.set("false-positive:cleared-marker", [
    { repo: "org/foo", issueNumber: 200, recoveryIso: "2026-05-02T10:00:00Z" },
    { repo: "org/bar", issueNumber: 201, recoveryIso: "2026-05-02T11:00:00Z" },
  ]);
  examples.set("false-positive:open-pr", []);
  examples.set("false-positive:other", []);

  const report = renderReport({
    generatedAtIso: "2026-05-10T00:00:00Z",
    windowDays: 30,
    reposScanned: 5,
    totals: {
      total: 3,
      legitimateCrash: 1,
      falsePositiveClearedMarker: 2,
      falsePositiveOpenPr: 0,
      falsePositiveOther: 0,
    },
    examples,
  });

  assert(report.includes("# Heartbeat Recovery Audit"));
  assert(report.includes("Total recovery events:** 3"));
  assert(report.includes("Repos scanned:** 5"));
  assert(report.includes("org/foo#100"));
  assert(report.includes("org/bar#201"));
  assert(report.includes("Conclusion"));
  assert(report.includes("cleared-marker false positives"));
});

Deno.test("renderReport — empty totals produces honest conclusion", () => {
  const report = renderReport({
    generatedAtIso: "2026-05-10T00:00:00Z",
    windowDays: 30,
    reposScanned: 5,
    totals: {
      total: 0,
      legitimateCrash: 0,
      falsePositiveClearedMarker: 0,
      falsePositiveOpenPr: 0,
      falsePositiveOther: 0,
    },
    examples: new Map(),
  });
  assert(report.includes("No `Assigned-without-heartbeat recovery"));
});
