/**
 * The Failure-Detection resume finder reads the listing the scan already
 * holds (Issue #2409).
 *
 * Live incident: the fleet spent its GitHub GraphQL quota in ~25 minutes of
 * every hour and sat locked out for the rest, claiming nothing. Five
 * maintenance sweeps cost exactly one GraphQL call per monitored repository,
 * every cycle, uncached. This finder was the clearest: `gh issue list --label
 * needs-failure-detection-repair` for each of 20 repositories every ~3 minutes,
 * to learn "none" — while the cached open-issue listing, which carries every
 * label, already held the answer.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { findFailureDetectionRepairParents } from "../lib/find_failure_detection_repair_issues.ts";

const LABEL = "needs-failure-detection-repair";
const silent = { info: () => {}, warn: () => {} };

/** A gh runner that records every call and answers like `gh issue list`. */
function recordingGh(answer: unknown = []) {
  const calls: string[][] = [];
  return {
    calls,
    fn: (args: string[]) => {
      calls.push(args);
      return Promise.resolve(JSON.stringify(answer));
    },
  };
}

Deno.test("resume finder - with the scan's listing to hand it makes no gh call and still finds the labelled parent (Issue #2409)", async () => {
  const gh = recordingGh();
  const parents = await findFailureDetectionRepairParents({
    repos: ["org/a", "org/b"],
    ghCommandFn: gh.fn,
    logger: silent,
    listOpenIssues: (repo) =>
      Promise.resolve(
        repo === "org/a"
          ? [
            { number: 1, title: "ordinary", labels: ["work-on"] },
            {
              number: 2,
              title: "needs finishing",
              labels: ["planning", LABEL],
            },
          ]
          : [{ number: 9, title: "other repo", labels: [] }],
      ),
  });

  assertEquals(parents, [{
    repo: "org/a",
    number: 2,
    title: "needs finishing",
  }]);
  assertEquals(gh.calls, [], "the listing already held the answer");
});

Deno.test("resume finder - a truncated listing cannot prove absence, so that repository is asked directly (Issue #2409)", async () => {
  const gh = recordingGh([{ number: 777, title: "beyond the listing" }]);
  const full = Array.from({ length: 3 }, (_, i) => ({
    number: i + 1,
    title: `issue ${i + 1}`,
    labels: [] as string[],
  }));

  const parents = await findFailureDetectionRepairParents({
    repos: ["org/big"],
    ghCommandFn: gh.fn,
    logger: silent,
    listOpenIssues: () => Promise.resolve(full),
    // The listing came back full: a labelled issue may sit beyond it.
    listingLimit: 3,
  });

  assertEquals(parents, [{
    repo: "org/big",
    number: 777,
    title: "beyond the listing",
  }]);
  assertEquals(gh.calls.length, 1);
  assertEquals(gh.calls[0]?.includes("--label"), true);
});

Deno.test("resume finder - a listing that cannot be read falls back to the direct query rather than reporting none (Issue #2409)", async () => {
  const gh = recordingGh([{ number: 5, title: "found the old way" }]);
  const parents = await findFailureDetectionRepairParents({
    repos: ["org/a"],
    ghCommandFn: gh.fn,
    logger: silent,
    listOpenIssues: () => Promise.reject(new Error("cache unreadable")),
  });

  assertEquals(parents, [{
    repo: "org/a",
    number: 5,
    title: "found the old way",
  }]);
  assertEquals(gh.calls.length, 1);
});

Deno.test("resume finder - without a listing it behaves exactly as before: one label query per repository (Issue #2409)", async () => {
  const gh = recordingGh([]);
  await findFailureDetectionRepairParents({
    repos: ["org/a", "org/b"],
    ghCommandFn: gh.fn,
    logger: silent,
  });
  assertEquals(gh.calls.length, 2);
});
