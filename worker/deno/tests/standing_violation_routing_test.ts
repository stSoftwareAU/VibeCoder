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
  const spaced = citedLocations("`" + "a ".repeat(900) + "x.ts:1`");
  assertEquals(spaced.length, 1);
  assert(spaced[0]!.path.endsWith("x.ts"));
});

Deno.test("citedLocations - a backticked path with spaces is reported whole (Issue #3613)", () => {
  assertEquals(
    citedLocations("`worker/deno/lib/run callback telemetry.ts:100-112`"),
    [{
      path: "worker/deno/lib/run callback telemetry.ts",
      start: 100,
      end: 112,
    }],
  );
});

Deno.test("citedLocations - separate backticked paths are not joined (Issue #3613)", () => {
  assertEquals(citedLocations("`a/foo.ts:1`, `b/bar.ts:2`"), [
    { path: "a/foo.ts", start: 1, end: 1 },
    { path: "b/bar.ts", start: 2, end: 2 },
  ]);
  assertEquals(citedLocations("`a/foo.ts:1, b/bar.ts:2`"), [
    { path: "a/foo.ts", start: 1, end: 1 },
    { path: "b/bar.ts", start: 2, end: 2 },
  ]);
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
  const head = new Set(["worker/deno/lib/foo.ts", "worker/deno/lib/other.ts"]);
  const run = (evidence: string, reason = "not fixed") =>
    ownLineStandingViolations(entries(viol(evidence, reason)), changed, head);

  assertEquals(run("`worker/deno/lib/foo.ts:12`").length, 1);
  assertEquals(run("`lib/foo.ts:12`").length, 1, "suffix path match");
  assertEquals(run("`worker/deno/lib/foo.ts:40`").length, 0, "outside ranges");
  assertEquals(run("`worker/deno/lib/other.ts:12`").length, 0, "not in diff");
  assertEquals(run("the whole module").length, 1, "fail closed");
  assertEquals(run("`worker/deno/lib/foo.ts:12`", "fixed in this diff"), []);
  assertEquals(
    run("`worker/deno/lib/missing.ts:12`").length,
    1,
    "unplaceable path fails closed",
  );
  assertEquals(run("`worker/deno/lib/foo.ts:40`").length, 0, "still outside");
  assertEquals(
    run("`lib/foo.ts:40`").length,
    0,
    "suffix of a diff file, outside ranges",
  );
  assertEquals(
    run("`lib/other.ts:12`").length,
    0,
    "suffix of an unchanged file at HEAD",
  );
});

Deno.test("ownLineStandingViolations - a path rewritten with spaces fails closed (Issue #3613)", () => {
  const changed = new Map([
    ["worker/deno/lib/run_callback_telemetry.ts", [[81, 114] as const]],
  ]);
  const head = new Set([
    "worker/deno/lib/run_callback_telemetry.ts",
    "worker/deno/lib/telemetry.ts",
  ]);
  const violations = ownLineStandingViolations(
    entries(
      viol(
        "`worker/deno/lib/run callback telemetry.ts:100-112`",
        "outstanding",
      ),
    ),
    changed,
    head,
  );
  assertEquals(violations.length, 1);
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
  const noCriteria = await findOwnLineStandingViolations({
    ...base,
    issueBody: "## Problem\n\nNo criteria.",
    prSummaryContent: standards(viol("`worker/deno/lib/foo.ts:12`", "stands")),
  });
  assertEquals(noCriteria.violations.length, 1, "no criteria still routes");
  assertEquals(
    noCriteria.violations[0]!.cited,
    [{ path: "worker/deno/lib/foo.ts", start: 12, end: 12 }],
  );
  assertEquals(noCriteria.notChecked, null);
  assertEquals(calls, calls2 + 1, "the diff is read once (Issue #3761)");
});

Deno.test("findOwnLineStandingViolations - an issue with no criteria heading still returns an own-line violation (Issue #3761)", async () => {
  const runGit = (_args: string[]) =>
    Promise.resolve({ code: 0, stdout: DIFF, stderr: "" });
  const base = {
    issueBody: "## Problem\n\nNo criteria heading.\n",
    base: "origin/main",
    runGit,
  };

  const refused = await findOwnLineStandingViolations({
    ...base,
    prSummaryContent: standards(
      viol("`worker/deno/lib/foo.ts:12`", "not fixed in this diff"),
    ),
  });
  assertEquals(refused.violations.length, 1);
  assertEquals(refused.notChecked, null);

  const settled = await findOwnLineStandingViolations({
    ...base,
    prSummaryContent: standards(
      viol("`worker/deno/lib/foo.ts:12`", "fixed in this diff"),
    ),
  });
  assertEquals(settled, { violations: [], notChecked: null });
});

type GitOut = { code: number; stdout: string; stderr: string };

/** Dispatches `ls-tree` to `ls`; every other call is the diff. */
function gitStub(ls: () => Promise<GitOut>) {
  const calls: string[][] = [];
  const runGit = (args: string[]) => {
    calls.push(args);
    if (args[0] === "ls-tree") return ls();
    return Promise.resolve({ code: 0, stdout: DIFF, stderr: "" });
  };
  return { calls, runGit };
}

Deno.test("findOwnLineStandingViolations - unplaceable path checks the HEAD listing (Issue #3613)", async () => {
  const ok = () =>
    Promise.resolve({
      code: 0,
      stdout: "worker/deno/lib/foo.ts\0worker/deno/lib/bar.ts\0",
      stderr: "",
    });
  const lsCount = (calls: string[][]) =>
    calls.filter((c) => c[0] === "ls-tree").length;
  const check = (evidence: string, ls: () => Promise<GitOut>) => {
    const git = gitStub(ls);
    return findOwnLineStandingViolations({
      issueBody: ISSUE,
      prSummaryContent: standards(viol(evidence, "stands")),
      base: "origin/main",
      runGit: git.runGit,
    }).then((result) => ({ result, git }));
  };

  const real = await check("`worker/deno/lib/bar.ts:5`", ok);
  assertEquals(real.result, { violations: [], notChecked: null });
  assertEquals(lsCount(real.git.calls), 1);
  assertEquals(real.git.calls.find((c) => c[0] === "ls-tree"), [
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    "HEAD",
  ]);

  const missing = await check("`worker/deno/lib/missing.ts:5`", ok);
  assertEquals(missing.result.violations.length, 1);
  assertEquals(missing.result.notChecked, null);

  const exited = await check(
    "`worker/deno/lib/missing.ts:5`",
    () =>
      Promise.resolve({
        code: 128,
        stdout: "",
        stderr: "fatal: not a tree object",
      }),
  );
  assertEquals(exited.result.violations.length, 1);
  assert(exited.result.notChecked?.includes("not a tree object"));

  const rejected = await check(
    "`worker/deno/lib/missing.ts:5`",
    () => Promise.reject(new Error("boom-ls")),
  );
  assertEquals(rejected.result.violations.length, 1);
  assert(rejected.result.notChecked?.includes("boom-ls"));

  const diffOnly = await check("`worker/deno/lib/foo.ts:99`", ok);
  assertEquals(diffOnly.result.violations, []);
  assertEquals(lsCount(diffOnly.git.calls), 0);

  const uncited = await check("the whole module", ok);
  assertEquals(uncited.result.violations.length, 1);
  assertEquals(uncited.result.notChecked, null);
  assertEquals(lsCount(uncited.git.calls), 0);
});
