/**
 * A PR merged into a milestone branch closes its issue whoever authored it
 * (Issue #2537).
 *
 * On 2026-09-23 GRQ-AutoTrader PR #838 — authored and merged by a human,
 * branch `issue-824-real-evaluation`, body `Closes #824` — merged into
 * `milestone/automatic-buying-from-the-score-sheet` at 00:19 UTC. GitHub
 * honours `Closes #N` on the default branch alone, so the worker's close-out
 * sweep is the only thing that closes a milestone child. The sweep listed
 * merged PRs with `--author <this host>`, so no host ever looked at #838:
 * #824 stayed open all day and held its three `top-priority` dependants.
 *
 * The mock honours `--author`, which is exactly what the older tests' mocks
 * did not — they returned the listing whatever the filter, so the gap was
 * invisible to them.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { closeIssuesForMergedPrs } from "../lib/pr_issue_linking.ts";
import { alwaysLanded } from "./fixtures/merge_landing_stub.ts";

const HUMAN_PR = {
  number: 838,
  title: "trader: the scheduled evaluation decides from the broker's " +
    "observation and reports durably (#824)",
  headRefName: "issue-824-real-evaluation",
  mergedAt: "2026-09-23T00:19:51Z",
  body: "Closes #824\n\n## Summary\n",
  author: { login: "nleck" },
};

function gh(closed: string[]): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "list") {
      const i = args.indexOf("--author");
      const author = i >= 0 ? args[i + 1] : undefined;
      const prs = author === undefined || author === HUMAN_PR.author.login
        ? [HUMAN_PR]
        : [];
      return Promise.resolve(JSON.stringify(prs));
    }
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({
        state: "OPEN",
        labels: [{ name: "top-priority" }],
        createdAt: "2026-09-22T21:24:04Z",
      }));
    }
    if (args[0] === "issue" && args[1] === "close") closed.push(args[2]!);
    return Promise.resolve("");
  };
}

Deno.test(
  "closeIssuesForMergedPrs - a human's PR merged into a milestone branch closes its issue (Issue #2537)",
  async () => {
    const closed: string[] = [];

    const count = await closeIssuesForMergedPrs(
      ["stSoftwareAU/GRQ-AutoTrader"],
      "VibeCoderST",
      gh(closed),
      "planning",
      undefined,
      { verifyMergeLandedFn: alwaysLanded },
    );

    assertEquals(
      closed,
      ["824"],
      "PR #838 merged into the milestone branch, so #824 must close — " +
        "whoever authored the PR",
    );
    assertEquals(count, 1);
  },
);
