/**
 * Tests for `getLabelLastRemoveInfo` (Issue #1878).
 *
 * Mirrors the existing `getLabelLastAddInfo` tests but inspects
 * `unlabeled` events instead of `labeled` events. Used by the grill-me
 * processor to detect when a non-worker user has explicitly removed
 * `needs-human` after a Round N comment was posted — that removal is
 * the developer's "go" signal even when no separate reply comment has
 * been authored.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { getLabelLastRemoveInfo } from "../lib/issue_query.ts";

interface TimelineEvent {
  event: string;
  label?: { name: string };
  actor?: { login: string };
  created_at?: string;
}

function createGhMock(
  timeline: TimelineEvent[],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const command = args.join(" ");
    if (command.includes("api") && command.includes("timeline")) {
      return Promise.resolve(JSON.stringify(timeline));
    }
    return Promise.resolve("");
  };
}

Deno.test(
  "getLabelLastRemoveInfo - returns timestamp of last unlabeled event",
  async () => {
    const gh = createGhMock([
      {
        event: "labeled",
        label: { name: "needs-human" },
        actor: { login: "testbot" },
        created_at: "2026-05-09T07:40:36Z",
      },
      {
        event: "unlabeled",
        label: { name: "needs-human" },
        actor: { login: "maintainer" },
        created_at: "2026-05-09T07:55:39Z",
      },
      {
        event: "labeled",
        label: { name: "needs-human" },
        actor: { login: "testbot" },
        created_at: "2026-05-09T08:15:00Z",
      },
      {
        event: "unlabeled",
        label: { name: "needs-human" },
        actor: { login: "maintainer" },
        created_at: "2026-05-09T08:16:20Z",
      },
    ]);

    const info = await getLabelLastRemoveInfo(
      "owner/repo",
      230,
      "needs-human",
      gh,
    );
    assertEquals(info !== null, true);
    if (info !== null) {
      assertEquals(info.removedBy, "maintainer");
      assertEquals(
        info.removedAt,
        Math.floor(Date.parse("2026-05-09T08:16:20Z") / 1000),
      );
    }
  },
);

Deno.test(
  "getLabelLastRemoveInfo - returns null when label was never removed",
  async () => {
    const gh = createGhMock([
      {
        event: "labeled",
        label: { name: "needs-human" },
        actor: { login: "testbot" },
        created_at: "2026-05-09T07:40:36Z",
      },
    ]);

    const info = await getLabelLastRemoveInfo(
      "owner/repo",
      230,
      "needs-human",
      gh,
    );
    assertEquals(info, null);
  },
);

Deno.test(
  "getLabelLastRemoveInfo - returns null when no timestamp present",
  async () => {
    const gh = createGhMock([
      {
        event: "unlabeled",
        label: { name: "needs-human" },
        actor: { login: "maintainer" },
        // No created_at field.
      },
    ]);

    const info = await getLabelLastRemoveInfo(
      "owner/repo",
      230,
      "needs-human",
      gh,
    );
    assertEquals(info, null);
  },
);

Deno.test(
  "getLabelLastRemoveInfo - returns null when only other labels were removed",
  async () => {
    const gh = createGhMock([
      {
        event: "unlabeled",
        label: { name: "grill-me" },
        actor: { login: "maintainer" },
        created_at: "2026-05-09T10:10:50Z",
      },
    ]);

    const info = await getLabelLastRemoveInfo(
      "owner/repo",
      230,
      "needs-human",
      gh,
    );
    assertEquals(info, null);
  },
);

Deno.test(
  "getLabelLastRemoveInfo - distinguishes worker from non-worker actor",
  async () => {
    // The worker user can also remove the label (operational-label
    // strip). The function returns the actor faithfully so callers can
    // decide whether to treat the removal as a developer signal.
    const gh = createGhMock([
      {
        event: "unlabeled",
        label: { name: "needs-human" },
        actor: { login: "testbot" },
        created_at: "2026-05-09T08:30:00Z",
      },
    ]);

    const info = await getLabelLastRemoveInfo(
      "owner/repo",
      230,
      "needs-human",
      gh,
    );
    assertEquals(info !== null, true);
    if (info !== null) {
      assertEquals(info.removedBy, "testbot");
    }
  },
);

Deno.test(
  "getLabelLastRemoveInfo - uses per_page=100 so events beyond page 1 are visible (Issue #1878)",
  async () => {
    // Verify the gh command includes per_page=100. Without this, issues with
    // >30 timeline events return only the first page, missing recent label
    // removals and causing isNonWorkerRemovalAfterRound to see only stale
    // events that pre-date the current round — silently re-adding needs-human.
    const capturedArgs: string[][] = [];
    const gh = (args: string[]): Promise<string> => {
      capturedArgs.push(args);
      return Promise.resolve(JSON.stringify([]));
    };

    await getLabelLastRemoveInfo("owner/repo", 230, "needs-human", gh);

    assertEquals(capturedArgs.length >= 1, true);
    const timelineCall = capturedArgs.find(
      (args) => args.some((a) => a.includes("timeline")),
    );
    assertEquals(timelineCall !== undefined, true);
    const endpoint = timelineCall?.find((a) => a.includes("timeline")) ?? "";
    assertEquals(
      endpoint.includes("per_page=100"),
      true,
      `Expected per_page=100 in timeline URL, got: ${endpoint}`,
    );
  },
);
