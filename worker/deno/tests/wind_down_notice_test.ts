/**
 * Tests for the wind-down notice (Issue #508).
 *
 * An agent approaching the run hard cap is told the remaining budget so it can
 * stop waiting on a long job, record what it has learnt and leave a resumable
 * note — instead of being SIGKILLed mid-poll with no account of what it was
 * waiting for.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildWindDownNotice,
  clearWindDownNotice,
  DEFAULT_WIND_DOWN_SECONDS,
  noticeOrdersWindDown,
  shouldWindDown,
  shouldWriteRunBudgetNotice,
  WIND_DOWN_NOTICE_FILENAME,
  WIND_DOWN_PROMPT_SECTION,
  writeWindDownNotice,
} from "../lib/wind_down_notice.ts";
import { GATE_SKIP_MARKER } from "../lib/quality_gate_budget.ts";

Deno.test("shouldWindDown - fires at and under the window, not above it", () => {
  assertEquals(shouldWindDown(601, 600), false);
  assertEquals(shouldWindDown(600, 600), true);
  assertEquals(shouldWindDown(0, 600), true);
  assertEquals(
    shouldWindDown(DEFAULT_WIND_DOWN_SECONDS),
    true,
    "the default window applies when none is configured",
  );
});

Deno.test("buildWindDownNotice - names the remaining budget and what to do with it", () => {
  const notice = buildWindDownNotice({
    remainingSeconds: 420,
    elapsedSeconds: 5_400,
    extensionsGranted: 3,
  });
  assert(
    notice.includes("420"),
    `the remaining budget must be stated: ${notice}`,
  );
  assert(notice.includes("5400"), "the elapsed time must be stated");
  assert(notice.includes("3"), "the extensions granted must be stated");
  assert(
    /stop waiting/i.test(notice),
    "the agent must be told to stop waiting on the long job",
  );
  assert(
    /commit/i.test(notice),
    "the agent must be told to preserve its work in progress",
  );
});

// Issue #1138 — the notice is the one channel that can stop an agent starting
// a 15-minute gate with 7 minutes left. It has to reach the agent while there
// is still more runway than the wind-down window, because that is exactly the
// band in which a gate is started and never finishes.

Deno.test("shouldWriteRunBudgetNotice - fires while the gate no longer fits, above the wind-down window (Issue #1138)", () => {
  // 1000s left: too much to be "winding down", far too little for a 900s gate
  // plus the tail. This is the band the measurements found agents dying in.
  assertEquals(shouldWindDown(1000, 600), false);
  assertEquals(shouldWriteRunBudgetNotice(1000, 600), true);
});

Deno.test("shouldWriteRunBudgetNotice - stays quiet on a run with runway for both (Issue #1138)", () => {
  assertEquals(shouldWriteRunBudgetNotice(3600, 600), false);
  // A repo with a fast gate goes quiet much sooner than one with a slow gate.
  assertEquals(shouldWriteRunBudgetNotice(1000, 600, 60), false);
  assertEquals(shouldWriteRunBudgetNotice(1000, 600, 2400), true);
});

Deno.test("buildWindDownNotice - a gate-only notice does not order a wind-down (Issue #1138)", () => {
  const notice = buildWindDownNotice({
    remainingSeconds: 1000,
    elapsedSeconds: 2600,
    extensionsGranted: 1,
  });
  assert(
    /do not start the full quality gate/i.test(notice),
    `the gate must be refused: ${notice}`,
  );
  assertEquals(
    /wind down now/i.test(notice),
    false,
    `a run with 1000s left is not winding down: ${notice}`,
  );
  assert(
    /1000/.test(notice),
    "the remaining budget must still be stated",
  );
});

Deno.test("buildWindDownNotice - refuses the full gate when the budget cannot cover it (Issue #1138)", () => {
  const notice = buildWindDownNotice({
    remainingSeconds: 420,
    elapsedSeconds: 5_400,
    extensionsGranted: 3,
  });
  assert(
    /do not start the full quality gate/i.test(notice),
    `the notice must refuse the gate outright: ${notice}`,
  );
  assert(
    notice.includes(GATE_SKIP_MARKER),
    `the notice must give the agent the line that records the skip: ${notice}`,
  );
});

Deno.test("buildWindDownNotice - stays silent about the gate when the budget still covers it (Issue #1138)", () => {
  const notice = buildWindDownNotice({
    remainingSeconds: 3_600,
    elapsedSeconds: 600,
    extensionsGranted: 0,
    typicalGateSeconds: 300,
  });
  assertEquals(
    /quality gate/i.test(notice),
    false,
    `a gate that fits must not be discouraged: ${notice}`,
  );
});

Deno.test("buildWindDownNotice - a measured gate duration decides the refusal (Issue #1138)", () => {
  // 900s left is plenty for a 60s gate and nowhere near enough for a 40m one.
  const short = buildWindDownNotice({
    remainingSeconds: 900,
    elapsedSeconds: 3_000,
    extensionsGranted: 1,
    typicalGateSeconds: 60,
  });
  assertEquals(/do not start the full quality gate/i.test(short), false);

  const long = buildWindDownNotice({
    remainingSeconds: 900,
    elapsedSeconds: 3_000,
    extensionsGranted: 1,
    typicalGateSeconds: 2_400,
  });
  assert(/do not start the full quality gate/i.test(long));
});

Deno.test("noticeOrdersWindDown - only a wind-down notice counts as a warning (Issue #1138)", () => {
  // The handover note reads this to say whether the run was warned. A
  // gate-refusal notice is not a warning, and claiming otherwise would tell
  // the next run its predecessor stopped knowingly when it did not.
  const gateOnly = buildWindDownNotice({
    remainingSeconds: 1000,
    elapsedSeconds: 2600,
    extensionsGranted: 1,
  });
  const windingDown = buildWindDownNotice({
    remainingSeconds: 300,
    elapsedSeconds: 3300,
    extensionsGranted: 2,
  });
  assertEquals(noticeOrdersWindDown(gateOnly), false);
  assertEquals(noticeOrdersWindDown(windingDown), true);
});

Deno.test("writeWindDownNotice - writes the notice where the agent can read it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wind_down_" });
  try {
    await writeWindDownNotice(dir, {
      remainingSeconds: 300,
      elapsedSeconds: 7_200,
      extensionsGranted: 4,
    });
    const written = await Deno.readTextFile(
      `${dir}/${WIND_DOWN_NOTICE_FILENAME}`,
    );
    assert(written.includes("300"), written);

    // Refreshed in place as the runway shrinks — one file, never a pile.
    await writeWindDownNotice(dir, {
      remainingSeconds: 120,
      elapsedSeconds: 7_400,
      extensionsGranted: 4,
    });
    const refreshed = await Deno.readTextFile(
      `${dir}/${WIND_DOWN_NOTICE_FILENAME}`,
    );
    assert(refreshed.includes("120"), refreshed);
    assert(!refreshed.includes("remaining: 300s"), "stale text must be gone");
    const entries: string[] = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
    assertEquals(entries, [WIND_DOWN_NOTICE_FILENAME]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeWindDownNotice - a directory that cannot be written fails loud", async () => {
  let threw = false;
  try {
    await writeWindDownNotice("/nonexistent-dir-for-508", {
      remainingSeconds: 60,
      elapsedSeconds: 100,
      extensionsGranted: 0,
    });
  } catch {
    threw = true;
  }
  assert(threw, "a failed write must surface, never be swallowed");
});

Deno.test("clearWindDownNotice - a notice from the last run never reaches the next agent", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wind_down_stale_" });
  try {
    await writeWindDownNotice(dir, {
      remainingSeconds: 60,
      elapsedSeconds: 10_000,
      extensionsGranted: 7,
    });
    await clearWindDownNotice(dir);
    let found = true;
    try {
      await Deno.stat(`${dir}/${WIND_DOWN_NOTICE_FILENAME}`);
    } catch {
      found = false;
    }
    assertEquals(found, false, "the stale notice must be gone");
    // Clearing a checkout that never had one is a no-op, not a failure.
    await clearWindDownNotice(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("WIND_DOWN_PROMPT_SECTION - tells the agent the file exists and never to commit it", () => {
  assert(
    WIND_DOWN_PROMPT_SECTION.includes(WIND_DOWN_NOTICE_FILENAME),
    "the agent must be told the exact filename to read",
  );
  assert(
    /never commit|do not commit/i.test(WIND_DOWN_PROMPT_SECTION),
    "the notice is worker state, not a deliverable",
  );
});

Deno.test("the notice file is hidden, so the enforced .gitignore keeps it out of every commit", () => {
  assert(
    WIND_DOWN_NOTICE_FILENAME.startsWith("."),
    "gitignore_enforcer.ts ignores every hidden path by default",
  );
});
