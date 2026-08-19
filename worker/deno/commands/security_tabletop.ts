/**
 * `security-tabletop` — the malicious-issue tabletop harness (Issue #4194).
 *
 * Runs the hostile fixture set inside the container the launcher builds, with
 * a planted canary credential, and writes the per-fixture verdicts to
 * `docs/evidence/tabletop-<date>.md`.
 *
 * Arguments:
 *   --image REF        image to run (default: this checkout's reference)
 *   --out PATH         report path (default docs/evidence/tabletop-<date>.md)
 *   --egress-url URL   host the egress fixture probes (no body is ever sent)
 *   --weaken LIST      negative control: disable `sink-redaction` and/or
 *                      `canary-encoding-scan`, comma separated. The run then
 *                      SUCCEEDS only if the harness detects a breach.
 *
 * Exit status is the point: a breach, a fixture that could not be run, or a
 * run that was not containerised all fail. Nothing degrades to host mode.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  assertFixtureCoverage,
  TABLETOP_FIXTURES,
} from "../lib/tabletop_fixtures.ts";
import {
  evaluateTabletopRun,
  mintCanary,
  negativeControlOutcome,
  type TabletopControl,
  type TabletopReport,
} from "../lib/tabletop_harness.ts";
import { formatTabletopReport } from "../lib/tabletop_report.ts";
import { createTabletopContainerRunner } from "../lib/tabletop_container_runner.ts";

/** Where the evidence is written. */
export const TABLETOP_EVIDENCE_DIR = "docs/evidence";

/** The controls a negative-control run may switch off. */
const KNOWN_CONTROLS: readonly TabletopControl[] = [
  "sink-redaction",
  "canary-encoding-scan",
];

/** Default report location for a run. */
export function tabletopReportPath(
  now: Date,
  negativeControl: boolean,
): string {
  const date = now.toISOString().slice(0, 10);
  return `${TABLETOP_EVIDENCE_DIR}/tabletop${
    negativeControl ? "-negative-control" : ""
  }-${date}.md`;
}

/**
 * Parse `--weaken`.
 *
 * @throws When a name is not a control the harness knows — a typo must not
 *   silently produce a straight run wearing a negative control's name.
 */
export function parseWeakenedControls(value: unknown): TabletopControl[] {
  if (value === undefined || value === false) return [];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `--weaken needs a comma-separated list of ${KNOWN_CONTROLS.join(", ")}.`,
    );
  }
  return value.split(",").map((raw) => {
    const name = raw.trim();
    const match = KNOWN_CONTROLS.find((control) => control === name);
    if (!match) {
      throw new Error(
        `Unknown control ${JSON.stringify(name)} — the harness can weaken ` +
          `${KNOWN_CONTROLS.join(" or ")}.`,
      );
    }
    return match;
  });
}

/** Repository root, resolved from this file's location. */
function repoRoot(): string {
  return new URL(import.meta.url).pathname.replace(
    /\/worker\/deno\/commands\/[^/]+$/,
    "",
  );
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value.trim() : "";
}

export const securityTabletopCommand: Command = {
  name: "security-tabletop",
  description:
    "Run the malicious-issue tabletop fixtures inside the container with a planted canary and write docs/evidence/tabletop-<date>.md (Issue #4194)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<TabletopReport>> {
    let weakenedControls: TabletopControl[];
    try {
      assertFixtureCoverage();
      weakenedControls = parseWeakenedControls(args["weaken"]);
    } catch (error) {
      return { success: false, message: (error as Error).message };
    }

    const canary = mintCanary();
    const runner = createTabletopContainerRunner({
      repoRoot: repoRoot(),
      image: stringArg(args, "image") || undefined,
      egressProbeUrl: stringArg(args, "egress-url") || undefined,
    });

    let report: TabletopReport;
    try {
      const outcome = await runner.run(TABLETOP_FIXTURES, {
        canary,
        weakenedControls,
      });
      report = evaluateTabletopRun(TABLETOP_FIXTURES, outcome, {
        canary,
        weakenedControls,
      });
    } catch (error) {
      // No runtime, no image, a non-containerised run, or a runner fault:
      // every one of them fails loudly rather than reporting a pass.
      return { success: false, message: (error as Error).message };
    }

    const outPath = stringArg(args, "out") ||
      tabletopReportPath(new Date(), weakenedControls.length > 0);
    try {
      const dir = outPath.includes("/")
        ? outPath.slice(0, outPath.lastIndexOf("/"))
        : ".";
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        outPath,
        formatTabletopReport(report, TABLETOP_FIXTURES),
      );
    } catch (error) {
      return {
        success: false,
        message: `Failed to write ${outPath}: ${(error as Error).message}`,
      };
    }

    const breached = report.results.filter((r) => r.verdict === "BREACHED");
    if (weakenedControls.length > 0) {
      const negative = negativeControlOutcome(report);
      return {
        success: negative.satisfied,
        message: `Wrote ${outPath} — negative control: ${negative.reason}`,
        data: report,
      };
    }
    return {
      success: report.verdict === "CONTAINED",
      message: `Wrote ${outPath} — verdict ${report.verdict} over ` +
        `${report.results.length} fixture(s) against ${report.image}` +
        (breached.length > 0
          ? `: ${
            breached.map((r) => `${r.id} (${r.reasons.join("; ")})`).join(", ")
          }`
          : ""),
      data: report,
    };
  },
};
