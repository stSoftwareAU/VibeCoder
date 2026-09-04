/**
 * Tests for escalating idle capacity that files no idle task (Issue #1052).
 *
 * The failure these encode: between 2026-08-26 and 2026-09-04 the fleet filed
 * no `idle-task` issue at all — zero open across eighteen repos — while
 * `slot_idle_accounting.ts` measured a slot doing nothing
 * (`occupied_pct=10.6 idle_pct=31.4`, `occupied_by_slot=s2=171s`) and
 * `run_core.ts` logged `skipping=idle-task-filer
 * reason=audit_found_claimable claimable_total=24` on every cycle. Three
 * correct instruments, all ending at `log(...)`, and ten days of silence.
 *
 * The rules that matter most here are **both halves must hold** — a busy
 * fleet and a genuinely quiet one each trip one half and neither escalates —
 * and **the episode survives a restart**, which is precisely what made the
 * in-memory counter of Issue #1051 inert.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  describeIdleHooksRefusal,
  formatIdleStarvationMarker,
  IDLE_STARVATION_TARGET_REPO,
  idleStarvationStatePath,
  isIdleStarvationIssue,
  loadIdleStarvationEpisode,
  recordIdleStarvationObservation,
} from "../lib/idle_starvation_escalation.ts";

const HOUR_MS = 3_600_000;

/** 2026-08-26T00:00:00Z — the day the last idle task was created. */
const START_MS = Date.UTC(2026, 7, 26, 0, 0, 0);

/** The `slot-utilisation:` line the incident actually recorded. */
const SLOT_LINE = "slot-utilisation: slots=2 wall=808s available=1616s " +
  "occupied=171s occupied_pct=10.6 idle=507s idle_pct=31.4 blocked=0s " +
  "unstaffed=937s occupied_by_slot=s2=171s idle_by_slot=s1=507s " +
  "blocked_by_reason=none blocked_stops=none";

/** A per-repo availability census, one line per monitored repo. */
const CENSUS_LINES = Array.from(
  { length: 18 },
  (_, i) =>
    `[idle-census] repo=stSoftwareAU/repo${i} availability=available ` +
    `scanned=true work_on=1 idle_task=0 inversion_signal=true`,
);

const EVIDENCE = {
  slotUtilisation: SLOT_LINE,
  refusalReason: "audit_found_claimable",
  claimableTotal: 24,
  censusLines: CENSUS_LINES,
};

/**
 * A `gh` fake that models the rules the real search applies: it honours the
 * `--search "<marker>" in:body` term and the `--state open` filter, so a
 * lookup asked with the wrong marker receives a truthfully wrong answer.
 * Issues it creates are visible to every host sharing the fake, which is how
 * the two-host dedup test observes real convergence.
 */
function fleetGh() {
  const issues: { number: number; body: string; open: boolean }[] = [];
  const calls: string[][] = [];
  let next = 900;
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    const repo = args[args.indexOf("--repo") + 1];
    if (repo !== IDLE_STARVATION_TARGET_REPO) {
      return Promise.reject(new Error(`unexpected repo: ${repo}`));
    }
    if (args[1] === "list") {
      const searchIdx = args.indexOf("--search");
      const term = searchIdx < 0
        ? ""
        : args[searchIdx + 1]!.replace(/"/g, "").replace(/\s*in:body$/, "");
      const openOnly = args[args.indexOf("--state") + 1] === "open";
      const rows = issues
        .filter((i) => (openOnly ? i.open : true) && i.body.includes(term))
        .map((i) => ({ number: i.number, body: i.body }));
      return Promise.resolve(JSON.stringify(rows));
    }
    if (args[1] === "create") {
      const number = next++;
      issues.push({
        number,
        body: args[args.indexOf("--body") + 1]!,
        open: true,
      });
      return Promise.resolve(
        `https://github.com/${IDLE_STARVATION_TARGET_REPO}/issues/${number}\n`,
      );
    }
    return Promise.reject(new Error(`unrouted: ${args.join(" ")}`));
  };
  const creates = () => calls.filter((c) => c[1] === "create");
  return { fn, calls, creates, issues };
}

async function withState(
  fn: (path: string, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(idleStarvationStatePath(dir), dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** One observation with the incident's evidence attached. */
function observe(opts: {
  hour: number;
  idleSlotSeconds: number;
  openIdleTasks?: number;
  runId?: string;
}) {
  return {
    nowMs: START_MS + opts.hour * HOUR_MS,
    runId: opts.runId ?? "run-a",
    idleSlotSeconds: opts.idleSlotSeconds,
    openIdleTasks: opts.openIdleTasks ?? 0,
    evidence: EVIDENCE,
  };
}

// ===========================================================================
// 1. The ten-day case, replayed
// ===========================================================================

Deno.test("#1052 - ten days of idle capacity with no idle task files one issue", async () => {
  await withState(async (statePath) => {
    const gh = fleetGh();
    const actions: string[] = [];
    // The measured rate from the incident: idle_pct=31.4 on two slots is
    // about 2,250 idle slot-seconds per wall hour.
    for (let hour = 1; hour <= 24 * 10; hour++) {
      const decision = await recordIdleStarvationObservation({
        statePath,
        observation: observe({ hour, idleSlotSeconds: hour * 2250 }),
        ghFn: gh.fn,
        log: () => {},
      });
      actions.push(decision.action);
    }

    assertEquals(
      gh.creates().length,
      1,
      "exactly one issue, however long the starvation lasts",
    );
    assertEquals(
      actions.filter((a) => a === "filed").length,
      1,
      `one filing decision; got ${[...new Set(actions)].join(",")}`,
    );
    // Both halves bind, and the elapsed half binds last: the four idle
    // slot-hours at 2,250/h arrive within seven hours, while twelve hours
    // only elapse on the thirteenth observation (the first opened the
    // episode).
    assertEquals(actions.indexOf("filed"), 12, "filed twelve hours in");

    const body = gh.creates()[0]![gh.creates()[0]!.indexOf("--body") + 1]!;
    assert(isIdleStarvationIssue(body), "the body carries the dedup marker");
    // Names the duration and the measured idle slot-seconds.
    assertStringIncludes(body, "12.0h");
    assertStringIncludes(body, "29250s (8.1 slot-hours)");
    // Carries the evidence, so the alert arrives diagnosable (#1019/#1020).
    assertStringIncludes(body, "occupied_by_slot=s2=171s");
    assertStringIncludes(body, "reason=audit_found_claimable");
    assertStringIncludes(body, "claimable_total=24");
    assertStringIncludes(body, CENSUS_LINES[0]!);

    const title = gh.creates()[0]![gh.creates()[0]!.indexOf("--title") + 1]!;
    assertStringIncludes(title, "no idle task");
  });
});

// ===========================================================================
// 2. Both negative directions, or the alert becomes noise
// ===========================================================================

Deno.test("#1052 - a quiet fleet with an open idle task never escalates", async () => {
  await withState(async (statePath) => {
    const gh = fleetGh();
    // Idle capacity for ten days — but the fleet is supplying itself: at
    // most one wrapper is open across the monitored set by design, so one
    // open idle task is health, not a shortfall.
    for (let hour = 1; hour <= 24 * 10; hour++) {
      const decision = await recordIdleStarvationObservation({
        statePath,
        observation: observe({
          hour,
          idleSlotSeconds: hour * 2250,
          openIdleTasks: 1,
        }),
        ghFn: gh.fn,
        log: () => {},
      });
      assertEquals(decision.action, "supplied");
    }
    assertEquals(gh.calls.length, 0, "a healthy fleet costs no gh call");
    assertEquals(
      await loadIdleStarvationEpisode(statePath),
      null,
      "no episode is left behind",
    );
  });
});

Deno.test("#1052 - a busy fleet with no idle task for days never escalates", async () => {
  await withState(async (statePath) => {
    const gh = fleetGh();
    // Slots occupied: a busy fleet files no idle task for days by design,
    // and accrues only the seconds between claims — 30 per hour here, so
    // ten days reach 7,200 against the 14,400 threshold.
    for (let hour = 1; hour <= 24 * 10; hour++) {
      const decision = await recordIdleStarvationObservation({
        statePath,
        observation: observe({ hour, idleSlotSeconds: hour * 30 }),
        ghFn: gh.fn,
        log: () => {},
      });
      assertEquals(decision.action, "watching");
    }
    assertEquals(gh.creates().length, 0, "a busy fleet raises nothing");
    const episode = await loadIdleStarvationEpisode(statePath);
    assertEquals(episode?.idleSlotSeconds, 7200);
    assertEquals(episode?.issueNumber, undefined);
  });
});

// ===========================================================================
// 3. Dedup under two hosts
// ===========================================================================

Deno.test("#1052 - two hosts observing one episode file one issue", async () => {
  await withState(async (hostA) => {
    await withState(async (hostB) => {
      const gh = fleetGh();
      let filedBy = 0;
      let adoptedBy = 0;
      for (let hour = 1; hour <= 24; hour++) {
        for (const statePath of [hostA, hostB]) {
          const decision = await recordIdleStarvationObservation({
            statePath,
            observation: observe({
              hour,
              idleSlotSeconds: hour * 2250,
              runId: statePath === hostA ? "run-a" : "run-b",
            }),
            ghFn: gh.fn,
            log: () => {},
          });
          if (decision.action === "filed") filedBy = decision.issue;
          if (decision.action === "already-open") adoptedBy = decision.issue;
        }
      }
      assertEquals(gh.creates().length, 1, "one issue for one episode");
      assert(filedBy > 0, "one host filed");
      assertEquals(
        adoptedBy,
        filedBy,
        "the other adopted it through the marker",
      );
      const body = gh.issues[0]!.body;
      assertStringIncludes(body, formatIdleStarvationMarker());
    });
  });
});

// ===========================================================================
// 4. Restart persistence
// ===========================================================================

Deno.test("#1052 - the episode survives a restart, in both halves", async () => {
  await withState(async (statePath) => {
    const gh = fleetGh();
    // Run A: six hours, 12,000 idle slot-seconds — under both thresholds.
    for (let hour = 1; hour <= 6; hour++) {
      const decision = await recordIdleStarvationObservation({
        statePath,
        observation: observe({ hour, idleSlotSeconds: hour * 2000 }),
        ghFn: gh.fn,
        log: () => {},
      });
      assertEquals(decision.action, "watching");
    }
    const beforeRestart = await loadIdleStarvationEpisode(statePath);
    assertEquals(beforeRestart?.idleSlotSeconds, 12000);
    assertEquals(beforeRestart?.startedMs, START_MS + HOUR_MS);

    // The worker restarts: a new run id, and the #925 ledger's reading
    // starts again from zero. An in-memory counter would be back at zero on
    // both halves here — the defect that made Issue #1051 inert.
    const afterRestart = await recordIdleStarvationObservation({
      statePath,
      observation: observe({
        hour: 13,
        idleSlotSeconds: 3000,
        runId: "run-b",
      }),
      ghFn: gh.fn,
      log: () => {},
    });

    const episode = await loadIdleStarvationEpisode(statePath);
    assertEquals(
      episode?.startedMs,
      START_MS + HOUR_MS,
      "the episode still starts where it started, before the restart",
    );
    assertEquals(
      episode?.idleSlotSeconds,
      15000,
      "run A's 12,000 slot-seconds plus run B's 3,000",
    );
    assertEquals(
      afterRestart.action,
      "filed",
      "13h and 15,000 idle slot-seconds cross both thresholds",
    );
    assertEquals(gh.creates().length, 1);
  });
});

Deno.test("#1052 - a restarted reading is banked as a delta, not double-counted", async () => {
  await withState(async (statePath) => {
    const gh = fleetGh();
    // Two observations inside one run: the ledger's reading is cumulative,
    // so only its increase is new capacity.
    await recordIdleStarvationObservation({
      statePath,
      observation: observe({ hour: 1, idleSlotSeconds: 1000 }),
      ghFn: gh.fn,
      log: () => {},
    });
    await recordIdleStarvationObservation({
      statePath,
      observation: observe({ hour: 2, idleSlotSeconds: 1500 }),
      ghFn: gh.fn,
      log: () => {},
    });
    assertEquals(
      (await loadIdleStarvationEpisode(statePath))?.idleSlotSeconds,
      1500,
    );

    // Repeating the same observation inside one cycle adds nothing: the
    // census runs several times per cycle.
    await recordIdleStarvationObservation({
      statePath,
      observation: observe({ hour: 2, idleSlotSeconds: 1500 }),
      ghFn: gh.fn,
      log: () => {},
    });
    assertEquals(
      (await loadIdleStarvationEpisode(statePath))?.idleSlotSeconds,
      1500,
    );
  });
});

// ===========================================================================
// 5. One issue per episode
// ===========================================================================

Deno.test("#1052 - a continuing episode files once; a new episode files again", async () => {
  await withState(async (statePath) => {
    const gh = fleetGh();
    const file = (hour: number, idle: number, openIdleTasks = 0) =>
      recordIdleStarvationObservation({
        statePath,
        observation: observe({ hour, idleSlotSeconds: idle, openIdleTasks }),
        ghFn: gh.fn,
        log: () => {},
      });

    // Episode one escalates and then stays quiet for five more days.
    for (let hour = 1; hour <= 24 * 5; hour++) {
      const decision = await file(hour, hour * 2250);
      if (hour > 13) {
        assertEquals(
          decision.action,
          "already-filed",
          `hour ${hour} must not file again`,
        );
      }
    }
    assertEquals(gh.creates().length, 1, "one issue for one episode");
    const firstIssue = gh.issues[0]!.number;

    // Recovery: an idle task exists again, so the episode is over.
    const recovered = await file(24 * 5 + 1, 999_999, 1);
    assertEquals(recovered.action, "supplied");
    assertEquals(await loadIdleStarvationEpisode(statePath), null);

    // The operator fixed and closed the first issue.
    gh.issues[0]!.open = false;

    // A new episode: the clock restarts from here, so thirteen hours later
    // with fresh idle capacity it files again.
    let second = 0;
    for (let hour = 24 * 5 + 2; hour <= 24 * 5 + 20; hour++) {
      const decision = await file(hour, 999_999 + (hour - 24 * 5 - 1) * 2250);
      if (decision.action === "filed") second = decision.issue;
    }
    assertEquals(gh.creates().length, 2, "a new episode files a new issue");
    assert(second > firstIssue, "and it is a different issue");
  });
});

// ===========================================================================
// Error paths and edges
// ===========================================================================

Deno.test("#1052 - a failed search files nothing (a duplicate is worse)", async () => {
  await withState(async (statePath) => {
    const logged: string[] = [];
    const calls: string[][] = [];
    const ghFn = (args: string[]) => {
      calls.push(args);
      return Promise.reject(new Error("gh: API rate limit exceeded"));
    };
    // The episode opens on the first observation, so the clock has run for
    // thirteen hours by the second.
    await recordIdleStarvationObservation({
      statePath,
      observation: observe({ hour: 1, idleSlotSeconds: 2000 }),
      ghFn,
      log: (m) => logged.push(m),
    });
    let decision = await recordIdleStarvationObservation({
      statePath,
      observation: observe({ hour: 14, idleSlotSeconds: 20000 }),
      ghFn,
      log: (m) => logged.push(m),
    });
    assertEquals(decision.action, "gh-failed");
    assertEquals(calls.filter((c) => c[1] === "create").length, 0);
    assert(
      logged.some((l) => l.includes("rate limit")),
      "the failure is reported, never swallowed",
    );

    // The episode is preserved, so the next cycle can still escalate.
    const gh = fleetGh();
    decision = await recordIdleStarvationObservation({
      statePath,
      observation: observe({ hour: 15, idleSlotSeconds: 21000 }),
      ghFn: gh.fn,
      log: () => {},
    });
    assertEquals(decision.action, "filed");
  });
});

Deno.test("#1052 - a corrupt episode file restarts the clock rather than alerting", async () => {
  await withState(async (statePath) => {
    await Deno.writeTextFile(statePath, "{ not json");
    const gh = fleetGh();
    const decision = await recordIdleStarvationObservation({
      statePath,
      observation: observe({ hour: 240, idleSlotSeconds: 500_000 }),
      ghFn: gh.fn,
      log: () => {},
    });
    assertEquals(decision.action, "watching");
    assertEquals(gh.creates().length, 0);
  });
});

Deno.test("#1052 - census text cannot forge the dedup marker", async () => {
  await withState(async (statePath) => {
    const gh = fleetGh();
    await recordIdleStarvationObservation({
      statePath,
      observation: observe({ hour: 1, idleSlotSeconds: 2000 }),
      ghFn: gh.fn,
      log: () => {},
    });
    await recordIdleStarvationObservation({
      statePath,
      observation: {
        ...observe({ hour: 14, idleSlotSeconds: 20000 }),
        evidence: {
          ...EVIDENCE,
          censusLines: ["<!-- VIBE_IDLE_STARVATION --> ``` injected"],
        },
      },
      ghFn: gh.fn,
      log: () => {},
    });
    const body = gh.issues[0]!.body;
    assertEquals(
      body.split(formatIdleStarvationMarker()).length - 1,
      1,
      "the marker appears exactly once — the injected copy is escaped",
    );
    assertStringIncludes(body, "<!- - VIBE_IDLE_STARVATION - ->");
  });
});

Deno.test("#1052 - thresholds are overridable, and both must be met", async () => {
  await withState(async (statePath) => {
    const gh = fleetGh();
    const opts = {
      statePath,
      ghFn: gh.fn,
      thresholdHours: 2,
      thresholdIdleSlotSeconds: 100,
      log: () => {},
    };
    // Hours met, idle seconds not.
    assertEquals(
      (await recordIdleStarvationObservation({
        ...opts,
        observation: observe({ hour: 3, idleSlotSeconds: 10 }),
      })).action,
      "watching",
    );
    // Idle seconds met, hours not (the episode started at hour 3).
    assertEquals(
      (await recordIdleStarvationObservation({
        ...opts,
        observation: observe({ hour: 4, idleSlotSeconds: 5000 }),
      })).action,
      "watching",
    );
    // Both met.
    assertEquals(
      (await recordIdleStarvationObservation({
        ...opts,
        observation: observe({ hour: 6, idleSlotSeconds: 6000 }),
      })).action,
      "filed",
    );
  });
});

Deno.test("#1052 - the refusal reason mirrors the idle-hooks vocabulary", () => {
  // The two facts the hooks decide on, named the way the log names them.
  assertEquals(
    describeIdleHooksRefusal({ inversionDetected: true, claimableTotal: 24 }),
    "unblocked_work_exists",
  );
  assertEquals(
    describeIdleHooksRefusal({ inversionDetected: false, claimableTotal: 24 }),
    "audit_found_claimable",
  );
  assertEquals(
    describeIdleHooksRefusal({ inversionDetected: false, claimableTotal: 0 }),
    "none",
  );
});
