/**
 * Authorised CHANGES_REQUESTED reviews are counted per sub-agent tier in
 * fleet telemetry (Issue #3404), driven through `findPrCommentsToFix`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  findPrCommentsToFix,
  type PrScanOptions,
} from "../lib/pr_maintenance.ts";
import {
  getFleetTelemetry,
  resetFleetTelemetry,
  startFleetTelemetry,
} from "../lib/fleet_telemetry.ts";
import { buildSubAgentTierMarker } from "../lib/pr_body.ts";
import type { Logger } from "../types.ts";

const noop = () => {};
const logger: Logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  skipReason: noop,
  timing: noop,
  scanSummary: noop,
  workerSummary: noop,
};

const SUBMITTED = "2026-09-01T00:00:00Z";
const BEFORE_MS = Date.parse(SUBMITTED) - 60_000;

function makeGh(reviewer: string, prBody: string) {
  const calls: string[] = [];
  const fn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    calls.push(key);
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        { number: 42, headRefName: "issue-42-fix", headRefOid: "shaA" },
      ]));
    }
    if (key.includes("pulls/42/reviews")) {
      return Promise.resolve(JSON.stringify([{
        login: reviewer,
        id: 700,
        body: "Please rename the helper.",
        state: "CHANGES_REQUESTED",
        submitted_at: SUBMITTED,
        commit_id: "shaA",
      }]));
    }
    if (key.includes("pr view") && key.includes("--json body")) {
      return Promise.resolve(JSON.stringify({ body: prBody }));
    }
    return Promise.resolve("[]");
  };
  return { fn, calls };
}

function options(ghCommandFn: (a: string[]) => Promise<string>): PrScanOptions {
  return {
    githubUser: "testbot",
    repos: ["org/repo"],
    logger,
    isRepoAllowed: () => true,
    isAuthorisedCommenter: (login: string) => login === "maintainer",
    ghCommandFn,
  };
}

async function scan(reviewer: string, body: string, times = 1) {
  resetFleetTelemetry();
  startFleetTelemetry(BEFORE_MS);
  const gh = makeGh(reviewer, body);
  try {
    for (let i = 0; i < times; i++) {
      await findPrCommentsToFix(options(gh.fn));
    }
    return { snap: getFleetTelemetry(), calls: gh.calls };
  } finally {
    resetFleetTelemetry();
  }
}

const bodyCalls = (calls: string[]) =>
  calls.filter((c) => c.includes("pr view") && c.includes("--json body"));

Deno.test("rejection of a haiku-marked PR counts under haiku (Issue #3404)", async () => {
  const { snap } = await scan(
    "maintainer",
    `Summary\n\n${buildSubAgentTierMarker("haiku")}`,
  );
  assertEquals(snap.prRejectionsHaiku, 1);
  assertEquals(snap.prRejectionsSonnet, 0);
});

Deno.test("rejection of an unmarked PR counts under sonnet (Issue #3404)", async () => {
  const { snap } = await scan("maintainer", "Summary with no marker");
  assertEquals(snap.prRejectionsSonnet, 1);
  assertEquals(snap.prRejectionsHaiku, 0);
});

Deno.test("an unauthorised reviewer is not counted and no PR body is read (Issue #3404)", async () => {
  const { snap, calls } = await scan(
    "stranger",
    buildSubAgentTierMarker("haiku"),
  );
  assertEquals(snap.prRejectionsSonnet, 0);
  assertEquals(snap.prRejectionsHaiku, 0);
  assertEquals(bodyCalls(calls).length, 0);
});

Deno.test("two scans of the same review count it once (Issue #3404)", async () => {
  const { snap } = await scan(
    "maintainer",
    buildSubAgentTierMarker("haiku"),
    2,
  );
  assertEquals(snap.prRejectionsHaiku, 1);
  assertEquals(snap.prRejectionsSonnet, 0);
});
