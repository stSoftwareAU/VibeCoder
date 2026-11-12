/**
 * Installs the agent's git `pre-push` hook (Issue #3394).
 *
 * ```mermaid
 * flowchart LR
 *   A[agent: git push] --> H[pre-push hook script]
 *   H --> C[pre_push_gate_cli.ts]
 *   C --> F[changed-file fmt/lint]
 *   F --> P[repo pre-flight commands]
 *   P -->|all pass| OK[push proceeds]
 *   F -->|fail| X[push refused]
 *   P -->|fail| X
 * ```
 *
 * The hook is wired through git's environment config
 * (`GIT_CONFIG_COUNT`/`KEY`/`VALUE` setting `core.hooksPath`) and is returned
 * as an env overlay for the AGENT's process only. The worker's own pushes
 * (e.g. WIP preservation) never see it, so they are not gated by it and keep
 * their existing pre-flight at the commit chokepoint.
 *
 * Residual risk: `git push --no-verify`, or the agent editing its own
 * environment, bypasses the hook. This is containment against honest mistakes,
 * not a security boundary.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { dirname } from "node:path";
import type { Result } from "../types.ts";
import type { CiCargoScan } from "./ci_cargo_checks.ts";
import { resolveGuardModulePath } from "./guard_module_path.ts";
import { posixSingleQuote } from "./shell_quote.ts";

/** Marker in the generated script's header. */
export const PRE_PUSH_HOOK_MARKER = "Vibe Coder pre-push gate";

/**
 * Render the hook script. It fails closed: a missing Deno binary, module,
 * spec, worker `deno.json` or worker `deno.lock` blocks the push rather than silently allowing it. `DENO_DIR` is
 * deliberately not pinned — this is a quality gate, not a security boundary.
 * Writes are limited to the temp directory, where the gate makes the scratch
 * worktree for the PR-base comparison of a failing CI cargo check (Issue #4630).
 */
export function renderPrePushHookScript(opts: {
  denoPath: string;
  modulePath: string;
  specPath: string;
}): string {
  const deno = posixSingleQuote(opts.denoPath);
  const module = posixSingleQuote(opts.modulePath);
  const spec = posixSingleQuote(opts.specPath);
  const workerDir = dirname(dirname(opts.modulePath));
  const config = posixSingleQuote(`${workerDir}/deno.json`);
  const lock = posixSingleQuote(`${workerDir}/deno.lock`);
  return `#!/bin/bash
# ${PRE_PUSH_HOOK_MARKER} (Issue #3394) — generated per run; do not edit.
set -uo pipefail

if [ ! -x ${deno} ]; then
  echo "[PRE_PUSH_BLOCKED] deno binary is missing or not executable: "${deno} >&2
  exit 1
fi
if [ ! -f ${module} ]; then
  echo "[PRE_PUSH_BLOCKED] gate module is missing: "${module} >&2
  exit 1
fi
if [ ! -f ${spec} ]; then
  echo "[PRE_PUSH_BLOCKED] gate spec is missing: "${spec} >&2
  exit 1
fi
if [ ! -f ${config} ]; then
  echo "[PRE_PUSH_BLOCKED] worker Deno config is missing: "${config} >&2
  exit 1
fi
if [ ! -f ${lock} ]; then
  echo "[PRE_PUSH_BLOCKED] worker Deno lock is missing: "${lock} >&2
  exit 1
fi

exec ${deno} run --quiet --config ${config} --frozen --lock ${lock} --allow-read --allow-write="${"$"}{TMPDIR:-/tmp}" --allow-run --allow-env ${module} --spec ${spec} -- "$@"
`;
}

/** An installed hook and the env overlay that activates it. */
export interface PrePushHook {
  dir: string;
  hooksDir: string;
  hookPath: string;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

/** Write the hook and spec to a temp dir and build the activating env. */
export async function installPrePushHook(opts: {
  baseEnv: Record<string, string>;
  preFlightCommands: readonly string[];
  timeoutSeconds?: number;
  /**
   * The repo's CI cargo checks, precomputed by the worker before the agent
   * runs (Issue #4630 review). Written into the hook spec so the hook can run
   * them without importing the workflow scanner (`ci_cargo_checks.ts`)
   * itself. Omit to keep the hook
   * scanning no CI cargo check.
   */
  ciCargo?: CiCargoScan;
  /**
   * The ref a failing CI cargo check is compared against (the PR base, as
   * `origin/<branch>`; `""` when a comparison is required but the base is
   * unknown). Written into the spec as `compareRef`; omit for no comparison.
   */
  compareRef?: string;
  denoPath?: string;
  modulePath?: string;
  makeTempDir?: () => Promise<string>;
}): Promise<Result<PrePushHook, Error>> {
  const rawCount = opts.baseEnv.GIT_CONFIG_COUNT;
  let count = 0;
  if (rawCount !== undefined) {
    if (!/^\d+$/.test(rawCount.trim())) {
      return {
        ok: false,
        error: new Error(
          `GIT_CONFIG_COUNT is not a non-negative integer: ${rawCount}`,
        ),
      };
    }
    count = Number(rawCount.trim());
  }

  let dir: string | undefined;
  try {
    dir = await (opts.makeTempDir ??
      (() => Deno.makeTempDir({ prefix: "vibe-pre-push-" })))();
    const hooksDir = `${dir}/hooks`;
    const hookPath = `${hooksDir}/pre-push`;
    const specPath = `${dir}/pre-push-spec.json`;
    await Deno.mkdir(hooksDir, { recursive: true });
    await Deno.writeTextFile(
      specPath,
      JSON.stringify({
        preFlightCommands: [...opts.preFlightCommands],
        ...(opts.timeoutSeconds === undefined
          ? {}
          : { timeoutSeconds: opts.timeoutSeconds }),
        ...(opts.ciCargo === undefined ? {} : { ciCargo: opts.ciCargo }),
        ...(opts.compareRef === undefined
          ? {}
          : { compareRef: opts.compareRef }),
      }),
    );
    await Deno.writeTextFile(
      hookPath,
      renderPrePushHookScript({
        denoPath: opts.denoPath ?? Deno.execPath(),
        modulePath: opts.modulePath ??
          resolveGuardModulePath("pre_push_gate_cli.ts", import.meta.url),
        specPath,
      }),
    );
    await Deno.chmod(hookPath, 0o755);

    const env: Record<string, string> = {
      ...opts.baseEnv,
      [`GIT_CONFIG_KEY_${count}`]: "core.hooksPath",
      [`GIT_CONFIG_VALUE_${count}`]: hooksDir,
      GIT_CONFIG_COUNT: String(count + 1),
    };
    const installedDir = dir;
    return {
      ok: true,
      value: {
        dir: installedDir,
        hooksDir,
        hookPath,
        env,
        cleanup: async () => {
          try {
            await Deno.remove(installedDir, { recursive: true });
          } catch (error) {
            console.warn(
              `[pre-push-hook] could not remove ${installedDir}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        },
      },
    };
  } catch (error) {
    if (dir !== undefined) {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
