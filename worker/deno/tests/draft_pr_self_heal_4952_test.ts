/**
 * Tests for the orphaned fleet draft self-heal (Issue #4952).
 *
 * A fleet draft whose issue has no live claim and whose body carries no
 * draft-continuation or mutation-hold marker is marked ready, and its CI is
 * awaited, so the auto-merge sweep can arm it. Every other draft stays a draft.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  buildDraftContinuationBody,
  buildMutationHoldDraftBody,
  DRAFT_CONTINUATION_MARKER,
} from "../lib/draft_continuation_pr.ts";
import { readyOrphanedDraftPr } from "../lib/draft_pr_self_heal.ts";

const REPO = "stSoftwareAU/VibeCoder";
const SHA = "abc123";
const FLEET = ["VibeCoderST", "stservice"];
const PR = 7;

interface PrFixture {
  body: string;
  isDraft: boolean;
  headRefName: string;
}

interface Fixture {
  /** `"unreadable"` makes `gh pr view` fail. */
  pr: PrFixture | "unreadable";
  /** `"unreadable"` makes `gh issue view` fail. */
  issue:
    | { state: string; assignees: { login: string }[] }
    | "unreadable";
  /** Makes `gh pr ready` fail. */
  readyFails?: boolean;
  /** Whether a new check run appears once the PR is ready. Default true. */
  ciStarts?: boolean;
}

function healthyDraft(over: Partial<PrFixture> = {}): PrFixture {
  return {
    body: "Work in progress, no marker.",
    isDraft: true,
    headRefName: "issue-7-fix-thing",
    ...over,
  };
}

const OPEN_UNCLAIMED = { state: "OPEN", assignees: [] };

/** A gh stub that routes on the subcommand and records every call. */
function ghStub(f: Fixture) {
  const calls: string[][] = [];
  let ready = false;
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      if (args.includes("headRefOid")) {
        return Promise.resolve(JSON.stringify({ headRefOid: SHA }));
      }
      if (f.pr === "unreadable") {
        return Promise.reject(new Error("HTTP 502"));
      }
      return Promise.resolve(JSON.stringify(f.pr));
    }
    if (args[0] === "pr" && args[1] === "ready") {
      if (f.readyFails) return Promise.reject(new Error("HTTP 502"));
      ready = true;
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "view") {
      if (f.issue === "unreadable") {
        return Promise.reject(new Error("HTTP 503"));
      }
      return Promise.resolve(JSON.stringify(f.issue));
    }
    if (args[0] === "api") {
      const runs = ready && f.ciStarts !== false
        ? [{ id: 2, conclusion: null }]
        : [];
      return Promise.resolve(JSON.stringify(runs));
    }
    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };
  return { gh, calls };
}

const noSleep = () => Promise.resolve();

/** Run the self-heal against a stub and capture its logs. */
async function heal(f: Fixture) {
  const { gh, calls } = ghStub(f);
  const warnings: string[] = [];
  const infos: string[] = [];
  const healed = await readyOrphanedDraftPr({
    repo: REPO,
    prNumber: PR,
    gh,
    fleetAuthors: FLEET,
    log: (m) => warnings.push(m),
    info: (m) => infos.push(m),
    sleep: noSleep,
  });
  const readyCalls = calls.filter((c) => c[0] === "pr" && c[1] === "ready");
  return { healed, calls, readyCalls, warnings, infos };
}

Deno.test("#4952 - an unclaimed draft with no marker is marked ready and reports CI started", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: OPEN_UNCLAIMED,
  });
  assert(run.healed, "CI started, so the sweep may arm it");
  assertEquals(run.readyCalls.length, 1);
  assertEquals(run.readyCalls[0], ["pr", "ready", "7", "--repo", REPO]);
  assertEquals(run.infos, [
    "Marked orphaned fleet draft PR #7 ready (Issue #4952)",
  ]);
  assertEquals(run.warnings, []);
});

Deno.test("#4952 - a draft carrying the draft-continuation marker is held and never readied", async () => {
  const run = await heal({
    pr: healthyDraft({
      body: buildDraftContinuationBody(PR),
    }),
    issue: OPEN_UNCLAIMED,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
});

Deno.test("#4952 - a mutation-hold draft carrying the marker is held and never readied", async () => {
  const run = await heal({
    pr: healthyDraft({
      body: buildMutationHoldDraftBody(7, "Closes #7", {
        job: "mutation",
        workflow: "ci.yml",
        comment: "survivors remain",
      }),
    }),
    issue: OPEN_UNCLAIMED,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
});

Deno.test("#4952 - control: the same draft without the marker is healed, so the marker is the refusing rule", async () => {
  const withMarker = await heal({
    pr: healthyDraft({
      body: `${DRAFT_CONTINUATION_MARKER}\n\nPart of #7`,
    }),
    issue: OPEN_UNCLAIMED,
  });
  const withoutMarker = await heal({
    pr: healthyDraft({ body: "Part of #7" }),
    issue: OPEN_UNCLAIMED,
  });
  assertFalse(withMarker.healed);
  assert(withoutMarker.healed);
  assertEquals(withoutMarker.readyCalls.length, 1);
});

Deno.test("#4952 - an issue assigned to a fleet author is a live claim and never readied", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: { state: "OPEN", assignees: [{ login: "vibecoderst" }] },
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
});

Deno.test("#4952 - control: an issue assigned to a non-fleet login is not a claim, so it is healed", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: { state: "OPEN", assignees: [{ login: "some-human" }] },
  });
  assert(run.healed);
  assertEquals(run.readyCalls.length, 1);
});

Deno.test("#4952 - a closed issue is never readied", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: { state: "CLOSED", assignees: [] },
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
});

Deno.test("#4952 - a branch that does not name an issue is never readied, and no issue is read", async () => {
  const run = await heal({
    pr: healthyDraft({ headRefName: "sync/1786-milestone-1653" }),
    issue: OPEN_UNCLAIMED,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
  assertEquals(run.calls.filter((c) => c[0] === "issue"), []);
});

Deno.test("#4952 - an unreadable PR view stays a draft and warns naming the PR number", async () => {
  const run = await heal({ pr: "unreadable", issue: OPEN_UNCLAIMED });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
  assert(
    run.warnings.some((m) => m.includes("PR #7")),
    `expected a warning naming PR #7, got ${JSON.stringify(run.warnings)}`,
  );
});

Deno.test("#4952 - a PR that is not a draft is not touched", async () => {
  const run = await heal({
    pr: healthyDraft({ isDraft: false }),
    issue: OPEN_UNCLAIMED,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls, []);
});

Deno.test("#4952 - a failed gh pr ready reports false and warns naming the PR number", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: OPEN_UNCLAIMED,
    readyFails: true,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls.length, 1);
  assert(
    run.warnings.some((m) => m.includes("PR #7")),
    `expected a warning naming PR #7, got ${JSON.stringify(run.warnings)}`,
  );
  assertEquals(run.infos, []);
});

Deno.test("#4952 - ready but no ready-for-review CI reports false, so the sweep does not arm it", async () => {
  const run = await heal({
    pr: healthyDraft(),
    issue: OPEN_UNCLAIMED,
    ciStarts: false,
  });
  assertFalse(run.healed);
  assertEquals(run.readyCalls.length, 1);
  assert(
    run.warnings.some((m) => m.includes("PR #7")),
    "the CI-not-started outcome is named with the PR number",
  );
});
