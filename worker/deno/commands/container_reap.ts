/**
 * container-reap command (Issue #4173).
 *
 * The host-side kill-and-reap watchdog the launchers call. Two modes, one per
 * layer of Issue #4173:
 *
 *   --name <container> [--client-pid <pid>] [--evidence-dir /path]
 *       The outer watchdog fired: the container outlived the launcher's
 *       deadline. Capture hard-kill evidence into the evidence directory
 *       before the kill (Issue #4253), then kill it, and if the runtime refuses
 *       ("running and can not be deleted"), SIGKILL the host-side client and
 *       the runtime helper holding it, so the launcher — and the supervisor
 *       behind it — is freed. Without --evidence-dir no evidence is captured.
 *
 *   --name <container> --if-silent --evidence-dir /path [--wedge-marker /path]
 *       The early reap (Issue #5161). Reap only when the worker log in the
 *       evidence directory has been silent for VIBE_GUEST_SILENCE_SECONDS
 *       (default 900; 0 disables) AND consecutive `exec` probes fail. Then
 *       write `container_silent` to the wedge marker (when given) and reap as
 *       for the deadline, with a reason saying the guest was silent. The marker
 *       records that decision, not a finished reap: the exit status says
 *       whether the reap completed. When the guest is not wedged, nothing is
 *       killed or written and the command exits with GUEST_ANSWERING_EXIT (3).
 *
 *   --stale --max-age-seconds <n> [--exclude <container>] [--refuse-live]
 *       Pre-launch reaper: reap every `vibe-coder-*` container older than the
 *       deadline, or whose launcher process is gone (which is also how a wedge
 *       that survived a host reboot is caught). No evidence is captured.
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-write --allow-run \
 *     mod.ts container-reap --runtime container --name vibe-coder-1234 \
 *     [--client-pid 1234] [--grace-seconds 30] [--work-dir /path] \
 *     [--evidence-dir /path]
 *
 * Exits non-zero when a reap was attempted and the container survived it: a
 * host that cannot reap its own containers must not look healthy (#3234).
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  checkGuestSilence,
  GUEST_ANSWERING_EXIT,
  guestSilenceReason,
  resolveGuestSilenceSeconds,
} from "../lib/guest_silence_watch.ts";
import {
  createReapDeps,
  dialectForExecutable,
  listLiveWorkerContainers,
  type LiveWorkerContainer,
  type ReapDeps,
  type ReapResult,
  reapStaleContainers,
  reapWedgedContainer,
  resolveGraceSeconds,
} from "../lib/container_watchdog.ts";

/**
 * Exit status for "another worker is already running on this host" — a
 * correct outcome the launcher must tell apart from a reaper that could not
 * run (1) and from a clean host (0) (Issue #26). The launchers read it by
 * this number; keep it stable.
 */
export const ANOTHER_WORKER_RUNNING_EXIT = 4;

/** What the wedge marker holds when the early reap fires (Issue #5161). */
const WEDGE_MARKER_TEXT = "container_silent\n";

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(optionalString(value));
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

/** What the command reports back to the launcher. */
export interface ContainerReapResult {
  /** One entry per container the command tried to reap. */
  reaped: ReapResult[];
  /** Live worker containers found by `--refuse-live` (Issue #26). */
  live?: LiveWorkerContainer[];
}

export const containerReapCommand: Command = {
  name: "container-reap",
  description:
    "Kill and reap a wedged worker container, host-side (Issue #4173)",

  execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<ContainerReapResult>> {
    return reap(args);
  },
};

/** Do the work. Separated so the tests can call it without the registry. */
export async function reap(
  args: Record<string, unknown>,
  overrides: { deps?: ReapDeps } = {},
): Promise<CommandResult<ContainerReapResult>> {
  const runtime = optionalString(args["runtime"]);
  if (!runtime) {
    return {
      success: false,
      message: "container-reap requires --runtime <executable>",
    };
  }

  const containerName = optionalString(args["name"]);
  const stale = args["stale"] === true;
  if (!containerName && !stale) {
    return {
      success: false,
      message: "container-reap requires either --name <container> or --stale",
    };
  }

  // The self-heal events log lives beside the worker's own, resolved the same
  // way the container-restart-backoff recorder resolves it: this command is
  // its own host-side process, before (or after) any container run.
  const workDir = optionalString(args["work-dir"]) ??
    Deno.env.get("WORK_DIR") ?? Deno.env.get("HOME") ?? "";

  const ifSilent = args["if-silent"] === true;
  const evidenceDirArg = optionalString(args["evidence-dir"]);
  if (ifSilent && (!containerName || stale)) {
    return {
      success: false,
      message: "container-reap --if-silent requires --name <container>",
    };
  }
  if (ifSilent && !evidenceDirArg) {
    return {
      success: false,
      message: "container-reap --if-silent requires --evidence-dir <path>",
    };
  }

  let deps: ReapDeps;
  try {
    deps = overrides.deps ?? createReapDeps({
      runtime,
      listArgs: dialectForExecutable(runtime).listArgs,
      workDir,
    });
  } catch (error) {
    return { success: false, message: (error as Error).message };
  }

  const graceSeconds = optionalNumber(args["grace-seconds"]) ??
    resolveGraceSeconds((name) => Deno.env.get(name));
  const results: ReapResult[] = [];

  let reapReason = optionalString(args["reason"]) ??
    "the launcher's watchdog deadline expired";
  if (ifSilent && containerName && evidenceDirArg) {
    const verdict = await checkGuestSilence(deps.evidence, {
      containerName,
      evidenceDir: evidenceDirArg,
      silenceSeconds: resolveGuestSilenceSeconds((name) => Deno.env.get(name)),
      nowMs: Date.now(),
    });
    if (!verdict.wedged) {
      return {
        success: true,
        exitCode: GUEST_ANSWERING_EXIT,
        message: verdict.detail,
        data: { reaped: [] },
      };
    }
    reapReason = guestSilenceReason(verdict.silentSeconds);
    const marker = optionalString(args["wedge-marker"]);
    if (marker) {
      try {
        await deps.evidence.writeFile(marker, WEDGE_MARKER_TEXT);
      } catch (error) {
        console.error(
          `[container-reap] could not write the wedge marker ${marker}: ${
            (error as Error).message
          }`,
        );
      }
    }
  }

  try {
    if (stale) {
      const maxAgeSeconds = optionalNumber(args["max-age-seconds"]);
      if (maxAgeSeconds === undefined || maxAgeSeconds < 1) {
        return {
          success: false,
          message: "container-reap --stale requires --max-age-seconds <n>",
        };
      }
      const exclude = optionalString(args["exclude"]);
      results.push(
        ...await reapStaleContainers(deps, {
          maxAgeSeconds,
          ...(exclude ? { excludeNames: [exclude] } : {}),
          ...(graceSeconds !== undefined ? { graceSeconds } : {}),
        }),
      );
    }

    if (containerName) {
      const clientPid = optionalNumber(args["client-pid"]);
      const evidenceDir = optionalString(args["evidence-dir"]);
      results.push(
        await reapWedgedContainer(deps, {
          containerName,
          ...(clientPid !== undefined && clientPid > 0 ? { clientPid } : {}),
          ...(graceSeconds !== undefined ? { graceSeconds } : {}),
          reason: reapReason,
          trigger: "watchdog",
          ...(evidenceDir ? { evidenceDir } : {}),
        }),
      );
    }
  } catch (error) {
    return { success: false, message: (error as Error).message };
  }

  const survivors = results.filter((result) => !result.reaped);

  // One worker per host (Issue #26): after the stale reap, anything still
  // listed with a live launcher behind it is a worker somebody else is
  // running — say so and stop this launch, before it builds or launches.
  if (args["refuse-live"] === true && stale) {
    const maxAgeSeconds = optionalNumber(args["max-age-seconds"]) ?? 0;
    const exclude = optionalString(args["exclude"]);
    const found = await listLiveWorkerContainers(deps, {
      maxAgeSeconds,
      ...(exclude ? { excludeNames: [exclude] } : {}),
    });
    if (!found.ok) {
      return {
        success: false,
        message: `could not tell whether another worker is running: ` +
          found.error,
        data: { reaped: results },
      };
    }
    if (found.live.length > 0) {
      const named = found.live.map((c) =>
        `${c.name} (launcher pid ${c.launcherPid}` +
        `${c.ageSeconds !== undefined ? `, running ${c.ageSeconds}s` : ""})`
      ).join(", ");
      return {
        success: false,
        exitCode: ANOTHER_WORKER_RUNNING_EXIT,
        message: `another worker is already running on this host: ${named}. ` +
          `One worker per host — stop that one (or the LaunchAgent, ` +
          `scheduled task or loop.sh that started it) before launching another.`,
        data: { reaped: results, live: found.live },
      };
    }
  }

  if (survivors.length > 0) {
    return {
      success: false,
      message: `could not reap ${
        survivors.map((result) => result.containerName).join(", ")
      }`,
      data: { reaped: results },
    };
  }

  return {
    success: true,
    message: results.length === 0
      ? "no wedged worker container found"
      : `reaped ${results.map((result) => result.containerName).join(", ")}`,
    data: { reaped: results },
  };
}
