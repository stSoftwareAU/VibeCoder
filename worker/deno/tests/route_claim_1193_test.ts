/**
 * Two hosts, one pre-pipeline request (Issue #1193).
 *
 * Follow-up to Issue #1139, which claimed the idle-task route only.
 * `processIssue` dispatches three routes **before** `workOnIssue`, whose
 * setup phase is the only caller of `claimIssue`. Two of them —
 * `add-repo:` and `seed-idle-tasks:` — still ran with no claim at all, so
 * neither request ever collected an assignee or a `CLAIM_LOCK` comment and
 * two hosts scanning the same repo both ran it.
 *
 * These tests drive the real claim path (`claimIssue` → `claimRoutedIssue` →
 * the route) over one shared fake GitHub issue with two hosts running under
 * the fleet's single login:
 *
 *   1. the second host's issue list was populated BEFORE the first host's
 *      claim, so it dispatches a request it believes is unassigned — and
 *      stands down without running the command;
 *   2. the stood-down host writes nothing at all to the issue;
 *   3. its run is recorded as a skip that releases nothing (`claimNotHeld`).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  routeAddRepoInProcessIssue,
  type RouteAddRepoOutcome,
} from "../lib/add_repo_process_issue_route.ts";
import {
  routeSeedIdleTasksInProcessIssue,
  type RouteSeedIdleTasksOutcome,
} from "../lib/seed_idle_tasks_process_issue_route.ts";
import {
  claimRoutedIssue,
  ROUTE_CLAIM_REFUSED_MESSAGE,
  routeRunResult,
} from "../lib/route_claim.ts";
import { CLAIM_MARKER_PREFIX, claimIssue } from "../lib/claim_issue.ts";
import { FakeClaimHub, makeRecordingLogger } from "./support/fake_claim_hub.ts";
import type { CommandResult, Logger, WorkerConfig } from "../types.ts";

const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 1193;
/** Both fleet hosts run under the same login, as the real fleet does. */
const FLEET_USER = "stservice";

const CONFIG = {
  repos: [REPO, "stSoftwareAU/private-repo-14"],
  workDir: "/tmp/work",
} as unknown as WorkerConfig;

/** The claim seams every host shares — only `gh` and the clock are faked. */
function claimSeams(hub: FakeClaimHub, host: string, beats: string[]) {
  return {
    workerIdFn: (user: string) => `${user}-${host}`,
    machineIdFn: () => Promise.resolve(`machine-${host}`),
    startHeartbeatFn: () => {
      beats.push(`start:${host}`);
      return Promise.resolve({
        ok: true as const,
        value: {
          id: host,
          repo: REPO,
          issueNumber: ISSUE,
          kind: "issue" as const,
        },
      });
    },
    claimIssueFn: (options: Parameters<typeof claimIssue>[0]) =>
      claimIssue({
        ...options,
        ghCommandFn: hub.gh(host),
        sleepFn: () => Promise.resolve(),
      }),
  };
}

/** The claim inputs a route needs, as `processIssue` supplies them. */
function claimInput(workDir: string) {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    workDir,
    githubUser: FLEET_USER,
    fleetAuthors: [FLEET_USER],
    pushCapableAuthors: [FLEET_USER],
  };
}

/** Run the add-repo route for one host against the shared issue. */
function runAddRepoHost(
  hub: FakeClaimHub,
  host: string,
  ran: string[],
  logger: Logger,
  workDir: string,
  beats: string[] = [],
): Promise<RouteAddRepoOutcome> {
  return routeAddRepoInProcessIssue(
    {
      ...claimInput(workDir),
      issueTitle: "add-repo: stSoftwareAU/private-repo-11",
      config: CONFIG,
    },
    {
      logger,
      executeFn: () => {
        ran.push(host);
        const result: CommandResult = { success: true, message: "added" };
        return Promise.resolve(result);
      },
      stopHeartbeatFn: () => {
        beats.push(`stop:${host}`);
        return Promise.resolve();
      },
      claimRouteFn: (input, deps) =>
        claimRoutedIssue(input, { ...deps, ...claimSeams(hub, host, beats) }),
    },
  );
}

/** Run the seed-idle-tasks route for one host against the shared issue. */
function runSeedHost(
  hub: FakeClaimHub,
  host: string,
  ran: string[],
  logger: Logger,
  workDir: string,
  beats: string[] = [],
): Promise<RouteSeedIdleTasksOutcome> {
  return routeSeedIdleTasksInProcessIssue(
    {
      ...claimInput(workDir),
      issueTitle: "seed-idle-tasks: stSoftwareAU/private-repo-14",
      config: CONFIG,
    },
    {
      logger,
      executeFn: () => {
        ran.push(host);
        const result: CommandResult = { success: true, message: "seeded" };
        return Promise.resolve(result);
      },
      stopHeartbeatFn: () => {
        beats.push(`stop:${host}`);
        return Promise.resolve();
      },
      claimRouteFn: (input, deps) =>
        claimRoutedIssue(input, { ...deps, ...claimSeams(hub, host, beats) }),
    },
  );
}

Deno.test(
  "two hosts, one add-repo request: the second host stands down without running the command",
  async () => {
    const hub = new FakeClaimHub(FLEET_USER, ["work-on"]);
    const ran: string[] = [];
    const beats: string[] = [];
    const workDir = await Deno.makeTempDir();
    const { logger: logA } = makeRecordingLogger();
    const { logger: logB, records: recordsB } = makeRecordingLogger();
    try {
      // Host B's issue list was fetched here — open, unassigned, no claim
      // marker — and it is what host B dispatches from below.
      assertEquals(hub.assignees, []);

      const first = await runAddRepoHost(
        hub,
        "GRQ-3",
        ran,
        logA,
        workDir,
        beats,
      );
      assertEquals(first, { routed: true, success: true });
      assertEquals(ran, ["GRQ-3"]);
      assertEquals(beats, ["start:GRQ-3", "stop:GRQ-3"]);

      // The claim host A took is visible to any other host.
      assertEquals(hub.assignees, [FLEET_USER]);
      assert(
        hub.comments.some((c) => c.body.includes(CLAIM_MARKER_PREFIX)),
        "the winning host must leave a CLAIM_LOCK marker on the request",
      );

      const second = await runAddRepoHost(
        hub,
        "Mac-Ultra-M2",
        ran,
        logB,
        workDir,
        beats,
      );

      assertEquals(second, {
        routed: true,
        success: false,
        claimLost: true,
        claimReason: "already_assigned",
        claimDetail: "the issue is assigned to another run",
      });
      // The command ran exactly once across the fleet, and the stood-down
      // host wrote nothing to the request.
      assertEquals(ran, ["GRQ-3"]);
      assertEquals(hub.writesBy("Mac-Ultra-M2"), []);
      assertEquals(beats, ["start:GRQ-3", "stop:GRQ-3"]);
      assert(
        recordsB.some(([message]) => message === ROUTE_CLAIM_REFUSED_MESSAGE),
        "the stood-down host must say why in its log",
      );
      // The loser has nothing to release — the main loop is told so.
      assert(second.routed, "the request is routed on both hosts");
      assertEquals(routeRunResult(second), {
        success: false,
        skipped: true,
        claimNotHeld: true,
      });
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "two hosts, one seed-idle-tasks request: the second host stands down without seeding",
  async () => {
    const hub = new FakeClaimHub(FLEET_USER, ["work-on"]);
    const ran: string[] = [];
    const beats: string[] = [];
    const workDir = await Deno.makeTempDir();
    const { logger: logA } = makeRecordingLogger();
    const { logger: logB, records: recordsB } = makeRecordingLogger();
    try {
      const first = await runSeedHost(hub, "GRQ-3", ran, logA, workDir, beats);
      assertEquals(first, { routed: true, success: true });
      assertEquals(ran, ["GRQ-3"]);
      assertEquals(hub.assignees, [FLEET_USER]);

      const second = await runSeedHost(
        hub,
        "Mac-Ultra-M2",
        ran,
        logB,
        workDir,
        beats,
      );

      assert("claimLost" in second, "the losing host must report a lost claim");
      assertEquals(second.claimReason, "already_assigned");
      // Seeding files issues in another repo — running it twice files them
      // twice, which is exactly what the claim prevents.
      assertEquals(ran, ["GRQ-3"]);
      assertEquals(hub.writesBy("Mac-Ultra-M2"), []);
      assertEquals(beats, ["start:GRQ-3", "stop:GRQ-3"]);
      assert(
        recordsB.some(([message]) => message === ROUTE_CLAIM_REFUSED_MESSAGE),
        "the stood-down host must say why in its log",
      );
      assertEquals(routeRunResult(second), {
        success: false,
        skipped: true,
        claimNotHeld: true,
      });
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "a non-matching title is never claimed — ordinary issues take the standard pipeline",
  async () => {
    const hub = new FakeClaimHub(FLEET_USER, ["work-on"]);
    const ran: string[] = [];
    const workDir = await Deno.makeTempDir();
    const { logger } = makeRecordingLogger();
    try {
      const outcome = await routeAddRepoInProcessIssue(
        {
          ...claimInput(workDir),
          issueTitle: "Fix the date parser",
          config: CONFIG,
        },
        {
          logger,
          executeFn: () => {
            ran.push("execute");
            return Promise.resolve({ success: true, message: "" });
          },
          claimRouteFn: (input, deps) =>
            claimRoutedIssue(input, {
              ...deps,
              ...claimSeams(hub, "GRQ-3", []),
            }),
        },
      );

      assertEquals(outcome, { routed: false });
      assertEquals(ran, []);
      // The standard pipeline's setup phase takes the claim for these; a
      // route that claimed here would double-claim every ordinary issue.
      assertEquals(hub.assignees, []);
      assertEquals(hub.calls, []);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "a claim that could not be made at all is a failure, not a benign skip",
  () => {
    assertEquals(
      routeRunResult({
        success: false,
        claimLost: true,
        claimReason: "claim_error",
        claimDetail: "gh: 503 unavailable",
      }),
      { success: false, skipped: false, claimNotHeld: true },
    );
    assertEquals(routeRunResult({ success: true }), {
      success: true,
      skipped: false,
    });
  },
);
