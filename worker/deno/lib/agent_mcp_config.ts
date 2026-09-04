/**
 * Per-run MCP configuration for the coding agent (Issue #4355).
 *
 * The coding guidelines promise the agent a headless browser via the
 * Playwright MCP server, and the container image bakes the browser for it
 * (Issue #4069) — but nothing handed the server to the agent at run time:
 * `.mcp.json` was only written by an optional `setup.sh` step into the
 * VibeCoder checkout root, which is not the agent's working directory (the
 * target-repo clone under `WORK_DIR`), and no `--mcp-config` was passed. So
 * `browser_take_screenshot` never existed for the agent, natively or in the
 * container, and `needs-screenshot` issues cycled through
 * "Screenshot Evidence Required" releases (private-repo-10#831, five times).
 *
 * This module builds the server configuration for the environment the agent
 * actually runs in — the baked browser when the image supplies one, the
 * clone's `docs/evidence` as the screenshot output directory, a disposable
 * browser profile — writes it to the worker cache (never into the checkout),
 * and returns the path for the provider to pass as `--mcp-config`.
 *
 * Best-effort: any failure returns `undefined` and the agent runs without
 * the server, exactly as before, with the reason logged.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { generateMcpConfig } from "../setup/screenshot.ts";
import { workerCacheDir } from "./worker_cache_dir.ts";
import { EVIDENCE_DIR } from "./screenshot_validation.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

export interface AgentMcpConfigOptions {
  /** The agent's working directory — the target-repo clone. */
  cwd: string;
  /** Screenshot directory relative to `cwd` (default `docs/evidence`). */
  screenshotDir?: string;
  /** Directory the config file is written to (default: the worker cache). */
  configDir?: string;
  /** Injectable writer (tests). */
  writeFile?: (path: string, content: string) => Promise<void>;
  /** Injectable config generator (tests). */
  generate?: (cwd: string, screenshotDir: string) => string;
  log?: (message: string) => void;
  /**
   * The work volume root for the default config directory (Issue #960).
   *
   * Named here, a test no longer has to export `WORK_DIR` into the process
   * to say where the cache lives. Omitted, `WORK_DIR` is read exactly as
   * before.
   */
  workDir?: string;
  /** Environment lookup for the default config directory (Issue #960). */
  env?: EnvLookup;
}

/** Stable, filesystem-safe name for a clone path. */
export function mcpConfigFileName(cwd: string): string {
  let hash = 2166136261;
  for (const ch of cwd) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `playwright-mcp-${hash.toString(16).padStart(8, "0")}.json`;
}

/** Read an env var through `lookup`, tolerating a denied `--allow-env`. */
function env(name: string, lookup: EnvLookup): string | undefined {
  try {
    return lookup(name) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where {@link defaultMcpConfigDir} looks for the work volume and the temp
 * directory (Issue #960).
 *
 * A test that needs a particular `WORK_DIR` or `TMPDIR` hands them over
 * rather than writing them into the process environment, which races every
 * other test in the run (Issue #880, plan #944).
 */
export interface McpConfigDirOptions {
  /** The work volume root. Wins over any `WORK_DIR` in the environment. */
  workDir?: string;
  /** Environment lookup; defaults to the real process environment. */
  env?: EnvLookup;
}

/**
 * Where the per-run config lives: the worker cache under `WORK_DIR` when the
 * run driver has exported it, otherwise the OS temp directory — never
 * `$HOME` (Issue #4370: a dev-machine test run wrote
 * `~/auto-issue-work/.vibe-cache/mcp/…` through the HOME fallback).
 */
export function defaultMcpConfigDir(
  options: McpConfigDirOptions = {},
): string {
  const lookup = options.env ?? processEnvLookup;
  // `workerCacheDir()` is undefined exactly when WORK_DIR is unset
  // (Issue #131), so no separate env guard is needed any more.
  const cacheDir = workerCacheDir({
    ...(options.workDir ? { workDir: options.workDir } : {}),
    env: lookup,
  });
  if (cacheDir) return `${cacheDir}/mcp`;
  const tmp = env("TMPDIR", lookup) ?? env("TEMP", lookup) ??
    env("TMP", lookup) ?? "/tmp";
  return `${tmp.replace(/[\\/]+$/, "")}/vibe-playwright-mcp`;
}

/**
 * Build the Playwright MCP server configuration for a run and write it
 * beside the other worker cache files. Returns the file path, or undefined
 * when the config could not be produced (logged, never thrown).
 */
export async function ensureAgentMcpConfig(
  options: AgentMcpConfigOptions,
): Promise<string | undefined> {
  const log = options.log ?? (() => {});
  const screenshotDir = options.screenshotDir ?? EVIDENCE_DIR;
  const generate = options.generate ??
    ((cwd: string, dir: string) =>
      // The clone is the "config dir" only for the profile-dir safety
      // check; the file itself is written elsewhere and the server's
      // scratch output dir sits beside the browser profile.
      generateMcpConfig({
        scriptDir: cwd,
        mcpConfigDir: cwd,
        screenshotDir: dir,
      }));
  const writeFile = options.writeFile ??
    (async (path: string, content: string) => {
      const dir = path.slice(0, path.lastIndexOf("/"));
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(path, content);
    });
  try {
    const content = generate(options.cwd, screenshotDir);
    const dir = options.configDir ?? defaultMcpConfigDir({
      ...(options.workDir ? { workDir: options.workDir } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    const path = `${dir}/${mcpConfigFileName(options.cwd)}`;
    await writeFile(path, content);
    return path;
  } catch (err) {
    log(
      `Playwright MCP config not written — the agent runs without a browser this run: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}
