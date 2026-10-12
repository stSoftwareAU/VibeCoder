/**
 * Issue #3382: standing violations on the branch's own lines are routed to a
 * code-capable turn. Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  isStandingViolation,
  parseStandardsEntries,
} from "../lib/independent_review_gate.ts";
import {
  citedLocations,
  findOwnLineStandingViolations,
  ownLineStandingViolations,
} from "../lib/standing_violation_routing.ts";

const MARKER =
  '<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->';

function standards(...items: string[]): string {
  return ["## Standards Review", "", MARKER, "", ...items].join("\n");
}

function entries(...items: string[]) {
  return parseStandardsEntries(standards(...items));
}

const ISSUE = "## Acceptance criteria\n\n- [ ] Do the thing.\n";

const DIFF = [
  "diff --git a/worker/deno/lib/foo.ts b/worker/deno/lib/foo.ts",
  "--- a/worker/deno/lib/foo.ts",
  "+++ b/worker/deno/lib/foo.ts",
  "@@ -10,0 +11,3 @@",
  "+a",
  "+b",
  "+c",
  "",
].join("\n");

const viol = (evidence: string, reason?: string) =>
  `- **violation** — bad thing — evidence: ${evidence}` +
  (reason === undefined ? "" : ` — reason: ${reason}`);

Deno.test("citedLocations - backticked path:line", () => {
  assertEquals(citedLocations("`worker/deno/lib/foo.ts:321`"), [
    { path: "worker/deno/lib/foo.ts", start: 321, end: 321 },
  ]);
});

Deno.test("citedLocations - a range", () => {
  assertEquals(citedLocations("container/toolchains/floci.sh:39-42"), [
    { path: "container/toolchains/floci.sh", start: 39, end: 42 },
  ]);
});

Deno.test("citedLocations - text after reason is ignored", () => {
  assertEquals(
    citedLocations("a/foo.ts:3 — reason: not fixed, see bar.ts:9"),
    [{ path: "a/foo.ts", start: 3, end: 3 }],
  );
});

Deno.test("citedLocations - no path:line gives []", () => {
  assertEquals(citedLocations("the whole module, see note: 5"), []);
});

Deno.test("citedLocations - hostile input returns promptly", () => {
  assertEquals(citedLocations("a".repeat(50_000) + "!"), []);
  assertEquals(citedLocations("/".repeat(50_000) + ":x"), []);
});

Deno.test("isStandingViolation - fixed, filed, unsettled, absent, clean", () => {
  const [fixed, filed, unsettled, none, clean] = entries(
    viol("a.ts:1", "fixed in this diff"),
    viol("a.ts:1", "pre-existing, filed #12"),
    viol("a.ts:1", "not fixed — this turn may not change code"),
    viol("a.ts:1"),
    "- **clean** — all good",
  ).map(isStandingViolation);
  assertEquals([fixed, filed, unsettled, none, clean], [
    false,
    false,
    true,
    true,
    false,
  ]);
});

Deno.test("ownLineStandingViolations - placement rules", () => {
  const changed = new Map([["worker/deno/lib/foo.ts", [[11, 13] as const]]]);
  const run = (evidence: string, reason = "not fixed") =>
    ownLineStandingViolations(entries(viol(evidence, reason)), changed);

  assertEquals(run("`worker/deno/lib/foo.ts:12`").length, 1);
  assertEquals(run("`lib/foo.ts:12`").length, 1, "suffix path match");
  assertEquals(run("`worker/deno/lib/foo.ts:40`").length, 0, "outside ranges");
  assertEquals(run("`worker/deno/lib/other.ts:12`").length, 0, "not in diff");
  assertEquals(run("the whole module").length, 1, "fail closed");
  assertEquals(run("`worker/deno/lib/foo.ts:12`", "fixed in this diff"), []);
});

Deno.test("findOwnLineStandingViolations - routing against a diff", async () => {
  let calls = 0;
  const runGit = (_args: string[]) => {
    calls++;
    return Promise.resolve({ code: 0, stdout: DIFF, stderr: "" });
  };
  const base = { issueBody: ISSUE, base: "origin/main", runGit };

  const none = await findOwnLineStandingViolations({
    ...base,
    prSummaryContent: standards(viol("a.ts:1", "fixed in this diff")),
  });
  assertEquals(none, { violations: [], notChecked: null });
  assertEquals(calls, 0);

  const own = await findOwnLineStandingViolations({
    ...base,
    prSummaryContent: standards(
      viol("`worker/deno/lib/foo.ts:12`", "stands"),
      viol("`worker/deno/lib/foo.ts:99`", "stands"),
    ),
  });
  assertEquals(calls, 1);
  assertEquals(own.notChecked, null);
  assertEquals(own.violations.length, 1);

  const noBase = await findOwnLineStandingViolations({
    ...base,
    base: null,
    prSummaryContent: standards(viol("`worker/deno/lib/foo.ts:99`", "stands")),
  });
  assertEquals(noBase.violations.length, 1);
  assert(noBase.notChecked !== null);
  assertEquals(calls, 1);

  const thrown = await findOwnLineStandingViolations({
    ...base,
    runGit: () => Promise.reject(new Error("boom")),
    prSummaryContent: standards(viol("`worker/deno/lib/foo.ts:99`", "stands")),
  });
  assertEquals(thrown.violations.length, 1);
  assert(thrown.notChecked?.includes("boom"));

  const failed = await findOwnLineStandingViolations({
    ...base,
    runGit: () => Promise.resolve({ code: 128, stdout: "", stderr: "bad" }),
    prSummaryContent: standards(viol("`worker/deno/lib/foo.ts:99`", "stands")),
  });
  assertEquals(failed.violations.length, 1);
  assert(failed.notChecked?.includes("128"));

  const calls2 = calls;
  const inapplicable = await findOwnLineStandingViolations({
    ...base,
    issueBody: "## Problem\n\nNo criteria.",
    prSummaryContent: standards(viol("`worker/deno/lib/foo.ts:12`", "stands")),
  });
  assertEquals(inapplicable, { violations: [], notChecked: null });
  assertEquals(calls, calls2);
});
