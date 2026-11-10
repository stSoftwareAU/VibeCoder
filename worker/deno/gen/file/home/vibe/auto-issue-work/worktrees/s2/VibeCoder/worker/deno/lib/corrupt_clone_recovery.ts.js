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
 *
 * When the cap refuses a second re-clone within the window, the refusal is a
 * distinct, worse signal than a first corruption: the same repo on the same
 * host corrupted its clone twice inside 24 h. Issue #2958 gives that refusal
 * a machine-parseable `clone-corrupt-repeat` payload riding inside the error
 * message, so callers downstream of `setupRepo` (which only ever sees the
 * message, not this module's types) can still recover the structured detail.
 * The release path reads it only from a setup-phase outcome (Issue #3446).
 */ import { detectHostFault } from "./host_fault.ts";
import { atomicWrite } from "./file_utils.ts";
import { withStateLock } from "./state_mutex.ts";
import { getHostname } from "./worker_identity.ts";
import { CLONE_CORRUPT_MARKER } from "./failure_diagnosis.ts";
/** Prefix of the one-line payload a cap refusal carries (Issue #2958). */ export const CLONE_CORRUPT_REPEAT_MARKER = "clone-corrupt-repeat";
/** Git/aside strings stored in state and the repeat payload are capped to this length. */ const MAX_STORED_MESSAGE_LENGTH = 1000;
/** Truncate `value` to {@link MAX_STORED_MESSAGE_LENGTH} so stored state and payloads stay bounded. */ function capLength(value) {
  return value.length > MAX_STORED_MESSAGE_LENGTH ? value.slice(0, MAX_STORED_MESSAGE_LENGTH) : value;
}
/** `clone-corrupt-repeat: {json}` on a single line. */ export function formatCloneCorruptRepeat(repeat) {
  return `${CLONE_CORRUPT_REPEAT_MARKER}: ${JSON.stringify(repeat)}`;
}
/**
 * Matches only a line that starts with the single-line
 * `clone-corrupt-repeat: {json}` payload, the line the worker writes (Issue
 * #3446), so text that merely quotes the payload mid-line is not read.
 */ const CLONE_CORRUPT_REPEAT_RE = new RegExp(`^${CLONE_CORRUPT_REPEAT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (\\{[^\\n]*\\})`, "m");
/**
 * Parse the payload out of a message with it on a line of its own; `null`
 * when absent or malformed (validates every field's type; optional fields
 * must be a string when present).
 */ export function parseCloneCorruptRepeat(message) {
  const match = message.match(CLONE_CORRUPT_REPEAT_RE);
  if (match === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch  {
    // Malformed JSON payload — not a well-formed clone-corrupt-repeat marker.
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed;
  if (typeof obj.repo !== "string" || typeof obj.host !== "string" || typeof obj.previousAt !== "string" || typeof obj.currentAt !== "string" || typeof obj.currentGitMessage !== "string" || obj.previousGitMessage !== undefined && typeof obj.previousGitMessage !== "string" || obj.aside !== undefined && typeof obj.aside !== "string") {
    return null;
  }
  const repeat = {
    repo: obj.repo,
    host: obj.host,
    previousAt: obj.previousAt,
    currentAt: obj.currentAt,
    currentGitMessage: obj.currentGitMessage
  };
  if (typeof obj.previousGitMessage === "string") {
    repeat.previousGitMessage = obj.previousGitMessage;
  }
  if (typeof obj.aside === "string") {
    repeat.aside = obj.aside;
  }
  return repeat;
}
/**
 * Read the repeat payload from a run outcome. Only a setup-phase `no_pr`
 * outcome is read: the setup phase is the only one whose message carries the
 * cap refusal, and later phases' messages can quote agent- or
 * repository-controlled text, which must never be trusted as the worker's
 * signal (Issue #3446).
 */ export function cloneCorruptRepeatFromOutcome(outcome) {
  if (outcome?.kind !== "no_pr" || outcome.phase !== "setup") return null;
  return parseCloneCorruptRepeat(outcome.message);
}
/** A repo is only re-cloned once per this many milliseconds, per host. */ export const CLONE_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** True when git output describes a corrupt clone (detectHostFault === "clone-corrupt"). */ export function isCloneCorruption(message) {
  return detectHostFault(message) === "clone-corrupt";
}
/** Sanitise a hostname for use in a filename, as `repo_fast_failure_tracker.ts` does. */ function sanitiseHostname(hostname) {
  const cleaned = hostname.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown-host";
}
/** `${workDir}/clone_recoveries_${sanitisedHost}.json` — one state file per host. */ export function cloneRecoveryStatePath(workDir, hostname = getHostname()) {
  return `${workDir}/clone_recoveries_${sanitiseHostname(hostname)}.json`;
}
/** The ISO timestamp of a recovery, whichever state form it was written in. */ function recoveryTimestamp(value) {
  return typeof value === "string" ? value : value.at;
}
/** Whether `value` is a legacy ISO string or a well-formed {@link RecoveryStateEntry}. */ function isValidRecoveryValue(value) {
  if (typeof value === "string") return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value;
  return typeof obj.at === "string" && (obj.gitMessage === undefined || typeof obj.gitMessage === "string") && (obj.aside === undefined || typeof obj.aside === "string");
}
/**
 * Load the state file; `ok({})` if missing or unparseable (warning logged),
 * `err` for any other read fault — that must not silently reset the 24 h cap.
 */ async function loadState(statePath) {
  let text;
  try {
    text = await Deno.readTextFile(statePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        ok: true,
        value: {}
      };
    }
    return {
      ok: false,
      error: new Error(`Could not read the clone recovery state at ${statePath}: ${error}`)
    };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Object.values(parsed).every(isValidRecoveryValue)) {
      return {
        ok: true,
        value: parsed
      };
    }
  } catch  {
  // Fall through to the warning below — an unparseable file is overwritten.
  }
  console.warn(`[corrupt-clone-recovery] ${statePath} is not valid recovery state; treating it as empty`);
  return {
    ok: true,
    value: {}
  };
}
/** UTC `YYYYMMDDTHHMMSSZ`, e.g. `20261001T120000Z`. */ function formatTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
/** The directory holding `path` — no `@std/path` in this import map. */ function parentDirectory(path) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : "/";
}
/** The final path segment — no `@std/path` in this import map. */ function baseName(path) {
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
 */ export async function recoverCorruptClone(repo, repoPath, workDir, gitMessage, options = {}) {
  const now = options.now ?? (()=>new Date());
  const statePath = cloneRecoveryStatePath(workDir, options.hostname);
  const base = baseName(repoPath);
  if (base === "" || base === "." || base === "..") {
    return {
      ok: false,
      error: new Error(`Not a recoverable path: ${repoPath}`)
    };
  }
  return await withStateLock(statePath, async ()=>{
    const loaded = await loadState(statePath);
    if (!loaded.ok) return loaded;
    const state = loaded.value;
    const lastRecovery = state[repo];
    const nowDate = now();
    if (lastRecovery !== undefined) {
      const previousAt = recoveryTimestamp(lastRecovery);
      const elapsed = nowDate.getTime() - new Date(previousAt).getTime();
      if (elapsed >= 0 && elapsed < CLONE_RECOVERY_WINDOW_MS) {
        const host = options.hostname ?? getHostname();
        const repeat = {
          repo,
          host,
          previousAt,
          currentAt: nowDate.toISOString(),
          currentGitMessage: capLength(gitMessage)
        };
        if (typeof lastRecovery !== "string") {
          if (lastRecovery.gitMessage !== undefined) {
            repeat.previousGitMessage = lastRecovery.gitMessage;
          }
          if (lastRecovery.aside !== undefined) {
            repeat.aside = lastRecovery.aside;
          }
        }
        return {
          ok: false,
          error: new Error(`The clone of ${repo} at ${repoPath} is corrupt (${gitMessage}) and was already re-cloned within 24 h on this host, so it is not re-cloned again. — ${CLONE_CORRUPT_MARKER}.\n` + formatCloneCorruptRepeat(repeat))
        };
      }
    }
    const parent = parentDirectory(repoPath);
    const prefix = `${base}.corrupt-`;
    try {
      for await (const entry of Deno.readDir(parent)){
        if (entry.name.startsWith(prefix)) {
          const siblingPath = `${parent}/${entry.name}`;
          try {
            await Deno.remove(siblingPath, {
              recursive: true
            });
          } catch (error) {
            return {
              ok: false,
              error: new Error(`Could not remove the old corrupt clone sibling at ${siblingPath}: ${error}`)
            };
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        return {
          ok: false,
          error: new Error(`Could not list the directory ${parent} to remove old corrupt clone siblings: ${error}`)
        };
      }
    }
    const aside = `${repoPath}.corrupt-${formatTimestamp(nowDate)}`;
    try {
      await Deno.rename(repoPath, aside);
    } catch (error) {
      return {
        ok: false,
        error: new Error(`Could not move the corrupt clone from ${repoPath} to ${aside}: ${error}`)
      };
    }
    const newEntry = {
      at: nowDate.toISOString(),
      gitMessage: capLength(gitMessage),
      aside
    };
    const newState = {
      ...state,
      [repo]: newEntry
    };
    const written = await atomicWrite({
      targetFile: statePath,
      content: JSON.stringify(newState, null, 2) + "\n"
    });
    if (!written.ok) {
      return {
        ok: false,
        error: new Error(`Could not record the clone recovery in ${statePath}: ${written.error.message}`)
      };
    }
    const firstLine = gitMessage.split("\n")[0].trim();
    console.error(`corrupt clone of ${repo} moved aside to ${aside}; re-cloning: ${firstLine}`);
    return {
      ok: true,
      value: aside
    };
  });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb3JydXB0X2Nsb25lX3JlY292ZXJ5LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogTW92ZSBhIGNvcnJ1cHQgY2xvbmUgYXNpZGUgYW5kIHJlLWNsb25lIGl0LCBhdCBtb3N0IG9uY2UgcGVyIHJlcG8gcGVyIDI0IGhcbiAqIHBlciBob3N0IChJc3N1ZSAjMjk1NykuXG4gKlxuICogYGRpc2NhcmRCcm9rZW5DbG9uZWAgKElzc3VlICMyODQ4KSBhbHJlYWR5IHJlbW92ZXMgYSBkaXJlY3RvcnkgdGhhdCBob2xkc1xuICogbm8gcmVwb3NpdG9yeSBhdCBhbGw7IHRoaXMgbW9kdWxlIGhhbmRsZXMgdGhlIGhhcmRlciBjYXNlIOKAlCBhIGRpcmVjdG9yeVxuICogdGhhdCAqaXMqIGEgcmVwb3NpdG9yeSwgYnV0IGEgY29ycnVwdCBvbmUgKGBkZXRlY3RIb3N0RmF1bHRgIGNsYXNzZXMgaXRzXG4gKiBnaXQgb3V0cHV0IGFzIGBcImNsb25lLWNvcnJ1cHRcImApLiBEZWxldGluZyBpdCBvdXRyaWdodCB3b3VsZCBkaXNjYXJkIGFueVxuICogY2x1ZSBhIGh1bWFuIG1pZ2h0IG5lZWQgdG8gZGlhZ25vc2UgYSBob3N0IHRoYXQga2VlcHMgY29ycnVwdGluZyBjbG9uZXMsXG4gKiBzbyBpdCBpcyByZW5hbWVkIGFzaWRlIHdpdGggYSB0aW1lc3RhbXAgaW5zdGVhZCBhbmQgb25seSBjbGVhbmVkIHVwIHRoZVxuICogbmV4dCB0aW1lIHRoZSBzYW1lIHJlcG8gbmVlZHMgcmVjb3ZlcmluZy4gVGhlIDI0IGggd2luZG93IHN0b3BzIGFcbiAqIHBlcnNpc3RlbnRseSBicm9rZW4gaG9zdC9yZXBvIHBhaXIgZnJvbSBsb29waW5nIGZvcmV2ZXIuXG4gKlxuICogV2hlbiB0aGUgY2FwIHJlZnVzZXMgYSBzZWNvbmQgcmUtY2xvbmUgd2l0aGluIHRoZSB3aW5kb3csIHRoZSByZWZ1c2FsIGlzIGFcbiAqIGRpc3RpbmN0LCB3b3JzZSBzaWduYWwgdGhhbiBhIGZpcnN0IGNvcnJ1cHRpb246IHRoZSBzYW1lIHJlcG8gb24gdGhlIHNhbWVcbiAqIGhvc3QgY29ycnVwdGVkIGl0cyBjbG9uZSB0d2ljZSBpbnNpZGUgMjQgaC4gSXNzdWUgIzI5NTggZ2l2ZXMgdGhhdCByZWZ1c2FsXG4gKiBhIG1hY2hpbmUtcGFyc2VhYmxlIGBjbG9uZS1jb3JydXB0LXJlcGVhdGAgcGF5bG9hZCByaWRpbmcgaW5zaWRlIHRoZSBlcnJvclxuICogbWVzc2FnZSwgc28gY2FsbGVycyBkb3duc3RyZWFtIG9mIGBzZXR1cFJlcG9gICh3aGljaCBvbmx5IGV2ZXIgc2VlcyB0aGVcbiAqIG1lc3NhZ2UsIG5vdCB0aGlzIG1vZHVsZSdzIHR5cGVzKSBjYW4gc3RpbGwgcmVjb3ZlciB0aGUgc3RydWN0dXJlZCBkZXRhaWwuXG4gKiBUaGUgcmVsZWFzZSBwYXRoIHJlYWRzIGl0IG9ubHkgZnJvbSBhIHNldHVwLXBoYXNlIG91dGNvbWUgKElzc3VlICMzNDQ2KS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHR5cGUgeyBSdW5PdXRjb21lIH0gZnJvbSBcIi4vcnVuX291dGNvbWUudHNcIjtcbmltcG9ydCB7IGRldGVjdEhvc3RGYXVsdCB9IGZyb20gXCIuL2hvc3RfZmF1bHQudHNcIjtcbmltcG9ydCB7IGF0b21pY1dyaXRlIH0gZnJvbSBcIi4vZmlsZV91dGlscy50c1wiO1xuaW1wb3J0IHsgd2l0aFN0YXRlTG9jayB9IGZyb20gXCIuL3N0YXRlX211dGV4LnRzXCI7XG5pbXBvcnQgeyBnZXRIb3N0bmFtZSB9IGZyb20gXCIuL3dvcmtlcl9pZGVudGl0eS50c1wiO1xuaW1wb3J0IHsgQ0xPTkVfQ09SUlVQVF9NQVJLRVIgfSBmcm9tIFwiLi9mYWlsdXJlX2RpYWdub3Npcy50c1wiO1xuXG4vKiogUHJlZml4IG9mIHRoZSBvbmUtbGluZSBwYXlsb2FkIGEgY2FwIHJlZnVzYWwgY2FycmllcyAoSXNzdWUgIzI5NTgpLiAqL1xuZXhwb3J0IGNvbnN0IENMT05FX0NPUlJVUFRfUkVQRUFUX01BUktFUiA9IFwiY2xvbmUtY29ycnVwdC1yZXBlYXRcIjtcblxuLyoqIEEgc2Vjb25kIGNvcnJ1cHRpb24gb2YgdGhlIHNhbWUgcmVwbyBvbiB0aGUgc2FtZSBob3N0IHdpdGhpbiB0aGUgd2luZG93LiAqL1xuZXhwb3J0IGludGVyZmFjZSBDbG9uZUNvcnJ1cHRSZXBlYXQge1xuICByZXBvOiBzdHJpbmc7XG4gIGhvc3Q6IHN0cmluZztcbiAgLyoqIElTTyB0aW1lIG9mIHRoZSBmaXJzdCBjb3JydXB0aW9uICh0aGUgcmVjb3ZlcnkgdGhlIGNhcCByZW1lbWJlcnMpLiAqL1xuICBwcmV2aW91c0F0OiBzdHJpbmc7XG4gIC8qKiBHaXQgb3V0cHV0IG9mIHRoZSBmaXJzdCBjb3JydXB0aW9uOyBhYnNlbnQgZm9yIHN0YXRlIHdyaXR0ZW4gYmVmb3JlICMyOTU4LiAqL1xuICBwcmV2aW91c0dpdE1lc3NhZ2U/OiBzdHJpbmc7XG4gIC8qKiBXaGVyZSB0aGUgZmlyc3QgY29ycnVwdCBjbG9uZSB3YXMgbW92ZWQgYXNpZGU7IGFic2VudCBmb3IgbGVnYWN5IHN0YXRlLiAqL1xuICBhc2lkZT86IHN0cmluZztcbiAgLyoqIElTTyB0aW1lIG9mIHRoaXMsIHRoZSBzZWNvbmQsIGNvcnJ1cHRpb24uICovXG4gIGN1cnJlbnRBdDogc3RyaW5nO1xuICBjdXJyZW50R2l0TWVzc2FnZTogc3RyaW5nO1xufVxuXG4vKiogR2l0L2FzaWRlIHN0cmluZ3Mgc3RvcmVkIGluIHN0YXRlIGFuZCB0aGUgcmVwZWF0IHBheWxvYWQgYXJlIGNhcHBlZCB0byB0aGlzIGxlbmd0aC4gKi9cbmNvbnN0IE1BWF9TVE9SRURfTUVTU0FHRV9MRU5HVEggPSAxMDAwO1xuXG4vKiogVHJ1bmNhdGUgYHZhbHVlYCB0byB7QGxpbmsgTUFYX1NUT1JFRF9NRVNTQUdFX0xFTkdUSH0gc28gc3RvcmVkIHN0YXRlIGFuZCBwYXlsb2FkcyBzdGF5IGJvdW5kZWQuICovXG5mdW5jdGlvbiBjYXBMZW5ndGgodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZS5sZW5ndGggPiBNQVhfU1RPUkVEX01FU1NBR0VfTEVOR1RIXG4gICAgPyB2YWx1ZS5zbGljZSgwLCBNQVhfU1RPUkVEX01FU1NBR0VfTEVOR1RIKVxuICAgIDogdmFsdWU7XG59XG5cbi8qKiBgY2xvbmUtY29ycnVwdC1yZXBlYXQ6IHtqc29ufWAgb24gYSBzaW5nbGUgbGluZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRDbG9uZUNvcnJ1cHRSZXBlYXQocmVwZWF0OiBDbG9uZUNvcnJ1cHRSZXBlYXQpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7Q0xPTkVfQ09SUlVQVF9SRVBFQVRfTUFSS0VSfTogJHtKU09OLnN0cmluZ2lmeShyZXBlYXQpfWA7XG59XG5cbi8qKlxuICogTWF0Y2hlcyBvbmx5IGEgbGluZSB0aGF0IHN0YXJ0cyB3aXRoIHRoZSBzaW5nbGUtbGluZVxuICogYGNsb25lLWNvcnJ1cHQtcmVwZWF0OiB7anNvbn1gIHBheWxvYWQsIHRoZSBsaW5lIHRoZSB3b3JrZXIgd3JpdGVzIChJc3N1ZVxuICogIzM0NDYpLCBzbyB0ZXh0IHRoYXQgbWVyZWx5IHF1b3RlcyB0aGUgcGF5bG9hZCBtaWQtbGluZSBpcyBub3QgcmVhZC5cbiAqL1xuY29uc3QgQ0xPTkVfQ09SUlVQVF9SRVBFQVRfUkUgPSBuZXcgUmVnRXhwKFxuICBgXiR7XG4gICAgQ0xPTkVfQ09SUlVQVF9SRVBFQVRfTUFSS0VSLnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCBcIlxcXFwkJlwiKVxuICB9OiAoXFxcXHtbXlxcXFxuXSpcXFxcfSlgLFxuICBcIm1cIixcbik7XG5cbi8qKlxuICogUGFyc2UgdGhlIHBheWxvYWQgb3V0IG9mIGEgbWVzc2FnZSB3aXRoIGl0IG9uIGEgbGluZSBvZiBpdHMgb3duOyBgbnVsbGBcbiAqIHdoZW4gYWJzZW50IG9yIG1hbGZvcm1lZCAodmFsaWRhdGVzIGV2ZXJ5IGZpZWxkJ3MgdHlwZTsgb3B0aW9uYWwgZmllbGRzXG4gKiBtdXN0IGJlIGEgc3RyaW5nIHdoZW4gcHJlc2VudCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUNsb25lQ29ycnVwdFJlcGVhdChcbiAgbWVzc2FnZTogc3RyaW5nLFxuKTogQ2xvbmVDb3JydXB0UmVwZWF0IHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gbWVzc2FnZS5tYXRjaChDTE9ORV9DT1JSVVBUX1JFUEVBVF9SRSk7XG4gIGlmIChtYXRjaCA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG5cbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKG1hdGNoWzFdISk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIE1hbGZvcm1lZCBKU09OIHBheWxvYWQg4oCUIG5vdCBhIHdlbGwtZm9ybWVkIGNsb25lLWNvcnJ1cHQtcmVwZWF0IG1hcmtlci5cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGlmIChwYXJzZWQgPT09IG51bGwgfHwgdHlwZW9mIHBhcnNlZCAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KHBhcnNlZCkpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBjb25zdCBvYmogPSBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGlmIChcbiAgICB0eXBlb2Ygb2JqLnJlcG8gIT09IFwic3RyaW5nXCIgfHxcbiAgICB0eXBlb2Ygb2JqLmhvc3QgIT09IFwic3RyaW5nXCIgfHxcbiAgICB0eXBlb2Ygb2JqLnByZXZpb3VzQXQgIT09IFwic3RyaW5nXCIgfHxcbiAgICB0eXBlb2Ygb2JqLmN1cnJlbnRBdCAhPT0gXCJzdHJpbmdcIiB8fFxuICAgIHR5cGVvZiBvYmouY3VycmVudEdpdE1lc3NhZ2UgIT09IFwic3RyaW5nXCIgfHxcbiAgICAob2JqLnByZXZpb3VzR2l0TWVzc2FnZSAhPT0gdW5kZWZpbmVkICYmXG4gICAgICB0eXBlb2Ygb2JqLnByZXZpb3VzR2l0TWVzc2FnZSAhPT0gXCJzdHJpbmdcIikgfHxcbiAgICAob2JqLmFzaWRlICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIG9iai5hc2lkZSAhPT0gXCJzdHJpbmdcIilcbiAgKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBjb25zdCByZXBlYXQ6IENsb25lQ29ycnVwdFJlcGVhdCA9IHtcbiAgICByZXBvOiBvYmoucmVwbyxcbiAgICBob3N0OiBvYmouaG9zdCxcbiAgICBwcmV2aW91c0F0OiBvYmoucHJldmlvdXNBdCxcbiAgICBjdXJyZW50QXQ6IG9iai5jdXJyZW50QXQsXG4gICAgY3VycmVudEdpdE1lc3NhZ2U6IG9iai5jdXJyZW50R2l0TWVzc2FnZSxcbiAgfTtcbiAgaWYgKHR5cGVvZiBvYmoucHJldmlvdXNHaXRNZXNzYWdlID09PSBcInN0cmluZ1wiKSB7XG4gICAgcmVwZWF0LnByZXZpb3VzR2l0TWVzc2FnZSA9IG9iai5wcmV2aW91c0dpdE1lc3NhZ2U7XG4gIH1cbiAgaWYgKHR5cGVvZiBvYmouYXNpZGUgPT09IFwic3RyaW5nXCIpIHtcbiAgICByZXBlYXQuYXNpZGUgPSBvYmouYXNpZGU7XG4gIH1cbiAgcmV0dXJuIHJlcGVhdDtcbn1cblxuLyoqXG4gKiBSZWFkIHRoZSByZXBlYXQgcGF5bG9hZCBmcm9tIGEgcnVuIG91dGNvbWUuIE9ubHkgYSBzZXR1cC1waGFzZSBgbm9fcHJgXG4gKiBvdXRjb21lIGlzIHJlYWQ6IHRoZSBzZXR1cCBwaGFzZSBpcyB0aGUgb25seSBvbmUgd2hvc2UgbWVzc2FnZSBjYXJyaWVzIHRoZVxuICogY2FwIHJlZnVzYWwsIGFuZCBsYXRlciBwaGFzZXMnIG1lc3NhZ2VzIGNhbiBxdW90ZSBhZ2VudC0gb3JcbiAqIHJlcG9zaXRvcnktY29udHJvbGxlZCB0ZXh0LCB3aGljaCBtdXN0IG5ldmVyIGJlIHRydXN0ZWQgYXMgdGhlIHdvcmtlcidzXG4gKiBzaWduYWwgKElzc3VlICMzNDQ2KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsb25lQ29ycnVwdFJlcGVhdEZyb21PdXRjb21lKFxuICBvdXRjb21lOiBSdW5PdXRjb21lIHwgdW5kZWZpbmVkLFxuKTogQ2xvbmVDb3JydXB0UmVwZWF0IHwgbnVsbCB7XG4gIGlmIChvdXRjb21lPy5raW5kICE9PSBcIm5vX3ByXCIgfHwgb3V0Y29tZS5waGFzZSAhPT0gXCJzZXR1cFwiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHBhcnNlQ2xvbmVDb3JydXB0UmVwZWF0KG91dGNvbWUubWVzc2FnZSk7XG59XG5cbi8qKiBBIHJlcG8gaXMgb25seSByZS1jbG9uZWQgb25jZSBwZXIgdGhpcyBtYW55IG1pbGxpc2Vjb25kcywgcGVyIGhvc3QuICovXG5leHBvcnQgY29uc3QgQ0xPTkVfUkVDT1ZFUllfV0lORE9XX01TID0gMjQgKiA2MCAqIDYwICogMTAwMDtcblxuLyoqIFRydWUgd2hlbiBnaXQgb3V0cHV0IGRlc2NyaWJlcyBhIGNvcnJ1cHQgY2xvbmUgKGRldGVjdEhvc3RGYXVsdCA9PT0gXCJjbG9uZS1jb3JydXB0XCIpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQ2xvbmVDb3JydXB0aW9uKG1lc3NhZ2U6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gZGV0ZWN0SG9zdEZhdWx0KG1lc3NhZ2UpID09PSBcImNsb25lLWNvcnJ1cHRcIjtcbn1cblxuLyoqIFNhbml0aXNlIGEgaG9zdG5hbWUgZm9yIHVzZSBpbiBhIGZpbGVuYW1lLCBhcyBgcmVwb19mYXN0X2ZhaWx1cmVfdHJhY2tlci50c2AgZG9lcy4gKi9cbmZ1bmN0aW9uIHNhbml0aXNlSG9zdG5hbWUoaG9zdG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGNsZWFuZWQgPSBob3N0bmFtZS5yZXBsYWNlKC9bXkEtWmEtejAtOS5fLV0vZywgXCJfXCIpO1xuICByZXR1cm4gY2xlYW5lZC5sZW5ndGggPiAwID8gY2xlYW5lZCA6IFwidW5rbm93bi1ob3N0XCI7XG59XG5cbi8qKiBgJHt3b3JrRGlyfS9jbG9uZV9yZWNvdmVyaWVzXyR7c2FuaXRpc2VkSG9zdH0uanNvbmAg4oCUIG9uZSBzdGF0ZSBmaWxlIHBlciBob3N0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsb25lUmVjb3ZlcnlTdGF0ZVBhdGgoXG4gIHdvcmtEaXI6IHN0cmluZyxcbiAgaG9zdG5hbWU6IHN0cmluZyA9IGdldEhvc3RuYW1lKCksXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYCR7d29ya0Rpcn0vY2xvbmVfcmVjb3Zlcmllc18ke3Nhbml0aXNlSG9zdG5hbWUoaG9zdG5hbWUpfS5qc29uYDtcbn1cblxuLyoqIE9wdGlvbnMgZm9yIHtAbGluayByZWNvdmVyQ29ycnVwdENsb25lfTsgYm90aCBkZWZhdWx0IHRvIHRoZSByZWFsIGhvc3QvY2xvY2suICovXG5leHBvcnQgaW50ZXJmYWNlIENsb25lUmVjb3ZlcnlPcHRpb25zIHtcbiAgbm93PzogKCkgPT4gRGF0ZTtcbiAgaG9zdG5hbWU/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogQSByZWNvdmVyeSwgaW4gdGhlIG9iamVjdCBmb3JtIHdyaXR0ZW4gc2luY2UgSXNzdWUgIzI5NTg6IHRoZSBJU08gdGltZSBvZlxuICogdGhlIHJlY292ZXJ5LCB0aGUgKGNhcHBlZCkgZ2l0IG91dHB1dCB0aGF0IHRyaWdnZXJlZCBpdCwgYW5kIHdoZXJlIHRoZVxuICogY29ycnVwdCBjbG9uZSB3YXMgbW92ZWQgYXNpZGUuXG4gKi9cbmludGVyZmFjZSBSZWNvdmVyeVN0YXRlRW50cnkge1xuICBhdDogc3RyaW5nO1xuICBnaXRNZXNzYWdlPzogc3RyaW5nO1xuICBhc2lkZT86IHN0cmluZztcbn1cblxuLyoqXG4gKiBUaGUgc3RhdGUgZmlsZSdzIHNoYXBlOiByZXBvIHNsdWcgdG8gaXRzIGxhc3QgcmVjb3ZlcnkuIEEgYmFyZSBJU08gc3RyaW5nXG4gKiBpcyBzdGF0ZSB3cml0dGVuIGJlZm9yZSAjMjk1OCDigJQgc3RpbGwgYSB2YWxpZCBjYXAgcmVjb3JkLCBqdXN0IHdpdGhvdXQgdGhlXG4gKiBnaXQgbWVzc2FnZSBvciBhc2lkZSBwYXRoIGEgYGNsb25lLWNvcnJ1cHQtcmVwZWF0YCBwYXlsb2FkIGNhbiBxdW90ZS5cbiAqL1xudHlwZSBSZWNvdmVyeVN0YXRlID0gUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgUmVjb3ZlcnlTdGF0ZUVudHJ5PjtcblxuLyoqIFRoZSBJU08gdGltZXN0YW1wIG9mIGEgcmVjb3ZlcnksIHdoaWNoZXZlciBzdGF0ZSBmb3JtIGl0IHdhcyB3cml0dGVuIGluLiAqL1xuZnVuY3Rpb24gcmVjb3ZlcnlUaW1lc3RhbXAodmFsdWU6IHN0cmluZyB8IFJlY292ZXJ5U3RhdGVFbnRyeSk6IHN0cmluZyB7XG4gIHJldHVybiB0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgPyB2YWx1ZSA6IHZhbHVlLmF0O1xufVxuXG4vKiogV2hldGhlciBgdmFsdWVgIGlzIGEgbGVnYWN5IElTTyBzdHJpbmcgb3IgYSB3ZWxsLWZvcm1lZCB7QGxpbmsgUmVjb3ZlcnlTdGF0ZUVudHJ5fS4gKi9cbmZ1bmN0aW9uIGlzVmFsaWRSZWNvdmVyeVZhbHVlKFxuICB2YWx1ZTogdW5rbm93bixcbik6IHZhbHVlIGlzIHN0cmluZyB8IFJlY292ZXJ5U3RhdGVFbnRyeSB7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIpIHJldHVybiB0cnVlO1xuICBpZiAodmFsdWUgPT09IG51bGwgfHwgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGNvbnN0IG9iaiA9IHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICByZXR1cm4gdHlwZW9mIG9iai5hdCA9PT0gXCJzdHJpbmdcIiAmJlxuICAgIChvYmouZ2l0TWVzc2FnZSA9PT0gdW5kZWZpbmVkIHx8IHR5cGVvZiBvYmouZ2l0TWVzc2FnZSA9PT0gXCJzdHJpbmdcIikgJiZcbiAgICAob2JqLmFzaWRlID09PSB1bmRlZmluZWQgfHwgdHlwZW9mIG9iai5hc2lkZSA9PT0gXCJzdHJpbmdcIik7XG59XG5cbi8qKlxuICogTG9hZCB0aGUgc3RhdGUgZmlsZTsgYG9rKHt9KWAgaWYgbWlzc2luZyBvciB1bnBhcnNlYWJsZSAod2FybmluZyBsb2dnZWQpLFxuICogYGVycmAgZm9yIGFueSBvdGhlciByZWFkIGZhdWx0IOKAlCB0aGF0IG11c3Qgbm90IHNpbGVudGx5IHJlc2V0IHRoZSAyNCBoIGNhcC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbG9hZFN0YXRlKHN0YXRlUGF0aDogc3RyaW5nKTogUHJvbWlzZTxSZXN1bHQ8UmVjb3ZlcnlTdGF0ZT4+IHtcbiAgbGV0IHRleHQ6IHN0cmluZztcbiAgdHJ5IHtcbiAgICB0ZXh0ID0gYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUoc3RhdGVQYXRoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7fSB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYENvdWxkIG5vdCByZWFkIHRoZSBjbG9uZSByZWNvdmVyeSBzdGF0ZSBhdCAke3N0YXRlUGF0aH06ICR7ZXJyb3J9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UodGV4dCk7XG4gICAgaWYgKFxuICAgICAgcGFyc2VkICE9PSBudWxsICYmIHR5cGVvZiBwYXJzZWQgPT09IFwib2JqZWN0XCIgJiZcbiAgICAgICFBcnJheS5pc0FycmF5KHBhcnNlZCkgJiZcbiAgICAgIE9iamVjdC52YWx1ZXMocGFyc2VkKS5ldmVyeShpc1ZhbGlkUmVjb3ZlcnlWYWx1ZSlcbiAgICApIHtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcGFyc2VkIGFzIFJlY292ZXJ5U3RhdGUgfTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIEZhbGwgdGhyb3VnaCB0byB0aGUgd2FybmluZyBiZWxvdyDigJQgYW4gdW5wYXJzZWFibGUgZmlsZSBpcyBvdmVyd3JpdHRlbi5cbiAgfVxuICBjb25zb2xlLndhcm4oXG4gICAgYFtjb3JydXB0LWNsb25lLXJlY292ZXJ5XSAke3N0YXRlUGF0aH0gaXMgbm90IHZhbGlkIHJlY292ZXJ5IHN0YXRlOyB0cmVhdGluZyBpdCBhcyBlbXB0eWAsXG4gICk7XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZToge30gfTtcbn1cblxuLyoqIFVUQyBgWVlZWU1NRERUSEhNTVNTWmAsIGUuZy4gYDIwMjYxMDAxVDEyMDAwMFpgLiAqL1xuZnVuY3Rpb24gZm9ybWF0VGltZXN0YW1wKGRhdGU6IERhdGUpOiBzdHJpbmcge1xuICByZXR1cm4gZGF0ZS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1stOl0vZywgXCJcIikucmVwbGFjZSgvXFwuXFxkK1okLywgXCJaXCIpO1xufVxuXG4vKiogVGhlIGRpcmVjdG9yeSBob2xkaW5nIGBwYXRoYCDigJQgbm8gYEBzdGQvcGF0aGAgaW4gdGhpcyBpbXBvcnQgbWFwLiAqL1xuZnVuY3Rpb24gcGFyZW50RGlyZWN0b3J5KHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHRyaW1tZWQgPSBwYXRoLnJlcGxhY2UoL1tcXFxcL10rJC8sIFwiXCIpO1xuICBjb25zdCBjdXQgPSBNYXRoLm1heCh0cmltbWVkLmxhc3RJbmRleE9mKFwiL1wiKSwgdHJpbW1lZC5sYXN0SW5kZXhPZihcIlxcXFxcIikpO1xuICByZXR1cm4gY3V0ID4gMCA/IHRyaW1tZWQuc2xpY2UoMCwgY3V0KSA6IFwiL1wiO1xufVxuXG4vKiogVGhlIGZpbmFsIHBhdGggc2VnbWVudCDigJQgbm8gYEBzdGQvcGF0aGAgaW4gdGhpcyBpbXBvcnQgbWFwLiAqL1xuZnVuY3Rpb24gYmFzZU5hbWUocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IHBhdGgucmVwbGFjZSgvW1xcXFwvXSskLywgXCJcIik7XG4gIGNvbnN0IGN1dCA9IE1hdGgubWF4KHRyaW1tZWQubGFzdEluZGV4T2YoXCIvXCIpLCB0cmltbWVkLmxhc3RJbmRleE9mKFwiXFxcXFwiKSk7XG4gIHJldHVybiBjdXQgPj0gMCA/IHRyaW1tZWQuc2xpY2UoY3V0ICsgMSkgOiB0cmltbWVkO1xufVxuXG4vKipcbiAqIE1vdmUgYSBjb3JydXB0IGNsb25lIGFzaWRlIGFuZCByZWNvcmQgdGhlIHJlY292ZXJ5LCB1bmxlc3MgdGhlIHNhbWUgcmVwb1xuICogd2FzIGFscmVhZHkgcmVjb3ZlcmVkIG9uIHRoaXMgaG9zdCB3aXRoaW4ge0BsaW5rIENMT05FX1JFQ09WRVJZX1dJTkRPV19NU30uXG4gKlxuICogQHJldHVybnMgYG9rKDxhc2lkZSBwYXRoPilgIG9uIHN1Y2Nlc3M7IGByZXBvUGF0aGAgbm8gbG9uZ2VyIGV4aXN0c1xuICogICBhZnRlcndhcmRzLiBgZXJyYCB3aGVuIHRoZSByZXBvIHdhcyBhbHJlYWR5IHJlLWNsb25lZCB0b28gcmVjZW50bHksIG9yXG4gKiAgIHdoZW4gYW55IGZpbGVzeXN0ZW0gc3RlcCBmYWlscy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlY292ZXJDb3JydXB0Q2xvbmUoXG4gIHJlcG86IHN0cmluZyxcbiAgcmVwb1BhdGg6IHN0cmluZyxcbiAgd29ya0Rpcjogc3RyaW5nLFxuICBnaXRNZXNzYWdlOiBzdHJpbmcsXG4gIG9wdGlvbnM6IENsb25lUmVjb3ZlcnlPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxzdHJpbmc+PiB7XG4gIGNvbnN0IG5vdyA9IG9wdGlvbnMubm93ID8/ICgoKSA9PiBuZXcgRGF0ZSgpKTtcbiAgY29uc3Qgc3RhdGVQYXRoID0gY2xvbmVSZWNvdmVyeVN0YXRlUGF0aCh3b3JrRGlyLCBvcHRpb25zLmhvc3RuYW1lKTtcblxuICBjb25zdCBiYXNlID0gYmFzZU5hbWUocmVwb1BhdGgpO1xuICBpZiAoYmFzZSA9PT0gXCJcIiB8fCBiYXNlID09PSBcIi5cIiB8fCBiYXNlID09PSBcIi4uXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihgTm90IGEgcmVjb3ZlcmFibGUgcGF0aDogJHtyZXBvUGF0aH1gKSxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIGF3YWl0IHdpdGhTdGF0ZUxvY2soc3RhdGVQYXRoLCBhc3luYyAoKTogUHJvbWlzZTxSZXN1bHQ8c3RyaW5nPj4gPT4ge1xuICAgIGNvbnN0IGxvYWRlZCA9IGF3YWl0IGxvYWRTdGF0ZShzdGF0ZVBhdGgpO1xuICAgIGlmICghbG9hZGVkLm9rKSByZXR1cm4gbG9hZGVkO1xuICAgIGNvbnN0IHN0YXRlID0gbG9hZGVkLnZhbHVlO1xuICAgIGNvbnN0IGxhc3RSZWNvdmVyeSA9IHN0YXRlW3JlcG9dO1xuICAgIGNvbnN0IG5vd0RhdGUgPSBub3coKTtcbiAgICBpZiAobGFzdFJlY292ZXJ5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IHByZXZpb3VzQXQgPSByZWNvdmVyeVRpbWVzdGFtcChsYXN0UmVjb3ZlcnkpO1xuICAgICAgY29uc3QgZWxhcHNlZCA9IG5vd0RhdGUuZ2V0VGltZSgpIC0gbmV3IERhdGUocHJldmlvdXNBdCkuZ2V0VGltZSgpO1xuICAgICAgaWYgKGVsYXBzZWQgPj0gMCAmJiBlbGFwc2VkIDwgQ0xPTkVfUkVDT1ZFUllfV0lORE9XX01TKSB7XG4gICAgICAgIGNvbnN0IGhvc3QgPSBvcHRpb25zLmhvc3RuYW1lID8/IGdldEhvc3RuYW1lKCk7XG4gICAgICAgIGNvbnN0IHJlcGVhdDogQ2xvbmVDb3JydXB0UmVwZWF0ID0ge1xuICAgICAgICAgIHJlcG8sXG4gICAgICAgICAgaG9zdCxcbiAgICAgICAgICBwcmV2aW91c0F0LFxuICAgICAgICAgIGN1cnJlbnRBdDogbm93RGF0ZS50b0lTT1N0cmluZygpLFxuICAgICAgICAgIGN1cnJlbnRHaXRNZXNzYWdlOiBjYXBMZW5ndGgoZ2l0TWVzc2FnZSksXG4gICAgICAgIH07XG4gICAgICAgIGlmICh0eXBlb2YgbGFzdFJlY292ZXJ5ICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgaWYgKGxhc3RSZWNvdmVyeS5naXRNZXNzYWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHJlcGVhdC5wcmV2aW91c0dpdE1lc3NhZ2UgPSBsYXN0UmVjb3ZlcnkuZ2l0TWVzc2FnZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGxhc3RSZWNvdmVyeS5hc2lkZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICByZXBlYXQuYXNpZGUgPSBsYXN0UmVjb3ZlcnkuYXNpZGU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgVGhlIGNsb25lIG9mICR7cmVwb30gYXQgJHtyZXBvUGF0aH0gaXMgY29ycnVwdCAoJHtnaXRNZXNzYWdlfSkgYW5kIHdhcyBhbHJlYWR5IHJlLWNsb25lZCB3aXRoaW4gMjQgaCBvbiB0aGlzIGhvc3QsIHNvIGl0IGlzIG5vdCByZS1jbG9uZWQgYWdhaW4uIOKAlCAke0NMT05FX0NPUlJVUFRfTUFSS0VSfS5cXG5gICtcbiAgICAgICAgICAgICAgZm9ybWF0Q2xvbmVDb3JydXB0UmVwZWF0KHJlcGVhdCksXG4gICAgICAgICAgKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBwYXJlbnQgPSBwYXJlbnREaXJlY3RvcnkocmVwb1BhdGgpO1xuICAgIGNvbnN0IHByZWZpeCA9IGAke2Jhc2V9LmNvcnJ1cHQtYDtcbiAgICB0cnkge1xuICAgICAgZm9yIGF3YWl0IChjb25zdCBlbnRyeSBvZiBEZW5vLnJlYWREaXIocGFyZW50KSkge1xuICAgICAgICBpZiAoZW50cnkubmFtZS5zdGFydHNXaXRoKHByZWZpeCkpIHtcbiAgICAgICAgICBjb25zdCBzaWJsaW5nUGF0aCA9IGAke3BhcmVudH0vJHtlbnRyeS5uYW1lfWA7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IERlbm8ucmVtb3ZlKHNpYmxpbmdQYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgIGBDb3VsZCBub3QgcmVtb3ZlIHRoZSBvbGQgY29ycnVwdCBjbG9uZSBzaWJsaW5nIGF0ICR7c2libGluZ1BhdGh9OiAke2Vycm9yfWAsXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoIShlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLk5vdEZvdW5kKSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICAgICAgYENvdWxkIG5vdCBsaXN0IHRoZSBkaXJlY3RvcnkgJHtwYXJlbnR9IHRvIHJlbW92ZSBvbGQgY29ycnVwdCBjbG9uZSBzaWJsaW5nczogJHtlcnJvcn1gLFxuICAgICAgICAgICksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgYXNpZGUgPSBgJHtyZXBvUGF0aH0uY29ycnVwdC0ke2Zvcm1hdFRpbWVzdGFtcChub3dEYXRlKX1gO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBEZW5vLnJlbmFtZShyZXBvUGF0aCwgYXNpZGUpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgYENvdWxkIG5vdCBtb3ZlIHRoZSBjb3JydXB0IGNsb25lIGZyb20gJHtyZXBvUGF0aH0gdG8gJHthc2lkZX06ICR7ZXJyb3J9YCxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3QgbmV3RW50cnk6IFJlY292ZXJ5U3RhdGVFbnRyeSA9IHtcbiAgICAgIGF0OiBub3dEYXRlLnRvSVNPU3RyaW5nKCksXG4gICAgICBnaXRNZXNzYWdlOiBjYXBMZW5ndGgoZ2l0TWVzc2FnZSksXG4gICAgICBhc2lkZSxcbiAgICB9O1xuICAgIGNvbnN0IG5ld1N0YXRlOiBSZWNvdmVyeVN0YXRlID0geyAuLi5zdGF0ZSwgW3JlcG9dOiBuZXdFbnRyeSB9O1xuICAgIGNvbnN0IHdyaXR0ZW4gPSBhd2FpdCBhdG9taWNXcml0ZSh7XG4gICAgICB0YXJnZXRGaWxlOiBzdGF0ZVBhdGgsXG4gICAgICBjb250ZW50OiBKU09OLnN0cmluZ2lmeShuZXdTdGF0ZSwgbnVsbCwgMikgKyBcIlxcblwiLFxuICAgIH0pO1xuICAgIGlmICghd3JpdHRlbi5vaykge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICAgIGBDb3VsZCBub3QgcmVjb3JkIHRoZSBjbG9uZSByZWNvdmVyeSBpbiAke3N0YXRlUGF0aH06ICR7d3JpdHRlbi5lcnJvci5tZXNzYWdlfWAsXG4gICAgICAgICksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IGZpcnN0TGluZSA9IGdpdE1lc3NhZ2Uuc3BsaXQoXCJcXG5cIilbMF0hLnRyaW0oKTtcbiAgICBjb25zb2xlLmVycm9yKFxuICAgICAgYGNvcnJ1cHQgY2xvbmUgb2YgJHtyZXBvfSBtb3ZlZCBhc2lkZSB0byAke2FzaWRlfTsgcmUtY2xvbmluZzogJHtmaXJzdExpbmV9YCxcbiAgICApO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogYXNpZGUgfTtcbiAgfSk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0JDLEdBSUQsU0FBUyxlQUFlLFFBQVEsa0JBQWtCO0FBQ2xELFNBQVMsV0FBVyxRQUFRLGtCQUFrQjtBQUM5QyxTQUFTLGFBQWEsUUFBUSxtQkFBbUI7QUFDakQsU0FBUyxXQUFXLFFBQVEsdUJBQXVCO0FBQ25ELFNBQVMsb0JBQW9CLFFBQVEseUJBQXlCO0FBRTlELHdFQUF3RSxHQUN4RSxPQUFPLE1BQU0sOEJBQThCLHVCQUF1QjtBQWlCbEUsd0ZBQXdGLEdBQ3hGLE1BQU0sNEJBQTRCO0FBRWxDLHFHQUFxRyxHQUNyRyxTQUFTLFVBQVUsS0FBYTtFQUM5QixPQUFPLE1BQU0sTUFBTSxHQUFHLDRCQUNsQixNQUFNLEtBQUssQ0FBQyxHQUFHLDZCQUNmO0FBQ047QUFFQSxxREFBcUQsR0FDckQsT0FBTyxTQUFTLHlCQUF5QixNQUEwQjtFQUNqRSxPQUFPLEdBQUcsNEJBQTRCLEVBQUUsRUFBRSxLQUFLLFNBQVMsQ0FBQyxTQUFTO0FBQ3BFO0FBRUE7Ozs7Q0FJQyxHQUNELE1BQU0sMEJBQTBCLElBQUksT0FDbEMsQ0FBQyxDQUFDLEVBQ0EsNEJBQTRCLE9BQU8sQ0FBQyx1QkFBdUIsUUFDNUQsaUJBQWlCLENBQUMsRUFDbkI7QUFHRjs7OztDQUlDLEdBQ0QsT0FBTyxTQUFTLHdCQUNkLE9BQWU7RUFFZixNQUFNLFFBQVEsUUFBUSxLQUFLLENBQUM7RUFDNUIsSUFBSSxVQUFVLE1BQU0sT0FBTztFQUUzQixJQUFJO0VBQ0osSUFBSTtJQUNGLFNBQVMsS0FBSyxLQUFLLENBQUMsS0FBSyxDQUFDLEVBQUU7RUFDOUIsRUFBRSxPQUFNO0lBQ04sMEVBQTBFO0lBQzFFLE9BQU87RUFDVDtFQUVBLElBQUksV0FBVyxRQUFRLE9BQU8sV0FBVyxZ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
// denoCacheMetadata=6602022403322957694,8329491703356300334