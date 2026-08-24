/**
 * The worker's standing view of the work volume (Issue #345).
 *
 * ## Why a monitor and not a bare function
 *
 * The standing totals (Issue #244) were a fire-and-forget log line: nothing
 * kept the reading, so nothing could act on it. On GRQ-23 the line said
 * `total 0.0 GB` beside a count of twelve clones every cycle for days while
 * `Feature work-volume: available` sat two lines above it, and the host then
 * crashed out of disk. A blind probe that nobody consults is worse than no
 * probe: it reads as "plenty of room".
 *
 * This monitor holds the latest reading on a bounded cadence — mirroring
 * {@link HostDiskMonitor} (Issue #226) — so the same measurement feeds the
 * log line, the feature report and the fleet-health payload. A reading that
 * is not a measurement (see `workVolumeUnknownReason`) is `unknown`, never a
 * confident zero.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  formatWorkVolumeUsage,
  scanWorkVolumeUsage,
  type WorkVolumeUsage,
  type WorkVolumeUsageOptions,
  workVolumeUnknownReason,
} from "./work_volume_usage.ts";

/** Minimum milliseconds between walks — a `du` sweep is not free. */
export const DEFAULT_WORK_VOLUME_SAMPLE_INTERVAL_MS = 300_000;

/** What the worker believes the work volume holds right now. */
export interface WorkVolumeStatus {
  /** True once a walk has run this process. */
  probed: boolean;
  /** True when the latest reading is a measurement the worker can act on. */
  known: boolean;
  /** Why the reading is not a measurement, when it is not. */
  reason: string | null;
  /** The measured total, when {@link known}. */
  totalBytes?: number;
}

/** Injectable pieces of {@link WorkVolumeMonitor}. */
export interface WorkVolumeMonitorOptions {
  workDir: string;
  /** Monitored repositories, `owner/repo` or bare directory names. */
  monitoredRepos: readonly string[];
  /** Directory walk, injectable (default {@link scanWorkVolumeUsage}). */
  scan?: (options: WorkVolumeUsageOptions) => Promise<WorkVolumeUsage>;
  /** Milliseconds clock, injectable. */
  now?: () => number;
  /** Minimum milliseconds between walks. */
  sampleIntervalMs?: number;
}

/**
 * Without a monitored list every clone reads as side/data, so the split is
 * refused rather than published — and a refusal is not a measurement either.
 */
const NO_MONITORED_REPOS =
  "standing totals skipped — no monitored repositories configured, so every " +
  "clone would read as side/data (Issue #244)";

/** Keeps the work volume's standing totals current on a bounded cadence. */
export class WorkVolumeMonitor {
  private readonly options: WorkVolumeMonitorOptions;
  private readonly scan: (
    options: WorkVolumeUsageOptions,
  ) => Promise<WorkVolumeUsage>;
  private readonly now: () => number;
  private readonly sampleIntervalMs: number;
  private lastUsage: WorkVolumeUsage | null = null;
  private lastSampleAt: number | undefined;
  private lastStatus: WorkVolumeStatus = {
    probed: false,
    known: false,
    reason: "not probed yet",
  };

  constructor(options: WorkVolumeMonitorOptions) {
    this.options = options;
    this.scan = options.scan ?? scanWorkVolumeUsage;
    this.now = options.now ?? Date.now;
    this.sampleIntervalMs = options.sampleIntervalMs ??
      DEFAULT_WORK_VOLUME_SAMPLE_INTERVAL_MS;
  }

  /** The most recent status without walking. */
  get status(): WorkVolumeStatus {
    return this.lastStatus;
  }

  /**
   * Walk if the cadence allows, then return the current status.
   *
   * `force` skips the cadence — the end-of-cycle sample must see the volume
   * at its peak, not the reading taken before the clones existed.
   */
  async probe(options: { force?: boolean } = {}): Promise<WorkVolumeStatus> {
    if (this.options.monitoredRepos.length === 0) {
      this.lastUsage = null;
      this.lastStatus = { probed: true, known: false, reason: NO_MONITORED_REPOS };
      return this.lastStatus;
    }
    const t = this.now();
    if (
      options.force !== true &&
      this.lastSampleAt !== undefined &&
      t - this.lastSampleAt < this.sampleIntervalMs
    ) {
      return this.lastStatus;
    }
    this.lastSampleAt = t;

    const usage = await this.scan({
      workDir: this.options.workDir,
      monitoredRepos: this.options.monitoredRepos,
    });
    this.lastUsage = usage;
    const reason = workVolumeUnknownReason(usage);
    this.lastStatus = reason === null
      ? { probed: true, known: true, reason: null, totalBytes: usage.totalBytes }
      : { probed: true, known: false, reason };
    return this.lastStatus;
  }

  /**
   * The one-line standing-totals log, walking first when the cadence allows.
   *
   * A reading that is not a measurement says so — the line never publishes a
   * total the probe did not measure.
   */
  async report(
    options: { label?: string; force?: boolean } = {},
  ): Promise<string> {
    const label = options.label ?? "Work volume";
    const status = await this.probe({ force: options.force === true });
    if (this.lastUsage === null) {
      return `${label}: unknown — ${status.reason}`;
    }
    return formatWorkVolumeUsage(this.lastUsage, label);
  }
}
