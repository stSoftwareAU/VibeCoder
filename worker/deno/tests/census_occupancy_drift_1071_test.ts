/**
 * The census and the selector must agree about an occupied work stream
 * (Issue #1071).
 *
 * "Is this work stream occupied?" is one question, and this repository has
 * now answered it in several places at once five times: #2751 (the backlog
 * signal counted work the selector permanently skips), #753 (the census
 * matched only `workerUser` while the selector matched every trusted
 * account), #655 (the audit counted issues the run itself was holding),
 * #1064 (the selector moved occupancy off the permission list and onto the
 * fleet identity) and #1050 (the audit and the selector disagreeing about
 * claimable work). Each was found in the field, never by a test.
 *
 * Since #1071 there is exactly one implementation — `occupiedStreamsFor`
 * calls `isMilestoneOccupied` — and this test is what keeps it that way. It
 * does not assert either function in isolation: it builds one issue set,
 * asks both, and asserts the verdicts are identical, across every axis the
 * two have drifted on and the two the rule is defined over:
 *
 *   - a human assignee (must NOT occupy — scheduling exists only between
 *     Vibe Coders),
 *   - a sibling Vibe Coder's assignee (must occupy — this is the
 *     duplicate-PR guard of #3095, and fixing *who* the rule applies to must
 *     not weaken *that* it applies),
 *   - this host's own assignee (must occupy),
 *   - an account nobody operates (must not occupy),
 *   - unassigned issues,
 *   - a real milestone, and the `""` default-branch stream.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildIdleDecisionCensus,
  type CensusIssue,
} from "../lib/idle_decision_census.ts";
import {
  type FilterableIssue,
  isMilestoneOccupied,
} from "../lib/issue_filter.ts";

const WORKER = "vibe-bot";
/** A sibling Vibe Coder: an account the fleet operates. */
const SIBLING = "sibling-bot";
/** A trusted human: `allowed_authors`, never the occupancy set (#1064). */
const HUMAN = "human-dev";
/** Nobody's account. */
const STRANGER = "passer-by";
/** The set both definitions are given — the fleet identity, and only it. */
const PUSH_CAPABLE = [SIBLING, WORKER];

const REPO = "org/drift";

/** One open issue, in the shape both definitions read. */
interface Row {
  number: number;
  labels: string[];
  assignees: string[];
  /** Milestone title, or "" for the default-branch work stream. */
  milestone: string;
}

function toCensusIssue(row: Row): CensusIssue {
  return {
    number: row.number,
    labels: row.labels,
    assignees: row.assignees,
    milestone: row.milestone,
    body: "",
  };
}

function toFilterable(row: Row): FilterableIssue {
  return {
    number: row.number,
    title: `Issue ${row.number}`,
    url: `https://github.com/${REPO}/issues/${row.number}`,
    author: "alice",
    assignees: row.assignees,
    labels: row.labels,
    createdAt: "2026-01-01T00:00:00Z",
    milestone: row.milestone,
  };
}

/**
 * The streams the **selector** considers occupied, straight from
 * `isMilestoneOccupied` — one question per distinct stream in the set.
 */
function selectorOccupied(rows: Row[]): string[] {
  const all = rows.map(toFilterable);
  const occupied: string[] = [];
  for (const stream of new Set(rows.map((r) => r.milestone))) {
    if (isMilestoneOccupied(all, stream, WORKER, [...PUSH_CAPABLE])) {
      occupied.push(stream);
    }
  }
  return occupied.sort();
}

/** Build the census over `rows`, with the fleet set both definitions share. */
function buildCensus(rows: Row[], pushCapableAuthors = PUSH_CAPABLE) {
  return buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: WORKER,
    pushCapableAuthors,
    repos: [{
      repo: REPO,
      monitored: true,
      scannedThisCycle: true,
      nice: 0,
      issues: rows.map(toCensusIssue),
    }],
  });
}

/**
 * How many issues the census attributes to the occupancy gate — its
 * published `stream_occupied=<n>` figure, which is what an operator reads
 * when asking why a repository was passed over.
 *
 * Note this is deliberately **not** `RepoCensusEntry.occupiedStreams`: that
 * field carries `checkRepoAvailability`'s separate "has this stream any
 * unassigned work for me" verdict, a different question the census reports
 * beside this one. Comparing the wrong one would make this test pass while
 * the gate under test drifted.
 */
function censusStreamOccupied(rows: Row[]): number {
  return buildCensus(rows).perRepo[0]!.streamOccupied;
}

/**
 * The same figure derived from the **selector's** verdict: every issue the
 * census would otherwise count as claimable, whose work stream
 * `isMilestoneOccupied` calls occupied. If the two definitions agree, these
 * two numbers agree for every issue set.
 */
function expectedFromSelector(rows: Row[], occupied: string[]): number {
  const streams = new Set(occupied);
  return rows.filter((r) =>
    r.assignees.length === 0 && r.labels.includes("work-on") &&
    streams.has(r.milestone)
  ).length;
}

/**
 * Assert both definitions reach the same verdict on `rows`, and that it is
 * the verdict `expected` names — so a fixture cannot pass by both sides
 * being wrong in the same direction.
 */
function assertAgree(rows: Row[], expected: string[], what: string): void {
  const selector = selectorOccupied(rows);
  assertEquals(
    selector,
    [...expected].sort(),
    `${what}: the selector's verdict changed`,
  );
  const census = censusStreamOccupied(rows);
  const fromSelector = expectedFromSelector(rows, selector);
  assertEquals(
    census,
    fromSelector,
    `${what}: the census and the selector disagree — the census attributed ` +
      `${census} issues to stream_occupied, the selector's occupied streams ` +
      `[${selector}] account for ${fromSelector}`,
  );
}

Deno.test(
  "occupancy drift - a human's assignment occupies nothing, in both (Issue #1064)",
  () => {
    assertAgree(
      [
        { number: 10, labels: ["work-on"], assignees: [HUMAN], milestone: "" },
        { number: 11, labels: ["work-on"], assignees: [], milestone: "" },
      ],
      [],
      "human assignee in the default-branch stream",
    );
  },
);

Deno.test(
  "occupancy drift - a sibling Vibe Coder's assignment occupies, in both (Issue #3095)",
  () => {
    // The duplicate-PR guard: another host's claim must still park the
    // stream, or two hosts start the same work stream and merge hell follows.
    assertAgree(
      [
        {
          number: 20,
          labels: ["work-on"],
          assignees: [SIBLING],
          milestone: "",
        },
        { number: 21, labels: ["work-on"], assignees: [], milestone: "" },
      ],
      [""],
      "sibling assignee in the default-branch stream",
    );
  },
);

Deno.test(
  "occupancy drift - this host's own assignment occupies, in both",
  () => {
    assertAgree(
      [
        { number: 30, labels: ["work-on"], assignees: [WORKER], milestone: "" },
        { number: 31, labels: ["work-on"], assignees: [], milestone: "" },
      ],
      [""],
      "own-host assignee in the default-branch stream",
    );
  },
);

Deno.test(
  "occupancy drift - an account the fleet does not operate occupies nothing, in both",
  () => {
    assertAgree(
      [
        {
          number: 40,
          labels: ["work-on"],
          assignees: [STRANGER],
          milestone: "",
        },
        { number: 41, labels: ["work-on"], assignees: [], milestone: "" },
      ],
      [],
      "stranger assignee in the default-branch stream",
    );
  },
);

Deno.test(
  "occupancy drift - an entirely unassigned repo occupies nothing, in both",
  () => {
    assertAgree(
      [
        { number: 50, labels: ["work-on"], assignees: [], milestone: "" },
        { number: 51, labels: ["work-on"], assignees: [], milestone: "v2" },
      ],
      [],
      "no assignees anywhere",
    );
  },
);

Deno.test(
  "occupancy drift - streams are independent, in both",
  () => {
    // A sibling holds `v2`; the default-branch stream and `v3` stay free.
    // Every axis at once, so a definition that collapses streams together —
    // or that reads the wrong account set for one of them — is caught.
    assertAgree(
      [
        {
          number: 60,
          labels: ["work-on"],
          assignees: [SIBLING],
          milestone: "v2",
        },
        { number: 61, labels: ["work-on"], assignees: [], milestone: "v2" },
        {
          number: 62,
          labels: ["work-on"],
          assignees: [HUMAN],
          milestone: "v3",
        },
        { number: 63, labels: ["work-on"], assignees: [], milestone: "v3" },
        { number: 64, labels: ["work-on"], assignees: [], milestone: "" },
      ],
      ["v2"],
      "one occupied milestone beside a human-held one and a free stream",
    );
  },
);

Deno.test(
  "occupancy drift - the whole fixture set, one comparison (Issue #1071)",
  () => {
    // Every account kind and both stream kinds in a single issue set: the
    // shape a per-function test would not have caught, because each function
    // was self-consistent while the two disagreed.
    const rows: Row[] = [
      { number: 70, labels: ["work-on"], assignees: [HUMAN], milestone: "" },
      { number: 71, labels: ["work-on"], assignees: [STRANGER], milestone: "" },
      { number: 72, labels: ["work-on"], assignees: [], milestone: "" },
      {
        number: 73,
        labels: ["work-on"],
        assignees: [SIBLING],
        milestone: "v2",
      },
      { number: 74, labels: ["work-on"], assignees: [], milestone: "v2" },
      { number: 75, labels: ["work-on"], assignees: [WORKER], milestone: "v3" },
      { number: 76, labels: ["work-on"], assignees: [], milestone: "v3" },
      { number: 77, labels: ["work-on"], assignees: [], milestone: "v4" },
    ];
    assertAgree(rows, ["v2", "v3"], "every account kind in one set");
  },
);

Deno.test(
  "occupancy drift - the census does not keep its own account list (Issue #1071)",
  () => {
    // Delegation, asserted through behaviour rather than by reading the
    // source: hand both definitions a set that occupies nothing and a set
    // that occupies everything, and the census must move with the selector
    // both times. A census with its own hard-coded notion of who counts
    // would hold one of these fixed.
    const rows: Row[] = [
      { number: 80, labels: ["work-on"], assignees: [SIBLING], milestone: "" },
      { number: 81, labels: ["work-on"], assignees: [], milestone: "" },
    ];
    const withSibling = buildCensus(rows, [SIBLING]);
    const withoutSibling = buildCensus(rows, []);

    assertEquals(withSibling.perRepo[0]!.streamOccupied, 1);
    assertEquals(withoutSibling.perRepo[0]!.streamOccupied, 0);
    // And the selector says exactly the same about the same two sets.
    const all = rows.map(toFilterable);
    assert(isMilestoneOccupied(all, "", WORKER, [SIBLING]));
    assert(!isMilestoneOccupied(all, "", WORKER, []));
  },
);
