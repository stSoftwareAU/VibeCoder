/**
 * The running-attempt announcement (Issue #2309).
 *
 * A conflict resolution that holds a milestone branch says so where the
 * milestone is already being read, naming the host it runs on and the time it
 * started — and it asks nothing of anyone.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type AgentAttemptAnnouncement,
  announceAgentAttempt,
  buildAgentAttemptComment,
} from "../lib/milestone_sync_announcement.ts";

const ANNOUNCEMENT: AgentAttemptAnnouncement = {
  repo: "owner/repo",
  milestoneTitle: "#1730 Ledger",
  milestoneNumber: 7,
  milestoneBranch: "milestone/1730-ledger",
  defaultBranch: "main",
  host: "worker-7",
  startedAt: "2026-09-18T01:02:03.000Z",
};

Deno.test("buildAgentAttemptComment - names the host, the start time and both branches", () => {
  const body = buildAgentAttemptComment(ANNOUNCEMENT);
  assertStringIncludes(body, "worker-7");
  assertStringIncludes(body, "2026-09-18T01:02:03.000Z");
  assertStringIncludes(body, "milestone/1730-ledger");
  assertStringIncludes(body, "main");
  // A record, not a hand-off: the sweep never asks a person for anything.
  assert(!body.includes("needs-human"));
});

Deno.test("announceAgentAttempt - posts one comment on the milestone's parent issue", async () => {
  const calls: string[][] = [];
  const logs: string[] = [];
  const posted = await announceAgentAttempt(
    ANNOUNCEMENT,
    (args) => {
      calls.push([...args]);
      return Promise.resolve("");
    },
    (message) => logs.push(message),
  );

  assertEquals(posted, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.slice(0, 5), [
    "issue",
    "comment",
    "1730",
    "--repo",
    "owner/repo",
  ]);
  assertStringIncludes(calls[0]?.[6] ?? "", "worker-7");
  assert(logs.some((line) => line.includes("#1730")));
});

Deno.test("announceAgentAttempt - a milestone with nowhere to post is recorded, not retried", async () => {
  const calls: string[][] = [];
  const logs: string[] = [];
  const posted = await announceAgentAttempt(
    { ...ANNOUNCEMENT, milestoneTitle: "Unnumbered milestone" },
    (args) => {
      calls.push([...args]);
      // No parent issue in the title and no open children.
      return Promise.resolve("[]");
    },
    (message) => logs.push(message),
  );

  assertEquals(posted, true);
  assertEquals(calls.filter((c) => c[1] === "comment"), []);
  assert(logs.some((line) => line.includes("No open issue to carry")));
});

Deno.test("announceAgentAttempt - a post that failed is said out loud and not recorded", async () => {
  const logs: string[] = [];
  const posted = await announceAgentAttempt(
    ANNOUNCEMENT,
    (args) => {
      if (args[1] === "comment") return Promise.reject(new Error("gh is down"));
      return Promise.resolve("");
    },
    (message) => logs.push(message),
  );

  assertEquals(posted, false);
  assert(
    logs.some((line) =>
      line.includes("WARNING") && line.includes("gh is down")
    ),
    `the reason must reach the log, got ${JSON.stringify(logs)}`,
  );
});
