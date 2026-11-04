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
  await withFileLock(`${path}.lock`, async () => {
    const file = await Deno.open(path, { create: true, append: true, write: true });
    try {
      await file.write(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    } finally {
      file.close();
    }
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
      throw new Error(`line ${index + 1} exceeds ${EVENT_LINE_LIMIT} characters`);
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
