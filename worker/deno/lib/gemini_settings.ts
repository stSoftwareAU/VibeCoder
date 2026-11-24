/**
 * Gemini's per-run settings file (Issue #5341).
 *
 * The Gemini CLI reads its system settings from the path named in the
 * `GEMINI_CLI_SYSTEM_SETTINGS_PATH` environment variable. Each run writes its
 * own file there, enforcing the run's denied tools, so a denial reaches the
 * CLI as a setting rather than as prompt text. An unmapped name, or a file that
 * cannot be written, refuses the spawn (see `claude_runner.ts`).
 *
 * The file also carries the run's MCP servers (Issue #5343), so the CLI can
 * start them; `--allowed-mcp-server-names` in `gemini_executor.ts` restricts
 * which of them load.
 *
 * A `Bash(<prefix>:*)` denial cannot be a `tools.exclude` entry: the CLI turns
 * each entry into a whole-tool deny rule (Gemini CLI 0.68.0,
 * `packages/core/src/policy/config.ts`). It is carried as a deny rule in a
 * policy file instead, which the settings file names under `policyPaths`
 * (PR #5524 review). The Policy Engine denies a shell command whose text starts
 * with the prefix and then a space, a quote or its end, including a sub-command
 * of `a && b` and the body of `bash -c '...'`, so it reads as Claude's
 * `Bash(<prefix>:*)` does. It does not look through an environment assignment
 * before the command (`FOO=1 cargo build`): observed on the CLI's own engine,
 * 0.68.0.
 *
 * The builders are pure; the writer is the only part that touches the disk.
 *
 * Australian English spelling throughout (behaviour, organisation, honour).
 */

import type { AgentRunSettings, ToolDenialSettings } from "./agent_provider.ts";
import type { EnvLookup } from "./env_lookup.ts";
import { readMcpServerEntries, SAFE_MCP_NAME } from "./mcp_server_entries.ts";
import type { Result } from "../types.ts";

/** The environment variable the Gemini CLI reads its system settings path from. */
export const GEMINI_SYSTEM_SETTINGS_ENV_VAR = "GEMINI_CLI_SYSTEM_SETTINGS_PATH";

/**
 * The Gemini CLI tool each mapped denial excludes (v0.68.0 `tool-names.ts` and
 * `definitions/base-declarations.ts`).
 *
 * `WebFetch` and `WebSearch` are mapped because the existing deny lists
 * (summarise, closure verdict, drift check) carry them and Gemini has the
 * equivalent tools, `web_fetch` and `google_web_search`.
 *
 * `EnterPlanMode` and `ExitPlanMode` are not in the issue's list, but the
 * runner denies them by default and the Quorum judge relies on that, so
 * refusing them would refuse every default Gemini run.
 */
const GEMINI_TOOL_FOR_DENIAL: ReadonlyMap<string, string> = new Map([
  ["Edit", "replace"],
  ["MultiEdit", "replace"],
  ["Write", "write_file"],
  ["Bash", "run_shell_command"],
  ["WebFetch", "web_fetch"],
  ["WebSearch", "google_web_search"],
  ["EnterPlanMode", "enter_plan_mode"],
  ["ExitPlanMode", "exit_plan_mode"],
]);

/** The Gemini CLI's shell tool, which a command-prefix denial applies to. */
const GEMINI_SHELL_TOOL = "run_shell_command";

/**
 * A denial of one shell command prefix: `Bash(git push:*)`. The prefix is
 * written into a TOML string, so it is limited to what the allow-list below
 * admits; any other form of `Bash(...)` stays unmapped and refuses the run.
 */
const SHELL_PREFIX_DENIAL = /^Bash\((.+):\*\)$/;

/** Characters a command prefix may hold: a word, then words, flags and paths. */
const SHELL_PREFIX_SHAPE = /^[A-Za-z0-9_][A-Za-z0-9_./ -]*$/;

/** The prefix a `Bash(<prefix>:*)` denial names, or undefined when it is not one. */
function shellPrefixOf(tool: string): string | undefined {
  const prefix = SHELL_PREFIX_DENIAL.exec(tool)?.[1];
  if (prefix === undefined) return undefined;
  if (prefix !== prefix.trim() || !SHELL_PREFIX_SHAPE.test(prefix)) {
    return undefined;
  }
  return prefix;
}

/** The deny-rule file for a run's shell prefixes, in the CLI's policy syntax. */
function buildShellPrefixPolicy(prefixes: readonly string[]): string {
  // A JSON string is a valid TOML basic string for the allow-listed characters.
  const list = prefixes.map((prefix) => JSON.stringify(prefix)).join(", ");
  return `[[rule]]
toolName = ${JSON.stringify(GEMINI_SHELL_TOOL)}
commandPrefix = [${list}]
decision = "deny"
priority = 999
denyMessage = "Denied by the worker for this run."
`;
}

/** Denials that turn off sub-agents through `experimental.enableAgents`. */
const SUB_AGENT_DENIALS: ReadonlySet<string> = new Set(["Task", "Agent"]);

/**
 * Denials Gemini has no tool for: the CLI has no notebook tool, so a notebook
 * edit cannot happen and the denial is met without a setting.
 */
const NO_TOOL_DENIALS: ReadonlySet<string> = new Set(["NotebookEdit"]);

/**
 * Maps a list of denied tool names into Gemini's settings object.
 *
 * `tools.exclude` lists each Gemini tool once, in order of first appearance;
 * `tools` is omitted when nothing is excluded, and `experimental` when neither
 * sub-agent name is denied. A `Bash(<prefix>:*)` name becomes one deny rule in
 * `policy`, in order of first appearance; the writer names the file holding it
 * in `policyPaths`. A name with no mapping (exact match only, or a `Bash(...)`
 * that is not a plain prefix) refuses the whole list, naming every such tool.
 *
 * @param disallowedTools - Tool names the run denies, as the runner names them.
 * @returns The settings object and policy rules, or the refusal naming the
 *   unmapped tools.
 */
export function buildGeminiToolSettings(
  disallowedTools: readonly string[],
): ToolDenialSettings {
  const exclude: string[] = [];
  const unmapped: string[] = [];
  const prefixes: string[] = [];
  let subAgentsOff = false;
  for (const tool of disallowedTools) {
    if (SUB_AGENT_DENIALS.has(tool)) {
      subAgentsOff = true;
    } else if (NO_TOOL_DENIALS.has(tool)) {
      continue;
    } else {
      const geminiTool = GEMINI_TOOL_FOR_DENIAL.get(tool);
      const prefix = geminiTool === undefined ? shellPrefixOf(tool) : undefined;
      if (prefix !== undefined) {
        if (!prefixes.includes(prefix)) prefixes.push(prefix);
      } else if (geminiTool === undefined) {
        if (!unmapped.includes(tool)) unmapped.push(tool);
      } else if (!exclude.includes(geminiTool)) {
        exclude.push(geminiTool);
      }
    }
  }
  if (unmapped.length > 0) {
    return {
      ok: false,
      refusal: {
        kind: "missing_tool_support",
        message: `gemini cannot enforce the denied tool(s) ${
          unmapped.join(", ")
        }: no Gemini CLI setting is mapped for them, and a denial is never left as prompt text only`,
      },
    };
  }
  const settings: Record<string, unknown> = {};
  if (exclude.length > 0) settings.tools = { exclude };
  if (subAgentsOff) settings.experimental = { enableAgents: false };
  return prefixes.length === 0
    ? { ok: true, settings }
    : { ok: true, settings, policy: buildShellPrefixPolicy(prefixes) };
}

/** One stdio MCP server as the Gemini CLI's `mcpServers` setting takes it. */
export interface GeminiMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Maps the run's MCP config into Gemini's `mcpServers` setting (Issue #5343).
 *
 * A server without a `command` is skipped, since Gemini needs one to start a
 * stdio server. The command and args are those Codex receives. Only string
 * values under a safe name are kept in `env`; nothing else (such as
 * `alwaysLoad`) is copied. `Object.fromEntries` keeps a name such as
 * `__proto__` as an own key rather than setting a prototype.
 *
 * @param configJson - The contents of the `--mcp-config` file.
 * @returns The servers keyed by name; empty when none is usable.
 */
export function buildGeminiMcpServers(
  configJson: string,
): Record<string, GeminiMcpServer> {
  const pairs: [string, GeminiMcpServer][] = [];
  for (const entry of readMcpServerEntries(configJson)) {
    if (entry.command === undefined) continue;
    const server: GeminiMcpServer = { command: entry.command };
    if (entry.args !== undefined) server.args = entry.args;
    if (entry.env !== undefined) {
      const env: [string, string][] = [];
      for (const [key, value] of Object.entries(entry.env)) {
        if (!SAFE_MCP_NAME.test(key) || typeof value !== "string") continue;
        env.push([key, value]);
      }
      server.env = Object.fromEntries(env);
    }
    pairs.push([entry.name, server]);
  }
  return Object.fromEntries(pairs);
}

/**
 * Reads the run's MCP config into Gemini's `mcpServers` setting (Issue #5343).
 *
 * The one reader behind both the argv's `--allowed-mcp-server-names` and the
 * settings file's `mcpServers`, so the two carry the same servers and refuse
 * the same configs. A config that cannot be read, or yields no usable server,
 * is an error, as Codex's is.
 *
 * @param path - The run's `--mcp-config` file.
 * @returns The servers keyed by name, or why the run must be refused.
 */
export function readGeminiMcpServers(
  path: string,
): Result<Record<string, GeminiMcpServer>> {
  let json: string;
  try {
    json = Deno.readTextFileSync(path);
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `the Gemini MCP config at ${path} could not be read: ${
          causeOf(error)
        }; refusing to run without the requested MCP servers (Issue #5343)`,
      ),
    };
  }
  const servers = buildGeminiMcpServers(json);
  if (Object.keys(servers).length === 0) {
    return {
      ok: false,
      error: new Error(
        `the Gemini MCP config at ${path} produced no usable mcpServers ` +
          "entry; refusing to run without the requested MCP servers (Issue #5343)",
      ),
    };
  }
  return { ok: true, value: servers };
}

/** The cause of a thrown value, as a message. */
function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Removes a directory the writer made after a failed write. Returns the cause
 * when the removal also fails, so the caller can report it, or undefined when
 * the directory is gone.
 */
async function removeDirectory(dir: string): Promise<string | undefined> {
  try {
    await Deno.remove(dir, { recursive: true });
    return undefined;
  } catch (error) {
    return causeOf(error);
  }
}

/**
 * Writes this run's settings file into a fresh, owner-only directory.
 *
 * The directory is made under `TMPDIR` as the run's own environment lookup
 * reads it, or under the system temporary directory when that is absent or
 * empty. The file is `settings.json`, created new with mode 0600 and chmodded
 * explicitly so the umask cannot widen it. Any failure names the path and the
 * cause, and removes the directory it made.
 *
 * With `mcpConfigPath`, the run's MCP servers are written under `mcpServers`
 * (Issue #5343). A config that cannot be read, or yields no usable server,
 * refuses the spawn, as Codex's does.
 *
 * With command-prefix denials, the rules are written to `policy/deny.toml` in
 * the same directory and the settings name that directory under `policyPaths`.
 * Both files are removed by `cleanup`; a failure to write either refuses the
 * spawn.
 *
 * @param request - The denials to enforce, the environment lookup and the
 *   run's MCP config path, when it has one.
 * @returns The environment that points the CLI at the file (its path is the
 *   value of `GEMINI_CLI_SYSTEM_SETTINGS_PATH`), and a `cleanup` that removes
 *   the directory (safe to call twice).
 */
export async function writeGeminiRunSettings(request: {
  disallowedTools: readonly string[];
  env?: EnvLookup;
  mcpConfigPath?: string;
}): Promise<Result<AgentRunSettings>> {
  const built = buildGeminiToolSettings(request.disallowedTools);
  if (!built.ok) return { ok: false, error: new Error(built.refusal.message) };

  if (request.mcpConfigPath) {
    const servers = readGeminiMcpServers(request.mcpConfigPath);
    if (!servers.ok) return servers;
    built.settings.mcpServers = servers.value;
  }

  const configuredRoot = (request.env?.("TMPDIR") ?? "").trim();
  const root = configuredRoot === "" ? undefined : configuredRoot;
  const rootLabel = root ?? "the system temporary directory";
  const consequence =
    "so the spawn is refused rather than leave its denied tools as prompt text only";

  let dir: string;
  try {
    dir = await Deno.makeTempDir({
      dir: root,
      prefix: "vibe-gemini-settings-",
    });
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `the Gemini settings file could not be written to ${rootLabel}: ${
          causeOf(error)
        }; ${consequence}`,
      ),
    };
  }

  const filePath = `${dir}/settings.json`;
  const policyDir = `${dir}/policy`;
  try {
    await Deno.chmod(dir, 0o700);
    if (built.policy !== undefined) {
      await Deno.mkdir(policyDir, { mode: 0o700 });
      await Deno.writeTextFile(`${policyDir}/deny.toml`, built.policy, {
        mode: 0o600,
        createNew: true,
      });
      built.settings.policyPaths = [policyDir];
    }
    await Deno.writeTextFile(
      filePath,
      `${JSON.stringify(built.settings, null, 2)}\n`,
      { mode: 0o600, createNew: true },
    );
    await Deno.chmod(filePath, 0o600);
  } catch (error) {
    const removalFailure = await removeDirectory(dir);
    const removalNote = removalFailure === undefined
      ? ""
      : `; the directory ${dir} could not be removed either: ${removalFailure}`;
    return {
      ok: false,
      error: new Error(
        `the Gemini settings file could not be written to ${filePath}: ${
          causeOf(error)
        }${removalNote}; ${consequence}`,
      ),
    };
  }

  const cleanup = async (): Promise<void> => {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  return {
    ok: true,
    value: {
      env: { [GEMINI_SYSTEM_SETTINGS_ENV_VAR]: filePath },
      cleanup,
    },
  };
}
