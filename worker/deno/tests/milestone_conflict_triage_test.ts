/**
 * Triage of a conflicted `main` → `milestone/*` sync merge (Issue #1559).
 *
 * The four patterns the issues name are exercised here against real content:
 * the same fix landed twice, one side that subsumes the other, both sides
 * appending to a ledger (Issue #1768), and two rival designs that only a human
 * can choose between. The coverage rule is pinned too — a conflicted test file
 * is never resolved by taking a side that drops cases.
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
  parseStampedIssues,
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

Deno.test("parseFixReferences - reads closing keywords, and only those", () => {
  assertEquals(parseFixReferences("Fixes #1270"), [1270]);
  assertEquals(parseFixReferences("closes #12 and Resolved #13"), [12, 13]);
  assertEquals(parseFixReferences("Refs #99 — mentions only"), []);
  assertEquals(
    parseFixReferences("Issue #1562 records three defects"),
    [],
    "prose that mentions an issue is not a claim to have fixed it",
  );
  assertEquals(parseFixReferences("no references at all"), []);
});

Deno.test("parseStampedIssues - reads this fleet's '(Issue #N)' subject stamp, not body prose", () => {
  assertEquals(parseStampedIssues("Bound the fallback (Issue #1264)"), [1264]);
  assertEquals(
    parseStampedIssues("Subject (Issue #7)\n\nBody mentions (Issue #8)"),
    [7],
    "only the subject line carries the claim",
  );
  assertEquals(parseStampedIssues("Issue #1562 records three defects"), []);
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

const DUPLICATE_FIX = [
  file({
    path: "lib/spawn.ts",
    ours: "export const impl = 'branch';\n",
    theirs: "export const impl = 'main';\n",
    oursFixes: [1270],
    theirsFixes: [1270],
  }),
];

Deno.test("planConflictResolution - case 1: both sides fix the same issue, the side whose cases for it are a superset wins", () => {
  const plan = planConflictResolution(DUPLICATE_FIX, {
    oursAdded: { 1270: ["covers the fallback", "covers the bound"] },
    theirsAdded: { 1270: ["covers the fallback"] },
    complete: true,
  });

  assertEquals(plan.escalations.length, 0, "case 1 resolves without a human");
  const impl = plan.decisions[0];
  assertEquals(impl?.case, "duplicate-fix");
  assertEquals(impl?.action, "ours");
  assertStringIncludes(impl?.reason ?? "", "#1270");
  assertStringIncludes(
    impl?.reason ?? "",
    "dropped",
    "the reason says what was dropped",
  );
});

Deno.test("planConflictResolution - a duplicate fix is scoped to the issue both sides cite, not to unrelated churn", () => {
  // Each side added cases for OTHER issues that the other side lacks. Those
  // must not make the sides incomparable for #1270.
  const plan = planConflictResolution(DUPLICATE_FIX, {
    oursAdded: { 1270: ["shared case"], 999: ["unrelated branch case"] },
    theirsAdded: { 1270: ["shared case"], 888: ["unrelated main case"] },
    complete: true,
  });

  assertEquals(plan.escalations.length, 0);
  assertEquals(plan.decisions[0]?.case, "duplicate-fix");
});

Deno.test("planConflictResolution - a duplicate fix whose cases for that issue are incomparable escalates", () => {
  const plan = planConflictResolution(DUPLICATE_FIX, {
    oursAdded: { 1270: ["only ours"] },
    theirsAdded: { 1270: ["only theirs"] },
    complete: true,
  });

  assertEquals(plan.escalations.length, 1);
  assertEquals(plan.escalations[0]?.action, "escalate");
});

Deno.test("planConflictResolution - a duplicate fix neither side tested is not resolved on no evidence", () => {
  const plan = planConflictResolution(DUPLICATE_FIX);

  assertEquals(plan.escalations.length, 1);
  assertStringIncludes(plan.escalations[0]?.reason ?? "", "neither side wrote");
});

Deno.test("planConflictResolution - evidence git could not read decides nothing", () => {
  const plan = planConflictResolution(DUPLICATE_FIX, {
    oursAdded: {},
    theirsAdded: {},
    complete: false,
  });

  assertEquals(plan.escalations.length, 1);
  assertStringIncludes(plan.escalations[0]?.reason ?? "", "could not be read");
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
  assertEquals(decision?.action, "theirs");
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
  assertEquals(plan.escalations[0]?.action, "escalate");
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

  const decision = plan.decisions[0];
  assert(
    decision?.action !== "ours" && decision?.action !== "theirs",
    "neither side may be taken when each carries a case the other lacks",
  );
  assertEquals(decision?.action, "union", "both sides' cases are kept instead");
  assertStringIncludes(decision?.reason ?? "", "keeps the branch case");
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
  assertEquals(plan.decisions[0]?.action, "ours");
});

Deno.test("planConflictResolution - a test file whose cases match but whose bodies differ is not decided by taking a side", () => {
  const plan = planConflictResolution([
    file({
      path: "tests/gate_test.ts",
      ours: 'Deno.test("same name", () => { assertEquals(a, 1); });\n',
      theirs: 'Deno.test("same name", () => { assertEquals(a, 2); });\n',
    }),
  ]);

  assertEquals(
    plan.decisions[0]?.action,
    "union",
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
  assertEquals(plan.decisions[0]?.action, "theirs");
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

// ---------------------------------------------------------------------------
// Both sides only appended — the append-only ledger rule (Issue #1768)
// ---------------------------------------------------------------------------

const LEDGER_BASE = `# Changelog

## Unreleased
`;

Deno.test("planConflictResolution - both sides only appended to a ledger, so both are kept", () => {
  const plan = planConflictResolution([
    file({
      path: "CHANGELOG.md",
      base: LEDGER_BASE,
      ours: `${LEDGER_BASE}- the milestone branch's entry\n`,
      theirs: `${LEDGER_BASE}- the default branch's entry\n`,
    }),
  ]);

  assertEquals(plan.escalations.length, 0);
  assertEquals(plan.resolved[0]?.case, "both-inserted");
  assertEquals(plan.resolved[0]?.action, "union");
  assertStringIncludes(plan.resolved[0]?.reason ?? "", "only added");
});

Deno.test("planConflictResolution - a side that dropped a base line is not a both-inserted union", () => {
  const base = `${LEDGER_BASE}- an entry from the base\n`;
  const plan = planConflictResolution([
    file({
      path: "CHANGELOG.md",
      base,
      // The milestone side removed the base's entry while adding its own.
      ours: `${LEDGER_BASE}- the milestone branch's entry\n`,
      theirs: `${base}- the default branch's entry\n`,
    }),
  ]);

  assertEquals(plan.resolved.length, 0);
  assertEquals(plan.escalations[0]?.case, "rival-designs");
});

Deno.test("planConflictResolution - a merge base that was not read decides nothing", () => {
  const plan = planConflictResolution([
    file({
      path: "CHANGELOG.md",
      // No `base`: an unread base must never read as "nothing was deleted".
      ours: `${LEDGER_BASE}- the milestone branch's entry\n`,
      theirs: `${LEDGER_BASE}- the default branch's entry\n`,
    }),
  ]);

  assertEquals(plan.resolved.length, 0);
  assertEquals(plan.escalations[0]?.case, "rival-designs");
});

Deno.test("planConflictResolution - a duplicate fix is decided as one, not unioned", () => {
  const plan = planConflictResolution([
    file({
      path: "lib/spawn.ts",
      base: "export const a = 1;\n",
      ours: "export const a = 1;\nexport const branch = true;\n",
      theirs: "export const a = 1;\nexport const main = true;\n",
      oursFixes: [1270],
      theirsFixes: [1270],
    }),
  ]);

  assertEquals(
    plan.decisions[0]?.action === "union",
    false,
    "the same fix landing twice is not two insertions to keep",
  );
  assertStringIncludes(plan.decisions[0]?.reason ?? "", "#1270");
});

Deno.test("planConflictResolution - a conflicted test file is still decided by the coverage rule", () => {
  const plan = planConflictResolution([
    file({
      path: "tests/gate_test.ts",
      base: 'Deno.test("shared", () => {});\n',
      ours:
        'Deno.test("shared", () => {});\nDeno.test("branch only", () => {});\n',
      theirs:
        'Deno.test("shared", () => {});\nDeno.test("main only", () => {});\n',
    }),
  ]);

  assertEquals(plan.resolved[0]?.case, "test-union");
  assertEquals(plan.resolved[0]?.action, "union");
});

Deno.test("planConflictResolution - two rival designs that are both purely additive are unioned, not escalated", () => {
  // The canonical rival-designs pair, but with a merge base showing that each
  // side only added: nothing either branch wrote is dropped by keeping both,
  // and the resolution gate verifies the union before it lands (Issue #1768).
  const base = "export const a = 1;\n";
  const plan = planConflictResolution([
    file({
      path: "lib/scan.ts",
      base,
      ours: `${base}export class IndirectSpawnRules {}\n`,
      theirs: `${base}export function scanContentForVariableBinarySpawn() {}\n`,
      oursFixes: [1378],
      theirsFixes: [1227],
    }),
  ]);

  assertEquals(plan.decisions[0]?.case, "both-inserted");
  assertEquals(plan.decisions[0]?.action, "union");
});

Deno.test("planConflictResolution - rival designs still escalate once a side changed a base line", () => {
  const base = "export const a = 1;\nexport const shared = true;\n";
  const plan = planConflictResolution([
    file({
      path: "lib/scan.ts",
      base,
      // The milestone side rewrote `shared`, so this is no longer two pure
      // insertions and only a human can choose.
      ours: "export const a = 1;\nexport const shared = false;\n" +
        "export class IndirectSpawnRules {}\n",
      theirs: `${base}export function scanContentForVariableBinarySpawn() {}\n`,
      oursFixes: [1378],
      theirsFixes: [1227],
    }),
  ]);

  assertEquals(plan.escalations[0]?.case, "rival-designs");
});
