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
  await withFileLock(`${path}.lock`, async () => {
    try {
      const bytes = await Deno.readFile(path);
      if (bytes.length && bytes[bytes.length - 1] !== 10) {
        const lastNewline = bytes.lastIndexOf(10);
        await Deno.truncate(path, lastNewline + 1);
      }
      const prior = await readPrDiscoveryEvents(path);
      if (
        prior.some((row) =>
          row.event === event.event && row.hostId === event.hostId &&
          row.repo === event.repo && row.prNumber === event.prNumber &&
          row.headSha === event.headSha && row.recordedAt === event.recordedAt
        )
      ) return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await Deno.writeTextFile(path, `${JSON.stringify(event)}\n`, {
      create: true,
      append: true,
    });
  });
}

/** Parse a bounded event file, rejecting malformed or overlong records. */
export async function readPrDiscoveryEvents(
  path: string,
): Promise<PrDiscoveryEvent[]> {
  const text = await Deno.readTextFile(path);
  const rows: PrDiscoveryEvent[] = [];
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
  return rows;
}
