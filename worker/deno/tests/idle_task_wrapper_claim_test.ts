/**
 * Unit tests for `claimIdleTaskWrapper` (Issue #1139).
 *
 * The two-host behaviour this claim exists for lives in
 * `idle_task_cross_host_claim_1139_test.ts`, which drives the real
 * `claimIssue` over a shared fake GitHub. Here the concern is the module's
 * own contract: what it returns, what it refuses, and what it does when the
 * pieces it depends on fail.
 *
 * Every seam is injected — no test reads the host's machine id, writes a
 * heartbeat file, or touches `gh`.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  claimIdleTaskWrapper,
  IDLE_TASK_CLAIM_REFUSED_MESSAGE,
  isWrapperUnavailable,
} from "../lib/idle_task_wrapper_claim.ts";
import type { Logger } from "../types.ts";

const REPO = "stSoftwareAU/NEAT-AI-Lamarck";
const ISSUE = 206;
const FLEET_USER = "stservice";

const INPUT = {
  repo: REPO,
  issueNumber: ISSUE,
  githubUser: FLEET_USER,
  workDir: "/tmp/does-not-need-to-exist",
  fleetAuthors: [FLEET_USER],
  pushCapableAuthors: [FLEET_USER],
};

const HANDLE = {
  id: "h",
  repo: REPO,
  issueNumber: ISSUE,
  kind: "issue" as const,
};

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

/** Seams that succeed, so each test overrides only what it is about. */
const okDeps = (logger: Logger) => ({
  logger,
  machineIdFn: () => Promise.resolve("machine-1"),
  startHeartbeatFn: () => Promise.resolve({ ok: true as const, value: HANDLE }),
});

Deno.test(
  "claimIdleTaskWrapper - a won claim returns the worker id and a beating heartbeat",
  async () => {
    const { logger } = makeLogger();
    let seen: Record<string, unknown> = {};

    const claim = await claimIdleTaskWrapper(INPUT, {
      ...okDeps(logger),
      workerIdFn: (user) => `${user}-worker`,
      claimIssueFn: (options) => {
        seen = options as unknown as Record<string, unknown>;
        return Promise.resolve({
          ok: true as const,
          value: { claimed: true, winnerId: "stservice-worker" },
        });
      },
    });

    assert(claim.claimed);
    assertEquals(claim.workerId, "stservice-worker");
    assertEquals(claim.heartbeat, HANDLE);
    // The fleet sets and the marker options reach `claimIssue` — without
    // them the CLAIM_LOCK trust narrows and the claim carries no liveness.
    assertEquals(seen.fleetAuthors, [FLEET_USER]);
    assertEquals(seen.pushCapableAuthors, [FLEET_USER]);
    assertEquals(seen.markerOptions, {
      machineId: "machine-1",
      workDir: INPUT.workDir,
    });
  },
);

Deno.test(
  "claimIdleTaskWrapper - a refusal with no detail still names what holds the wrapper",
  async () => {
    const { logger, records } = makeLogger();

    const claim = await claimIdleTaskWrapper(INPUT, {
      ...okDeps(logger),
      claimIssueFn: () =>
        Promise.resolve({
          ok: true as const,
          value: { claimed: false, reason: "already_assigned" as const },
        }),
    });

    assert(!claim.claimed);
    assertEquals(claim.reason, "already_assigned");
    assertEquals(claim.detail, "the wrapper is assigned to another run");
    const refusal = records.find(([m]) =>
      m === IDLE_TASK_CLAIM_REFUSED_MESSAGE
    );
    assert(refusal !== undefined, "the stand-down must be logged");
    assertEquals(
      (refusal[1] as Record<string, unknown>).unavailable,
      true,
      "an assigned wrapper is unavailable, not a fault in this host",
    );
  },
);

Deno.test(
  "claimIdleTaskWrapper - fails closed when the claim call itself errors",
  async () => {
    const { logger, records } = makeLogger();

    const claim = await claimIdleTaskWrapper(INPUT, {
      ...okDeps(logger),
      claimIssueFn: () => Promise.reject(new Error("gh: 503 unavailable")),
    });

    assert(!claim.claimed);
    assertEquals(claim.reason, "claim_error");
    assert(claim.detail.includes("503"));
    const refusal = records.find(([m]) =>
      m === IDLE_TASK_CLAIM_REFUSED_MESSAGE
    );
    assert(refusal !== undefined, "a claim that could not be made must say so");
    assertEquals(
      (refusal[1] as Record<string, unknown>).unavailable,
      false,
      "a gh outage is a fault, not a wrapper someone else holds",
    );
  },
);

Deno.test(
  "claimIdleTaskWrapper - a Result-shaped claim failure is a claim_error too",
  async () => {
    const { logger } = makeLogger();

    const claim = await claimIdleTaskWrapper(INPUT, {
      ...okDeps(logger),
      claimIssueFn: () =>
        Promise.resolve({ ok: false as const, error: new Error("no route") }),
    });

    assert(!claim.claimed);
    assertEquals(claim.reason, "claim_error");
    assertEquals(claim.detail, "no route");
  },
);

Deno.test(
  "claimIdleTaskWrapper - no machine id means no liveness, so the claim is refused",
  async () => {
    // A claim with no heartbeat marker is the state this module exists to
    // prevent: drop the assignee mid-scan and a sibling host reads the
    // wrapper as free. Refuse rather than scan without liveness.
    const { logger } = makeLogger();
    let claimAttempted = false;

    const thrown = await claimIdleTaskWrapper(INPUT, {
      logger,
      machineIdFn: () => Promise.reject(new Error("no /etc/machine-id")),
      claimIssueFn: () => {
        claimAttempted = true;
        return Promise.resolve({
          ok: true as const,
          value: { claimed: true },
        });
      },
    });

    assert(!thrown.claimed);
    assertEquals(thrown.reason, "claim_error");
    assert(thrown.detail.includes("machine id"));
    assertEquals(claimAttempted, false, "no claim is made without liveness");

    const empty = await claimIdleTaskWrapper(INPUT, {
      logger,
      machineIdFn: () => Promise.resolve(""),
      claimIssueFn: () =>
        Promise.resolve({ ok: true as const, value: { claimed: true } }),
    });
    assert(!empty.claimed);
    assertEquals(empty.reason, "claim_error");
  },
);

Deno.test(
  "claimIdleTaskWrapper - a heartbeat that will not start is loud, and the claim stands",
  async () => {
    // The assignee and the claim comment's initial marker still hold the
    // wrapper, so losing the refreshes costs liveness after the marker goes
    // stale — not the claim itself. It must not pass silently.
    const { logger, records } = makeLogger();

    const claim = await claimIdleTaskWrapper(INPUT, {
      logger,
      machineIdFn: () => Promise.resolve("machine-1"),
      startHeartbeatFn: () =>
        Promise.resolve({ ok: false as const, error: new Error("EACCES") }),
      claimIssueFn: () =>
        Promise.resolve({ ok: true as const, value: { claimed: true } }),
    });

    assert(claim.claimed);
    assertEquals(claim.heartbeat, undefined);
    assert(
      records.some(([m, c]) =>
        m.includes("heartbeat did not start") &&
        String((c as Record<string, unknown>).error).includes("EACCES")
      ),
      "a heartbeat that will not start must be reported",
    );
  },
);

Deno.test(
  "claimIdleTaskWrapper - a heartbeat that throws is caught and reported",
  async () => {
    const { logger, records } = makeLogger();

    const claim = await claimIdleTaskWrapper(INPUT, {
      logger,
      machineIdFn: () => Promise.resolve("machine-1"),
      startHeartbeatFn: () => {
        throw new Error("interval registry full");
      },
      claimIssueFn: () =>
        Promise.resolve({ ok: true as const, value: { claimed: true } }),
    });

    assert(claim.claimed);
    assertEquals(claim.heartbeat, undefined);
    assert(
      records.some(([m]) => m.includes("heartbeat threw")),
      "a throwing heartbeat must be reported, not swallowed",
    );
  },
);

Deno.test("isWrapperUnavailable - held-or-unclaimable versus fault", () => {
  for (
    const reason of [
      "already_assigned",
      "recent_claim",
      "heartbeat_active",
      "race_lost",
      "fleet_pr_exists",
      "blocking_label",
      "already_closed",
    ] as const
  ) {
    assertEquals(isWrapperUnavailable(reason), true, reason);
  }
  for (
    const reason of [
      "claim_error",
      "api_error",
      "not_assignable",
      "forbidden",
      "not_found",
      "comment_failed",
      "verification_failed",
    ] as const
  ) {
    assertEquals(isWrapperUnavailable(reason), false, reason);
  }
});
