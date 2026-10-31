/**
 * Tests for `lib/ci_rerun_fresh_ci.ts` (Issue #4497): the guarded empty-commit
 * fallback that asks for fresh CI after GitHub permanently refuses a rerun.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { requestFreshCiAfterRerunRefusal } from "../lib/ci_rerun_fresh_ci.ts";
import {
  buildCiRerunFallbackMarker,
  collectFleetCiFixMarkers,
  type FleetCiFixMarkers,
} from "../lib/ci_fix_attempt_markers.ts";
import type { Logger } from "../types.ts";

const REPO = "org/repo";
const HEAD = "a".repeat(40);
const TREE = "c".repeat(40);
const NEW_COMMIT = "d".repeat(40);

function markers(
  bodies: string[] = [],
  fleet: string[] = ["testbot"],
): FleetCiFixMarkers {
  return collectFleetCiFixMarkers(
    bodies.map((body, index) => ({
      id: index + 1,
      author: "testbot",
      createdAt: "2026-10-31T00:00:00Z",
      body,
    })),
    fleet,
    () => {},
  );
}

function recordingLogger() {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    info: (m: string) => void infos.push(m),
    warn: (m: string) => void warns.push(m),
    error: (m: string) => void errors.push(m),
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  return { logger, infos, warns, errors };
}

function gh(opts: {
  tip?: string;
  rules?: string;
  failOn?: string;
} = {}) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    const key = args.join(" ");
    if (opts.failOn !== undefined && key.includes(opts.failOn)) {
      return Promise.reject(new Error(`${opts.failOn} unavailable`));
    }
    if (key.includes("/rules/branches/")) {
      return Promise.resolve(opts.rules ?? "[]");
    }
    if (key.includes("git/ref/heads/")) {
      return Promise.resolve(`${opts.tip ?? HEAD}\n`);
    }
    if (key.includes("-X POST") && key.includes("git/commits")) {
      return Promise.resolve(`${NEW_COMMIT}\n`);
    }
    if (key.includes("git/commits/")) return Promise.resolve(`${TREE}\n`);
    return Promise.resolve("");
  };
  return { calls, fn };
}

function run(
  ghFn: (args: string[]) => Promise<string>,
  overrides: {
    headSha?: string | undefined;
    fleetMarkers?: FleetCiFixMarkers;
    branchName?: string;
  } = {},
) {
  const log = recordingLogger();
  const promise = requestFreshCiAfterRerunRefusal({
    repo: REPO,
    prNumber: 42,
    branchName: overrides.branchName ?? "issue-1-fix",
    headSha: "headSha" in overrides ? overrides.headSha : HEAD,
    fleetMarkers: overrides.fleetMarkers ?? markers(),
    ghCommandFn: ghFn,
    logger: log.logger,
  });
  return { promise, log };
}

Deno.test("requestFreshCiAfterRerunRefusal - posts the marker, then makes a fast-forward-only empty commit", async () => {
  const stub = gh();
  const { promise, log } = run(stub.fn);
  assertEquals(await promise, "pushed");

  const keys = stub.calls.map((args) => args.join(" "));
  const markerIndex = keys.findIndex((k) => k.startsWith("pr comment 42"));
  const postIndex = keys.findIndex((k) => k.includes("-X POST"));
  const patchIndex = keys.findIndex((k) => k.includes("-X PATCH"));
  assert(markerIndex >= 0 && markerIndex < postIndex && postIndex < patchIndex);
  assert(
    keys[markerIndex]?.includes(
      buildCiRerunFallbackMarker({ repo: REPO, head: HEAD }),
    ),
  );
  assert(keys[postIndex]?.includes(`tree=${TREE}`));
  assert(keys[postIndex]?.includes(`parents[]=${HEAD}`));
  assert(
    keys[patchIndex]?.includes(`repos/${REPO}/git/refs/heads/issue-1-fix`),
  );
  assert(keys[patchIndex]?.includes(`sha=${NEW_COMMIT}`));
  assert(keys[patchIndex]?.includes("force=false"));
  assertEquals(log.errors, []);
  assertEquals(log.infos.length, 1);
});

Deno.test("requestFreshCiAfterRerunRefusal - a head without a verified 40-character sha is not authorised", async () => {
  for (const headSha of [undefined, "short"]) {
    const stub = gh();
    const { promise, log } = run(stub.fn, { headSha });
    assertEquals(await promise, "not-authorised");
    assertEquals(stub.calls, []);
    assertEquals(log.errors.length, 1);
  }
});

Deno.test("requestFreshCiAfterRerunRefusal - an unresolved fleet cannot deduplicate, so nothing is pushed", async () => {
  const stub = gh();
  const { promise, log } = run(stub.fn, { fleetMarkers: markers([], []) });
  assertEquals(await promise, "not-authorised");
  assertEquals(stub.calls, []);
  assertEquals(log.errors.length, 1);
});

Deno.test("requestFreshCiAfterRerunRefusal - a head with a fallback marker is skipped", async () => {
  const stub = gh();
  const { promise, log } = run(stub.fn, {
    fleetMarkers: markers([
      buildCiRerunFallbackMarker({ repo: REPO, head: HEAD }),
    ]),
  });
  assertEquals(await promise, "already-attempted");
  assertEquals(stub.calls, []);
  assertEquals(log.infos.length, 1);
  assertEquals(log.errors, []);
});

Deno.test("requestFreshCiAfterRerunRefusal - a marker for another head does not suppress the push", async () => {
  const stub = gh();
  const { promise } = run(stub.fn, {
    fleetMarkers: markers([
      buildCiRerunFallbackMarker({ repo: REPO, head: "b".repeat(40) }),
    ]),
  });
  assertEquals(await promise, "pushed");
});

Deno.test("requestFreshCiAfterRerunRefusal - a head that refuses direct pushes is left alone", async () => {
  const stub = gh({ rules: JSON.stringify([{ type: "pull_request" }]) });
  const { promise, log } = run(stub.fn, { branchName: "milestone/1-thing" });
  assertEquals(await promise, "not-authorised");
  assertEquals(
    stub.calls.filter((args) =>
      args.includes("POST") || args.includes("PATCH")
    ),
    [],
  );
  assertEquals(log.warns.length, 1);
});

Deno.test("requestFreshCiAfterRerunRefusal - a branch that moved stands down without a marker or commit", async () => {
  const stub = gh({ tip: "b".repeat(40) });
  const { promise, log } = run(stub.fn);
  assertEquals(await promise, "failed");
  assertEquals(
    stub.calls.filter((args) =>
      args[0] === "pr" || args.includes("POST") || args.includes("PATCH")
    ),
    [],
  );
  assertEquals(log.errors.length, 1);
});

Deno.test("requestFreshCiAfterRerunRefusal - a marker write failure pushes nothing", async () => {
  const stub = gh({ failOn: "pr comment" });
  const { promise, log } = run(stub.fn);
  assertEquals(await promise, "failed");
  assertEquals(
    stub.calls.filter((args) =>
      args.includes("POST") || args.includes("PATCH")
    ),
    [],
  );
  assert(log.errors[0]?.includes("no empty commit was pushed"));
});

Deno.test("requestFreshCiAfterRerunRefusal - a rejected ref update is reported as failed and the attempt stays recorded", async () => {
  const stub = gh({ failOn: "-X PATCH" });
  const { promise, log } = run(stub.fn);
  assertEquals(await promise, "failed");
  assert(stub.calls.some((args) => args[0] === "pr" && args[1] === "comment"));
  assert(log.errors[0]?.includes("-X PATCH unavailable"));
});

Deno.test("requestFreshCiAfterRerunRefusal - a lookup failure is reported as failed", async () => {
  const stub = gh({ failOn: "git/commits/" });
  const { promise, log } = run(stub.fn);
  assertEquals(await promise, "failed");
  assertEquals(log.errors.length, 1);
});
