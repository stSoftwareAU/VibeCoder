/**
 * Tests for Issue #2387 — the RTK Bash-output trial write-up page.
 *
 * `docs/RTK-OUTPUT-TRIAL.md` records the protocol the `rtk_output.enabled`
 * trial is judged by: the candidate and how it is wired, the bar, the window
 * and who opens it, the rule that pairs enabled runs against control runs,
 * where every figure is read from, and the verdict template. The judging is a
 * human act after the window closes, so the page is the only place that
 * protocol is written down — these tests keep it honest.
 *
 * Four of them are drift tests in the strict sense: the statuses, the rendered
 * `RTK:` shapes, the hook wiring and the failure marker are taken from the
 * **live** modules (`prepareRtkRun` is really called, `buildRtkStatsLine`
 * really renders each shape, and `RTK_OUTPUT_KEYS` is really read), so
 * renaming a status or changing a rendered line fails here instead of leaving
 * the page quietly wrong. The rest pin prose the code cannot express — the
 * bar, who may open the window, what a verdict changes — and for those the
 * page is the source of truth, so a keyword check scoped to its own section is
 * the strongest assertion available. Every assertion is scoped that way, so
 * deleting the rule it pins cannot be satisfied by the same words appearing
 * elsewhere on the page.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { parseRtkOutput, RTK_OUTPUT_KEYS } from "../lib/rtk_output_config.ts";
import {
  RTK_HOOK_COMMAND,
  RTK_HOOK_MATCHER,
  RTK_UNAVAILABLE_MARKER,
  type RtkOutputResult,
} from "../lib/rtk_output.ts";
import {
  buildRtkStatsLine,
  RTK_STATS_PREFIX,
} from "../lib/issue_run_stats_comment.ts";
import {
  CLAUDE_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
} from "../lib/agent_provider.ts";
import { readRepoDoc, section } from "./support/markdown_docs.ts";
import { rtkExited, rtkGain, rtkSeam, rtkVersion } from "./support/rtk_seam.ts";

const TRIAL_PAGE = "docs/RTK-OUTPUT-TRIAL.md";

/** The trial page, read fresh so an edit between tests cannot be cached. */
function trialPage(): Promise<string> {
  return readRepoDoc(TRIAL_PAGE);
}

const silent = { info: () => {}, warn: () => {} };

/** One prepared run through the live `prepareRtkRun`, via the shared seam. */
function prepared(
  enabled: boolean,
  providerId: string,
  replies: Parameters<typeof rtkSeam>[0] = [],
) {
  return rtkSeam(replies).prepare({ enabled, providerId, logger: silent });
}

/** Every status the live preparation really produces, keyed by name. */
async function liveResults(): Promise<Record<string, RtkOutputResult>> {
  const off = await prepared(false, CLAUDE_PROVIDER_ID);
  const unsupported = await prepared(true, GEMINI_PROVIDER_ID);
  const failed = await prepared(true, CLAUDE_PROVIDER_ID, [rtkExited(127)]);
  const ok = await prepared(true, CLAUDE_PROVIDER_ID, [
    rtkVersion(),
    rtkGain(0),
  ]);

  const results = {
    off: off.result,
    unsupported: unsupported.result,
    failed: failed.result,
    ok: ok.result,
  };
  // The page's four statuses are these, not a list someone typed out.
  for (const [name, result] of Object.entries(results)) {
    assertEquals(result.status, name);
  }
  return results;
}

Deno.test("the trial page is linked from every surface that names the switch", async () => {
  // Links are relative to the linking file: repo-root pages carry the `docs/`
  // prefix, pages already inside `docs/` link the sibling directly.
  const sources: Array<[string, string]> = [
    ["README.md", TRIAL_PAGE],
    ["docs/REPO-CONTEXT-TRIAL.md", "RTK-OUTPUT-TRIAL.md"],
    ["docs/CONFIGURATION.md", "RTK-OUTPUT-TRIAL.md"],
  ];
  for (const [source, target] of sources) {
    assert(
      (await readRepoDoc(source)).includes(`](${target})`),
      `${source} must link ${target}`,
    );
  }
  // REFERENCES.md records where RTK shows up as a repo-relative path, and its
  // own path-existence test reads that third column.
  assert(
    (await readRepoDoc("docs/REFERENCES.md")).includes(TRIAL_PAGE),
    `docs/REFERENCES.md must record ${TRIAL_PAGE} as where RTK shows up`,
  );
});

Deno.test("the candidate section names the live switch and hook wiring", async () => {
  const candidate = section(await trialPage(), "The candidate");

  for (const key of RTK_OUTPUT_KEYS) {
    assert(
      candidate.includes(`rtk_output.${key}`),
      `the candidate section must name the switch \`rtk_output.${key}\``,
    );
    // The key the page names must be one the live parser actually accepts.
    assert(
      parseRtkOutput({ [key]: true }).ok,
      `the live parser must accept rtk_output.${key}`,
    );
  }
  assert(
    candidate.includes(RTK_HOOK_COMMAND) &&
      candidate.includes(`\`${RTK_HOOK_MATCHER}\``),
    `the candidate section must name the live hook (${RTK_HOOK_MATCHER} → ${RTK_HOOK_COMMAND})`,
  );
  assert(
    candidate.includes("--settings"),
    "the candidate section must say how the hook reaches the spawn",
  );
  assert(
    candidate.includes("#2381"),
    "the candidate section must name the toolchain issue that pins the binary",
  );
});

Deno.test("the motivation section states that its figures are not evidence", async () => {
  const motivation = section(await trialPage(), "Motivation");
  const lower = motivation.toLowerCase();
  assert(
    lower.includes("not evidence"),
    "the motivation section must say its figures are not evidence",
  );
  for (const source of ["JetBrains", "codepointer.dev"]) {
    assert(
      motivation.includes(source),
      `the motivation section must name the ${source} benchmark`,
    );
  }
  assert(
    motivation.includes("--dangerously-skip-permissions"),
    "the motivation section must say why the fleet's own runs are unmeasured",
  );
});

Deno.test("the bar section states every clause of the bar", async () => {
  const bar = section(await trialPage(), "The bar");
  const lower = bar.toLowerCase();
  assert(bar.includes("10%"), "the bar's ≥ 10% margin must be stated");
  assert(
    /\b20\b[^.]*\bruns\b/i.test(bar),
    "the bar must state the 20-completed-run threshold",
  );
  assert(lower.includes("2 days"), "the bar must state the 2-day threshold");
  assert(
    lower.includes("whichever is later"),
    "the bar must say which of the two thresholds decides",
  );
  assert(
    lower.includes("success rate"),
    "the bar must carry the no-worse-success-rate clause",
  );
  assert(
    /\b(preflight|gain)\b[^.]*\bagainst\b/i.test(bar),
    "the bar must say RTK's own preflight and gain reads count against it",
  );
});

Deno.test("the window section describes a human-opened, unscheduled window", async () => {
  const window = section(await trialPage(), "The window and the switch");
  const lower = window.toLowerCase();
  assert(lower.includes("grq-25"), "the window section must name the host");
  assert(lower.includes("1.7.0"), "the window opens on the 1.7.0 deployment");
  assert(
    lower.includes(".config.json"),
    "the window section must name the file the operator edits",
  );
  assert(
    /no code schedules it/i.test(window),
    "opening the window must be stated as manual, not scheduled by code",
  );
  assert(
    /no worker flips it/i.test(window),
    "the page must say no worker flips the switch on its own",
  );
});

Deno.test("the comparison rule pairs the statuses the runner really returns", async () => {
  const results = await liveResults();
  const comparison = section(await trialPage(), "The comparison rule");

  for (const status of Object.keys(results)) {
    assert(
      comparison.includes(`\`${status}\``),
      `the comparison rule must say how \`${status}\` runs are treated`,
    );
  }
  assert(
    /1\.7\.0/.test(comparison) &&
      new RegExp(RTK_STATS_PREFIX.replace(/[*]/g, "\\$&")).test(comparison),
    "the comparison rule must exclude pre-1.7.0 runs, which carry no RTK line",
  );
  assert(
    /graft/i.test(comparison) && /codegraph/i.test(comparison),
    "both sides of a comparison must hold the same Graft/CodeGraph state",
  );
});

Deno.test("the figure-sources section quotes the shapes the code really renders", async () => {
  const results = await liveResults();
  const sources = section(await trialPage(), "figure is read from");

  const shapes = [
    buildRtkStatsLine({ ...results.ok!, savedTokens: 12_340 }),
    buildRtkStatsLine(results.ok!),
    buildRtkStatsLine(results.failed!),
    buildRtkStatsLine(results.off!),
    buildRtkStatsLine(results.unsupported!),
  ];
  for (const shape of shapes) {
    assert(
      sources.includes(shape),
      `the figure-sources section must quote the rendered line \`${shape}\``,
    );
  }
  assert(
    sources.includes("`rtk`") && /callback/i.test(sources),
    "the figure-sources section must name the `rtk` callback block",
  );
  assert(
    /run-stats/i.test(sources) && /cost/i.test(sources),
    "tokens and cost must be read from the run-stats comment",
  );
  assert(
    /savedTokens[^.]*indicative/i.test(sources),
    "`savedTokens` must be marked indicative only",
  );
});

Deno.test("the security section states the posture of a binary ahead of every Bash command", async () => {
  const security = section(await trialPage(), "Security posture");
  assert(
    security.includes(RTK_UNAVAILABLE_MARKER),
    `the security section must name the live failure marker ${RTK_UNAVAILABLE_MARKER}`,
  );
  assert(
    /third-party/i.test(security) && /PATH/.test(security),
    "the security section must say RTK is third-party and resolves through PATH",
  );
  for (const control of ["C13", "C24"]) {
    assert(
      security.includes(control),
      `the security section must say the ${control} shim still applies`,
    );
  }
  assert(
    /telemetry/i.test(security),
    "the security section must record that telemetry is disabled image-wide",
  );
});

Deno.test("the results section leaves a table and a verdict to fill in", async () => {
  const results = section(await trialPage(), "Results");
  assert(
    results.includes("| ---"),
    "the results section must carry a table to fill in",
  );
  assert(
    /clears \/ does not clear/i.test(results),
    "the results section must end on the clears / does not clear verdict",
  );
});

Deno.test("the page says what a pass changes and what a miss changes", async () => {
  const verdict = section(await trialPage(), "What the verdict changes");
  assert(
    /default[^.]*\btrue\b/i.test(verdict) && /false/.test(verdict),
    "a pass must flip the shipped default to true with a per-host false opt-out",
  );
  assert(
    /#2348/.test(verdict),
    "the default-on criteria must be phrased like #2348's",
  );
  assert(
    /nothing[^.]*\bbeyond\b|beyond the recorded verdict/i.test(verdict),
    "a miss must change nothing beyond the recorded verdict",
  );
});

Deno.test("the comparable tools are recorded as facts, not as trial candidates", async () => {
  const comparable = section(await trialPage(), "Comparable tools");
  for (const tool of ["headroom", "context-mode", "caveman", "ponytail"]) {
    assert(
      comparable.toLowerCase().includes(tool),
      `the comparable-tools section must record ${tool}`,
    );
  }
  assert(comparable.includes("#2322"), "ponytail's issue must be cited");
  assert(
    /not trialled/i.test(comparable),
    "the comparable-tools section must say these are recorded, not trialled",
  );
});
