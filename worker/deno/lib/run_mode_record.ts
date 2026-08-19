/**
 * Durable per-launch run-mode record (Issue #4189).
 *
 * The Phase 0 gate of plan #4160 is "the fleet running clean in container
 * mode on both hosts", and until now nothing on disk said which mode a
 * launch ran in: the resolved mode was logged to stderr only, and the
 * `~/.vibe-coder/last-launch-phase` marker holds one value that the next
 * launch overwrites. This module writes one line per launch into
 * `~/logs/run_core.log` — the file that already carries one block per
 * launch (`VIBE_RUN_ID=…`) and outlives the 3-day worker-log retention —
 * so the green-gate report can count launches by mode instead of inferring.
 *
 * Line shape (parsed by the report; do not reword without updating both):
 *
 *     run mode: container host=host-23 run_id=vibe-msyhwilh-2dbf1b
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Prefix of the record line inside `run_core.log`. */
export const RUN_MODE_RECORD_PREFIX = "run mode: ";

/** One parsed record. */
export interface RunModeRecord {
  mode: string;
  host: string;
  runId: string;
}

/** Format the record line (without the timestamp `run_core.log` adds). */
export function formatRunModeRecord(record: RunModeRecord): string {
  const clean = (v: string) => v.replace(/\s+/g, "_") || "unknown";
  return `${RUN_MODE_RECORD_PREFIX}${clean(record.mode)} host=${
    clean(record.host)
  } run_id=${clean(record.runId)}`;
}

const RECORD_RE = /(?:^|\s)run mode: (\S+) host=(\S+) run_id=(\S+)\s*$/;

/**
 * Parse a `run_core.log` line (timestamp prefix tolerated). Returns
 * `undefined` for any other line.
 */
export function parseRunModeRecord(line: string): RunModeRecord | undefined {
  const match = line.match(RECORD_RE);
  if (!match) return undefined;
  const [, mode, host, runId] = match;
  return {
    mode: mode ?? "unknown",
    host: host ?? "unknown",
    runId: runId ?? "unknown",
  };
}

/**
 * The host this run reports as (Issue #4189): the launcher passes the real
 * machine name through `VIBE_HOST_ID` (inside a container the hostname is
 * the ephemeral container name); otherwise the hostname, domain trimmed.
 */
export function resolveRunHostId(
  env: (name: string) => string | undefined = (name) => {
    try {
      return Deno.env.get(name);
    } catch {
      return undefined;
    }
  },
  hostname: () => string = () => Deno.hostname(),
): string {
  let hostId = env("VIBE_HOST_ID")?.trim() ?? "";
  if (!hostId) {
    try {
      hostId = hostname();
    } catch {
      hostId = "unknown";
    }
  }
  const dot = hostId.indexOf(".");
  return dot > 0 ? hostId.slice(0, dot) : hostId || "unknown";
}
