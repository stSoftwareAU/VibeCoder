/**
 * Tests for the sweep-drift command (Issue #1609).
 *
 * The command formats one block per slice. Git is injected; these tests
 * never spawn a real process.
 *
 * Australian English spelling throughout.
 */

import { assertEquals } from "@std/assert";
import {
  collectSweepDrift,
  formatSweepDriftReport,
  sweepDriftCommand,
} from "../commands/sweep_drift.ts";
import type { SweepCoverageLedger } from "../lib/lib_sweep_coverage.ts";

const COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function ledger(): SweepCoverageLedger {
  return {
    roots: ["worker/deno/lib"],
    parent: 1209,
    description: "fixture",
    slices: [
      {
        issue: 1214,
        chunk: "12a",
        title: "subprocess",
        ledger: "docs/audits/a.md",
        definition: "fixture",
        status: "swept",
        sweptAt: COMMIT,
        paths: ["worker/deno/lib/a.ts"],
      },
    ],
  };
}

Deno.test("formatSweepDriftReport - prints one block per slice with counts and paths (Issue #1609)", () => {
  const text = formatSweepDriftReport([{
    chunk: "12a",
    issue: 1214,
    title: "subprocess",
    sweptAt: COMMIT,
    drift: {
      added: ["worker/deno/lib/new.ts"],
      modified: ["worker/deno/lib/a.ts"],
      unowned: [],
    },
  }]);
  assertEquals(
    text.includes("## 12a (#1214) subprocess"),
    true,
  );
  assertEquals(text.includes("added (1):"), true);
  assertEquals(text.includes("  - worker/deno/lib/new.ts"), true);
  assertEquals(text.includes("modified (1):"), true);
  assertEquals(text.includes("unowned (0):"), true);
});

Deno.test("collectSweepDrift - one block per slice from the injected runner (Issue #1609)", async () => {
  const blocks = await collectSweepDrift(
    ledger(),
    ["worker/deno/lib/a.ts"],
    (args) => {
      if (args.includes("--diff-filter=M")) {
        return Promise.resolve({
          code: 0,
          stdout: "worker/deno/lib/a.ts\n",
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  );
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]?.chunk, "12a");
  assertEquals(blocks[0]?.drift.modified, ["worker/deno/lib/a.ts"]);
  assertEquals(blocks[0]?.drift.added, []);
});

Deno.test("sweep-drift command - is registered under the documented name (Issue #1609)", () => {
  assertEquals(sweepDriftCommand.name, "sweep-drift");
});
