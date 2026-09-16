/**
 * Gate: a launcher outcome record must be able to name its host (Issue #709).
 *
 * `container-restart-backoff` is what escalates a host that cannot launch. Its
 * report names the machine — `resolveRunHostId()` and `escalationHostId()`
 * both read `Deno.hostname()`, and both fall back to `unknown` when they
 * cannot. Deno refuses that read without `--allow-sys=hostname`, so an
 * invocation missing the flag reports `unknown-host` for its `<phase>`
 * failure.
 *
 * That is not a cosmetic loss. Since Issue #2108 the report is the
 * `callbacks.host_failure` payload the operator's own hook receives, and its
 * `host` field is the only thing telling one machine's outage from another's
 * — so every host in the fleet collapses onto one nameless report per phase.
 * Issues #709, #710 and #711 are the three that arrived that way: three
 * phases, one nameless host, nothing to act on.
 *
 * `loop.sh` has carried the flag since Issue #633; the other three call sites
 * were never updated with it. One flag across four scripts is exactly the
 * drift a source gate exists to hold, so this module finds every invocation
 * and says which of them can name its host.
 *
 * Australian English spelling throughout (behaviour, recognise).
 */

import { executableLines, type LauncherDialect } from "./launcher_source.ts";

/** The sub-command whose invocations this gate governs. */
export const OUTCOME_RECORDER = "container-restart-backoff";

/** The Deno permission `Deno.hostname()` requires. */
export const HOSTNAME_PERMISSION = "--allow-sys=hostname";

/**
 * The argument that distinguishes an invocation from prose naming one.
 *
 * Every caller passes it, and the command refuses to run without it — so a
 * block carrying the recorder's name but not this flag is a log message or a
 * comment, not a call site.
 */
const INVOCATION_MARKER = "--exit-status";

/** One `container-restart-backoff` invocation found in a script. */
export interface OutcomeRecordInvocation {
  /** Source file the invocation lives in. */
  file: string;
  /** 1-indexed line the recorder is named on. */
  line: number;
  /** Whether Deno will let this invocation read the hostname. */
  namesHost: boolean;
  /** Ready-to-print explanation, set only when `namesHost` is false. */
  fault?: string;
}

/**
 * The statement an invocation sits in: the run of non-blank code lines around
 * it.
 *
 * Comments are already blanked by {@link executableLines}, so a comment
 * mentioning the flag never counts as granting it, and the blank line or
 * comment that precedes every one of these call sites bounds the block.
 */
function invocationBlock(lines: string[], index: number): string[] {
  let start = index;
  while (start > 0 && lines[start - 1]!.trim() !== "") start--;
  let end = index;
  while (end + 1 < lines.length && lines[end + 1]!.trim() !== "") end++;
  return lines.slice(start, end + 1);
}

/**
 * Find every outcome-record invocation a script makes.
 *
 * Returning the clean ones too is deliberate: a gate that only reports faults
 * passes just as quietly when the call site it was watching disappears, and
 * "no invocations found" is a different failure from "all of them are sound".
 *
 * @param file - Path reported in the fault, for the failure message
 * @param source - The script's full source text
 * @param dialect - Language the script is written in
 * @returns One entry per invocation, in source order
 */
export function findOutcomeRecordInvocations(
  file: string,
  source: string,
  dialect: LauncherDialect,
): OutcomeRecordInvocation[] {
  const lines = executableLines(source, dialect);
  const found: OutcomeRecordInvocation[] = [];

  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]!.includes(OUTCOME_RECORDER)) continue;
    const block = invocationBlock(lines, index);
    if (!block.some((line) => line.includes(INVOCATION_MARKER))) continue;

    const namesHost = block.some((line) => line.includes(HOSTNAME_PERMISSION));
    found.push({
      file,
      line: index + 1,
      namesHost,
      ...(namesHost ? {} : {
        fault: `${file}:${index + 1}: the ${OUTCOME_RECORDER} invocation ` +
          `omits ${HOSTNAME_PERMISSION}, so Deno.hostname() throws and the ` +
          'host-failure payload it hands the hook names "unknown-host" — ' +
          "every host in the fleet then reports under one nameless host " +
          "(Issue #709)",
      }),
    });
  }
  return found;
}
