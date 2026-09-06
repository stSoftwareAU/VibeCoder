/**
 * Tests for escalate_as_work.ts — carrying a stuck PR into the work queue
 * instead of parking it behind `needs-human` (Issue #569).
 *
 * The operator's framing: *"`PR comment + needs-human label` is mostly a
 * failure in our automated Vibe Coder workflow."* A PR that is behind,
 * conflicting, red or unmergeable is a task, not a decision.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildWorkEscalationBody,
  DEFAULT_WORK_LABEL,
  escalateAsWork,
  workEscalationMarker,
  workEscalationTitle,
} from "../lib/escalate_as_work.ts";
import { isWorkerAppliableLabel } from "../lib/worker_label_guard.ts";

/** A label the worker IS allowed to apply, taken from the guard itself. */
const PERMITTED_LABEL = "escalated";

/** The fleet login every fixture issue is authored by. */
const FLEET_AUTHOR = "vibe-coder-bot";

const STALL = {
  repo: "org/repo",
  prNumber: 549,
  summary: "CI is red and no fix has landed",
  reason: "semgrep has been failing for 2 hours with no new push.",
  nextStep: "Push a fix or close the PR.",
};

/** A `gh` stub recording every call, answering the listing with `answer`. */
function fakeGh(answer = "[]") {
  const calls: string[][] = [];
  return {
    calls,
    gh: (args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(answer);
      }
      if (args[0] === "issue" && args[1] === "create") {
        return Promise.resolve("https://github.com/org/repo/issues/601\n");
      }
      return Promise.resolve("");
    },
  };
}

Deno.test("escalateAsWork - files the blockage beside the PR", async () => {
  const { gh, calls } = fakeGh();
  const result = await escalateAsWork(STALL, {
    gh,
    fleetAuthors: [FLEET_AUTHOR],
  });

  assert(result.ok);
  assertEquals(result.value.filed, true);
  assertEquals(result.value.issueNumber, 601);

  const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assert(create, "an issue must be filed");
  // Filed beside the PR, where the work is.
  assertEquals(create[create.indexOf("--repo") + 1], "org/repo");
});

// ===========================================================================
// Issue #1381 — the escalation must not self-apply a reserved queue label.
//
// The escalation is triggered by wall-clock stall thresholds on a PR, so an
// unprivileged contributor can cause it to run. Filing is still the right
// answer (a stuck PR nobody hears about is the worse failure), but the
// queue-priority label is the operator's to apply, and `escalateAsWork` must
// consult the same allowlist every other worker label mutation does rather
// than passing the label straight to `gh` on the creation call.
// ===========================================================================

Deno.test("escalateAsWork - the default work label is a reserved one the worker may not apply", () => {
  // Single source of truth: the guard decides, this test only records that
  // the default lands on the forbidden side of it.
  assertEquals(isWorkerAppliableLabel(DEFAULT_WORK_LABEL), false);
  assertEquals(isWorkerAppliableLabel(PERMITTED_LABEL), true);
});

Deno.test("escalateAsWork - a reserved work label is never self-applied on creation (Issue #1381)", async () => {
  const { gh, calls } = fakeGh();
  const result = await escalateAsWork(STALL, {
    gh,
    fleetAuthors: [FLEET_AUTHOR],
  });

  // The escalation still lands — the fail direction is towards filing.
  assert(result.ok);
  assertEquals(result.value.filed, true);

  const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assert(create, "the escalation must still be filed");
  assertEquals(
    create.includes("--label"),
    false,
    "the worker must not apply its own queue-priority label",
  );
  assertEquals(
    create.includes(DEFAULT_WORK_LABEL),
    false,
    "the reserved label must not reach gh by any argument",
  );
});

Deno.test("escalateAsWork - the withheld label is explained on the issue it files (Issue #1381)", async () => {
  const { gh, calls } = fakeGh();
  const result = await escalateAsWork(STALL, {
    gh,
    fleetAuthors: [FLEET_AUTHOR],
  });
  assert(result.ok);

  const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assert(create);
  const body = create[create.indexOf("--body") + 1] ?? "";
  assertStringIncludes(body, DEFAULT_WORK_LABEL);
  assertStringIncludes(body, "worker_label_guard.ts");
});

Deno.test("escalateAsWork - a permitted work label is still applied (Issue #1381)", async () => {
  const { gh, calls } = fakeGh();
  const result = await escalateAsWork(
    { ...STALL, workLabel: PERMITTED_LABEL },
    {
      gh,
      fleetAuthors: [FLEET_AUTHOR],
    },
  );

  assert(result.ok);
  const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assert(create);
  assertEquals(
    create[create.indexOf("--label") + 1],
    PERMITTED_LABEL,
    "the guard refuses reserved labels, not every label",
  );
  const body = create[create.indexOf("--body") + 1] ?? "";
  assertEquals(
    body.includes("worker_label_guard.ts"),
    false,
    "nothing was withheld, so nothing is explained away",
  );
});

Deno.test("escalateAsWork - dedup does not filter on a label the fleet never applies (Issue #1381)", async () => {
  // Listing `--label work-on` while never applying it would match nothing,
  // so every pass would re-file the same escalation.
  const existing = JSON.stringify([
    {
      number: 601,
      title: workEscalationTitle(STALL),
      author: { login: FLEET_AUTHOR },
    },
  ]);
  const { gh, calls } = fakeGh(existing);
  const result = await escalateAsWork(STALL, {
    gh,
    fleetAuthors: [FLEET_AUTHOR],
  });

  assert(result.ok);
  assertEquals(
    result.value.filed,
    false,
    "an ongoing blockage stays one issue",
  );

  const list = calls.find((c) => c[0] === "issue" && c[1] === "list");
  assert(list);
  assertEquals(
    list.includes(DEFAULT_WORK_LABEL),
    false,
    "the label belt is gone; the fleet-author braces still hold",
  );
});

Deno.test("escalateAsWork - a permitted label keeps its dedup listing filter (Issue #1381)", async () => {
  const escalation = { ...STALL, workLabel: PERMITTED_LABEL };
  const existing = JSON.stringify([
    {
      number: 601,
      title: workEscalationTitle(escalation),
      author: { login: FLEET_AUTHOR },
    },
  ]);
  const { gh, calls } = fakeGh(existing);
  const result = await escalateAsWork(escalation, {
    gh,
    fleetAuthors: [FLEET_AUTHOR],
  });

  assert(result.ok);
  assertEquals(result.value.filed, false);
  const list = calls.find((c) => c[0] === "issue" && c[1] === "list");
  assert(list);
  assertEquals(list[list.indexOf("--label") + 1], PERMITTED_LABEL);
});

Deno.test("escalateAsWork - an ongoing blockage updates its issue, never re-files", async () => {
  const existing = JSON.stringify([
    {
      number: 601,
      title: workEscalationTitle(STALL),
      author: { login: FLEET_AUTHOR },
    },
  ]);
  const { gh, calls } = fakeGh(existing);

  const result = await escalateAsWork(STALL, {
    gh,
    fleetAuthors: [FLEET_AUTHOR],
  });

  assert(result.ok);
  assertEquals(result.value.filed, false);
  assertEquals(result.value.issueNumber, 601);
  assertEquals(
    calls.some((c) => c[0] === "issue" && c[1] === "create"),
    false,
    "an ongoing blockage is one issue, commented on",
  );
  assert(calls.some((c) => c[0] === "issue" && c[1] === "comment"));
});

Deno.test("escalateAsWork - an unparseable listing files rather than losing the escalation", async () => {
  // A duplicate report is recoverable; a lost escalation is not.
  const { gh, calls } = fakeGh("not json at all");
  const result = await escalateAsWork(STALL, {
    gh,
    fleetAuthors: [FLEET_AUTHOR],
  });

  assert(result.ok);
  assertEquals(result.value.filed, true);
  assert(calls.some((c) => c[0] === "issue" && c[1] === "create"));
});

Deno.test("escalateAsWork - a gh failure is reported, never swallowed", async () => {
  const result = await escalateAsWork(STALL, {
    gh: () => Promise.reject(new Error("gh: rate limited")),
  });
  assert(!result.ok);
  assertStringIncludes(result.error.message, "rate limited");
});

Deno.test("buildWorkEscalationBody - carries the PR, the cause and what was tried", () => {
  const body = buildWorkEscalationBody({
    ...STALL,
    attempted: "The CI-fix lane spent 3 attempts on it.",
  });

  assertStringIncludes(body, workEscalationMarker("org/repo", 549));
  assertStringIncludes(body, "org/repo#549");
  assertStringIncludes(body, "semgrep has been failing");
  assertStringIncludes(body, "The CI-fix lane spent 3 attempts on it.");
  assertStringIncludes(body, "Push a fix or close the PR.");
  // States the policy, so the next reader knows why this is not needs-human.
  assertStringIncludes(body, "a task, not a decision");
});

Deno.test("workEscalationTitle - names the PR, so the dedup key is stable", () => {
  assertEquals(
    workEscalationTitle(STALL),
    "PR #549 cannot land: CI is red and no fix has landed",
  );
});
