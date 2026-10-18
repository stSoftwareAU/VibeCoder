/** Read-only JSON report over explicitly supplied host ledgers and snapshots. */
import { readLifecycleLedger } from "./lifecycle_ledger.ts";
import {
  buildStabilisationReport,
  type StabilisationEvidence,
} from "./stabilisation_report.ts";
import { redactSecrets } from "./secret_redaction.ts";

export async function stabilisationReportCli(args: string[]): Promise<string> {
  const [flag, evidencePath, ...paths] = args;
  if (flag === "--help") {
    return "Usage: deno task stabilisation-report --evidence snapshot.json host-ledger.jsonl [other-host.jsonl ...]";
  }
  if (flag !== "--evidence" || !evidencePath || paths.length === 0) {
    throw new Error(
      "Supply --evidence and at least one lifecycle ledger path; use --help for usage",
    );
  }
  const evidence = JSON.parse(
    await Deno.readTextFile(evidencePath),
    (key, value: unknown) => {
      if (
        ["historyComplete", "accepted", "processGenerated"].includes(key) &&
        typeof value !== "boolean"
      ) throw new Error(`Evidence field ${key} must be boolean`);
      if (
        [
          "failuresPrevented",
          "extraChecks",
          "extraModelCalls",
          "extraSeconds",
          "residualRecurrence",
        ].includes(key) && value !== null &&
        (!Number.isFinite(value) || (value as number) < 0)
      ) {
        throw new Error(
          `Evidence field ${key} must be a nonnegative number or null`,
        );
      }
      return value;
    },
  ) as StabilisationEvidence;
  for (const row of evidence.safeguards) {
    if (!["observed", "synthetic"].includes(row.source)) {
      throw new Error(
        "Evidence safeguard source must be observed or synthetic",
      );
    }
  }
  const ledgers = await Promise.all(
    paths.map((path) => readLifecycleLedger(path)),
  );
  return JSON.stringify(
    buildStabilisationReport(ledgers.flat(), evidence),
    null,
    2,
  );
}
if (import.meta.main) {
  try {
    console.log(await stabilisationReportCli(Deno.args));
  } catch (error) {
    console.error(
      redactSecrets(String(error)),
    );
    Deno.exitCode = 1;
  }
}
