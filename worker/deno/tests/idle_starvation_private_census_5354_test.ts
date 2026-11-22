/**
 * The idle-starvation issue never names a private repository (Issue #5354).
 *
 * VibeCoder is public, and the escalation is filed into `stSoftwareAU/VibeCoder`.
 * Its body pastes the per-repo `[idle-census]` lines verbatim, and those lines
 * name every monitored repository — including private ones the public issue
 * must not reveal. The filing path therefore withholds any census line that
 * names a repository not positively confirmed public, and keeps the rest.
 *
 * The rules that matter here are **fail closed** — a failed visibility lookup
 * withholds the line — and **no lookup unless the issue is actually filed**.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import {
  type IdleStarvationDecision,
  type IdleStarvationObservation,
  idleStarvationStatePath,
  recordIdleStarvationObservation,
  withholdPrivateCensusLines,
} from "../lib/idle_starvation_escalation.ts";

const FLEET: readonly string[] = ["vibe-coder-bot"];
const HOUR_MS = 3_600_000;
const START_MS = Date.UTC(2026, 10, 1, 0, 0, 0);
const NOOP = (_message: string) => {};

/** Thresholds low enough that two observations reach the filing path. */
const FAST = { thresholdHours: 1, thresholdIdleSlotSeconds: 100 };

/** The placeholder the body carries in place of a withheld census line. */
const WITHHELD =
  "(census line withheld: it names a repository that is not public; the host log has it)";

const HEADER = "[idle-census] decision_point=idle-hooks repos=2 inversion=true";
const PUBLIC_LINE =
  "[idle-census] decision_point=idle-hooks repo=stSoftwareAU/VibeCoder " +
  "monitored=true scanned=true availability=available";
const PRIVATE_LINE =
  "[idle-census] decision_point=idle-hooks repo=stSoftwareAU/PrivateThing " +
  "monitored=true scanned=true availability=busy";
const FLAKY_LINE =
  "[idle-census] decision_point=idle-hooks repo=stSoftwareAU/FlakyThing " +
  "monitored=true scanned=true availability=available";
const ALERT_LINE = "[idle-census] decision_point=idle-hooks ALERT inversion " +
  "repos=stSoftwareAU/VibeCoder,stSoftwareAU/PrivateThing";
const OTHER_PUBLIC_LINE =
  "[idle-census] decision_point=idle-hooks repo=stSoftwareAU/OtherPublic " +
  "monitored=true scanned=true availability=available";
const ALERT_PUBLIC_LINE =
  "[idle-census] decision_point=idle-hooks ALERT inversion " +
  "repos=stSoftwareAU/VibeCoder,stSoftwareAU/OtherPublic";

type Reply = "public" | "private" | "fail";

/**
 * A `gh` fake answering the visibility route `gh api repos/<owner>/<repo>
 * --jq .visibility` from `replies`. An unlisted repo, or one marked `fail`,
 * rejects as a real failed lookup would. The dedup search finds nothing, and
 * `issue create` is captured so the posted `--body` can be inspected.
 */
function gh(replies: Readonly<Record<string, Reply>>) {
  const calls: string[][] = [];
  const bodies: string[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api") {
      const repo = args[1]!.replace(/^repos\//, "");
      const reply = replies[repo];
      if (reply === undefined || reply === "fail") {
        return Promise.reject(new Error(`HTTP 404: Not Found (${repo})`));
      }
      return Promise.resolve(`${reply}\n`);
    }
    if (args[1] === "list") return Promise.resolve("[]");
    if (args[1] === "create") {
      bodies.push(args[args.indexOf("--body") + 1]!);
      return Promise.resolve(
        "https://github.com/stSoftwareAU/VibeCoder/issues/901\n",
      );
    }
    return Promise.reject(new Error(`unrouted: ${args.join(" ")}`));
  };
  return {
    fn,
    calls,
    bodies,
    apiCalls: () => calls.filter((c) => c[0] === "api"),
  };
}

async function withState(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "idle_starvation_5354_" });
  try {
    await fn(idleStarvationStatePath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** One observation with the given census lines attached. */
function observe(
  hour: number,
  idleSlotSeconds: number,
  censusLines: readonly string[],
): IdleStarvationObservation {
  return {
    nowMs: START_MS + hour * HOUR_MS,
    runId: "run-a",
    idleSlotSeconds,
    openIdleTasks: 0,
    evidence: {
      slotUtilisation: "slot-utilisation: slots=2 idle_pct=31.4",
      refusalReason: "audit_found_claimable",
      claimableTotal: 24,
      censusLines,
    },
  };
}

/** Open the episode at hour 0, then reach the filing path at hour 2. */
async function fileThrough(
  statePath: string,
  censusLines: readonly string[],
  ghFn: (args: string[]) => Promise<string>,
): Promise<IdleStarvationDecision> {
  await recordIdleStarvationObservation({
    statePath,
    observation: observe(0, 0, censusLines),
    ghFn,
    log: NOOP,
    fleetAuthors: FLEET,
    ...FAST,
  });
  return await recordIdleStarvationObservation({
    statePath,
    observation: observe(2, 1000, censusLines),
    ghFn,
    log: NOOP,
    fleetAuthors: FLEET,
    ...FAST,
  });
}

// ===========================================================================
// 1. The filed body names no private repository
// ===========================================================================

Deno.test("#5354 - the filed body withholds lines naming a private repo and keeps the rest", async () => {
  await withState(async (statePath) => {
    const g = gh({
      "stSoftwareAU/PrivateThing": "private",
      "stSoftwareAU/VibeCoder": "public",
    });
    const decision = await fileThrough(statePath, [
      HEADER,
      PRIVATE_LINE,
      PUBLIC_LINE,
      ALERT_LINE,
    ], g.fn);

    assertEquals(decision.action, "filed", "the filing path must be reached");
    assertEquals(g.bodies.length, 1, "exactly one issue is created");
    const body = g.bodies[0]!;

    assertFalse(
      body.includes("PrivateThing"),
      "the private repository must not be named anywhere in the body",
    );
    assertStringIncludes(body, HEADER, "the header line is kept");
    assertStringIncludes(body, PUBLIC_LINE, "the public repo's line is kept");
    assertStringIncludes(body, WITHHELD, "the withheld placeholder appears");
    assertFalse(
      body.includes(PRIVATE_LINE) || body.includes(ALERT_LINE),
      "the private line and the ALERT line naming it are both withheld",
    );
    assertEquals(
      body.split(WITHHELD).length - 1,
      2,
      "two lines (the private one and the ALERT naming it) are withheld",
    );
    assertEquals(
      g.apiCalls().length,
      2,
      "one visibility lookup per distinct repository, not per line",
    );
  });
});

// ===========================================================================
// 2. Fail closed: a failed lookup withholds the line
// ===========================================================================

Deno.test("#5354 - a failed visibility lookup withholds that repo's line", async () => {
  await withState(async (statePath) => {
    const g = gh({
      "stSoftwareAU/FlakyThing": "fail",
      "stSoftwareAU/VibeCoder": "public",
    });
    const decision = await fileThrough(statePath, [
      HEADER,
      FLAKY_LINE,
      PUBLIC_LINE,
    ], g.fn);

    assertEquals(decision.action, "filed", "the filing path must be reached");
    const body = g.bodies[0]!;
    assertFalse(
      body.includes("FlakyThing"),
      "a repo whose visibility could not be confirmed is not named",
    );
    assertStringIncludes(
      body,
      PUBLIC_LINE,
      "the confirmed-public line is kept",
    );
    assertStringIncludes(
      body,
      WITHHELD,
      "the failed lookup's line is withheld",
    );
    assertEquals(
      body.split(WITHHELD).length - 1,
      1,
      "exactly the failed lookup's line is withheld",
    );
  });
});

// ===========================================================================
// 3. The helper, directly
// ===========================================================================

Deno.test("#5354 - a line naming no repository is kept unchanged, with no lookup", async () => {
  const g = gh({});
  const out = await withholdPrivateCensusLines([HEADER], g.fn);
  assertEquals(out, [HEADER]);
  assertEquals(g.calls.length, 0, "a line with no repository costs no gh call");
});

Deno.test("#5354 - with every named repository public, lines are returned unchanged", async () => {
  const g = gh({
    "stSoftwareAU/VibeCoder": "public",
    "stSoftwareAU/OtherPublic": "public",
  });
  const lines = [HEADER, PUBLIC_LINE, OTHER_PUBLIC_LINE, ALERT_PUBLIC_LINE];
  const out = await withholdPrivateCensusLines(lines, g.fn);
  assertEquals(out, lines, "a positive control: nothing is withheld");
  assertEquals(
    g.apiCalls().length,
    2,
    "one memoised lookup per distinct repository across all lines",
  );
  assert(
    out.every((l) => !l.includes(WITHHELD)),
    "no placeholder appears when every repository is public",
  );
});

// ===========================================================================
// 4. No lookup unless the issue is actually filed
// ===========================================================================

Deno.test("#5354 - a cycle below the thresholds makes no repository lookup", async () => {
  await withState(async (statePath) => {
    const g = gh({
      "stSoftwareAU/PrivateThing": "private",
      "stSoftwareAU/VibeCoder": "public",
    });
    const decision = await recordIdleStarvationObservation({
      statePath,
      observation: observe(1, 2250, [HEADER, PRIVATE_LINE, PUBLIC_LINE]),
      ghFn: g.fn,
      log: NOOP,
      fleetAuthors: FLEET,
    });

    assertEquals(decision.action, "watching");
    assertEquals(
      g.apiCalls().length,
      0,
      "no `gh api repos/` call while the episode is still below threshold",
    );
    assertEquals(g.bodies.length, 0, "nothing is filed");
  });
});

// ===========================================================================
// 5. The tokeniser fails closed: punctuation never hides a repository name
// ===========================================================================

/** A census line whose repository slot carries `token`, as written. */
function lineNaming(token: string): string {
  return `[idle-census] decision_point=idle-hooks ${token} monitored=true ` +
    "scanned=true availability=busy";
}

/** Visibility fake: PrivateThing is private, VibeCoder is public. */
function visibilityGh() {
  return gh({
    "stSoftwareAU/PrivateThing": "private",
    "stSoftwareAU/VibeCoder": "public",
  });
}

const PRIVATE_WRAPPINGS: readonly (readonly [string, string])[] = [
  ["in double quotes", `repo="stSoftwareAU/PrivateThing"`],
  ["in parentheses", "(stSoftwareAU/PrivateThing)"],
  ["with a trailing colon", "stSoftwareAU/PrivateThing:"],
  ["in backticks", "`stSoftwareAU/PrivateThing`"],
];

for (const [label, token] of PRIVATE_WRAPPINGS) {
  Deno.test(`#5354 - a private repo ${label} withholds its line`, async () => {
    const g = visibilityGh();
    const out = await withholdPrivateCensusLines(
      [HEADER, lineNaming(token), PUBLIC_LINE],
      g.fn,
    );
    assertEquals(
      out,
      [HEADER, WITHHELD, PUBLIC_LINE],
      "the wrapped private repo's line is withheld; the rest is kept",
    );
    assertFalse(
      out.some((l) => l.includes("PrivateThing")),
      "the private repository is not named anywhere in the output",
    );
  });
}

Deno.test("#5354 - a multi-segment token withholds its line, as it cannot be confirmed public", async () => {
  const g = visibilityGh();
  const out = await withholdPrivateCensusLines(
    [HEADER, lineNaming("stSoftwareAU/PrivateThing/sub"), PUBLIC_LINE],
    g.fn,
  );
  assertEquals(
    out,
    [HEADER, WITHHELD, PUBLIC_LINE],
    "a token with a second '/' is not a repository, so its line is withheld",
  );
});

Deno.test("#5354 - a public repo wrapped in quotes is still kept (look-alike control)", async () => {
  const g = visibilityGh();
  const line = lineNaming(`repo="stSoftwareAU/VibeCoder"`);
  const out = await withholdPrivateCensusLines([line], g.fn);
  assertEquals(out, [line], "a confirmed-public repo's line is kept");
  assertEquals(
    g.apiCalls().length,
    1,
    "the quoted repo is looked up, so it is kept because it is confirmed public",
  );
});
