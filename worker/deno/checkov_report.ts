/**
 * `checkov_report.ts` — the CI judgement of the Checkov CloudFormation scan
 * (Issue #3653).
 *
 * The required `checkov` job (`.github/workflows/checkov.yml`) runs Checkov
 * with the arguments from `checkovScanArgs()`, writes the JSON report to a
 * file, and calls this entry with Checkov's exit code. The verdict is the
 * same {@link judgeCheckovRun} the local quality gate applies, so CI and the
 * gate cannot disagree about a template.
 *
 * Usage:
 *   deno run --frozen --lock=deno.lock --allow-read checkov_report.ts \
 *     --report <path> --checkov-exit <n>
 *
 * Exit status: 0 when PASSED, 1 when FAILED, a bad or missing argument, or an
 * unreadable report file (fail loud — never a pass by default).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { installConsoleRedaction } from "./lib/console_redaction.ts";
import { judgeCheckovRun } from "./lib/checkov_check.ts";

/** The arguments a valid invocation names. */
const USAGE = "usage: checkov_report.ts --report <path> --checkov-exit <n>";

/** The value following `flag`, or null when the flag is absent or valueless. */
function flagValue(args: string[], flag: string): string | null {
  const at = args.indexOf(flag);
  if (at === -1) return null;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) return null;
  return value;
}

/**
 * Run the judgement over the report file and print the verdict.
 *
 * @param args - The command-line arguments, without the program name.
 * @returns 0 when PASSED, 1 when FAILED or the invocation is invalid.
 */
export async function main(args: string[]): Promise<number> {
  // Issue #1280 (SEC-1217-12): every entry point patches its own console.
  installConsoleRedaction();

  const reportPath = flagValue(args, "--report");
  const exitText = flagValue(args, "--checkov-exit");
  if (reportPath === null) {
    console.error(`checkov_report: --report <path> is required\n${USAGE}`);
    return 1;
  }
  if (exitText === null) {
    console.error(`checkov_report: --checkov-exit <n> is required\n${USAGE}`);
    return 1;
  }
  const exitCode = /^\d+$/.test(exitText) ? Number(exitText) : NaN;
  if (!Number.isSafeInteger(exitCode)) {
    console.error(
      `checkov_report: --checkov-exit must be a non-negative integer, got "${exitText}"`,
    );
    return 1;
  }

  let stdout: string;
  try {
    stdout = await Deno.readTextFile(reportPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `checkov_report: cannot read the Checkov report at ${reportPath}: ${detail}`,
    );
    return 1;
  }

  const judged = judgeCheckovRun({ exitCode, stdout, stderr: "" });
  if (judged.status === "PASSED") {
    console.log(judged.output);
    return 0;
  }
  console.error(judged.output);
  return 1;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
