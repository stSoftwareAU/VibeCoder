/**
 * Tests for Issue #2158 — the repo-context trial write-up page.
 *
 * `docs/REPO-CONTEXT-TRIAL.md` records the protocol the Graft and CodeGraph
 * trials follow: the candidates, the bar both are judged by, the sequential
 * windows on GRQ-23, the exclusion rules, where each figure is read from, and
 * why Graphify was dropped. The judging itself is a human act after a window
 * closes, so the page is the only place that protocol is written down — these
 * tests keep it honest.
 *
 * Two properties make them drift tests rather than keyword checks:
 *
 *   - the statuses, the index cap and the failure marker are taken from the
 *     **live** CodeGraph modules (`prepareCodegraphContext` is really called,
 *     `CODEGRAPH_INDEX_TIMEOUT_MS` and `CODEGRAPH_CONTEXT_KEYS` are really
 *     read), so renaming a status or changing the cap fails here instead of
 *     leaving the page quietly wrong; and
 *   - every prose assertion is scoped to the section that must carry it, so
 *     deleting the rule it pins cannot be satisfied by the same words
 *     appearing elsewhere on the page.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  CODEGRAPH_CONTEXT_KEYS,
  parseCodegraphContext,
} from "../lib/codegraph_context_config.ts";
import {
  CODEGRAPH_INDEX_TIMEOUT_MS,
  CODEGRAPH_UNAVAILABLE_MARKER,
  prepareCodegraphContext,
} from "../lib/codegraph_context.ts";
import { GEMINI_PROVIDER_ID } from "../lib/agent_provider.ts";

const TRIAL_PAGE = "docs/REPO-CONTEXT-TRIAL.md";

// tests/ → worker/deno/ → worker/ → repo root
function read(relative: string): string {
  return Deno.readTextFileSync(
    new URL(`../../../${relative}`, import.meta.url),
  );
}

/**
 * The body of the numbered section whose heading matches `pattern`, up to the
 * next heading of the same level — so a rule deleted from its own section
 * cannot be "found" in a results table or an intro paragraph.
 */
function section(page: string, pattern: RegExp): string {
  const headings = [...page.matchAll(/^(#{2,3}) (.*)$/gm)];
  const index = headings.findIndex((h) => pattern.test(h[2] ?? ""));
  assert(index >= 0, `${TRIAL_PAGE} has no section matching ${pattern}`);
  const start = headings[index]!.index! + headings[index]![0].length;
  const next = headings.slice(index + 1).find((h) =>
    (h[1] ?? "").length <= (headings[index]![1] ?? "").length
  );
  return page.slice(start, next ? next.index! : undefined);
}

Deno.test("the trial page is linked from the README Documentation table", () => {
  assert(
    read("README.md").includes(`](${TRIAL_PAGE})`),
    `README.md must link ${TRIAL_PAGE} from its Documentation table`,
  );
});

Deno.test("the candidates section names both candidates and their switches", () => {
  const candidates = section(read(TRIAL_PAGE), /candidates/i);
  for (const name of ["Graft", "CodeGraph"]) {
    assert(
      candidates.includes(name),
      `the candidates section must name ${name}`,
    );
  }
  assert(
    candidates.includes("graft_context.enabled") &&
      candidates.includes("codegraph_context.enabled"),
    "the candidates section must name each candidate's host switch",
  );
});

Deno.test("the page records all three Graphify rejection reasons", () => {
  const graphify = section(read(TRIAL_PAGE), /Graphify/i).toLowerCase();
  // Python runtime, the LLM cost of indexing docs/PDFs, weakest video result.
  for (const reason of ["python", "pdf", "weakest"]) {
    assert(
      graphify.includes(reason),
      `the Graphify section must record the reason "${reason}"`,
    );
  }
});

Deno.test("the bar section states every clause of the bar", () => {
  const bar = section(read(TRIAL_PAGE), /the bar/i);
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
    /\b(build|index)\b[^.]*\b(time|seconds)\b[^.]*\bcounts\b/i.test(bar),
    "the bar must say the tool's own build/index time counts against it",
  );
});

Deno.test("the windows section describes the sequence and the manual switch-over", () => {
  const windows = section(read(TRIAL_PAGE), /window/i);
  const lower = windows.toLowerCase();
  assert(lower.includes("grq-23"), "the windows section must name the host");
  assert(
    lower.includes("same window length"),
    "the second window must run for the same length as the first",
  );
  assert(
    lower.includes(".config.json"),
    "the switch-over must name the file the operator edits",
  );
  assert(
    /no code schedules it/i.test(windows),
    "the switch-over must be stated as manual, not scheduled by code",
  );
});

Deno.test("the exclusions section excludes the statuses the runner really returns", async () => {
  const off = await prepareCodegraphContext({
    repoDir: "/nonexistent",
    enabled: false,
    providerId: "claude",
    logger: { warn: () => {} },
  });
  const gemini = await prepareCodegraphContext({
    repoDir: "/nonexistent",
    enabled: true,
    providerId: GEMINI_PROVIDER_ID,
    logger: { warn: () => {} },
  });
  assertEquals(off.status, "off");
  assertEquals(gemini.status, "unsupported");

  const exclusions = section(read(TRIAL_PAGE), /exclusion/i);
  for (const status of [off.status, gemini.status]) {
    assert(
      exclusions.includes(`\`${status}\``),
      `the exclusions section must say how \`${status}\` runs are treated`,
    );
  }
  assert(
    /both switches were on/i.test(exclusions),
    "runs with both repo-context switches on must be excluded from either window",
  );
});

Deno.test("the page pins the CodeGraph index cap and failure marker to the code", () => {
  const page = read(TRIAL_PAGE);
  const capSeconds = CODEGRAPH_INDEX_TIMEOUT_MS / 1000;
  assert(
    page.includes(`${capSeconds} s`),
    `the page must state the live index cap of ${capSeconds} s`,
  );
  assert(
    page.includes(CODEGRAPH_UNAVAILABLE_MARKER),
    `the page must name the live failure marker ${CODEGRAPH_UNAVAILABLE_MARKER}`,
  );
});

Deno.test("the page names the live config key for each candidate switch", () => {
  const page = read(TRIAL_PAGE);
  for (const key of CODEGRAPH_CONTEXT_KEYS) {
    assert(
      page.includes(`codegraph_context.${key}`),
      `${TRIAL_PAGE} must name the switch \`codegraph_context.${key}\``,
    );
    // The key the page names must be one the live parser actually accepts.
    const parsed = parseCodegraphContext({ [key]: true });
    assert(parsed.ok, `the live parser must accept codegraph_context.${key}`);
  }
  assert(
    page.includes("graft_context.enabled"),
    `${TRIAL_PAGE} must name Graft's own switch`,
  );
});

Deno.test("the figure-sources section names both surfaces for both candidates", () => {
  const sources = section(read(TRIAL_PAGE), /figure/i);
  for (const source of ["CodeGraph:", "Graft:", "`codegraph`", "`graft`"]) {
    assert(
      sources.includes(source),
      `the figure-sources section must point at ${source}`,
    );
  }
  assert(
    /run-stats/i.test(sources) && /callback/i.test(sources),
    "the figure-sources section must name the run-stats comment and the callback context",
  );
});

Deno.test("the page carries a results table per candidate", () => {
  const page = read(TRIAL_PAGE);
  for (const candidate of ["Graft", "CodeGraph"]) {
    const results = section(page, new RegExp(`results.*${candidate}\\b`, "i"));
    assert(
      results.includes("| ---"),
      `the ${candidate} results section must carry a table to fill in`,
    );
    assert(
      /verdict/i.test(results),
      `the ${candidate} results section must leave a verdict to record`,
    );
  }
});
