/** Persisted consecutive transient branch-refresh refusals (Issue #4831). */

import { atomicWrite } from "./file_utils.ts";

export const BRANCH_REFRESH_REFUSAL_FILE = ".branch_refresh_refusals_v1";
export const BRANCH_REFRESH_REFUSAL_MARKER =
  "<!-- vibe-branch-refresh-refusal-v1";
export const BRANCH_REFRESH_REFUSAL_THRESHOLD = 2;
export const BRANCH_REFRESH_REFUSAL_TTL_MS = 24 * 60 * 60 * 1000;

export type BranchRefreshTransientReason =
  | "mergeability-unknown"
  | "test-merge-parents-stale";

export interface BranchRefreshRefusalEntry {
  reason: BranchRefreshTransientReason;
  streak: number;
  lastSeenAtMs: number;
  notified: boolean;
}

export type BranchRefreshRefusalState = Map<string, BranchRefreshRefusalEntry>;

export interface BranchRefreshRefusalIo {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
}

const productionIo: BranchRefreshRefusalIo = {
  readTextFile: (path) => Deno.readTextFile(path),
  writeTextFile: async (path, data) => {
    const result = await atomicWrite({ targetFile: path, content: data });
    if (!result.ok) throw result.error;
  },
};

export function branchRefreshRefusalKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

export function classifyTransientBranchRefreshRefusal(
  message: string,
): BranchRefreshTransientReason | undefined {
  if (message.includes("PR mergeability is still UNKNOWN")) {
    return "mergeability-unknown";
  }
  if (message.includes("PR test merge parents do not match its head and base")) {
    return "test-merge-parents-stale";
  }
  return undefined;
}

export function recordBranchRefreshRefusal(
  state: BranchRefreshRefusalState,
  repo: string,
  prNumber: number,
  reason: BranchRefreshTransientReason,
  nowMs = Date.now(),
): BranchRefreshRefusalEntry {
  const key = branchRefreshRefusalKey(repo, prNumber);
  const previous = state.get(key);
  const consecutive = previous?.reason === reason &&
    nowMs - previous.lastSeenAtMs <= BRANCH_REFRESH_REFUSAL_TTL_MS;
  const entry: BranchRefreshRefusalEntry = {
    reason,
    streak: consecutive ? previous.streak + 1 : 1,
    lastSeenAtMs: nowMs,
    notified: consecutive && previous.notified,
  };
  state.set(key, entry);
  return entry;
}

export function clearBranchRefreshRefusal(
  state: BranchRefreshRefusalState,
  repo: string,
  prNumber: number,
): BranchRefreshRefusalEntry | undefined {
  const key = branchRefreshRefusalKey(repo, prNumber);
  const previous = state.get(key);
  state.delete(key);
  return previous;
}

export function parseBranchRefreshRefusals(
  raw: string,
  nowMs = Date.now(),
): BranchRefreshRefusalState {
  const state: BranchRefreshRefusalState = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return state;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    if (
      !/^[\w.-]+\/[\w.-]+#\d+$/.test(key) ||
      (entry.reason !== "mergeability-unknown" &&
        entry.reason !== "test-merge-parents-stale") ||
      !Number.isSafeInteger(entry.streak) || (entry.streak as number) < 1 ||
      typeof entry.lastSeenAtMs !== "number" ||
      !Number.isFinite(entry.lastSeenAtMs) ||
      nowMs - entry.lastSeenAtMs > BRANCH_REFRESH_REFUSAL_TTL_MS ||
      typeof entry.notified !== "boolean"
    ) continue;
    state.set(key, {
      reason: entry.reason,
      streak: entry.streak as number,
      lastSeenAtMs: entry.lastSeenAtMs,
      notified: entry.notified,
    });
  }
  return state;
}

export function serialiseBranchRefreshRefusals(
  state: BranchRefreshRefusalState,
  nowMs = Date.now(),
): string {
  const live = Object.fromEntries(
    [...state].filter(([, entry]) =>
      nowMs - entry.lastSeenAtMs <= BRANCH_REFRESH_REFUSAL_TTL_MS
    ),
  );
  return JSON.stringify(live);
}

export async function readBranchRefreshRefusals(
  workDir: string,
  io: BranchRefreshRefusalIo = productionIo,
  warn: (message: string) => void = console.warn,
): Promise<BranchRefreshRefusalState> {
  try {
    return parseBranchRefreshRefusals(
      await io.readTextFile(`${workDir}/${BRANCH_REFRESH_REFUSAL_FILE}`),
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      warn(
        `Could not read branch-refresh refusal state in ${workDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return new Map();
  }
}

export async function writeBranchRefreshRefusals(
  workDir: string,
  state: BranchRefreshRefusalState,
  io: BranchRefreshRefusalIo = productionIo,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  try {
    await io.writeTextFile(
      `${workDir}/${BRANCH_REFRESH_REFUSAL_FILE}`,
      serialiseBranchRefreshRefusals(state),
    );
  } catch (error) {
    warn(
      `Could not persist branch-refresh refusal state in ${workDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
