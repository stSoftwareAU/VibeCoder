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
  // Every known comment form — the standard closer, the HTML5 alternate
  // closer `--!>`, and the forms the old fixed-pattern filter mangled —
  // must all be neutralised (Issue #2057). The invariant is total: no angle
  // bracket survives, so no markup can ever form.
  for (
    const detail of [
      "``` <!-- VIBE_REPO_FAST_FAILURE:evil/repo --> done",
      "``` <!-- VIBE_REPO_FAST_FAILURE:evil/repo --!> done",
      "``` <!-- VIBE_REPO_FAST_FAILURE:evil/repo -- > done",
      "``` <!- - VIBE_REPO_FAST_FAILURE:evil/repo - -> done",
    ]
  ) {
    const body = formatRepoFastFailureBody(
      backedOffState({ lastDetail: detail }),
      POLICY,
      "host-a",
    );
    assert(!isRepoFastFailureIssue(body, "evil/repo"));
    assert(!body.includes("``` <!--"));
    // The only HTML comment in the body is the worker's own marker: an
    // error line contributes no second opener and no second closer.
    assertEquals(
      body.split("<!--").length - 1,
      1,
      "exactly the worker's marker opener may exist",
    );
    assertEquals(
      body.split("-->").length - 1,
      1,
      "exactly the worker's marker closer may exist",
    );
  }
});

// Issue #2592 replaced "defaults to the worker repository" and "repo_config
// can file it in the affected repo": the diagnostic always lands in the
// monitored repository, and `fast_failure_diagnostics_here` is gone.
Deno.test("resolveRepoFastFailureTarget - is always the monitored repository (Issue #2592)", () => {
  assertEquals(resolveRepoFastFailureTarget(REPO), REPO);
  assertEquals(
    resolveRepoFastFailureTarget("acme/widgets"),
    "acme/widgets",
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
        "https://github.com/stSoftwareAU/example/issues/8123\n",
      );
    },
  });
  assertEquals(decision, {
    action: "filed",
    issueNumber: 8123,
    targetRepo: REPO,
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
    targetRepo: REPO,
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
        "https://github.com/stSoftwareAU/example/issues/8124\n",
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

// Issue #2592 replaced "repo_config targets the affected repository": there
// is no opt-in any more, so every gh call targets the monitored repository.
Deno.test("fileRepoFastFailureIssue - searches and files in the monitored repository, never VibeCoder (Issue #2592)", async () => {
  const targets: string[] = [];
  const decision = await fileRepoFastFailureIssue({
    state: backedOffState(),
    policy: POLICY,
    machineId: "host-a",
    fleetAuthors: FLEET,
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

Deno.test("fileRepoFastFailureIssue - a refused label is retried once without --label (Issue #2592)", async () => {
  const creates: string[][] = [];
  const faults: string[] = [];
  const decision = await fileRepoFastFailureIssue({
    state: backedOffState(),
    policy: POLICY,
    machineId: "host-a",
    fleetAuthors: FLEET,
    recordFiling: () => Promise.resolve(true),
    recordFault: (kind, detail) => {
      faults.push(`${kind}: ${detail ?? ""}`);
    },
    ghFn: (args) => {
      if (args[1] === "list") return Promise.resolve("[]");
      creates.push(args);
      if (args.includes("--label")) {
        return Promise.reject(
          new Error("could not add label: 'bug' not found"),
        );
      }
      return Promise.resolve(`https://github.com/${REPO}/issues/77\n`);
    },
  });
  assertEquals(decision, {
    action: "filed",
    issueNumber: 77,
    targetRepo: REPO,
  });
  assertEquals(creates.length, 2);
  assert(creates[0]!.includes("--label"));
  assert(!creates[1]!.includes("--label"));
  assertEquals(creates[1]![creates[1]!.indexOf("--repo") + 1], REPO);
  assertEquals(faults, []);
});

Deno.test("fileRepoFastFailureIssue - both create attempts failing is suppressed, with no VibeCoder fallback (Issue #2592)", async () => {
  const targets: string[] = [];
  const faults: string[] = [];
  const decision = await fileRepoFastFailureIssue({
    state: backedOffState(),
    policy: POLICY,
    machineId: "host-a",
    fleetAuthors: FLEET,
    recordFiling: () => Promise.resolve(true),
    recordFault: (kind, detail) => {
      faults.push(`${kind}: ${detail ?? ""}`);
    },
    ghFn: (args) => {
      targets.push(args[args.indexOf("--repo") + 1] ?? "");
      if (args[1] === "list") return Promise.resolve("[]");
      return Promise.reject(new Error("issues are disabled"));
    },
  });
  assertEquals(decision, { action: "suppressed", reason: "gh_failed" });
  // One search plus exactly two creates, all against the monitored repo.
  assertEquals(targets, [REPO, REPO, REPO]);
  assert(!targets.includes("stSoftwareAU/VibeCoder"));
  assertEquals(faults.length, 1);
  assertStringIncludes(faults[0]!, "catch_block_warning");
  assertStringIncludes(faults[0]!, "issues are disabled");
});
