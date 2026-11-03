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
  countAttempts,
} from "./ci_fix_attempt_markers.ts";

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
  nextEligibleAt: string | null;
  nextAction: string;
  pushedHead: string | null;
  reconciliation: BabysitterReconciliation;
  /** Bounded diagnostics from substantive no-progress attempts. */
  evidence?: string[];
  /** The one deduplicated escalation raised for this incident. */
  escalation?: { issue: string; at: string };
}

/** A repair failure whose blocker class is known where it is thrown. */
export class BabysitterFailure extends Error {
  readonly blockerClass: BabysitterBlockerClass;
  constructor(message: string, blockerClass: BabysitterBlockerClass) {
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
    /timeout|timed out|fetch failed|network|dns|econn|rate limit|401|403|bad credentials|500|502|503|504|token expired|token expires|sigkill|sigterm|out of memory|code 137|code 143/
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
): boolean {
  return !record || record.nextEligibleAt === null ||
    Date.parse(record.nextEligibleAt) <= now;
}

/** Use the existing fleet-authored PR marker as the cross-host attempt tally. */
export function sharedBabysitterAttemptCount(
  comments: readonly CiFixMarkerComment[],
  fleetLogins: readonly string[],
  signature: string,
): number {
  const markers = collectFleetCiFixMarkers(comments, fleetLogins);
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
  return countAttempts(markers, signature);
}

/** Build the established fleet-wide attempt marker for a repair outcome. */
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
    }),
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
