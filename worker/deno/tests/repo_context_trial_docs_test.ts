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
 * The status names and the switch key are not hard-coded prose checks: they
 * are taken from the live CodeGraph modules (`prepareCodegraphContext` is
 * really called, `CODEGRAPH_CONTEXT_KEYS` is really read), so renaming a
 * status or a config key fails here instead of leaving the page quietly wrong.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  CODEGRAPH_CONTEXT_KEYS,
  parseCodegraphContext,
} from "../lib/codegraph_context_config.ts";
import { prepareCodegraphContext } from "../lib/codegraph_context.ts";
import { GEMINI_PROVIDER_ID } from "../lib/agent_provider.ts";

const TRIAL_PAGE = "docs/REPO-CONTEXT-TRIAL.md";

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

function read(relative: string): string {
  return Deno.readTextFileSync(repoPath(relative));
}

/** Local markdown link targets of `file`, resolved to repo-relative paths. */
function markdownLinks(file: string): string[] {
  const dir = file.includes("/")
    ? file.slice(0, file.lastIndexOf("/") + 1)
    : "";
  const targets: string[] = [];
  for (const match of read(file).matchAll(/\]\(([^)\s]+)/g)) {
    const raw = match[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) continue;
    const withoutAnchor = raw.split("#")[0] ?? "";
    if (!withoutAnchor.endsWith(".md")) continue;
    const resolved = new URL(withoutAnchor, `file:///${dir}`).pathname
      .replace(/^\//, "");
    targets.push(decodeURIComponent(resolved));
  }
  return targets;
}

Deno.test("the trial page is linked from the README Documentation table", () => {
  assert(
    markdownLinks("README.md").includes(TRIAL_PAGE),
    `README.md must link ${TRIAL_PAGE} from its Documentation table`,
  );
});

Deno.test("the trial page names both candidates and the dropped one", () => {
  const page = read(TRIAL_PAGE);
  for (const candidate of ["Graft", "CodeGraph", "Graphify"]) {
    assert(page.includes(candidate), `${TRIAL_PAGE} must name ${candidate}`);
  }
});

Deno.test("the trial page records all three Graphify rejection reasons", () => {
  const page = read(TRIAL_PAGE).toLowerCase();
  // Python runtime, the LLM cost of indexing docs/PDFs, weakest video result.
  for (const reason of ["python", "pdf", "weakest"]) {
    assert(
      page.includes(reason),
      `${TRIAL_PAGE} must record the Graphify reason "${reason}"`,
    );
  }
});

Deno.test("the trial page states the bar both candidates are judged by", () => {
  const page = read(TRIAL_PAGE);
  const lower = page.toLowerCase();
  assert(page.includes("10%"), "the bar's ≥ 10% margin must be stated");
  assert(page.includes("20"), "the 20-completed-run threshold must be stated");
  assert(lower.includes("2 days"), "the 2-day threshold must be stated");
  assert(
    lower.includes("whichever is later"),
    "the first-judged rule must say which of the two thresholds wins",
  );
  assert(
    lower.includes("success rate"),
    "the no-worse-success-rate half of the bar must be stated",
  );
});

Deno.test("the trial page counts the tool's own build/index time in the bar", () => {
  const lower = read(TRIAL_PAGE).toLowerCase();
  assert(
    lower.includes("index time") || lower.includes("index seconds"),
    "the bar must say the tool's own index/build time counts against it",
  );
});

Deno.test("the trial page describes the sequential windows and manual switch-over", () => {
  const lower = read(TRIAL_PAGE).toLowerCase();
  assert(lower.includes("grq-23"), "the trial host must be named");
  assert(
    lower.includes(".config.json"),
    "the manual switch-over must name the file the operator edits",
  );
  assert(
    lower.includes("no code schedules") || lower.includes("nothing schedules"),
    "the page must say the switch-over is manual, not scheduled by code",
  );
});

Deno.test("the trial page excludes the statuses the runner really returns", async () => {
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

  const page = read(TRIAL_PAGE);
  for (const status of [off.status, gemini.status]) {
    assert(
      page.includes(`\`${status}\``),
      `${TRIAL_PAGE} must say how \`${status}\` runs are treated`,
    );
  }
});

Deno.test("the trial page excludes runs where both switches were on", () => {
  const lower = read(TRIAL_PAGE).toLowerCase();
  assert(
    lower.includes("both") && lower.includes("exclud"),
    "runs with both repo-context switches on must be excluded from either window",
  );
});

Deno.test("the trial page names the live config key for each candidate switch", () => {
  const page = read(TRIAL_PAGE);
  for (const key of CODEGRAPH_CONTEXT_KEYS) {
    assert(
      page.includes(`codegraph_context.${key}`),
      `${TRIAL_PAGE} must name the switch \`codegraph_context.${key}\``,
    );
  }
  // The key the page names must be one the live parser actually accepts.
  const parsed = parseCodegraphContext({ enabled: true });
  assert(parsed.ok && parsed.value.enabled);
  assert(
    page.includes("graft_context.enabled"),
    `${TRIAL_PAGE} must name Graft's own switch`,
  );
});

Deno.test("the trial page says where each figure is read from", () => {
  const page = read(TRIAL_PAGE);
  for (const source of ["CodeGraph:", "Graft:", "`codegraph`", "`graft`"]) {
    assert(
      page.includes(source),
      `${TRIAL_PAGE} must point at the ${source} figure source`,
    );
  }
});

Deno.test("the trial page carries a results table per candidate", () => {
  const page = read(TRIAL_PAGE);
  const headings = [...page.matchAll(/^#{2,3} .*$/gm)].map((m) => m[0]);
  for (const candidate of ["Graft", "CodeGraph"]) {
    const heading = headings.find((h) =>
      h.includes(candidate) && /result/i.test(h)
    );
    assert(heading, `${TRIAL_PAGE} needs a results section for ${candidate}`);
    const body = page.slice(page.indexOf(heading));
    assert(
      body.includes("| ---"),
      `the ${candidate} results section must carry a table to fill in`,
    );
  }
});
