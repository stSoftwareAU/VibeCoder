/**
 * The per-slice top-up files of the security-sweep coverage ledger: two PRs
 * that each add a module add two `top-up-<issue>.json` files under
 * `docs/audits/lib-sweep-coverage/` rather than both appending to the ledger
 * file's tail, so they never conflict. These build throwaway checkouts, so
 * they live apart from the read-only `lib_sweep_coverage_test.ts`.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  LIB_SWEEP_LEDGER_PATH,
  LIB_SWEEP_ROOT,
  LIB_SWEEP_TOP_UP_DIR,
  readCoverageLedger,
  SweepLedgerError,
  topUpChunkId,
} from "../lib/lib_sweep_coverage.ts";

const FIXTURE_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function ledgerFileJson(): string {
  return JSON.stringify({
    roots: [LIB_SWEEP_ROOT],
    parent: 1209,
    description: "d",
    slices: [{
      issue: 1219,
      chunk: "12e",
      title: "t",
      ledger: "docs/audits/x.md",
      definition: "d",
      status: "swept",
      sweptAt: FIXTURE_COMMIT,
      paths: ["worker/deno/lib/1219.ts"],
    }],
  });
}

function topUpJson(issue: number, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    issue,
    chunk: topUpChunkId(issue),
    title: "t",
    ledger: "docs/audits/x.md",
    definition: "d",
    status: "claimed",
    sweptAt: FIXTURE_COMMIT,
    paths: [`worker/deno/lib/${issue}.ts`],
    ...over,
  });
}

async function checkoutWith(
  topUps: Record<string, string> | null,
): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs/audits`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/${LIB_SWEEP_LEDGER_PATH}`,
    ledgerFileJson(),
  );
  if (topUps !== null) {
    await Deno.mkdir(`${root}/${LIB_SWEEP_TOP_UP_DIR}`);
    for (const [name, json] of Object.entries(topUps)) {
      await Deno.writeTextFile(`${root}/${LIB_SWEEP_TOP_UP_DIR}/${name}`, json);
    }
  }
  return root;
}

Deno.test("readCoverageLedger - adds every top-up file's slice to the ledger file's", async () => {
  const root = await checkoutWith({
    "top-up-3301.json": topUpJson(3301),
    "top-up-3300.json": topUpJson(3300),
  });
  const ledger = await readCoverageLedger(root);
  assertEquals(ledger.slices.map((s) => s.chunk), [
    "12e",
    "top-up-3300",
    "top-up-3301",
  ]);
  assertEquals(ledger.slices[2]!.paths, ["worker/deno/lib/3301.ts"]);
});

Deno.test("readCoverageLedger - no top-up directory reads the ledger file alone", async () => {
  const ledger = await readCoverageLedger(await checkoutWith(null));
  assertEquals(ledger.slices.map((s) => s.chunk), ["12e"]);
});

Deno.test("readCoverageLedger - a top-up file not named after its own issue fails loud", async () => {
  const root = await checkoutWith({ "top-up-3300.json": topUpJson(3301) });
  const err = await assertRejects(
    () => readCoverageLedger(root),
    SweepLedgerError,
  );
  assert(err.message.includes("top-up-3300.json"), err.message);
  assert(err.message.includes("top-up-3301.json"), err.message);
});

Deno.test("readCoverageLedger - a malformed top-up file fails naming that file", async () => {
  const root = await checkoutWith({
    "top-up-3300.json": topUpJson(3300, { sweptAt: "nope" }),
  });
  const err = await assertRejects(
    () => readCoverageLedger(root),
    SweepLedgerError,
  );
  assert(
    err.message.startsWith(`${LIB_SWEEP_TOP_UP_DIR}/top-up-3300.json:`),
    err.message,
  );
});

Deno.test("readCoverageLedger - a top-up file that is not valid JSON fails naming that file", async () => {
  // A trailing comma must not surface as a bare SyntaxError naming no file.
  const root = await checkoutWith({ "top-up-3300.json": '{"issue": 3300,}' });
  const err = await assertRejects(
    () => readCoverageLedger(root),
    SweepLedgerError,
  );
  assert(
    err.message.startsWith(
      `${LIB_SWEEP_TOP_UP_DIR}/top-up-3300.json: not valid JSON`,
    ),
    err.message,
  );
});

Deno.test("readCoverageLedger - a non-JSON file in the top-up directory fails loud", async () => {
  const root = await checkoutWith({ "notes.txt": "x" });
  const err = await assertRejects(
    () => readCoverageLedger(root),
    SweepLedgerError,
  );
  // Pin the extension rule itself: the JSON parse would also refuse "x", but
  // only with "not valid JSON", never this guidance.
  assert(
    err.message.startsWith(`${LIB_SWEEP_TOP_UP_DIR}/notes.txt:`),
    err.message,
  );
  assert(
    err.message.includes(
      "only top-up-<issue>.json files belong in this directory",
    ),
    err.message,
  );
});

Deno.test("readCoverageLedger - a top-up file reusing a ledger-file slice's issue fails loud", async () => {
  const root = await checkoutWith({
    "top-up-1219.json": topUpJson(1219, { paths: ["worker/deno/lib/b.ts"] }),
  });
  const err = await assertRejects(
    () => readCoverageLedger(root),
    SweepLedgerError,
  );
  assert(err.message.includes("1219"), err.message);
});

Deno.test("readCoverageLedger - a subdirectory in the top-up directory fails naming it", async () => {
  // A slice put in a nested folder must not drop out of the ledger unseen.
  const root = await checkoutWith({ "top-up-3300.json": topUpJson(3300) });
  await Deno.mkdir(`${root}/${LIB_SWEEP_TOP_UP_DIR}/nested`);
  await Deno.writeTextFile(
    `${root}/${LIB_SWEEP_TOP_UP_DIR}/nested/top-up-3301.json`,
    topUpJson(3301),
  );
  const err = await assertRejects(
    () => readCoverageLedger(root),
    SweepLedgerError,
  );
  assert(err.message.includes(`${LIB_SWEEP_TOP_UP_DIR}/nested`), err.message);
});

Deno.test("readCoverageLedger - a symlink in the top-up directory fails naming it", async () => {
  // A slice committed as a symlink must not drop out of the ledger unseen.
  const root = await checkoutWith({ "top-up-3300.json": topUpJson(3300) });
  const target = `${root}/elsewhere.json`;
  await Deno.writeTextFile(target, topUpJson(3301));
  await Deno.symlink(
    target,
    `${root}/${LIB_SWEEP_TOP_UP_DIR}/top-up-3301.json`,
  );
  const err = await assertRejects(
    () => readCoverageLedger(root),
    SweepLedgerError,
  );
  assert(
    err.message.includes(`${LIB_SWEEP_TOP_UP_DIR}/top-up-3301.json`),
    err.message,
  );
});
