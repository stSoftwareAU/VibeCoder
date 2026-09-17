/**
 * A sync-conflict marker is only evidence when a fleet account wrote it
 * (Issue #2231).
 *
 * `clearEarlierSyncEscalation` removed `needs-human` from a milestone's
 * tracking issue whenever the thread contained a sync-conflict marker for the
 * branch — without checking who wrote the comment. The marker prefix is fixed
 * text and the branch it names is public on every milestone PR, so any account
 * that could comment on a public repository could plant one and have the
 * worker strip a `needs-human` a person applied. The same unauthored match
 * decided the cross-host dedup in `hasConflictEscalationComment`, where a
 * planted marker suppressed a report only a human can settle.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { parseIssueViewCommentRows } from "../lib/alert_dedup_authors.ts";
import {
  type ActiveMilestone,
  escalateSyncConflict,
} from "../lib/milestone_branch_sync.ts";
import {
  conflictEscalationMarker,
  hasConflictEscalationComment,
} from "../lib/milestone_conflict_dedup.ts";
import type { MilestoneSyncConflict } from "../lib/milestone_sync_conflict.ts";

const REPO = "stSoftwareAU/VibeCoder";
const BRANCH = "milestone/2145-trial-codegraph-as-a-second-repo-context-cand";
const FLEET = "vibe-coder-bot";
const OUTSIDER = "passing-stranger";

const MILESTONE: ActiveMilestone = {
  milestoneTitle: "#2145 Trial CodeGraph as a second repo-context candidate",
  milestoneNumber: 60,
  milestoneBranch: BRANCH,
  defaultBranch: "main",
};

const AUTO_CONFLICT: MilestoneSyncConflict = {
  files: ["docs/audits/lib-sweep-coverage.json"],
  milestoneSha: "68e2065a403efc022cfde9a8574d71f18ed2e6a4",
  defaultSha: "7e75ebb286a816729bd7ab750166bf8e0179f0af",
  resolution: "auto",
};

/** An earlier sync escalation's marker for this very branch. */
const EARLIER_MARKER = conflictEscalationMarker(
  `${BRANCH}@0cf1383bc75c:Cargo.lock`,
);

interface StubComment {
  author: string;
  body: string;
}

/** A gh stub over one open, `needs-human`-labelled thread. */
function ghStub(comments: StubComment[]) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const key = args.join(" ");
    if (key.startsWith("api repos/")) return Promise.resolve("abc1234 subject");
    if (key.includes("--json state")) return Promise.resolve("OPEN");
    if (key.includes("--json labels,comments")) {
      return Promise.resolve(JSON.stringify({
        labels: [{ name: "needs-human" }],
        comments: comments.map((c) => ({
          author: { login: c.author },
          body: c.body,
        })),
      }));
    }
    return Promise.resolve("");
  };
  return {
    gh,
    removed: () =>
      calls.filter((c) => c.includes("--remove-label")).map((c) =>
        c[c.indexOf("--remove-label") + 1]
      ),
    body: () => {
      const comment = calls.find((c) => c[0] === "issue" && c[1] === "comment");
      return comment?.[comment.indexOf("--body") + 1] ?? "";
    },
  };
}

Deno.test("escalateSyncConflict - a sync-conflict marker planted by a non-fleet commenter does not strip needs-human (Issue #2231)", async () => {
  const stub = ghStub([
    {
      author: OUTSIDER,
      body: `${EARLIER_MARKER}\nmilestone sync conflict needs a human`,
    },
  ]);

  const posted = await escalateSyncConflict(
    REPO,
    MILESTONE,
    AUTO_CONFLICT,
    stub.gh,
    () => {},
    { fleetAuthors: [FLEET] },
  );

  assertEquals(posted, true, "the notice still goes out");
  assertEquals(
    stub.removed(),
    [],
    "a marker anyone can write is not evidence the fleet escalated here",
  );
  assert(!stub.body().includes("is cleared"), stub.body());
});

Deno.test("escalateSyncConflict - a fleet-authored marker still clears the needs-human it applied (Issue #2231)", async () => {
  const stub = ghStub([
    { author: OUTSIDER, body: "Please leave this open." },
    {
      author: FLEET,
      body: `${EARLIER_MARKER}\nmilestone sync conflict needs a human`,
    },
  ]);

  const posted = await escalateSyncConflict(
    REPO,
    MILESTONE,
    AUTO_CONFLICT,
    stub.gh,
    () => {},
    { fleetAuthors: [FLEET] },
  );

  assertEquals(posted, true);
  assertEquals(stub.removed(), ["needs-human"], "#2214's behaviour is kept");
  assert(
    stub.body().includes("is cleared: the branch has synced"),
    stub.body(),
  );
});

Deno.test("escalateSyncConflict - an unresolved fleet identity leaves the label alone (Issue #2231)", async () => {
  const warnings: string[] = [];
  const stub = ghStub([
    {
      author: FLEET,
      body: `${EARLIER_MARKER}\nmilestone sync conflict needs a human`,
    },
  ]);

  await escalateSyncConflict(
    REPO,
    MILESTONE,
    AUTO_CONFLICT,
    stub.gh,
    (message) => warnings.push(message),
    { fleetAuthors: [] },
  );

  assertEquals(
    stub.removed(),
    [],
    "an unattributable marker fails closed — the label stands",
  );
  assert(
    warnings.some((w) => w.includes("fleet author set unresolved")),
    `the condition is logged, not swallowed: ${warnings.join(" | ")}`,
  );
});

Deno.test("escalateSyncConflict - a thread whose comments cannot be read leaves the label alone and says so (Issue #2231)", async () => {
  const warnings: string[] = [];
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const key = args.join(" ");
    if (key.startsWith("api repos/")) return Promise.resolve("abc1234 subject");
    if (key.includes("--json state")) return Promise.resolve("OPEN");
    if (key.includes("--json labels,comments")) {
      // A payload `gh` should never return: labels present, comments not an
      // array. An unread thread must not read as "this pass did not
      // escalate here".
      return Promise.resolve(
        JSON.stringify({ labels: [{ name: "needs-human" }], comments: {} }),
      );
    }
    return Promise.resolve("");
  };

  await escalateSyncConflict(
    REPO,
    MILESTONE,
    AUTO_CONFLICT,
    gh,
    (message) => warnings.push(message),
    { fleetAuthors: [FLEET] },
  );

  assertEquals(
    calls.filter((c) => c.includes("--remove-label")),
    [],
    "an unreadable thread fails closed",
  );
  assert(
    warnings.some((w) => w.includes("comments` array")),
    `the unreadable answer is named, not swallowed: ${warnings.join(" | ")}`,
  );
});

Deno.test("parseIssueViewCommentRows - keeps both author shapes and drops what cannot be read (Issue #2231)", () => {
  assertEquals(
    parseIssueViewCommentRows([
      { author: { login: FLEET }, body: "object shape" },
      { author: OUTSIDER, body: "bare login shape" },
      { body: "no author at all" },
      { author: { login: 7 }, body: "unreadable author" },
      { author: { login: FLEET } },
      null,
      "not a comment",
    ]),
    [
      { author: FLEET, body: "object shape" },
      { author: OUTSIDER, body: "bare login shape" },
      { author: null, body: "no author at all" },
      { author: null, body: "unreadable author" },
    ],
  );
});

Deno.test("parseIssueViewCommentRows - a payload that is not an array yields no rows (Issue #2231)", () => {
  assertEquals(parseIssueViewCommentRows(undefined), []);
  assertEquals(parseIssueViewCommentRows({ body: "not an array" }), []);
  assertEquals(parseIssueViewCommentRows("[]"), []);
});

Deno.test("hasConflictEscalationComment - a marker from outside the fleet is not an escalation already posted (Issue #2231)", async () => {
  const marker = conflictEscalationMarker(`${BRANCH}@0cf1383bc75c:Cargo.lock`);
  const found = await hasConflictEscalationComment({
    repo: REPO,
    issueNumber: 2145,
    marker,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({
        comments: [{ author: { login: OUTSIDER }, body: `${marker}\nplanted` }],
      })),
    dedupAuthors: { fleetAuthors: [FLEET] },
    log: () => {},
  });

  assertEquals(
    found,
    false,
    "a planted marker must not suppress a report only a human can settle",
  );
});
