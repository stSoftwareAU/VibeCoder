/**
 * Tests for the `worker/deno/lib/` security-sweep coverage ledger
 * (Issue #1219, parent #1209).
 *
 * The last test is the gate the issue asked for: it walks the real `lib/`
 * tree and fails when any module is claimed by no sweep slice. That is the
 * detection mechanism that keeps chunk 12 closed — before this change the
 * ledger did not exist, so the modules of the closing pass were
 * indistinguishable from modules nobody had ever read.
 *
 * Fail direction, stated explicitly: with the #1219 slice removed from the
 * ledger — the pre-fix state of the tree — `diffCoverage` reports those
 * modules as `unswept` and the check fails; with the slice present it passes.
 * `diffCoverage - the pre-fix ledger without the #1219 slice reports the
 * remainder as unswept` is the regression test for that.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  describeCoverageDiff,
  diffCoverage,
  driftSince,
  duplicateSliceIds,
  ENUMERATED_SLICE_MAX_PATHS,
  LEDGER_FILE_LAST_TOP_UP_ISSUE,
  LIB_SWEEP_LEDGER_PATH,
  LIB_SWEEP_ROOT,
  LIB_SWEEP_TOP_UP_DIR,
  listSweptModules,
  listSweptModulesForRoots,
  localLedgerRecords,
  mismatchedTopUpIds,
  parseCoverageLedger,
  readCoverageLedger,
  SWEEP_COVERAGE_ROOTS,
  type SweepCoverageLedger,
  type SweepGitRunner,
  SweepLedgerError,
  topUpChunkId,
  unnamedSmallSliceModules,
  verifySweptAtsOnDefaultBranch,
} from "../lib/lib_sweep_coverage.ts";

/** A valid `sweptAt` used by fixtures (Issue #1609). */
const FIXTURE_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Repository root, two directories above `worker/deno/tests/`. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

function readRealLedger(): Promise<SweepCoverageLedger> {
  return readCoverageLedger(REPO_ROOT);
}

function ledgerFixture(
  slices: Array<{ chunk: string; paths: string[] }>,
): SweepCoverageLedger {
  return {
    roots: [LIB_SWEEP_ROOT],
    parent: 1209,
    description: "fixture",
    slices: slices.map((s, i) => ({
      issue: 1000 + i,
      chunk: s.chunk,
      title: "fixture slice",
      ledger: "docs/audits/fixture.md",
      definition: "fixture",
      status: "swept" as const,
      sweptAt: FIXTURE_COMMIT,
      paths: s.paths,
    })),
  };
}

Deno.test("parseCoverageLedger - accepts a well-formed ledger", () => {
  const ledger = parseCoverageLedger(JSON.stringify({
    roots: [LIB_SWEEP_ROOT],
    parent: 1209,
    description: "d",
    slices: [{
      issue: 1219,
      chunk: "12e",
      title: "closing pass",
      ledger: "docs/audits/x.md",
      definition: "the remainder",
      status: "claimed",
      sweptAt: FIXTURE_COMMIT,
      paths: ["worker/deno/lib/a.ts"],
    }],
  }));
  assertEquals(ledger.slices.length, 1);
  assertEquals(ledger.slices[0]?.status, "claimed");
  assertEquals(ledger.slices[0]?.paths, ["worker/deno/lib/a.ts"]);
  assertEquals(ledger.roots, [LIB_SWEEP_ROOT]);
  assertEquals(ledger.slices[0]?.sweptAt, FIXTURE_COMMIT);
});

Deno.test("parseCoverageLedger - fails loud on malformed input", () => {
  // A truncated or emptied ledger must never read as "everything is swept".
  assertThrows(() => parseCoverageLedger("{"), SweepLedgerError);
  assertThrows(() => parseCoverageLedger("[]"), SweepLedgerError);
  assertThrows(
    () =>
      parseCoverageLedger(
        JSON.stringify({
          roots: ["r"],
          parent: 1209,
          description: "d",
          slices: [],
        }),
      ),
    SweepLedgerError,
  );
  assertThrows(
    () =>
      parseCoverageLedger(JSON.stringify({
        roots: ["r"],
        parent: 1209,
        description: "d",
        slices: [{
          issue: 1,
          chunk: "12e",
          title: "t",
          ledger: "l",
          definition: "d",
          status: "maybe",
          sweptAt: FIXTURE_COMMIT,
          paths: [],
        }],
      })),
    SweepLedgerError,
  );
});

function wellFormedLedgerJson(
  over: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    roots: [LIB_SWEEP_ROOT],
    parent: 1209,
    description: "d",
    slices: [{
      issue: 1219,
      chunk: "12e",
      title: "t",
      ledger: "l",
      definition: "d",
      status: "swept",
      sweptAt: FIXTURE_COMMIT,
      paths: ["worker/deno/lib/a.ts"],
    }],
    ...over,
  });
}

Deno.test("parseCoverageLedger - missing or malformed sweptAt fails naming the field (Issue #1609)", () => {
  const missing = assertThrows(
    () =>
      parseCoverageLedger(wellFormedLedgerJson({
        slices: [{
          issue: 1,
          chunk: "12a",
          title: "t",
          ledger: "l",
          definition: "d",
          status: "swept",
          paths: ["worker/deno/lib/a.ts"],
        }],
      })),
    SweepLedgerError,
  );
  assert(missing.message.includes("sweptAt"), missing.message);

  const badHex = assertThrows(
    () =>
      parseCoverageLedger(wellFormedLedgerJson({
        slices: [{
          issue: 1,
          chunk: "12a",
          title: "t",
          ledger: "l",
          definition: "d",
          status: "swept",
          sweptAt: "not-a-commit",
          paths: ["worker/deno/lib/a.ts"],
        }],
      })),
    SweepLedgerError,
  );
  assert(badHex.message.includes("sweptAt"), badHex.message);
});

Deno.test("parseCoverageLedger - missing roots fails naming the field (Issue #1609)", () => {
  const err = assertThrows(
    () =>
      parseCoverageLedger(JSON.stringify({
        root: LIB_SWEEP_ROOT,
        parent: 1209,
        description: "d",
        slices: [{
          issue: 1,
          chunk: "12a",
          title: "t",
          ledger: "l",
          definition: "d",
          status: "swept",
          sweptAt: FIXTURE_COMMIT,
          paths: ["worker/deno/lib/a.ts"],
        }],
      })),
    SweepLedgerError,
  );
  assert(err.message.includes("roots"), err.message);
});

/** A ledger's JSON text, with each slice's chunk id and issue supplied. */
function ledgerJson(slices: Array<{ chunk: string; issue: number }>): string {
  return JSON.stringify({
    roots: [LIB_SWEEP_ROOT],
    parent: 1209,
    description: "d",
    slices: slices.map((s) => ({
      issue: s.issue,
      chunk: s.chunk,
      title: "t",
      ledger: "docs/audits/x.md",
      definition: "d",
      status: "swept",
      sweptAt: FIXTURE_COMMIT,
      paths: [`worker/deno/lib/${s.issue}.ts`],
    })),
  });
}

Deno.test("parseCoverageLedger - two slices sharing a chunk id fail loud (Issue #1968)", () => {
  // Two branches cut from the same tail both allocated `12aa`. The merge that
  // brings both in must fail here, not after it has landed on main.
  const err = assertThrows(
    () =>
      parseCoverageLedger(ledgerJson([
        { chunk: "12aa", issue: 1940 },
        { chunk: "12aa", issue: 1943 },
      ])),
    SweepLedgerError,
  );
  assert(err.message.includes("12aa"), err.message);
  assert(err.message.includes("top-up-<issue>"), err.message);
});

Deno.test("parseCoverageLedger - two slices owning the same issue fail loud (Issue #1968)", () => {
  const err = assertThrows(
    () =>
      parseCoverageLedger(ledgerJson([
        { chunk: "top-up-1940", issue: 1940 },
        { chunk: "12ab", issue: 1940 },
      ])),
    SweepLedgerError,
  );
  assert(err.message.includes("1940"), err.message);
});

Deno.test("parseCoverageLedger - collision-free top-up ids parse (Issue #1968)", () => {
  const ledger = parseCoverageLedger(ledgerJson([
    { chunk: topUpChunkId(1940), issue: 1940 },
    { chunk: topUpChunkId(1943), issue: 1943 },
  ]));
  assertEquals(ledger.slices.map((s) => s.chunk), [
    "top-up-1940",
    "top-up-1943",
  ]);
});

Deno.test("parseCoverageLedger - a top-up id naming another issue fails loud (Issue #1968)", () => {
  const err = assertThrows(
    () =>
      parseCoverageLedger(ledgerJson([
        { chunk: "top-up-1940", issue: 1943 },
      ])),
    SweepLedgerError,
  );
  assert(err.message.includes("top-up-1940 (issue 1943)"), err.message);
});

Deno.test("mismatchedTopUpIds - only a top-up id is held to its own issue", () => {
  assertEquals(
    mismatchedTopUpIds([
      { chunk: "top-up-1940", issue: 1940 },
      { chunk: "12aa", issue: 1926 },
      { chunk: "top-up-1938", issue: 1943 },
    ]),
    ["top-up-1938 (issue 1943)"],
  );
});

Deno.test("topUpChunkId - derives the id from the issue, so two runs cannot collide (Issue #1968)", () => {
  assertEquals(topUpChunkId(1968), "top-up-1968");
  assert(topUpChunkId(1940) !== topUpChunkId(1943));
});

Deno.test("duplicateSliceIds - reports every repeated chunk id and issue number", () => {
  assertEquals(
    duplicateSliceIds([
      { chunk: "12aa", issue: 1940 },
      { chunk: "12aa", issue: 1943 },
      { chunk: "12ab", issue: 1943 },
      { chunk: "12ac", issue: 1951 },
    ]),
    { chunks: ["12aa"], issues: [1943] },
  );
  assertEquals(
    duplicateSliceIds([
      { chunk: "12aa", issue: 1940 },
      { chunk: "12ab", issue: 1943 },
    ]),
    { chunks: [], issues: [] },
  );
});

Deno.test("the real ledger allocates each chunk id and issue number once (Issue #1968)", async () => {
  // `readRealLedger` parses, so a collision throws before this assertion; the
  // explicit check states the invariant the acceptance criterion names.
  assertEquals(duplicateSliceIds((await readRealLedger()).slices), {
    chunks: [],
    issues: [],
  });
});

Deno.test("diffCoverage - a module on disk that no slice claims is unswept", () => {
  const diff = diffCoverage(
    ledgerFixture([{ chunk: "12a", paths: ["worker/deno/lib/a.ts"] }]),
    ["worker/deno/lib/a.ts", "worker/deno/lib/new_module.ts"],
  );
  assertEquals(diff.unswept, ["worker/deno/lib/new_module.ts"]);
  assertEquals(diff.stale, []);
  assertEquals(diff.duplicated, []);
  assert(describeCoverageDiff(diff)?.includes("new_module.ts"));
});

Deno.test("diffCoverage - a ledger entry with no module on disk is stale", () => {
  const diff = diffCoverage(
    ledgerFixture([{
      chunk: "12a",
      paths: ["worker/deno/lib/a.ts", "worker/deno/lib/deleted.ts"],
    }]),
    ["worker/deno/lib/a.ts"],
  );
  assertEquals(diff.stale, ["worker/deno/lib/deleted.ts"]);
  assertEquals(diff.unswept, []);
});

Deno.test("diffCoverage - a module claimed by two slices is reported", () => {
  const diff = diffCoverage(
    ledgerFixture([
      { chunk: "12a", paths: ["worker/deno/lib/a.ts"] },
      { chunk: "12b", paths: ["worker/deno/lib/a.ts"] },
    ]),
    ["worker/deno/lib/a.ts"],
  );
  assertEquals(diff.duplicated, ["worker/deno/lib/a.ts (12a, 12b)"]);
});

Deno.test("diffCoverage - a fully covered tree yields no diff", () => {
  const diff = diffCoverage(
    ledgerFixture([{ chunk: "12a", paths: ["worker/deno/lib/a.ts"] }]),
    ["worker/deno/lib/a.ts"],
  );
  assertEquals(diff, { unswept: [], stale: [], duplicated: [] });
  assertEquals(describeCoverageDiff(diff), null);
});

Deno.test("listSweptModules - walks subdirectories and excludes test files", async () => {
  const paths = await listSweptModules(REPO_ROOT);
  assert(paths.includes(`${LIB_SWEEP_ROOT}/lib_sweep_coverage.ts`));
  assert(
    paths.some((p) => p.startsWith(`${LIB_SWEEP_ROOT}/phases/`)),
    "expected lib/phases/ modules to be walked",
  );
  assertEquals(paths.filter((p) => p.endsWith("_test.ts")), []);
  assertEquals(paths, [...paths].sort(), "expected a sorted list");
});

Deno.test("listSweptModules - a file root is returned as-is, a directory root is still walked", async () => {
  // Uses the real tree rather than a temp dir: this file sits in the
  // completeness-check family (Issue #1483), which excludes anything that
  // writes, spawns or makes a temp dir — an existing module and an existing
  // lib/ subdirectory exercise both root kinds without any of that. A `.sh`
  // literal is avoided deliberately: naming one beside `REPO_ROOT` on one
  // line reads, to the integration-test manifest's own heuristic (Issue
  // #907), as a test that drives a repository script.
  const fileRoot = `${LIB_SWEEP_ROOT}/lib_sweep_coverage.ts`;
  assertEquals(await listSweptModules(REPO_ROOT, fileRoot), [fileRoot]);
  const dirPaths = await listSweptModules(
    REPO_ROOT,
    `${LIB_SWEEP_ROOT}/phases`,
  );
  assert(dirPaths.length > 1, "expected the directory root to be walked");
  assertEquals(dirPaths, [...dirPaths].sort());
});

Deno.test("the ledger's roots match SWEEP_COVERAGE_ROOTS (Issues #2759, #2760)", async () => {
  const ledger = await readRealLedger();
  assertEquals(ledger.roots, [...SWEEP_COVERAGE_ROOTS]);
});

Deno.test(
  "diffCoverage - the pre-fix ledger without the #1219 slice reports the remainder as unswept",
  async () => {
    // Regression test for the gap this issue closed. Before #1219 no ledger
    // existed at all, so every module in the closing pass was unaccounted for.
    // Removing the #1219 slice reconstructs that state: the check must go red.
    const ledger = await readRealLedger();
    const withoutClosingPass: SweepCoverageLedger = {
      ...ledger,
      slices: ledger.slices.filter((s) => s.issue !== 1219),
    };
    const diff = diffCoverage(
      withoutClosingPass,
      await listSweptModules(REPO_ROOT),
    );
    assert(
      diff.unswept.length > 0,
      "expected the closing-pass modules to be reported as unswept",
    );
    assert(
      describeCoverageDiff(diff)?.includes("claimed by no sweep slice"),
      "expected a failure message naming the unswept modules",
    );
  },
);

Deno.test("localLedgerRecords - keeps repo paths and drops issue URLs", () => {
  const records = localLedgerRecords({
    roots: [LIB_SWEEP_ROOT],
    parent: 1209,
    description: "fixture",
    slices: [
      {
        issue: 1,
        chunk: "12a",
        title: "swept",
        ledger: "docs/audits/b.md",
        definition: "fixture",
        status: "swept",
        sweptAt: FIXTURE_COMMIT,
        paths: [],
      },
      {
        issue: 2,
        chunk: "12b",
        title: "still open",
        ledger: "https://github.com/stSoftwareAU/VibeCoder/issues/2",
        definition: "fixture",
        status: "claimed",
        sweptAt: FIXTURE_COMMIT,
        paths: [],
      },
      {
        issue: 3,
        chunk: "12c",
        title: "shares a record",
        ledger: "docs/audits/b.md",
        definition: "fixture",
        status: "swept",
        sweptAt: FIXTURE_COMMIT,
        paths: [],
      },
    ],
  });
  assertEquals(records, ["docs/audits/b.md"]);
});

Deno.test("every sweep record the ledger names exists in the tree", async () => {
  // A slice's `ledger` is how a reader gets from "this path was swept" to
  // *what the sweep found*, and six filed finding issues cite the #1219
  // record by name. A dangling reference makes the sweep unauditable while
  // still reading as closed, so it fails here rather than at a reader.
  //
  // Fail direction: run against the tree before this change — the coverage
  // JSON named `docs/audits/security-sweep-1219-lib-closing-pass.md` and the
  // file did not exist — and this test goes red.
  const ledger = await readRealLedger();
  const records = localLedgerRecords(ledger);
  assert(records.length > 0, "expected the ledger to name written records");
  const missing: string[] = [];
  for (const record of records) {
    const stat = await Deno.stat(`${REPO_ROOT}${record}`).catch(() => null);
    if (!stat?.isFile) missing.push(record);
  }
  assertEquals(
    missing,
    [],
    `${LIB_SWEEP_LEDGER_PATH} names sweep record(s) that do not exist:\n` +
      missing.map((r) => `  - ${r}`).join("\n"),
  );
});

Deno.test("every non-test module under the ledger roots is claimed by exactly one sweep slice (Issue #1609)", async () => {
  const ledger = await readRealLedger();
  const diff = diffCoverage(
    ledger,
    await listSweptModulesForRoots(REPO_ROOT, ledger.roots),
  );
  const failure = describeCoverageDiff(diff);
  assertEquals(
    failure,
    null,
    `${LIB_SWEEP_LEDGER_PATH} no longer matches the ledger roots:\n\n${failure}`,
  );
});

/**
 * A ledger whose slices each carry their own record path (Issue #1325).
 *
 * `ledgerFixture` points every slice at one shared record, which cannot
 * express "this slice's own record does not name what it claims".
 */
function recordedLedgerFixture(
  slices: Array<{ chunk: string; ledger: string; paths: string[] }>,
): SweepCoverageLedger {
  return {
    roots: [LIB_SWEEP_ROOT],
    parent: 1209,
    description: "fixture",
    slices: slices.map((s, i) => ({
      issue: 1000 + i,
      chunk: s.chunk,
      title: "fixture slice",
      ledger: s.ledger,
      definition: "fixture",
      status: "swept" as const,
      sweptAt: FIXTURE_COMMIT,
      paths: s.paths,
    })),
  };
}

Deno.test("unnamedSmallSliceModules - a small slice's record must name each module it claims", () => {
  // The shortcut this rejects: appending a new module's path to a slice so the
  // coverage gate goes green, without the sweep that read it. The record is
  // the evidence, so a claim its record never mentions is not evidence.
  const gaps = unnamedSmallSliceModules(
    recordedLedgerFixture([{
      chunk: "12f",
      ledger: "docs/audits/top-up.md",
      paths: ["worker/deno/lib/read.ts", "worker/deno/lib/unread.ts"],
    }]),
    new Map([["docs/audits/top-up.md", "read worker/deno/lib/read.ts"]]),
  );
  assertEquals(gaps, [
    "worker/deno/lib/unread.ts (12f — docs/audits/top-up.md)",
  ]);
});

Deno.test("unnamedSmallSliceModules - a record naming every claimed module reports nothing", () => {
  const gaps = unnamedSmallSliceModules(
    recordedLedgerFixture([{
      chunk: "12f",
      ledger: "docs/audits/top-up.md",
      paths: ["worker/deno/lib/read.ts", "worker/deno/lib/also_read.ts"],
    }]),
    new Map([[
      "docs/audits/top-up.md",
      "swept worker/deno/lib/read.ts and worker/deno/lib/also_read.ts",
    ]]),
  );
  assertEquals(gaps, []);
});

Deno.test("unnamedSmallSliceModules - a slice past the enumeration limit describes its modules collectively", () => {
  // The five original slices cover dozens to hundreds of modules each and say
  // so in prose; requiring every path by name would make the rule unusable.
  const paths = Array.from(
    { length: ENUMERATED_SLICE_MAX_PATHS + 1 },
    (_, i) => `worker/deno/lib/m${i}.ts`,
  );
  const gaps = unnamedSmallSliceModules(
    recordedLedgerFixture([{
      chunk: "12e",
      ledger: "docs/audits/closing-pass.md",
      paths,
    }]),
    new Map([["docs/audits/closing-pass.md", "the remainder of lib/"]]),
  );
  assertEquals(gaps, []);
});

Deno.test("unnamedSmallSliceModules - a record that was not supplied fails loud", () => {
  // Absence of evidence is not evidence: an unread record reports every claim
  // rather than passing for want of text to check.
  const gaps = unnamedSmallSliceModules(
    recordedLedgerFixture([{
      chunk: "12f",
      ledger: "docs/audits/missing.md",
      paths: ["worker/deno/lib/a.ts"],
    }]),
    new Map(),
  );
  assertEquals(gaps, ["worker/deno/lib/a.ts (12f — docs/audits/missing.md)"]);
});

Deno.test("unnamedSmallSliceModules - a slice still pointing at its issue is skipped", () => {
  // A `claimed` slice has no written record yet, so there is nothing to read.
  const gaps = unnamedSmallSliceModules(
    recordedLedgerFixture([{
      chunk: "12g",
      ledger: "https://github.com/stSoftwareAU/VibeCoder/issues/2",
      paths: ["worker/deno/lib/a.ts"],
    }]),
    new Map(),
  );
  assertEquals(gaps, []);
});

Deno.test("every small sweep slice's record names each module it claims", async () => {
  // Fail direction: run against the tree before this change — `12e` claimed
  // `gh_timeout.ts` and `12b` claimed `gh_body_file_io.ts`, neither record
  // naming the module — and, once those two were the only members of a
  // top-up slice, this check goes red. Both now sit in `12f`, whose record
  // names them.
  const ledger = await readRealLedger();
  const texts = new Map<string, string>();
  for (const record of localLedgerRecords(ledger)) {
    const text = await Deno.readTextFile(`${REPO_ROOT}${record}`).catch(
      () => null,
    );
    if (text !== null) texts.set(record, text);
  }
  assertEquals(
    unnamedSmallSliceModules(ledger, texts),
    [],
    `${LIB_SWEEP_LEDGER_PATH} claims module(s) in a small slice whose ` +
      `record never names them — sweep them and record the result`,
  );
});

function fakeGit(
  answers: Record<string, { code: number; stdout: string; stderr: string }>,
): SweepGitRunner {
  return (args) => {
    const key = args.join(" ");
    const hit = Object.entries(answers).find(([pattern]) =>
      key.includes(pattern)
    );
    if (!hit) {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    return Promise.resolve(hit[1]);
  };
}

Deno.test("driftSince - returns the slice's added and modified modules from an injected runner (Issue #1609)", async () => {
  const ledger = ledgerFixture([
    {
      chunk: "12a",
      paths: [
        "worker/deno/lib/kept.ts",
        "worker/deno/lib/added.ts",
        "worker/deno/lib/changed.ts",
      ],
    },
  ]);
  const drift = await driftSince(
    ledger,
    ledger.slices[0]!,
    [
      "worker/deno/lib/kept.ts",
      "worker/deno/lib/added.ts",
      "worker/deno/lib/changed.ts",
      "worker/deno/lib/orphan.ts",
    ],
    fakeGit({
      "--diff-filter=A": {
        code: 0,
        stdout: "worker/deno/lib/added.ts\nworker/deno/lib/other.ts\n",
        stderr: "",
      },
      "--diff-filter=M": {
        code: 0,
        stdout: "worker/deno/lib/changed.ts\nworker/deno/lib/changed_test.ts\n",
        stderr: "",
      },
    }),
  );
  assertEquals(drift.added, ["worker/deno/lib/added.ts"]);
  assertEquals(drift.modified, ["worker/deno/lib/changed.ts"]);
  assertEquals(drift.unowned, ["worker/deno/lib/orphan.ts"]);
});

Deno.test("driftSince - an empty diff is an empty report (Issue #1609)", async () => {
  const ledger = ledgerFixture([{
    chunk: "12a",
    paths: ["worker/deno/lib/a.ts"],
  }]);
  const drift = await driftSince(
    ledger,
    ledger.slices[0]!,
    ["worker/deno/lib/a.ts"],
    fakeGit({}),
  );
  assertEquals(drift, { added: [], modified: [], unowned: [] });
});

// Issue #2178 widened this error: the message now names the slice, its
// `sweptAt` and the remedy, so a failing `sweep-drift` says which slice to
// repoint. The stderr is still carried verbatim inside it, which is what the
// original #1609 assertion was protecting.
Deno.test("driftSince - a non-zero git exit throws with stderr (Issue #1609)", async () => {
  const ledger = ledgerFixture([{
    chunk: "12a",
    paths: ["worker/deno/lib/a.ts"],
  }]);
  let thrown: unknown;
  try {
    await driftSince(
      ledger,
      ledger.slices[0]!,
      ["worker/deno/lib/a.ts"],
      fakeGit({
        "--diff-filter=A": {
          code: 128,
          stdout: "",
          stderr: "fatal: bad revision",
        },
      }),
    );
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof SweepLedgerError, String(thrown));
  assert(
    (thrown as SweepLedgerError).message.includes("fatal: bad revision"),
    (thrown as SweepLedgerError).message,
  );
});

Deno.test("driftSince - an unreachable sweptAt names the slice, the commit and the remedy (Issue #2178)", async () => {
  // Fail direction: before this change the thrown message was the bare git
  // stderr — `fatal: bad object 00c1d959…` — which named neither the slice
  // nor what to do about it, so `sweep-drift` failed without saying which of
  // the ledger's slices pointed at a squash-deleted feature-branch commit.
  const ledger = ledgerFixture([{
    chunk: "12a",
    paths: ["worker/deno/lib/a.ts"],
  }]);
  let thrown: unknown;
  try {
    await driftSince(
      ledger,
      ledger.slices[0]!,
      ["worker/deno/lib/a.ts"],
      fakeGit({
        "--diff-filter=A": {
          code: 128,
          stdout: "",
          stderr: `fatal: bad object ${FIXTURE_COMMIT}`,
        },
      }),
    );
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof SweepLedgerError, String(thrown));
  const message = (thrown as SweepLedgerError).message;
  assert(message.includes("slice 12a (#1000)"), message);
  assert(message.includes(FIXTURE_COMMIT), message);
  assert(message.includes("reachable from the default branch"), message);
  assert(message.includes("docs/audits/fixture.md"), message);
});

/**
 * Git runner that answers the ancestry guard from a set of commits on the
 * default branch (Issue #2754). `cat-file -e` resolves only `known` commits;
 * `merge-base --is-ancestor` exits 0 for `onDefault` and 1 otherwise, as git
 * does, and 128 for an object git cannot find.
 */
function ancestryGit(
  defaultRef: string,
  known: ReadonlySet<string>,
  onDefault: ReadonlySet<string>,
): { runGit: SweepGitRunner; calls: string[] } {
  const calls: string[] = [];
  const runGit: SweepGitRunner = (args) => {
    calls.push(args.join(" "));
    const ok = { code: 0, stdout: "", stderr: "" };
    if (args[0] === "rev-parse") {
      return Promise.resolve(
        args[2] === `${defaultRef}^{commit}`
          ? { ...ok, stdout: "f".repeat(40) }
          : {
            code: 128,
            stdout: "",
            stderr: `fatal: Needed a single revision`,
          },
      );
    }
    if (args[0] === "cat-file") {
      const sha = args[2]!.replace("^{commit}", "");
      return Promise.resolve(
        known.has(sha) ? ok : { code: 1, stdout: "", stderr: "" },
      );
    }
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      const sha = args[2]!;
      if (!known.has(sha)) {
        return Promise.resolve({
          code: 128,
          stdout: "",
          stderr: `fatal: Not a valid commit name ${sha}`,
        });
      }
      return Promise.resolve(
        onDefault.has(sha) && args[3] === defaultRef ? ok : {
          code: 1,
          stdout: "",
          stderr: "",
        },
      );
    }
    return Promise.reject(new Error(`unexpected git call: ${args.join(" ")}`));
  };
  return { runGit, calls };
}

const LANDED = "1".repeat(40);
const BRANCH_ONLY = "2".repeat(40);
const SQUASHED_AWAY = "3".repeat(40);

function ancestryLedger(sweptAts: string[]): SweepCoverageLedger {
  const base = ledgerFixture(
    sweptAts.map((_, i) => ({
      chunk: topUpChunkId(1000 + i),
      paths: [`worker/deno/lib/m${i}.ts`],
    })),
  );
  return {
    ...base,
    slices: base.slices.map((slice, i) => ({
      ...slice,
      ledger: `docs/audits/security-sweep-${slice.issue}.md`,
      sweptAt: sweptAts[i]!,
    })),
  };
}

async function ancestryError(
  ledger: SweepCoverageLedger,
  runGit: SweepGitRunner,
): Promise<string> {
  try {
    await verifySweptAtsOnDefaultBranch(ledger, "origin/main", runGit);
  } catch (error) {
    assert(error instanceof SweepLedgerError, String(error));
    return error.message;
  }
  throw new Error("expected verifySweptAtsOnDefaultBranch to throw");
}

Deno.test("verifySweptAtsOnDefaultBranch - a branch-only sweptAt names the slice, the commit and the repoint command (Issue #2754)", async () => {
  // Fail direction: a top-up that recorded its feature branch's HEAD resolves
  // while the PR is open but is not on the default branch, and squash-merge
  // deletes it — 34 slices reached `main` this way before the guard existed.
  const { runGit } = ancestryGit(
    "origin/main",
    new Set([LANDED, BRANCH_ONLY]),
    new Set([LANDED]),
  );
  const message = await ancestryError(
    ancestryLedger([LANDED, BRANCH_ONLY]),
    runGit,
  );
  assert(message.includes("top-up-1001 (#1001)"), message);
  assert(message.includes(BRANCH_ONLY), message);
  assert(message.includes("not an ancestor of origin/main"), message);
  assert(
    message.includes(
      "git log --diff-filter=A -1 --format=%H origin/main -- " +
        "docs/audits/security-sweep-1001.md",
    ),
    message,
  );
  assert(!message.includes("top-up-1000 "), message);
});

Deno.test("verifySweptAtsOnDefaultBranch - an unresolvable sweptAt fails as missing, and every offender is listed (Issue #2754)", async () => {
  const { runGit } = ancestryGit(
    "origin/main",
    new Set([LANDED, BRANCH_ONLY]),
    new Set([LANDED]),
  );
  const message = await ancestryError(
    ancestryLedger([SQUASHED_AWAY, LANDED, BRANCH_ONLY]),
    runGit,
  );
  assert(message.includes("2 slice(s)"), message);
  assert(message.includes("top-up-1000 (#1000)"), message);
  assert(message.includes(`${SQUASHED_AWAY} does not resolve`), message);
  assert(message.includes("top-up-1002 (#1002)"), message);
  assert(message.includes("security-sweep-1000.md"), message);
});

Deno.test("verifySweptAtsOnDefaultBranch - the repaired ledger passes (Issue #2754)", async () => {
  // The same ledger after the repoint: the branch-only slice now names the
  // commit its record landed at, which is on the default branch.
  const repointed = "4".repeat(40);
  const { runGit, calls } = ancestryGit(
    "origin/main",
    new Set([LANDED, BRANCH_ONLY, repointed]),
    new Set([LANDED, repointed]),
  );
  await verifySweptAtsOnDefaultBranch(
    ancestryLedger([LANDED, repointed]),
    "origin/main",
    runGit,
  );
  assert(
    calls.includes(`merge-base --is-ancestor ${repointed} origin/main`),
    calls.join("\n"),
  );
});

Deno.test("verifySweptAtsOnDefaultBranch - an unresolvable default branch fails loud rather than passing (Issue #2754)", async () => {
  // A CI job that forgot to fetch the default branch must not report every
  // slice clean — nor blame every slice for the missing ref.
  const { runGit } = ancestryGit(
    "origin/main",
    new Set([LANDED]),
    new Set([LANDED]),
  );
  let thrown: unknown;
  try {
    await verifySweptAtsOnDefaultBranch(
      ancestryLedger([LANDED]),
      "origin/trunk",
      runGit,
    );
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof SweepLedgerError, String(thrown));
  assert(thrown.message.includes("origin/trunk"), thrown.message);
  assert(thrown.message.includes("git fetch"), thrown.message);
});

Deno.test("parseCoverageLedger - a new top-up slice in the ledger file itself is refused, naming the directory", () => {
  const late = LEDGER_FILE_LAST_TOP_UP_ISSUE + 1;
  const err = assertThrows(
    () =>
      parseCoverageLedger(ledgerJson([
        { chunk: "12e", issue: 1219 },
        { chunk: topUpChunkId(late), issue: late },
      ])),
    SweepLedgerError,
  );
  assert(err.message.includes(topUpChunkId(late)), err.message);
  assert(err.message.includes(LIB_SWEEP_TOP_UP_DIR), err.message);
  // The slices already in the file stay valid.
  parseCoverageLedger(ledgerJson([
    {
      chunk: topUpChunkId(LEDGER_FILE_LAST_TOP_UP_ISSUE),
      issue: LEDGER_FILE_LAST_TOP_UP_ISSUE,
    },
  ]));
});

Deno.test("parseCoverageLedger - a letter-chunk slice for a late issue in the ledger file is refused, naming the directory", () => {
  // Copying the 12y..12ag letter shape still in the file must not get a new
  // slice past the guard: the cut-off is by issue, whatever the chunk id.
  const late = LEDGER_FILE_LAST_TOP_UP_ISSUE + 1;
  const err = assertThrows(
    () =>
      parseCoverageLedger(ledgerJson([
        { chunk: "12e", issue: 1219 },
        { chunk: "12ah", issue: late },
      ])),
    SweepLedgerError,
  );
  assert(err.message.includes("12ah"), err.message);
  assert(err.message.includes(LIB_SWEEP_TOP_UP_DIR), err.message);
  assert(err.message.includes(`${topUpChunkId(late)}.json`), err.message);
});
