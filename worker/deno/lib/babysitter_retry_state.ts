/** Durable retry and post-push reconciliation state for the PR babysitter. */

import { atomicWrite } from "./file_utils.ts";
import {
  computeFailureSignature,
  type FailureSignatureInput,
} from "./auto_fix_attempt_tracker.ts";
import {
  buildCiFixAttemptMarker,
  type CiFixAttemptMarker,
  type CiFixMarkerComment,
  collectFleetCiFixMarkers,
} from "./ci_fix_attempt_markers.ts";
import { containsSecret } from "./secret_redaction.ts";

/** Distinguishes a stall handoff from a label the fleet applied. */
export const BABYSITTER_HANDOFF_MARKER = "<!-- vibe-babysitter-handoff -->";

export type BabysitterBlockerClass =
  | "infrastructure"
  | "capability"
  | "race"
  | "code"
  | "owner"
  | "unknown";

export type BabysitterReconciliation =
  | "repair-needed"
  | "waiting-for-ci-review"
  | "closed-unmerged"
  | "merged"
  | "owner-hold";

export interface BabysitterRetryRecord {
  version: 2;
  repo: string;
  prNumber: number;
  failureIdentity: string;
  observedHead: string;
  blockerClass: BabysitterBlockerClass;
  lastOutcome: string;
  attempts: { infrastructure: number; substantive: number };
  /** Local no-progress attempts whose shared marker could not be published. */
  unpublishedAttempts?: number;
  /** A push reset awaiting publication to the shared tally. */
  pendingPushReset?: string;
  nextEligibleAt: string | null;
  nextAction: string;
  pushedHead: string | null;
  reconciliation: BabysitterReconciliation;
  /** Bounded diagnostics from substantive no-progress attempts. */
  evidence?: string[];
  /** The deduplicated stall-ladder handoff raised for this incident. */
  escalation?: { issue: string; at: string };
}

/** A repair failure whose blocker class is known where it is thrown. */
export class BabysitterFailure extends Error {
  readonly blockerClass: BabysitterBlockerClass;
  constructor(
    message: string,
    blockerClass: BabysitterBlockerClass,
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = "BabysitterFailure";
    this.blockerClass = blockerClass;
  }
}

export interface LoadBabysitterRetryStateOptions {
  stateDir: string;
  repo: string;
  prNumber: number;
  failureIdentity: string;
  head: string;
  legacyPath?: string;
  now?: number;
}

const LEGACY_COOLDOWN_MS = 5 * 60_000;
const REPAIR_CHECKPOINT_LIMIT = 2 * 1024 * 1024;

function statePath(
  stateDir: string,
  repo: string,
  prNumber: number,
  failureIdentity: string,
): string {
  const signature = computeFailureSignature({
    repo,
    locus: { kind: "pr", number: prNumber },
    checkName: failureIdentity,
  });
  return `${stateDir}/attempt-v2-${signature}.json`;
}

function parseRecord(value: unknown, path: string): BabysitterRetryRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Invalid babysitter retry state in ${path}: expected object`,
    );
  }
  const record = value as Record<string, unknown>;
  const attempts = record.attempts as Record<string, unknown> | undefined;
  const blockerClasses: BabysitterBlockerClass[] = [
    "infrastructure",
    "capability",
    "race",
    "code",
    "owner",
    "unknown",
  ];
  const reconciliations: BabysitterReconciliation[] = [
    "repair-needed",
    "waiting-for-ci-review",
    "closed-unmerged",
    "merged",
    "owner-hold",
  ];
  const valid = record.version === 2 && typeof record.repo === "string" &&
    Number.isSafeInteger(record.prNumber) &&
    typeof record.failureIdentity === "string" &&
    typeof record.observedHead === "string" &&
    blockerClasses.includes(record.blockerClass as BabysitterBlockerClass) &&
    typeof record.lastOutcome === "string" && attempts !== undefined &&
    Number.isSafeInteger(attempts.infrastructure) &&
    Number.isSafeInteger(attempts.substantive) &&
    (attempts.infrastructure as number) >= 0 &&
    (attempts.substantive as number) >= 0 &&
    (record.unpublishedAttempts === undefined ||
      (Number.isSafeInteger(record.unpublishedAttempts) &&
        (record.unpublishedAttempts as number) >= 0)) &&
    (record.pendingPushReset === undefined ||
      typeof record.pendingPushReset === "string") &&
    (record.nextEligibleAt === null ||
      (typeof record.nextEligibleAt === "string" &&
        Number.isFinite(Date.parse(record.nextEligibleAt)))) &&
    typeof record.nextAction === "string" &&
    (record.pushedHead === null || typeof record.pushedHead === "string") &&
    reconciliations.includes(
      record.reconciliation as BabysitterReconciliation,
    ) &&
    (record.evidence === undefined ||
      (Array.isArray(record.evidence) &&
        record.evidence.every((line) => typeof line === "string"))) &&
    (record.escalation === undefined ||
      (typeof record.escalation === "object" && record.escalation !== null &&
        typeof (record.escalation as Record<string, unknown>).issue ===
          "string" &&
        typeof (record.escalation as Record<string, unknown>).at ===
          "string"));
  if (!valid) throw new Error(`Invalid babysitter retry state in ${path}`);
  return record as unknown as BabysitterRetryRecord;
}

export async function saveBabysitterRetryState(
  stateDir: string,
  record: BabysitterRetryRecord,
): Promise<void> {
  await Deno.mkdir(stateDir, { recursive: true });
  const path = statePath(
    stateDir,
    record.repo,
    record.prNumber,
    record.failureIdentity,
  );
  const result = await atomicWrite({
    targetFile: path,
    content: `${JSON.stringify(record)}\n`,
  });
  if (!result.ok) {
    throw new Error(
      `Could not save babysitter retry state: ${result.error.message}`,
    );
  }
}

export async function loadBabysitterRetryState(
  options: LoadBabysitterRetryStateOptions,
): Promise<BabysitterRetryRecord | undefined> {
  const path = statePath(
    options.stateDir,
    options.repo,
    options.prNumber,
    options.failureIdentity,
  );
  try {
    const record = parseRecord(
      JSON.parse(await Deno.readTextFile(path)),
      path,
    );
    if (
      record.repo !== options.repo || record.prNumber !== options.prNumber ||
      record.failureIdentity !== options.failureIdentity
    ) {
      throw new Error(`Babysitter retry state identity mismatch in ${path}`);
    }
    return record;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (!options.legacyPath) return undefined;
  try {
    await Deno.readTextFile(options.legacyPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  const now = options.now ?? Date.now();
  const record: BabysitterRetryRecord = {
    version: 2,
    repo: options.repo,
    prNumber: options.prNumber,
    failureIdentity: options.failureIdentity,
    observedHead: options.head,
    blockerClass: "unknown",
    lastOutcome: "legacy-attempt",
    attempts: { infrastructure: 0, substantive: 0 },
    nextEligibleAt: new Date(now + LEGACY_COOLDOWN_MS).toISOString(),
    nextAction: "retry after the migrated legacy cooldown",
    pushedHead: null,
    reconciliation: "repair-needed",
  };
  await saveBabysitterRetryState(options.stateDir, record);
  return record;
}

export async function listBabysitterRetryStates(
  stateDir: string,
  repo: string,
  prNumber?: number,
): Promise<BabysitterRetryRecord[]> {
  const records: BabysitterRetryRecord[] = [];
  try {
    for await (const entry of Deno.readDir(stateDir)) {
      if (
        !entry.isFile || !/^attempt-v2-[a-f0-9]{16}\.json$/.test(entry.name)
      ) {
        continue;
      }
      const path = `${stateDir}/${entry.name}`;
      const record = parseRecord(
        JSON.parse(await Deno.readTextFile(path)),
        path,
      );
      if (
        record.repo === repo &&
        (prNumber === undefined || record.prNumber === prNumber)
      ) {
        records.push(record);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return records;
    throw error;
  }
  return records;
}

export async function clearBabysitterRetryStates(
  stateDir: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  for (
    const record of await listBabysitterRetryStates(stateDir, repo, prNumber)
  ) {
    await Deno.remove(
      statePath(stateDir, repo, prNumber, record.failureIdentity),
    );
  }
  try {
    for await (const entry of Deno.readDir(stateDir)) {
      if (!entry.isFile || !entry.name.startsWith("repair-checkpoint-v1-")) {
        continue;
      }
      const path = `${stateDir}/${entry.name}`;
      const value = JSON.parse(await Deno.readTextFile(path));
      if (
        typeof value === "object" && value !== null &&
        value.repo === repo && value.prNumber === prNumber
      ) {
        await Deno.remove(path);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function repairCheckpointPath(
  stateDir: string,
  repo: string,
  prNumber: number,
  failureIdentity: string,
  head: string,
): string {
  const signature = computeFailureSignature({
    repo,
    locus: { kind: "pr", number: prNumber },
    checkName: `${failureIdentity}:${head}`,
  });
  return `${stateDir}/repair-checkpoint-v1-${signature}.json`;
}

/** Persist only a bounded, secret-scanned repair patch for this exact head. */
export async function saveBabysitterRepairCheckpoint(options: {
  stateDir: string;
  repo: string;
  prNumber: number;
  failureIdentity: string;
  head: string;
  patch: string;
}): Promise<void> {
  if (!options.patch.trim()) return;
  if (new TextEncoder().encode(options.patch).byteLength > REPAIR_CHECKPOINT_LIMIT) {
    throw new Error("Babysitter repair checkpoint exceeds the 2 MiB limit");
  }
  if (containsSecret(options.patch)) {
    throw new Error("Babysitter repair checkpoint contains a detectable secret");
  }
  await Deno.mkdir(options.stateDir, { recursive: true });
  const path = repairCheckpointPath(
    options.stateDir,
    options.repo,
    options.prNumber,
    options.failureIdentity,
    options.head,
  );
  const record = {
    version: 1,
    repo: options.repo,
    prNumber: options.prNumber,
    failureIdentity: options.failureIdentity,
    head: options.head,
    patch: options.patch,
  };
  const result = await atomicWrite({
    targetFile: path,
    content: `${JSON.stringify(record)}\n`,
  });
  if (!result.ok) {
    throw new Error(`Could not save babysitter repair checkpoint: ${result.error.message}`);
  }
}

/** Read a checkpoint only for the same PR failure and unchanged remote head. */
export async function loadBabysitterRepairCheckpoint(options: {
  stateDir: string;
  repo: string;
  prNumber: number;
  failureIdentity: string;
  head: string;
}): Promise<string | undefined> {
  const path = repairCheckpointPath(
    options.stateDir,
    options.repo,
    options.prNumber,
    options.failureIdentity,
    options.head,
  );
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid babysitter repair checkpoint in ${path}`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 || record.repo !== options.repo ||
    record.prNumber !== options.prNumber ||
    record.failureIdentity !== options.failureIdentity ||
    record.head !== options.head || typeof record.patch !== "string" ||
    new TextEncoder().encode(record.patch).byteLength > REPAIR_CHECKPOINT_LIMIT ||
    containsSecret(record.patch)
  ) {
    throw new Error(`Invalid babysitter repair checkpoint in ${path}`);
  }
  return record.patch;
}

/** Remove the checkpoint after successful revalidation or terminal cleanup. */
export async function clearBabysitterRepairCheckpoint(options: {
  stateDir: string;
  repo: string;
  prNumber: number;
  failureIdentity: string;
  head: string;
}): Promise<void> {
  try {
    await Deno.remove(repairCheckpointPath(
      options.stateDir,
      options.repo,
      options.prNumber,
      options.failureIdentity,
      options.head,
    ));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** Classify a thrown failure from its structured cause, then from its text. */
export function classifyBabysitterFailure(
  error: unknown,
): BabysitterBlockerClass {
  if (error instanceof BabysitterFailure) return error.blockerClass;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOSPC" || code === "ENOENT") return "capability";
  return classifyBabysitterBlocker(
    error instanceof Error ? error.message : String(error),
  );
}

export function classifyBabysitterBlocker(
  message: string,
): BabysitterBlockerClass {
  const text = message.toLowerCase();
  if (/needs-human|human decision|owner hold|manual hold/.test(text)) {
    return "owner";
  }
  if (
    /no space left|enospc|command not found|missing tool|not installed|chromium.*(?:sandbox|launch)/
      .test(text)
  ) {
    return "capability";
  }
  if (
    /head changed|changed during|lock renewal|another worker holds|reference lock/
      .test(text)
  ) {
    return "race";
  }
  if (
    isTransientNetworkFailure(message) ||
    /timeout|timed out|fetch failed|network|dns|econn|rate limit|http\s+(?:401|403|408|429|5\d\d)\b|resolve host|connection (?:reset|refused)|hung up|rpc failed|internal server error|failed to connect|bad credentials|token expired|token expires|sigkill|sigterm|out of memory|code 137|code 143/
      .test(text)
  ) {
    return "infrastructure";
  }
  return "code";
}

export function babysitterRetryDelayMs(
  blockerClass: BabysitterBlockerClass,
  attempts: number,
): number | null {
  if (blockerClass === "owner") return null;
  const exponent = Math.max(0, Math.min(6, attempts - 1));
  switch (blockerClass) {
    case "infrastructure":
      return Math.min(30 * 60_000, 60_000 * 2 ** exponent);
    case "capability":
      return Math.min(2 * 60 * 60_000, 15 * 60_000 * 2 ** exponent);
    case "race":
      return 60_000;
    case "code":
      return Math.min(60 * 60_000, 5 * 60_000 * 2 ** exponent);
    case "unknown":
      return 5 * 60_000;
  }
}

export function babysitterRetryEligible(
  record: BabysitterRetryRecord | undefined,
  now = Date.now(),
  head?: string,
): boolean {
  return !record || (head !== undefined && head !== record.observedHead) ||
    (!record.escalation && (record.nextEligibleAt === null ||
      Date.parse(record.nextEligibleAt) <= now));
}

/** Count consecutive no-progress outcomes in our fleet-authored marker family. */
export function sharedBabysitterAttemptCount(
  comments: readonly CiFixMarkerComment[],
  fleetLogins: readonly string[],
  signature: string,
): number {
  // Translate only our own family for the shared strict attribute parser.
  // CI-fix markers are deliberately not evidence of babysitter attempts.
  const isolated = [...comments].sort((a, b) => a.id - b.id).map((comment) => ({
    ...comment,
    body: (comment.body ?? "").replaceAll(
      "vibe-ci-fix-attempt",
      "ignored-ci-attempt",
    )
      .replaceAll("vibe-babysitter-attempt", "vibe-ci-fix-attempt"),
  }));
  const markers = collectFleetCiFixMarkers(isolated, fleetLogins);
  if (!markers.fleetResolved) {
    throw new Error(
      "Cannot resolve fleet authors for the babysitter attempt tally",
    );
  }
  if (markers.ignoredOutsideFleet > 0) {
    console.warn(
      `[babysitter-retry] ignored ${markers.ignoredOutsideFleet} attempt marker comment(s) from outside the fleet`,
    );
  }
  let consecutive = 0;
  for (const attempt of markers.attempts.get(signature) ?? []) {
    consecutive = attempt.outcome === "pushed" ? 0 : consecutive + 1;
  }
  return consecutive;
}

/** Build a babysitter-only marker that cannot authorise lifting human holds. */
export function buildBabysitterAttemptMarker(
  repo: string,
  prNumber: number,
  failureIdentity: string,
  head: string,
  attempt: number,
  outcome: CiFixAttemptMarker["outcome"],
): { signature: string; marker: string } {
  const signature = babysitterFailureSignature(repo, prNumber, failureIdentity);
  return {
    signature,
    marker: buildCiFixAttemptMarker({
      signature,
      checkName: failureIdentity,
      head,
      attempt,
      outcome,
    }).replace("vibe-ci-fix-attempt", "vibe-babysitter-attempt"),
  };
}

export function babysitterFailureSignature(
  repo: string,
  prNumber: number,
  failureIdentity: string,
): string {
  const input: FailureSignatureInput = {
    repo,
    locus: { kind: "pr", number: prNumber },
    checkName: failureIdentity,
  };
  return computeFailureSignature(input);
}
import { isTransientNetworkFailure } from "./transient_network_failure.ts";
