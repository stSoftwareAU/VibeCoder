/**
 * Service-account environment application (Issue #3530).
 *
 * The bash-era launcher applied the operator's service-account auth by
 * `eval`-ing the `load-config` export script, which set `GH_CONFIG_DIR`
 * (from `.config.json` `gh_config_dir`) and `GIT_SSH_COMMAND` (from
 * `ssh_key_path`). The pure-Deno driver (`run.sh` → `run-entrypoint`,
 * Issue #3504) dropped that step, so every `gh`/`git` child process
 * inherited the ambient (human) credentials. Downstream, the #3416
 * fleet-login trust gate then treated the human operator as a fleet worker
 * and silently rejected every label they applied — the host claimed no
 * labelled work at all.
 *
 * This module applies the same two variables in-process, on the shared
 * command path in `mod.ts`, so every command — including `run-entrypoint`
 * — authenticates as the service account before its first `gh` call.
 * Configured values win over ambient env, matching the bash-era
 * `eval "$(load-config)"` behaviour.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { WorkerConfig } from "../types.ts";
import { buildGitSshCommand } from "./shell_quote.ts";
import {
  DEFAULT_CREDENTIAL_DIR_SUFFIX,
  GH_CREDENTIAL_SUBDIR,
  GH_HOSTS_FILE,
  GH_RUNTIME_CONFIG_SUFFIX,
  SCRATCH_DIR_ENV,
} from "./credential_preflight.ts";

/** Resolved env entries; absent when the operator did not configure them. */
export interface ServiceAccountEnv {
  GH_CONFIG_DIR?: string;
  GIT_SSH_COMMAND?: string;
}

/**
 * Filesystem probe for the container-aware fallback (Issue #4060).
 *
 * Inside the container the operator's configured paths do not exist —
 * `~/.config/gh-vibe` and the SSH key are host paths that are deliberately
 * never mounted. What IS mounted is the Vibe credential directory
 * (Issue #4064). With a probe supplied, an absent `gh_config_dir` falls back
 * to the mounted `…/credentials/gh` material, and an absent SSH key omits
 * `GIT_SSH_COMMAND` entirely so git uses the entrypoint's HTTPS+token
 * transport instead. Without a probe the resolution stays pure and applies
 * the configured values unconditionally (host-era semantics).
 */
export interface ServiceAccountEnvProbe {
  exists(path: string): boolean;
}

/** Options for {@link resolveServiceAccountEnv}. */
export interface ServiceAccountEnvOptions {
  probe?: ServiceAccountEnvProbe;
  /**
   * True when running inside the worker container. The fallback applies ONLY
   * there: on the host a configured-but-missing path must keep failing
   * loudly (a silent fall-through to ambient credentials is exactly the
   * Issue #3530 leak). The container stamps VIBE_IMAGE_AGENT_PROVIDERS into
   * the image environment, which {@link applyServiceAccountEnv} reads.
   */
  inContainer?: boolean;
  /**
   * Directories to try before the legacy `~/.config/gh-runtime` copy when the
   * configured path is absent — the entrypoint's own staged copy, wherever
   * this launch put it (Issue #515: it moved to `${VIBE_SCRATCH_DIR}/gh` when
   * the container root filesystem became read-only). Highest priority first.
   * Candidates without a `hosts.yml` are skipped.
   */
  stagedGhConfigDirs?: string[];
}

/** Real filesystem probe used by {@link applyServiceAccountEnv}. */
const fsProbe: ServiceAccountEnvProbe = {
  exists(path: string): boolean {
    try {
      Deno.statSync(path);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Expand a leading `~` to the supplied home directory, mirroring the
 * `load-config` export script (`commands/load_config.ts`).
 */
function expandHome(path: string, home: string): string {
  return path.replace(/^~/, home);
}

/**
 * Resolve the service-account env entries from the loaded config.
 *
 * Pure — no I/O. `home` is injected so tests need not touch `$HOME`.
 *
 * @param config - The `ghConfigDir` / `sshKeyPath` operator values.
 * @param home - Home directory used to expand a leading `~`.
 * @returns Entries to set; empty object when nothing is configured.
 */
export function resolveServiceAccountEnv(
  config: Pick<WorkerConfig, "ghConfigDir" | "sshKeyPath">,
  home: string,
  options: ServiceAccountEnvOptions = {},
): ServiceAccountEnv {
  const probe = options.inContainer ? options.probe : undefined;
  const env: ServiceAccountEnv = {};
  if (config.ghConfigDir) {
    const expanded = expandHome(config.ghConfigDir, home);
    if (!probe || probe.exists(expanded)) {
      env.GH_CONFIG_DIR = expanded;
    } else {
      // Container fallback (Issue #4060): the configured directory is a host
      // path that was never mounted. Prefer the WRITABLE runtime copy the
      // entrypoint staged (gh needs to write a config migration on every
      // fresh VM), then the read-only mount, then the configured value so
      // the failure stays loud and names the operator's own setting.
      const runtime = `${home}/${GH_RUNTIME_CONFIG_SUFFIX}`;
      const mounted = `${home}/${DEFAULT_CREDENTIAL_DIR_SUFFIX}/` +
        GH_CREDENTIAL_SUBDIR;
      // The staged copies this launch actually made come first (Issue #515):
      // the entrypoint no longer writes ${runtime} — that path is the image
      // layer — so a resolver that only knows the legacy location silently
      // falls through to the READ-ONLY mount, and gh's first-use config
      // migration then dies with "failed to write config after migration:
      // … read-only file system" (observed live, Issue #509 milestone).
      const staged = (options.stagedGhConfigDirs ?? []).find((candidate) =>
        candidate.length > 0 && probe.exists(`${candidate}/${GH_HOSTS_FILE}`)
      );
      if (staged) {
        env.GH_CONFIG_DIR = staged;
      } else if (probe.exists(`${runtime}/${GH_HOSTS_FILE}`)) {
        env.GH_CONFIG_DIR = runtime;
      } else if (probe.exists(`${mounted}/${GH_HOSTS_FILE}`)) {
        env.GH_CONFIG_DIR = mounted;
      } else {
        env.GH_CONFIG_DIR = expanded;
      }
    }
  }
  if (config.sshKeyPath) {
    const keyPath = expandHome(config.sshKeyPath, home);
    if (!probe || probe.exists(keyPath)) {
      // Git parses GIT_SSH_COMMAND with /bin/sh, so the key path must be
      // quoted (Issue #3661, SEC-a228ff008ed4) — an unquoted path with a
      // space picks up the wrong identity, and one with `;`/`$(…)` executes
      // on every git call.
      env.GIT_SSH_COMMAND = buildGitSshCommand(keyPath);
    }
    // Absent key: the contained worker has no SSH material by design — omit
    // the variable so git falls back to the entrypoint's HTTPS rewrite with
    // the mounted gh token.
  }
  return env;
}

/**
 * Apply the service-account env to the current process so child `gh` and
 * `git` processes inherit it. Configured values override ambient env
 * (config wins — parity with the bash-era behaviour); unconfigured fields
 * leave the ambient env untouched.
 *
 * @param config - The loaded worker config.
 * @param home - Home directory override (defaults to `$HOME`).
 */
export function applyServiceAccountEnv(
  config: Pick<WorkerConfig, "ghConfigDir" | "sshKeyPath">,
  home: string = Deno.env.get("HOME") ?? "",
): void {
  const inContainer = Deno.env.get("VIBE_IMAGE_AGENT_PROVIDERS") !== undefined;
  const env = resolveServiceAccountEnv(config, home, {
    probe: fsProbe,
    inContainer,
    stagedGhConfigDirs: stagedGhConfigDirsFromEnv(),
  });
  if (env.GH_CONFIG_DIR !== undefined) {
    // gh writes its config migration on first use, so a read-only directory
    // here is a startup failure, not a degraded mode (Issue #509): stage a
    // writable copy rather than hand gh a directory it cannot write.
    Deno.env.set(
      "GH_CONFIG_DIR",
      inContainer ? ensureWritableGhConfigDir(env.GH_CONFIG_DIR) : env
        .GH_CONFIG_DIR,
    );
  }
  if (env.GIT_SSH_COMMAND !== undefined) {
    Deno.env.set("GIT_SSH_COMMAND", env.GIT_SSH_COMMAND);
  }
}

/**
 * Where THIS launch staged the writable `gh` copy, highest priority first.
 *
 * The container entrypoint exports both variables; on the host neither is set
 * and the list is empty, so nothing changes there.
 */
function stagedGhConfigDirsFromEnv(): string[] {
  const scratch = Deno.env.get(SCRATCH_DIR_ENV);
  return [
    Deno.env.get("GH_CONFIG_DIR"),
    scratch ? `${scratch}/${GH_CREDENTIAL_SUBDIR}` : undefined,
  ].filter((dir): dir is string => dir !== undefined && dir.length > 0);
}

/** True when a file can be created inside `dir` (probe written and removed). */
function isWritableDir(dir: string): boolean {
  const probePath = `${dir}/.vibe-write-probe`;
  try {
    Deno.writeTextFileSync(probePath, "");
    Deno.removeSync(probePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a `GH_CONFIG_DIR` gh can write to.
 *
 * The resolved directory is returned untouched when it is already writable.
 * Otherwise — the read-only credential mount is the case that reaches here —
 * its `hosts.yml` is copied to the first writable staging candidate. This is
 * the worker's own belt to the entrypoint's braces: the two encode the same
 * staging decision in different languages, and when they disagree the run
 * dies at `gh api user` with a message no log carried (Issue #509).
 */
function ensureWritableGhConfigDir(dir: string): string {
  if (isWritableDir(dir)) return dir;
  const tmp = Deno.env.get("TMPDIR")?.replace(/\/+$/, "") ?? "/tmp";
  const scratch = Deno.env.get(SCRATCH_DIR_ENV);
  const candidates = [
    `${tmp}/vibe-gh-config`,
    scratch ? `${scratch}/gh-config` : undefined,
  ].filter((candidate): candidate is string => candidate !== undefined);
  for (const candidate of candidates) {
    try {
      Deno.mkdirSync(candidate, { recursive: true, mode: 0o700 });
      Deno.copyFileSync(
        `${dir}/${GH_HOSTS_FILE}`,
        `${candidate}/${GH_HOSTS_FILE}`,
      );
      Deno.chmodSync(`${candidate}/${GH_HOSTS_FILE}`, 0o600);
      console.error(
        `[SECURITY] gh config dir ${dir} is not writable — staged a ` +
          `container-local copy at ${candidate} (Issue #509)`,
      );
      return candidate;
    } catch {
      // Try the next candidate; the caller's gh call stays the loud failure.
    }
  }
  console.error(
    `[SECURITY] gh config dir ${dir} is not writable and no staging ` +
      `candidate could be created (${candidates.join(", ")}) — gh will fail ` +
      `its first-use config migration`,
  );
  return dir;
}
