/** Durable events from the fleet PR babysitter's ordinary discovery pass. */

import { withFileLock } from "./file_lock.ts";

export type PrDiscoveryEventKind = "discovered" | "eligible" | "processed";

export interface PrDiscoveryEvent {
  event: PrDiscoveryEventKind;
  hostId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  recordedAt: string;
}

const EVENT_LINE_LIMIT = 16_384;
const LEDGER_BYTE_LIMIT = 16 * 1024 * 1024;
const recordedByPath = new Map<string, { day: string; keys: Set<string> }>();

/**
 * Map any host label (a free-form VIBE_HOST_ID or hostname) onto the identifier
 * shape the event ledger and deployment heartbeat accept: characters outside
 * [A-Za-z0-9_.-] become '-', leading non-alphanumerics are dropped, the result
 * is trimmed to 128 characters, and an empty result falls back to 'host'.
 */
export function reportHostId(raw: string): string {
  const mapped = raw.replace(/[^A-Za-z0-9_.-]/g, "-").replace(
    /^[^A-Za-z0-9]+/,
    "",
  ).slice(0, 128);
  return mapped || "host";
}

function validEvent(value: unknown): value is PrDiscoveryEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const event = value as Partial<PrDiscoveryEvent>;
  return ["discovered", "eligible", "processed"].includes(event.event ?? "") &&
    typeof event.hostId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(event.hostId) &&
    typeof event.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(event.repo) &&
    Number.isSafeInteger(event.prNumber) && event.prNumber! > 0 &&
    typeof event.headSha === "string" && event.headSha.length > 0 &&
    typeof event.recordedAt === "string" &&
    Number.isFinite(Date.parse(event.recordedAt));
}

/** Append one transition under a cross-process lock; errors are not swallowed. */
export async function appendPrDiscoveryEvent(
  path: string,
  event: PrDiscoveryEvent,
): Promise<void> {
  if (!validEvent(event)) throw new Error("invalid PR discovery event");
  const separator = path.lastIndexOf("/");
  if (separator > 0) {
    await Deno.mkdir(path.slice(0, separator), { recursive: true });
  }
  const dailyPath = `${path}.${
    new Date(event.recordedAt).toISOString().slice(0, 10)
  }`;
  await withFileLock(`${path}.lock`, async () => {
    const day = new Date(event.recordedAt).toISOString().slice(0, 10);
    let recorded = recordedByPath.get(path);
    if (!recorded || recorded.day !== day) {
      recorded = { day, keys: new Set() };
      recordedByPath.set(path, recorded);
    }
    const key = JSON.stringify([
      event.event,
      event.hostId,
      event.repo,
      event.prNumber,
      event.headSha,
    ]);
    if (recorded.keys.has(key)) return;
    try {
      using file = await Deno.open(dailyPath, { read: true, write: true });
      const size = (await file.stat()).size;
      if (size) {
        const start = Math.max(0, size - EVENT_LINE_LIMIT - 1);
        await file.seek(start, Deno.SeekMode.Start);
        const bytes = new Uint8Array(size - start);
        let read = 0;
        while (read < bytes.length) {
          const count = await file.read(bytes.subarray(read));
          if (count === null) {
            throw new Error("unexpected end of discovery ledger");
          }
          read += count;
        }
        if (bytes[bytes.length - 1] !== 10) {
          const lastNewline = bytes.lastIndexOf(10);
          if (lastNewline < 0 && start > 0) {
            throw new Error("discovery ledger tail exceeds line limit");
          }
          await file.truncate(start + lastNewline + 1);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await Deno.writeTextFile(dailyPath, `${JSON.stringify(event)}\n`, {
      create: true,
      append: true,
    });
    recorded.keys.add(key);
  });
}

/** Parse a bounded event file, rejecting malformed or overlong records. */
export async function readPrDiscoveryEvents(
  path: string,
  verifiedMs = 0,
  endMs = Infinity,
): Promise<PrDiscoveryEvent[]> {
  const separator = path.lastIndexOf("/");
  const directory = separator < 0 ? "." : path.slice(0, separator) || "/";
  const name = path.slice(separator + 1);
  const paths: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name === name) paths.push(path);
    const suffix = entry.name.slice(name.length + 1);
    if (
      entry.name.startsWith(`${name}.`) && /^\d{4}-\d{2}-\d{2}$/.test(suffix) &&
      Date.parse(`${suffix}T23:59:59.999Z`) >= verifiedMs &&
      Date.parse(`${suffix}T00:00:00Z`) <= endMs
    ) {
      paths.push(`${directory}/${entry.name}`);
    }
  }
  if (!paths.length) {
    throw new Deno.errors.NotFound(`no discovery ledger at ${path}`);
  }
  paths.sort();
  let total = 0;
  const rows: PrDiscoveryEvent[] = [];
  for (const filePath of paths) {
    using file = await Deno.open(filePath, { read: true });
    const bytes = new Uint8Array(LEDGER_BYTE_LIMIT - total + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = await file.read(bytes.subarray(length));
      if (count === null) break;
      length += count;
    }
    total += length;
    if (total > LEDGER_BYTE_LIMIT) {
      throw new Error(`discovery ledger exceeds ${LEDGER_BYTE_LIMIT} bytes`);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, length),
    );
    for (const [index, line] of text.split("\n").entries()) {
      if (!line) continue;
      if (line.length > EVENT_LINE_LIMIT) {
        throw new Error(
          `line ${index + 1} exceeds ${EVENT_LINE_LIMIT} characters`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`line ${index + 1} is invalid JSON`, { cause: error });
      }
      if (!validEvent(parsed)) throw new Error(`line ${index + 1} is invalid`);
      rows.push(parsed);
    }
  }
  return rows;
}
