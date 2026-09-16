/**
 * A milestone sync that resolved its conflict itself posts a notice, not an
 * escalation (Issue #2214).
 *
 * VibeCoder#2145 and #2163, 2026-09-16: the sync merged main in, settled the
 * ledger by union, verified and pushed — and reopened the closed planning
 * issue, labelled it `needs-human`, and led with "needs a human". Same on
 * NEAT-AI-Ockham#130, twice. The success notice now leaves a closed parent
 * closed, applies no label, and clears the `needs-human` an earlier sync
 * escalation of the same branch left behind. A resolution nobody could make
 * still escalates exactly as before.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ActiveMilestone,
  escalateSyncConflict,
} from "../lib/milestone_branch_sync.ts";
import { conflictEscalationMarker } from "../lib/milestone_conflict_dedup.ts";
import type { MilestoneSyncConflict } from "../lib/milestone_sync_conflict.ts";

const REPO = "stSoftwareAU/VibeCoder";
const BRANCH = "milestone/2145-trial-codegraph-as-a-second-repo-context-cand";

const MILESTONE: ActiveMilestone = {
  milestoneTitle: "#2145 Trial CodeGraph as a second repo-context candidate",
  milestoneNumber: 60,
  milestoneBranch: BRANCH,
  defaultBranch: "main",
};

function conflict(
  resolution: MilestoneSyncConflict["resolution"],
): MilestoneSyncConflict {
  return {
    files: ["docs/audits/lib-sweep-coverage.json"],
    milestoneSha: "68e2065a403efc022cfde9a8574d71f18ed2e6a4",
    defaultSha: "7e75ebb286a816729bd7ab750166bf8e0179f0af",
    resolution,
  };
}

interface Thread {
  state: "OPEN" | "CLOSED";
  labels: string[];
  comments: string[];
}

/** A gh stub over one planning-issue thread, recording every call. */
function ghStub(thread: Thread) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const key = args.join(" ");
    if (key.startsWith("api repos/")) return Promise.resolve("abc1234 subject");
    if (key.includes("--json state")) return Promise.resolve(thread.state);
    if (key.includes("--json labels,comments")) {
      return Promise.resolve(JSON.stringify({
        labels: thread.labels.map((name) => ({ name })),
        comments: thread.comments.map((body) => ({ body })),
      }));
    }
    if (key.includes("--json comments")) {
      return Promise.resolve(
        JSON.stringify({ comments: thread.comments.map((body) => ({ body })) }),
      );
    }
    return Promise.resolve("");
  };
  const comment = () =>
    calls.find((c) => c[0] === "issue" && c[1] === "comment");
  return {
    gh,
    calls,
    reopens: () => calls.filter((c) => c[0] === "issue" && c[1] === "reopen"),
    added: () =>
      calls.filter((c) => c.includes("--add-label")).map((c) =>
        c[c.indexOf("--add-label") + 1]
      ),
    removed: () =>
      calls.filter((c) => c.includes("--remove-label")).map((c) =>
        c[c.indexOf("--remove-label") + 1]
      ),
    body: () => comment()?.[comment()!.indexOf("--body") + 1] ?? "",
  };
}

Deno.test("escalateSyncConflict - a resolved conflict on a closed planning issue posts the notice there without reopening, labelling, or 'needs a human' (Issue #2214)", async () => {
  const stub = ghStub({ state: "CLOSED", labels: [], comments: [] });
  const posted = await escalateSyncConflict(
    REPO,
    MILESTONE,
    conflict("auto"),
    stub.gh,
    () => {},
  );

  assertEquals(posted, true);
  assertEquals(stub.reopens(), [], "the closed planning issue stays closed");
  assertEquals(stub.added(), [], "no label on a success");
  const body = stub.body();
  assertStringIncludes(body, "resolved a conflict automatically");
  // The notice's own closing line says "Nothing here needs a human"; what
  // must be absent is the escalation preamble.
  assert(
    !body.includes("needs a human, and this is the milestone's own planning"),
    body,
  );
  assert(!body.includes("Reopened by the milestone branch sync"), body);
});

Deno.test("escalateSyncConflict - a resolved conflict clears the needs-human an earlier sync escalation of the same branch applied (Issue #2214)", async () => {
  const earlier = conflictEscalationMarker(
    `${BRANCH}@0cf1383bc75c:Cargo.lock`,
  );
  const stub = ghStub({
    state: "OPEN",
    labels: ["needs-human", "top-priority"],
    comments: [
      `${earlier}\n## Milestone sync conflict needs a human — both sides prepared`,
    ],
  });
  const posted = await escalateSyncConflict(
    REPO,
    MILESTONE,
    conflict("auto"),
    stub.gh,
    () => {},
  );

  assertEquals(posted, true);
  assertEquals(stub.removed(), ["needs-human"]);
  assertStringIncludes(stub.body(), "is cleared: the branch has synced");
  assertEquals(stub.added(), []);
});

Deno.test("escalateSyncConflict - a needs-human that no sync escalation put there is left alone (Issue #2214)", async () => {
  const stub = ghStub({
    state: "OPEN",
    labels: ["needs-human"],
    comments: ["A person asked for a decision here."],
  });
  await escalateSyncConflict(
    REPO,
    MILESTONE,
    conflict("auto"),
    stub.gh,
    () => {},
  );

  assertEquals(
    stub.removed(),
    [],
    "a human's needs-human is not the sync's to remove",
  );
  assert(!stub.body().includes("is cleared"), stub.body());
});

Deno.test("escalateSyncConflict - a resolution nobody chose posts its record on the closed parent without reopening or labelling it either (Issue #2226)", async () => {
  const stub = ghStub({ state: "CLOSED", labels: [], comments: [] });
  const posted = await escalateSyncConflict(
    REPO,
    MILESTONE,
    conflict("theirs"),
    stub.gh,
    () => {},
  );

  assertEquals(posted, true);
  assertEquals(stub.reopens(), [], "the ladder acts on it, not a person");
  assertEquals(stub.added(), []);
  const body = stub.body();
  assert(body.length > 0, "the record is posted");
  assert(
    !body.includes("needs a human, and this is the milestone's own planning"),
    body,
  );
  assert(!body.includes("Reopened by the milestone branch sync"), body);
});
