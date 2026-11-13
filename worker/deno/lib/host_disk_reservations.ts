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
 * same floor, and the worker credits back what a live babysitter repair has
 * consumed so a babysitter-driven dip is a wait, not a kill.
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
 * Tracks, per live reservation, the worker's own footprint growth when it
 * first saw the reservation, so the dip credit can take the worker's growth
 * since then off the drop (Issue #5105).
 */
export class ReservationSightings {
  private readonly firstSeen = new Map<string, number | undefined>();

  /**
   * Records new reservations and returns the worker's growth since the
   * earliest live one was first seen, or undefined when that is not known
   * (no footprint measurement, or a reservation first seen past the grace).
   */
  observe(
    live: readonly HostDiskReservation[],
    workerFootprintBytes: number | undefined,
    nowMs: number,
  ): number | undefined {
    const ids = new Set(live.map((r) => r.id));
    for (const id of [...this.firstSeen.keys()]) {
      if (!ids.has(id)) this.firstSeen.delete(id);
    }
    for (const r of live) {
      if (this.firstSeen.has(r.id)) continue;
      const timely = nowMs - r.admittedAt <= RESERVATION_SIGHTING_GRACE_MS;
      this.firstSeen.set(r.id, timely ? workerFootprintBytes : undefined);
    }
    if (live.length === 0 || workerFootprintBytes === undefined) {
      return undefined;
    }
    const earliest = live.reduce((
      a,
      b,
    ) => (b.admittedAt < a.admittedAt ? b : a));
    const base = this.firstSeen.get(earliest.id);
    if (base === undefined) return undefined;
    return Math.max(0, workerFootprintBytes - base);
  }
}
