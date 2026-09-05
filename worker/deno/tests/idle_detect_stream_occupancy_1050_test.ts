/**
 * The audit's work-stream occupancy gate, over the scan's account set
 * (Issue #1050).
 *
 * The claim scan calls a work stream occupied when an issue in it is
 * assigned to ANY fleet account — `isMilestoneOccupied` resolves that set as
 * `workerUser` plus `.config.json`'s `allowed_authors`. The audit modelled
 * the same gate against `workerUser` alone, so a single issue assigned to
 * any other trusted account left the stream reading as free here and as
 * `milestone-occupied` to the scan.
 *
 * That is what stopped idle-task filing across all eighteen monitored
 * repositories from 2026-08-26: `stSoftwareAU/VibeCoder` held two dozen
 * unassigned `work-on` issues in the default-branch stream, one unlabelled
 * issue in that stream was assigned to a human in `allowed_authors`, the
 * scan refused every one of them, and the audit's `claimable_total=24`
 * suppressed the filer on work nothing could take.
 *
 * Both directions are pinned here. Widening occupancy too far would suppress
 * nothing and re-introduce the #2106 wrapper flooding, so an assignment to
 * an account the scan does NOT trust must leave the stream claimable, just
 * as it does for the scan.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  auditClaimableState,
  classifyIssues,
  pickDominantReason,
} from "../lib/idle_detect_diagnostics.ts";

const WORKER = "worker-bot";

/** Two unassigned `work-on` issues, plus whatever `extra` adds. */
function backlog(extra: Array<Record<string, unknown>> = []) {
  return [
    {
      number: 10,
      title: "Backlog item 10",
      labels: ["work-on"],
      assignees: [] as string[],
      milestone: "",
    },
    {
      number: 11,
      title: "Backlog item 11",
      labels: ["work-on"],
      assignees: [] as string[],
      milestone: "",
    },
    ...extra as Array<
      {
        number: number;
        title: string;
        labels: string[];
        assignees: string[];
        milestone: string;
      }
    >,
  ];
}

/** The issue that occupies the default-branch stream, assigned to `who`. */
function occupiedBy(who: string) {
  return {
    number: 99,
    title: "Already being worked on",
    labels: [] as string[],
    assignees: [who],
    milestone: "",
  };
}

function claimableNumbers(
  issues: ReturnType<typeof backlog>,
  allowedAuthors?: readonly string[],
): number[] {
  return classifyIssues(issues, {
    workerUser: WORKER,
    ...(allowedAuthors === undefined ? {} : { allowedAuthors }),
  })
    .filter((v) => v.claimable)
    .map((v) => v.number);
}

Deno.test(
  "classifyIssues - a stream held by another trusted account is occupied (Issue #1050)",
  () => {
    const verdicts = classifyIssues(backlog([occupiedBy("colleague")]), {
      workerUser: WORKER,
      allowedAuthors: ["colleague", WORKER],
    });
    assertEquals(verdicts.filter((v) => v.claimable).length, 0);
    for (const number of [10, 11]) {
      const v = verdicts.find((x) => x.number === number)!;
      assertEquals(v.excludedBy, "stream_occupied");
    }
    assertEquals(pickDominantReason(verdicts), "stream_occupied");
  },
);

Deno.test(
  "classifyIssues - the worker's own assignment still occupies the stream",
  () => {
    assertEquals(
      claimableNumbers(backlog([occupiedBy(WORKER)]), ["colleague", WORKER]),
      [],
    );
  },
);

Deno.test(
  "classifyIssues - an account the scan does not trust does not occupy (Issue #2106)",
  () => {
    // `isMilestoneOccupied` counts fleet accounts only, so a drive-by
    // assignment must not park the repository. Suppressing here would file
    // no idle task while the scan happily claimed the backlog.
    assertEquals(
      claimableNumbers(backlog([occupiedBy("passer-by")]), [
        "colleague",
        WORKER,
      ]),
      [10, 11],
    );
  },
);

Deno.test(
  "classifyIssues - occupancy is per work stream, not per repository",
  () => {
    const issues = [
      ...backlog([occupiedBy("colleague")]),
      {
        number: 30,
        title: "In a milestone of its own",
        labels: ["work-on"],
        assignees: [] as string[],
        milestone: "M1",
      },
    ];
    assertEquals(
      classifyIssues(issues, {
        workerUser: WORKER,
        allowedAuthors: ["colleague", WORKER],
      }).filter((v) => v.claimable).map((v) => v.number),
      [30],
    );
  },
);

Deno.test(
  "classifyIssues - omitting allowedAuthors preserves the pre-#1050 verdict",
  () => {
    // The option is what production must supply; without it the audit sees
    // only its own login, which is exactly the blind spot #1050 describes.
    assertEquals(claimableNumbers(backlog([occupiedBy("colleague")])), [
      10,
      11,
    ]);
  },
);

Deno.test(
  "classifyIssues - a milestone-tracking issue is not claimable (Issue #1050)",
  () => {
    const verdicts = classifyIssues([
      {
        number: 40,
        title: "Merge milestone 'M9' to main",
        labels: ["work-on"],
        assignees: [],
        milestone: "",
      },
      {
        number: 41,
        title: "Carries the marker instead",
        labels: ["work-on"],
        assignees: [],
        milestone: "",
        body:
          "<!-- milestone-tracking-issue — do not process as regular work -->",
      },
    ], { workerUser: WORKER });
    assertEquals(verdicts.filter((v) => v.claimable).length, 0);
    assertEquals(verdicts[0]!.excludedBy, "milestone_tracker");
    assertEquals(verdicts[1]!.excludedBy, "milestone_tracker");
    assertEquals(pickDominantReason(verdicts), "milestone_tracker");
  },
);

Deno.test(
  "classifyIssues - claimableLabels narrows the tier the question is asked about",
  () => {
    const issues = [
      {
        number: 50,
        title: "Real work",
        labels: ["work-on"],
        assignees: [],
        milestone: "",
      },
      {
        number: 51,
        title: "An idle-task wrapper",
        labels: ["idle-task"],
        assignees: [],
        milestone: "",
      },
    ];
    assertEquals(
      classifyIssues(issues, { workerUser: WORKER })
        .filter((v) => v.claimable).map((v) => v.number),
      [50, 51],
    );
    assertEquals(
      classifyIssues(issues, {
        workerUser: WORKER,
        claimableLabels: ["top-priority", "work-on", "low-priority"],
      }).filter((v) => v.claimable).map((v) => v.number),
      [50],
    );
  },
);

// ---------------------------------------------------------------------------
// End to end through the probe, which is what suppresses the filer
// ---------------------------------------------------------------------------

function ghReturning(
  issues: Array<Record<string, unknown>>,
): (args: string[]) => Promise<string> {
  return (_args: string[]) => Promise.resolve(JSON.stringify(issues));
}

/** The live fixture: 24 work-on issues behind one trusted assignment. */
function liveShape(withOccupyingAssignment: boolean) {
  const rows: Array<Record<string, unknown>> = [];
  for (let n = 100; n < 124; n++) {
    rows.push({
      number: n,
      title: `Backlog ${n}`,
      labels: [{ name: "work-on" }],
      assignees: [],
      milestone: null,
      body: "",
    });
  }
  if (withOccupyingAssignment) {
    rows.push({
      number: 99,
      title: "Already being worked on",
      labels: [],
      assignees: [{ login: "colleague" }],
      milestone: null,
      body: "",
    });
  }
  return rows;
}

Deno.test(
  "auditClaimableState - an occupied stream counts no claimable work (Issue #1050)",
  async () => {
    const lines: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/backlog"],
      workerUser: WORKER,
      allowedAuthors: ["colleague", WORKER],
      tick: 1,
      scanFoundClaimable: false,
      ghCommandFn: ghReturning(liveShape(true)),
      log: (l) => lines.push(l),
    });
    assertEquals(result.claimableTotal, 0);
    assertEquals(result.misClassification, false);
    assert(
      lines.some((l) => l.includes("reason=stream_occupied")),
      `expected a stream_occupied line; got:\n${lines.join("\n")}`,
    );
  },
);

Deno.test(
  "auditClaimableState - a free stream still counts every backlog issue (Issue #2806)",
  async () => {
    const result = await auditClaimableState({
      repos: ["org/backlog"],
      workerUser: WORKER,
      allowedAuthors: ["colleague", WORKER],
      tick: 1,
      scanFoundClaimable: false,
      ghCommandFn: ghReturning(liveShape(false)),
      log: () => {},
    });
    assertEquals(result.claimableTotal, 24);
    assertEquals(result.misClassification, true);
  },
);
