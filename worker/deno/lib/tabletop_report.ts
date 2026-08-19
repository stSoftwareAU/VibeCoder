/**
 * Evidence rendering for the tabletop harness (Issue #4194).
 *
 * Turns a {@link TabletopReport} into the markdown written to
 * `docs/evidence/tabletop-<date>.md`: the date, the image the fixtures ran
 * against and its digest, the per-fixture verdict, and the hostile payload
 * each fixture stands for — quoted inside a fence, as data.
 *
 * The canary never appears here. The report records *that* a canary was
 * recovered, from which sink and in which form; the value itself is minted per
 * run and stays in the run.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { TabletopReport } from "./tabletop_harness.ts";
import type { TabletopFixture } from "./tabletop_fixtures.ts";

/** Escape the pipe and newline a markdown table cell cannot carry. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Emoji-free verdict marker, so the table reads in a plain terminal too. */
function marker(verdict: string): string {
  return verdict === "CONTAINED"
    ? "PASS"
    : verdict === "BREACHED"
    ? "FAIL"
    : "ERROR";
}

/**
 * Render the evidence document.
 *
 * @param report - The judged run.
 * @param fixtures - The fixture set, for the payload appendix.
 * @returns Markdown for `docs/evidence/tabletop-<date>.md`.
 */
export function formatTabletopReport(
  report: TabletopReport,
  fixtures: readonly TabletopFixture[],
): string {
  const lines: string[] = [];
  lines.push("# Malicious-issue tabletop evidence");
  lines.push("");
  lines.push(
    `Generated ${report.generatedAt} by \`mod.ts security-tabletop\` ` +
      `(Issue #4194). Each fixture ran inside the container the launcher ` +
      `builds, with a planted canary credential; the canary value is minted ` +
      `per run and never recorded here.`,
  );
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(`**Verdict: ${report.verdict}**`);
  lines.push("");
  lines.push(
    report.weakenedControls.length > 0
      ? `Negative control — deliberately weakened: ${
        report.weakenedControls.join(", ")
      }. A weakened run that reports no breach means the harness cannot ` +
        `detect one.`
      : "No control was weakened: this is a straight run.",
  );
  lines.push("");
  lines.push("## Run");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Mode | ${cell(report.mode)} |`);
  lines.push(`| Runtime | ${cell(report.runtime)} |`);
  lines.push(`| Image | ${cell(report.image)} |`);
  lines.push(`| Image digest | ${cell(report.imageDigest)} |`);
  lines.push(`| Fixtures | ${report.results.length} |`);
  lines.push("");
  lines.push("## Fixtures");
  lines.push("");
  lines.push(
    "| Fixture | Surface | Objective | Must | Attempt | Verdict | Detail |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const result of report.results) {
    const detail = result.reasons.length > 0
      ? result.reasons.join("; ")
      : result.detail;
    lines.push(
      `| \`${cell(result.id)}\` | ${cell(result.surface)} | ${
        cell(result.objective)
      } | ${cell(result.expectation)} | ${cell(result.status)} | ${
        marker(result.verdict)
      } | ${cell(detail)} |`,
    );
  }

  const leaked = report.results.filter((r) => r.leaks.length > 0);
  lines.push("");
  lines.push("## Canary");
  lines.push("");
  if (leaked.length === 0) {
    lines.push(
      "The planted canary credential was not recovered from any outbound " +
        "artefact — comment bodies, pull-request bodies, the run log, or the " +
        "attempt's own output — in literal, separator-split, base64, hex or " +
        "reversed form.",
    );
  } else {
    lines.push("The canary was recovered from these sinks:");
    lines.push("");
    lines.push("| Fixture | Sink | Form |");
    lines.push("| --- | --- | --- |");
    for (const result of leaked) {
      for (const leak of result.leaks) {
        lines.push(
          `| \`${cell(result.id)}\` | ${cell(leak.sink)} | ${
            cell(leak.form)
          } |`,
        );
      }
    }
  }

  lines.push("");
  lines.push("## Payloads");
  lines.push("");
  lines.push(
    "The hostile text each fixture stands for, quoted as data. Nothing reads " +
      "it as an instruction; the executable half is the fixture's own attempt.",
  );
  for (const fixture of fixtures) {
    lines.push("");
    lines.push(`### \`${fixture.id}\``);
    lines.push("");
    lines.push(
      `Surface **${fixture.surface}**, objective **${fixture.objective}**, ` +
        `controls ${fixture.controls.join(", ")}.`,
    );
    lines.push("");
    lines.push("```text");
    lines.push(fixture.payload);
    lines.push("```");
  }

  lines.push("");
  lines.push("## Method");
  lines.push("");
  lines.push(
    "- Fixtures and attempts: `worker/deno/lib/tabletop_fixtures.ts`.",
  );
  lines.push(
    "- Judgement and canary scanning: `worker/deno/lib/tabletop_harness.ts`.",
  );
  lines.push(
    "- Container execution: `worker/deno/lib/tabletop_container_runner.ts`, " +
      "driving the launch plan `run.sh` itself uses.",
  );
  lines.push(
    "- A run that is not containerised is refused, never downgraded to host " +
      "mode.",
  );
  lines.push(
    "- Outbound artefacts pass through the production redaction chokepoint " +
      "(`secret_redaction.ts`) before the canary scan, so what is measured is " +
      "the control the worker actually ships.",
  );
  return lines.join("\n") + "\n";
}
