/**
 * Two hosts, one idle-task wrapper (Issue #1139).
 *
 * Measured from the fleet run records on 2026-09-05:
 * `NEAT-AI-Lamarck#206` ran on GRQ-3 (01:56:42 → 02:01:32) and on
 * Mac-Ultra-M2 (02:00:25 → 02:05:25) — overlapping, both recorded
 * `success`. Neither issue's timeline carries an `assigned` event, because
 * `routeIdleTaskInProcessIssue` runs *before* `workOnIssue`, whose setup
 * phase held the only `claimIssue` call: a routed wrapper took no claim
 * lock at all, so a second host's scan kept offering it.
 *
 * These tests drive the real claim path (`claimIssue` →
 * `claimRoutedIssue` → `routeIdleTaskInProcessIssue`) over one shared
 * fake GitHub state, with two hosts:
 *
 *   1. the second host's issue list was populated BEFORE the first host's
 *      claim, so it dispatches a wrapper it believes is unassigned — and
 *      stands down without scanning;
 *   2. two simultaneous claims resolve by earliest `CLAIM_LOCK`, and the
 *      loser removes its own claim and unassigns itself;
 *   3. a lost claim is recorded as a skip, never as an ordinary success.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { routeIdleTaskInProcessIssue } from "../lib/idle_task_process_issue_route.ts";
import {
  claimRoutedIssue,
  ROUTE_CLAIM_REFUSED_MESSAGE,
  routeRunResult,
} from "../lib/route_claim.ts";
import { CLAIM_MARKER_PREFIX, claimIssue } from "../lib/claim_issue.ts";
import { formatHeartbeatMarker } from "../lib/heartbeat_storage.ts";
import type { IdleTaskTemplate } from "../lib/idle_task_template.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Shared fake GitHub — one issue, two hosts
// ---------------------------------------------------------------------------

const REPO = "stSoftwareAU/NEAT-AI-Lamarck";
const ISSUE = 206;
/** Both fleet hosts run under the same login, as the real fleet does. */
const FLEET_USER = "stservice";

interface FakeComment {
  id: number;
  body: string;
  createdAt: string;
  author: string;
}

/** The one issue both hosts can see, and every mutation made to it. */
class FakeGitHub {
  assignees: string[] = [];
  comments: FakeComment[] = [];
  state = "OPEN";
  labels: string[] = ["idle-task"];
  /** Every `gh` invocation, tagged with the host that made it. */
  readonly calls: Array<{ host: string; args: string[] }> = [];
  /** Hook fired just before a host's claim comment is stored. */
  onClaimComment?: (host: string) => void;
  private nextId = 1;

  /** A `gh` runner bound to one host. */
  gh(host: string): (args: string[]) => Promise<string> {
    return (args: string[]) => {
      this.calls.push({ host, args: [...args] });
      return Promise.resolve(this.dispatch(host, args));
    };
  }

  /** Writes this host made to the issue (assign, comment, close, delete). */
  writesBy(host: string): string[][] {
    return this.calls
      .filter((c) => c.host === host && isWrite(c.args))
      .map((c) => c.args);
  }

  private dispatch(host: string, args: string[]): string {
    const jq = jqOf(args);

    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("labels")) {
        return JSON.stringify({
          labels: this.labels.map((name) => ({ name })),
        });
      }
      if (args.includes("assignees")) return JSON.stringify(this.assignees);
      if (args.includes("state")) return this.state;
      return "";
    }

    if (args[0] === "issue" && args[1] === "edit") {
      const add = args.indexOf("--add-assignee");
      if (add >= 0) {
        const user = args[add + 1]!;
        if (!this.assignees.includes(user)) this.assignees.push(user);
        return "";
      }
      const remove = args.indexOf("--remove-assignee");
      if (remove >= 0) {
        this.assignees = this.assignees.filter((a) => a !== args[remove + 1]);
        return "";
      }
      return "";
    }

    if (args[0] === "issue" && args[1] === "comment") {
      const body = args[args.indexOf("--body") + 1] ?? "";
      if (body.includes(CLAIM_MARKER_PREFIX)) this.onClaimComment?.(host);
      this.addComment(body);
      return "";
    }

    if (args[0] === "issue" && args[1] === "close") {
      this.state = "CLOSED";
      return "";
    }

    if (args[0] === "api" && args[1] === "-X" && args[2] === "DELETE") {
      const id = Number(args[3]!.split("/").pop());
      this.comments = this.comments.filter((c) => c.id !== id);
      return "";
    }

    if (args[0] === "api" && args[1]?.endsWith("/comments")) {
      // Heartbeat marker scan — body + author only.
      if (jq.includes("{body: .body, author: .user.login}")) {
        return JSON.stringify(
          this.comments.map((c) => ({ body: c.body, author: c.author })),
        );
      }
      const claims = this.comments.filter((c) =>
        c.body.includes(CLAIM_MARKER_PREFIX)
      );
      // This worker's own claim comment id (the lost-race cleanup).
      if (jq.includes("contains(")) {
        const needle = jq.split('contains("')[1]?.split('")')[0] ?? "";
        const own = this.comments.find((c) => c.body.includes(needle));
        return own ? String(own.id) : "";
      }
      // Stale-claim cleanup — id, created_at, author (no body).
      if (!jq.includes("body: .body")) {
        return JSON.stringify(
          claims.map((c) => ({
            id: c.id,
            created_at: c.createdAt,
            author: c.author,
          })),
        );
      }
      // Race verification — the full claim comment shape.
      return JSON.stringify(
        claims.map((c) => ({
          id: c.id,
          body: c.body,
          created_at: c.createdAt,
          author: c.author,
        })),
      );
    }

    return "";
  }

  addComment(body: string, createdAt: string = new Date().toISOString()): void {
    this.comments.push({
      id: this.nextId++,
      body,
      createdAt,
      author: FLEET_USER,
    });
  }
}

function jqOf(args: string[]): string {
  const i = args.indexOf("--jq");
  return i >= 0 ? args[i + 1] ?? "" : "";
}

function isWrite(args: string[]): boolean {
  if (args[0] === "issue") {
    return args[1] === "edit" || args[1] === "comment" || args[1] === "close";
  }
  return args[0] === "api" && args[1] === "-X";
}

function makeLogger(): { logger: Logger; records: Array<[string, unknown]> } {
  const records: Array<[string, unknown]> = [];
  const push = (m: string, c?: unknown) => records.push([m, c]);
  const logger: Logger = {
    info: push,
    warn: push,
    error: push,
    debug: push,
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  return { logger, records };
}

const TEMPLATE: IdleTaskTemplate = {
  name: "github-actions-audit",
  description: "Run a GitHub Actions audit",
  buildIssueTitle: () => "Run a GitHub Actions audit",
  buildIssueBody: () => "audit body",
  runTask: () => Promise.resolve({ ok: true, summary: "audit complete" }),
};

/**
 * The wrapper as each host's scan dispatched it.
 *
 * `workDir` is a temp directory per test, never a fixed shared path: the
 * real claim path writes marker state under it, and a unit test must not
 * inherit or leave host state (Issue #1098).
 */
function wrapperInput(workDir: string) {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Run a GitHub Actions audit",
    issueLabels: ["idle-task"],
    issueBody: "audit body",
    workDir,
    githubUser: FLEET_USER,
    fleetAuthors: [FLEET_USER],
    pushCapableAuthors: [FLEET_USER],
  };
}

/**
 * Run the route for one host against the shared issue, counting scans.
 * The real `claimRoutedIssue` and `claimIssue` are used — only `gh`,
 * the clone and the template are faked.
 */
function runHost(
  hub: FakeGitHub,
  host: string,
  scans: string[],
  logger: Logger,
  workDir: string,
  beats: string[] = [],
) {
  const handle = {
    id: host,
    repo: REPO,
    issueNumber: ISSUE,
    kind: "issue" as const,
  };
  return routeIdleTaskInProcessIssue(wrapperInput(workDir), {
    logger,
    findTemplateFn: () => TEMPLATE,
    ensureCloneFn: () =>
      Promise.resolve({ ok: true, repoPath: "/tmp/work/repo", cloned: false }),
    handleIdleTaskFn: () => {
      scans.push(host);
      return Promise.resolve({
        handled: true,
        ok: true,
        summary: "GitHub Actions audit complete. Filed 6 issues.",
      });
    },
    ghCommandFn: hub.gh(host),
    stopHeartbeatFn: () => {
      beats.push(`stop:${host}`);
      return Promise.resolve();
    },
    claimRouteFn: (input, deps) =>
      claimRoutedIssue(input, {
        ...deps,
        workerIdFn: (user) => `${user}-${host}`,
        machineIdFn: () => Promise.resolve(`machine-${host}`),
        startHeartbeatFn: () => {
          beats.push(`start:${host}`);
          return Promise.resolve({ ok: true as const, value: handle });
        },
        claimIssueFn: (options) =>
          claimIssue({
            ...options,
            ghCommandFn: hub.gh(host),
            sleepFn: () => Promise.resolve(),
          }),
      }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "two hosts, one wrapper: the second host's stale issue list does not let it re-run the scan",
  async () => {
    const hub = new FakeGitHub();
    const scans: string[] = [];
    const beats: string[] = [];
    const workDir = await Deno.makeTempDir();
    const { logger: logA } = makeLogger();
    const { logger: logB, records: recordsB } = makeLogger();
    try {
      // Host B's issue list was fetched here — open, unassigned, no claim
      // marker — and it is what host B dispatches from below. The route reads
      // the live issue at claim time, which is the whole point: a stale list
      // can still offer the wrapper, and the claim is what refuses it.
      assertEquals(hub.assignees, []);
      assertEquals(hub.comments.length, 0);

      const first = await runHost(hub, "GRQ-3", scans, logA, workDir, beats);
      assertEquals(first, { routed: true, success: true });
      assertEquals(scans, ["GRQ-3"]);
      // The winner beat for the life of its scan and stopped afterwards.
      assertEquals(beats, ["start:GRQ-3", "stop:GRQ-3"]);

      // The claim host A took is visible to any other host: an assignee and a
      // fleet-authored CLAIM_LOCK comment.
      assertEquals(hub.assignees, [FLEET_USER]);
      assert(
        hub.comments.some((c) => c.body.includes(CLAIM_MARKER_PREFIX)),
        "the winning host must leave a CLAIM_LOCK marker on the wrapper",
      );

      // Host B dispatches from that stale view, minutes later.
      const second = await runHost(
        hub,
        "Mac-Ultra-M2",
        scans,
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
      // The scan ran exactly once across the fleet.
      assertEquals(scans, ["GRQ-3"]);
      // And host B wrote nothing at all to the wrapper, nor started a beat.
      assertEquals(hub.writesBy("Mac-Ultra-M2"), []);
      assertEquals(beats, ["start:GRQ-3", "stop:GRQ-3"]);
      assert(
        recordsB.some(([message]) => message === ROUTE_CLAIM_REFUSED_MESSAGE),
        "the stood-down host must say why in its log",
      );
      // The loser has nothing to release — the main loop is told so.
      assert(second.routed, "the wrapper is routed on both hosts");
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
  "two hosts claiming at once: the loser stands down, and the winner's beating heartbeat keeps a third host off",
  async () => {
    const hub = new FakeGitHub();
    const scans: string[] = [];
    const workDir = await Deno.makeTempDir();
    const { logger } = makeLogger();

    // A genuine simultaneous race: host B's pre-claim read saw an unassigned
    // issue, and host A's claim — assignee plus a CLAIM_LOCK carrying a live
    // heartbeat marker — lands one second earlier while B is posting its
    // own. Earliest CLAIM_LOCK wins.
    const nowSeconds = Math.floor(Date.now() / 1000);
    hub.onClaimComment = (host) => {
      if (host !== "Mac-Ultra-M2") return;
      hub.onClaimComment = undefined;
      hub.assignees = [FLEET_USER];
      hub.addComment(
        `${CLAIM_MARKER_PREFIX}${FLEET_USER}-GRQ-3 -->\nClaimed by GRQ-3\n` +
          formatHeartbeatMarker("machine-GRQ-3", nowSeconds),
        new Date(Date.now() - 1000).toISOString(),
      );
    };

    const outcome = await runHost(hub, "Mac-Ultra-M2", scans, logger, workDir);

    assert("claimLost" in outcome, "the losing host must report a lost claim");
    assertEquals(outcome.claimReason, "race_lost");
    assertEquals(scans, [], "a lost race must never run the scan");
    assertEquals(hub.state, "OPEN", "a lost race must never close the wrapper");
    // The loser deletes its own CLAIM_LOCK comment.
    assertEquals(
      hub.comments.filter((c) => c.body.includes("Mac-Ultra-M2")).length,
      0,
    );
    // `claimIssue`'s own lost-race cleanup unassigns `githubUser`, and the
    // whole fleet runs under one login — so the winner's assignment goes
    // with it, and the wrapper now reads as unassigned while GRQ-3 is still
    // scanning. That is precisely why the claim publishes a heartbeat: a
    // third host reading this state is refused on the live marker, not on
    // the assignee that is no longer there (Issue #214).
    assertEquals(hub.assignees, []);
    const third = await runHost(hub, "GRQ-25", scans, logger, workDir);
    await Deno.remove(workDir, { recursive: true });
    assert("claimLost" in third, "the third host must not get the wrapper");
    assertEquals(third.claimReason, "heartbeat_active");
    assertEquals(scans, [], "the scan still belongs to GRQ-3 alone");
  },
);

Deno.test(
  "a lost claim is recorded as a skip, never as an ordinary success",
  () => {
    assertEquals(
      routeRunResult({
        success: false,
        claimLost: true,
        claimReason: "already_assigned",
        claimDetail: "assigned to a sibling host",
      }),
      { success: false, skipped: true, claimNotHeld: true },
    );
    // A claim that could not be made at all is a FAILURE, not a benign
    // skip: a broken GitHub must reach the failure counters.
    assertEquals(
      routeRunResult({
        success: false,
        claimLost: true,
        claimReason: "claim_error",
        claimDetail: "gh: 503 unavailable",
      }),
      { success: false, skipped: false, claimNotHeld: true },
    );
    // A scan this host actually ran keeps its ordinary success/failure.
    assertEquals(routeRunResult({ success: true }), {
      success: true,
      skipped: false,
    });
    assertEquals(routeRunResult({ success: false }), {
      success: false,
      skipped: false,
    });
  },
);
