/**
 * File-backed checkpoints for the external orchestrator (Issue #3642).
 *
 * One JSON file per issue lives in the checkpoint directory. Writes go to a
 * temporary file that is renamed over the target, so a reader never sees a
 * half-written checkpoint. A file whose schema is not
 * {@link ORCHESTRATION_CHECKPOINT_SCHEMA} is never resumed: it is ignored
 * with a warning, so an old layout cannot be replayed by accident.
 *
 * Australian English spelling throughout (behaviour, recognised).
 */

import type {
  OrchestrationRefusal,
  OrchestrationState,
  StructuredResult,
  TargetRole,
} from "./types.ts";
import { ORCHESTRATION_TRANSITIONS } from "./types.ts";

/** The schema key every checkpoint carries. Anything else is ignored. */
export const ORCHESTRATION_CHECKPOINT_SCHEMA = "orchestration-checkpoint-v1";

/** The persisted state of one orchestrated run. */
export interface OrchestrationCheckpoint {
  schema: typeof ORCHESTRATION_CHECKPOINT_SCHEMA;
  issueId: string;
  leaseId: string;
  /** Epoch milliseconds of the last renewal of the lease. */
  leaseHeartbeatMs: number;
  state: OrchestrationState;
  /** Provider invocations made so far, across every resume of the run. */
  invocations: number;
  /** Spend so far, across every resume of the run. */
  costUsd: number;
  /** Output of each successful call, keyed by its idempotency key. */
  steps: Record<string, string>;
  results: StructuredResult[];
  /** Set once the run reaches a terminal outcome. */
  final?: {
    state: "done" | "blocked" | "refused" | "timed_out" | "cancelled";
    reason: string;
    managerOutput?: string;
    refusal?: OrchestrationRefusal;
  };
}

function checkpointPath(checkpointDir: string, issueId: string): string {
  return `${checkpointDir}/${encodeURIComponent(issueId)}.json`;
}

/**
 * The key that makes one role call idempotent: a call whose key already has a
 * recorded output is not sent again on resume.
 *
 * @param issueId - The issue the run works on.
 * @param role - The role the call plays.
 * @param attempt - The attempt number, counted from zero.
 * @param brief - The brief the call is given; a changed brief is a new call.
 * @returns `<issueId>:<role>:<attempt>:<sha256 of brief, hex>`.
 */
export async function idempotencyKey(
  issueId: string,
  role: TargetRole,
  attempt: number,
  brief: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(brief),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${issueId}:${role}:${attempt}:${hex}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCheckpointShape(value: Record<string, unknown>): boolean {
  return typeof value.issueId === "string" &&
    typeof value.leaseId === "string" &&
    typeof value.leaseHeartbeatMs === "number" &&
    typeof value.state === "string" &&
    Object.hasOwn(ORCHESTRATION_TRANSITIONS, value.state) &&
    typeof value.invocations === "number" &&
    typeof value.costUsd === "number" &&
    isRecord(value.steps) &&
    Array.isArray(value.results);
}

/**
 * Reads the checkpoint for `issueId`, if one is present and usable.
 *
 * A missing file yields no checkpoint and no warning. A file that is not
 * JSON, is malformed, names another issue, or carries another schema yields
 * no checkpoint and a warning that says why.
 *
 * @param checkpointDir - The directory holding the checkpoint files.
 * @param issueId - The issue whose checkpoint is wanted.
 * @returns The checkpoint, and a warning when one was ignored.
 */
export async function loadCheckpoint(
  checkpointDir: string,
  issueId: string,
): Promise<{ checkpoint?: OrchestrationCheckpoint; warning?: string }> {
  const path = checkpointPath(checkpointDir, issueId);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      warning:
        `orchestration checkpoint ${path} is not valid JSON; ignoring it and starting fresh`,
    };
  }
  if (!isRecord(parsed)) {
    return {
      warning:
        `orchestration checkpoint ${path} is not an object; ignoring it and starting fresh`,
    };
  }
  if (parsed.schema !== ORCHESTRATION_CHECKPOINT_SCHEMA) {
    return {
      warning: `orchestration checkpoint ${path} has schema ${
        JSON.stringify(parsed.schema)
      }, expected ${ORCHESTRATION_CHECKPOINT_SCHEMA}; ignoring it and starting fresh`,
    };
  }
  if (!isCheckpointShape(parsed) || parsed.issueId !== issueId) {
    return {
      warning:
        `orchestration checkpoint ${path} is malformed; ignoring it and starting fresh`,
    };
  }
  return { checkpoint: parsed as unknown as OrchestrationCheckpoint };
}

/**
 * Writes the checkpoint atomically: a temporary file in the same directory,
 * renamed over the target. A failed rename removes its temporary file.
 *
 * @param checkpointDir - The directory holding the checkpoint files.
 * @param checkpoint - The checkpoint to persist.
 */
export async function saveCheckpoint(
  checkpointDir: string,
  checkpoint: OrchestrationCheckpoint,
): Promise<void> {
  await Deno.mkdir(checkpointDir, { recursive: true });
  const path = checkpointPath(checkpointDir, checkpoint.issueId);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(
    temporary,
    `${JSON.stringify(checkpoint, null, 2)}\n`,
  );
  try {
    await Deno.rename(temporary, path);
  } catch (err) {
    try {
      await Deno.remove(temporary);
    } catch (cleanup) {
      // A missing temporary file is the expected outcome; anything else is worth reporting.
      if (!(cleanup instanceof Deno.errors.NotFound)) {
        console.warn(
          `orchestration checkpoint: could not remove ${temporary}: ${cleanup}`,
        );
      }
    }
    throw err;
  }
}
