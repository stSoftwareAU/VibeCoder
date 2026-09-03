/**
 * Issue #854: an escalated issue needs BOTH labels restored, and nothing said so.
 *
 * On escalation the worker adds `needs-human` and then strips the discovery
 * labels, so the issue is not merely parked — it has no label any discovery
 * tier looks for. `escalation_cleanup.ts` does that deliberately (Issue
 * #1487): `label_security` removes the worker's own `needs-human` from the
 * in-memory label list before `filterAndSort` sees it, so without the strip
 * the issue is re-picked immediately.
 *
 * The gap was that recovery then requires two actions and the issue said
 * nothing about the second. Observed on GRQ-23 on 2026-09-03 for #842:
 *
 * ```text
 * 00:44:50 labeled work-on
 * 00:56:57 labeled needs-human
 * 00:57:02 unlabeled work-on      <- silent
 * ```
 *
 * An operator who cleared `needs-human` — the only step any comment
 * mentioned — left the issue with `bug` alone, which is not a discovery
 * label. It would never have been claimed again, and nothing would have
 * reported that. Seven issues were in this state and I restored `work-on` to
 * each by hand.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { stripDiscoveryLabelsOnEscalation } from "../lib/escalation_cleanup.ts";

const CONFIG = {
  needsHumanLabel: "needs-human",
  workOnLabel: "work-on",
  issueLabels: ["top-priority", "low-priority"],
};

/** A gh stub returning `labels` for `issue view` and recording every call. */
function ghStub(labels: string[]) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(
        JSON.stringify({ labels: labels.map((name) => ({ name })) }),
      );
    }
    return Promise.resolve("");
  };
  return { fn, calls };
}

const commentBodies = (calls: string[][]): string[] =>
  calls
    .filter((a) => a[0] === "issue" && a[1] === "comment")
    .map((a) => a[a.indexOf("--body") + 1] ?? "");

Deno.test("escalation cleanup - reports which discovery labels it removed (Issue #854)", async () => {
  const { fn, calls } = ghStub(["needs-human", "work-on", "bug"]);
  const removed = await stripDiscoveryLabelsOnEscalation(
    "stSoftwareAU/VibeCoder",
    842,
    CONFIG,
    fn,
  );
  assertEquals(removed, ["work-on"]);
  assert(
    calls.some((a) => a.includes("--remove-label") && a.includes("work-on")),
    "work-on should still be stripped — #1487 depends on it",
  );
});

Deno.test("escalation cleanup - the resume note names BOTH labels to restore (Issue #854)", async () => {
  const { fn, calls } = ghStub(["needs-human", "work-on", "bug"]);
  await stripDiscoveryLabelsOnEscalation(
    "stSoftwareAU/VibeCoder",
    842,
    CONFIG,
    fn,
  );
  const bodies = commentBodies(calls);
  assertEquals(bodies.length, 1, "exactly one resume note");
  const body = bodies[0] ?? "";
  assert(body.includes("needs-human"), "must name the label to remove");
  assert(body.includes("work-on"), "must name the label to re-add");
  assert(
    body.includes("nothing will claim it"),
    "must say why clearing needs-human alone is not enough",
  );
});

Deno.test("escalation cleanup - a non-discovery label is left alone and unreported (Issue #854)", async () => {
  // `bug` is descriptive, not a discovery label: it is neither stripped nor
  // named as something to restore.
  const { fn, calls } = ghStub(["needs-human", "bug"]);
  const removed = await stripDiscoveryLabelsOnEscalation(
    "stSoftwareAU/VibeCoder",
    842,
    CONFIG,
    fn,
  );
  assertEquals(removed, []);
  assertEquals(
    commentBodies(calls).length,
    0,
    "nothing was removed, so there is nothing to resume",
  );
});

Deno.test("escalation cleanup - a second escalation does not repeat the note (Issue #854)", async () => {
  // The labels are already gone, so nothing is removed and no note is posted.
  // That is the dedup: the note follows the removal, not the escalation.
  const { fn, calls } = ghStub(["needs-human", "bug"]);
  await stripDiscoveryLabelsOnEscalation(
    "stSoftwareAU/VibeCoder",
    842,
    CONFIG,
    fn,
  );
  assertEquals(commentBodies(calls).length, 0);
});

Deno.test("escalation cleanup - without needs-human nothing is touched (Issue #854)", async () => {
  const { fn, calls } = ghStub(["work-on", "bug"]);
  const removed = await stripDiscoveryLabelsOnEscalation(
    "stSoftwareAU/VibeCoder",
    842,
    CONFIG,
    fn,
  );
  assertEquals(removed, []);
  assert(
    !calls.some((a) => a.includes("--remove-label")),
    "an unescalated issue keeps its discovery labels",
  );
  assertEquals(commentBodies(calls).length, 0);
});

Deno.test("escalation cleanup - every stripped tier is named in the note (Issue #854)", async () => {
  const { fn, calls } = ghStub([
    "needs-human",
    "work-on",
    "top-priority",
    "low-priority",
  ]);
  const removed = await stripDiscoveryLabelsOnEscalation(
    "stSoftwareAU/VibeCoder",
    842,
    CONFIG,
    fn,
  );
  assertEquals(removed.sort(), ["low-priority", "top-priority", "work-on"]);
  const body = commentBodies(calls)[0] ?? "";
  for (const label of ["work-on", "top-priority", "low-priority"]) {
    assert(body.includes(label), `the note must name ${label}`);
  }
});

Deno.test("escalation cleanup - a failed comment does not mask the outcome (Issue #854)", async () => {
  // The labels are already correct by this point; a comment failure must not
  // throw and lose the escalation result.
  const fn = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(
        JSON.stringify({
          labels: [{ name: "needs-human" }, { name: "work-on" }],
        }),
      );
    }
    if (args[0] === "issue" && args[1] === "comment") {
      return Promise.reject(new Error("gh comment failed"));
    }
    return Promise.resolve("");
  };
  const removed = await stripDiscoveryLabelsOnEscalation(
    "stSoftwareAU/VibeCoder",
    842,
    CONFIG,
    fn,
  );
  assertEquals(removed, ["work-on"], "the removal still stands");
});
