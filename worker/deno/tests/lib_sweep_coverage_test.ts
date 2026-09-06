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
  ENUMERATED_SLICE_MAX_PATHS,
  LIB_SWEEP_LEDGER_PATH,
  LIB_SWEEP_ROOT,
  listSweptModules,
  localLedgerRecords,
  parseCoverageLedger,
  type SweepCoverageLedger,
  SweepLedgerError,
  unnamedSmallSliceModules,
} from "../lib/lib_sweep_coverage.ts";

/** Repository root, two directories above `worker/deno/tests/`. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

function readRealLedger(): SweepCoverageLedger {
  return parseCoverageLedger(
    Deno.readTextFileSync(`${REPO_ROOT}${LIB_SWEEP_LEDGER_PATH}`),
  );
}

function ledgerFixture(
  slices: Array<{ chunk: string; paths: string[] }>,
): SweepCoverageLedger {
  return {
    root: LIB_SWEEP_ROOT,
    parent: 1209,
    description: "fixture",
    slices: slices.map((s, i) => ({
      issue: 1000 + i,
      chunk: s.chunk,
      title: "fixture slice",
      ledger: "docs/audits/fixture.md",
      definition: "fixture",
      status: "swept" as const,
      paths: s.paths,
    })),
  };
}

Deno.test("parseCoverageLedger - accepts a well-formed ledger", () => {
  const ledger = parseCoverageLedger(JSON.stringify({
    root: LIB_SWEEP_ROOT,
    parent: 1209,
    description: "d",
    slices: [{
      issue: 1219,
      chunk: "12e",
      title: "closing pass",
      ledger: "docs/audits/x.md",
      definition: "the remainder",
      status: "claimed",
      paths: ["worker/deno/lib/a.ts"],
    }],
  }));
  assertEquals(ledger.slices.length, 1);
  assertEquals(ledger.slices[0]?.status, "claimed");
  assertEquals(ledger.slices[0]?.paths, ["worker/deno/lib/a.ts"]);
});

Deno.test("parseCoverageLedger - fails loud on malformed input", () => {
  // A truncated or emptied ledger must never read as "everything is swept".
  assertThrows(() => parseCoverageLedger("{"), SweepLedgerError);
  assertThrows(() => parseCoverageLedger("[]"), SweepLedgerError);
  assertThrows(
    () =>
      parseCoverageLedger(
        JSON.stringify({
          root: "r",
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
        root: "r",
        parent: 1209,
        description: "d",
        slices: [{
          issue: 1,
          chunk: "12e",
          title: "t",
          ledger: "l",
          definition: "d",
          status: "maybe",
          paths: [],
        }],
      })),
    SweepLedgerError,
  );
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

Deno.test(
  "diffCoverage - the pre-fix ledger without the #1219 slice reports the remainder as unswept",
  async () => {
    // Regression test for the gap this issue closed. Before #1219 no ledger
    // existed at all, so every module in the closing pass was unaccounted for.
    // Removing the #1219 slice reconstructs that state: the check must go red.
    const ledger = readRealLedger();
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
    root: LIB_SWEEP_ROOT,
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
        paths: [],
      },
      {
        issue: 2,
        chunk: "12b",
        title: "still open",
        ledger: "https://github.com/stSoftwareAU/VibeCoder/issues/2",
        definition: "fixture",
        status: "claimed",
        paths: [],
      },
      {
        issue: 3,
        chunk: "12c",
        title: "shares a record",
        ledger: "docs/audits/b.md",
        definition: "fixture",
        status: "swept",
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
  const ledger = readRealLedger();
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

Deno.test("every worker/deno/lib module is claimed by exactly one sweep slice", async () => {
  const ledger = readRealLedger();
  const diff = diffCoverage(ledger, await listSweptModules(REPO_ROOT));
  const failure = describeCoverageDiff(diff);
  assertEquals(
    failure,
    null,
    `${LIB_SWEEP_LEDGER_PATH} no longer matches ${LIB_SWEEP_ROOT}:\n\n${failure}`,
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
    root: LIB_SWEEP_ROOT,
    parent: 1209,
    description: "fixture",
    slices: slices.map((s, i) => ({
      issue: 1000 + i,
      chunk: s.chunk,
      title: "fixture slice",
      ledger: s.ledger,
      definition: "fixture",
      status: "swept" as const,
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
  const ledger = readRealLedger();
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
