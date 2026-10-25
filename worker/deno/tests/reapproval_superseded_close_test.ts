/**
 * Unit tests for the re-approved-then-superseded close (Issues #1862, #4298).
 *
 * The end-to-end loop is driven in `reapproval_superseded_loop_1862_test.ts`;
 * these pin the two-fact guard and the failure direction.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildReapprovalSupersededClose,
  closeReapprovalSuperseded,
  type PostMergeReapproval,
} from "../lib/reapproval_superseded_close.ts";
import { supersededOutcome } from "../lib/run_outcome.ts";
import type { Logger } from "../types.ts";

const REAPPROVAL: PostMergeReapproval = {
  label: "work-on",
  addedBy: "nleck",
  addedAt: Math.floor(Date.parse("2026-09-09T15:49:15Z") / 1000),
  prNumber: 116,
  mergedAt: "2026-09-09T09:35:27Z",
};

const SUPERSEDED = supersededOutcome({
  phase: "completion",
  prUrl: "https://github.com/stSoftwareAU/GRQ-AutoTrader/pull/116",
  prNumber: 116,
  prState: "MERGED",
});

const quiet: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

Deno.test("closeReapprovalSuperseded - closes as completed when both facts hold (Issue #4298)", async () => {
  const calls: string[][] = [];
  const note = await closeReapprovalSuperseded({
    repo: "stSoftwareAU/GRQ-AutoTrader",
    issueNumber: 106,
    reapproval: REAPPROVAL,
    outcome: SUPERSEDED,
    ghFn: (args) => {
      calls.push(args);
      return Promise.resolve("");
    },
    logger: quiet,
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.slice(0, 3), ["issue", "close", "106"]);
  assertEquals(calls[0]![calls[0]!.indexOf("--reason") + 1], "completed");
  assertStringIncludes(note ?? "", "closed as completed");
});

Deno.test("closeReapprovalSuperseded - no re-approval or no superseded release closes nothing", async () => {
  const calls: string[][] = [];
  const ghFn = (args: string[]) => {
    calls.push(args);
    return Promise.resolve("");
  };
  const base = { repo: "o/r", issueNumber: 1, ghFn, logger: quiet };
  assertEquals(
    await closeReapprovalSuperseded({
      ...base,
      reapproval: undefined,
      outcome: SUPERSEDED,
    }),
    null,
  );
  assertEquals(
    await closeReapprovalSuperseded({
      ...base,
      reapproval: REAPPROVAL,
      outcome: { kind: "no_pr_expected", phase: "x", summary: "y" },
    }),
    null,
  );
  assertEquals(calls, []);
});

Deno.test("closeReapprovalSuperseded - a failed close is null, never a throw", async () => {
  const note = await closeReapprovalSuperseded({
    repo: "o/r",
    issueNumber: 1,
    reapproval: REAPPROVAL,
    outcome: SUPERSEDED,
    ghFn: () => Promise.reject(new Error("HTTP 502")),
    logger: quiet,
  });
  assertEquals(note, null);
});

Deno.test("buildReapprovalSupersededClose - names the PR and who re-approved, and survives an odd timestamp", () => {
  const body = buildReapprovalSupersededClose({
    ...REAPPROVAL,
    addedAt: 1e20,
  });
  assertStringIncludes(body, "PR #116");
  assertStringIncludes(body, "@nleck");
  assertStringIncludes(body, String(1e20));
});
