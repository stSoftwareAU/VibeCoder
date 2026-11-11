/**
 * Which red checks of a draft PR cannot pass there (Issue #4951): `gate`, or a
 * check whose `needs:` were all skipped. A job that ran and failed is real.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { fetchFailedCheckRuns } from "../lib/pr_maintenance.ts";
import { dropDraftByDesignFailures } from "../lib/draft_ci_by_design.ts";
import type { JobNeedsMap } from "../lib/workflow_job_needs.ts";

const NEEDS: JobNeedsMap = new Map([
  ["gate", ["lint", "test"]],
  ["CI Required Checks", ["lint", "test"]],
  ["deploy", ["lint", "test"]],
  ["lint", []],
  ["test", []],
]);

function names(checks: { name: string }[]): string[] {
  return checks.map((c) => c.name);
}

function reader(skipped: string[]) {
  return () => Promise.resolve(new Set(skipped));
}

Deno.test("dropDraftByDesignFailures - gate is dropped even with no needs topology", async () => {
  const kept = await dropDraftByDesignFailures(
    [{ name: "gate" }],
    null,
    reader([]),
  );
  assertEquals(kept, []);
});

Deno.test("dropDraftByDesignFailures - a check whose needs were all skipped is dropped", async () => {
  const kept = await dropDraftByDesignFailures(
    [{ name: "CI Required Checks" }],
    NEEDS,
    reader(["lint", "test"]),
  );
  assertEquals(kept, []);
});

Deno.test("dropDraftByDesignFailures - a check with a need that ran is kept (positive control for the skipped rule)", async () => {
  const kept = await dropDraftByDesignFailures(
    [{ name: "CI Required Checks" }],
    NEEDS,
    // `test` ran on this head, so the check is not explained by skipping.
    reader(["lint"]),
  );
  assertEquals(names(kept), ["CI Required Checks"]);
});

Deno.test("dropDraftByDesignFailures - a job with no needs and an unknown job are kept", async () => {
  const kept = await dropDraftByDesignFailures(
    [{ name: "test" }, { name: "unknown-job" }],
    NEEDS,
    reader(["lint", "test"]),
  );
  assertEquals(names(kept), ["test", "unknown-job"]);
});

Deno.test("dropDraftByDesignFailures - without a topology a non-gate check is kept", async () => {
  const kept = await dropDraftByDesignFailures(
    [{ name: "CI Required Checks" }],
    null,
    reader(["lint", "test"]),
  );
  assertEquals(names(kept), ["CI Required Checks"]);
});

Deno.test("dropDraftByDesignFailures - a real failure is kept beside a dropped gate and dropped aggregators", async () => {
  const kept = await dropDraftByDesignFailures(
    [{ name: "gate" }, { name: "deploy" }, { name: "CI Required Checks" }, {
      name: "test",
    }],
    NEEDS,
    reader(["lint", "test"]),
  );
  assertEquals(names(kept), ["test"]);
});

Deno.test("draft CI - skipped needs beyond the first page still suppress the aggregator (PR #5030 review)", async () => {
  const first = Array.from({ length: 100 }, (_, id) => ({
    id,
    name: id === 0 ? "lint" : `unrelated-${id}`,
    status: "completed",
    conclusion: "skipped",
  }));
  const second = [{
    id: 101,
    name: "test",
    status: "completed",
    conclusion: "skipped",
  }];
  const gh = (args: string[]) =>
    Promise.resolve(
      args.includes("--paginate") &&
        args.some((a) => a.endsWith("?per_page=100"))
        ? `${JSON.stringify(first)}\n${JSON.stringify(second)}`
        : JSON.stringify(first.slice(0, 30)),
    );
  const kept = await dropDraftByDesignFailures(
    [{ name: "CI Required Checks" }, { name: "test" }],
    NEEDS,
    async () =>
      new Set(
        (await fetchFailedCheckRuns("org/repo", "head", gh, ["skipped"])).map((
          c,
        ) => c.name),
      ),
  );
  assertEquals(
    names(kept),
    ["test"],
    "the real failure remains, the draft-only aggregator does not",
  );
});
