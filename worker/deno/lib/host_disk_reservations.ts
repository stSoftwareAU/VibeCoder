/**
 * Host-disk reservation ledger (Issue #5105).
 *
 * Shared by the fleet PR babysitter (which runs on the host) and the worker
 * (in its container). The babysitter writes one JSON file per running repair
 * container into `<log dir>/host-disk-reservations/` (host-side
 * `${RUN_CORE_LOG_DIR}/host-disk-reservations`, guest-side
 * `${HOME}/logs/host-disk-reservations`), the same mounted log directory that
 * carries `host-disk.json` (see `HOST_DISK_REFRESH_FILE` in host_disk.ts).
 * Both sides admit new disk-growing work through the same function against the
 * same floor, and the worker credits back what a babysitter repair has consumed
 * (while it runs, and after it ends until a later launcher reading arrives) so
 * a babysitter-driven dip is a wait, not a kill.
 */

export const HOST_DISK_RESERVATIONS_DIR = "host-disk-reservations";

/** A babysitter repair's host footprint: its worker-image container rootfs (~8 GB) plus its own egress proxy rootfs (~7.6 GB), measured in the #5105 comments. */
export const BABYSITTER_LAUNCH_FOOTPRINT_BYTES = 16 * 1024 ** 3;

export interface HostDiskReservation {
  holder: "babysitter";
  /** Container name; used as the file name `${id}.json`. */
  id: string;
  bytes: number;
  /** Host free bytes measured at admission. */
  availableAtAdmission: number;
  /** Epoch ms. */
  admittedAt: number;
  /** Epoch ms. */
  expiresAt: number;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const FILE_RE = /^[a-z0-9][a-z0-9-]{0,79}\.json$/;

function isPositiveSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

function isNonNegativeSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** Name of the first invalid field, or null when the value is valid. */
function invalidField(r: unknown): string | null {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return "body";
  const o = r as Record<string, unknown>;
  if (o.holder !== "babysitter") return "holder";
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) return "id";
  if (!isPositiveSafeInt(o.bytes)) return "bytes";
  if (!isNonNegativeSafeInt(o.availableAtAdmission)) {
    return "availableAtAdmission";
  }
  if (!isPositiveSafeInt(o.admittedAt)) return "admittedAt";
  if (!isPositiveSafeInt(o.expiresAt) || o.expiresAt <= o.admittedAt) {
    return "expiresAt";
  }
  return null;
}

/** Returns the validated reservation parsed from file text, or null if it is malformed. */
export function parseHostDiskReservation(
  text: string,
): HostDiskReservation | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (invalidField(o) !== null) return null;
  const v = o as HostDiskReservation;
  return {
    holder: "babysitter",
    id: v.id,
    bytes: v.bytes,
    availableAtAdmission: v.availableAtAdmission,
    admittedAt: v.admittedAt,
    expiresAt: v.expiresAt,
  };
}

/** Atomically writes the reservation file and returns its final path. */
export async function writeHostDiskReservation(
  dir: string,
  reservation: HostDiskReservation,
): Promise<string> {
  const bad = invalidField(reservation);
  if (bad !== null) {
    throw new Error(`Invalid host disk reservation: bad field ${bad}`);
  }
  await Deno.mkdir(dir, { recursive: true, mode: 0o755 });
  const finalPath = `${dir}/${reservation.id}.json`;
  const tmpPath = `${dir}/.${reservation.id}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmpPath, JSON.stringify(reservation) + "\n", {
    mode: 0o644,
  });
  try {
    await Deno.chmod(tmpPath, 0o644);
    await Deno.rename(tmpPath, finalPath);
  } catch (e) {
    try {
      await Deno.remove(tmpPath);
    } catch (cleanupErr) {
      if (cleanupErr instanceof Deno.errors.NotFound) throw e;
      const msg = (x: unknown) => x instanceof Error ? x.message : String(x);
      throw new Error(
        `Failed to write host disk reservation (${msg(e)}) and failed to ` +
          `remove temp file ${tmpPath} (${msg(cleanupErr)})`,
        { cause: e },
      );
    }
    throw e;
  }
  return finalPath;
}

/** Removes a reservation file (a missing file is fine) and returns nothing. */
export async function removeHostDiskReservation(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return;
    throw new Error(
      `Failed to remove host disk reservation ${path}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/** Returns the unexpired, valid reservations in the directory, oldest admission first. */
export async function readLiveHostDiskReservations(
  dir: string,
  nowMs: number,
): Promise<HostDiskReservation[]> {
  const live: HostDiskReservation[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !FILE_RE.test(entry.name)) continue;
      let text: string;
      try {
        text = await Deno.readTextFile(`${dir}/${entry.name}`);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) continue;
        throw e;
      }
      const r = parseHostDiskReservation(text);
      if (r === null) continue;
      if (`${r.id}.json` !== entry.name) continue;
      if (r.expiresAt <= nowMs) continue;
      live.push(r);
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return live.length ? live : [];
    throw new Error(
      `Failed to read host disk reservations in ${dir}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  return live.sort((a, b) => a.admittedAt - b.admittedAt);
}

export interface ReservationAccount {
  reservedBytes: number;
  consumedBytes: number;
  outstandingBytes: number;
}

/** Returns the reserved, consumed and outstanding byte totals for the live reservations. */
export function accountHostDiskReservations(
  live: readonly HostDiskReservation[],
  availableBytes: number,
): ReservationAccount {
  if (live.length === 0) {
    return { reservedBytes: 0, consumedBytes: 0, outstandingBytes: 0 };
  }
  const reservedBytes = live.reduce((s, r) => s + r.bytes, 0);
  const earliest = live.reduce((a, b) => (b.admittedAt < a.admittedAt ? b : a));
  const consumedBytes = Math.min(
    reservedBytes,
    Math.max(0, earliest.availableAtAdmission - availableBytes),
  );
  return {
    reservedBytes,
    consumedBytes,
    outstandingBytes: reservedBytes - consumedBytes,
  };
}

export type HostDiskLaunchAdmission =
  | { admit: true }
  | { admit: false; reason: string };

const gb = (n: number): string => (n / 1e9).toFixed(1);

/** Returns whether a launch of the requested size keeps the host above its floor, with a reason if not. */
export function admitHostDiskLaunch(input: {
  availableBytes: number;
  floorBytes: number;
  requestBytes: number;
  live: readonly HostDiskReservation[];
}): HostDiskLaunchAdmission {
  const { outstandingBytes } = accountHostDiskReservations(
    input.live,
    input.availableBytes,
  );
  if (
    input.availableBytes - outstandingBytes - input.requestBytes >=
      input.floorBytes
  ) {
    return { admit: true };
  }
  return {
    admit: false,
    reason:
      `host disk has ${gb(input.availableBytes)} GB free with ${
        gb(outstandingBytes)
      } GB outstanding across ${input.live.length} live reservation(s); ` +
      `the ${gb(input.requestBytes)} GB request would breach the ${
        gb(input.floorBytes)
      } GB floor (Issue #5105)`,
  };
}

/**
 * Below this fraction of the floor no reservation credit applies (Issue
 * #5105): a running build stops and the launch ends whatever the ledger
 * says, so a wrong consumption estimate can never take the host to zero.
 */
export const HOST_DISK_HARD_MINIMUM_FLOOR_FRACTION = 0.5;

/**
 * Returns the bytes live babysitter reservations have consumed that explain a
 * dip below the floor, or null if they do not.
 *
 * The drop in free space since the earliest reservation's admission is only
 * credited after the worker's own measured growth over the same span is
 * taken off it, and never past the reserved bytes: the babysitter is not
 * credited with space the worker used. Unknown worker growth credits nothing,
 * and no credit applies below {@link HOST_DISK_HARD_MINIMUM_FLOOR_FRACTION}
 * of the floor.
 */
export function babysitterDipCreditBytes(input: {
  availableBytes: number;
  floorBytes: number;
  live: readonly HostDiskReservation[];
  /** The worker's own host growth since the earliest live reservation was admitted; undefined when not measured. */
  workerGrowthBytes: number | undefined;
}): number | null {
  if (input.availableBytes >= input.floorBytes) return null;
  if (
    input.availableBytes <
      input.floorBytes * HOST_DISK_HARD_MINIMUM_FLOOR_FRACTION
  ) {
    return null;
  }
  if (input.workerGrowthBytes === undefined || input.live.length === 0) {
    return null;
  }
  // The drop with the worker's own growth added back, capped at the reserved
  // bytes: what the babysitter alone can have taken.
  const { consumedBytes: credit } = accountHostDiskReservations(
    input.live,
    input.availableBytes + Math.max(0, input.workerGrowthBytes),
  );
  if (credit <= 0) return null;
  if (input.availableBytes + credit < input.floorBytes) return null;
  return credit;
}

/**
 * How long after a reservation's admission the worker may first see it and
 * still measure its own growth from then (Issue #5105). A reservation first
 * seen later is never credited: the worker's growth before it looked is not
 * known.
 */
export const RESERVATION_SIGHTING_GRACE_MS = 10 * 60_000;

/**
 * How long a vanished reservation keeps explaining a dip (Issue #5105): the
 * launcher's reading is refreshed every 300 s and a worker ignores one older
 * than 15 minutes (`DEFAULT_REFRESH_MAX_AGE_MS` in host_disk.ts), so a reading
 * measured after the release always arrives inside this bound or is stale.
 */
export const RELEASED_RESERVATION_CREDIT_MAX_MS = 15 * 60_000;

/** What {@link ReservationSightings.observe} reports. */
export interface ReservationObservation {
  /**
   * The worker's own growth since the earliest live or released reservation
   * was first seen; undefined when that is not known.
   */
  workerGrowthBytes: number | undefined;
  /**
   * Reservations that vanished (the repair ended, or the file expired) but
   * whose space the worker's launcher reading may not show as returned yet.
   * They still explain a dip, and are not outstanding for admission.
   */
  released: HostDiskReservation[];
}

interface Sighting {
  reservation: HostDiskReservation;
  /** The worker's footprint when first seen; undefined when not timely or unmeasured. */
  base: number | undefined;
}

/**
 * Tracks, per reservation, the worker's own footprint growth when it first
 * saw the reservation, so the dip credit can take the worker's growth since
 * then off the drop (Issue #5105).
 *
 * A reservation that vanishes is held as released until the launcher's
 * reading was measured after the worker saw it go (or
 * {@link RELEASED_RESERVATION_CREDIT_MAX_MS} passes): the babysitter removes
 * the file right after teardown, but the worker's low reading comes from
 * `host-disk.json`, which is rewritten only every few minutes. Dropping the
 * credit at once would kill a build over space the host has just got back.
 */
export class ReservationSightings {
  private readonly firstSeen = new Map<string, Sighting>();
  private readonly released = new Map<
    string,
    { sighting: Sighting; vanishedAt: number }
  >();

  /** Whether any of `live` has not been seen before (it needs a baseline). */
  hasUnseen(live: readonly HostDiskReservation[]): boolean {
    return live.some((r) => !this.firstSeen.has(r.id));
  }

  /** Whether a vanished reservation is still held as released. */
  get holdsReleased(): boolean {
    return this.released.size > 0;
  }

  /**
   * Records new reservations and releases, and returns the worker's growth
   * since the earliest tracked one was first seen (undefined when not known:
   * no footprint measurement, or a reservation first seen past the grace)
   * with the reservations held as released.
   *
   * `launcherMeasuredAtMs` is when the launcher reading the worker has
   * adopted was measured; a release is forgotten once that is later than the
   * moment the worker saw the reservation go.
   */
  observe(
    live: readonly HostDiskReservation[],
    workerFootprintBytes: number | undefined,
    nowMs: number,
    launcherMeasuredAtMs: number,
  ): ReservationObservation {
    const ids = new Set(live.map((r) => r.id));
    for (const [id, sighting] of [...this.firstSeen]) {
      if (ids.has(id)) continue;
      this.firstSeen.delete(id);
      // A reservation the worker could not measure from is never credited.
      if (sighting.base !== undefined) {
        this.released.set(id, { sighting, vanishedAt: nowMs });
      }
    }
    for (const [id, { vanishedAt }] of [...this.released]) {
      if (
        ids.has(id) || launcherMeasuredAtMs > vanishedAt ||
        nowMs - vanishedAt > RELEASED_RESERVATION_CREDIT_MAX_MS
      ) this.released.delete(id);
    }
    for (const r of live) {
      if (this.firstSeen.has(r.id)) continue;
      const timely = nowMs - r.admittedAt <= RESERVATION_SIGHTING_GRACE_MS;
      this.firstSeen.set(r.id, {
        reservation: r,
        base: timely ? workerFootprintBytes : undefined,
      });
    }
    const released = [...this.released.values()].map((h) =>
      h.sighting.reservation
    );
    const tracked = [...live, ...released];
    if (tracked.length === 0 || workerFootprintBytes === undefined) {
      return { workerGrowthBytes: undefined, released };
    }
    const earliest = tracked.reduce((
      a,
      b,
    ) => (b.admittedAt < a.admittedAt ? b : a));
    const base = (this.firstSeen.get(earliest.id) ??
      this.released.get(earliest.id)?.sighting)?.base;
    return {
      workerGrowthBytes: base === undefined
        ? undefined
        : Math.max(0, workerFootprintBytes - base),
      released,
    };
  }
}
