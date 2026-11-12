/**
 * Base-refresh churn across competing callers (Issue #4943).
 *
 * Several lanes (branch-update loop, PR maintenance, babysitter, auto-merge
 * sweep) and several worker hosts ask requestReadyBranchUpdate for the same
 * strict base with no merge queue. Each call mints its own worker id, so they
 * are separate callers; they share one stateful fake GitHub, which is the only
 * place the base-refresh owner and the update-branch calls are observed.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Result } from "../types.ts";
import { requestReadyBranchUpdate } from "../lib/required_branch_checks_4613.ts";

import {
  AUTHOR,
  BASE,
  BASE_SHA,
  FakeFleet,
  headOf,
  movedHeadOf,
  nowSeconds,
  type Pr,
  readyPr,
  REPO,
} from "./support/base_refresh_fleet.ts";
const AUTHOR_OPTIONS = { fleetAuthors: [AUTHOR] };
const OWNER_REFUSAL =
  /^base refresh owned by owner\/repo#10 \(refresh-[0-9a-f-]{36}\)$/;
const noSleep = async () => {};
interface Logged {
  result: Result<void>;
  lines: string[];
}

/** Ask for a refresh, capturing the console.warn lines the call emits. */
async function askLogged(
  fleet: FakeFleet,
  prNumber: number,
  source: string,
): Promise<Logged> {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await requestReadyBranchUpdate(
      REPO,
      prNumber,
      fleet.gh,
      BASE,
      undefined,
      noSleep,
      AUTHOR_OPTIONS,
      source,
    );
    return {
      result,
      lines: lines.filter((line) => line.startsWith("[base-refresh]")),
    };
  } finally {
    console.warn = original;
  }
}

/** Assert exactly one bounded diagnostic line for the call, and return it. */
function oneLine(logged: Logged): string {
  assertEquals(logged.lines.length, 1, "one diagnostic line per call");
  const line = logged.lines[0]!;
  assert(line.length <= 600, `diagnostic line is ${line.length} characters`);
  return line;
}

function refusal(result: Result<void>): string {
  if (result.ok) throw new Error("expected the refresh to be refused");
  return result.error.message;
}

Deno.test("two ready behind PRs share one owner: #10 refreshes and #11 is refused for every competing caller", async () => {
  const fleet = new FakeFleet([readyPr(10), readyPr(11)]);
  const first = await askLogged(fleet, 10, "branch-update-loop");
  assertEquals(first.result.ok, true);
  const firstLine = oneLine(first);
  assertStringIncludes(firstLine, "source=branch-update-loop");
  assertStringIncludes(firstLine, "outcome=refresh-requested");
  assertStringIncludes(firstLine, "pr=#10");
  assertStringIncludes(
    firstLine,
    'reason="branch update requested from GitHub"',
  );

  for (const source of ["pr-maintenance", "babysitter-behind"]) {
    const refused = await askLogged(fleet, 11, source);
    assertEquals(OWNER_REFUSAL.test(refusal(refused.result)), true);
    const line = oneLine(refused);
    assertStringIncludes(line, `source=${source}`);
    assertStringIncludes(line, "outcome=refresh-skipped");
    assertStringIncludes(line, "pr=#11");
    assertStringIncludes(line, "owner=#10/refresh-");
  }

  assertEquals(fleet.prs.get(10)!.headRefOid, movedHeadOf(10));
  assertEquals(fleet.parents.get(movedHeadOf(10)), [headOf(10), BASE_SHA]);
  assertEquals(fleet.ownerPrs(), [10]);
});

const unready: Array<[string, Partial<Pr>]> = [
  ["(a) reviewDecision is REVIEW_REQUIRED", {
    reviewDecision: "REVIEW_REQUIRED",
  }],
  ["(b) no auto-merge request is set", { autoMergeRequest: null }],
  ["(c) the PR is a draft", { isDraft: true }],
  ["(d) mergeable is CONFLICTING, a genuine conflict left to the repair path", {
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
  }],
];

for (const [label, overrides] of unready) {
  Deno.test(`an unready behind-only PR never gets update-branch: ${label}`, async () => {
    const fleet = new FakeFleet([readyPr(10, overrides)]);
    const logged = await askLogged(fleet, 10, "branch-update-loop");
    assertEquals(
      refusal(logged.result),
      "PR no longer ready for a branch update",
    );
    assertStringIncludes(oneLine(logged), "outcome=refresh-skipped");
    assertEquals(fleet.parents.size, 0);
    assertEquals(fleet.ownerPrs(), []);
  });
}

Deno.test("failed required CI on the owner releases the base so the next ready PR refreshes", async () => {
  const fleet = new FakeFleet([readyPr(10), readyPr(11)]);
  assertEquals(
    (await askLogged(fleet, 10, "branch-update-loop")).result.ok,
    true,
  );
  fleet.gate.set(movedHeadOf(10), "failure");
  const next = await askLogged(fleet, 11, "auto-merge-sweep");
  assertEquals(next.result.ok, true);
  assertStringIncludes(oneLine(next), "outcome=refresh-requested");
  assertEquals(fleet.prs.get(10)!.headRefOid, movedHeadOf(10));
  assertEquals(fleet.prs.get(11)!.headRefOid, movedHeadOf(11));
  assertEquals(fleet.parents.get(movedHeadOf(11)), [headOf(11), BASE_SHA]);
  assertEquals(fleet.ownerPrs(), [11]);
});

Deno.test("a merged owner releases the base so the next ready PR refreshes", async () => {
  const fleet = new FakeFleet([readyPr(10), readyPr(11)]);
  assertEquals(
    (await askLogged(fleet, 10, "branch-update-loop")).result.ok,
    true,
  );
  fleet.prs.get(10)!.state = "MERGED";
  const next = await askLogged(fleet, 11, "auto-merge-sweep");
  assertEquals(next.result.ok, true);
  assertEquals(fleet.prs.get(10)!.headRefOid, movedHeadOf(10));
  assertEquals(fleet.prs.get(11)!.headRefOid, movedHeadOf(11));
  assertEquals(fleet.parents.get(movedHeadOf(11)), [headOf(11), BASE_SHA]);
  assertEquals(fleet.ownerPrs(), [11]);
});

Deno.test("a closed owner releases the base so the next ready PR refreshes", async () => {
  const fleet = new FakeFleet([readyPr(10), readyPr(11)]);
  assertEquals(
    (await askLogged(fleet, 10, "branch-update-loop")).result.ok,
    true,
  );
  fleet.prs.get(10)!.state = "CLOSED";
  const next = await askLogged(fleet, 11, "auto-merge-sweep");
  assertEquals(next.result.ok, true);
  assertEquals(fleet.prs.get(10)!.headRefOid, movedHeadOf(10));
  assertEquals(fleet.prs.get(11)!.headRefOid, movedHeadOf(11));
  assertEquals(fleet.parents.get(movedHeadOf(11)), [headOf(11), BASE_SHA]);
  assertEquals(fleet.ownerPrs(), [11]);
});

Deno.test("an owner record past its expiry is reconciled away so the next ready PR refreshes", async () => {
  const fleet = new FakeFleet([readyPr(10), readyPr(11)]);
  fleet.seedOwner(10, headOf(10), "crashed-host", nowSeconds() - 60);
  const next = await askLogged(fleet, 11, "babysitter-behind");
  assertEquals(next.result.ok, true);
  assertStringIncludes(oneLine(next), "outcome=refresh-requested");
  assertEquals(fleet.prs.get(10)!.headRefOid, headOf(10));
  assertEquals(fleet.prs.get(11)!.headRefOid, movedHeadOf(11));
  assertEquals(fleet.parents.get(movedHeadOf(11)), [headOf(11), BASE_SHA]);
  assertEquals(fleet.ownerPrs(), [11]);
});

Deno.test("an unexpired owner from a crashed worker still blocks the next ready PR", async () => {
  const fleet = new FakeFleet([readyPr(10), readyPr(11)]);
  fleet.seedOwner(10, headOf(10), "crashed-host", nowSeconds() + 3600);
  const next = await askLogged(fleet, 11, "pr-maintenance");
  assertEquals(
    refusal(next.result),
    "base refresh owned by owner/repo#10 (crashed-host)",
  );
  assertStringIncludes(oneLine(next), "owner=#10/crashed-host");
  assertEquals(fleet.parents.size, 0);
  assertEquals(fleet.ownerPrs(), [10]);
});

Deno.test("a newer push seen on the second live read refuses the refresh before any update-branch call", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  fleet.moveHead = { prNumber: 10, atLiveRead: 2, to: movedHeadOf(10) };
  const logged = await askLogged(fleet, 10, "branch-update-loop");
  assertEquals(
    refusal(logged.result),
    "PR changed while its required checks were read",
  );
  assertStringIncludes(oneLine(logged), "outcome=refresh-skipped");
  assertEquals(fleet.parents.size, 0);
  assertEquals(fleet.ownerPrs(), []);
});

Deno.test("a newer push seen on the third live read releases the just-acquired owner and sends no update-branch call", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  fleet.moveHead = { prNumber: 10, atLiveRead: 3, to: movedHeadOf(10) };
  const logged = await askLogged(fleet, 10, "branch-update-loop");
  assertEquals(
    refusal(logged.result),
    "required-check read failed: PR base or head changed before branch update",
  );
  assertEquals(fleet.parents.size, 0);
  assertEquals(fleet.ownerPrs(), []);
});

Deno.test("a merge-queue base refuses the behind-only refresh and writes no ownership comment", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  fleet.mergeQueue = true;
  const logged = await askLogged(fleet, 10, "auto-merge-sweep");
  assertEquals(
    refusal(logged.result),
    "merge-queue base is exempt from behind-only refresh",
  );
  assertStringIncludes(oneLine(logged), "outcome=refresh-skipped");
  assertEquals(fleet.parents.size, 0);
  assertEquals(fleet.ownerPrs(), []);
});

Deno.test("a non-strict base keeps the direct update-branch path with no ownership comment", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  fleet.strict = false;
  const logged = await askLogged(fleet, 10, "pr-maintenance");
  assertEquals(logged.result.ok, true);
  assertStringIncludes(oneLine(logged), "outcome=refresh-requested");
  assertEquals(fleet.prs.get(10)!.headRefOid, movedHeadOf(10));
  assertEquals(fleet.parents.get(movedHeadOf(10)), [headOf(10), BASE_SHA]);
  assertEquals(fleet.ownerPrs(), []);
});

Deno.test("a candidate with no required check on its head is refused before any update-branch call", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  fleet.gate.delete(headOf(10));
  const logged = await askLogged(fleet, 10, "branch-update-loop");
  assertEquals(
    refusal(logged.result),
    "required current-head checks have not passed",
  );
  assertStringIncludes(oneLine(logged), "outcome=refresh-skipped");
  assertEquals(fleet.parents.size, 0);
  assertEquals(fleet.ownerPrs(), []);
});

Deno.test("a candidate whose required check failed on its head is refused before any update-branch call", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  fleet.gate.set(headOf(10), "failure");
  const logged = await askLogged(fleet, 10, "branch-update-loop");
  assertEquals(
    refusal(logged.result),
    "required current-head checks have not passed",
  );
  assertEquals(fleet.parents.size, 0);
  assertEquals(fleet.ownerPrs(), []);
});

Deno.test("a PR that already owns the base is not blocked by its own record when it asks again", async () => {
  const fleet = new FakeFleet([readyPr(10)]);
  fleet.seedOwner(10, headOf(10), "selected-host", nowSeconds() + 3600);
  const again = await askLogged(fleet, 10, "auto-merge-sweep");
  assertEquals(again.result.ok, true);
  assertStringIncludes(oneLine(again), "outcome=refresh-requested");
  assertEquals(fleet.prs.get(10)!.headRefOid, movedHeadOf(10));
  assertEquals(fleet.parents.get(movedHeadOf(10)), [headOf(10), BASE_SHA]);
});
