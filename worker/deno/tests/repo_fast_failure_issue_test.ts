/**
 * Tests for the backed-off-repository diagnostic issue (Issue #1950).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  fileRepoFastFailureIssue,
  formatRepoFastFailureBody,
  formatRepoFastFailureMarker,
  isRepoFastFailureIssue,
  resolveRepoFastFailureTarget,
} from "../lib/repo_fast_failure_issue.ts";
import type { RepoFastFailureState } from "../lib/repo_fast_failure_tracker.ts";
import { resolveRepoFastFailurePolicy } from "../lib/repo_fast_failure_tracker.ts";

const REPO = "stSoftwareAU/example";
const FLEET = ["vibe-bot"];
const POLICY = resolveRepoFastFailurePolicy();

function backedOffState(
  overrides: Partial<RepoFastFailureState> = {},
): RepoFastFailureState {
  return {
    repo: REPO,
    count: 3,
    backedOff: true,
    backedOffUntil: 1_700_000_000,
    lastPhase: "setup",
    lastDetail: "quality.sh: line 3: deno: command not found",
    lastAt: 1_699_900_000,
    ...overrides,
  };
}

Deno.test("formatRepoFastFailureBody - carries the phase and the last error line", () => {
  const body = formatRepoFastFailureBody(backedOffState(), POLICY, "host-a");
  assertStringIncludes(body, formatRepoFastFailureMarker(REPO));
  assertStringIncludes(body, "`setup`");
  assertStringIncludes(body, "deno: command not found");
  assertStringIncludes(body, "3 fast failures in the last 24 h");
  assert(isRepoFastFailureIssue(body, REPO));
});

Deno.test("formatRepoFastFailureBody - an error line cannot forge a marker or close the fence", () => {
  const body = formatRepoFastFailureBody(
    backedOffState({
      lastDetail: "``` <!-- VIBE_REPO_FAST_FAILURE:evil/repo --> done",
    }),
    POLICY,
    "host-a",
  );
  assert(!isRepoFastFailureIssue(body, "evil/repo"));
  assert(!body.includes("``` <!--"));
});

Deno.test("resolveRepoFastFailureTarget - defaults to the worker repository", () => {
  assertEquals(
    resolveRepoFastFailureTarget(REPO, undefined),
    "stSoftwareAU/VibeCoder",
  );
});

Deno.test("resolveRepoFastFailureTarget - repo_config can file it in the affected repo", () => {
  assertEquals(
    resolveRepoFastFailureTarget(REPO, {
      [REPO]: { fastFailureDiagnosticsHere: true },
    }),
    REPO,
  );
});

Deno.test("fileRepoFastFailureIssue - files exactly one diagnostic when none exists", async () => {
  const calls: string[][] = [];
  const filings: unknown[] = [];
  const decision = await fileRepoFastFailureIssue({
    state: backedOffState(),
    policy: POLICY,
    machineId: "host-a",
    fleetAuthors: FLEET,
    recordFiling: (filing) => {
      filings.push(filing);
      return Promise.resolve(true);
    },
    ghFn: (args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      return Promise.resolve(
        "https://github.com/stSoftwareAU/VibeCoder/issues/8123\n",
      );
    },
  });
  assertEquals(decision, {
    action: "filed",
    issueNumber: 8123,
    targetRepo: "stSoftwareAU/VibeCoder",
  });
  assertEquals(calls.length, 2);
  assertEquals(calls[1]?.[1], "create");
  assertEquals(filings.length, 1);
});

Deno.test("fileRepoFastFailureIssue - an existing fleet-authored diagnostic is reused, not duplicated", async () => {
  const calls: string[][] = [];
  const decision = await fileRepoFastFailureIssue({
    state: backedOffState(),
    policy: POLICY,
    machineId: "host-a",
    fleetAuthors: FLEET,
    ghFn: (args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(JSON.stringify([{
          number: 4242,
          body: formatRepoFastFailureMarker(REPO) + "\nalready filed",
          author: { login: "vibe-bot" },
        }]));
      }
      throw new Error("must not write");
    },
  });
  assertEquals(decision, {
    action: "exists",
    issueNumber: 4242,
    targetRepo: "stSoftwareAU/VibeCoder",
  });
  assertEquals(calls.length, 1);
});

Deno.test("fileRepoFastFailureIssue - a stranger's marker does not stand in for the diagnostic", async () => {
  let created = false;
  const decision = await fileRepoFastFailureIssue({
    state: backedOffState(),
    policy: POLICY,
    machineId: "host-a",
    fleetAuthors: FLEET,
    recordFiling: () => Promise.resolve(true),
    ghFn: (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(JSON.stringify([{
          number: 9,
          body: formatRepoFastFailureMarker(REPO),
          author: { login: "stranger" },
        }]));
      }
      created = true;
      return Promise.resolve(
        "https://github.com/stSoftwareAU/VibeCoder/issues/8124\n",
      );
    },
  });
  assertEquals(decision.action, "filed");
  assertEquals(created, true);
});

Deno.test("fileRepoFastFailureIssue - a repository that is not backed off files nothing", async () => {
  const decision = await fileRepoFastFailureIssue({
    state: backedOffState({ count: 1, backedOff: false }),
    policy: POLICY,
    machineId: "host-a",
    fleetAuthors: FLEET,
    ghFn: () => {
      throw new Error("must not call gh");
    },
  });
  assertEquals(decision, { action: "suppressed", reason: "not_backed_off" });
});

Deno.test("fileRepoFastFailureIssue - a gh failure is reported, never thrown at the release path", async () => {
  const logs: string[] = [];
  const decision = await fileRepoFastFailureIssue({
    state: backedOffState(),
    policy: POLICY,
    machineId: "host-a",
    fleetAuthors: FLEET,
    log: (message) => logs.push(message),
    ghFn: () => Promise.reject(new Error("gh exploded")),
  });
  assertEquals(decision, { action: "suppressed", reason: "gh_failed" });
  assert(logs.some((line) => line.includes("suppressed:gh_failed")));
});

Deno.test("fileRepoFastFailureIssue - repo_config targets the affected repository", async () => {
  const targets: string[] = [];
  const decision = await fileRepoFastFailureIssue({
    state: backedOffState(),
    policy: POLICY,
    machineId: "host-a",
    fleetAuthors: FLEET,
    repoConfigs: { [REPO]: { fastFailureDiagnosticsHere: true } },
    recordFiling: () => Promise.resolve(true),
    ghFn: (args) => {
      targets.push(args[args.indexOf("--repo") + 1] ?? "");
      if (args[1] === "list") return Promise.resolve("[]");
      return Promise.resolve(`https://github.com/${REPO}/issues/12\n`);
    },
  });
  assertEquals(decision, {
    action: "filed",
    issueNumber: 12,
    targetRepo: REPO,
  });
  assertEquals(targets, [REPO, REPO]);
});
