/**
 * Host identity for a HOST-level failure report (Issue #556, Issue #2088).
 *
 * Every other report the worker makes rides the issue it is working on. A
 * failure that happens *before* any issue is claimed — the checkout update
 * (#4204), the container launcher's crash-loop (#4072), a credential that
 * stopped working (#554) — has no such target, and that is exactly when the
 * operator most needs telling: nothing is being worked, and nothing will be
 * until somebody looks.
 *
 * That report is delivered **on the host**, to `callbacks.host_failure`. Core
 * files nothing in the origin repository for a host-level condition: the
 * origin repository is public, and a crash-loop, a stale checkout or a dead
 * credential describe the operator's own infrastructure to anybody reading it
 * (Issue #2088). The issue channel this module once carried — file, comment,
 * close, all deduplicated by title — was retired with that milestone; what is
 * left is the host's identity, which the hook payload's `host` field names,
 * and the `owner/repo` parse the release check still needs.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/** Parse `owner/repo` out of a git origin URL (SSH or HTTPS). */
export function parseOriginRepo(url: string): string | null {
  const match = url.trim().match(
    /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?$/,
  );
  return match ? match[1]! : null;
}

/**
 * The host's own identity — the `host` field of every host-failure payload.
 *
 * @param env - Reads `VIBE_HOST_ID`; defaults to the process environment, so
 *   production callers pass nothing (Issue #967). A test hands in a fixed map
 *   rather than mutating the environment every parallel worker shares.
 */
export function escalationHostId(env: EnvLookup = processEnvLookup): string {
  let fromEnv: string | undefined;
  try {
    fromEnv = env("VIBE_HOST_ID")?.trim();
  } catch {
    fromEnv = undefined;
  }
  if (fromEnv) return fromEnv;
  try {
    return Deno.hostname().split(".")[0] || "unknown-host";
  } catch {
    return "unknown-host";
  }
}
