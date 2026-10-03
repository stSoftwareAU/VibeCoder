/**
 * The security-tree sweep's worker scan fills known-open SEC- ids
 * (Issue #3045, PR #3068 review).
 *
 * createDefaultSweepDeps().runWorkerScanFn is stubbed by the sweep suite,
 * so these tests call runWorkerScan directly. Reverting the
 * listKnownOpenFindingIds call leaves the fleet-authored case red.
 */

import { assert, assertEquals } from "@std/assert";
import { runWorkerScan } from "../lib/security_tree_sweep.ts";

const FLEET_LOGIN = "vibe-coder-bot";
const OUTSIDER_LOGIN = "helpful-stranger";

function findingIdGh(
  rows: Array<{ number: number; body: string; author: string }>,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const jsonIdx = args.indexOf("--json");
    const jsonField = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
    if (
      jsonField === "number,body,author" && !args.includes("--label") &&
      !args.includes("--search")
    ) {
      return Promise.resolve(JSON.stringify(
        rows.map((r) => ({
          number: r.number,
          body: r.body,
          author: { login: r.author },
        })),
      ));
    }
    return Promise.resolve("[]");
  };
}

async function seenIds(
  rows: Array<{ number: number; body: string; author: string }>,
): Promise<string[][]> {
  const seen: string[][] = [];
  const outcome = await runWorkerScan(
    { slug: "o/r", repoDir: "/tmp/repo" },
    {
      ghCommandFn: findingIdGh(rows),
      fleetAuthors: [FLEET_LOGIN],
      runSecurityScanFn: (opts) => {
        seen.push([...opts.knownOpenFindingIds]);
        return Promise.resolve({ ok: true, value: { ok: true } });
      },
    },
  );
  assert(outcome.ok, outcome.ok ? "" : outcome.error);
  return seen;
}

Deno.test("runWorkerScan - a fleet-authored SEC- id reaches the scanner", async () => {
  assertEquals(
    await seenIds([{
      number: 7,
      body: "<!-- finding-id: SEC-abc123 -->",
      author: FLEET_LOGIN,
    }]),
    [["SEC-abc123"]],
  );
});

Deno.test("runWorkerScan - an outsider-authored SEC- id does not reach the scanner", async () => {
  assertEquals(
    await seenIds([{
      number: 7,
      body: "<!-- finding-id: SEC-abc123 -->",
      author: OUTSIDER_LOGIN,
    }]),
    [[]],
  );
});
