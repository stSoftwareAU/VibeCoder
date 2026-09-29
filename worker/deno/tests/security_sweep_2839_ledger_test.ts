/**
 * Issue #2839 — the delta re-sweep of the top-up slices #2754 did not
 * repoint. Each slice the record sweeps must point its `ledger` at that
 * record with `sweptAt` at the swept merge-base, and the record must triage
 * and name every module it claims to have read.
 */
import { assert, assertEquals } from "@std/assert";
import {
  LIB_SWEEP_LEDGER_PATH,
  parseCoverageLedger,
  unnamedSmallSliceModules,
} from "../lib/lib_sweep_coverage.ts";
import { sweepGitRunnerFor } from "../commands/sweep_drift.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const RECORD = "docs/audits/security-sweep-2839-top-up-delta.md";
const SWEPT_AT = "42c876e1aa6f8df81177cc19ddb807dd7912bf63";

const ledger = parseCoverageLedger(
  Deno.readTextFileSync(`${REPO_ROOT}${LIB_SWEEP_LEDGER_PATH}`),
);
const recordText = Deno.readTextFileSync(`${REPO_ROOT}${RECORD}`);

/** `chunk → triage` for every row of the record's swept-slices table. */
function sweptRows(text: string): Map<string, string> {
  const rows = new Map<string, string>();
  const row = /^\| (12[a-z]+|top-up-\d+) +\|.*\| *([^|]+?) *\|$/gm;
  for (const match of text.matchAll(row)) rows.set(match[1], match[2]);
  return rows;
}

Deno.test("security sweep #2839 - every swept slice points at the record and its merge-base", () => {
  const rows = sweptRows(recordText);
  assertEquals(rows.size, 35);
  for (const [chunk, triage] of rows) {
    const slice = ledger.slices.find((s) => s.chunk === chunk);
    assert(slice, `${chunk} is not in the ledger`);
    assertEquals(slice.ledger, RECORD, `${chunk} ledger`);
    assertEquals(slice.sweptAt, SWEPT_AT, `${chunk} sweptAt`);
    assert(triage.startsWith("nil"), `${chunk} triage is "${triage}"`);
  }
});

Deno.test("security sweep #2839 - the record names every module its slices claim", () => {
  const chunks = new Set(sweptRows(recordText).keys());
  const gaps = unnamedSmallSliceModules(ledger, new Map([[RECORD, recordText]]))
    .filter((gap) => gap.includes(`— ${RECORD})`));
  assertEquals(gaps, []);
  const pointing = ledger.slices.filter((s) => s.ledger === RECORD);
  assertEquals(pointing.map((s) => s.chunk).sort(), [...chunks].sort());
});

const gitRun = sweepGitRunnerFor(REPO_ROOT);
// A shallow CI clone may not hold the merge-base; skip rather than fail there.
const haveSweptAt =
  (await gitRun(["cat-file", "-e", `${SWEPT_AT}^{commit}`])).code === 0;

Deno.test({
  name: "security sweep #2839 - the recorded sweptAt is an ancestor of HEAD",
  ignore: !haveSweptAt,
  async fn() {
    const result = await gitRun([
      "merge-base",
      "--is-ancestor",
      SWEPT_AT,
      "HEAD",
    ]);
    assertEquals(result.code, 0, result.stderr);
  },
});
