/**
 * Where a milestone-sync escalation lands (Issue #1769).
 *
 * The old path had two destinations — a comment on the tracking issue the
 * milestone title leads with, or a freshly filed `needs-human` issue. Planning
 * closes the parent issue as soon as the sub-issues are filed, so nearly every
 * milestone took the second path and the fleet grew one diagnostic per branch
 * and per conflicting commit. These tests pin the replacement: the parent
 * planning issue (reopened when closed), else the oldest open child, else
 * nowhere — and never a new issue.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  decideMilestoneEscalationTarget,
  resolveMilestoneEscalationTarget,
} from "../lib/milestone_escalation_target.ts";

const REPO = "owner/repo";

/** A `gh` stub that records every argv and answers from a routing table. */
function ghStub(
  answers: (key: string) => string | Error,
): { gh: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    gh: (args: string[]): Promise<string> => {
      calls.push([...args]);
      const answer = answers(args.join(" "));
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
}

const createCalls = (calls: string[][]): string[][] =>
  calls.filter((c) => c[0] === "issue" && c[1] === "create");

// ---------------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------------

Deno.test("decideMilestoneEscalationTarget - the parent planning issue wins", () => {
  assertEquals(
    decideMilestoneEscalationTarget({
      parentIssue: 1730,
      children: [
        { number: 12, kind: "issue" },
        { number: 9, kind: "issue" },
      ],
    }),
    { kind: "parent", issue: 1730, reopened: false },
  );
});

Deno.test("decideMilestoneEscalationTarget - with no parent, the oldest open child carries it", () => {
  assertEquals(
    decideMilestoneEscalationTarget({
      parentIssue: null,
      children: [
        { number: 42, kind: "issue" },
        { number: 12, kind: "issue" },
        { number: 87, kind: "issue" },
      ],
    }),
    { kind: "child", issue: 12 },
  );
});

Deno.test("decideMilestoneEscalationTarget - a child PR is never the destination", () => {
  // Merging the summary PR deletes the milestone branch and auto-closes its
  // child PRs, which would bury the escalation in a closed PR.
  assertEquals(
    decideMilestoneEscalationTarget({
      parentIssue: null,
      children: [{ number: 3, kind: "pr" }, { number: 41, kind: "issue" }],
    }),
    { kind: "child", issue: 41 },
  );
  assertEquals(
    decideMilestoneEscalationTarget({
      parentIssue: null,
      children: [{ number: 3, kind: "pr" }],
    }),
    { kind: "none" },
  );
});

Deno.test("decideMilestoneEscalationTarget - no parent and no children is nowhere", () => {
  assertEquals(
    decideMilestoneEscalationTarget({ parentIssue: null, children: [] }),
    { kind: "none" },
  );
});

Deno.test("decideMilestoneEscalationTarget - a nonsense issue number is not a destination", () => {
  assertEquals(
    decideMilestoneEscalationTarget({
      parentIssue: 0,
      children: [{ number: -3, kind: "issue" }, { number: 0, kind: "issue" }],
    }),
    { kind: "none" },
  );
});

// ---------------------------------------------------------------------------
// The gh wrapper
// ---------------------------------------------------------------------------

Deno.test("resolveMilestoneEscalationTarget - an open parent is used as it stands", async () => {
  const { gh, calls } = ghStub((key) =>
    key.startsWith("issue view") ? "OPEN" : ""
  );

  const target = await resolveMilestoneEscalationTarget({
    repo: REPO,
    milestone: { title: "#1730 Resolve merge conflicts", number: 7 },
    ghCommandFn: gh,
    log: () => {},
  });

  assertEquals(target, { kind: "parent", issue: 1730, reopened: false });
  assertEquals(
    calls.filter((c) => c[1] === "reopen").length,
    0,
    "an open issue is not reopened",
  );
  assertEquals(createCalls(calls).length, 0);
});

Deno.test("resolveMilestoneEscalationTarget - a closed parent is reopened and labelled needs-human only", async () => {
  const { gh, calls } = ghStub((key) =>
    key.startsWith("issue view") ? "CLOSED" : ""
  );

  const target = await resolveMilestoneEscalationTarget({
    repo: REPO,
    milestone: { title: "#1730 Resolve merge conflicts", number: 7 },
    ghCommandFn: gh,
    log: () => {},
  });

  assertEquals(target, { kind: "parent", issue: 1730, reopened: true });
  assertEquals(
    calls.filter((c) => c[1] === "reopen").map((c) => c[2]),
    ["1730"],
    "reopened exactly once",
  );

  // No pickup label: reopening must not push the milestone's planning back
  // into the fleet's work queue.
  const labels = calls
    .filter((c) => c.includes("--add-label"))
    .map((c) => c[c.indexOf("--add-label") + 1]);
  assertEquals(labels, ["needs-human"]);
  assertEquals(createCalls(calls).length, 0);
});

Deno.test("resolveMilestoneEscalationTarget - a reopen that fails still targets the parent", async () => {
  const { gh, calls } = ghStub((key) => {
    if (key.startsWith("issue view")) return "CLOSED";
    if (key.startsWith("issue reopen")) return new Error("403 forbidden");
    return "";
  });
  const logs: string[] = [];

  const target = await resolveMilestoneEscalationTarget({
    repo: REPO,
    milestone: { title: "#1730 Resolve merge conflicts", number: 7 },
    ghCommandFn: gh,
    log: (m) => logs.push(m),
  });

  assertEquals(target, { kind: "parent", issue: 1730, reopened: false });
  assert(
    logs.some((l) => l.includes("403 forbidden")),
    `the refusal is said out loud; logs: ${JSON.stringify(logs)}`,
  );
  assertEquals(createCalls(calls).length, 0);
});

Deno.test("resolveMilestoneEscalationTarget - no parent falls through to the milestone's oldest open child", async () => {
  const { gh, calls } = ghStub((key) => {
    if (key.includes("issues?milestone=7")) {
      return JSON.stringify([
        { number: 88, title: "Later child" },
        // A milestone-assigned PR: lower-numbered, and still not a
        // destination — the milestone merge auto-closes it.
        { number: 9, title: "A child PR", pull_request: {} },
        { number: 41, title: "Earliest child" },
      ]);
    }
    return "";
  });

  const target = await resolveMilestoneEscalationTarget({
    repo: REPO,
    milestone: { title: "Resolve merge conflicts", number: 7 },
    ghCommandFn: gh,
    log: () => {},
    verification: { authorOptions: { fleetAuthors: ["vibe-coder"] } },
  });

  assertEquals(target, { kind: "child", issue: 41 });
  assertEquals(
    calls.filter((c) => c[0] === "pr" && c[1] === "list").length,
    0,
    "PRs based on the branch are not even asked for",
  );
  assertEquals(createCalls(calls).length, 0);
});

Deno.test("resolveMilestoneEscalationTarget - children that cannot be read leave nowhere to escalate", async () => {
  const { gh, calls } = ghStub((key) =>
    key.includes("issues?milestone=7")
      ? new Error("API rate limit exceeded")
      : ""
  );
  const logs: string[] = [];

  const target = await resolveMilestoneEscalationTarget({
    repo: REPO,
    milestone: { title: "Resolve merge conflicts", number: 7 },
    ghCommandFn: gh,
    log: (m) => logs.push(m),
  });

  assertEquals(target, { kind: "none" });
  assert(
    logs.some((l) => l.includes("rate limit")),
    `a degraded lookup says why; logs: ${JSON.stringify(logs)}`,
  );
  assertEquals(createCalls(calls).length, 0, "never files an issue");
});

Deno.test("resolveMilestoneEscalationTarget - a milestone with no open children is nowhere", async () => {
  const { gh, calls } = ghStub((key) =>
    key.includes("issues?milestone=7") ? "[]" : ""
  );

  const target = await resolveMilestoneEscalationTarget({
    repo: REPO,
    milestone: { title: "Resolve merge conflicts", number: 7 },
    ghCommandFn: gh,
    log: () => {},
  });

  assertEquals(target, { kind: "none" });
  assertEquals(createCalls(calls).length, 0);
});
