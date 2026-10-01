/**
 * Move a corrupt clone aside and re-clone it, at most once per repo per 24 h
 * per host (Issue #2957).
 *
 * `discardBrokenClone` (Issue #2848) already removes a directory that holds
 * no repository at all; this module handles the harder case — a directory
 * that *is* a repository, but a corrupt one (`detectHostFault` classes its
 * git output as `"clone-corrupt"`). Deleting it outright would discard any
 * clue a human might need to diagnose a host that keeps corrupting clones,
 * so it is renamed aside with a timestamp instead and only cleaned up the
 * next time the same repo needs recovering. The 24 h window stops a
 * persistently broken host/repo pair from looping forever.
 */

import type { Result } from "../types.ts";
import { detectHostFault } from "./host_fault.ts";
import { atomicWrite } from "./file_utils.ts";
import { withStateLock } from "./state_mutex.ts";
import { getHostname } from "./worker_identity.ts";

/** A repo is only re-cloned once per this many milliseconds, per host. */
export const CLONE_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** True when git output describes a corrupt clone (detectHostFault === "clone-corrupt"). */
export function isCloneCorruption(message: string): boolean {
  return detectHostFault(message) === "clone-corrupt";
}

/** Sanitise a hostname for use in a filename, as `repo_fast_failure_tracker.ts` does. */
function sanitiseHostname(hostname: string): string {
  const cleaned = hostname.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown-host";
}

/** `${workDir}/clone_recoveries_${sanitisedHost}.json` — one state file per host. */
export function cloneRecoveryStatePath(
  workDir: string,
  hostname: string = getHostname(),
): string {
  return `${workDir}/clone_recoveries_${sanitiseHostname(hostname)}.json`;
}

/** Options for {@link recoverCorruptClone}; both default to the real host/clock. */
export interface CloneRecoveryOptions {
  now?: () => Date;
  hostname?: string;
}

/** The state file's shape: repo slug to ISO timestamp of its last recovery. */
type RecoveryState = Record<string, string>;

/**
 * Load the state file; `ok({})` if missing or unparseable (warning logged),
 * `err` for any other read fault — that must not silently reset the 24 h cap.
 */
async function loadState(statePath: string): Promise<Result<RecoveryState>> {
  let text: string;
  try {
    text = await Deno.readTextFile(statePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { ok: true, value: {} };
    }
    return {
      ok: false,
      error: new Error(
        `Could not read the clone recovery state at ${statePath}: ${error}`,
      ),
    };
  }
  try {
    const parsed = JSON.parse(text);
    if (
      parsed !== null && typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((value) => typeof value === "string")
    ) {
      return { ok: true, value: parsed as RecoveryState };
    }
  } catch {
    // Fall through to the warning below — an unparseable file is overwritten.
  }
  console.warn(
    `[corrupt-clone-recovery] ${statePath} is not valid recovery state; treating it as empty`,
  );
  return { ok: true, value: {} };
}

/** UTC `YYYYMMDDTHHMMSSZ`, e.g. `20261001T120000Z`. */
function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** The directory holding `path` — no `@std/path` in this import map. */
function parentDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : "/";
}

/** The final path segment — no `@std/path` in this import map. */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/**
 * Move a corrupt clone aside and record the recovery, unless the same repo
 * was already recovered on this host within {@link CLONE_RECOVERY_WINDOW_MS}.
 *
 * @returns `ok(<aside path>)` on success; `repoPath` no longer exists
 *   afterwards. `err` when the repo was already re-cloned too recently, or
 *   when any filesystem step fails.
 */
export async function recoverCorruptClone(
  repo: string,
  repoPath: string,
  workDir: string,
  gitMessage: string,
  options: CloneRecoveryOptions = {},
): Promise<Result<string>> {
  const now = options.now ?? (() => new Date());
  const statePath = cloneRecoveryStatePath(workDir, options.hostname);

  const base = baseName(repoPath);
  if (base === "" || base === "." || base === "..") {
    return {
      ok: false,
      error: new Error(`Not a recoverable path: ${repoPath}`),
    };
  }

  return await withStateLock(statePath, async (): Promise<Result<string>> => {
    const loaded = await loadState(statePath);
    if (!loaded.ok) return loaded;
    const state = loaded.value;
    const lastRecovery = state[repo];
    const nowDate = now();
    if (lastRecovery !== undefined) {
      const elapsed = nowDate.getTime() - new Date(lastRecovery).getTime();
      if (elapsed >= 0 && elapsed < CLONE_RECOVERY_WINDOW_MS) {
        return {
          ok: false,
          error: new Error(
            `The clone of ${repo} at ${repoPath} is corrupt (${gitMessage}) and was already re-cloned within 24 h on this host, so it is not re-cloned again.`,
          ),
        };
      }
    }

    const parent = parentDirectory(repoPath);
    const prefix = `${base}.corrupt-`;
    try {
      for await (const entry of Deno.readDir(parent)) {
        if (entry.name.startsWith(prefix)) {
          const siblingPath = `${parent}/${entry.name}`;
          try {
            await Deno.remove(siblingPath, { recursive: true });
          } catch (error) {
            return {
              ok: false,
              error: new Error(
                `Could not remove the old corrupt clone sibling at ${siblingPath}: ${error}`,
              ),
            };
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        return {
          ok: false,
          error: new Error(
            `Could not list the directory ${parent} to remove old corrupt clone siblings: ${error}`,
          ),
        };
      }
    }

    const aside = `${repoPath}.corrupt-${formatTimestamp(nowDate)}`;
    try {
      await Deno.rename(repoPath, aside);
    } catch (error) {
      return {
        ok: false,
        error: new Error(
          `Could not move the corrupt clone from ${repoPath} to ${aside}: ${error}`,
        ),
      };
    }

    const newState: RecoveryState = { ...state, [repo]: nowDate.toISOString() };
    const written = await atomicWrite({
      targetFile: statePath,
      content: JSON.stringify(newState, null, 2) + "\n",
    });
    if (!written.ok) {
      return {
        ok: false,
        error: new Error(
          `Could not record the clone recovery in ${statePath}: ${written.error.message}`,
        ),
      };
    }

    const firstLine = gitMessage.split("\n")[0]!.trim();
    console.error(
      `ERROR: corrupt clone of ${repo} moved aside to ${aside}; re-cloning: ${firstLine}`,
    );
    return { ok: true, value: aside };
  });
}
