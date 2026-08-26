/**
 * Resolving the supervisor's wall-clock cap into an extension ceiling
 * (Issue #421, parent #397).
 *
 * `loop.sh` owns the cap (`VIBE_RUN_MAX_SECONDS`, applied by `timeout`) and
 * now publishes it — with the run's start epoch — into the worker
 * environment. This module turns that pair into the absolute epoch-ms past
 * which no extension grant may be issued, holding back the SIGTERM→commit→
 * push window so the worker's own kill lands before the supervisor's.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  describeRunHardCap,
  resolveRunHardCap,
  WIP_CHECKPOINT_RESERVE_SECONDS,
} from "../lib/run_hard_cap.ts";

const STARTED_EPOCH_SECONDS = 1_700_000_000;
const STARTED_MS = STARTED_EPOCH_SECONDS * 1000;

/** An env reader over a fixed map, as the launcher would supply. */
function env(
  values: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => values[name];
}

Deno.test("resolveRunHardCap - a real cap yields a ceiling with the shutdown reserve held back", () => {
  const resolution = resolveRunHardCap({
    env: env({
      VIBE_RUN_MAX_SECONDS: "10800",
      VIBE_RUN_STARTED_EPOCH: String(STARTED_EPOCH_SECONDS),
    }),
    killAfterSeconds: 30,
  });

  assert(
    resolution.capped,
    `expected a cap, got: ${JSON.stringify(resolution)}`,
  );
  if (!resolution.capped) return;
  const { cap } = resolution;
  assertEquals(cap.supervisorDeadlineMs, STARTED_MS + 10800 * 1000);
  assertEquals(cap.reserveSeconds, 30 + WIP_CHECKPOINT_RESERVE_SECONDS);
  assertEquals(
    cap.ceilingMs,
    STARTED_MS + (10800 - 30 - WIP_CHECKPOINT_RESERVE_SECONDS) * 1000,
  );
  assert(
    cap.ceilingMs < cap.supervisorDeadlineMs,
    "the worker's own kill must land before the supervisor's",
  );
});

Deno.test("resolveRunHardCap - the reserve is configurable and always inside the cap", () => {
  const resolution = resolveRunHardCap({
    env: env({
      VIBE_RUN_MAX_SECONDS: "3600",
      VIBE_RUN_STARTED_EPOCH: String(STARTED_EPOCH_SECONDS),
    }),
    killAfterSeconds: 45,
    checkpointReserveSeconds: 300,
  });
  assert(resolution.capped);
  if (!resolution.capped) return;
  assertEquals(resolution.cap.reserveSeconds, 345);
  assertEquals(resolution.cap.ceilingMs, STARTED_MS + (3600 - 345) * 1000);
});

Deno.test("resolveRunHardCap - VIBE_RUN_MAX_SECONDS=0 means disabled, never 'cap at zero'", () => {
  const resolution = resolveRunHardCap({
    env: env({
      VIBE_RUN_MAX_SECONDS: "0",
      VIBE_RUN_STARTED_EPOCH: String(STARTED_EPOCH_SECONDS),
    }),
    killAfterSeconds: 30,
  });
  assertEquals(resolution.capped, false);
  if (resolution.capped) return;
  assert(
    resolution.reason.includes("disables the supervisor cap"),
    `the reason must say the cap is disabled: ${resolution.reason}`,
  );
});

Deno.test("resolveRunHardCap - absent environment means no ceiling and no crash", () => {
  const cases: Array<Record<string, string>> = [
    {},
    { VIBE_RUN_MAX_SECONDS: "5400" },
    { VIBE_RUN_STARTED_EPOCH: String(STARTED_EPOCH_SECONDS) },
  ];
  for (const values of cases) {
    const resolution = resolveRunHardCap({
      env: env(values),
      killAfterSeconds: 30,
    });
    assertEquals(
      resolution.capped,
      false,
      `expected no ceiling for ${JSON.stringify(values)}`,
    );
  }
});

Deno.test("resolveRunHardCap - unusable values are refused rather than silently unbounding", () => {
  const cases: Array<[string, string]> = [
    ["not-a-number", String(STARTED_EPOCH_SECONDS)],
    ["-1", String(STARTED_EPOCH_SECONDS)],
    ["5400", "not-a-number"],
    ["5400", "0"],
    // Epoch-milliseconds where seconds are expected: accepting it would put
    // the ceiling ~50 000 years out, which is unbounded by another name.
    ["5400", String(STARTED_MS)],
  ];
  for (const [maxSeconds, startedEpoch] of cases) {
    const resolution = resolveRunHardCap({
      env: env({
        VIBE_RUN_MAX_SECONDS: maxSeconds,
        VIBE_RUN_STARTED_EPOCH: startedEpoch,
      }),
      killAfterSeconds: 30,
    });
    assertEquals(
      resolution.capped,
      false,
      `expected no ceiling for max=${maxSeconds} start=${startedEpoch}`,
    );
    if (resolution.capped) continue;
    assert(
      resolution.reason.length > 0,
      "an unusable value must explain itself in the log",
    );
  }
});

Deno.test("resolveRunHardCap - a cap smaller than the reserve leaves no runway, it does not invert", () => {
  const resolution = resolveRunHardCap({
    env: env({
      VIBE_RUN_MAX_SECONDS: "60",
      VIBE_RUN_STARTED_EPOCH: String(STARTED_EPOCH_SECONDS),
    }),
    killAfterSeconds: 30,
    checkpointReserveSeconds: 120,
  });
  assert(resolution.capped);
  if (!resolution.capped) return;
  // The ceiling is at or before the run start: every grant is refused, which
  // is the fail-safe direction.
  assert(
    resolution.cap.ceilingMs <= STARTED_MS,
    "a cap inside the reserve must refuse extensions, not extend backwards",
  );
});

Deno.test("describeRunHardCap - the run-start line names the cap, the reserve and the runway", () => {
  const resolution = resolveRunHardCap({
    env: env({
      VIBE_RUN_MAX_SECONDS: "10800",
      VIBE_RUN_STARTED_EPOCH: String(STARTED_EPOCH_SECONDS),
    }),
    killAfterSeconds: 30,
  });
  const line = describeRunHardCap(resolution, STARTED_MS + 600_000);
  assert(line.includes("10800s"), `cap missing: ${line}`);
  assert(line.includes("150s"), `reserve missing: ${line}`);
  assert(line.includes("VIBE_RUN_MAX_SECONDS"), `source missing: ${line}`);
});

Deno.test("describeRunHardCap - an absent cap says so rather than reading as bounded", () => {
  const resolution = resolveRunHardCap({ env: env({}), killAfterSeconds: 30 });
  const line = describeRunHardCap(resolution, STARTED_MS);
  assert(
    line.toLowerCase().includes("no ceiling"),
    `an unbounded run must say so: ${line}`,
  );
});
