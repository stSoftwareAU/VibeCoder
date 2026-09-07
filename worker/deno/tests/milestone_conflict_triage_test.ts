/**
 * Triage of a conflicted `main` → `milestone/*` sync merge (Issue #1559).
 *
 * The three patterns the issue names are exercised here against real content:
 * the same fix landed twice, one side that subsumes the other, and two rival
 * designs that only a human can choose between. The coverage rule is pinned
 * too — a conflicted test file is never resolved by taking a side that drops
 * cases.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  analyseConflictedFile,
  buildConflictAnalysisComment,
  buildResolutionCommitMessage,
  type ConflictedFile,
  extractExports,
  extractTestNames,
  isLineSuperset,
  isTestPath,
  parseFixReferences,
  planConflictResolution,
} from "../lib/milestone_conflict_triage.ts";

function file(over: Partial<ConflictedFile> = {}): ConflictedFile {
  return {
    path: "lib/spawn.ts",
    ours: "export const a = 1;\n",
    theirs: "export const a = 2;\n",
    oursFixes: [],
    theirsFixes: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Parsing primitives
// ---------------------------------------------------------------------------

Deno.test("parseFixReferences - reads closing keywords and this fleet's own '(Issue #N)' stamp", () => {
  assertEquals(parseFixReferences("Fixes #1270"), [1270]);
  assertEquals(parseFixReferences("closes #12 and Resolved #13"), [12, 13]);
  assertEquals(
    parseFixReferences("Bound the fallback (Issue #1264)"),
    [1264],
  );
  assertEquals(parseFixReferences("Refs #99 — mentions only"), []);
  assertEquals(parseFixReferences("no references at all"), []);
});

Deno.test("extractTestNames - finds Deno.test names in every shape the repo uses", () => {
  const source = `
    Deno.test("alpha runs", () => {});
    Deno.test(
      "beta runs",
      async () => {},
    );
    Deno.test({ name: "gamma runs", fn: () => {} });
  `;
  assertEquals(extractTestNames(source), [
    "alpha runs",
    "beta runs",
    "gamma runs",
  ]);
});

Deno.test("extractExports - names the exported symbols on a side", () => {
  const source = `
    export interface Rules { a: number }
    export function scanContentForVariableBinarySpawn(x: string) {}
    export const LIMIT = 3;
    function private_() {}
  `;
  assertEquals(extractExports(source), [
    "LIMIT",
    "Rules",
    "scanContentForVariableBinarySpawn",
  ]);
});

Deno.test("isTestPath - test files are recognised by directory and by suffix", () => {
  assert(isTestPath("worker/deno/tests/spawn_test.ts"));
  assert(isTestPath("src/spawn.test.ts"));
  assert(isTestPath("src/spawn.spec.ts"));
  assert(!isTestPath("worker/deno/lib/spawn.ts"));
  assert(!isTestPath("docs/testing.md"));
});

Deno.test("isLineSuperset - true only when every line of the smaller side survives", () => {
  assert(isLineSuperset("a\nb\nc\n", "a\nc\n"));
  assert(!isLineSuperset("a\nb\n", "a\nz\n"));
  // Duplicates are counted, not collapsed.
  assert(!isLineSuperset("a\nb\n", "a\na\n"));
});

// ---------------------------------------------------------------------------
// Case 1 — the same fix landed twice
// ---------------------------------------------------------------------------

Deno.test("planConflictResolution - case 1: both sides fix the same issue, the side with the superset tests wins", () => {
  const plan = planConflictResolution([
    file({
      path: "lib/spawn.ts",
      ours: "export const impl = 'branch';\n",
      theirs: "export const impl = 'main';\n",
      oursFixes: [1270],
      theirsFixes: [1270],
    }),
    file({
      path: "tests/spawn_test.ts",
      ours: 'Deno.test("one", () => {});\nDeno.test("two", () => {});\n',
      theirs: 'Deno.test("one", () => {});\n',
      oursFixes: [1270],
      theirsFixes: [1270],
    }),
  ]);

  assertEquals(plan.escalations.length, 0, "case 1 resolves without a human");
  assertEquals(plan.testsSuperset, "ours");
  const impl = plan.decisions.find((d) => d.path === "lib/spawn.ts");
  assertEquals(impl?.case, "duplicate-fix");
  assertEquals(impl?.side, "ours");
  assertStringIncludes(impl?.reason ?? "", "#1270");
  const tests = plan.decisions.find((d) => d.path === "tests/spawn_test.ts");
  assertEquals(tests?.side, "ours", "the side carrying both cases is kept");
});

Deno.test("planConflictResolution - a duplicate fix whose test coverage is incomparable escalates", () => {
  const plan = planConflictResolution([
    file({
      path: "lib/spawn.ts",
      ours: "export const impl = 'branch';\n",
      theirs: "export const impl = 'main';\n",
      oursFixes: [1270],
      theirsFixes: [1270],
    }),
    file({
      path: "tests/spawn_test.ts",
      ours: 'Deno.test("only ours", () => {});\n',
      theirs: 'Deno.test("only theirs", () => {});\n',
      oursFixes: [1270],
      theirsFixes: [1270],
    }),
  ]);

  assertEquals(plan.testsSuperset, null);
  assertEquals(plan.escalations.length, 2);
  assert(plan.escalations.every((d) => d.side === null));
});

// ---------------------------------------------------------------------------
// Case 2 — one side subsumes the other
// ---------------------------------------------------------------------------

Deno.test("planConflictResolution - case 2: the side that keeps every line of the other is taken", () => {
  const plan = planConflictResolution([
    file({
      path: "lib/spawn_runner.ts",
      ours: "const a = 1;\n",
      theirs: "const a = 1;\nconst bounded = true;\n",
    }),
  ]);

  const decision = plan.decisions[0];
  assertEquals(decision?.case, "superset");
  assertEquals(decision?.side, "theirs");
  assertEquals(plan.escalations.length, 0);
  assertStringIncludes(decision?.reason ?? "", "every line");
});

// ---------------------------------------------------------------------------
// Case 3 — rival designs
// ---------------------------------------------------------------------------

Deno.test("planConflictResolution - case 3: two designs for the same problem reach a human", () => {
  const plan = planConflictResolution([
    file({
      path: "lib/scan.ts",
      ours: "export class IndirectSpawnRules {}\n",
      theirs: "export function scanContentForVariableBinarySpawn() {}\n",
      oursFixes: [1378],
      theirsFixes: [1227],
    }),
  ]);

  assertEquals(plan.resolved.length, 0);
  assertEquals(plan.escalations.length, 1);
  assertEquals(plan.escalations[0]?.case, "rival-designs");
  assertEquals(plan.escalations[0]?.side, null);
});

// ---------------------------------------------------------------------------
// The coverage rule
// ---------------------------------------------------------------------------

Deno.test("planConflictResolution - a test file is never resolved by taking a side that drops cases", () => {
  const plan = planConflictResolution([
    file({
      path: "tests/gate_test.ts",
      // Line-superset would say "take theirs"; the case sets say otherwise.
      ours: 'Deno.test("keeps the branch case", () => {});\n',
      theirs:
        'Deno.test("keeps the main case", () => {});\nDeno.test("and another", () => {});\n',
    }),
  ]);

  assertEquals(plan.escalations.length, 1);
  assertStringIncludes(
    plan.escalations[0]?.reason ?? "",
    "keeps the branch case",
  );
});

Deno.test("planConflictResolution - a test file resolves when one side is a genuine union of both", () => {
  const plan = planConflictResolution([
    file({
      path: "tests/gate_test.ts",
      ours:
        'Deno.test("shared", () => {});\nDeno.test("extra branch case", () => {});\n',
      theirs: 'Deno.test("shared", () => {});\n',
    }),
  ]);

  assertEquals(plan.escalations.length, 0);
  assertEquals(plan.decisions[0]?.case, "test-union");
  assertEquals(plan.decisions[0]?.side, "ours");
});

Deno.test("planConflictResolution - a test file whose cases match but whose bodies differ escalates", () => {
  const plan = planConflictResolution([
    file({
      path: "tests/gate_test.ts",
      ours: 'Deno.test("same name", () => { assertEquals(a, 1); });\n',
      theirs: 'Deno.test("same name", () => { assertEquals(a, 2); });\n',
    }),
  ]);

  assertEquals(
    plan.escalations.length,
    1,
    "equal case names still hide a lost assertion — that is the silent loss",
  );
});

// ---------------------------------------------------------------------------
// Modify/delete keeps the Issue #1048 rule
// ---------------------------------------------------------------------------

Deno.test("planConflictResolution - a file the default branch deleted stays deleted (Issue #1048)", () => {
  const plan = planConflictResolution([
    file({ path: "lib/fleet_health.ts", theirs: null }),
  ]);

  assertEquals(plan.decisions[0]?.case, "incoming-delete");
  assertEquals(plan.decisions[0]?.side, "theirs");
  assertEquals(plan.escalations.length, 0);
});

Deno.test("planConflictResolution - a deleted TEST file escalates rather than dropping its cases", () => {
  const plan = planConflictResolution([
    file({ path: "tests/fleet_health_test.ts", theirs: null }),
  ]);

  assertEquals(plan.escalations.length, 1);
});

Deno.test("planConflictResolution - a file the milestone branch deleted and the default branch edited escalates", () => {
  const plan = planConflictResolution([
    file({ path: "lib/fleet_health.ts", ours: null }),
  ]);

  assertEquals(plan.escalations.length, 1);
});

// ---------------------------------------------------------------------------
// What the reader is handed
// ---------------------------------------------------------------------------

Deno.test("buildResolutionCommitMessage - records the reasoning for every file it resolved", () => {
  const plan = planConflictResolution([
    file({
      path: "lib/spawn_runner.ts",
      ours: "const a = 1;\n",
      theirs: "const a = 1;\nconst bounded = true;\n",
    }),
  ]);
  const message = buildResolutionCommitMessage({
    defaultBranch: "main",
    milestoneBranch: "milestone/1559",
    plan,
  });

  assertStringIncludes(message, "milestone/1559");
  assertStringIncludes(message, "lib/spawn_runner.ts");
  assertStringIncludes(message, "superset");
  assertStringIncludes(message, "Issue #1559");
});

Deno.test("buildConflictAnalysisComment - carries both sides' exports, test names and the difference", () => {
  const conflicted = file({
    path: "lib/scan.ts",
    ours:
      'export class IndirectSpawnRules {}\nDeno.test("branch case", () => {});\n',
    theirs:
      'export function scanContentForVariableBinarySpawn() {}\nDeno.test("main case", () => {});\n',
  });
  const analyses = [analyseConflictedFile(conflicted, "two rival designs")];
  const body = buildConflictAnalysisComment({
    repo: "stSoftwareAU/VibeCoder",
    milestoneBranch: "milestone/1559",
    defaultBranch: "main",
    analyses,
    resolved: [],
  });

  assertStringIncludes(body, "IndirectSpawnRules");
  assertStringIncludes(body, "scanContentForVariableBinarySpawn");
  assertStringIncludes(body, "branch case");
  assertStringIncludes(body, "main case");
  assertStringIncludes(body, "only on");
  assert(
    !body.includes("was pushed"),
    "nothing is pushed when the sync escalates",
  );
});
