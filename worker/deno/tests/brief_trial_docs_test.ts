/**
 * Tests for Issue #2604 — the brief trial protocol page.
 *
 * `docs/BRIEF-TRIAL.md` records how the `brief_toolchain.enabled` trial
 * (#2581) is judged: the candidate, the bar, the window, the comparison rule,
 * where each figure is read from, the security posture and the verdict
 * template. The verdict (#2605) is read against this page, so it must not
 * drift from the code.
 *
 * The drift tests take the stats prefix, the statuses, the rendered `Brief:`
 * lines, the config key and the scan argv from the **live** modules, so
 * renaming any of them without updating the page fails here. The prose the
 * code cannot express — the bar, the window, what a verdict changes — is
 * pinned by keyword checks scoped to its own section.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  BRIEF_TOOLCHAIN_KEYS,
  parseBriefToolchain,
} from "../lib/brief_toolchain_config.ts";
import {
  BRIEF_BINARY,
  BRIEF_VERSION,
  type BriefRunReport,
  briefRunReport,
  briefScanArgs,
} from "../lib/brief_toolchain.ts";
import {
  BRIEF_STATS_PREFIX,
  buildBriefStatsLine,
} from "../lib/issue_run_stats_comment.ts";
import { BRIEF_OFF } from "../lib/run_callbacks.ts";
import { readRepoDoc, section } from "./support/markdown_docs.ts";

const TRIAL_PAGE = "docs/BRIEF-TRIAL.md";

/** The marker §4 carries until a human names the trial host. */
const HOST_PLACEHOLDER = "TRIAL-HOST-NOT-YET-NAMED";

/** brief subcommands and scan targets the trial never runs. */
const FORBIDDEN = ["enrich", "outline", "threat-model", "sinks", "missing"];

/** The trial page, read fresh so an edit between tests cannot be cached. */
function trialPage(): Promise<string> {
  return readRepoDoc(TRIAL_PAGE);
}

/** `\*\*`-safe pattern for a literal string. */
function literal(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

/** Every status the live report builder really produces, keyed by name. */
function liveReports(): Record<string, BriefRunReport> {
  const reports = {
    ok: briefRunReport(true, { status: "ok", seconds: 1.5 }),
    failed: briefRunReport(true, { status: "failed", reason: "exit 1" }),
    off: briefRunReport(true, { status: "off", reason: "no Cargo.toml" }),
  };
  for (const [name, report] of Object.entries(reports)) {
    assertEquals(report.status, name);
  }
  return reports;
}

Deno.test("the trial page is linked from every doc that names the switch", async () => {
  const docs = ["README.md"];
  for await (
    const entry of Deno.readDir(new URL("../../../docs/", import.meta.url))
  ) {
    if (entry.isFile && entry.name.endsWith(".md")) {
      docs.push(`docs/${entry.name}`);
    }
  }
  const naming = [];
  for (const doc of docs) {
    if (doc === TRIAL_PAGE) continue;
    const text = await readRepoDoc(doc);
    if (!text.includes("brief_toolchain")) continue;
    naming.push(doc);
    const target = doc.startsWith("docs/") ? "BRIEF-TRIAL.md" : TRIAL_PAGE;
    assert(text.includes(`](${target})`), `${doc} must link ${target}`);
  }
  for (const doc of ["docs/CONFIGURATION.md", "docs/CALLBACKS.md"]) {
    assert(naming.includes(doc), `${doc} must document brief_toolchain`);
  }
  for (
    const doc of ["docs/RTK-OUTPUT-TRIAL.md", "docs/REPO-CONTEXT-TRIAL.md"]
  ) {
    const related = section(await readRepoDoc(doc), "Related documentation");
    assert(related.includes("](BRIEF-TRIAL.md)"), `${doc} must link the page`);
  }
});

Deno.test("the candidate section names the live switch, version and block", async () => {
  const candidate = section(await trialPage(), "The candidate");
  for (const key of BRIEF_TOOLCHAIN_KEYS) {
    assert(
      candidate.includes(`brief_toolchain.${key}`),
      `the candidate section must name \`brief_toolchain.${key}\``,
    );
    assert(parseBriefToolchain({ [key]: true }).ok, `live key ${key}`);
  }
  assert(candidate.includes(BRIEF_VERSION), "the pinned version is named");
  assert(candidate.includes("container/tools.json"), "the pin's home is named");
  assert(
    candidate.includes("## Cargo commands (from brief)") &&
      candidate.includes("Cargo.toml"),
    "the candidate section must name the map block and when it appears",
  );
});

Deno.test("the motivation section states that it is not evidence", async () => {
  const motivation = section(await trialPage(), "Motivation");
  assert(/not evidence/i.test(motivation), "motivation is not evidence");
});

Deno.test("the bar section states every clause of the bar", async () => {
  const bar = section(await trialPage(), "The bar");
  assert(bar.includes("10%"), "the ≥ 10% margin must be stated");
  assert(/token/i.test(bar) && /cost/i.test(bar), "tokens or cost");
  assert(/implementation run/i.test(bar), "per completed implementation run");
  assert(/success rate[^.]*no lower/i.test(bar), "success rate no lower");
  assert(
    /brief's own run time[^.]*against/i.test(bar),
    "brief's own run time must be counted against it",
  );
});

Deno.test("the window section states the host, the length and the opening", async () => {
  const window = section(await trialPage(), "The window and the switch");
  assert(
    window.includes(HOST_PLACEHOLDER) || /\*\*Trial host:\*\* \S/.test(window),
    "the window section must name the host or carry the placeholder",
  );
  assert(
    /GRQ-23/.test(window) && /GRQ-25/.test(window),
    "the window section must exclude the other candidates' hosts",
  );
  assert(/\*\*Switch-on date:\*\*/.test(window), "a switch-on date line");
  assert(/2 days/.test(window), "the 2-day threshold");
  assert(/\b20\b[^.]*\bruns\b/i.test(window), "the 20-run threshold");
  assert(/whichever is later/i.test(window), "which threshold decides");
  assert(
    /deployed/i.test(window) && /human/i.test(window) &&
      window.includes(".config.json"),
    "the window opens on deployment plus a human enabling the switch",
  );
});

Deno.test("the comparison rule uses the live prefix and statuses", async () => {
  const reports = liveReports();
  const comparison = section(await trialPage(), "The comparison rule");
  assert(
    literal(`${BRIEF_STATS_PREFIX} ok`).test(comparison),
    "only `Brief: ok` runs count",
  );
  assert(
    literal(`${BRIEF_STATS_PREFIX} failed`).test(comparison),
    "`Brief: failed` runs are reported separately",
  );
  for (const status of Object.keys(reports)) {
    assert(comparison.includes(`\`${status}\``), `status \`${status}\``);
  }
  assert(/Rust/.test(comparison) && /control hosts/i.test(comparison));
  assert(/same dates/i.test(comparison), "same dates on both sides");
  assert(/#2573/.test(comparison), "the effort re-sweep hits both sides");
});

Deno.test("the figure-sources section quotes the shapes the code renders", async () => {
  const reports = liveReports();
  const sources = section(await trialPage(), "figure is read from");
  const shapes = [
    buildBriefStatsLine(reports.ok!),
    buildBriefStatsLine(
      briefRunReport(true, { status: "ok", seconds: 0, cached: true }),
    ),
    buildBriefStatsLine({ ...reports.failed!, reason: "<reason>" }),
    buildBriefStatsLine(reports.off!),
  ];
  for (const shape of shapes) {
    assert(shape, "an enabled report renders a line");
    assert(sources.includes(shape), `quote the rendered line \`${shape}\``);
  }
  assertEquals(buildBriefStatsLine(BRIEF_OFF), undefined);
  assert(sources.includes(JSON.stringify(reports.ok)), "the ok callback block");
  assert(sources.includes(JSON.stringify(BRIEF_OFF)), "the off callback block");
  assert(
    sources.includes("`brief`") && /callback/i.test(sources),
    "the figure-sources section must name the `brief` callback field",
  );
});

Deno.test("the security section lists the argv and every forbidden subcommand", async () => {
  const security = section(await trialPage(), "Security posture");
  const argv = [BRIEF_BINARY, ...briefScanArgs("<repo>")].join(" ");
  assert(security.includes(argv), `the live argv \`${argv}\``);
  for (const word of FORBIDDEN) {
    assert(security.includes(`\`${word}\``), `\`${word}\` is never run`);
  }
  assert(/no shell/i.test(security), "no shell");
  assert(/offline/i.test(security) && /remote/i.test(security));
  assert(/allowlist/i.test(security) && /cap/i.test(security));
  assert(/timeout/i.test(security), "a timeout");
});

Deno.test("the results section leaves a table and a verdict to fill in", async () => {
  const results = section(await trialPage(), "Results");
  assert(results.includes("| ---"), "a table to fill in");
  for (const row of ["token", "cost", "success rate", "seconds", "failed"]) {
    assert(results.toLowerCase().includes(row), `a ${row} row`);
  }
  assert(/keep \/ remove/i.test(results), "a keep / remove verdict");
});

Deno.test("the page says what a keep and a miss change", async () => {
  const verdict = section(await trialPage(), "What the verdict changes");
  assert(/separate decision/i.test(verdict), "widening is separate");
  assert(/negative result/i.test(verdict) && /one PR/i.test(verdict));
  for (const part of ["container/tools.json", "toolchains/brief.sh"]) {
    assert(verdict.includes(part), `removal names ${part}`);
  }
});

Deno.test("the out-of-scope section names what the trial leaves alone", async () => {
  const scope = section(await trialPage(), "Out of scope");
  for (const word of FORBIDDEN) {
    assert(scope.includes(`\`${word}\``), `\`${word}\` is out of scope`);
  }
  assert(/Graft/.test(scope) && /CodeGraph/.test(scope));
  assert(scope.includes("REPO-CONTEXT-TRIAL.md"));
});
