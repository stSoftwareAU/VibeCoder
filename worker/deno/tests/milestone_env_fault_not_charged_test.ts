/**
 * An environment fault never climbs the milestone conflict ladder.
 *
 * GRQ-AutoTrader's milestones were rolled to the `merge-fallback` rung by
 * faults no resolution could fix:
 *
 * - The egress proxy refused `esm.sh`, so `deno task check` in `web/` could
 *   not download React. The merge gate read that as "the merged tree does not
 *   pass the repository's own check" and charged a conflict attempt; three
 *   charges filed a `merge-fallback` issue on every milestone. The resolution
 *   gate already leaves such a task to CI (Issue #4422); the merge gate now
 *   does the same, and `esm.sh` is allowlisted.
 * - The cargo disk budget withheld the conflict agent, and the second such
 *   cycle was charged and climbed. A full disk is the host's fault and waits
 *   for the host, as every other disk stop does.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkMergedTree } from "../lib/milestone_merge_gate.ts";
import {
  CARGO_BUDGET_AGENT_WITHHELD,
  escalateRepeatedRefusal,
} from "../lib/milestone_branch_sync.ts";
import { resolveEgressAllowlist } from "../lib/egress_allowlist.ts";

/** `deno task check` as it failed in the fleet container behind the proxy. */
const ESM_SH_REFUSED = [
  "Task check deno check",
  "Download https://esm.sh/react@19.2.8/jsx-runtime?target=es2022",
  "error: Import 'https://esm.sh/react@19.2.8/jsx-runtime?target=es2022' failed.",
  "    0: error sending request for url (https://esm.sh/react@19.2.8/jsx-runtime?target=es2022): client error (Connect): unsuccessful tunnel",
  "    1: client error (Connect)",
  "    2: unsuccessful tunnel",
  "    at file:///home/vibe/auto-issue-work/GRQ-AutoTrader/web/src/App.tsx:1:1",
].join("\n");

async function denoTree(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "merge-gate-env-fault-" });
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({ tasks: { check: "deno check" } }),
  );
  return dir;
}

Deno.test("the merge gate leaves a Deno check that cannot reach its module host to CI, never refuses the tree", async () => {
  const dir = await denoTree();
  try {
    const outcome = await checkMergedTree(
      dir,
      () => Promise.resolve({ code: 1, output: ESM_SH_REFUSED }),
      () => Promise.resolve(false),
    );
    assert(outcome.status !== "failed", outcome.detail);
    assertStringIncludes(outcome.detail, "could not fetch its remote modules");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the merge gate names a Deno check left to CI as checkLeftToCi, so the report cannot claim it passed (Issue #4441)", async () => {
  const dir = await denoTree();
  try {
    const outcome = await checkMergedTree(
      dir,
      () => Promise.resolve({ code: 1, output: ESM_SH_REFUSED }),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "skipped", outcome.detail);
    assertStringIncludes(
      outcome.checkLeftToCi ?? "",
      "could not fetch its remote modules",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a cargo project that passes does not hide a Deno check left to CI from checkLeftToCi (Issue #4441)", async () => {
  const dir = await denoTree();
  try {
    await Deno.writeTextFile(`${dir}/Cargo.toml`, '[package]\nname = "x"\n');
    const outcome = await checkMergedTree(
      dir,
      (project) =>
        Promise.resolve(
          project.kind === "cargo"
            ? { code: 0, output: "" }
            : { code: 1, output: ESM_SH_REFUSED },
        ),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "passed", outcome.detail);
    assertStringIncludes(
      outcome.checkLeftToCi ?? "",
      "could not fetch its remote modules",
    );
    assertStringIncludes(outcome.detail, "left to CI");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the merge gate still refuses a Deno check that fails for a real reason", async () => {
  const dir = await denoTree();
  try {
    const outcome = await checkMergedTree(
      dir,
      () =>
        Promise.resolve({
          code: 1,
          output: "error: TS2304 [ERROR]: Cannot find name 'x'.",
        }),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "failed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a cargo-budget withhold never climbs to the roll-back, however long it lasts", () => {
  const refusal = {
    outcome: "not-charged" as const,
    reason: CARGO_BUDGET_AGENT_WITHHELD,
    rung: "agent" as const,
    refusal: true as const,
  };
  for (const refusedBefore of [1, 2, 3, 10]) {
    const verdict = escalateRepeatedRefusal(refusal, refusedBefore);
    assertEquals(verdict.outcome, "not-charged", `after ${refusedBefore}`);
    assertEquals(verdict.exhaust, undefined, `after ${refusedBefore}`);
  }
});

Deno.test("esm.sh is on the egress allowlist", () => {
  const hosts = resolveEgressAllowlist({
    enabledProviderIds: [],
    imgbbConfigured: false,
  });
  assert(hosts.includes("esm.sh"));
});
