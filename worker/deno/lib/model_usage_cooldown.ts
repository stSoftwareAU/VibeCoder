/**
 * Model-scoped usage cooldown store (Issue #5086).
 *
 * A Claude usage limit that names a model tier ("You've reached your Fable
 * limit") exhausts that tier only. The other tiers on the same provider still
 * work, so the run steps down the model ladder (fable -> opus) rather than
 * marking the whole provider exhausted. This module remembers, per
 * `<provider>/<family>`, that a tier is cooling, so the next phase on the same
 * volume starts on the next model down instead of re-probing the cap.
 *
 * The store lives in WORK_DIR beside `.rate_limit_signal`, but it is NOT a
 * provider pause: it never writes `.rate_limit_signal` and nothing reads it as
 * one. Entries clear by expiry. A cooled model is not run until its window
 * ends, so no run can observe the limit lifting earlier; expiry is the
 * recovery path.
 *
 * A malformed file or an unknown version is an error, never "no cooldown": a
 * silent miss would re-probe a capped tier on every phase.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { modelFamily } from "./planning_run_stats.ts";
import type { Result } from "../types.ts";

/** File name of the cooldown store inside WORK_DIR. */
export const MODEL_USAGE_COOLDOWN_FILENAME = ".model_usage_cooldown.json";

interface CooldownEntry {
  untilEpochMs: number;
  recordedAtEpochMs: number;
}

interface CooldownFile {
  version: 1;
  cooldowns: Record<string, CooldownEntry>;
}

/** Absolute path of the cooldown store for `workDir`. */
export function modelUsageCooldownPath(workDir: string): string {
  return `${workDir.replace(/\/+$/, "")}/${MODEL_USAGE_COOLDOWN_FILENAME}`;
}

function cooldownKey(provider: string, model: string): string {
  return `${provider}/${modelFamily(model) ?? model.toLowerCase()}`;
}

function fail<T>(message: string): Result<T> {
  return { ok: false, error: new Error(message) };
}

async function readFile(workDir: string): Promise<Result<CooldownFile>> {
  const path = modelUsageCooldownPath(workDir);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { ok: true, value: { version: 1, cooldowns: {} } };
    }
    return fail(
      `Could not read model usage cooldown file ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fail(
      `Malformed model usage cooldown file ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const record = parsed as Partial<CooldownFile> | null;
  if (
    typeof record !== "object" || record === null || record.version !== 1 ||
    typeof record.cooldowns !== "object" || record.cooldowns === null
  ) {
    return fail(
      `Unrecognised model usage cooldown file ${path}: expected version 1 with a cooldowns object`,
    );
  }
  return { ok: true, value: record as CooldownFile };
}

/**
 * Record that `model`'s family on `provider` is cooling until `untilEpochMs`.
 * Read-modify-write; expired entries are dropped; the write is atomic (temp
 * file + rename in the same directory).
 */
export async function recordModelUsageCooldown(
  workDir: string,
  entry: {
    provider: string;
    model: string;
    untilEpochMs: number;
    nowMs: number;
  },
): Promise<Result<void>> {
  const existing = await readFile(workDir);
  // A corrupt store is replaced rather than blocking a fresh record: the
  // entry being written is newer than anything the file could hold.
  const cooldowns: Record<string, CooldownEntry> = {};
  if (existing.ok) {
    for (const [key, value] of Object.entries(existing.value.cooldowns)) {
      if (
        value && typeof value.untilEpochMs === "number" &&
        value.untilEpochMs > entry.nowMs
      ) {
        cooldowns[key] = value;
      }
    }
  }
  cooldowns[cooldownKey(entry.provider, entry.model)] = {
    untilEpochMs: entry.untilEpochMs,
    recordedAtEpochMs: entry.nowMs,
  };
  const path = modelUsageCooldownPath(workDir);
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.mkdir(workDir, { recursive: true });
    await Deno.writeTextFile(
      tmp,
      JSON.stringify({ version: 1, cooldowns }, null, 2) + "\n",
    );
    await Deno.rename(tmp, path);
    return { ok: true, value: undefined };
  } catch (error) {
    try {
      await Deno.remove(tmp);
    } catch { /* nothing to clean */ }
    return fail(
      `Could not write model usage cooldown file ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** The active cooldown for `model`'s family on `provider`, if any. */
export async function readActiveModelCooldown(
  workDir: string,
  provider: string,
  model: string,
  nowMs: number,
): Promise<Result<{ untilEpochMs: number } | undefined>> {
  const file = await readFile(workDir);
  if (!file.ok) return file;
  const entry = file.value.cooldowns[cooldownKey(provider, model)];
  if (
    !entry || typeof entry.untilEpochMs !== "number" ||
    entry.untilEpochMs <= nowMs
  ) {
    return { ok: true, value: undefined };
  }
  return { ok: true, value: { untilEpochMs: entry.untilEpochMs } };
}

/**
 * Step down from `model` while the current rung is cooling and a cheaper rung
 * exists. Stops at the cheapest rung even if it is cooling. `skipped` lists
 * the cooling rungs stepped over, in order.
 */
export async function firstModelNotCooling(
  workDir: string,
  provider: string,
  model: string,
  nowMs: number,
  cheaperModel: (model: string) => string | null,
): Promise<Result<{ model: string; skipped: string[] }>> {
  const skipped: string[] = [];
  let current = model;
  for (;;) {
    const cooling = await readActiveModelCooldown(
      workDir,
      provider,
      current,
      nowMs,
    );
    if (!cooling.ok) return cooling;
    if (!cooling.value) break;
    const next = cheaperModel(current);
    if (!next) break;
    skipped.push(current);
    current = next;
  }
  return { ok: true, value: { model: current, skipped } };
}
