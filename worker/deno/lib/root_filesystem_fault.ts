/**
 * Container root-filesystem fault detection (Issue #3179).
 *
 * On GRQ-23 (2026-10-03) the container's root filesystem took virtio write
 * errors and ext4 remounted it read-only (`emergency_ro`). The worker went on
 * cycling: every two minutes the gh guard shim could not make its temp
 * directory, the provider health check failed for want of a writable `/tmp`,
 * and the run logged "Claude health check failed — skipping cycle" until a
 * human stopped the container. Nothing inside the launch can repair a
 * read-only root — the only fix is a fresh container, whose volume-init fscks
 * every named volume — so the run has to notice, say so, and end.
 *
 * `work_volume_fault.ts` (Issue #229) already recognises this text, but only
 * in git's stderr and only for the work volume. This module checks the rest:
 * the container's own scratch (`/tmp`, `/var/tmp`, `TMPDIR`) and the two
 * state volumes beside the work directory (`…-agent-state`,
 * `…-approval-state`), by creating and deleting a file in each, plus a scan of
 * `/proc/mounts` for the kernel's `emergency_ro` flag.
 *
 * A plain `ro` root is **not** a fault: Issue #516 mounts the root
 * `--read-only` on purpose wherever the runtime supports it, with writable
 * tmpfs scratch in its place. Only the kernel's error remount, or a probe
 * write refused with an I/O-class error, counts.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { findIoFaultLine } from "./work_volume_fault.ts";
import { resolveAgentStateDir } from "./agent_state_dir.ts";
import { resolveContentApprovalStateDir } from "./content_approval_state_dir.ts";

/**
 * Exit status a worker run uses to declare a root-filesystem fault.
 *
 * 74 is `EX_IOERR` from `sysexits.h` — "an error occurred while doing I/O on
 * some file". It sits beside the quota pause's 75 (`EX_TEMPFAIL`), outside the
 * launcher's own 3/4, 87, 88 and 124/137, the entrypoint's 76 and the
 * toolchain self-check's 89, and below 128 so it is never a signal death.
 */
export const ROOT_FS_FAULT_EXIT_STATUS = 74;

/** The code the one ERROR line carries, for grepping a fleet log. */
export const ROOT_FS_FAULT_CODE = "ROOT_FS_READ_ONLY";

/** A filesystem the container needs that can no longer be written. */
export interface RootFilesystemFault {
  /** The directory or mount point that failed. */
  path: string;
  /** What failed, in the kernel's or runtime's own words. */
  detail: string;
}

/** I/O seams for {@link detectRootFilesystemFault}. */
export interface RootFilesystemProbeDeps {
  /** `/proc/mounts`, or null when it cannot be read (not Linux). */
  readMounts(): Promise<string | null>;
  /** Create and delete a file in `dir`; throws on failure. */
  writeProbe(dir: string): Promise<void>;
  /** Report a probe failure that is not an I/O fault. */
  warn(message: string): void;
}

/**
 * The first mount the kernel remounted read-only after an error, or null.
 *
 * ext4's `errors=remount-ro` reports itself as `emergency_ro` in the option
 * list (the incident's root read `rw,relatime,emergency_ro`).
 */
export function findEmergencyReadOnlyMount(
  procMounts: string,
): { device: string; mountPoint: string } | null {
  for (const line of procMounts.split("\n")) {
    const [device, mountPoint, , options] = line.trim().split(/\s+/);
    if (!device || !mountPoint || !options) continue;
    if (options.split(",").includes("emergency_ro")) {
      return { device, mountPoint };
    }
  }
  return null;
}

/**
 * The directories the cycle probes, in order, without duplicates.
 *
 * `/tmp` and `/var/tmp` are the container's scratch (tmpfs on Docker and
 * Podman, the root filesystem itself on Apple `container`); `TMPDIR` is where
 * Deno and the agents actually make temp files, which the entrypoint may have
 * relocated (Issue #515); the state volumes are the work directory's
 * siblings. An unset `workDir` simply has no state volumes to probe.
 */
export function rootFilesystemProbeDirs(
  options: { workDir: string; tmpDir?: string },
): string[] {
  const dirs = [
    "/tmp",
    "/var/tmp",
    options.tmpDir ?? "",
    resolveAgentStateDir(options.workDir),
    resolveContentApprovalStateDir(options.workDir),
  ].map((dir) => dir.trim().replace(/(.)\/+$/, "$1"))
    .filter((dir) => dir !== "");
  return [...new Set(dirs)];
}

/** Create and delete one file in `dir` — the production write probe. */
export async function probeDirectoryWritable(dir: string): Promise<void> {
  const file = await Deno.makeTempFile({ dir, prefix: ".vibe-fs-probe-" });
  await Deno.remove(file);
}

/**
 * Check the container's filesystems once.
 *
 * An absent directory is skipped (a native run has no state volumes); a write
 * refused for any reason other than an I/O-class error is warned about but is
 * not a root fault — a permission problem is not fixed by a new container.
 *
 * @returns The first fault found, or null when everything is writable.
 */
export async function detectRootFilesystemFault(
  dirs: readonly string[],
  deps: RootFilesystemProbeDeps,
): Promise<RootFilesystemFault | null> {
  const mounts = await deps.readMounts();
  const emergency = mounts === null ? null : findEmergencyReadOnlyMount(mounts);
  if (emergency) {
    return {
      path: emergency.mountPoint,
      detail: `${emergency.device} is mounted emergency_ro (the kernel ` +
        `remounted it read-only after an I/O error)`,
    };
  }
  for (const dir of dirs) {
    try {
      await deps.writeProbe(dir);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      const message = err instanceof Error ? err.message : String(err);
      const ioLine = findIoFaultLine(message);
      if (ioLine !== null) return { path: dir, detail: ioLine };
      deps.warn(
        `[root-fs] could not write a probe file in ${dir}: ${message} — not ` +
          `an I/O fault, so the run continues (Issue #3179)`,
      );
    }
  }
  return null;
}

/** The one ERROR line a faulted run logs before it ends. */
export function formatRootFilesystemFault(fault: RootFilesystemFault): string {
  return `[${ROOT_FS_FAULT_CODE}] ${fault.path} is not writable: ` +
    `${fault.detail} — nothing inside this container can repair it, so ` +
    `ending this run with status ${ROOT_FS_FAULT_EXIT_STATUS} for the ` +
    `launcher to start a fresh container (Issue #3179)`;
}

/**
 * The production probe for one run: real `/proc/mounts`, real writes, and a
 * non-I/O warning reported once per directory rather than every cycle.
 */
export function createRootFilesystemCheck(
  options: { workDir: string; tmpDir?: string; warn: (m: string) => void },
): () => Promise<RootFilesystemFault | null> {
  const dirs = rootFilesystemProbeDirs(options);
  const warned = new Set<string>();
  return () =>
    detectRootFilesystemFault(dirs, {
      readMounts: async () => {
        try {
          return await Deno.readTextFile("/proc/mounts");
        } catch {
          // Not Linux (a native macOS run): the write probes still decide.
          return null;
        }
      },
      writeProbe: probeDirectoryWritable,
      warn: (message) => {
        if (warned.has(message)) return;
        warned.add(message);
        options.warn(message);
      },
    });
}
