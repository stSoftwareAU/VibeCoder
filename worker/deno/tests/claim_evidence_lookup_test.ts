/**
 * Tests for the claim-time evidence lookup (Issue #245).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fetchIssueClaimEvidence } from "../lib/claim_evidence_lookup.ts";

const FLEET = ["vibe-coder-bot"];

function ghReturning(payload: unknown): {
  fn: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    fn: (args: string[]) => {
      calls.push(args);
      return Promise.resolve(JSON.stringify(payload));
    },
  };
}

Deno.test("claim evidence #245 - one gh call answers all three evidence sources", async () => {
  const gh = ghReturning({
    labels: [{ name: "size/L" }, { name: "enhancement" }],
    comments: [
      {
        author: { login: "vibe-coder-bot" },
        body: "- 21:49 `vibe-coder-1736` — no PR (`timeout`, phase `execute`)",
      },
      {
        author: { login: "vibe-coder-bot" },
        body: "**Detail:** WIP preserved: 21 files on issue-222",
      },
    ],
  });

  const result = await fetchIssueClaimEvidence({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 222,
    ghCommandFn: gh.fn,
    fleetAuthors: FLEET,
  });

  assertEquals(result.lookupError, undefined);
  assertEquals(result.evidence.preservedWip, true);
  assertEquals(result.evidence.previousExecuteTimeout, true);
  assertEquals(result.evidence.longJobLabels, ["size/L"]);
  assertEquals(gh.calls.length, 1);
  assertEquals(gh.calls[0]?.slice(0, 3), ["issue", "view", "222"]);
});

Deno.test("claim evidence #245 - a marker forged by an untrusted author is ignored", async () => {
  const gh = ghReturning({
    labels: [],
    comments: [
      {
        author: { login: "drive-by" },
        body: "WIP preserved: 99 files — no PR (`timeout`, phase `execute`)",
      },
    ],
  });

  const result = await fetchIssueClaimEvidence({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 222,
    ghCommandFn: gh.fn,
    fleetAuthors: FLEET,
  });

  assertEquals(result.evidence.preservedWip, false);
  assertEquals(result.evidence.previousExecuteTimeout, false);
});

Deno.test("claim evidence #245 - configured long-job labels replace the defaults", async () => {
  const gh = ghReturning({
    labels: [{ name: "size/L" }, { name: "needs-a-week" }],
    comments: [],
  });

  const result = await fetchIssueClaimEvidence({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 7,
    ghCommandFn: gh.fn,
    fleetAuthors: FLEET,
    longJobLabels: ["needs-a-week"],
  });

  assertEquals(result.evidence.longJobLabels, ["needs-a-week"]);
});

Deno.test("claim evidence #245 - a failed lookup is reported, not swallowed", async () => {
  const result = await fetchIssueClaimEvidence({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 222,
    ghCommandFn: () => Promise.reject(new Error("gh: API rate limit exceeded")),
    fleetAuthors: FLEET,
  });

  assert(result.lookupError !== undefined);
  assertStringIncludes(result.lookupError!, "rate limit");
  assertEquals(result.evidence, {});
});

Deno.test("claim evidence #245 - unparseable output is reported as a lookup error", async () => {
  const result = await fetchIssueClaimEvidence({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 222,
    ghCommandFn: () => Promise.resolve("not json"),
    fleetAuthors: FLEET,
  });

  assert(result.lookupError !== undefined);
  assertStringIncludes(result.lookupError!, "unparseable");
});
