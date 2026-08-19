/**
 * Machine identifier helper (Issue #1454).
 *
 * Provides a stable per-install machine identifier used to mark heartbeat
 * comments on GitHub so multiple workers sharing a single GitHub user can
 * distinguish which machine holds a live claim.
 *
 * The identifier combines the machine hostname with a UUID persisted in
 * `${workDir}/.machine-id`. The UUID survives hostname changes and the
 * hostname aids human readability. Format: `{hostname}-{uuid}`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { getHostname } from "./worker_identity.ts";

/** Filename used for the persisted per-install UUID. */
export const MACHINE_ID_FILENAME = ".machine-id";

/**
 * Sanitise a machine ID segment so it survives use inside an HTML comment
 * marker without breaking parsing. We only allow characters that cannot
 * clash with the delimiters `:` and `-->`.
 */
function sanitiseSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Read or create the per-install UUID stored at `${workDir}/.machine-id`.
 *
 * The first call on a machine generates a UUID with `crypto.randomUUID()`
 * and writes it to disk. Subsequent calls read the same value.
 */
export async function getOrCreateMachineUuid(workDir: string): Promise<string> {
  const path = `${workDir}/${MACHINE_ID_FILENAME}`;
  try {
    const existing = (await Deno.readTextFile(path)).trim();
    if (existing.length > 0) return existing;
  } catch {
    // File does not exist — fall through and create it
  }
  const uuid = crypto.randomUUID();
  try {
    await Deno.mkdir(workDir, { recursive: true });
  } catch {
    // Directory already exists — non-fatal
  }
  try {
    await Deno.writeTextFile(path, uuid);
  } catch {
    // Persistence failed — return the generated UUID anyway so the caller
    // still gets a usable identifier for the current process.
  }
  return uuid;
}

/**
 * Get the stable machine identifier for the current install.
 *
 * Combines the hostname with the per-install UUID. The UUID guarantees
 * uniqueness even when two machines happen to share a hostname.
 */
export async function getMachineId(workDir: string): Promise<string> {
  const host = sanitiseSegment(getHostname() || "unknown-host") ||
    "unknown-host";
  const uuid = sanitiseSegment(await getOrCreateMachineUuid(workDir));
  return `${host}-${uuid}`;
}
