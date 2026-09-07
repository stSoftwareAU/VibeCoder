/**
 * Milestone tracking issues must be identified by authenticated evidence, not
 * by their title (Issue #1246).
 *
 * A title is text the issue's own author chooses, so a title-shaped match is a
 * claim rather than evidence. Two milestone decisions act destructively on the
 * answer — a child classified as "our tracker" is subtracted from the
 * open-children count (a zero count merges the summary PR and deletes the
 * milestone branch), and a child classified as "our tracker" on the
 * premature/duplicate paths is closed with `gh issue close`.
 *
 * Every test here is stated in both directions: the guard must refuse the
 * unverifiable candidate *and* still admit the fleet's genuine tracker.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  checkAndHandleMilestoneCompletions,
  checkMilestoneComplete,
  getOpenMilestoneTrackers,
  hasExistingMilestoneTrackingIssue,
  type MilestoneCompletionDeps,
} from "../lib/milestone_completion.ts";
import { fetchAuthoritativeOpenChildren } from "../lib/milestone_open_children.ts";
import { fetchOpenMilestoneChildren } from "../lib/milestone_children_gate.ts";
import {
  hasMilestoneTrackingMarker,
  MILESTONE_TRACKING_MARKER,
  MILESTONE_TRACKING_MARKER_PREFIX,
  partitionMilestoneTrackers,
} from "../lib/milestone_tracker_identity.ts";

/** The fleet identity these tests state instead of writing a config file. */
const FLEET = ["stservice"] as const;
const VERIFICATION = { authorOptions: { fleetAuthors: FLEET } };

/** The title shape anybody may set on an issue they opened. */
const TRACKER_TITLE = "Merge milestone 'scan' to main";

/** A body carrying the marker the worker itself writes. */
const TRACKER_BODY = `${MILESTONE_TRACKING_MARKER}\n## Milestone completion`;

/** REST issue row (`repos/…/issues?milestone=…`). */
function restIssue(
  number: number,
  title: string,
  opts: { body?: string; login?: string } = {},
): Record<string, unknown> {
  return {
    number,
    title,
    body: opts.body ?? "",
    user: { login: opts.login ?? "mallory" },
  };
}

/** `gh issue list --json …` row as `fetchAllIssues` projects it. */
function listIssue(
  number: number,
  title: string,
  milestone: string,
  opts: { body?: string; login?: string } = {},
): Record<string, unknown> {
  return {
    number,
    title,
    body: opts.body ?? "",
    assignees: [],
    labels: [],
    createdAt: "2026-01-01T00:00:00Z",
    milestone: { title: milestone },
    author: { login: opts.login ?? "mallory" },
    url: "u",
  };
}

/** gh stub for the authoritative milestone + child-list pair. */
function makeAuthoritativeGh(
  openIssues: number,
  children: unknown[],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const key = args.join(" ");
    if (key.includes("/issues?")) {
      return Promise.resolve(JSON.stringify(children));
    }
    return Promise.resolve(JSON.stringify({ open_issues: openIssues }));
  };
}

// ---------------------------------------------------------------------------
// fetchAuthoritativeOpenChildren — the open-children count that gates the
// summary-PR merge and therefore the milestone-branch deletion.
// ---------------------------------------------------------------------------

Deno.test("fetchAuthoritativeOpenChildren - a tracking-shaped child without the fleet's evidence still counts as open (Issue #1246)", async () => {
  const result = await fetchAuthoritativeOpenChildren(
    "owner/repo",
    53,
    makeAuthoritativeGh(1, [restIssue(4001, TRACKER_TITLE)]),
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.trackers.length, 0);
  assertEquals(result.value.children.map((c) => c.number), [4001]);
  // Non-zero is the hard veto: no summary PR, no branch deletion.
  assertEquals(result.value.openCount, 1);
});

Deno.test("fetchAuthoritativeOpenChildren - the marker alone is not enough without a fleet author (Issue #1246)", async () => {
  const result = await fetchAuthoritativeOpenChildren(
    "owner/repo",
    53,
    makeAuthoritativeGh(1, [
      restIssue(4002, TRACKER_TITLE, { body: TRACKER_BODY, login: "mallory" }),
    ]),
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.trackers.length, 0);
  assertEquals(result.value.openCount, 1);
});

Deno.test("fetchAuthoritativeOpenChildren - the fleet's genuine tracker is still excluded (Issue #1246)", async () => {
  const result = await fetchAuthoritativeOpenChildren(
    "owner/repo",
    53,
    makeAuthoritativeGh(1, [
      restIssue(4003, TRACKER_TITLE, {
        body: TRACKER_BODY,
        login: "stservice",
      }),
    ]),
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.trackers.map((c) => c.number), [4003]);
  assertEquals(result.value.children.length, 0);
  assertEquals(result.value.openCount, 0);
});

Deno.test("fetchAuthoritativeOpenChildren - an unresolved fleet set excludes nothing (Issue #1246)", async () => {
  const result = await fetchAuthoritativeOpenChildren(
    "owner/repo",
    53,
    makeAuthoritativeGh(1, [
      restIssue(4004, TRACKER_TITLE, {
        body: TRACKER_BODY,
        login: "stservice",
      }),
    ]),
    { authorOptions: { fleetAuthors: [] } },
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.trackers.length, 0);
  assertEquals(result.value.openCount, 1);
});

// ---------------------------------------------------------------------------
// checkMilestoneComplete — the cached second opinion.
// ---------------------------------------------------------------------------

Deno.test("checkMilestoneComplete - a tracking-shaped child without the fleet's evidence keeps the milestone open (Issue #1246)", async () => {
  const ghFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--state open")) {
      return Promise.resolve(
        JSON.stringify([listIssue(4010, TRACKER_TITLE, "scan")]),
      );
    }
    return Promise.resolve("[]");
  };

  const result = await checkMilestoneComplete(
    "owner/repo",
    "scan",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, false);
});

Deno.test("checkMilestoneComplete - the fleet's genuine tracker never blocks its own milestone (Issue #3214, #1246)", async () => {
  const ghFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--state open")) {
      return Promise.resolve(
        JSON.stringify([
          listIssue(4011, TRACKER_TITLE, "scan", {
            body: TRACKER_BODY,
            login: "stservice",
          }),
        ]),
      );
    }
    return Promise.resolve("[]");
  };

  const result = await checkMilestoneComplete(
    "owner/repo",
    "scan",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, true);
});

// ---------------------------------------------------------------------------
// getOpenMilestoneTrackers — feeds `gh issue close`.
// ---------------------------------------------------------------------------

Deno.test("getOpenMilestoneTrackers - never nominates a child the fleet did not file (Issue #1246)", async () => {
  const ghFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--state open")) {
      return Promise.resolve(
        JSON.stringify([
          listIssue(4020, TRACKER_TITLE, "scan"),
          listIssue(4021, TRACKER_TITLE, "scan", { body: TRACKER_BODY }),
        ]),
      );
    }
    return Promise.resolve("[]");
  };

  assertEquals(
    await getOpenMilestoneTrackers(
      "owner/repo",
      "scan",
      ghFn,
      undefined,
      VERIFICATION,
    ),
    [],
  );
});

Deno.test("getOpenMilestoneTrackers - still nominates the fleet's own tracker (Issue #1246)", async () => {
  const ghFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--state open")) {
      return Promise.resolve(
        JSON.stringify([
          listIssue(4030, TRACKER_TITLE, "scan", {
            body: TRACKER_BODY,
            login: "stservice",
          }),
        ]),
      );
    }
    return Promise.resolve("[]");
  };

  assertEquals(
    await getOpenMilestoneTrackers(
      "owner/repo",
      "scan",
      ghFn,
      undefined,
      VERIFICATION,
    ),
    [4030],
  );
});

// ---------------------------------------------------------------------------
// hasExistingMilestoneTrackingIssue — the number the summary PR says it
// closes, and the number the completion path runs `gh issue close` on.
// ---------------------------------------------------------------------------

Deno.test("hasExistingMilestoneTrackingIssue - does not adopt a tracking-shaped issue the fleet did not file (Issue #1246)", async () => {
  const ghFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--state all")) {
      return Promise.resolve(
        JSON.stringify([{
          number: 4040,
          title: TRACKER_TITLE,
          body: "",
          author: { login: "mallory" },
        }]),
      );
    }
    return Promise.resolve("[]");
  };

  const result = await hasExistingMilestoneTrackingIssue(
    "owner/repo",
    "scan",
    7,
    "main",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, null);
});

Deno.test("hasExistingMilestoneTrackingIssue - still reuses the fleet's own tracker despite branch drift (Issue #2753, #1246)", async () => {
  const ghFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--state all")) {
      return Promise.resolve(
        JSON.stringify([
          {
            number: 4050,
            title: "Merge milestone 'scan' to Develop",
            body: TRACKER_BODY,
            author: { login: "stservice" },
          },
        ]),
      );
    }
    return Promise.resolve("[]");
  };

  const result = await hasExistingMilestoneTrackingIssue(
    "owner/repo",
    "scan",
    7,
    "main",
    ghFn,
    undefined,
    VERIFICATION,
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, 4050);
});

// ---------------------------------------------------------------------------
// fetchOpenMilestoneChildren — the merge gate that stands between the summary
// PR and the branch deletion.
// ---------------------------------------------------------------------------

Deno.test("fetchOpenMilestoneChildren - a tracking-shaped child without the fleet's evidence still blocks the merge (Issue #1246)", async () => {
  const ghFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return Promise.resolve(JSON.stringify([restIssue(4060, TRACKER_TITLE)]));
    }
    return Promise.resolve("[]");
  };

  const result = await fetchOpenMilestoneChildren({
    repo: "owner/repo",
    milestoneNumber: 53,
    ghCommandFn: ghFn,
    verification: VERIFICATION,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.map((c) => c.number), [4060]);
});

Deno.test("fetchOpenMilestoneChildren - the fleet's genuine tracker is still not a blocking child (Issue #1246)", async () => {
  const ghFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return Promise.resolve(
        JSON.stringify([
          restIssue(4070, TRACKER_TITLE, {
            body: TRACKER_BODY,
            login: "stservice",
          }),
        ]),
      );
    }
    return Promise.resolve("[]");
  };

  const result = await fetchOpenMilestoneChildren({
    repo: "owner/repo",
    milestoneNumber: 53,
    ghCommandFn: ghFn,
    verification: VERIFICATION,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.length, 0);
});

// ---------------------------------------------------------------------------
// End to end: the two acted-on consequences the finding names.
// ---------------------------------------------------------------------------

/** Build the gh stub for one milestone whose only open child is `child`. */
function makeCompletionGh(
  child: Record<string, unknown>,
  restChild: Record<string, unknown>,
  sink: { closed: number[]; createdPrs: number; createdIssues: number },
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return Promise.resolve(JSON.stringify([restChild]));
    }
    if (/api repos\/[^ ]+\/milestones\/\d+$/.test(key)) {
      return Promise.resolve(JSON.stringify({ open_issues: 1 }));
    }
    if (key.includes("api") && key.endsWith("/milestones")) {
      return Promise.resolve(JSON.stringify([{ title: "scan", number: 5 }]));
    }
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return Promise.resolve("main");
    }
    if (key.includes("issue list") && key.includes("--state open")) {
      return Promise.resolve(JSON.stringify([child]));
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return Promise.resolve(
        JSON.stringify([
          { number: 100, title: "did work", milestone: { title: "scan" } },
        ]),
      );
    }
    if (key.includes("issue create")) {
      sink.createdIssues++;
      return Promise.resolve("https://github.com/owner/repo/issues/999");
    }
    if (key.includes("pr create")) {
      sink.createdPrs++;
      return Promise.resolve("https://github.com/owner/repo/pull/999");
    }
    if (key.includes("issue close")) {
      const num = args.find((a) => /^\d+$/.test(a));
      if (num) sink.closed.push(Number(num));
      return Promise.resolve("");
    }
    return Promise.resolve("[]");
  };
}

function completionDeps(
  overrides: Partial<MilestoneCompletionDeps>,
): MilestoneCompletionDeps {
  return {
    repos: ["owner/repo"],
    ghCommandFn: () => Promise.resolve("[]"),
    log: () => {},
    authorOptions: { fleetAuthors: FLEET },
    ...overrides,
  };
}

Deno.test("checkAndHandleMilestoneCompletions - a retitled third-party issue is neither closed nor discounted (Issue #1246)", async () => {
  const sink = { closed: [] as number[], createdPrs: 0, createdIssues: 0 };
  const ghFn = makeCompletionGh(
    listIssue(4080, TRACKER_TITLE, "scan"),
    restIssue(4080, TRACKER_TITLE),
    sink,
  );

  const result = await checkAndHandleMilestoneCompletions(
    completionDeps({ ghCommandFn: ghFn }),
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.summaryPrsCreated, 0);
  // Nobody else's issue was closed, and no summary PR was raised — so the
  // milestone branch survives.
  assertEquals(sink.closed, []);
  assertEquals(sink.createdPrs, 0);
});

Deno.test("checkAndHandleMilestoneCompletions - the fleet's own premature tracker is still closed (Issue #3214, #1246)", async () => {
  const sink = { closed: [] as number[], createdPrs: 0, createdIssues: 0 };
  // The milestone carries a genuine tracker *and* real open work, so the
  // premature-tracker path applies: the tracker is closed, nothing is merged.
  const ghFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("issue list") && key.includes("--state open")) {
      return Promise.resolve(
        JSON.stringify([
          listIssue(4090, TRACKER_TITLE, "scan", {
            body: TRACKER_BODY,
            login: "stservice",
          }),
          listIssue(4091, "Real open work", "scan", { login: "alice" }),
        ]),
      );
    }
    return makeCompletionGh(
      listIssue(4090, TRACKER_TITLE, "scan"),
      restIssue(4090, TRACKER_TITLE),
      sink,
    )(args);
  };

  const result = await checkAndHandleMilestoneCompletions(
    completionDeps({ ghCommandFn: ghFn }),
  );
  assertEquals(result.ok, true);
  assertEquals(sink.closed, [4090]);
  assertEquals(sink.createdPrs, 0);
});

// ---------------------------------------------------------------------------
// partitionMilestoneTrackers — the shared decision, on its own.
// ---------------------------------------------------------------------------

Deno.test("partitionMilestoneTrackers - takes all three checks together (Issue #1246)", async () => {
  const rows = [
    { number: 1, title: "Ordinary work", body: "", author: "alice" },
    { number: 2, title: TRACKER_TITLE, body: "", author: "stservice" },
    { number: 3, title: TRACKER_TITLE, body: TRACKER_BODY, author: "mallory" },
    {
      number: 4,
      title: TRACKER_TITLE,
      body: TRACKER_BODY,
      author: "stservice",
    },
  ];
  const logs: string[] = [];
  const { trackers, others } = await partitionMilestoneTrackers(
    rows,
    "unit",
    { authorOptions: { fleetAuthors: FLEET }, log: (m) => logs.push(m) },
  );
  assertEquals(trackers.map((r) => r.number), [4]);
  // Order is preserved, and every unverifiable candidate stays a child.
  assertEquals(others.map((r) => r.number), [1, 2, 3]);
  assertEquals(
    logs.some((l) => l.includes("no tracking-issue body marker")),
    true,
  );
  assertEquals(logs.some((l) => l.includes("outside the fleet")), true);
});

Deno.test("partitionMilestoneTrackers - the marker prefix is a prefix of the marker (Issue #1246)", () => {
  assertEquals(
    MILESTONE_TRACKING_MARKER.startsWith(MILESTONE_TRACKING_MARKER_PREFIX),
    true,
  );
  assertEquals(MILESTONE_TRACKING_MARKER_PREFIX.length > 0, true);
  assertEquals(hasMilestoneTrackingMarker(TRACKER_BODY), true);
  assertEquals(hasMilestoneTrackingMarker(""), false);
  assertEquals(hasMilestoneTrackingMarker(null), false);
});
