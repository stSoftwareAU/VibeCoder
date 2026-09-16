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
 * Since Issue #2156 the same file carries any additional server a run is
 * handed (CodeGraph), independently of the Playwright browser grant, so an
 * extra server never widens that grant.
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
import { ensureStateDir, sharedTmpStateDir } from "./private_cache_dir.ts";

/**
 * One `mcpServers` entry: the keys both providers understand (Issue #2156).
 *
 * `command`, `args` and `env` are what `buildCodexMcpConfigArgs`
 * (`codex_executor.ts`) translates into Codex `-c` overrides, so an entry
 * written here serves Claude's `--mcp-config` and Codex alike.
 */
export interface AgentMcpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * What a run asks of the per-run MCP config (Issue #2156).
 *
 * Kept separate from {@link AgentMcpConfigOptions} so a caller — the runner's
 * `mcpConfig` option — can name the request without the plumbing.
 */
export interface AgentMcpServerRequest {
  /**
   * Include the Playwright browser server (default `true`).
   *
   * `false` hands the agent the `servers` below and no browser, so an
   * additional server never widens the browser grant of Issue #192.
   */
  playwright?: boolean;
  /** Additional servers merged into the written `mcpServers` map. */
  servers?: Record<string, AgentMcpServerSpec>;
}

export interface AgentMcpConfigOptions extends AgentMcpServerRequest {
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

/**
 * Stable, filesystem-safe name for a clone path.
 *
 * The `playwright-` prefix is historical and kept for continuity: since
 * Issue #2156 the file may hold servers other than Playwright (and may hold
 * no Playwright entry at all).
 */
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
  // Issue #1242: the temp fallback is per-account. The fixed
  // `${TMPDIR}/vibe-playwright-mcp` was the same path for every account on
  // the host, so a local user could plant the MCP server configuration the
  // coding agent is then handed.
  return sharedTmpStateDir("vibe-playwright-mcp", (key) => env(key, lookup));
}

/**
 * Merge the additional servers over the generated Playwright map.
 *
 * Two shapes are faults rather than merge outcomes (Issue #2156), because
 * each would drop a capability the caller asked for while still returning a
 * written config:
 *
 * - a generated shape carrying no entries — coalescing it away writes the
 *   additional servers and no browser entry for a run that asked for the
 *   browser;
 * - an additional server whose name collides with a generated one — the
 *   caller's entry would silently replace the hardened browser entry, losing
 *   its secrets denylist, its pinned specifier and its scratch output dir.
 *
 * @param generated - The JSON {@link generateMcpConfig} produced
 * @param extra - The additional servers this run asked for
 * @returns The merged `mcpServers` map
 * @throws Error when the generated map is empty or a name collides
 */
function mergeServers(
  generated: string,
  extra: Record<string, AgentMcpServerSpec>,
): Record<string, unknown> {
  const servers = (JSON.parse(generated) as {
    mcpServers?: Record<string, unknown>;
  }).mcpServers;
  if (!servers || Object.keys(servers).length === 0) {
    throw new Error(
      "the generated Playwright configuration carries no mcpServers entry",
    );
  }
  const collisions = Object.keys(extra).filter((name) => name in servers);
  if (collisions.length > 0) {
    throw new Error(
      `additional MCP server ${
        collisions.join(", ")
      } would replace the generated entry of the same name`,
    );
  }
  return { ...servers, ...extra };
}

/**
 * Build the MCP server configuration for a run and write it beside the other
 * worker cache files. Returns the file path, or undefined when no server was
 * requested or the config could not be produced (logged, never thrown).
 *
 * The Playwright browser server is included unless `playwright: false`, and
 * any `servers` entries are merged over it — the additive merge
 * `setup/screenshot.ts` performs on an existing `.mcp.json`.
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
      // Issue #1242: under the shared temporary root the directory is
      // created 0700 and refused when another account owns it — the config
      // written here is handed to the coding agent, so it must not be
      // written into (or read back from) a directory a local user controls.
      const trust = await ensureStateDir(dir);
      if (!trust.trusted) {
        throw new Error(
          `MCP config directory ${dir} is not worker-private: ${
            trust.reason ?? "unknown"
          }`,
        );
      }
      await Deno.writeTextFile(path, content);
    });
  const withPlaywright = options.playwright ?? true;
  const extra = options.servers ?? {};
  const extraNames = Object.keys(extra);
  if (!withPlaywright && extraNames.length === 0) {
    log(
      "MCP config not written — no MCP server was requested for this run.",
    );
    return undefined;
  }
  try {
    let content: string;
    if (!withPlaywright) {
      content = JSON.stringify({ mcpServers: { ...extra } }, null, 2);
    } else {
      const generated = generate(options.cwd, screenshotDir);
      // Playwright alone is written verbatim, so the file a browser run gets
      // is byte-for-byte what it got before Issue #2156.
      content = extraNames.length === 0 ? generated : JSON.stringify(
        { mcpServers: mergeServers(generated, extra) },
        null,
        2,
      );
    }
    const dir = options.configDir ?? defaultMcpConfigDir({
      ...(options.workDir ? { workDir: options.workDir } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    const path = `${dir}/${mcpConfigFileName(options.cwd)}`;
    await writeFile(path, content);
    return path;
  } catch (err) {
    // Named for what was actually requested (Issue #2156): a codegraph-only
    // run has no browser to lose, so "without a browser" would misreport it.
    log(
      `${
        withPlaywright ? "Playwright MCP" : "MCP"
      } config not written — the agent runs without the requested MCP servers this run: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}
