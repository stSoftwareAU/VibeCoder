/**
 * Tests for the audit-heartbeat-recoveries command (Issue #1885).
 *
 * Covers:
 *   - The pure classifier (lib/heartbeat_recovery_classifier.ts) for
 *     each of the four buckets defined in the issue.
 *   - The marker-state derivation helper.
 *   - The orchestrating `auditHeartbeatRecoveries` function with a
 *     stubbed gh runner.
 *   - The markdown-rendering helpers.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  auditHeartbeatRecoveries,
  auditHeartbeatRecoveriesCommand,
  type AuditReport,
  buildConclusion,
  completedWithinFollowUp,
  deriveMarkerState,
  formatAuditMarkdown,
  hadOpenLinkedPRAtRecovery,
} from "../commands/audit_heartbeat_recoveries.ts";
import {
  classifyEvent,
  isRecoveryComment,
  parseMarkerStateFromBody,
} from "../lib/heartbeat_recovery_classifier.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

const config = buildDefaultWorkerConfig();

// ============================================================================
// Command metadata
// ============================================================================

Deno.test("auditHeartbeatRecoveriesCommand - has correct name", () => {
  assertEquals(
    auditHeartbeatRecoveriesCommand.name,
    "audit-heartbeat-recoveries",
  );
});

Deno.test("auditHeartbeatRecoveriesCommand - has description", () => {
  assertEquals(auditHeartbeatRecoveriesCommand.description.length > 0, true);
});

// ============================================================================
// classifyEvent — the four buckets defined in Issue #1885
// ============================================================================

Deno.test("classifyEvent - legitimate-crash when no marker, no PR, no completion", () => {
  assertEquals(
    classifyEvent({
      markerState: "absent",
      openLinkedPRAtRecovery: false,
      completedWithinFollowUp: false,
    }),
    "legitimate-crash",
  );
});

Deno.test("classifyEvent - legitimate-crash also when marker is stale", () => {
  assertEquals(
    classifyEvent({
      markerState: "stale",
      openLinkedPRAtRecovery: false,
      completedWithinFollowUp: false,
    }),
    "legitimate-crash",
  );
});

Deno.test("classifyEvent - false-positive:cleared-marker when marker was cleared", () => {
  assertEquals(
    classifyEvent({
      markerState: "cleared",
      openLinkedPRAtRecovery: false,
      completedWithinFollowUp: false,
    }),
    "false-positive:cleared-marker",
  );
});

Deno.test("classifyEvent - false-positive:open-pr when an open PR is linked", () => {
  assertEquals(
    classifyEvent({
      markerState: "absent",
      openLinkedPRAtRecovery: true,
      completedWithinFollowUp: false,
    }),
    "false-positive:open-pr",
  );
});

Deno.test("classifyEvent - open PR wins over cleared marker", () => {
  // The open-PR signal is the strongest "worker is fine" indicator —
  // it must dominate even if the marker has been cleared.
  assertEquals(
    classifyEvent({
      markerState: "cleared",
      openLinkedPRAtRecovery: true,
      completedWithinFollowUp: false,
    }),
    "false-positive:open-pr",
  );
});

Deno.test("classifyEvent - false-positive:other when marker is live", () => {
  assertEquals(
    classifyEvent({
      markerState: "live",
      openLinkedPRAtRecovery: false,
      completedWithinFollowUp: false,
    }),
    "false-positive:other",
  );
});

Deno.test("classifyEvent - false-positive:other when work completed within follow-up", () => {
  assertEquals(
    classifyEvent({
      markerState: "absent",
      openLinkedPRAtRecovery: false,
      completedWithinFollowUp: true,
    }),
    "false-positive:other",
  );
});

// ============================================================================
// isRecoveryComment
// ============================================================================

Deno.test("isRecoveryComment - matches the canonical marker", () => {
  const body = `Automatic recovery: this issue was unassigned ...

---

Assigned-without-heartbeat recovery (Issue #632)`;
  assertEquals(isRecoveryComment(body), true);
});

Deno.test("isRecoveryComment - matches a near-duplicate phrasing", () => {
  const body =
    "Automatic recovery: assigned over 30 minutes ago with no heartbeat recorded for this issue.";
  assertEquals(isRecoveryComment(body), true);
});

Deno.test("isRecoveryComment - rejects unrelated comments", () => {
  assertEquals(isRecoveryComment("LGTM, merging."), false);
  assertEquals(
    isRecoveryComment(
      "Self-healing recovery (Issue #471) — heartbeat timed out.",
    ),
    false,
  );
});

// ============================================================================
// parseMarkerStateFromBody
// ============================================================================

Deno.test("parseMarkerStateFromBody - absent when no marker present", () => {
  assertEquals(parseMarkerStateFromBody("Just some prose."), "absent");
});

Deno.test("parseMarkerStateFromBody - cleared when epoch=0 and cleared suffix", () => {
  const body =
    "<!-- VIBE_CODER_HEARTBEAT:machine-A:0 --> <!-- cleared: claim released by machine machine-A -->";
  assertEquals(parseMarkerStateFromBody(body), "cleared");
});

Deno.test("parseMarkerStateFromBody - live when epoch is non-zero", () => {
  const body = "<!-- VIBE_CODER_HEARTBEAT:machine-A:1715000000 -->";
  assertEquals(parseMarkerStateFromBody(body), "live");
});

// ============================================================================
// deriveMarkerState — picks the latest marker before recovery
// ============================================================================

Deno.test("deriveMarkerState - returns absent when no marker comments exist", () => {
  const recovery = "2026-05-10T10:00:00Z";
  const state = deriveMarkerState(
    [
      {
        id: 1,
        user: { login: "u" },
        created_at: "2026-05-10T09:00:00Z",
        body: "hi",
      },
    ],
    recovery,
    24 * 3600,
  );
  assertEquals(state, "absent");
});

Deno.test("deriveMarkerState - returns cleared when latest marker before recovery is cleared", () => {
  const state = deriveMarkerState(
    [
      {
        id: 1,
        user: { login: "u" },
        created_at: "2026-05-10T08:00:00Z",
        body: "<!-- VIBE_CODER_HEARTBEAT:m:1715000000 -->",
      },
      {
        id: 2,
        user: { login: "u" },
        created_at: "2026-05-10T09:55:00Z",
        body: "<!-- VIBE_CODER_HEARTBEAT:m:0 --> <!-- cleared: released -->",
      },
    ],
    "2026-05-10T10:00:00Z",
    24 * 3600,
  );
  assertEquals(state, "cleared");
});

Deno.test("deriveMarkerState - returns stale when latest marker is older than the window", () => {
  const state = deriveMarkerState(
    [
      {
        id: 1,
        user: { login: "u" },
        created_at: "2026-05-08T00:00:00Z", // 2 days before recovery
        body: "<!-- VIBE_CODER_HEARTBEAT:m:1715000000 -->",
      },
    ],
    "2026-05-10T00:00:00Z",
    24 * 3600,
  );
  assertEquals(state, "stale");
});

Deno.test("deriveMarkerState - returns live when latest marker is recent", () => {
  const state = deriveMarkerState(
    [
      {
        id: 1,
        user: { login: "u" },
        created_at: "2026-05-10T09:55:00Z",
        body: "<!-- VIBE_CODER_HEARTBEAT:m:1715000000 -->",
      },
    ],
    "2026-05-10T10:00:00Z",
    24 * 3600,
  );
  assertEquals(state, "live");
});

// ============================================================================
// hadOpenLinkedPRAtRecovery / completedWithinFollowUp
// ============================================================================

Deno.test("hadOpenLinkedPRAtRecovery - true for an unmerged PR cross-reference", () => {
  const open = hadOpenLinkedPRAtRecovery(
    [
      {
        event: "cross-referenced",
        created_at: "2026-05-10T09:00:00Z",
        source: { issue: { number: 99, pull_request: { merged_at: null } } },
      },
    ],
    "2026-05-10T10:00:00Z",
  );
  assertEquals(open, true);
});

Deno.test("hadOpenLinkedPRAtRecovery - false when PR was merged before recovery", () => {
  const open = hadOpenLinkedPRAtRecovery(
    [
      {
        event: "cross-referenced",
        created_at: "2026-05-10T09:00:00Z",
        source: {
          issue: {
            number: 99,
            pull_request: { merged_at: "2026-05-10T09:30:00Z" },
          },
        },
      },
    ],
    "2026-05-10T10:00:00Z",
  );
  assertEquals(open, false);
});

Deno.test("completedWithinFollowUp - true for PR merged inside the window", () => {
  const completed = completedWithinFollowUp(
    [
      {
        event: "cross-referenced",
        created_at: "2026-05-10T11:00:00Z",
        source: {
          issue: {
            number: 100,
            pull_request: { merged_at: "2026-05-12T11:00:00Z" },
          },
        },
      },
    ],
    "2026-05-10T10:00:00Z",
    7,
  );
  assertEquals(completed, true);
});

Deno.test("completedWithinFollowUp - false for PR merged after the window", () => {
  const completed = completedWithinFollowUp(
    [
      {
        event: "cross-referenced",
        created_at: "2026-05-20T00:00:00Z",
        source: {
          issue: {
            number: 100,
            pull_request: { merged_at: "2026-05-25T00:00:00Z" },
          },
        },
      },
    ],
    "2026-05-10T10:00:00Z",
    7,
  );
  assertEquals(completed, false);
});

// ============================================================================
// auditHeartbeatRecoveries — full pass with a stubbed gh runner
// ============================================================================

interface StubResponses {
  search: number[]; // issue numbers returned by search/issues
  comments: Record<number, unknown[]>;
  timeline: Record<number, unknown[]>;
  title: Record<number, string>;
}

function stubGh(
  repo: string,
  responses: StubResponses,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("search/issues")) {
      return Promise.resolve(
        JSON.stringify({
          items: responses.search.map((n) => ({ number: n })),
        }),
      );
    }
    // comments endpoint
    const commentsMatch = joined.match(
      new RegExp(`repos/${repo}/issues/(\\d+)/comments`),
    );
    if (commentsMatch) {
      const issueNumber = Number(commentsMatch[1]);
      // Pagination: gh is called with `page=N`; return the array on page 1
      // and an empty array thereafter so the loop terminates.
      const page = (() => {
        // Match "page=N" only when not preceded by "per_" — avoids
        // confusing the per_page=100 query parameter with the actual
        // page argument.
        const m = joined.match(/(?:^|[^_])page=(\d+)/);
        return m ? Number(m[1]) : 1;
      })();
      if (page > 1) return Promise.resolve("[]");
      return Promise.resolve(
        JSON.stringify(responses.comments[issueNumber] ?? []),
      );
    }
    const timelineMatch = joined.match(
      new RegExp(`repos/${repo}/issues/(\\d+)/timeline`),
    );
    if (timelineMatch) {
      const issueNumber = Number(timelineMatch[1]);
      return Promise.resolve(
        JSON.stringify(responses.timeline[issueNumber] ?? []),
      );
    }
    const issueMatch = joined.match(
      new RegExp(`repos/${repo}/issues/(\\d+)$`),
    );
    if (issueMatch) {
      const issueNumber = Number(issueMatch[1]);
      return Promise.resolve(
        JSON.stringify({ title: responses.title[issueNumber] ?? "" }),
      );
    }
    return Promise.resolve("[]");
  };
}

Deno.test("auditHeartbeatRecoveries - classifies events from stubbed gh data", async () => {
  const repo = "owner/audit-test";
  const recoveryBody = `Automatic recovery: blah.

---

Assigned-without-heartbeat recovery (Issue #632)`;

  const stub = stubGh(repo, {
    search: [101, 102, 103, 104],
    comments: {
      // 101 — cleared marker before recovery → false-positive:cleared-marker
      101: [
        {
          id: 11,
          user: { login: "worker-bot" },
          created_at: "2026-05-08T09:00:00Z",
          body: "<!-- VIBE_CODER_HEARTBEAT:m:1715000000 -->",
        },
        {
          id: 12,
          user: { login: "worker-bot" },
          created_at: "2026-05-08T09:30:00Z",
          body: "<!-- VIBE_CODER_HEARTBEAT:m:0 --> <!-- cleared: released -->",
        },
        {
          id: 13,
          user: { login: "worker-bot" },
          created_at: "2026-05-08T10:00:00Z",
          body: recoveryBody,
        },
      ],
      // 102 — open PR linked at recovery → false-positive:open-pr
      102: [
        {
          id: 21,
          user: { login: "worker-bot" },
          created_at: "2026-05-08T10:00:00Z",
          body: recoveryBody,
        },
      ],
      // 103 — no marker, no PR, no follow-up → legitimate-crash
      103: [
        {
          id: 31,
          user: { login: "worker-bot" },
          created_at: "2026-05-08T10:00:00Z",
          body: recoveryBody,
        },
      ],
      // 104 — live marker → false-positive:other
      104: [
        {
          id: 41,
          user: { login: "worker-bot" },
          created_at: "2026-05-08T09:55:00Z",
          body: "<!-- VIBE_CODER_HEARTBEAT:m:1715000000 -->",
        },
        {
          id: 42,
          user: { login: "worker-bot" },
          created_at: "2026-05-08T10:00:00Z",
          body: recoveryBody,
        },
      ],
    },
    timeline: {
      101: [],
      102: [
        {
          event: "cross-referenced",
          created_at: "2026-05-08T09:30:00Z",
          source: { issue: { number: 200, pull_request: { merged_at: null } } },
        },
      ],
      103: [],
      104: [],
    },
    title: { 101: "A", 102: "B", 103: "C", 104: "D" },
  });

  const result = await auditHeartbeatRecoveries({
    repos: [repo],
    workerUser: "worker-bot",
    windowDays: 30,
    nowFn: () => new Date("2026-05-10T00:00:00Z"),
    ghCommandFn: stub,
  });
  if (!result.ok) throw result.error;
  const report = result.value;
  assertEquals(report.totals.events, 4);
  assertEquals(report.byCategory["false-positive:cleared-marker"], 1);
  assertEquals(report.byCategory["false-positive:open-pr"], 1);
  assertEquals(report.byCategory["legitimate-crash"], 1);
  assertEquals(report.byCategory["false-positive:other"], 1);
});

Deno.test("auditHeartbeatRecoveries - ignores comments by other authors", async () => {
  const repo = "owner/audit-test";
  const recoveryBody = "Assigned-without-heartbeat recovery (Issue #632)";
  const stub = stubGh(repo, {
    search: [201],
    comments: {
      201: [
        {
          id: 1,
          user: { login: "someone-else" },
          created_at: "2026-05-08T10:00:00Z",
          body: recoveryBody,
        },
      ],
    },
    timeline: { 201: [] },
    title: { 201: "X" },
  });
  const result = await auditHeartbeatRecoveries({
    repos: [repo],
    workerUser: "worker-bot",
    windowDays: 30,
    nowFn: () => new Date("2026-05-10T00:00:00Z"),
    ghCommandFn: stub,
  });
  if (!result.ok) throw result.error;
  assertEquals(result.value.totals.events, 0);
});

// ============================================================================
// formatAuditMarkdown / buildConclusion
// ============================================================================

function buildReport(byCategory: Record<string, number>): AuditReport {
  const events: AuditReport["events"] = [];
  let id = 1;
  for (const [cat, count] of Object.entries(byCategory)) {
    for (let i = 0; i < count; i++) {
      events.push({
        repo: "owner/repo",
        issue: id,
        title: `Issue ${id}`,
        recoveryCommentId: id * 10,
        recoveryAt: "2026-05-08T10:00:00Z",
        category: cat as AuditReport["events"][0]["category"],
      });
      id++;
    }
  }
  return {
    generatedAt: "2026-05-10T00:00:00.000Z",
    windowDays: 30,
    workerUser: "worker-bot",
    reposScanned: ["owner/repo"],
    totals: {
      events: events.length,
      issues: new Set(events.map((e) => `${e.repo}#${e.issue}`)).size,
    },
    byCategory: {
      "legitimate-crash": byCategory["legitimate-crash"] ?? 0,
      "false-positive:cleared-marker":
        byCategory["false-positive:cleared-marker"] ?? 0,
      "false-positive:open-pr": byCategory["false-positive:open-pr"] ?? 0,
      "false-positive:other": byCategory["false-positive:other"] ?? 0,
    },
    events,
  };
}

Deno.test("formatAuditMarkdown - includes per-category counts and example links", () => {
  const md = formatAuditMarkdown(
    buildReport({
      "legitimate-crash": 1,
      "false-positive:cleared-marker": 2,
      "false-positive:open-pr": 1,
      "false-positive:other": 0,
    }),
  );
  assertStringIncludes(md, "Heartbeat-recovery audit");
  assertStringIncludes(md, "`legitimate-crash`");
  assertStringIncludes(md, "`false-positive:cleared-marker`");
  assertStringIncludes(md, "`false-positive:open-pr`");
  assertStringIncludes(md, "`false-positive:other`");
  assertStringIncludes(md, "https://github.com/owner/repo/issues/");
});

Deno.test("formatAuditMarkdown - shows _No events_ for empty categories", () => {
  const md = formatAuditMarkdown(
    buildReport({
      "legitimate-crash": 0,
      "false-positive:cleared-marker": 0,
      "false-positive:open-pr": 1,
      "false-positive:other": 0,
    }),
  );
  assertStringIncludes(md, "_No events in this category._");
});

Deno.test("buildConclusion - reports quiescent path when zero events", () => {
  const text = buildConclusion(
    buildReport({
      "legitimate-crash": 0,
      "false-positive:cleared-marker": 0,
      "false-positive:open-pr": 0,
      "false-positive:other": 0,
    }),
  );
  assertStringIncludes(text, "No `Assigned-without-heartbeat recovery");
});

Deno.test("buildConclusion - identifies the dominant category", () => {
  const text = buildConclusion(
    buildReport({
      "legitimate-crash": 1,
      "false-positive:cleared-marker": 5,
      "false-positive:open-pr": 1,
      "false-positive:other": 1,
    }),
  );
  assertStringIncludes(text, "`false-positive:cleared-marker`");
  assertStringIncludes(text, "8 recovery events");
});

// ============================================================================
// Command — error path
// ============================================================================

Deno.test("auditHeartbeatRecoveriesCommand - errors when no repos configured", async () => {
  const stripped: WorkerConfig = { ...config, repos: [] };
  const result = await auditHeartbeatRecoveriesCommand.execute({}, stripped);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "No repos to audit");
});
