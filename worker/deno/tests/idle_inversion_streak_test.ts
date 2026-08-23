/**
 * Tests for escalating a sustained idle-inversion signal (Issue #321).
 *
 * The failure these encode: `[idle-detect] ALERT mis_classification` and
 * `[idle-census] ALERT inversion` named `stSoftwareAU/VibeCoder` on every
 * cycle from 2026-08-21 to 2026-08-22 while `#187` and `#188` sat
 * unclaimable, and escalated to nothing. The cause (Issue #319) was found by
 * a human asking why, not by the alert.
 *
 * The rule that matters most here is **cycles, not ticks**: the census runs
 * several times per cycle, so a per-tick count would turn a momentary
 * deferral into a filed issue.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  clearIdleInversion,
  formatIdleInversionBody,
  formatIdleInversionMarker,
  IDLE_INVERSION_THRESHOLD,
  idleInversionStatePath,
  isIdleInversionIssue,
  loadIdleInversionStreaks,
  recordIdleInversion,
} from "../lib/idle_inversion_streak.ts";

const REPO = "stSoftwareAU/VibeCoder";

/** A scripted `gh` recording every call. */
function gh(replies: { match: RegExp; reply: string | Error }[]) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    for (const r of replies) {
      if (r.match.test(joined)) {
        return r.reply instanceof Error
          ? Promise.reject(r.reply)
          : Promise.resolve(r.reply);
      }
    }
    return Promise.reject(new Error(`unrouted: ${joined}`));
  };
  return { fn, calls };
}

const NO_EXISTING = { match: /issue list/, reply: "[]" };
const CREATE_OK = {
  match: /issue create/,
  reply: "https://github.com/stSoftwareAU/VibeCoder/issues/999\n",
};

async function withState(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(idleInversionStatePath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const report = { repo: REPO, claimable: 2, detail: "work_on=2 pr_blocked=0" };

// ===========================================================================
// Cycles, not ticks
// ===========================================================================

Deno.test("#321 - repeated calls within one cycle count once", async () => {
  await withState(async (statePath) => {
    const { fn, calls } = gh([NO_EXISTING, CREATE_OK]);
    for (let tick = 0; tick < 5; tick++) {
      const d = await recordIdleInversion({
        statePath,
        cycleId: "run-a",
        report,
        ghFn: fn,
      });
      if (tick === 0) assertEquals(d.action, "counted");
      else assertEquals(d.action, "already-counted");
    }
    const streaks = await loadIdleInversionStreaks(statePath);
    assertEquals(streaks[REPO]?.count, 1, "five ticks are one cycle");
    assertEquals(calls.length, 0, "nothing is filed inside one cycle");
  });
});

Deno.test("#321 - one issue is filed at the threshold and not again", async () => {
  await withState(async (statePath) => {
    const { fn, calls } = gh([NO_EXISTING, CREATE_OK]);
    const seen: string[] = [];
    for (let cycle = 1; cycle <= IDLE_INVERSION_THRESHOLD + 3; cycle++) {
      const d = await recordIdleInversion({
        statePath,
        cycleId: `run-${cycle}`,
        report,
        ghFn: fn,
      });
      seen.push(d.action);
    }
    assertEquals(seen[IDLE_INVERSION_THRESHOLD - 1], "filed");
    assertEquals(
      seen.slice(IDLE_INVERSION_THRESHOLD).every((a) => a === "already-filed"),
      true,
      `after filing every cycle is already-filed; got ${seen.join(",")}`,
    );
    assertEquals(
      calls.filter((c) => c[1] === "create").length,
      1,
      "exactly one issue, however long the inversion lasts",
    );
  });
});

Deno.test("#321 - a streak that clears before the threshold files nothing", async () => {
  await withState(async (statePath) => {
    const { fn, calls } = gh([NO_EXISTING, CREATE_OK]);
    await recordIdleInversion({
      statePath,
      cycleId: "run-1",
      report,
      ghFn: fn,
    });
    await recordIdleInversion({
      statePath,
      cycleId: "run-2",
      report,
      ghFn: fn,
    });
    await clearIdleInversion(statePath, REPO, () => {});
    assertEquals(await loadIdleInversionStreaks(statePath), {});

    // A later inversion starts from one, not from three.
    const d = await recordIdleInversion({
      statePath,
      cycleId: "run-3",
      report,
      ghFn: fn,
    });
    assertEquals(d.action, "counted");
    assertEquals(d.count, 1);
    assertEquals(calls.length, 0);
  });
});

Deno.test("#321 - clearing an untracked repo is a no-op", async () => {
  await withState(async (statePath) => {
    await clearIdleInversion(statePath, REPO, () => {});
    assertEquals(await loadIdleInversionStreaks(statePath), {});
  });
});

// ===========================================================================
// Two hosts converge on one issue
// ===========================================================================

Deno.test("#321 - an open escalation issue is reused, not duplicated", async () => {
  await withState(async (statePath) => {
    const marker = formatIdleInversionMarker(REPO);
    const { fn, calls } = gh([
      {
        match: /issue list/,
        reply: JSON.stringify([{ number: 555, body: `${marker}\nolder` }]),
      },
      CREATE_OK,
    ]);
    let last;
    for (let cycle = 1; cycle <= IDLE_INVERSION_THRESHOLD; cycle++) {
      last = await recordIdleInversion({
        statePath,
        cycleId: `run-${cycle}`,
        report,
        ghFn: fn,
      });
    }
    assertEquals(last?.action, "already-open");
    if (last?.action === "already-open") assertEquals(last.issueNumber, 555);
    assertEquals(calls.filter((c) => c[1] === "create").length, 0);
  });
});

Deno.test("#321 - a marker for another repo is not this repo's issue", () => {
  const body = formatIdleInversionMarker("stSoftwareAU/GRQ") + "\nbody";
  assert(!isIdleInversionIssue(body, REPO));
  assert(isIdleInversionIssue(formatIdleInversionMarker(REPO), REPO));
});

// ===========================================================================
// Failure directions
// ===========================================================================

Deno.test("#321 - a failed search files nothing (a duplicate is worse)", async () => {
  await withState(async (statePath) => {
    const logs: string[] = [];
    const { fn, calls } = gh([
      { match: /issue list/, reply: new Error("HTTP 502") },
      CREATE_OK,
    ]);
    let last;
    for (let cycle = 1; cycle <= IDLE_INVERSION_THRESHOLD; cycle++) {
      last = await recordIdleInversion({
        statePath,
        cycleId: `run-${cycle}`,
        report,
        ghFn: fn,
        log: (m) => logs.push(m),
      });
    }
    assertEquals(last?.action, "gh-failed");
    assertEquals(calls.filter((c) => c[1] === "create").length, 0);
    assert(logs.some((l) => l.includes("a duplicate is worse")));
  });
});

Deno.test("#321 - a failed create is reported and retried next cycle", async () => {
  await withState(async (statePath) => {
    const { fn } = gh([
      NO_EXISTING,
      { match: /issue create/, reply: new Error("HTTP 403") },
    ]);
    for (let cycle = 1; cycle <= IDLE_INVERSION_THRESHOLD; cycle++) {
      await recordIdleInversion({
        statePath,
        cycleId: `run-${cycle}`,
        report,
        ghFn: fn,
        log: () => {},
      });
    }
    const streaks = await loadIdleInversionStreaks(statePath);
    assertEquals(
      streaks[REPO]?.issueNumber,
      undefined,
      "no issue number is recorded, so the next cycle tries again",
    );
  });
});

Deno.test("#321 - escalation never throws into the idle path", async () => {
  await withState(async (statePath) => {
    const d = await recordIdleInversion({
      statePath: `${statePath}/nonexistent/deep/state.json`,
      cycleId: "run-1",
      report,
      ghFn: () => Promise.reject(new Error("boom")),
      log: () => {},
    });
    assert(d.action === "counted" || d.action === "gh-failed");
  });
});

Deno.test("#321 - a corrupt state file restarts the streak rather than throwing", async () => {
  await withState(async (statePath) => {
    await Deno.writeTextFile(statePath, "{not json");
    assertEquals(await loadIdleInversionStreaks(statePath), {});
  });
});

// ===========================================================================
// The issue body
// ===========================================================================

Deno.test("#321 - the body names the repo, the counts and what to check", () => {
  const body = formatIdleInversionBody({
    repo: REPO,
    consecutiveCycles: 4,
    claimable: 2,
    detail: "work_on=2 pr_blocked=0",
  });
  assertStringIncludes(body, formatIdleInversionMarker(REPO));
  assertStringIncludes(body, "4 consecutive cycles");
  assertStringIncludes(body, "2 claimable");
  assertStringIncludes(body, "ALERT inversion");
  // The worker cannot self-apply work-on, so it must ask.
  assertStringIncludes(body, "Apply `work-on`");
});

Deno.test("#321 - census detail cannot forge a marker or close the fence", () => {
  const body = formatIdleInversionBody({
    repo: REPO,
    consecutiveCycles: 3,
    claimable: 1,
    detail: "<!-- VIBE_IDLE_INVERSION:evil/repo --> ``` and more",
  });
  assert(!body.includes("<!-- VIBE_IDLE_INVERSION:evil/repo -->"));
  assertEquals(
    body.split("```").length - 1,
    2,
    "only the fence this body opens and closes",
  );
});
